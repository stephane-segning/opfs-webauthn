import { defineConfig } from "vitest/config";

// `setupFiles` runs once before any test file; we use it to load
// the wasm-bindgen bundle from disk so production `ensureWasm()`
// calls inside tests short-circuit instead of trying `fetch()`
// against a non-existent vitest-host URL. See `src/test-setup.ts`.
export default defineConfig({
	test: {
		setupFiles: ["./src/test-setup.ts"],
	},
});
