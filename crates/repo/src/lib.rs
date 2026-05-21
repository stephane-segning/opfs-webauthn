//! SQL schema, migrations, row id codec, and per-field AEAD-AAD
//! construction for the opfs-webauthn notes vault.
//!
//! Pairs with [`opfs_crypto`] for the AES-GCM seal/open primitives
//! and with `sqlite-wasm` on the JavaScript side (see
//! [ADR 0004][adr0004]) for the actual database driver. The Rust
//! side is the source of truth for the schema string and the AAD
//! construction — the JS side (`packages/storage`) currently
//! re-declares them as JS constants; a follow-up PR ports it to
//! consume these values through `@opfs/core-wasm`.
//!
//! [adr0004]: https://github.com/stephane-segning/opfs-webauthn/blob/main/docs/adrs/0004-sqlite-opfs-storage.md

#![no_std]

extern crate alloc;

pub mod codec;
pub mod error;
pub mod id;
pub mod migrations;
pub mod schema;

// Re-exports — the canonical API. Internal modules also stay
// public for crate consumers who want full visibility, but most
// callers reach for these.
pub use codec::aad_for;
pub use error::Error;
pub use id::{ROW_ID_BYTES, ROW_ID_CHARS, decode as decode_row_id, encode as encode_row_id};
pub use migrations::{MIGRATIONS, Migration, pending as pending_migrations};
pub use schema::{ROW_AAD, SCHEMA_SQL, SCHEMA_VERSION, current_schema_sql};

// Re-export the crypto crate so consumers building on opfs-repo
// don't have to pull it in twice. Same pattern as the wasm-bindgen
// surface in `opfs-core`.
pub use opfs_crypto;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_version_matches_last_migration() {
        let last = MIGRATIONS.last().expect("non-empty");
        assert_eq!(last.to_version, SCHEMA_VERSION);
    }

    #[test]
    fn current_schema_sql_round_trips_to_constant() {
        assert_eq!(current_schema_sql(), SCHEMA_SQL);
    }
}
