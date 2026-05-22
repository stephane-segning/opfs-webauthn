/**
 * One-time wasm initialisation for the storage layer.
 *
 * Production / browser path: `init()` with no args lets the
 * `@opfs/core-wasm` web build resolve the .wasm relative to its
 * own URL via `fetch()`. That works in any browser / dedicated /
 * shared worker.
 *
 * Test path: `vitest.config.ts` wires a setup file
 * (`src/test-setup.ts`) that pre-loads the wasm bytes via
 * `node:fs/promises` and calls `init(bytes)` BEFORE any test
 * file runs. The wasm-bindgen `init()` is internally
 * short-circuited once a module is loaded, so the production
 * `ensureWasm()` call inside tests becomes a no-op.
 *
 * Splitting it this way keeps `node:fs` + `node:url` out of the
 * Next.js / webpack bundle entirely — even guarded dynamic
 * imports would otherwise pull a `node:` schema reference into
 * the browser graph and webpack rejects those (`UnhandledSchemeError`).
 *
 * The init is memoised — every consumer calls `ensureWasm()` and
 * pays the load cost exactly once. Subsequent calls await the
 * same in-flight promise. `getWasm()` is the synchronous
 * accessor; it throws if ensureWasm hasn't resolved yet, which
 * surfaces lifecycle bugs at the call site instead of inside the
 * binding.
 */

import init, * as raw from "@opfs/core-wasm";

export type WasmExports = typeof raw;

let initPromise: Promise<void> | null = null;
let ready = false;

/**
 * Idempotent. Triggers `init()` on the first call; awaits the same
 * pending promise on subsequent calls. Safe to call from anywhere
 * the storage layer reaches.
 */
export function ensureWasm(): Promise<void> {
	if (!initPromise) {
		initPromise = init().then(() => {
			ready = true;
		});
	}
	// initPromise is guaranteed non-null here: either it was already
	// set before the guard, or the block above just assigned it.
	// biome-ignore lint/style/noNonNullAssertion: see comment above
	return initPromise!;
}

/**
 * Synchronous accessor for the wasm bindings. **Caller must have
 * already awaited `ensureWasm()`** — otherwise we throw a
 * lifecycle-bug error here instead of letting the bindings emit
 * their own less-readable error from inside the wasm boundary.
 */
export function getWasm(): WasmExports {
	if (!ready) {
		throw new Error(
			"opfs-storage: getWasm() called before ensureWasm() resolved",
		);
	}
	return raw;
}
