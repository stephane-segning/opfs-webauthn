/**
 * `@opfs/storage` — sqlite-wasm + OPFS writer with a typed RPC
 * client. Prefers a `SharedWorker` so multiple tabs share one
 * writer (ADR 0006); falls back to a dedicated `Worker` when
 * `SharedWorker` is unavailable (notably older iOS Safari).
 *
 * The page-side `Repo` holds the `CryptoVault` and encrypts row
 * content before it ever crosses into the worker; the worker stores
 * ciphertext only.
 *
 * Usage:
 *
 * ```ts
 * import { createRepo } from "@opfs/storage";
 * const repo = await createRepo({ vault });
 * await repo.upsertNote({ title: "hello", body: "world" });
 * ```
 */

import type { CryptoVault } from "@opfs/core-wasm";

import { Repo } from "./repo.js";
import { WorkerClient, type WorkerLike } from "./rpc.js";

export type { ListPage, Note, NoteInput } from "./repo.js";
export { Repo } from "./repo.js";
export type { EncryptedNoteRow, StorageEventName } from "./row.js";

export type CreateRepoOptions = {
	readonly vault: CryptoVault;
	/**
	 * Optional transport override — useful for tests. Default tries
	 * `SharedWorker`, then falls back to a dedicated `Worker`.
	 */
	readonly transport?: WorkerLike;
};

const SHARED_WORKER_NAME = "opfs-storage-db";

const supportsSharedWorker = (): boolean =>
	typeof globalThis !== "undefined" &&
	typeof (globalThis as { SharedWorker?: unknown }).SharedWorker !==
		"undefined";

function adaptDedicated(worker: Worker): WorkerLike {
	return {
		postMessage: (data) => worker.postMessage(data),
		addEventListener: worker.addEventListener.bind(worker),
		removeEventListener: worker.removeEventListener.bind(worker),
		close: () => worker.terminate(),
	};
}

function adaptShared(shared: SharedWorker): WorkerLike {
	shared.port.start();
	// Messages flow over the port; error events fire on the SharedWorker
	// object itself (e.g. script load failure), so each channel routes
	// to the endpoint that actually emits it.
	const route = (
		method: "addEventListener" | "removeEventListener",
		type: "message" | "error",
		listener: EventListener,
	): void => {
		if (type === "error") shared[method]("error", listener);
		else shared.port[method]("message", listener);
	};
	return {
		postMessage: (data) => shared.port.postMessage(data),
		addEventListener: (type, listener) =>
			route("addEventListener", type, listener as EventListener),
		removeEventListener: (type, listener) =>
			route("removeEventListener", type, listener as EventListener),
		close: () => shared.port.close(),
	};
}

function defaultTransport(): WorkerLike {
	if (supportsSharedWorker()) {
		const shared = new SharedWorker(
			new URL("./db-shared-worker.ts", import.meta.url),
			{ type: "module", name: SHARED_WORKER_NAME },
		);
		return adaptShared(shared);
	}
	const dedicated = new Worker(new URL("./db-worker.ts", import.meta.url), {
		type: "module",
		name: SHARED_WORKER_NAME,
	});
	return adaptDedicated(dedicated);
}

/**
 * Boot the storage worker and return a ready-to-use `Repo`.
 */
export async function createRepo(opts: CreateRepoOptions): Promise<Repo> {
	const transport = opts.transport ?? defaultTransport();
	const client = new WorkerClient(transport);
	const repo = new Repo(client, opts.vault);
	await repo.bootstrap();
	return repo;
}
