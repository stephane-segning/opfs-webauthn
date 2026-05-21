/**
 * Random 128-bit row ids encoded as Crockford base32. The encode /
 * decode lives in the Rust crate `opfs-repo` (see
 * `crates/repo/src/id.rs`); this module wraps the wasm bindings so
 * the JS and Rust sides produce byte-identical output.
 *
 * Per ADR 0004 we deliberately do NOT use ULIDs / UUIDv7 — their
 * embedded timestamps would leak into the plaintext primary key
 * column and defeat the day-quantization on `updated_day`.
 *
 * **Callers must `await ensureWasm()` before invoking any of these
 * functions.** The page-side `Repo.create` and the worker bootstrap
 * both call it.
 */

import { getWasm } from "./wasm.js";

/** Length in bytes of a row id at rest. Always 16. */
export const ROW_ID_BYTES = 16;

/** Length in characters of a Crockford-encoded row id. Always 26. */
export const ROW_ID_CHARS = 26;

function randomBytes(length: number): Uint8Array {
	const buf = new Uint8Array(length);
	crypto.getRandomValues(buf);
	return buf;
}

/** Generate a fresh random 16-byte id, Crockford-base32 encoded. */
export function generateRowId(): string {
	return getWasm().encodeRowId(randomBytes(ROW_ID_BYTES));
}

/** Encode 16 bytes as 26 Crockford-base32 chars. */
export function encodeRowId(bytes: Uint8Array): string {
	return getWasm().encodeRowId(bytes);
}

/** Decode a 26-char Crockford-base32 id back into its 16 bytes. */
export function decodeRowId(id: string): Uint8Array {
	return getWasm().decodeRowId(id);
}
