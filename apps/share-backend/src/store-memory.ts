/**
 * In-memory `RendezvousStore` used by tests. Implements the same
 * single-pickup + collision-reject semantics as the KV-backed store
 * so the router tests don't need to mock KV.
 */

import type { RendezvousRecord, RendezvousStore } from "./store.js";

type StoredRecord = RendezvousRecord & { readonly absoluteExpiresAtMs: number };

export class MemoryRendezvousStore implements RendezvousStore {
	readonly #rendezvous = new Map<string, StoredRecord>();
	readonly #blobs = new Map<
		string,
		{ bytes: Uint8Array; expiresAtMs: number }
	>();
	readonly #counters = new Map<
		string,
		{ count: number; expiresAtMs: number }
	>();

	#now(): number {
		return Date.now();
	}

	async putRendezvous(
		code: string,
		record: RendezvousRecord,
		ttlSeconds: number,
	): Promise<boolean> {
		this.#sweep();
		if (this.#rendezvous.has(code)) return false;
		this.#rendezvous.set(code, {
			...record,
			absoluteExpiresAtMs: this.#now() + ttlSeconds * 1000,
		});
		return true;
	}

	async getRendezvous(code: string): Promise<RendezvousRecord | null> {
		this.#sweep();
		const record = this.#rendezvous.get(code);
		return record ? { epk: record.epk, expiresAt: record.expiresAt } : null;
	}

	async putBlob(
		code: string,
		blob: Uint8Array,
		ttlSeconds: number,
	): Promise<boolean> {
		this.#sweep();
		if (this.#blobs.has(code)) return false;
		this.#blobs.set(code, {
			bytes: blob,
			expiresAtMs: this.#now() + ttlSeconds * 1000,
		});
		return true;
	}

	async takeBlob(code: string): Promise<Uint8Array | null> {
		this.#sweep();
		const entry = this.#blobs.get(code);
		if (!entry) return null;
		this.#blobs.delete(code);
		return entry.bytes;
	}

	async incrementMintCounter(ip: string, ttlSeconds: number): Promise<number> {
		this.#sweep();
		const existing = this.#counters.get(ip);
		const count = (existing?.count ?? 0) + 1;
		this.#counters.set(ip, {
			count,
			expiresAtMs: this.#now() + ttlSeconds * 1000,
		});
		return count;
	}

	#sweep(): void {
		const now = this.#now();
		for (const [k, v] of this.#rendezvous) {
			if (v.absoluteExpiresAtMs <= now) this.#rendezvous.delete(k);
		}
		for (const [k, v] of this.#blobs) {
			if (v.expiresAtMs <= now) this.#blobs.delete(k);
		}
		for (const [k, v] of this.#counters) {
			if (v.expiresAtMs <= now) this.#counters.delete(k);
		}
	}
}
