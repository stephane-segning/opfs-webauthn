//! wasm-bindgen surface for `opfs-webauthn`.
//!
//! This crate is the only thing the JS side imports from Rust. It
//! re-exports the safer, audited surface of the underlying crates so
//! the JS bridge has exactly one place to evolve.
//!
//! The `wasm-bindgen` glue lands in a follow-up PR; for now this is a
//! plain `rlib` re-export so the workspace builds end-to-end and the
//! dependency graph is wired.

#![no_std]

pub use opfs_crypto;
pub use opfs_repo;
pub use opfs_share_protocol;

#[cfg(test)]
mod tests {
    #[test]
    fn re_exports_are_reachable() {
        let _ = crate::opfs_crypto::KEY_LEN;
        let _ = crate::opfs_repo::SCHEMA_VERSION;
        let _ = crate::opfs_share_protocol::PROTOCOL_VERSION;
    }
}
