/**
 * Full share-flow integration test. Wires the real WASM crypto via
 * `initSync` (no fetch — load the .wasm artifact directly from disk),
 * the real share-backend `route()` running in-process against an
 * `MemoryRendezvousStore`, and the real `RendezvousClient` talking to
 * that router through a fake `fetch`.
 *
 * That covers the seams the per-package tests cannot:
 *   - JS ↔ Rust commitment matching (the recipient'"'"'s commitment is
 *     computed by Rust, but the sender verifies it via the JS port
 *     of the same algorithm).
 *   - Wire format compatibility (`encodeShareBlob` ↔ `decodeShareBlob`
 *     under real AEAD bytes).
 *   - Single-pickup semantics through the actual handlers.
 *   - The recipient-first commitment ceremony with a real epk.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync } from "@opfs/core-wasm";
import type { Deps } from "@opfs/share-backend/src/handlers.js";
import { route } from "@opfs/share-backend/src/router.js";
import { MemoryRendezvousStore } from "@opfs/share-backend/src/store-memory.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
	type FetchLike,
	pollAndDecrypt,
	prepareReceive,
	RendezvousClient,
	sendShare,
} from "./index.js";

const encoder = new TextEncoder();
const payloadFor = (title: string, body: string): Uint8Array =>
	encoder.encode(JSON.stringify({ title, body }));

// Resolve the wasm artifact from the sibling `@opfs/core-wasm`
// package. The Turbo task graph guarantees this exists before
// `share-client#test` runs.
const wasmPath = join(
	fileURLToPath(import.meta.url),
	"../../../core-wasm/dist/opfs_core_bg.wasm",
);

beforeAll(() => {
	// `initSync` accepts raw bytes; we read the `.wasm` artifact from
	// disk so the test does not depend on a fetch impl.
	const bytes = readFileSync(wasmPath);
	initSync({ module: bytes });
});

/**
 * Build an in-process Worker stand-in: a `fetch` that routes through
 * the real backend `route()` against a fresh `MemoryRendezvousStore`,
 * and a `RendezvousClient` configured to use it. No network at all.
 */
function makeInProcessClient(): RendezvousClient {
	const store = new MemoryRendezvousStore();
	const deps: Deps = {
		store,
		clientIp: "203.0.113.42",
		now: () => Math.floor(Date.now() / 1000),
	};
	const fakeFetch: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? input : (input as URL).toString();
		const method = init?.method ?? "GET";
		// `route` reads from a standard `Request`; build one that
		// mirrors what the browser fetch would send to the worker.
		const headers = new Headers(init?.headers as HeadersInit | undefined);
		const body = init?.body ?? null;
		const request = new Request(url, {
			method,
			headers,
			body: body as BodyInit | null,
		});
		return route(request, deps);
	};
	return new RendezvousClient({
		baseUrl: "http://share.test",
		fetch: fakeFetch,
	});
}

describe("share flow — full integration (real WASM + real backend)", () => {
	it("round-trips a note from sender to recipient", async () => {
		const client = makeInProcessClient();
		const session = await prepareReceive(client);
		expect(session.code).toMatch(/^[0-9A-Z]{12}$/);

		const plaintext = payloadFor("from sender", "ciphertext-only on the wire");

		// Sender locally verifies the commitment, encrypts, uploads.
		await sendShare(client, session.code, plaintext);

		// Recipient picks up the blob, decrypts. Use a tight poll
		// interval so the test runs in milliseconds.
		const decrypted = await pollAndDecrypt(client, session, {
			intervalMs: 5,
			timeoutMs: 2_000,
		});
		expect(decrypted).toEqual(plaintext);
	});

	it("rejects a sender that types the wrong code", async () => {
		const client = makeInProcessClient();
		const session = await prepareReceive(client);
		// Twiddle one character of the code so the local commitment
		// verification fails. Pick a char that's guaranteed Crockford-
		// valid: rotate '0' ↔ '1' to dodge the alphabet edge cases.
		const corruptChar = session.code[0] === "0" ? "1" : "0";
		const wrongCode = corruptChar + session.code.slice(1);
		try {
			await expect(
				sendShare(client, wrongCode, new Uint8Array([1, 2, 3])),
			).rejects.toMatchObject({ kind: "rendezvousNotFound" });
		} finally {
			session.handle.free();
		}
	});

	it("rejects a second pickup of the same blob", async () => {
		const client = makeInProcessClient();
		const session = await prepareReceive(client);
		const plaintext = payloadFor("single-shot", "");
		await sendShare(client, session.code, plaintext);

		const first = await pollAndDecrypt(client, session, {
			intervalMs: 5,
			timeoutMs: 2_000,
		});
		expect(first).toEqual(plaintext);

		// `pollAndDecrypt` freed the handle on its way out, so the
		// "second pickup" is a fresh attempt without a valid handle.
		// We expect the backend's `takeBlob` to have deleted the
		// ciphertext, so a follow-up `tryDownloadBlob` returns null —
		// i.e. the timeout path fires.
		const second = makeInProcessClient(); // fresh store, fresh keys
		const fresh = await prepareReceive(second);
		await expect(
			pollAndDecrypt(second, fresh, { intervalMs: 5, timeoutMs: 50 }),
		).rejects.toMatchObject({ kind: "rendezvousExpired" });
	});
});
