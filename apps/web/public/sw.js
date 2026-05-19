/*
 * Minimal service worker for opfs-webauthn.
 *
 * Strategy:
 * - All requests for hashed Next.js bundles (`_next/static/...`) and
 *   the `.wasm` artifacts are cache-first: they're immutable, hashed
 *   URLs, so once cached they never need network again.
 * - HTML navigations are network-first with cache fallback so a fresh
 *   deploy lands immediately but a flaky network still shows the
 *   shell.
 * - Everything else passes through to the network.
 *
 * The cache key picks up the `?v=` query parameter the registration
 * script appends with the current build id. A deploy → new value → a
 * fresh SW installs (browsers treat each unique SW URL as a distinct
 * worker) → old caches evicted on activate. No `skipWaiting` — we
 * don't want a half-updated page if multiple tabs are open.
 */

const BUILD_ID = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_NAME = `opfs-webauthn-${BUILD_ID}`;

function isImmutable(url) {
	return (
		url.pathname.includes("/_next/static/") || url.pathname.endsWith(".wasm")
	);
}

function isHtmlNavigation(request) {
	return (
		request.mode === "navigate" ||
		(request.method === "GET" &&
			(request.headers.get("accept") || "").includes("text/html"))
	);
}

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
			);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (isImmutable(url)) {
		event.respondWith(cacheFirst(request));
		return;
	}
	if (isHtmlNavigation(request)) {
		event.respondWith(networkFirst(request));
	}
});

async function cacheFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) cache.put(request, response.clone());
	return response;
}

async function networkFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		throw err;
	}
}
