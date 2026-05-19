/**
 * One handler per route. Each handler is a pure async function over
 * `(request, deps)` so we can exercise them in tests without spinning
 * up a Worker runtime. Failure cases throw `HttpError`; the router
 * maps them to responses.
 */

import { CODE_LEN, codeForPubkey, X25519_PUBKEY_LEN } from "./commitment.js";
import {
	MAX_BLOB_BYTES,
	MINT_RATE_LIMIT,
	RENDEZVOUS_TTL_SECONDS,
} from "./config.js";
import {
	badRequest,
	conflict,
	gone,
	notFound,
	payloadTooLarge,
	tooManyRequests,
} from "./errors.js";
import type { RendezvousStore } from "./store.js";

export type Deps = {
	readonly store: RendezvousStore;
	/** Client IP, derived once by the router from `CF-Connecting-IP`. */
	readonly clientIp: string;
	/** Unix-seconds clock, injectable for tests. */
	readonly now: () => number;
};

const APP_OCTET_STREAM = "application/octet-stream";

async function readBinary(request: Request, max: number): Promise<Uint8Array> {
	const buf = await request.arrayBuffer();
	if (buf.byteLength > max) {
		throw payloadTooLarge(`body exceeds ${max} bytes`);
	}
	return new Uint8Array(buf);
}

function assertCode(code: string): void {
	if (code.length !== CODE_LEN) throw badRequest("malformed code");
}

/**
 * `POST /rendezvous` — recipient mints a rendezvous. Body is the raw
 * 32-byte ephemeral X25519 pubkey. Returns `{code, expiresAt}` JSON.
 */
export async function mintRendezvous(
	request: Request,
	deps: Deps,
): Promise<Response> {
	const minted = await deps.store.incrementMintCounter(
		deps.clientIp,
		RENDEZVOUS_TTL_SECONDS,
	);
	if (minted > MINT_RATE_LIMIT) throw tooManyRequests();

	const epk = await readBinary(request, X25519_PUBKEY_LEN);
	if (epk.length !== X25519_PUBKEY_LEN) {
		throw badRequest(`epk must be exactly ${X25519_PUBKEY_LEN} bytes`);
	}

	const code = codeForPubkey(epk);
	const expiresAt = deps.now() + RENDEZVOUS_TTL_SECONDS;
	const ok = await deps.store.putRendezvous(
		code,
		{ epk, expiresAt },
		RENDEZVOUS_TTL_SECONDS,
	);
	if (!ok) {
		// Two distinct epks landed on the same 60-bit truncation inside
		// the TTL window — a real pre-image hit, not just a duplicate
		// submit. Asking the client to retry mints a fresh epk and
		// re-derives the code.
		throw conflict("code collision; retry");
	}
	return Response.json({ code, expiresAt });
}

/** `GET /rendezvous/:code` — sender fetches the recipient's epk. */
export async function fetchRendezvous(
	code: string,
	deps: Deps,
): Promise<Response> {
	assertCode(code);
	const record = await deps.store.getRendezvous(code);
	if (!record) throw notFound();
	if (record.expiresAt <= deps.now()) throw gone();
	const body = new Uint8Array(record.epk);
	return new Response(body, {
		status: 200,
		headers: { "content-type": APP_OCTET_STREAM },
	});
}

/** `POST /rendezvous/:code/blob` — sender uploads the encrypted blob. */
export async function uploadBlob(
	code: string,
	request: Request,
	deps: Deps,
): Promise<Response> {
	assertCode(code);
	const record = await deps.store.getRendezvous(code);
	if (!record) throw notFound("no such rendezvous");
	if (record.expiresAt <= deps.now()) throw gone();
	const blob = await readBinary(request, MAX_BLOB_BYTES);
	if (blob.length === 0) throw badRequest("empty blob");
	const ok = await deps.store.putBlob(code, blob, RENDEZVOUS_TTL_SECONDS);
	if (!ok) throw conflict("blob already uploaded");
	return new Response(null, { status: 204 });
}

/** `GET /rendezvous/:code/blob` — recipient picks up the blob, once. */
export async function downloadBlob(
	code: string,
	deps: Deps,
): Promise<Response> {
	assertCode(code);
	const blob = await deps.store.takeBlob(code);
	if (!blob) throw notFound();
	const body = new Uint8Array(blob);
	return new Response(body, {
		status: 200,
		headers: { "content-type": APP_OCTET_STREAM },
	});
}
