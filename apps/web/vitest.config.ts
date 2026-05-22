/**
 * Vitest config for the web app. We override the project's
 * `jsx: "preserve"` (which is for Next's compiler) so that esbuild
 * lowers JSX with the automatic runtime during test runs — otherwise
 * any `.tsx` test file or imported React component crashes with
 * `React is not defined`. Pinning `jsx: "automatic"` here aligns the
 * test runtime with the app runtime (Next 15 + React 19 use the
 * automatic runtime everywhere).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
});
