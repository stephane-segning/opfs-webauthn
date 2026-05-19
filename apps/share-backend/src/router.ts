/**
 * Tiny URL-pattern router. Match → handler → response. Splitting it
 * out of `index.ts` keeps the Worker entry trivial and lets the
 * tests drive the router directly with a `Request`/`Deps` pair.
 */

import { badRequest, HttpError, notFound } from "./errors.js";
import {
	type Deps,
	downloadBlob,
	fetchRendezvous,
	mintRendezvous,
	uploadBlob,
} from "./handlers.js";

const CODE_PATTERN = /^[0-9A-Z]+$/;

type Route =
	| { kind: "mint" }
	| { kind: "fetch"; code: string }
	| { kind: "upload"; code: string }
	| { kind: "download"; code: string }
	| { kind: "none" };

function match(method: string, path: string): Route {
	if (method === "POST" && path === "/rendezvous") return { kind: "mint" };
	const rendezvousMatch = /^\/rendezvous\/([^/]+)$/.exec(path);
	if (rendezvousMatch?.[1]) {
		const code = rendezvousMatch[1];
		if (!CODE_PATTERN.test(code)) return { kind: "none" };
		if (method === "GET") return { kind: "fetch", code };
	}
	const blobMatch = /^\/rendezvous\/([^/]+)\/blob$/.exec(path);
	if (blobMatch?.[1]) {
		const code = blobMatch[1];
		if (!CODE_PATTERN.test(code)) return { kind: "none" };
		if (method === "POST") return { kind: "upload", code };
		if (method === "GET") return { kind: "download", code };
	}
	return { kind: "none" };
}

function errorResponse(err: unknown): Response {
	if (err instanceof HttpError) {
		return Response.json({ error: err.message }, { status: err.status });
	}
	return Response.json({ error: "internal error" }, { status: 500 });
}

export async function route(request: Request, deps: Deps): Promise<Response> {
	const url = new URL(request.url);
	const route = match(request.method, url.pathname);
	try {
		switch (route.kind) {
			case "mint":
				return await mintRendezvous(request, deps);
			case "fetch":
				return await fetchRendezvous(route.code, deps);
			case "upload":
				return await uploadBlob(route.code, request, deps);
			case "download":
				return await downloadBlob(route.code, deps);
			case "none":
				throw notFound("no such endpoint");
			default: {
				const _exhaustive: never = route;
				throw badRequest("unreachable");
			}
		}
	} catch (err) {
		return errorResponse(err);
	}
}
