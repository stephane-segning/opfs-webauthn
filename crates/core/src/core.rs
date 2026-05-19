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
    Aead, AeadError, HkdfError, KEY_LEN, Key, KeyError, NONCE_LEN, RecipientSecret, SealedShare,
    ShareError, TAG_LEN, X25519_PUBKEY_LEN, derive_kek, share_open, share_seal,
};
use rand_core::OsRng;
use zeroize::Zeroizing;

/// Context label for the KEK derivation, per ADR 0005.
const KEK_INFO: &[u8] = b"opfs-webauthn/v1/kek";
/// Domain separator bound into the share-flow HKDF expand label
/// (and the AES-GCM AAD) so a future protocol revision invalidates
/// old blobs by design. Bumping the suffix is a deliberate break.
const SHARE_INFO: &[u8] = b"opfs-webauthn/v1/share";
/// Associated data bound into the AES-GCM tag when wrapping the DEK.
/// Anchors the wrap to the protocol version so a future major change
/// invalidates old wrapped DEKs by design.
const DEK_WRAP_AAD: &[u8] = b"opfs-webauthn/v1/dek-wrap";
/// Expected length of the `WebAuthn` PRF output, in bytes (W3C webauthn-3 §10.1.2).
const PRF_OUTPUT_LEN: usize = 32;

/// Trait used by the wasm-bindgen wrapper to turn a typed error into
/// the string a `JsError` will surface. Avoids dragging `std::fmt`
/// imports into `lib.rs`.
pub trait DisplayError {
    fn to_string(&self) -> String;
}

#[derive(Debug)]
pub enum VaultError {
    BadPrfOutputLength { got: usize },
    BadWrapNonceLength { got: usize },
    BadWrappedDekLength { got: usize, expected: usize },
    BadRowNonceLength { got: usize },
    Hkdf,
    Aead(AeadError),
    Key(KeyError),
    Random,
    AuthFailure,
}

