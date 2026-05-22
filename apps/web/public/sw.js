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

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.includes("/api/")) return;

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
