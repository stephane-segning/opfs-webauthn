//! HPKE-style X25519 + HKDF-SHA-256 + AES-256-GCM seal/open for the
//! recipient-first share flow (ADR 0007).
//!
//! Construction (RFC 9180 base mode, lightly specialized):
//!   1. Recipient publishes `recipient_pk` and keeps `recipient_sk`.
//!   2. Sender draws an ephemeral `(sender_sk, sender_pk)` X25519
//!      keypair and computes `dh = X25519(sender_sk, recipient_pk)`.
//!   3. `prk = HKDF-Extract(salt = sender_pk || recipient_pk, ikm = dh)`
//!      binds both endpoints into the salt so the same DH output can
//!      never be reused under a different rendezvous.
//!   4. `key = HKDF-Expand(prk, info, 32)`  — caller-supplied
//!      `info` is the domain separator (e.g. `b"opfs-webauthn/v1/share"`).
//!   5. Encrypt under AES-256-GCM with a fresh 96-bit nonce, binding
//!      `sender_pk || recipient_pk || info` as AAD.
//!
//! The decrypt side computes the same `dh` via
//! `X25519(recipient_sk, sender_pk)` and follows the same KDF/AAD.

use crate::KEY_LEN;
use crate::aead::{Aead, AeadError, NONCE_LEN};
use crate::hkdf::HkdfError;
use crate::key::{Key, ZeroizingVec};
use alloc::vec::Vec;
use hkdf::Hkdf;
use rand_core::{CryptoRng, RngCore};
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// X25519 public-key length in bytes.
pub const X25519_PUBKEY_LEN: usize = 32;
/// X25519 secret-scalar length in bytes.
pub const X25519_SECRET_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum ShareError {
    #[error("hkdf: {0}")]
    Hkdf(#[from] HkdfError),
    #[error("aead: {0}")]
    Aead(#[from] AeadError),
}

/// Recipient's long-ish-lived X25519 secret. Zeroizes on drop. The
/// rendezvous flow scopes the secret to a single share session, so
/// "long-ish" means "the 5-minute TTL window" in practice.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct RecipientSecret([u8; X25519_SECRET_LEN]);

impl RecipientSecret {
    /// Draw a fresh recipient keypair. The matching public key is
    /// available via [`Self::pubkey`] and is the value the recipient
    /// publishes to the rendezvous backend.
    pub fn random(rng: &mut (impl RngCore + CryptoRng)) -> Self {
        let mut bytes = Zeroizing::new([0u8; X25519_SECRET_LEN]);
        rng.fill_bytes(bytes.as_mut());
        // X25519 scalars are clamped on use; we keep the raw bytes so
        // the secret survives a `Clone` without surprises.
        Self(*bytes)
    }

    /// Reconstruct a secret from previously-stored bytes (for the
    /// recipient's session-resume path — the secret has to outlive
    /// the page that minted it).
    pub const fn from_bytes(bytes: [u8; X25519_SECRET_LEN]) -> Self {
        Self(bytes)
    }

    /// The matching X25519 public key.
    pub fn pubkey(&self) -> [u8; X25519_PUBKEY_LEN] {
        let sk = StaticSecret::from(self.0);
        let pk = PublicKey::from(&sk);
        *pk.as_bytes()
    }

    /// Borrow the raw secret bytes. Prefer storing via the
    /// recipient handle instead of round-tripping through here.
    pub const fn expose(&self) -> &[u8; X25519_SECRET_LEN] {
        &self.0
    }
}

impl core::fmt::Debug for RecipientSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("RecipientSecret(<redacted>)")
    }
}

