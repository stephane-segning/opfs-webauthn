/**
 * `NEXT_OUTPUT_EXPORT=1` switches the build to a fully static export
 * for GitHub Pages. The Pages workflow (`.github/workflows/deploy.yml`)
 * sets that env. Local dev and the regular CI build leave it off and
 * use the standard Next.js build.
 *
 * `NEXT_PUBLIC_BASE_PATH` is set in CI when the app is served under
 * a project URL (e.g. `/opfs-webauthn`).
 */

const isExport = process.env.NEXT_OUTPUT_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import("next").NextConfig} */
const config = {
	...(isExport ? { output: "export" } : {}),
	...(basePath ? { basePath } : {}),
	images: { unoptimized: isExport },
	trailingSlash: isExport,
	// Workspace packages publish TypeScript source with Node ESM-style
	// `.js` import specifiers. Next.js + webpack can't resolve those
	// out of the box, so we let Next transpile them as if they were
	// part of the app and map `./foo.js` → `./foo.ts(x)?` during
	// resolution.
	transpilePackages: ["@opfs/auth", "@opfs/core-wasm", "@opfs/design-tokens"],
	webpack(webpackConfig) {
		webpackConfig.resolve.extensionAlias = {
			...(webpackConfig.resolve.extensionAlias ?? {}),
			".js": [".ts", ".tsx", ".js"],
		};
		return webpackConfig;
	},
};

export default config;
