/**
 * Cloudflare KV-backed implementation of `RendezvousStore`. Two
 * namespaces are used so the rendezvous metadata and the encrypted
 * blob have independent TTLs and can be cleared separately.
 *
 * Important caveat: KV is eventually consistent and reads are cached
 * for up to ~60s at the edge. For the rendezvous metadata that's
 * fine — the code is derived from the epk, so the worst case is a
 * stale-but-still-valid record. For `takeBlob` we use
 * `getWithMetadata` + `delete` and accept that, within the cache
 * window, a determined attacker who races the legitimate recipient
 * might pull the same ciphertext twice. ADR 0007 documents this as
 * an accepted trade-off; the blob is already AEAD-encrypted and the
 * TTL is short.
 */

import type { RendezvousRecord, RendezvousStore } from "./store.js";

const META_PREFIX = "rdv:";
const BLOB_PREFIX = "blob:";
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

export class KvRendezvousStore implements RendezvousStore {
	readonly #rendezvous: KVNamespace;
	readonly #blobs: KVNamespace;

	constructor(rendezvous: KVNamespace, blobs: KVNamespace) {
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
		if (stored.expiresAt * 1000 <= Date.now()) return null;
		return { epk: fromBase64(stored.epk), expiresAt: stored.expiresAt };
	}

	async putBlob(
		code: string,
		blob: Uint8Array,
		ttlSeconds: number,
	): Promise<boolean> {
		const key = BLOB_PREFIX + code;
		const existing = await this.#blobs.get(key, "arrayBuffer");
		if (existing !== null) return false;
		await this.#blobs.put(key, blob, { expirationTtl: ttlSeconds });
		return true;
	}

	async takeBlob(code: string): Promise<Uint8Array | null> {
		const key = BLOB_PREFIX + code;
		const buf = await this.#blobs.get(key, "arrayBuffer");
		if (!buf) return null;
		await this.#blobs.delete(key);
		return new Uint8Array(buf);
	}

	async incrementMintCounter(ip: string, ttlSeconds: number): Promise<number> {
		const key = RL_PREFIX + ip;
		const raw = await this.#rendezvous.get(key);
		const next = (raw ? Number.parseInt(raw, 10) : 0) + 1;
		// `expirationTtl` on every write keeps the window rolling cheaply;
		// we don't need a precise per-window reset for this rate limiter.
		await this.#rendezvous.put(key, String(next), {
			expirationTtl: ttlSeconds,
		});
		return next;
	}
}
