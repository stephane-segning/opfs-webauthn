/**
 * One-time wasm initialisation for the storage layer.
 *
 * `@opfs/core-wasm` is built with wasm-pack's `--target web` flag,
 * so its `init()` fetches the .wasm via `fetch()` against
 * `import.meta.url`. That works in any browser / worker context but
 * NOT in vitest's default node environment — `fetch()` won't read
 * a local file. So this module sniffs the environment:
 *
 * - In a browser, worker, or service-worker context (everywhere
 *   `WorkerGlobalScope` or `window` exists), call `init()` with no
 *   args — wasm-pack's default path resolution does the right
 *   thing.
 * - In node (vitest), read the .wasm via `node:fs/promises` and
 *   pass the bytes directly to `init()`. wasm-pack accepts a
 *   `BufferSource` and skips the fetch.
 *
 * The init is memoised — every consumer calls `ensureWasm()` and
 * pays the load cost exactly once. Subsequent calls await the
 * same in-flight promise.
 *
 * After `ensureWasm()` resolves, `getWasm()` returns the namespace
 * of synchronous bindings — `encodeRowId`, `aadFor`, `schemaSql`,
 * and friends. Calling `getWasm()` before init throws to surface a
 * lifecycle bug loudly instead of erroring later inside the bindings.
 */

import init, * as raw from "@opfs/core-wasm";

export type WasmExports = typeof raw;

let initPromise: Promise<void> | null = null;
let initialized = false;

function inBrowserLikeContext(): boolean {
	// In a DedicatedWorker or SharedWorker, `self` is the global and
	// `WorkerGlobalScope` exists; `window` is undefined. In a page,
	// `window` exists. Both have working `fetch`. node — even node 18+
	// with the global fetch — doesn't surface `WorkerGlobalScope` or
	// `window`, so this branch picks the right strategy without
	// depending on `process.versions.node` (which is stripped by some
	// bundlers).
	return (
		(typeof globalThis !== "undefined" &&
			(globalThis as { window?: unknown }).window !== undefined) ||
		(typeof globalThis !== "undefined" &&
			"WorkerGlobalScope" in globalThis &&
			typeof (globalThis as { self?: unknown }).self !== "undefined")
	);
}

async function loadNodeWasmBytes(): Promise<ArrayBuffer> {
	// Dynamic imports keep `node:fs` out of the browser bundle. The
	// bundler can statically prove these never run in the browser
	// because `inBrowserLikeContext` guards their call site.
	const [{ readFile }, { fileURLToPath }] = await Promise.all([
		import("node:fs/promises"),
		import("node:url"),
	]);
	// Resolve relative to this file, which lives in `packages/storage/src/`.
	// The wasm dist is at `packages/core-wasm/dist/opfs_core_bg.wasm`.
	const wasmUrl = new URL(
		"../../core-wasm/dist/opfs_core_bg.wasm",
		import.meta.url,
	);
	const buf = await readFile(fileURLToPath(wasmUrl));
	// Node's Buffer extends Uint8Array but isn't an ArrayBuffer.
	// wasm-bindgen accepts BufferSource, so slice into a real
	// ArrayBuffer to keep the type contract honest.
	return buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength,
	) as ArrayBuffer;
}

/**
 * Idempotent. Triggers `init()` on the first call; awaits the same
 * pending promise on subsequent calls. Safe to call from anywhere
 * the storage layer reaches.
 */
export function ensureWasm(): Promise<void> {
	if (initialized) return Promise.resolve();
	if (!initPromise) {
		initPromise = (async () => {
			const input = inBrowserLikeContext()
				? undefined
				: await loadNodeWasmBytes();
			await init(input);
			initialized = true;
		})();
	}
	return initPromise;
}

/**
 * Synchronous accessor for the wasm bindings. **Caller must have
 * already awaited `ensureWasm()`** — otherwise the named bindings
 * inside `@opfs/core-wasm` throw at first use. The early-throw here
 * surfaces that lifecycle bug at the call site instead of inside
 * the binding.
 */
export function getWasm(): WasmExports {
	if (!initialized) {
		throw new Error(
			"opfs-storage: getWasm() called before ensureWasm() resolved",
		);
	}
	return raw;
}
