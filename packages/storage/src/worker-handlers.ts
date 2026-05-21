/**
 * Transport-independent worker handlers. The dispatch table is keyed
 * by `WorkerRequest["kind"]` so adding a command means adding an
 * entry — open/closed.
 *
 * `broadcastTxApplied` fans out the post-write notification to every
 * connected page. In the dedicated-worker case there's exactly one
 * `Connection`; under SharedWorker there's one per tab.
 */

import { eachConnection } from "./connection.js";
import { type Database, openNotesDatabase } from "./database.js";
import { NoteRepositorySql } from "./note-repository.js";
import type { EncryptedNoteRow } from "./row.js";
import { notify, type WorkerRequest, type WorkerResponse } from "./rpc.js";
import { getSchemaVersion } from "./schema.js";

const DB_FILENAME = "opfs-webauthn-notes.sqlite";

let db: Database | null = null;
let repo: NoteRepositorySql | null = null;

async function withDb<R>(fn: (repo: NoteRepositorySql) => R): Promise<R> {
	if (!db || !repo) {
		db = await openNotesDatabase(DB_FILENAME);
		repo = new NoteRepositorySql(db);
	}
	return fn(repo);
}

function broadcastTxApplied(ids: readonly string[]): void {
	const envelope = notify({ kind: "tx-applied", ids });
	eachConnection((c) => c.post(envelope));
}

/**
 * Map every `WorkerRequest` kind to its handler. The signature is
 * unified — `(req) => Promise<WorkerResponse>` — so callers don't
 * special-case any one command.
 */
const handlers: {
	[K in WorkerRequest["kind"]]: (
		req: Extract<WorkerRequest, { kind: K }>,
	) => Promise<WorkerResponse>;
} = {
	ping: async () => ({ kind: "ping", pong: true }),
	bootstrap: async () => {
		// `withDb` ensures wasm is initialised (via `openNotesDatabase`),
		// which `getSchemaVersion()` needs to be reachable.
		await withDb(() => undefined);
		return { kind: "bootstrap", schemaVersion: getSchemaVersion() };
	},
	listNotes: (req) =>
		withDb((r) => {
			const page = r.list(req);
			return {
				kind: "listNotes",
				rows: page.rows,
				nextCursor: page.nextCursor,
			};
		}),
	upsertNote: (req) =>
		withDb((r) => {
			const row: EncryptedNoteRow = r.upsert(req.row);
			broadcastTxApplied([row.id]);
			return { kind: "upsertNote", row };
		}),
	archiveNote: (req) =>
		withDb((r) => {
			r.archive(req.id);
			broadcastTxApplied([req.id]);
			return { kind: "archiveNote" };
		}),
	close: async () => {
		// Per-tab `close` only detaches one Connection; we leave `db`
		// open so other tabs (under SharedWorker) keep working. The
		// browser closes the DB when the last connection drops and the
		// worker is torn down.
		return { kind: "close" };
	},
};

export const dispatch = (request: WorkerRequest): Promise<WorkerResponse> =>
	handlers[request.kind](request as never);
