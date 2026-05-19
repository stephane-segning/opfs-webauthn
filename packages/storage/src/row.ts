/**
 * Wire-level row shape for the encrypted notes table. The page side
 * encrypts/decrypts via `CryptoVault`; the worker only ever sees
 * ciphertext, nonces, and the plaintext metadata that is indexed
 * (id, updated_day, archived). See ADR 0004 for the metadata-leak
 * rationale.
 *
 * `id` is a 26-character Crockford base32 encoding of 16 random bytes
 * (128 bits) for ergonomic logging without leaking timing data the
 * way ULIDs would.
 */

/** Encrypted row as it lives in SQLite + crosses the worker boundary. */
export type EncryptedNoteRow = {
	readonly id: string;
	readonly updatedDay: number;
	readonly archived: boolean;
	readonly titleNonce: Uint8Array;
	readonly titleCiphertext: Uint8Array;
	readonly bodyNonce: Uint8Array;
	readonly bodyCiphertext: Uint8Array;
};

/** Input the page hands the worker on upsert. */
export type NoteRowInput = EncryptedNoteRow;

/** Currently the only broadcast event; more land with multi-tab. */
export type StorageEventName = "tx-applied";