/// The wire-format pieces a sender produces. The caller assembles
/// these into the `ShareBlob` CBOR envelope (see `opfs-share-protocol`).
#[derive(Debug, Clone)]
pub struct SealedShare {
    pub sender_pubkey: [u8; X25519_PUBKEY_LEN],
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

/// Encrypt `plaintext` under the recipient's X25519 public key,
/// with caller-supplied randomness.
///
/// Splitting the entropy step out of `seal` lets the WASM bindings
/// fetch their randomness via fallible `getrandom` calls and surface
/// failures as typed errors, instead of panicking deep inside an
/// `RngCore::fill_bytes` call. Host-side callers that already have
/// an `RngCore + CryptoRng` should use `seal` and let it handle the
/// entropy plumbing.
#[allow(
    clippy::similar_names,
    reason = "sender_sk/sender_pk/recipient_pk are protocol-defined names"
)]
pub fn seal_with_components(
    recipient_pubkey: &[u8; X25519_PUBKEY_LEN],
    plaintext: &[u8],
    info: &[u8],
    sender_secret_bytes: &[u8; X25519_SECRET_LEN],
    nonce: &[u8; NONCE_LEN],
) -> Result<SealedShare, ShareError> {
    let sender_sk = StaticSecret::from(*sender_secret_bytes);
    let sender_pk = PublicKey::from(&sender_sk);
    let sender_pk_bytes = *sender_pk.as_bytes();

    let dh = sender_sk.diffie_hellman(&PublicKey::from(*recipient_pubkey));
    let key = derive_share_key(dh.as_bytes(), &sender_pk_bytes, recipient_pubkey, info)?;

    let aad = aad_bytes(&sender_pk_bytes, recipient_pubkey, info);
    let aead = Aead::new(&key);
    let ciphertext = aead.encrypt(nonce, &aad, plaintext)?;

    Ok(SealedShare {
        sender_pubkey: sender_pk_bytes,
        nonce: *nonce,
        ciphertext,
    })
}

/// Convenience wrapper around [`seal_with_components`] that draws
/// the sender's ephemeral secret and nonce from `rng`.
///
/// Caller-side entropy failures are an infallible-API panic — use
/// `seal_with_components` directly if you need typed errors.
pub fn seal(
    recipient_pubkey: &[u8; X25519_PUBKEY_LEN],
    plaintext: &[u8],
    info: &[u8],
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<SealedShare, ShareError> {
    let mut sender_secret_bytes = Zeroizing::new([0u8; X25519_SECRET_LEN]);
    rng.fill_bytes(sender_secret_bytes.as_mut());
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce);
    seal_with_components(
        recipient_pubkey,
        plaintext,
        info,
        &sender_secret_bytes,
        &nonce,
    )
}

