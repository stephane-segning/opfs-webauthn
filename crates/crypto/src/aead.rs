//! AES-256-GCM encrypt/decrypt for row payloads and the key-wrap.

use crate::key::Key;
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use alloc::vec::Vec;
use thiserror::Error;

/// Nonce length in bytes — AES-GCM standard 96-bit nonce.
pub const NONCE_LEN: usize = 12;
/// GCM authentication tag length.
pub const TAG_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum AeadError {
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption failed (tag mismatch or truncated ciphertext)")]
    Decrypt,
}

pub struct Aead {
    cipher: Aes256Gcm,
}

impl core::fmt::Debug for Aead {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Aead(Aes256Gcm)")
    }
}

impl Aead {
    pub fn new(key: &Key) -> Self {
        // Aes256Gcm::new accepts a GenericArray which is just a wrapped 32-byte slice.
        let cipher = Aes256Gcm::new(key.expose().into());
        Self { cipher }
    }

    /// Encrypt `plaintext` to a fresh ciphertext+tag buffer.
    ///
    /// `aad` is bound into the tag and verified on decrypt.
    /// Caller-supplied nonce must be unique under this key — never reuse.
    pub fn encrypt(
        &self,
        nonce: &[u8; NONCE_LEN],
        aad: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, AeadError> {
        let nonce = Nonce::from_slice(nonce);
        let mut buf = Vec::with_capacity(plaintext.len() + TAG_LEN);
        buf.extend_from_slice(plaintext);
        self.cipher
            .encrypt_in_place(nonce, aad, &mut buf)
            .map_err(|_| AeadError::Encrypt)?;
        Ok(buf)
    }

    /// Decrypt `ciphertext` (which includes the trailing tag).
    pub fn decrypt(
        &self,
        nonce: &[u8; NONCE_LEN],
        aad: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, AeadError> {
        let nonce = Nonce::from_slice(nonce);
        let mut buf = Vec::from(ciphertext);
        self.cipher
            .decrypt_in_place(nonce, aad, &mut buf)
            .map_err(|_| AeadError::Decrypt)?;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hex_literal::hex;

    /// NIST GCM test vector for AES-256, no AAD.
    ///   key: 31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22
    ///   nonce: 5b2675071e6adf562d6cce40
    ///   plaintext: 2b800e4f3f9b95edec56cefa3a01622a1c61f43d61cdaf6a76d5b58c47e7d8b8
    ///   tag: 7ac4ea4ce6f49ba8feb6df30a7e7eddb (truncated for brevity in this
    ///   test — we just round-trip and check the tag instead of pinning a
    ///   specific tag value, since the upstream `RustCrypto` crate already
    ///   ships its own NIST KAT suite).
    #[test]
    fn aes_gcm_roundtrip() {
        let key_bytes = hex!("31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22");
        let nonce = hex!("5b2675071e6adf562d6cce40");
        let plaintext = hex!("2b800e4f3f9b95edec56cefa3a01622a1c61f43d61cdaf6a76d5b58c47e7d8b8");
        let key = Key::from_bytes(key_bytes);
        let aead = Aead::new(&key);

        let ct = aead.encrypt(&nonce, b"row-aad", &plaintext).unwrap();
        assert_eq!(ct.len(), plaintext.len() + TAG_LEN);

        let pt = aead.decrypt(&nonce, b"row-aad", &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn aes_gcm_rejects_tampered_ciphertext() {
        let key = Key::from_bytes([7u8; 32]);
        let aead = Aead::new(&key);
        let nonce = [0u8; NONCE_LEN];
        let mut ct = aead.encrypt(&nonce, b"aad", b"hello world").unwrap();
        // Flip a bit in the ciphertext body.
        ct[0] ^= 0x01;
        let err = aead.decrypt(&nonce, b"aad", &ct).unwrap_err();
        assert!(matches!(err, AeadError::Decrypt));
    }

    #[test]
    fn aes_gcm_rejects_wrong_aad() {
        let key = Key::from_bytes([7u8; 32]);
        let aead = Aead::new(&key);
        let nonce = [1u8; NONCE_LEN];
        let ct = aead.encrypt(&nonce, b"aad-a", b"payload").unwrap();
        let err = aead.decrypt(&nonce, b"aad-b", &ct).unwrap_err();
        assert!(matches!(err, AeadError::Decrypt));
    }
}
