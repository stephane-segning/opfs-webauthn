/*
 * opfs-webauthn service worker — hand-rolled, no Workbox.
 *
 * Why hand-rolled?
 * - The app is a single-page static export. The interesting offline
 *   surface is: one HTML shell, a handful of hashed JS/CSS chunks,
 *   two `.wasm` blobs, the manifest + icons. That's ~30 URLs. A
 *   Workbox build adds a dep tree, a separate build step, and a
 *   second source of truth for caching strategy — overkill for a
 *   precache + cache-first SW that fits in ~80 lines.
 * - The project leans hard on "few, auditable deps" (read the rest
 *   of the lockfile: no PWA framework, no webpack plugins beyond
 *   what Next ships). Adding `workbox-build` would be the largest
 *   single dependency in the web app.
 *
 * Caching strategy
 * - **Install**: open the cache and `addAll(...)` every URL the
 *   build emitted in `sw-manifest.js`. If any URL fails, the SW
 *   install fails — that's deliberate. A half-precached shell is
 *   worse than no SW at all because it gives the user a confident
 *   "you're offline-ready" signal that won't survive airplane mode.
 * - **Activate**: claim clients (so the freshly-installed worker
 *   controls the page that registered it without a reload) and
 *   evict any cache whose key starts with our prefix but isn't the
 *   current version. Scoped to our prefix so we don't touch other
 *   PWAs that may share the origin (e.g. `*.github.io`).
 * - **Fetch**:
 *   - GET only; same-origin only. Cross-origin and non-GET pass
 *     through to the network — caching POSTs to the share backend
 *     would corrupt the rendezvous protocol.
 *   - Requests under `/api/` pass through unconditionally. The
 *     share backend is on the same origin under that prefix in
 *     production and the encrypted-blob lifecycle (pickup-once,
 *     server deletes on read) is incompatible with any cache.
 *   - `/config.js` (and any `BASE_PATH`-prefixed equivalent) is
 *     rendered at container start from deployment env vars and is
 *     not content-hashed; pass it through unconditionally so env
 *     rotations land on the next request, not on a manual cache
 *     bust.
 *   - When the precache manifest is missing (dev / non-static-export
 *     build), bypass the SW entirely — `urls` is empty, `version` is
 *     `dev`, and routing through `cacheFirst` would just leak bytes
 *     into a cache the install hook never primed.
 *   - Navigation requests (HTML): try the network first so a deploy
 *     lands immediately; on failure (offline), fall back to the
 *     cached `index.html`. Static export means every route renders
 *     the same shell, so one cached shell is enough.
 *   - Everything else under the precache: cache-first. Hashed URLs
 *     are immutable; once cached they never need network.
 *   - Misses (a URL the build didn't precache): go to network and
 *     opportunistically cache the response if it's same-origin,
 *     successful, and not under `/api/`. This catches lazy chunks
 *     Next.js may load on demand.
 *
 * Versioning
 * - `sw-manifest.js` defines `self.__OPFS_PRECACHE = { version, urls }`.
 *   `version` is a content hash of the manifest plus the Next.js
 *   `BUILD_ID`, computed at build time by
 *   `apps/web/scripts/build-precache-manifest.mjs`. A code change
 *   ⇒ new `BUILD_ID` ⇒ new manifest hash ⇒ new cache key ⇒ old
 *   cache evicted on `activate`.
 *
 * skipWaiting + clients.claim
 * - We call both. The previous incarnation of this file avoided
 *   `skipWaiting` to keep multi-tab consistency, but with a
 *   precache-everything strategy the new worker has the full new
 *   shell ready before it activates, so taking over immediately is
 *   safe — and gets users their fix without a tab reload.
 *
 * Manual smoke (no unit tests for this file — runs inside a real
 * SW context that vitest doesn't emulate):
 * 1. `NEXT_OUTPUT_EXPORT=1 pnpm --filter @opfs/web build` to produce
 *    a real `out/sw-manifest.js`. Serve `out/` (e.g. `npx serve`),
 *    load the page, check DevTools → Application → Service Workers
 *    shows it active and Cache Storage holds `opfs-shell-<hash>`
 *    with the manifest URLs.
 * 2. Re-request `/config.js` with the Network tab open: it must
 *    miss the SW cache every time (no "(from ServiceWorker)" entry
 *    served from cache; an immediate change to the file on disk
 *    must surface on the next reload).
 * 3. `pnpm --filter @opfs/web build` (no `NEXT_OUTPUT_EXPORT`):
 *    serve the worker manually and confirm Cache Storage stays
 *    empty — every fetch should hit network only, and no
 *    `opfs-shell-dev` cache should appear.
 */