impl DisplayError for VaultError {
    fn to_string(&self) -> String {
        match self {
            Self::BadPrfOutputLength { got } => {
                format!("prfOutput must be {PRF_OUTPUT_LEN} bytes (W3C WebAuthn PRF), got {got}")
            }
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
            Self::Aead(e) => format!("AEAD operation failed: {e}"),
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
    fn from(e: AeadError) -> Self {
        Self::Aead(e)
    }
}

impl From<KeyError> for VaultError {
    fn from(e: KeyError) -> Self {
        Self::Key(e)
    }
}

/// Errors surfaced from the recipient-first share flow. Kept distinct
/// from `VaultError` so the JS bindings can map them to dedicated
/// `JsError`s without leaking the failure shape via stringly-typed
/// catches.
#[derive(Debug)]
pub enum ShareVaultError {
    BadRecipientPubkeyLength { got: usize },
    BadSenderPubkeyLength { got: usize },
    BadShareNonceLength { got: usize },
    Share(ShareError),
}

impl DisplayError for ShareVaultError {
    fn to_string(&self) -> String {
        match self {
            Self::BadRecipientPubkeyLength { got } => {
                format!("recipientPubkey must be {X25519_PUBKEY_LEN} bytes, got {got}")
            }
            Self::BadSenderPubkeyLength { got } => {
                format!("senderPubkey must be {X25519_PUBKEY_LEN} bytes, got {got}")
            }
            Self::BadShareNonceLength { got } => {
                format!("nonce must be {NONCE_LEN} bytes, got {got}")
            }
            Self::Share(e) => format!("share crypto failure: {e}"),
        }
    }
}

impl From<ShareError> for ShareVaultError {
    fn from(e: ShareError) -> Self {
        Self::Share(e)
    }
}

fn pubkey_array(bytes: &[u8]) -> Option<[u8; X25519_PUBKEY_LEN]> {
    bytes.try_into().ok()
}

fn nonce_array(bytes: &[u8]) -> Option<[u8; NONCE_LEN]> {
    bytes.try_into().ok()
}

/// Recipient-side handle. Owns the X25519 secret for the lifetime of
/// the share session and is the only thing that can open a `SealedShare`
/// addressed to its public key.
#[derive(Debug)]
pub struct RecipientHandle {
    secret: RecipientSecret,
}

impl RecipientHandle {
    /// Mint a fresh recipient keypair.
    pub fn prepare() -> Self {
        Self {
            secret: RecipientSecret::random(&mut OsRng),
        }
    }

    /// Public key to publish via the rendezvous backend.
    pub fn pubkey(&self) -> [u8; X25519_PUBKEY_LEN] {
        self.secret.pubkey()
    }

    /// Open a sealed share addressed to this recipient. Returns the
    /// raw plaintext bytes; the buffer is zeroized on drop.
    pub fn open(
        &self,
        sender_pubkey: &[u8],
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, ShareVaultError> {
        let Some(sender_pk) = pubkey_array(sender_pubkey) else {
            return Err(ShareVaultError::BadSenderPubkeyLength {
                got: sender_pubkey.len(),
            });
        };
        let Some(nonce) = nonce_array(nonce) else {
            return Err(ShareVaultError::BadShareNonceLength { got: nonce.len() });
        };
        let plaintext = share_open(&self.secret, &sender_pk, &nonce, ciphertext, SHARE_INFO)?;
        // `plaintext` is `Zeroizing<Vec<u8>>`; the clone we hand back
        // is what JS sees, while the source buffer is wiped at the end
        // of this scope. JS callers are responsible for clearing the
        // returned bytes once the note has been written to OPFS.
        Ok(plaintext.to_vec())
    }
}

/// Sender-side seal. Encrypts `plaintext` under `recipient_pubkey`
/// using a fresh ephemeral X25519 keypair.
pub fn seal_share(
    recipient_pubkey: &[u8],
    plaintext: &[u8],
) -> Result<SealedShare, ShareVaultError> {
    let Some(pk) = pubkey_array(recipient_pubkey) else {
        return Err(ShareVaultError::BadRecipientPubkeyLength {
            got: recipient_pubkey.len(),
        });
    };
    Ok(share_seal(&pk, plaintext, SHARE_INFO, &mut OsRng)?)
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
        if prf_output.len() != PRF_OUTPUT_LEN {
            return Err(VaultError::BadPrfOutputLength {
                got: prf_output.len(),
            });
        }
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
        if prf_output.len() != PRF_OUTPUT_LEN {
            return Err(VaultError::BadPrfOutputLength {
                got: prf_output.len(),
            });
        }
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
    fn enroll_rejects_non_32_byte_prf_output() {
        // Empty, too-short, and too-long inputs all rejected.
        let salt = vec![0u8; 16];
        for bogus_len in [0usize, 1, 16, 31, 33, 64] {
            let bogus = vec![0u8; bogus_len];
            assert!(
                matches!(
                    CryptoVault::enroll(&bogus, &salt),
                    Err(VaultError::BadPrfOutputLength { .. })
                ),
                "enroll must reject {bogus_len}-byte PRF output",
            );
        }
    }

    #[test]
    fn unlock_rejects_non_32_byte_prf_output() {
        let (prf, salt) = fixture(0x60);
        let enroll = CryptoVault::enroll(&prf, &salt).unwrap();
        let salt16 = vec![0u8; 16];
        for bogus_len in [0usize, 1, 16, 31, 33, 64] {
            let bogus = vec![0u8; bogus_len];
            assert!(
                matches!(
                    CryptoVault::unlock(&bogus, &salt16, &enroll.wrapped_dek, &enroll.wrap_nonce),
                    Err(VaultError::BadPrfOutputLength { .. })
                ),
                "unlock must reject {bogus_len}-byte PRF output",
            );
        }
    }

    #[test]
    fn share_seal_open_roundtrip_recovers_plaintext() {
        let recipient = RecipientHandle::prepare();
        let recipient_pk = recipient.pubkey();
        let sealed = seal_share(&recipient_pk, b"hello share").expect("seal");
        let opened = recipient
            .open(&sealed.sender_pubkey, &sealed.nonce, &sealed.ciphertext)
            .expect("open");
        assert_eq!(opened, b"hello share");
    }

    #[test]
    fn share_open_rejects_wrong_recipient() {
        let alice = RecipientHandle::prepare();
        let mallory = RecipientHandle::prepare();
        let sealed = seal_share(&alice.pubkey(), b"to alice").unwrap();
        let err = mallory
            .open(&sealed.sender_pubkey, &sealed.nonce, &sealed.ciphertext)
            .unwrap_err();
        assert!(matches!(err, ShareVaultError::Share(_)));
    }

    #[test]
    fn share_open_rejects_bad_input_lengths() {
        let recipient = RecipientHandle::prepare();
        let sealed = seal_share(&recipient.pubkey(), b"x").unwrap();
        // Wrong sender pubkey length.
        assert!(matches!(
            recipient.open(&[0u8; 31], &sealed.nonce, &sealed.ciphertext),
            Err(ShareVaultError::BadSenderPubkeyLength { got: 31 })
        ));
        // Wrong nonce length.
        assert!(matches!(
            recipient.open(&sealed.sender_pubkey, &[0u8; 8], &sealed.ciphertext),
            Err(ShareVaultError::BadShareNonceLength { got: 8 })
        ));
    }

    #[test]
    fn seal_share_rejects_bad_recipient_pubkey_length() {
        for bogus_len in [0usize, 16, 31, 33, 64] {
            let bogus = vec![0u8; bogus_len];
            assert!(matches!(
                seal_share(&bogus, b"plain"),
                Err(ShareVaultError::BadRecipientPubkeyLength { .. })
            ));
        }
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
