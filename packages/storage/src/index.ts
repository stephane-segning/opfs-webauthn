/**
 * `@opfs/storage` — sqlite-wasm + OPFS writer worker, leader-election
 * fallback, and a typed request/response RPC. See ADR 0004 + ADR 0006.
 *
 * Stub for now; the worker, RPC layer, and leader election land in a
 * follow-up PR.
 */

export type Note = {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly archived: boolean;
};

/** Input to `Repo.upsertNote`. `id` is optional — omit to create a new note. */
export type NoteInput = Omit<Note, "id" | "createdAt" | "updatedAt"> & {
	readonly id?: string;
};

export type Repo = {
	readonly listNotes: (input: { limit?: number; cursor?: string }) => Promise<{
		readonly notes: readonly Note[];
		readonly nextCursor: string | null;
	}>;
	readonly upsertNote: (note: NoteInput) => Promise<Note>;
	readonly archiveNote: (id: string) => Promise<void>;
	readonly close: () => Promise<void>;
};

export type StorageEvent =
	| { readonly kind: "tx-applied"; readonly ids: readonly string[] }
	| { readonly kind: "vault-locked" }
	| { readonly kind: "leader-elected"; readonly leaderId: string };

export type EventListener = (event: StorageEvent) => void;

/**
 * The eventual entry point: `createRepo()` boots the SharedWorker (or
 * falls back to a Web-Locks leader-election dedicated worker) and
 * returns a typed `Repo` + subscribe.
 */
export type CreateRepo = () => Promise<{
	readonly repo: Repo;
	readonly subscribe: (listener: EventListener) => () => void;
}>;
