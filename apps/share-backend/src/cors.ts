/**
 * CORS wrapper. The frontend is served from a different origin
 * (GitHub Pages) than the Worker (workers.dev or a custom domain),
 * so we have to opt the browser in explicitly. Allowed origins are
 * declared in `wrangler.jsonc#vars.ALLOWED_ORIGINS` so the surface
 * is locked down per deploy rather than baked into code.
 */

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_HEADERS = "content-type";
const CORS_MAX_AGE = "86400";

function parseAllowed(raw: string | undefined): readonly string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function originIsAllowed(
	origin: string | null,
	allowedRaw: string | undefined,
): boolean {
	if (!origin) return false;
	return parseAllowed(allowedRaw).includes(origin);
}

export function corsHeadersFor(
	origin: string | null,
	allowedRaw: string | undefined,
): Headers {
	const headers = new Headers();
	if (originIsAllowed(origin, allowedRaw)) {
		headers.set("access-control-allow-origin", origin as string);
		headers.set("vary", "origin");
		headers.set("access-control-allow-methods", CORS_METHODS);
		headers.set("access-control-allow-headers", CORS_HEADERS);
		headers.set("access-control-max-age", CORS_MAX_AGE);
	}
	return headers;
}

export function preflightResponse(
	origin: string | null,
	allowedRaw: string | undefined,
): Response {
	const headers = corsHeadersFor(origin, allowedRaw);
	const status = originIsAllowed(origin, allowedRaw) ? 204 : 403;
	return new Response(null, { status, headers });
}

/** Merge CORS headers onto an existing response without rebuilding it. */
export function withCors(response: Response, cors: Headers): Response {
	if (cors.has("access-control-allow-origin")) {
		const merged = new Headers(response.headers);
		for (const [k, v] of cors) merged.set(k, v);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: merged,
		});
	}
	return response;
}
