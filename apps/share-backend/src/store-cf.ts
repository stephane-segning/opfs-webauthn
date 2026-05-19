/**
 * Cloudflare-backed `RendezvousStore`. The metadata lives in KV (the
 * record is small, eventually-consistent reads are acceptable for a
 * 5-minute TTL), and the blob lives in R2 — R2 supports conditional
 * put (`etagDoesNotMatch: "*"`), which gives us the atomic
 * single-upload semantic that KV cannot.
 *
 * Trade-offs we accept:
 *   - `getRendezvous` returns an expired record rather than `null` so
 *     the handler can answer `410 Gone` instead of `404` — preserving
 *     the API's missing-vs-expired distinction (ADR 0007).
 *   - `incrementMintCounter` is a best-effort defense layer. Racing
 *     mints from the same IP can produce a small overshoot. Hard
 *     rate enforcement is configured at the Cloudflare zone level
 *     via WAF Rate Limiting Rules; the brute-force barrier is the
 *     60-bit commitment, not this counter.
 *   - `takeBlob` does an R2 `get` followed by `delete`; concurrent
 *     pickups under the cache window could see the same blob twice.
 *     The blob is AEAD-encrypted under a one-shot ephemeral key, so
 *     a duplicate read does not weaken confidentiality.
 */

import type { RendezvousRecord, RendezvousStore } from "./store.js";

const META_PREFIX = "rdv:";
const RL_PREFIX = "rl:mint:";

type StoredRecord = {
	readonly epk: string;
	readonly expiresAt: number;
};

const toBase64 = (bytes: Uint8Array): string => {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str);
};

const fromBase64 = (str: string): Uint8Array => {
	const bin = atob(str);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};

export class CloudflareRendezvousStore implements RendezvousStore {
	readonly #rendezvous: KVNamespace;
	readonly #blobs: R2Bucket;

	constructor(rendezvous: KVNamespace, blobs: R2Bucket) {
		this.#rendezvous = rendezvous;
		this.#blobs = blobs;
	}

	async putRendezvous(
		code: string,
		record: RendezvousRecord,
		ttlSeconds: number,
	): Promise<boolean> {
		const key = META_PREFIX + code;
		const existing = await this.#rendezvous.get(key);
		// KV has no native CAS, so this read-then-put has a tiny race
		// window. A collision means two distinct epks hashed to the
		// same 60-bit code inside the TTL — a real pre-image hit, not
		// a typo — and the worst outcome is that two recipients see
		// each other's rendezvous. Both clients will detect this
		// during local commitment verification and abort.
		if (existing !== null) return false;
		const stored: StoredRecord = {
			epk: toBase64(record.epk),
			expiresAt: record.expiresAt,
		};
		await this.#rendezvous.put(key, JSON.stringify(stored), {
			expirationTtl: ttlSeconds,
		});
		return true;
	}

	async getRendezvous(code: string): Promise<RendezvousRecord | null> {
		const raw = await this.#rendezvous.get(META_PREFIX + code);
		if (!raw) return null;
		const stored = JSON.parse(raw) as StoredRecord;
		return { epk: fromBase64(stored.epk), expiresAt: stored.expiresAt };
	}

	async putBlob(
		code: string,
		blob: Uint8Array,
		_ttlSeconds: number,
	): Promise<boolean> {
		// R2 conditional put: succeed only if the key does not exist
		// yet. This is atomic at the bucket boundary, so two senders
		// racing to upload under the same code see exactly one
		// `success`, one `null` — ADR 0007's single-upload contract,
		// minus the consistency wobble KV would introduce.
		const put = await this.#blobs.put(code, blob, {
			onlyIf: { etagDoesNotMatch: "*" },
		});
		return put !== null;
	}

	async takeBlob(code: string): Promise<Uint8Array | null> {
		const object = await this.#blobs.get(code);
		if (!object) return null;
		const buf = await object.arrayBuffer();
		await this.#blobs.delete(code);
		return new Uint8Array(buf);
	}

	async incrementMintCounter(ip: string, ttlSeconds: number): Promise<number> {
		const key = RL_PREFIX + ip;
		const raw = await this.#rendezvous.get(key);
		const next = (raw ? Number.parseInt(raw, 10) : 0) + 1;
		await this.#rendezvous.put(key, String(next), {
			expirationTtl: ttlSeconds,
		});
		return next;
	}
}
