/**
 * Feature flag + backend wiring for the share flow.
 *
 * The share-backend URL is **runtime-configured**, not baked at
 * build time: the container's entrypoint substitutes
 * `${SHARE_BACKEND_URL}` from the pod env into
 * `/usr/share/nginx/html/config.js` (a tiny script that sets
 * `window.__OPFS_CONFIG__`), and the root layout loads that file
 * synchronously before any bundle script runs. So the same image
 * digest works in any cluster — the Helm chart's
 * `env.shareBackendUrl` flows through to here without a rebuild.
 *
 * `getShareConfig` reads the config lazily on first call so the
 * module itself stays SSR-safe (no `window` access at import
 * time). The only caller is `notes-shell.tsx`, which is a
 * `"use client"` component, so this never runs server-side in
 * practice — but the lazy read makes the contract explicit.
 *
 * Empty / missing URL → share UI disabled. Any non-empty value
 * is used verbatim as the rendezvous client's `baseUrl`.
 */

import { RendezvousClient } from "@opfs/share-client";

type OpfsRuntimeConfig = {
	readonly shareBackendUrl?: string;
};

declare global {
	interface Window {
		readonly __OPFS_CONFIG__?: OpfsRuntimeConfig;
	}
}

export type ShareConfig =
	| { readonly enabled: false }
	| { readonly enabled: true; readonly client: RendezvousClient };

let cached: ShareConfig | null = null;

function readBackendUrl(): string | undefined {
	if (typeof window === "undefined") return undefined;
	return window.__OPFS_CONFIG__?.shareBackendUrl;
}

/**
 * Returns the share-flow configuration for this build. Memoized so
 * the `RendezvousClient` is created exactly once per page session.
 */
export function getShareConfig(): ShareConfig {
	if (cached) return cached;
	const baseUrl = readBackendUrl();
	if (!baseUrl) {
		cached = { enabled: false };
		return cached;
	}
	cached = {
		enabled: true,
		client: new RendezvousClient({ baseUrl }),
	};
	return cached;
}
