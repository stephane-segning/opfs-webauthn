//! Pure-Rust core for the wasm-bindgen surface in `lib.rs`.
//!
//! Anything that needs to be unit-testable with `cargo test` lives
//! here — wasm-bindgen-decorated functions cannot be called outside a
//! wasm runtime, so the public `#[wasm_bindgen]` impls are thin
//! wrappers that delegate to this module.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use opfs_crypto::{
    Aead, AeadError, HkdfError, KEY_LEN, Key, KeyError, NONCE_LEN, TAG_LEN, derive_kek,
};
use zeroize::Zeroizing;

/// Context label for the KEK derivation, per ADR 0005.
const KEK_INFO: &[u8] = b"opfs-webauthn/v1/kek";
/// Associated data bound into the AES-GCM tag when wrapping the DEK.
/// Anchors the wrap to the protocol version so a future major change
/// invalidates old wrapped DEKs by design.
const DEK_WRAP_AAD: &[u8] = b"opfs-webauthn/v1/dek-wrap";

/// Trait used by the wasm-bindgen wrapper to turn a typed error into
/// the string a `JsError` will surface. Avoids dragging `std::fmt`
/// imports into `lib.rs`.
pub trait DisplayError {
    fn to_string(&self) -> String;
}

#[derive(Debug)]
pub enum VaultError {
    BadWrapNonceLength { got: usize },
    BadWrappedDekLength { got: usize, expected: usize },
    BadRowNonceLength { got: usize },
    Hkdf,
    Aead,
    Key(KeyError),
    Random,
    AuthFailure,
}

impl DisplayError for VaultError {
    fn to_string(&self) -> String {
        match self {
            Self::BadWrapNonceLength { got } => {
                format!("wrapNonce must be {NONCE_LEN} bytes, got {got}")
            }
            Self::BadWrappedDekLength { got, expected } => {
                format!("wrappedDek must be {expected} bytes (DEK + GCM tag), got {got}")
            }
            Self::BadRowNonceLength { got } => {
                format!("nonce must be {NONCE_LEN} bytes, got {got}")
            }
            Self::Hkdf => String::from("KEK derivation failed"),
            Self::Aead => String::from("AEAD operation failed"),
            Self::Key(e) => format!("invalid key: {e}"),
            Self::Random => String::from("entropy source (crypto.getRandomValues / OS RNG) failed"),
            Self::AuthFailure => {
                String::from("vault unlock failed (wrong passkey or tampered data)")
            }
        }
    }
}

impl From<HkdfError> for VaultError {
    fn from(_: HkdfError) -> Self {
        Self::Hkdf
    }
}

impl From<AeadError> for VaultError {
    fn from(_: AeadError) -> Self {
        Self::Aead
    }
}

impl From<KeyError> for VaultError {
    fn from(e: KeyError) -> Self {
        Self::Key(e)
    }
}

/// Pure Rust vault. The wasm-bindgen wrapper in `lib.rs` holds one of
/// these as `Self(core::CryptoVault)`.
#[derive(Debug)]
pub struct CryptoVault {
    dek: Key,
}

impl CryptoVault {
    /// Enroll a new vault. The DEK and wrap nonce are generated inside
    /// wasm (via `getrandom`, which the "js" feature wires to
    /// `crypto.getRandomValues` on the web) so they never appear as a
    /// JS-visible byte buffer — see ADR 0005.
    pub fn enroll(prf_output: &[u8], prf_salt: &[u8]) -> Result<EnrollResult, VaultError> {
        // Wrap the DEK buffer in `Zeroizing` so it wipes on every drop
        // path, including the error paths below.
        let mut dek_bytes = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::getrandom(dek_bytes.as_mut()).map_err(|_| VaultError::Random)?;
        let mut wrap_nonce = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut wrap_nonce).map_err(|_| VaultError::Random)?;