// `sw-manifest.js` is emitted by `scripts/build-precache-manifest.mjs`,
// which only runs when Next produces a static export (`out/`). For a
// regular `next build` (no `NEXT_OUTPUT_EXPORT=1`) the file is absent
// and `importScripts` would throw, aborting SW evaluation entirely —
// meaning even the no-op fetch handler below would never be installed.
// Swallow the failure so the worker still evaluates; without a
// manifest we fall back to a `dev` cache key and an empty precache
// list, which makes `install` a no-op and every `fetch` go straight
// to the network. That degrades gracefully into "no offline shell"
// rather than "SW silently broken".
try {
	importScripts("./sw-manifest.js");
} catch (_noManifest) {
	// Intentionally empty — see comment above.
}

const PRECACHE = self.__OPFS_PRECACHE ?? { version: "dev", urls: [] };
const CACHE_PREFIX = "opfs-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${PRECACHE.version}`;
const SHELL_URL = "./index.html";

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			// `addAll` is atomic-ish: if any single request fails the
			// whole call rejects and the SW install fails. That's the
			// behaviour we want — see comment block above.
			await cache.addAll(PRECACHE.urls);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			const stale = keys.filter(
				(k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME,
			);
			await Promise.all(stale.map((k) => caches.delete(k)));
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("message", (event) => {
	// Lets the page tell a waiting worker to activate immediately
	// without the user having to close every tab. The registration
	// script can post this after surfacing the "update available"
	// affordance.
	if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// `/config.js` is rendered at container start from deployment env
// vars (see `src/app/layout.tsx` and `docker/40-render-config.sh`);
// it is **not** content-hashed, so caching it would mask deploy-time
// env rotations until the cache is manually busted. Treat it the
// same as `/api/*`: never cache, always go to the network. The check
// covers both the bare `/config.js` and any `BASE_PATH`-prefixed
// form a sub-path deploy produces (e.g. `/myapp/config.js`).
function isRuntimeConfig(pathname) {
	return pathname === "/config.js" || pathname.endsWith("/config.js");
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.includes("/api/")) return;
	if (isRuntimeConfig(url.pathname)) return;

	// Dev / non-static-export build: no `sw-manifest.js`, so the
	// precache list is empty and `CACHE_NAME` is the placeholder
	// `opfs-shell-dev`. Routing every same-origin GET through
	// `cacheFirst` here would silently accumulate bytes in a
	// `dev`-keyed cache that `install` never primed and that
	// `activate` won't purge across deploys (the version never
	// changes). Bypass entirely — network-only, no offline shell.
	if (PRECACHE.urls.length === 0) return;

	if (request.mode === "navigate") {
		event.respondWith(navigationStrategy(request));
		return;
	}
	event.respondWith(cacheFirst(request));
});

async function navigationStrategy(request) {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		// A 5xx from the origin is functionally equivalent to "offline"
		// from the user's perspective: the network reached the server
		// but the server can't serve the shell. Prefer the cached
		// shell so the SPA still boots and routing/state work, rather
		// than handing the user the origin's error page. A 404 still
		// passes through (it likely means the user typed an unknown
		// path on a domain we don't control, and shadowing it with
		// our shell would be misleading).
		if (response.ok || response.status === 404) return response;
		const shell = await cache.match(SHELL_URL);
		if (shell) return shell;
		return response;
	} catch (_offline) {
		const shell = await cache.match(SHELL_URL);
		if (shell) return shell;
		// Last resort: a synthesised 503 so the browser doesn't show
		// the platform's generic offline page after we promised
		// offline support.
		return new Response("Offline", {
			status: 503,
			statusText: "Offline",
			headers: { "Content-Type": "text/plain" },
		});
	}
}

async function cacheFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	// Only cache success responses; opaque (0) responses from
	// cross-origin already filtered out above, but a same-origin 4xx
	// shouldn't pollute the cache either.
	if (response.ok) {
		// Clone before the body is consumed — `fetch` returns a
		// single-use stream.
		cache.put(request, response.clone()).catch(() => {
			// Storage quota / private-mode failures shouldn't break
			// the response we're already returning to the page.
		});
	}
	return response;
}
