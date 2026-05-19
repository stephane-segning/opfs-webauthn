/**
 * `RendezvousClient` is pure HTTP plumbing. These tests drive it
 * against a tiny in-process fake `fetch` to verify request shape
 * and error mapping without touching the network.
 */

import { describe, expect, it } from "vitest";

import { ShareError } from "./errors.js";
import { type FetchLike, RendezvousClient } from "./transport.js";

const BASE = "https://share.test/backend";

type Recorded = { url: string; method: string; body: Uint8Array | null };

function makeClient(handler: (req: Recorded) => Response): {
	client: RendezvousClient;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const fakeFetch: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		const method = init?.method ?? "GET";
		let body: Uint8Array | null = null;
		if (init?.body instanceof Uint8Array) body = init.body;
		else if (init?.body instanceof ArrayBuffer)
			body = new Uint8Array(init.body);
		const recorded: Recorded = { url, method, body };
		calls.push(recorded);
		return handler(recorded);
	};
	const client = new RendezvousClient({ baseUrl: BASE, fetch: fakeFetch });
	return { client, calls };
}

describe("RendezvousClient.mint", () => {
	it("POSTs the epk and parses the JSON response", async () => {
		const { client, calls } = makeClient(
			() =>
				new Response(
					JSON.stringify({ code: "AAAAAAAAAAAA", expiresAt: 1234 }),
					{
						status: 200,
					},
				),
		);
		const epk = new Uint8Array(32).fill(9);
		const result = await client.mint(epk);
		expect(result).toEqual({ code: "AAAAAAAAAAAA", expiresAt: 1234 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}/rendezvous`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual(epk);
	});

	it("maps a 429 status to a rate-limited share error", async () => {
		const { client } = makeClient(() => new Response("", { status: 429 }));
		await expect(client.mint(new Uint8Array(32))).rejects.toMatchObject({
			kind: "rateLimited",
		});
	});

	it("maps a 403 status to originDenied", async () => {
		const { client } = makeClient(() => new Response("", { status: 403 }));
		await expect(client.mint(new Uint8Array(32))).rejects.toMatchObject({
			kind: "originDenied",
		});
	});
});

describe("RendezvousClient.fetchEpk", () => {
	it("returns the response body as raw bytes", async () => {
		const epk = new Uint8Array(32).fill(0x42);
		const { client } = makeClient(
			() =>
				new Response(epk, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				}),
		);
		const fetched = await client.fetchEpk("ABCDEFGHIJKL");
		expect(fetched).toEqual(epk);
	});

	it("encodes the code in the URL", async () => {
		const { client, calls } = makeClient(
			() => new Response(new Uint8Array(32), { status: 200 }),
		);
		await client.fetchEpk("CODE/with?weird");
		expect(calls[0]?.url).toBe(`${BASE}/rendezvous/CODE%2Fwith%3Fweird`);
	});

	it("maps a 410 status to rendezvousExpired", async () => {
		const { client } = makeClient(() => new Response("", { status: 410 }));
		await expect(client.fetchEpk("AAAAAAAAAAAA")).rejects.toMatchObject({
			kind: "rendezvousExpired",
		});
	});

	it("maps a 404 status to rendezvousNotFound", async () => {
		const { client } = makeClient(() => new Response("", { status: 404 }));
		await expect(client.fetchEpk("AAAAAAAAAAAA")).rejects.toMatchObject({
			kind: "rendezvousNotFound",
		});
	});
});

describe("RendezvousClient.uploadBlob", () => {
	it("POSTs the blob and resolves on 204", async () => {
		const { client, calls } = makeClient(
			() => new Response(null, { status: 204 }),
		);
		const blob = Uint8Array.from([1, 2, 3]);
		await client.uploadBlob("AAAAAAAAAAAA", blob);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual(blob);
	});

	it("maps 409 to blobAlreadyUploaded", async () => {
		const { client } = makeClient(() => new Response("", { status: 409 }));
		await expect(
			client.uploadBlob("AAAAAAAAAAAA", new Uint8Array([1])),
		).rejects.toMatchObject({ kind: "blobAlreadyUploaded" });
	});
});

describe("RendezvousClient.tryDownloadBlob", () => {
	it("returns the bytes on 200", async () => {
		const blob = Uint8Array.from([9, 8, 7]);
		const { client } = makeClient(() => new Response(blob, { status: 200 }));
		const fetched = await client.tryDownloadBlob("AAAAAAAAAAAA");
		expect(fetched).toEqual(blob);
	});

	it("returns null on 404 so the poller distinguishes waiting from failure", async () => {
		const { client } = makeClient(() => new Response("", { status: 404 }));
		const fetched = await client.tryDownloadBlob("AAAAAAAAAAAA");
		expect(fetched).toBeNull();
	});

	it("throws on a non-404 error status", async () => {
		const { client } = makeClient(() => new Response("", { status: 410 }));
		await expect(client.tryDownloadBlob("AAAAAAAAAAAA")).rejects.toMatchObject({
			kind: "rendezvousExpired",
		});
	});
});

describe("RendezvousClient network failures", () => {
	it("wraps a fetch throw as a typed network error", async () => {
		const client = new RendezvousClient({
			baseUrl: BASE,
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
		});
		await expect(client.mint(new Uint8Array(32))).rejects.toMatchObject({
			kind: "network",
		});
	});

	it("strips a trailing slash from baseUrl so URLs don't double up", () => {
		const client = new RendezvousClient({
			baseUrl: `${BASE}/`,
			fetch: globalThis.fetch,
		});
		expect(client.baseUrl).toBe(BASE);
	});

	it("preserves an existing ShareError through the network-safe wrapper", async () => {
		const tagged = new ShareError("protocol", "pre-existing");
		const client = new RendezvousClient({
			baseUrl: BASE,
			fetch: async () => {
				throw tagged;
			},
		});
		await expect(client.mint(new Uint8Array(32))).rejects.toBe(tagged);
	});
});
