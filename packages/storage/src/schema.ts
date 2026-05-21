/**
 * Notes-table schema accessors. The schema string, the schema
 * version, and the row-AAD domain separator live in the Rust crate
 * `opfs-repo` (see `crates/repo/src/schema.rs`); this module is a
 * thin re-export so the JS-side worker / page code consumes the
 * exact same bytes the Rust side defines.
 *
 * Per ADR 0004:
 *
 * - `id` BLOB: 16 random bytes (128 bits). Stored as BLOB, not TEXT,
 *   because the worker treats it as bytes; the page side encodes /
 *   decodes Crockford base32 for the JS string handle.
 * - `updated_day`: integer days since the Unix epoch
 *   (`floor(unixSeconds / 86400)`). Day-quantised so the disk layout
 *   never reveals when within the day a note was edited.
 * - `archived`: 0 / 1 bool.
 * - `*_nonce` / `*_ciphertext` BLOB pairs: AES-GCM nonce + ciphertext+tag
 *   produced by `CryptoVault.encrypt`. AAD is `aad_for(row_id, field)`,
 *   sourced from wasm.
 *
 * **Callers must `await ensureWasm()` before invoking any of these
 * functions.** The page-side `Repo.create` and the worker bootstrap
 * both call it; ad-hoc consumers do the same.
 */

import { getWasm } from "./wasm.js";

/** Current schema version recorded in `schema_meta.version`. */
export function getSchemaVersion(): number {
	return getWasm().schemaVersion();
}

/** Canonical DDL for the notes vault. Apply on cold start. */
export function getSchemaSql(): string {
	return getWasm().schemaSql();
}

/** Domain-separator prefix every per-field AAD starts with. */
export function getRowAad(): string {
	return getWasm().rowAad();
}
