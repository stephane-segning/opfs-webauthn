//! wasm-bindgen surface for `opfs-webauthn`.
//!
//! This crate is the only thing the JS side imports from Rust. It
//! exposes a small, audited surface over the underlying crates so the
//! JS bridge has exactly one place to evolve.
//!
//! Built into a JS + .wasm bundle via:
//!
//! ```sh
//! wasm-pack build crates/core \
//!   --target web \
//!   --out-dir ../../packages/core-wasm/dist \
//!   --out-name opfs_core
//! ```

use opfs_crypto::commitment;
use wasm_bindgen::prelude::*;

pub use opfs_crypto;
pub use opfs_repo;
pub use opfs_share_protocol;

/// Protocol version (mirrors `opfs_share_protocol::PROTOCOL_VERSION`).
#[wasm_bindgen(js_name = protocolVersion)]
#[must_use]
#[allow(
    clippy::missing_const_for_fn,
    reason = "wasm-bindgen does not support const fn in the public surface"
)]
pub fn protocol_version() -> u8 {
    opfs_share_protocol::PROTOCOL_VERSION
}

/// Length in bytes of an X25519 public key (always 32).
#[wasm_bindgen(js_name = x25519PubkeyLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 32; wasm-bindgen rejects const fn"
)]
pub fn x25519_pubkey_len() -> u32 {
    opfs_share_protocol::X25519_PUBKEY_LEN as u32
}

/// Length of the rendezvous pickup code in Crockford-base32 characters.
#[wasm_bindgen(js_name = commitmentCodeLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 12; wasm-bindgen rejects const fn"
)]
pub fn commitment_code_len() -> u32 {
    commitment::CODE_LEN as u32
}

/// Derive the rendezvous pickup code for a recipient's ephemeral X25519
/// public key. Returns 12 Crockford-base32 characters (60 bits of
/// entropy bound to the key) — see ADR 0007.
#[wasm_bindgen(js_name = codeForPubkey)]
#[must_use]
pub fn code_for_pubkey(epk: &[u8]) -> String {
    commitment::code_for_pubkey(epk)
}

/// Verify a pickup code matches a fetched ephemeral pubkey.
///
/// Returns `true` on match, `false` on mismatch or wrong code length —
/// callers can branch without try/catch. The implementation is
/// constant-time inside the matched-length case.
#[wasm_bindgen(js_name = verifyCode)]
#[must_use]
pub fn verify_code(code: &str, epk: &[u8]) -> bool {
    commitment::verify_code(code, epk).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn re_exports_are_reachable() {
        let _ = crate::opfs_crypto::KEY_LEN;
        let _ = crate::opfs_repo::SCHEMA_VERSION;
        let _ = crate::opfs_share_protocol::PROTOCOL_VERSION;
    }

    #[test]
    fn protocol_version_matches_share_protocol() {
        assert_eq!(protocol_version(), opfs_share_protocol::PROTOCOL_VERSION);
    }

    #[test]
    fn commitment_roundtrip() {
        let epk = [7u8; 32];
        let code = code_for_pubkey(&epk);
        assert_eq!(code.len(), commitment_code_len() as usize);
        assert!(verify_code(&code, &epk));
        assert!(!verify_code(&code, &[8u8; 32]));
    }
}
