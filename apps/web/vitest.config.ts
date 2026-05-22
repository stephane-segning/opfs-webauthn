import { defineConfig } from "vitest/config";

// The default vitest esbuild config uses classic JSX (`React.createElement`),
// which fails for TSX test files in this codebase — we run React 19 with the
// automatic runtime everywhere else (next.js is configured that way). Pinning
// `jsx: "automatic"` here aligns the test runtime with the app runtime.
export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
});
