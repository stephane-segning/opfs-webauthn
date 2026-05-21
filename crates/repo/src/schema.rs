//! Notes-table schema. Per [ADR 0004][adr0004]:
//!
//! - `id BLOB`: 16 random bytes (128 bits). Stored as BLOB, not TEXT,
//!   because the worker treats it as bytes; the page side encodes /
//!   decodes Crockford base32 for the JS string handle (see [`id`]).
//! - `updated_day INTEGER`: days since the Unix epoch
//!   (`floor(unix_seconds / 86400)`). Day-quantised so the disk
//!   layout never reveals when within the day a note was edited.
//! - `archived INTEGER`: 0 / 1 bool.
//! - `*_nonce` / `*_ciphertext` BLOB pairs: AES-GCM nonce +
//!   ciphertext+tag produced by [`opfs_crypto::aead`]. AAD binding
//!   is constructed by [`crate::codec::aad_for`].
//!
//! Index orders newest day descending then id descending — `id` is a
//! stable secondary sort because it leaks no timing.
//!
//! [adr0004]: https://github.com/stephane-segning/opfs-webauthn/blob/main/docs/adrs/0004-sqlite-opfs-storage.md
//! [`id`]: crate::id
//! [`opfs_crypto::aead`]: opfs_crypto::aead

/// Current schema version. Bumped whenever a forward-migration lands
/// in [`crate::migrations::MIGRATIONS`].
pub const SCHEMA_VERSION: u32 = 1;

/// Canonical schema SQL. Byte-identical to the JS-side
/// `packages/storage/src/schema.ts` `SCHEMA_SQL` so the worker setup
/// runs identical DDL whether it sources the string from JS or wasm.
///
/// Keep these in sync by hand — the JS port lands in a follow-up PR
/// that re-exports this constant through wasm-bindgen.
pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS notes (
  id BLOB PRIMARY KEY NOT NULL,
  updated_day INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  title_nonce BLOB NOT NULL,
  title_ciphertext BLOB NOT NULL,
  body_nonce BLOB NOT NULL,
  body_ciphertext BLOB NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_notes_recent
  ON notes(updated_day DESC, id DESC)
  WHERE archived = 0;
";

/// Domain-separator prefix for every per-field AES-GCM AAD.
///
/// The actual AAD bytes are constructed by [`crate::codec::aad_for`]
/// — `{ROW_AAD}/{field}/{row_id_string}`. Bumping the version suffix
/// invalidates every existing ciphertext, so it lives behind a
/// migration if it ever changes.
pub const ROW_AAD: &str = "opfs-webauthn/v1/note-row";

/// Convenience accessor for the schema string. Pre-existing API from
/// the placeholder version of this crate; kept so external consumers
/// don't have to import the const directly.
#[must_use]
pub const fn current_schema_sql() -> &'static str {
    SCHEMA_SQL
}
