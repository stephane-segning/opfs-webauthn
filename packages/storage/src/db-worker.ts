/**
 * Dedicated DB worker. Owns the sqlite-wasm instance + the OPFS sync
 * access handles. Sole writer on the OPFS database file.
 *
 * Per ADR 0006 a future PR replaces this dedicated worker with a
 * SharedWorker (with a Web-Locks leader-election fallback) so multiple
 * tabs share one writer.
 */

/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { decodeRowId, encodeRowId } from "./id.js";
import type { EncryptedNoteRow, NoteRowInput } from "./row.js";
import type {
	ClientEnvelope,
	ServerEnvelope,
	WorkerRequest,
	WorkerResponse,
} from "./rpc.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

declare const self: DedicatedWorkerGlobalScope;

const DB_FILENAME = "opfs-webauthn-notes.sqlite";

// Lazily set on first `bootstrap`.
type SqliteApi = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SAHPoolUtil = Awaited<ReturnType<SqliteApi["installOpfsSAHPoolVfs"]>>;
type OpfsDb = InstanceType<SAHPoolUtil["OpfsSAHPoolDb"]>;

let db: OpfsDb | null = null;
let pool: SAHPoolUtil | null = null;

async function ensureDb(): Promise<OpfsDb> {
	if (db) return db;
	const sqlite3 = await sqlite3InitModule();
	pool ??= await sqlite3.installOpfsSAHPoolVfs({});
	const fresh: OpfsDb = new pool.OpfsSAHPoolDb(`/${DB_FILENAME}`);
	fresh.exec(SCHEMA_SQL);
	fresh.exec({
		sql: `INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		bind: [String(SCHEMA_VERSION)],
	});
	db = fresh;
	return fresh;
}

function dispatch(request: WorkerRequest): Promise<WorkerResponse> {
	switch (request.kind) {
		case "ping":
			return Promise.resolve({ kind: "ping", pong: true });
		case "bootstrap":
			return bootstrap();
		case "listNotes":
			return listNotes(request);
		case "upsertNote":
			return upsertNote(request.row);
		case "archiveNote":
			return archiveNote(request.id);
		case "close":
			return closeDb();
	}
}

async function bootstrap(): Promise<WorkerResponse> {
	await ensureDb();
	return { kind: "bootstrap", schemaVersion: SCHEMA_VERSION };
}

async function listNotes(req: {
	readonly limit: number;
	readonly cursor: string | null;
	readonly includeArchived: boolean;
}): Promise<WorkerResponse> {
	const handle = await ensureDb();
	const limit = Math.max(1, Math.min(req.limit, 200));
	// Cursor is the (updated_day, id) tuple of the last row from the
	// previous page, base32-encoded as "DDDDDDDDDD:ID". We page on
	// (updated_day DESC, id DESC).
	let whereCursor = "";
	const bind: (string | number | Uint8Array)[] = [];
	if (req.cursor) {
		const [dayStr, lastId] = req.cursor.split(":");
		if (!dayStr || !lastId) {
			throw new Error(`malformed cursor: ${req.cursor}`);
		}
		whereCursor = `AND (updated_day < ? OR (updated_day = ? AND id < ?))`;
		bind.push(Number.parseInt(dayStr, 10));
		bind.push(Number.parseInt(dayStr, 10));
		bind.push(decodeRowId(lastId));
	}
	const archivedClause = req.includeArchived ? "" : "AND archived = 0";
	const sql = `
		SELECT id, updated_day, archived,
		       title_nonce, title_ciphertext,
		       body_nonce, body_ciphertext
		FROM notes
		WHERE 1=1 ${archivedClause} ${whereCursor}
		ORDER BY updated_day DESC, id DESC
		LIMIT ?`;
	bind.push(limit + 1);

	// `rowMode: "array"` actually emits `unknown[][]`, but the bundled
	// type definitions of @sqlite.org/sqlite-wasm declare `resultRows`
	// as `SqlValue[]`. Cast at the boundary; we decode the columns by
	// position immediately below.
	const raw: unknown[][] = [];
	handle.exec({
		sql,
		bind,
		rowMode: "array",
		resultRows: raw as unknown as never,
	});

	const rows = raw.slice(0, limit).map(decodeRow);
	const nextCursor =
		raw.length > limit
			? `${rows[rows.length - 1]?.updatedDay}:${rows[rows.length - 1]?.id}`
			: null;
	return { kind: "listNotes", rows, nextCursor };
}

async function upsertNote(input: NoteRowInput): Promise<WorkerResponse> {
	const handle = await ensureDb();
	const idBytes = decodeRowId(input.id);
	handle.exec({
		sql: `
			INSERT INTO notes(id, updated_day, archived, title_nonce, title_ciphertext, body_nonce, body_ciphertext)
			VALUES(?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				updated_day = excluded.updated_day,
				archived = excluded.archived,
				title_nonce = excluded.title_nonce,
				title_ciphertext = excluded.title_ciphertext,
				body_nonce = excluded.body_nonce,
				body_ciphertext = excluded.body_ciphertext`,
		bind: [
			idBytes,
			input.updatedDay,
			input.archived ? 1 : 0,
			input.titleNonce,
			input.titleCiphertext,
			input.bodyNonce,
			input.bodyCiphertext,
		],
	});
	notify({ kind: "tx-applied", ids: [input.id] });
	return { kind: "upsertNote", row: input };
}

async function archiveNote(id: string): Promise<WorkerResponse> {
	const handle = await ensureDb();
	handle.exec({
		sql: "UPDATE notes SET archived = 1 WHERE id = ?",
		bind: [decodeRowId(id)],
	});
	notify({ kind: "tx-applied", ids: [id] });
	return { kind: "archiveNote" };
}

function closeDb(): Promise<WorkerResponse> {
	if (db) {
		db.close();
		db = null;
	}
	return Promise.resolve({ kind: "close" });
}

function decodeRow(values: ReadonlyArray<unknown>): EncryptedNoteRow {
	const [
		id,
		updatedDay,
		archived,
		titleNonce,
		titleCiphertext,
		bodyNonce,
		bodyCiphertext,
	] = values;
	return {
		id: encodeRowId(id as Uint8Array),
		updatedDay: updatedDay as number,
		archived: (archived as number) === 1,
		titleNonce: titleNonce as Uint8Array,
		titleCiphertext: titleCiphertext as Uint8Array,
		bodyNonce: bodyNonce as Uint8Array,
		bodyCiphertext: bodyCiphertext as Uint8Array,
	};
}

function notify(notification: {
	kind: "tx-applied";
	ids: readonly string[];
}): void {
	const envelope: ServerEnvelope = { kind: "notification", notification };
	self.postMessage(envelope);
}

self.addEventListener("message", (event: MessageEvent<ClientEnvelope>) => {
	const { id, request } = event.data;
	dispatch(request)
		.then((response) => {
			const envelope: ServerEnvelope = { kind: "response", id, response };
			self.postMessage(envelope);
		})
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			const envelope: ServerEnvelope = { kind: "error", id, message };
			self.postMessage(envelope);
		});
});
