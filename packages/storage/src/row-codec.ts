/**
 * Field-pair codec. Symmetric pair: every plaintext field becomes a
 * `{nonce, ciphertext}` pair under an AAD derived from the row id
 * and the field name. Tampering — swapping fields, replaying a row
 * across ids — fails authentication.
 *
 * The codec is the only place that holds the `CryptoVault`.
 * Everything above it (the `Repo`) speaks plaintext; everything
 * below it (the RPC + worker) speaks ciphertext.
 *
 * The AAD bytes are produced by the wasm-exported `aadFor` from
 * `@opfs/core-wasm` (which is just `opfs_repo::aad_for` exposed
 * through wasm-bindgen). That keeps the JS and Rust sides
 * byte-identical — a one-bit drift in either implementation
 * breaks AEAD verification on cross-side reads.
 *
 * **Callers must `await ensureWasm()` before constructing a
 * `RowCodec`.** The page-side `Repo.create` calls it.
 */

import { AES_GCM_NONCE_LEN, type CryptoVault } from "@opfs/core-wasm";

import { getWasm } from "./wasm.js";

export type EncryptedField = {
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
};

// Module-level singletons. `TextEncoder` / `TextDecoder` are
// stateless across calls, so reusing one instance avoids the
// per-call allocator + V8 hidden-class churn that gemini flagged
// — small, predictable win on the hot encrypt/decrypt loops.
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

function freshNonce(): Uint8Array {
	const buf = new Uint8Array(AES_GCM_NONCE_LEN);
	crypto.getRandomValues(buf);
	return buf;
}

export class RowCodec {
	readonly #vault: CryptoVault;
	constructor(vault: CryptoVault) {
		this.#vault = vault;
	}

	encryptField(
		rowId: string,
		field: string,
		plaintext: string,
	): EncryptedField {
		const nonce = freshNonce();
		const aad = getWasm().aadFor(rowId, field);
		const ciphertext = this.#vault.encrypt(
			nonce,
			aad,
			ENCODER.encode(plaintext),
		);
		return { nonce, ciphertext };
	}

	decryptField(
		rowId: string,
		field: string,
		encrypted: EncryptedField,
	): string {
		const aad = getWasm().aadFor(rowId, field);
		const bytes = this.#vault.decrypt(
			encrypted.nonce,
			aad,
			encrypted.ciphertext,
		);
		return DECODER.decode(bytes);
	}
}
