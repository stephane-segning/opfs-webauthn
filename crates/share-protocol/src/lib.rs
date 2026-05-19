//! Typed envelope for the recipient-first rendezvous share flow.
//!
//! Per ADR 0007:
//!   - The recipient mints a rendezvous with its ephemeral X25519
//!     pubkey; the backend returns the BLAKE3-commitment pickup code.
//!   - The sender fetches the ephemeral pubkey by code, **verifies the
//!     commitment locally**, encrypts the note blob with HPKE-style
//!     X25519+HKDF+AES-256-GCM, and uploads the result.
//!   - The recipient pulls the blob exactly once.
//!
//! This crate ships the envelope schema only. The on-the-wire codec is
//! CBOR (ciborium); the JS side talks to it through the opfs-core WASM
//! bindings.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Protocol version. Bumped when the envelope layout changes
/// incompatibly.
pub const PROTOCOL_VERSION: u8 = 1;

/// Length of an X25519 public key in bytes.
pub const X25519_PUBKEY_LEN: usize = 32;
/// Length of an AES-GCM nonce in bytes.
pub const AES_GCM_NONCE_LEN: usize = 12;

/// Body the recipient device posts to open a rendezvous.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RendezvousRequest {
    pub version: u8,
    /// Recipient's ephemeral X25519 public key.
    #[serde(with = "serde_bytes")]
    pub ephemeral_pubkey: [u8; X25519_PUBKEY_LEN],
}

/// Response returned to the recipient when a rendezvous is minted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RendezvousResponse {
    pub version: u8,
    /// 12-character Crockford-base32 pickup code (60-bit commitment).
    pub code: alloc::string::String,
    /// Unix timestamp (seconds) when the rendezvous expires.
    pub expires_at: u64,
}

/// Encrypted blob the sender uploads under the pickup code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareBlob {
    pub version: u8,
    /// Sender's ephemeral X25519 public key for HPKE key agreement.
    #[serde(with = "serde_bytes")]
    pub sender_pubkey: [u8; X25519_PUBKEY_LEN],
    /// AES-GCM nonce.
    #[serde(with = "serde_bytes")]
    pub nonce: [u8; AES_GCM_NONCE_LEN],
    /// AES-256-GCM ciphertext including the 16-byte tag.
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn rendezvous_request_roundtrips_through_cbor() {
        let mut pk = [0u8; X25519_PUBKEY_LEN];
        pk[..4].copy_from_slice(&[1, 2, 3, 4]);
        let req = RendezvousRequest {
            version: PROTOCOL_VERSION,
            ephemeral_pubkey: pk,
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&req, &mut buf).unwrap();
        let decoded: RendezvousRequest = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(decoded.version, PROTOCOL_VERSION);
        assert_eq!(decoded.ephemeral_pubkey, req.ephemeral_pubkey);
    }

    #[test]
    fn share_blob_roundtrips_through_cbor() {
        let blob = ShareBlob {
            version: PROTOCOL_VERSION,
            sender_pubkey: [9; X25519_PUBKEY_LEN],
            nonce: [0; AES_GCM_NONCE_LEN],
            ciphertext: vec![0xAA; 64],
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&blob, &mut buf).unwrap();
        let decoded: ShareBlob = ciborium::from_reader(buf.as_slice()).unwrap();
        assert_eq!(decoded.sender_pubkey, blob.sender_pubkey);
        assert_eq!(decoded.nonce, blob.nonce);
        assert_eq!(decoded.ciphertext, blob.ciphertext);
    }
}
