//! wasm-bindgen surface for `opfs-webauthn`.
//!
//! This crate is the only thing the JS side imports from Rust. It
//! re-exports the safer, audited surface of the underlying crates so
//! the JS bridge has exactly one place to evolve.
//!
//! The `wasm-bindgen` glue lands in a follow-up PR; for now this is a
//! plain re-export shell so the workspace builds end-to-end and the
//! dependency graph is wired.
//!
//! This crate depends on `std` because it is built as a `cdylib` and
//! needs a global allocator + panic handler. The leaf crates
//! (`opfs-crypto`, `opfs-share-protocol`) are `no_std + alloc` so they
//! remain reusable in embedded contexts.

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
