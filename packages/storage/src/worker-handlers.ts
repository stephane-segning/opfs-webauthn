/**
 * Transport-independent worker handlers. The dispatch table is keyed
 * by `WorkerRequest["kind"]` so adding a command means adding an
 * entry — open/closed.
 *
 * `createDispatcher` is the factory; the worker entries
 * (`db-worker.ts`, `db-shared-worker.ts`) supply concrete
 * `openDatabase` + `broadcast` impls. Tests can stand up a
 * dispatcher against an in-memory DB and a no-op broadcaster.
 *
 * Per ADR 0006, `tx-applied` rides a `BroadcastChannel` so every
 * tab (including the originating one) hears about every write. The
 * dispatcher itself stays transport-agnostic; the entries decide
 * what `broadcast` means.
 */

import type { Database } from "./database.js";
import { NoteRepositorySql } from "./note-repository.js";
import type { EncryptedNoteRow } from "./row.js";
import type {
	WorkerNotification,
	WorkerRequest,
	WorkerResponse,
} from "./rpc.js";
import { getSchemaVersion } from "./schema.js";

export type Dispatcher = (request: WorkerRequest) => Promise<WorkerResponse>;

export type Broadcaster = (notification: WorkerNotification) => void;

export type DispatcherOptions = {
	readonly openDatabase: () => Promise<Database>;
	readonly broadcast: Broadcaster;
};

/**
 * Build a dispatcher closed over its DB opener + broadcaster. The DB
 * is opened lazily on the first request that needs it, so a
 * bootstrap ping (`ping`) doesn't pay the OPFS-SAH pool install
 * cost on cold connect.
 */
export function createDispatcher(opts: DispatcherOptions): Dispatcher {
	let db: Database | null = null;
	let repo: NoteRepositorySql | null = null;

	const withDb = async <R>(fn: (r: NoteRepositorySql) => R): Promise<R> => {
		if (!db || !repo) {
			db = await opts.openDatabase();
			repo = new NoteRepositorySql(db);
		}
		return fn(repo);
	};

	const broadcastTx = (ids: readonly string[]): void => {
		opts.broadcast({ kind: "tx-applied", ids });
	};

	const handlers: {
		[K in WorkerRequest["kind"]]: (
			req: Extract<WorkerRequest, { kind: K }>,
		) => Promise<WorkerResponse>;
	} = {
		ping: async () => ({ kind: "ping", pong: true }),
		bootstrap: async () => {
			// Force the lazy DB open so `bootstrap` is the deterministic
			// "schema is applied, you can write now" handshake the page
			// awaits before exposing the UI.
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
				broadcastTx([row.id]);
				return { kind: "upsertNote", row };
			}),
		getNote: (req) => withDb((r) => ({ kind: "getNote", row: r.get(req.id) })),
		archiveNote: (req) =>
			withDb((r) => {
				r.archive(req.id);
				broadcastTx([req.id]);
				return { kind: "archiveNote" };
			}),
		deleteNote: (req) =>
			withDb((r) => {
				// Hard delete is irreversible — the UI gates this behind a
				// confirmation dialog (see `note-editor.tsx`). The id still
				// fans out so other tabs drop the row from their cached list.
				r.delete(req.id);
				broadcastTx([req.id]);
				return { kind: "deleteNote" };
			}),
		close: async () => {
			// Per-tab `close` only detaches one Connection (see
			// `connection.ts`). The DB stays open so other tabs (under
			// SharedWorker) keep working; the browser tears the worker
			// down when the last connection drops.
			return { kind: "close" };
		},
	};

	return (request: WorkerRequest): Promise<WorkerResponse> =>
		handlers[request.kind](request as never);
}
