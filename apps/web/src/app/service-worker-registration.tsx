"use client";

import { useEffect } from "react";

import pkg from "../../package.json";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const BUILD_ID = pkg.version;

/**
 * Client-only service-worker registration. Mounted once from the
 * root layout. The build id rides in the query string so a deploy
 * mints a fresh SW (and a fresh cache).
 */
export function ServiceWorkerRegistration() {
	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
			return;
		const url = `${BASE_PATH}/sw.js?v=${encodeURIComponent(BUILD_ID)}`;
		const scope = `${BASE_PATH}/`;
		navigator.serviceWorker.register(url, { scope }).catch((err) => {
			// Service worker is a progressive enhancement; failure to
			// register isn't fatal, just no offline shell.
			console.warn("service worker registration failed", err);
		});
	}, []);
	return null;
}
