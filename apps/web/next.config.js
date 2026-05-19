/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 *
 * Set `NEXT_OUTPUT_EXPORT=1` (and optionally `NEXT_PUBLIC_BASE_PATH`) to
 * produce a fully static build for GitHub Pages. The Pages workflow
 * (`.github/workflows/deploy.yml`) sets these. Locally and in CI the
 * default Node-server build is used until the tRPC scaffold is removed.
 */
import "./src/env.js";

const isExport = process.env.NEXT_OUTPUT_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import("next").NextConfig} */
const config = {
	...(isExport ? { output: "export" } : {}),
	...(basePath ? { basePath, assetPrefix: basePath } : {}),
	images: { unoptimized: isExport },
	trailingSlash: isExport,
};

export default config;
