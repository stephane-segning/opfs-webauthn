//! SQL schema, migrations, and encrypted row codec.
//!
//! This crate is a stub: the schema and migration framework will land
//! in a follow-up PR. The placeholder keeps the workspace graph
//! buildable and the public surface visible.

#![no_std]

extern crate alloc;

pub use opfs_crypto;

/// Current schema version. Bumped whenever a migration lands.
pub const SCHEMA_VERSION: u32 = 0;

/// Placeholder for the canonical schema SQL string.
///
/// Will be replaced by the migration-driven schema in the storage
/// implementation PR. Kept here so the WASM surface in `opfs-core` can
/// already import the name.
pub const fn current_schema_sql() -> &'static str {
    ""
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_version_starts_at_zero() {
        assert_eq!(SCHEMA_VERSION, 0);
    }

    #[test]
    fn current_schema_sql_is_empty_for_now() {
        assert!(current_schema_sql().is_empty());
    }
}
