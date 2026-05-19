/**
 * Persistence interface for the rendezvous backend. The router talks
 * to this; the production binding is KV-backed, tests use an
 * in-memory fake. Splitting the contract here keeps handlers unaware
 * of Cloudflare-isms and makes the storage layer swappable (KV today,
 * Durable Objects tomorrow if we need strong single-pickup).
 */

export type RendezvousRecord = {
	/** Recipient's ephemeral X25519 public key. */
	readonly epk: Uint8Array;
	/** Unix seconds when this rendezvous (and its blob) expire. */
	readonly expiresAt: number;
};

export interface RendezvousStore {
	/**
	 * Insert a fresh rendezvous. Resolves to `true` if the code was
	 * unused; `false` if a rendezvous already exists under it (the
	 * caller should reject the request — a code collision inside the
	 * TTL window is a 60-bit pre-image hit and means re-derive).
	 */
	putRendezvous(
		code: string,
		record: RendezvousRecord,
		ttlSeconds: number,
	): Promise<boolean>;

	/**
	 * Look up the recipient's epk for `code`. Returns `null` only if
	 * the record is truly absent; an expired-but-still-stored record
	 * is returned and the handler decides between `404` and `410`.
	 * Collapsing both states inside the store would lose the
	 * documented "missing vs. expired" distinction in the API.
	 */
	getRendezvous(code: string): Promise<RendezvousRecord | null>;

	/**
	 * Stage the encrypted blob under `code`. Resolves `false` if a
	 * blob is already present — uploads are single-shot (ADR 0007).
	 */
	putBlob(code: string, blob: Uint8Array, ttlSeconds: number): Promise<boolean>;

	/**
	 * Atomically read-and-delete the blob for `code`. Returns `null`
	 * if the blob is missing — including the case where another
	 * recipient just picked it up.
	 */
	takeBlob(code: string): Promise<Uint8Array | null>;

	/**
	 * Increment the per-IP mint counter inside the current TTL window.
	 * Returns the post-increment count so the caller can decide
	 * whether to throttle.
	 */
	incrementMintCounter(ip: string, ttlSeconds: number): Promise<number>;
}
