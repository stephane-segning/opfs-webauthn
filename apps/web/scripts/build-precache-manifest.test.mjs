import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildManifest, renderManifest } from "./build-precache-manifest.mjs";

/**
 * Creates a fake `out/` tree matching the layout Next.js' static
 * export produces. Returns the dir path; the test is responsible
 * for cleanup.
 */
async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), "opfs-sw-test-"));
	const w = async (rel, body = "x") => {
		const full = join(root, rel);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, body);
	};
	await w("index.html", "<html></html>");
	await w("404.html", "<html>404</html>");
	await w("index.txt", "ignored");
	await w("manifest.webmanifest", "{}");
	await w("favicon.ico", "ico");
	await w("icon-192.png", "png");
	await w("icon-512.png", "png");
	await w("icon.svg", "<svg/>");
	await w("apple-touch-icon.png", "png");
	await w("sw.js", "/* must be excluded */");
	await w("sw-manifest.js", "/* must be excluded */");
	await w("_next/static/chunks/main-abc123.js", "main");
	await w("_next/static/chunks/app/page-def456.js", "page");
	await w("_next/static/css/styles-789.css", "css");
	await w("_next/static/media/opfs_core.cc616bca.wasm", "wasm");
	await w("_next/static/build-id/_buildManifest.js", "bm");
	// Pretend a future build leaked an API payload — must be skipped.
	await w("_next/static/api/leak.json", "{}");
	await w("404/index.html", "<html>404</html>");
	return root;
}

describe("buildManifest", () => {
	let outDir;
	beforeEach(async () => {
		outDir = await makeFixture();
	});
	afterEach(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it("includes the HTML shell and top-level static assets", async () => {
		const manifest = await buildManifest(outDir);
		expect(manifest.urls).toContain("./index.html");
		expect(manifest.urls).toContain("./manifest.webmanifest");
		expect(manifest.urls).toContain("./favicon.ico");
		expect(manifest.urls).toContain("./icon-192.png");
		expect(manifest.urls).toContain("./icon-512.png");
		expect(manifest.urls).toContain("./icon.svg");
		expect(manifest.urls).toContain("./apple-touch-icon.png");
	});

	it("includes all hashed JS/CSS/wasm under _next/static", async () => {
		const manifest = await buildManifest(outDir);
		expect(manifest.urls).toContain("./_next/static/chunks/main-abc123.js");
		expect(manifest.urls).toContain("./_next/static/chunks/app/page-def456.js");
		expect(manifest.urls).toContain("./_next/static/css/styles-789.css");
		expect(manifest.urls).toContain(
			"./_next/static/media/opfs_core.cc616bca.wasm",
		);
		expect(manifest.urls).toContain(
			"./_next/static/build-id/_buildManifest.js",
		);
	});

	it("excludes sw.js, sw-manifest.js, 404.html, index.txt, and 404/", async () => {
		const manifest = await buildManifest(outDir);
		expect(manifest.urls).not.toContain("./sw.js");
		expect(manifest.urls).not.toContain("./sw-manifest.js");
		expect(manifest.urls).not.toContain("./404.html");
		expect(manifest.urls).not.toContain("./index.txt");
		expect(manifest.urls.every((u) => !u.startsWith("./404/"))).toBe(true);
	});

	it("excludes anything under an /api/ path segment", async () => {
		const manifest = await buildManifest(outDir);
		expect(manifest.urls.every((u) => !u.includes("/api/"))).toBe(true);
	});

	it("emits URLs as relative paths with forward slashes", async () => {
		const manifest = await buildManifest(outDir);
		for (const url of manifest.urls) {
			expect(url.startsWith("./")).toBe(true);
			expect(url.includes("\\")).toBe(false);
		}
	});

	it("sorts the URL list deterministically", async () => {
		const a = await buildManifest(outDir);
		const b = await buildManifest(outDir);
		expect(a.urls).toEqual(b.urls);
		const sorted = [...a.urls].sort();
		expect(a.urls).toEqual(sorted);
	});

	it("changes the version when a file's content changes", async () => {
		const before = await buildManifest(outDir);
		await writeFile(
			join(outDir, "_next/static/chunks/main-abc123.js"),
			"main-different-payload-of-different-length",
		);
		const after = await buildManifest(outDir);
		expect(before.version).not.toBe(after.version);
	});

	it("changes the version when contents differ but sizes match", async () => {
		// Guards against a regression where the version hash was
		// derived from `stat.size` only: a deploy that swaps a
		// non-hashed asset (`index.html`, `config.js`) for one of
		// identical byte length would have kept the same cache key
		// and served stale bytes forever.
		const shellPath = join(outDir, "index.html");
		await writeFile(shellPath, "AAAAAAAAAA");
		const before = await buildManifest(outDir);
		await writeFile(shellPath, "BBBBBBBBBB");
		const after = await buildManifest(outDir);
		expect(after.urls).toEqual(before.urls);
		expect(after.version).not.toBe(before.version);
	});

	it("produces a 16-char hex version stamp", async () => {
		const manifest = await buildManifest(outDir);
		expect(manifest.version).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("renderManifest", () => {
	it("emits valid JS that sets self.__OPFS_PRECACHE", () => {
		const out = renderManifest({ version: "abc123", urls: ["./a.js"] });
		expect(out).toMatch(/self\.__OPFS_PRECACHE =/);
		expect(out).toMatch(/"version": "abc123"/);
		expect(out).toMatch(/"\.\/a\.js"/);
	});
});
