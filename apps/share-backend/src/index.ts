/**
 * Cloudflare Worker entry. Wires the runtime bindings (KV, env) into
 * the transport-independent `route()` + `Deps` pair so all the actual
 * logic stays testable from plain Node.
 */

import { corsHeadersFor, preflightResponse, withCors } from "./cors.js";
import type { Deps } from "./handlers.js";
import { route } from "./router.js";
import { KvRendezvousStore } from "./store-kv.js";

export interface Env {
	RENDEZVOUS: KVNamespace;
	BLOBS: KVNamespace;
	ALLOWED_ORIGINS?: string;
}

const CF_IP_HEADER = "cf-connecting-ip";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = request.headers.get("origin");
		if (request.method === "OPTIONS") {
			return preflightResponse(origin, env.ALLOWED_ORIGINS);
		}

		const cors = corsHeadersFor(origin, env.ALLOWED_ORIGINS);
		const deps: Deps = {
			store: new KvRendezvousStore(env.RENDEZVOUS, env.BLOBS),
			clientIp: request.headers.get(CF_IP_HEADER) ?? "0.0.0.0",
			now: () => Math.floor(Date.now() / 1000),
		};

		const response = await route(request, deps);
		return withCors(response, cors);
	},
};
