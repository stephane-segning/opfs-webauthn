/**
 * Dedicated DB worker. The dispatch is a typed table keyed by
 * request kind — adding a new command means adding an entry, not
 * editing a switch. Per ADR 0006 the worker is the sole writer;
 * a future PR replaces this dedicated worker with a SharedWorker
 * (with a Web-Locks leader-election fallback) so multiple tabs share
 * one writer.
 */

/// <reference lib="webworker" />

import { type Database, openNotesDatabase } from "./database.js";
import { NoteRepositorySql } from "./note-repository.js";
import type { EncryptedNoteRow } from "./row.js";
import {
	type ClientEnvelope,
	fail,
	notify,
	respond,
	type WorkerRequest,
	type WorkerResponse,
} from "./rpc.js";
import { SCHEMA_VERSION } from "./schema.js";

declare const self: DedicatedWorkerGlobalScope;

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
	self.postMessage(notify({ kind: "tx-applied", ids }));
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
		await withDb(() => undefined);
		return { kind: "bootstrap", schemaVersion: SCHEMA_VERSION };
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
		db?.close();
		db = null;
		repo = null;
		return { kind: "close" };
	},
};

function dispatch(request: WorkerRequest): Promise<WorkerResponse> {
	// `as never` keeps the union narrow per handler at the call site.
	return handlers[request.kind](request as never);
}

self.addEventListener("message", (event: MessageEvent<ClientEnvelope>) => {
	const { id, request } = event.data;
	dispatch(request)
		.then((response) => self.postMessage(respond(id, response)))
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			self.postMessage(fail(id, message));
		});
});
