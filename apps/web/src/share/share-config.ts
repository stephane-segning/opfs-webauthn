/**
 * Feature flag + backend wiring for the share flow.
 *
 * Frontend and share-backend live on the same origin (ADR 0014).
 * The cluster ingress routes `/api/*` to the rendezvous Knative
 * service; `/` falls through to the static frontend. So the
 * default `baseUrl` is the relative path `/api` — `fetch`
 * resolves it against the document origin at request time, the
 * browser treats the request as same-origin, and we sidestep
 * CORS entirely.
 *
 * `NEXT_PUBLIC_SHARE_BACKEND_URL` overrides the default:
 *   - any absolute URL (`https://…`) → cross-origin override for
 *     dev or staging that isn't behind the ingress yet
 *   - explicit empty string → disable the share UI for this build
 *     (the build smoke-test workflow uses this)
 *   - any other relative path (`/foo`) → use that instead of
 *     `/api`, useful if the ingress mounts the API somewhere else
 *
 * Distinguishing `undefined` from `""` matters: Docker sets the
 * env to the ARG default `/api` when not overridden, so most
 * deploys hit the default branch through the env-read path. The
 * `undefined` branch is for `pnpm dev` from a fresh checkout
 * with no `.env*`, which should still get sharing on by default.
 */

import { RendezvousClient } from "@opfs/share-client";

const RAW_BACKEND_URL: string | undefined =
	process.env.NEXT_PUBLIC_SHARE_BACKEND_URL;
const DEFAULT_BASE_URL = "/api";

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
	const baseUrl =
		RAW_BACKEND_URL === undefined ? DEFAULT_BASE_URL : RAW_BACKEND_URL;
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
