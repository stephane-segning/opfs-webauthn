//! HKDF-SHA-256 KEK derivation.
//!
//! The KEK derived here wraps the random per-vault DEK (see ADR 0005).
//! Inputs:
//!   - `prf_output`: bytes returned by the `WebAuthn` PRF extension
//!     (the IKM).
//!   - `salt`: stable, plaintext salt persisted alongside the
//!     credential id.
//!   - `info`: a per-purpose context string.

use crate::{KEY_LEN, key::Key};
use hkdf::Hkdf;
use sha2::Sha256;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum HkdfError {
    #[error("HKDF expand failed")]
    Expand,
}

/// Default purpose label for the vault KEK.
pub const KEK_INFO: &[u8] = b"opfs-webauthn/v1/kek";

/// Derive a 256-bit KEK from the PRF output.
pub fn derive_kek(prf_output: &[u8], salt: &[u8], info: &[u8]) -> Result<Key, HkdfError> {
    let hk = Hkdf::<Sha256>::new(Some(salt), prf_output);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(info, &mut okm).map_err(|_| HkdfError::Expand)?;
    Ok(Key::from_bytes(okm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_literal::hex;

    /// RFC 5869 §A.1 — Test Case 1 (SHA-256).
    /// IKM:  0x0b * 22
    /// salt: 0x000102030405060708090a0b0c
    /// info: 0xf0f1f2f3f4f5f6f7f8f9
    /// L=42 OKM: 3cb25f25faacd57a90434f64d0362f2a 2d2d0a90cf1a5a4c5db02d56ecc4c5bf
    ///          34007208d5b887185865
    #[test]
    fn rfc5869_test_case_1_first_32_bytes() {
        let ikm = hex!("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let salt = hex!("000102030405060708090a0b0c");
        let info = hex!("f0f1f2f3f4f5f6f7f8f9");

        let key = derive_kek(&ikm, &salt, &info).expect("hkdf");
        // First 32 of the 42-byte OKM:
        let expected = hex!("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf");
        assert_eq!(key.expose(), &expected);
    }

    #[test]
    fn different_info_yields_different_kek() {
        let prf = b"a-prf-output-32-bytes-of-entropy";
        let salt = b"stable-salt";
        let k1 = derive_kek(prf, salt, b"opfs-webauthn/v1/kek").unwrap();
        let k2 = derive_kek(prf, salt, b"opfs-webauthn/v1/share").unwrap();
        assert_ne!(k1.expose(), k2.expose());
    }
}
