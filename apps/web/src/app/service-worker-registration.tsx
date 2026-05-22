"use client";

import { useEffect } from "react";

import pkg from "../../package.json";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const BUILD_ID = pkg.version;
// `next dev` rebuilds `_next/static/*` chunks on every change. The
// SW caches them cache-first, which would serve stale code until the
// worker is manually cleared. So we register only in production
// builds — dev gets normal HMR, prod gets offline support.
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Client-only service-worker registration. Mounted once from the
 * root layout. The build id rides in the query string so a deploy
 * mints a fresh SW (and a fresh cache).
 *
 * Update affordance: when the browser detects a new SW (`updatefound`
 * + `installed` while a controller already exists), we log a
 * console.info so the operator can verify the new version landed.
 * A user-facing toast would be nicer but isn't blocking — the SW
 * itself uses `skipWaiting` + `clients.claim` so the new shell
 * takes over on the next navigation regardless.
 */
export function ServiceWorkerRegistration() {
	useEffect(() => {
		if (!IS_PRODUCTION) return;
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
			return;
		const url = `${BASE_PATH}/sw.js?v=${encodeURIComponent(BUILD_ID)}`;
		const scope = `${BASE_PATH}/`;
		navigator.serviceWorker
			.register(url, { scope })
			.then((registration) => {
				registration.addEventListener("updatefound", () => {
					const installing = registration.installing;
					if (!installing) return;
					installing.addEventListener("statechange", () => {
						// `installed` + an existing controller means the
						// page is now being managed by an older worker
						// and a fresh one is queued. With `skipWaiting`
						// in the SW the takeover is automatic; we still
						// log so the update is observable in DevTools.
						if (
							installing.state === "installed" &&
							navigator.serviceWorker.controller
						) {
							console.info(
								"opfs: a new version is ready and will activate shortly",
							);
						}
					});
				});
			})
			.catch((err) => {
				// Service worker is a progressive enhancement; failure to
				// register isn't fatal, just no offline shell.
				console.warn("service worker registration failed", err);
			});
	}, []);
	return null;
}
