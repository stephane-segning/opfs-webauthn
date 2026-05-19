/**
 * Field-pair codec. Symmetric pair: every plaintext field becomes a
 * `{nonce, ciphertext}` pair under an AAD derived from the row id and
 * the field name. Tampering — swapping fields, replaying a row across
 * ids — fails authentication.
 *
 * The codec is the only place that holds the `CryptoVault`. Everything
 * above it (the `Repo`) speaks plaintext; everything below it (the
 * RPC + worker) speaks ciphertext.
 */

import { AES_GCM_NONCE_LEN, type CryptoVault } from "@opfs/core-wasm";

import { ROW_AAD } from "./schema.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

export type EncryptedField = {
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
};

function freshNonce(): Uint8Array {
	const buf = new Uint8Array(AES_GCM_NONCE_LEN);
	crypto.getRandomValues(buf);
	return buf;
}

function aadFor(rowId: string, field: string): Uint8Array {
	return ENCODER.encode(`${ROW_AAD}/${field}/${rowId}`);
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
		const ciphertext = this.#vault.encrypt(
			nonce,
			aadFor(rowId, field),
			ENCODER.encode(plaintext),
		);
		return { nonce, ciphertext };
	}

	decryptField(
		rowId: string,
		field: string,
		encrypted: EncryptedField,
	): string {
		const bytes = this.#vault.decrypt(
			encrypted.nonce,
			aadFor(rowId, field),
			encrypted.ciphertext,
		);
		return DECODER.decode(bytes);
	}
}
