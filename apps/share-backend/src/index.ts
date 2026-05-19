/**
 * Cloudflare Worker entry. Wires the runtime bindings (KV, env) into
 * the transport-independent `route()` + `Deps` pair so all the actual
 * logic stays testable from plain Node.
 */

import {
	corsHeadersFor,
	originIsAllowed,
	preflightResponse,
	withCors,
} from "./cors.js";
import type { Deps } from "./handlers.js";
import { route } from "./router.js";
import { CloudflareRendezvousStore } from "./store-cf.js";

export interface Env {
	RENDEZVOUS: KVNamespace;
	BLOBS: R2Bucket;
	ALLOWED_ORIGINS?: string;
}

const CF_IP_HEADER = "cf-connecting-ip";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = request.headers.get("origin");
		if (request.method === "OPTIONS") {
			return preflightResponse(origin, env.ALLOWED_ORIGINS);
		}

		// Simple cross-origin POSTs bypass preflight, so allow-list
		// enforcement has to happen here before any side effects run.
		// Missing `Origin` is treated as same-origin / non-browser
		// (curl, server-to-server) — those clients can't carry the
		// user's session, so they aren't a CSRF vector.
		if (origin !== null && !originIsAllowed(origin, env.ALLOWED_ORIGINS)) {
			return new Response(JSON.stringify({ error: "origin not allowed" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}

		const cors = corsHeadersFor(origin, env.ALLOWED_ORIGINS);
		const deps: Deps = {
			store: new CloudflareRendezvousStore(env.RENDEZVOUS, env.BLOBS),
			clientIp: request.headers.get(CF_IP_HEADER) ?? "0.0.0.0",
			now: () => Math.floor(Date.now() / 1000),
		};

		const response = await route(request, deps);
		return withCors(response, cors);
	},
};
