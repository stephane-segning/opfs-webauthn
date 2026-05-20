/**
 * `NEXT_OUTPUT_EXPORT=1` switches the build to a fully static export
 * for GitHub Pages. The Pages workflow (`.github/workflows/deploy.yml`)
 * sets that env. Local dev and the regular CI build leave it off and
 * use the standard Next.js build.
 *
 * `NEXT_PUBLIC_BASE_PATH` is read here so the same build serves
 * either from a project URL (e.g. `/opfs-webauthn`) or the apex of
 * a custom domain (production now: `ocs.vaam.store`, basePath
 * unset → empty string → no prefix).
 *
 * Heads-up: moving the served domain changes the WebAuthn rpId
 * (which is `location.hostname` at credential-creation time), so
 * existing passkeys bound to the old hostname will not unlock the
 * vault from the new one. Document loudly if we ever migrate again.
 */

import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
	transpilePackages: [
		"@opfs/auth",
		"@opfs/core-wasm",
		"@opfs/design-tokens",
		"@opfs/share-client",
		"@opfs/state",
		"@opfs/storage",
	],
	webpack(webpackConfig) {
		webpackConfig.resolve.extensionAlias = {
			...(webpackConfig.resolve.extensionAlias ?? {}),
			".js": [".ts", ".tsx", ".js"],
		};
		return webpackConfig;
	},
};

export default withNextIntl(config);
