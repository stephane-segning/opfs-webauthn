/**
 * `@opfs/storage` — sqlite-wasm + OPFS dedicated-worker writer, with
 * a typed RPC client (multi-tab safety lands in a follow-up PR — see
 * ADR 0006). The page-side `Repo` holds the `CryptoVault` and
 * encrypts row content before it ever crosses into the worker; the
 * worker stores ciphertext-only.
 *
 * Usage:
 *
 * ```ts
 * import { createRepo } from "@opfs/storage";
 * const repo = await createRepo({ vault });
 * const page = await repo.listNotes();
 * await repo.upsertNote({ title: "hello", body: "world" });
 * ```
 */

import type { CryptoVault } from "@opfs/core-wasm";

import { Repo } from "./repo.js";
import { WorkerClient } from "./rpc.js";

export type { ListPage, Note, NoteInput } from "./repo.js";
export { Repo } from "./repo.js";
export type { EncryptedNoteRow, StorageEventName } from "./row.js";

export type CreateRepoOptions = {
	readonly vault: CryptoVault;
	/**
	 * Optional `Worker` factory override — useful for tests that want
	 * to substitute a stub. Default constructs the bundled
	 * `db-worker.ts` via `new Worker(new URL(...))`.
	 */
	readonly workerFactory?: () => Worker;
};

function defaultWorker(): Worker {
	return new Worker(new URL("./db-worker.ts", import.meta.url), {
		type: "module",
		name: "opfs-storage-db",
	});
}

/**
 * Boot the dedicated DB worker and return a ready-to-use `Repo`.
 */
export async function createRepo(opts: CreateRepoOptions): Promise<Repo> {
	const worker = opts.workerFactory ? opts.workerFactory() : defaultWorker();
	const client = new WorkerClient(worker);
	const repo = new Repo(client, opts.vault);
	await repo.bootstrap();
	return repo;
}
