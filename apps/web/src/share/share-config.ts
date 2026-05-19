/**
 * Feature-flag for the share flow. The whole UI is conditional on
 * `NEXT_PUBLIC_SHARE_BACKEND_URL` being set at build time — that lets
 * the GitHub Pages deploy ship without a backend URL and simply hide
 * the share affordances, with no runtime branching to test.
 */

import { RendezvousClient } from "@opfs/share-client";

const BACKEND_URL = process.env.NEXT_PUBLIC_SHARE_BACKEND_URL;

export type ShareConfig =
	| { readonly enabled: false }
	| { readonly enabled: true; readonly client: RendezvousClient };

let cached: ShareConfig | null = null;

/**
 * Returns the share-flow configuration for this build. Memoized so
 * the `RendezvousClient` is created exactly once per page session.
 */
export function getShareConfig(): ShareConfig {
	if (cached) return cached;
	if (!BACKEND_URL) {
		cached = { enabled: false };
		return cached;
	}
	cached = {
		enabled: true,
		client: new RendezvousClient({ baseUrl: BACKEND_URL }),
	};
	return cached;
}
