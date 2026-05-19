/**
 * BLAKE3-truncation commitment code — JS port of `crates/crypto/src/commitment.rs`.
 *
 * The construction must match the Rust side byte-for-byte, otherwise
 * the sender's WASM-side `verify_code` would refuse server-issued
 * codes. The 60-bit, Crockford-base32, 12-character envelope is the
 * load-bearing security parameter for the rendezvous (ADR 0007).
 */

import { blake3 } from "@noble/hashes/blake3";

/** Bits of the BLAKE3 digest committed by the pickup code. */
export const COMMITMENT_BITS = 60;
/** Resulting Crockford-base32 character count (`COMMITMENT_BITS / 5`). */
export const CODE_LEN = 12;
/** Bytes of the digest we feed to base32 before truncating. */
const DIGEST_PREFIX_BYTES = 8;
/** Crockford base32 alphabet — same ordering as Rust `base32` crate. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode `bytes` using Crockford base32. The Rust crate emits
 * `ceil(bytes*8/5)` chars; we mirror that exactly so truncation lands
 * on the same boundary on both sides.
 */
function base32Crockford(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			const idx = (value >>> (bits - 5)) & 0x1f;
			out += CROCKFORD[idx];
			bits -= 5;
		}
	}
	if (bits > 0) {
		const idx = (value << (5 - bits)) & 0x1f;
		out += CROCKFORD[idx];
	}
	return out;
}

/**
 * Derive the pickup code for an ephemeral X25519 public key.
 *
 * Algorithm (mirrors `code_for_pubkey` in opfs-crypto):
 *   1. `digest = BLAKE3(epk)`
 *   2. Take the first 8 bytes, mask the low 4 bits of byte 7 so the
 *      trailing base32 char carries no information.
 *   3. Crockford-base32 encode and keep the first 12 chars.
 */
export function codeForPubkey(epk: Uint8Array): string {
	const digest = blake3(epk);
	const buf = digest.slice(0, DIGEST_PREFIX_BYTES);
	buf[DIGEST_PREFIX_BYTES - 1] = (buf[DIGEST_PREFIX_BYTES - 1] ?? 0) & 0xf0;
	return base32Crockford(buf).slice(0, CODE_LEN);
}

/**
 * Best-effort shape-check before we hit BLAKE3 — keeps the server
 * from logging tiny inputs as legitimate rendezvous bodies.
 */
export const X25519_PUBKEY_LEN = 32;