        let kek = derive_kek(prf_output, prf_salt, KEK_INFO)?;
        let dek = Key::from_slice(&*dek_bytes)?;
        let kek_aead = Aead::new(&kek);
        let wrapped = kek_aead
            .encrypt(&wrap_nonce, DEK_WRAP_AAD, dek.expose())
            .map_err(VaultError::from)?;
        Ok(EnrollResult {
            vault: Some(Self { dek }),
            wrapped_dek: wrapped,
            wrap_nonce: wrap_nonce.to_vec(),
        })
    }

    pub fn unlock(
        prf_output: &[u8],
        prf_salt: &[u8],
        wrapped_dek: &[u8],
        wrap_nonce: &[u8],
    ) -> Result<Self, VaultError> {
        if wrap_nonce.len() != NONCE_LEN {
            return Err(VaultError::BadWrapNonceLength {
                got: wrap_nonce.len(),
            });
        }
        let expected = KEY_LEN + TAG_LEN;
        if wrapped_dek.len() != expected {
            return Err(VaultError::BadWrappedDekLength {
                got: wrapped_dek.len(),
                expected,
            });
        }
        let kek = derive_kek(prf_output, prf_salt, KEK_INFO)?;
        let kek_aead = Aead::new(&kek);
        // Wrap the decrypted DEK in `Zeroizing` so the Vec wipes on
        // every drop path, including the error branch from
        // `Key::from_slice` below.
        let dek_bytes = Zeroizing::new(
            kek_aead
                .decrypt(
                    wrap_nonce.try_into().expect("len checked above"),
                    DEK_WRAP_AAD,
                    wrapped_dek,
                )
                .map_err(|_| VaultError::AuthFailure)?,
        );
        let dek = Key::from_slice(&dek_bytes)?;
        Ok(Self { dek })
    }

    pub fn encrypt(
        &self,
        nonce: &[u8],
        aad: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, VaultError> {
        if nonce.len() != NONCE_LEN {
            return Err(VaultError::BadRowNonceLength { got: nonce.len() });
        }
        let gcm = Aead::new(&self.dek);
        gcm.encrypt(nonce.try_into().expect("len checked above"), aad, plaintext)
            .map_err(VaultError::from)
    }

    pub fn decrypt(
        &self,
        nonce: &[u8],
        aad: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, VaultError> {
        if nonce.len() != NONCE_LEN {
            return Err(VaultError::BadRowNonceLength { got: nonce.len() });
        }
        let gcm = Aead::new(&self.dek);
        gcm.decrypt(
            nonce.try_into().expect("len checked above"),
            aad,
            ciphertext,
        )
        .map_err(VaultError::from)
    }
}

#[derive(Debug)]
pub struct EnrollResult {
    vault: Option<CryptoVault>,
    pub wrapped_dek: Vec<u8>,
    pub wrap_nonce: Vec<u8>,
}

impl EnrollResult {
    // `Option::take` is `const fn` since Rust 1.83; workspace
    // `rust-version` is 1.85.
    pub const fn take_vault(&mut self) -> Option<CryptoVault> {
        self.vault.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn fixture(seed: u8) -> (Vec<u8>, Vec<u8>) {
        let prf = vec![seed; 32];
        let salt = vec![seed.wrapping_add(1); 16];
        (prf, salt)
    }

    #[test]
    fn enroll_and_unlock_roundtrip_through_persisted_blob() {
        let (prf, salt) = fixture(0xA5);
        let mut enroll = CryptoVault::enroll(&prf, &salt).expect("enroll succeeds");

        let vault = enroll.take_vault().unwrap();
        let row_nonce = [0xCC; 12];
        let ct = vault
            .encrypt(&row_nonce, b"row-aad", b"hello, vault")
            .unwrap();
        let pt = vault.decrypt(&row_nonce, b"row-aad", &ct).unwrap();
        assert_eq!(pt, b"hello, vault");

        // Simulate persisting the wrapped DEK to OPFS and unlocking
        // from cold start.
        let wrapped = enroll.wrapped_dek.clone();
        let stored_wrap_nonce = enroll.wrap_nonce.clone();
        let reopened = CryptoVault::unlock(&prf, &salt, &wrapped, &stored_wrap_nonce)
            .expect("unlock with the right PRF succeeds");
        let pt2 = reopened.decrypt(&row_nonce, b"row-aad", &ct).unwrap();
        assert_eq!(pt2, b"hello, vault");
    }

    #[test]
    fn unlock_rejects_wrong_prf_output() {
        let (prf, salt) = fixture(0x10);
        let enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let mut wrong_prf = prf;
        wrong_prf[0] ^= 0x01;
        let err = CryptoVault::unlock(&wrong_prf, &salt, &enroll.wrapped_dek, &enroll.wrap_nonce);
        assert!(matches!(err, Err(VaultError::AuthFailure)));
    }

    #[test]
    fn unlock_rejects_tampered_wrapped_dek() {
        let (prf, salt) = fixture(0x20);
        let enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let mut wrapped = enroll.wrapped_dek.clone();
        wrapped[0] ^= 0x01;
        let err = CryptoVault::unlock(&prf, &salt, &wrapped, &enroll.wrap_nonce);
        assert!(matches!(err, Err(VaultError::AuthFailure)));
    }

    #[test]
    fn unlock_rejects_tampered_wrap_nonce() {
        let (prf, salt) = fixture(0x21);
        let enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let mut wrap_nonce_tampered = enroll.wrap_nonce.clone();
        wrap_nonce_tampered[0] ^= 0x01;
        let err = CryptoVault::unlock(&prf, &salt, &enroll.wrapped_dek, &wrap_nonce_tampered);
        assert!(matches!(err, Err(VaultError::AuthFailure)));
    }

    #[test]
    fn take_vault_twice_returns_none_second_time() {
        let (prf, salt) = fixture(0x30);
        let mut enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        assert!(enroll.take_vault().is_some());
        assert!(enroll.take_vault().is_none());
    }

    #[test]
    fn encrypt_rejects_bad_nonce_length() {
        let (prf, salt) = fixture(0x40);
        let mut enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let vault = enroll.take_vault().unwrap();
        assert!(matches!(
            vault.encrypt(&[0u8; 8], b"aad", b"x"),
            Err(VaultError::BadRowNonceLength { got: 8 })
        ));
        assert!(matches!(
            vault.decrypt(&[0u8; 8], b"aad", b"x"),
            Err(VaultError::BadRowNonceLength { got: 8 })
        ));
    }

    #[test]
    fn enroll_produces_distinct_dek_each_call() {
        // Same PRF + salt — two enroll calls still produce different
        // wrapped DEKs, because the DEK and wrap nonce are both fresh
        // random per call. This is the test that proves wasm-side
        // randomness, not caller-supplied bytes.
        let (prf, salt) = fixture(0x42);
        let a = CryptoVault::enroll(&prf, &salt).unwrap();
        let b = CryptoVault::enroll(&prf, &salt).unwrap();
        assert_ne!(a.wrapped_dek, b.wrapped_dek);
        assert_ne!(a.wrap_nonce, b.wrap_nonce);
    }

    #[test]
    fn unlock_rejects_bad_input_lengths() {
        let valid_wrap = vec![0u8; KEY_LEN + TAG_LEN];
        let valid_nonce = [0u8; 12];
        assert!(matches!(
            CryptoVault::unlock(&[0u8; 32], &[0u8; 16], &valid_wrap, &[0u8; 8]),
            Err(VaultError::BadWrapNonceLength { got: 8 })
        ));
        assert!(matches!(
            CryptoVault::unlock(&[0u8; 32], &[0u8; 16], &[0u8; 32], &valid_nonce),
            Err(VaultError::BadWrappedDekLength {
                got: 32,
                expected: _
            })
        ));
    }

    #[test]
    fn different_aad_fails_decrypt() {
        let (prf, salt) = fixture(0x50);
        let mut enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let vault = enroll.take_vault().unwrap();
        let row_nonce = [0xAB; 12];
        let ct = vault.encrypt(&row_nonce, b"aad-a", b"payload").unwrap();
        assert!(vault.decrypt(&row_nonce, b"aad-b", &ct).is_err());
    }
}