/// Decrypt a `SealedShare` using the recipient's secret. Returns the
/// plaintext in a `Zeroizing<Vec<u8>>` so the buffer is wiped when it
/// goes out of scope at the call site.
#[allow(
    clippy::similar_names,
    reason = "sender_pubkey/recipient_pk are protocol-defined names"
)]
pub fn open(
    recipient_secret: &RecipientSecret,
    sender_pubkey: &[u8; X25519_PUBKEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    info: &[u8],
) -> Result<ZeroizingVec, ShareError> {
    let recipient_sk = StaticSecret::from(*recipient_secret.expose());
    let recipient_pk_bytes = *PublicKey::from(&recipient_sk).as_bytes();

    let dh = recipient_sk.diffie_hellman(&PublicKey::from(*sender_pubkey));
    let key = derive_share_key(dh.as_bytes(), sender_pubkey, &recipient_pk_bytes, info)?;

    let aad = aad_bytes(sender_pubkey, &recipient_pk_bytes, info);
    let aead = Aead::new(&key);
    let plaintext = aead.decrypt(nonce, &aad, ciphertext)?;
    Ok(Zeroizing::new(plaintext))
}

/// HKDF over the X25519 DH output. The salt binds both endpoints so
/// the same DH value can never key two different rendezvous, even if
/// the same recipient pubkey is somehow reused.
fn derive_share_key(
    dh: &[u8; KEY_LEN],
    sender_pubkey: &[u8; X25519_PUBKEY_LEN],
    recipient_pubkey: &[u8; X25519_PUBKEY_LEN],
    info: &[u8],
) -> Result<Key, HkdfError> {
    let mut salt = [0u8; 2 * X25519_PUBKEY_LEN];
    salt[..X25519_PUBKEY_LEN].copy_from_slice(sender_pubkey);
    salt[X25519_PUBKEY_LEN..].copy_from_slice(recipient_pubkey);

    let hk = Hkdf::<Sha256>::new(Some(&salt), dh);
    let mut okm = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(info, okm.as_mut())
        .map_err(|_| HkdfError::Expand)?;
    Ok(Key::from_bytes(*okm))
}

/// AAD bound into the AES-GCM tag. Anything the receiver checks goes
/// in here so a hostile relay cannot substitute either pubkey or
/// the info label without invalidating the tag.
fn aad_bytes(
    sender_pubkey: &[u8; X25519_PUBKEY_LEN],
    recipient_pubkey: &[u8; X25519_PUBKEY_LEN],
    info: &[u8],
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(2 * X25519_PUBKEY_LEN + info.len());
    aad.extend_from_slice(sender_pubkey);
    aad.extend_from_slice(recipient_pubkey);
    aad.extend_from_slice(info);
    aad
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    const INFO: &[u8] = b"opfs-webauthn/v1/share";

    fn fresh_recipient() -> RecipientSecret {
        RecipientSecret::random(&mut OsRng)
    }

    #[test]
    fn seal_open_roundtrip_recovers_plaintext() {
        let recipient = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let plaintext = b"share me, please".to_vec();
        let sealed = seal(&recipient_pk, &plaintext, INFO, &mut OsRng).unwrap();
        let opened = open(
            &recipient,
            &sealed.sender_pubkey,
            &sealed.nonce,
            &sealed.ciphertext,
            INFO,
        )
        .unwrap();
        assert_eq!(opened.as_slice(), plaintext.as_slice());
    }

    #[test]
    fn open_with_wrong_recipient_secret_fails() {
        let recipient = fresh_recipient();
        let attacker = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let sealed = seal(&recipient_pk, b"secret", INFO, &mut OsRng).unwrap();
        let err = open(
            &attacker,
            &sealed.sender_pubkey,
            &sealed.nonce,
            &sealed.ciphertext,
            INFO,
        )
        .unwrap_err();
        assert!(matches!(err, ShareError::Aead(_)));
    }

    #[test]
    fn open_with_tampered_ciphertext_fails() {
        let recipient = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let mut sealed = seal(&recipient_pk, b"a payload", INFO, &mut OsRng).unwrap();
        sealed.ciphertext[0] ^= 0x01;
        let err = open(
            &recipient,
            &sealed.sender_pubkey,
            &sealed.nonce,
            &sealed.ciphertext,
            INFO,
        )
        .unwrap_err();
        assert!(matches!(err, ShareError::Aead(_)));
    }

    #[test]
    fn open_with_substituted_sender_pubkey_fails() {
        let recipient = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let sealed = seal(&recipient_pk, b"payload", INFO, &mut OsRng).unwrap();
        // Use a different (well-formed) pubkey as the sender's — the
        // KDF salt changes, so the derived key changes, so the tag
        // fails.
        let other = fresh_recipient();
        let bogus_sender = other.pubkey();
        let err = open(
            &recipient,
            &bogus_sender,
            &sealed.nonce,
            &sealed.ciphertext,
            INFO,
        )
        .unwrap_err();
        assert!(matches!(err, ShareError::Aead(_)));
    }

    #[test]
    fn different_info_breaks_decrypt() {
        let recipient = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let sealed = seal(&recipient_pk, b"payload", INFO, &mut OsRng).unwrap();
        let err = open(
            &recipient,
            &sealed.sender_pubkey,
            &sealed.nonce,
            &sealed.ciphertext,
            b"opfs-webauthn/v2/share",
        )
        .unwrap_err();
        assert!(matches!(err, ShareError::Aead(_)));
    }

    #[test]
    fn ephemeral_sender_pubkeys_differ_between_seals() {
        let recipient = fresh_recipient();
        let recipient_pk = recipient.pubkey();
        let a = seal(&recipient_pk, b"x", INFO, &mut OsRng).unwrap();
        let b = seal(&recipient_pk, b"x", INFO, &mut OsRng).unwrap();
        assert_ne!(a.sender_pubkey, b.sender_pubkey);
        assert_ne!(a.nonce, b.nonce);
    }
}
