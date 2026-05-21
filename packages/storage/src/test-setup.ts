/**
 * vitest setup file (`vitest.config.ts` → `test.setupFiles`).
 *
 * Pre-loads the wasm-bindgen bundle from disk via `node:fs` so the
 * later `init()` call inside production `ensureWasm()` short-circuits
 * — wasm-bindgen's web target caches the loaded module on a private
 * variable and bails fast on subsequent inits.
 *
 * Lives in this file (not `wasm.ts`) so `node:fs` / `node:url`
 * never appear in the Next.js / webpack import graph. webpack
 * rejects `node:` schema specifiers even behind guarded dynamic
 * imports — they're statically resolved before the guard runs.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import init from "@opfs/core-wasm";

// Resolve relative to this file. `import.meta.url` works under
// vitest (esm runner); the path traverses out of
// `packages/storage/src/` into `packages/core-wasm/dist/`.
const wasmUrl = new URL(
	"../../core-wasm/dist/opfs_core_bg.wasm",
	import.meta.url,
);
await init(await readFile(fileURLToPath(wasmUrl)));
