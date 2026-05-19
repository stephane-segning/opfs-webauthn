/**
 * Wire format for the share blob, as written to the rendezvous
 * backend.
 *
 *   `[version: u8][senderPubkey: 32][nonce: 12][ciphertext: N]`
 *
 * A fixed binary framing (rather than CBOR) keeps the JS side
 * dependency-free. The Rust `opfs-share-protocol::ShareBlob` carries
 * the same fields and can be ported here as a CBOR codec if/when a
 * Rust-side sender or receiver lands.
 */

import {
	AES_GCM_NONCE_LEN,
	PROTOCOL_VERSION,
	X25519_PUBKEY_LEN,
} from "@opfs/core-wasm";

import { ShareError } from "./errors.js";

/** Bytes occupied by the fixed header — version + senderPubkey + nonce. */
export const SHARE_BLOB_HEADER_LEN = 1 + X25519_PUBKEY_LEN + AES_GCM_NONCE_LEN;

export type ShareBlobParts = {
	readonly senderPubkey: Uint8Array;
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
};

export function encodeShareBlob(parts: ShareBlobParts): Uint8Array {
	if (parts.senderPubkey.length !== X25519_PUBKEY_LEN) {
		throw new ShareError(
			"protocol",
			`senderPubkey must be ${X25519_PUBKEY_LEN} bytes`,
		);
	}
	if (parts.nonce.length !== AES_GCM_NONCE_LEN) {
		throw new ShareError(
			"protocol",
			`nonce must be ${AES_GCM_NONCE_LEN} bytes`,
		);
	}
	const out = new Uint8Array(SHARE_BLOB_HEADER_LEN + parts.ciphertext.length);
	out[0] = PROTOCOL_VERSION;
	out.set(parts.senderPubkey, 1);
	out.set(parts.nonce, 1 + X25519_PUBKEY_LEN);
	out.set(parts.ciphertext, SHARE_BLOB_HEADER_LEN);
	return out;
}

export function decodeShareBlob(bytes: Uint8Array): ShareBlobParts {
	if (bytes.length < SHARE_BLOB_HEADER_LEN) {
		throw new ShareError(
			"protocol",
			`share blob shorter than header (${bytes.length} < ${SHARE_BLOB_HEADER_LEN})`,
		);
	}
	const version = bytes[0];
	if (version !== PROTOCOL_VERSION) {
		throw new ShareError(
			"protocol",
			`unknown share-blob version ${version}, expected ${PROTOCOL_VERSION}`,
		);
	}
	// `slice` copies — the caller may mutate or zero the returned
	// arrays without affecting the input buffer (or vice versa).
	const senderPubkey = bytes.slice(1, 1 + X25519_PUBKEY_LEN);
	const nonce = bytes.slice(1 + X25519_PUBKEY_LEN, SHARE_BLOB_HEADER_LEN);
	const ciphertext = bytes.slice(SHARE_BLOB_HEADER_LEN);
	return { senderPubkey, nonce, ciphertext };
}
