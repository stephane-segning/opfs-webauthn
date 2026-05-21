/**
 * `@opfs/storage` — sqlite-wasm + OPFS writer with a typed RPC
 * client. Prefers a `SharedWorker` so multiple tabs share one
 * writer (ADR 0006); falls back to a dedicated `Worker` when
 * `SharedWorker` is unavailable (older iOS Safari) **or** when the
 * shared worker can't install the OPFS SAH-pool VFS (Firefox today
 * — `FileSystemFileHandle.prototype.createSyncAccessHandle` is
 * exposed in DedicatedWorker but not yet in SharedWorker).
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
import { ensureWasm } from "./wasm.js";

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

/** sqlite-wasm's exact message when the OPFS SAH-pool VFS isn't usable. */
const OPFS_UNAVAILABLE_MARKER = "Missing required OPFS APIs";

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

function makeSharedTransport(): WorkerLike {
	const shared = new SharedWorker(
		new URL("./db-shared-worker.ts", import.meta.url),
		{ type: "module", name: SHARED_WORKER_NAME },
	);
	return adaptShared(shared);
}

function makeDedicatedTransport(): WorkerLike {
	const dedicated = new Worker(new URL("./db-worker.ts", import.meta.url), {
		type: "module",
		name: SHARED_WORKER_NAME,
	});
	return adaptDedicated(dedicated);
}

/**
 * Did `repo.bootstrap()` fail because the worker context lacks the
 * OPFS-SAH APIs? The marker comes straight from sqlite-wasm's
 * `installOpfsSAHPoolVfs`. We match the substring (not the full
 * message) so future minor wording changes upstream don't break us.
 */
function isOpfsUnavailable(err: unknown): boolean {
	if (err instanceof Error)
		return err.message.includes(OPFS_UNAVAILABLE_MARKER);
	if (typeof err === "string") return err.includes(OPFS_UNAVAILABLE_MARKER);
	return false;
}

async function bootRepo(
	transport: WorkerLike,
	vault: CryptoVault,
): Promise<Repo> {
	const client = new WorkerClient(transport);
	const repo = new Repo(client, vault);
	try {
		await repo.bootstrap();
		return repo;
	} catch (err) {
		// Surface the worker handle so the caller can tear the worker
		// down before attempting a different transport.
		client.terminate();
		throw err;
	}
}

/**
 * Boot the storage worker and return a ready-to-use `Repo`.
 *
 * If `SharedWorker` is available we try it first (ADR 0006: one
 * writer across tabs). If `bootstrap()` rejects with sqlite-wasm's
 * "Missing required OPFS APIs." — currently Firefox, which exposes
 * `createSyncAccessHandle` only in dedicated workers — we tear that
 * worker down and retry on a `DedicatedWorker`. Per-tab semantics
 * lose the cross-tab single-writer guarantee but the app stays
 * usable, which is the right trade-off until SharedWorker support
 * for OPFS-SAH is universal.
 */
export async function createRepo(opts: CreateRepoOptions): Promise<Repo> {
	// `Repo` reaches into wasm-backed helpers (`generateRowId`,
	// `aadFor`) synchronously, so initialise the wasm bundle on the
	// page side before any of that runs. `ensureWasm` is idempotent
	// — the worker calls it too on first DB open.
	await ensureWasm();
	if (opts.transport) {
		// Test / advanced path: caller controls the transport.
		return bootRepo(opts.transport, opts.vault);
	}
	if (supportsSharedWorker()) {
		try {
			return await bootRepo(makeSharedTransport(), opts.vault);
		} catch (err) {
			if (!isOpfsUnavailable(err)) throw err;
			// SharedWorker can't open OPFS on this browser. Fall through
			// to the dedicated worker so the user still gets a working
			// app, just per-tab instead of cross-tab.
			console.warn(
				"opfs-storage: SharedWorker lacks createSyncAccessHandle; falling back to dedicated worker",
				err,
			);
		}
	}
	return bootRepo(makeDedicatedTransport(), opts.vault);
}
