//! BLAKE3-truncation commitment code for the share rendezvous.
//!
//! Construction (per ADR 0007):
//!   1. `digest = BLAKE3(epk)`            full 32-byte hash
//!   2. `bits   = first 60 bits of digest` (most-significant first)
//!   3. `code   = base32(bits)`           12 Crockford-base32 chars
//!
//! Verification re-derives the code from the ephemeral pubkey the
//! sender just fetched and aborts the share if the codes differ.

use alloc::string::String;
use base32::Alphabet;
use thiserror::Error;

/// Number of bits of the BLAKE3 digest committed by the pickup code.
pub const COMMITMENT_BITS: usize = 60;
/// Resulting base32 character count (`COMMITMENT_BITS / 5`).
pub const CODE_LEN: usize = 12;

#[derive(Debug, Error)]
pub enum CommitmentError {
    #[error("code length mismatch: expected {CODE_LEN}, got {0}")]
    BadLength(usize),
    #[error("code does not match the public key commitment")]
    Mismatch,
}

/// Derive the pickup code for a given ephemeral public key.
pub fn code_for_pubkey(epk: &[u8]) -> String {
    // base32 emits ceil(bytes*8/5) chars. For 60 bits we want 12 chars
    // (60/5), so we feed 8 bytes (64 bits) and truncate. The bottom 4
    // bits of byte 7 are zeroed so the truncated 13th char carries no
    // information — taking the first 12 chars is equivalent to a
    // 60-bit Crockford-base32 commitment.
    const BUF_LEN: usize = 8;
    let digest = blake3::hash(epk);
    let mut buf = [0u8; BUF_LEN];
    buf.copy_from_slice(&digest.as_bytes()[..BUF_LEN]);
    buf[BUF_LEN - 1] &= 0xF0;
    let mut encoded = base32::encode(Alphabet::Crockford, &buf);
    encoded.truncate(CODE_LEN);
    encoded
}

/// Constant-time verify that `code` is the commitment of `epk`.
pub fn verify_code(code: &str, epk: &[u8]) -> Result<(), CommitmentError> {
    if code.len() != CODE_LEN {
        return Err(CommitmentError::BadLength(code.len()));
    }
    let expected = code_for_pubkey(epk);
    if crate::key::ct_eq(code.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(CommitmentError::Mismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_12_crockford_chars() {
        let epk = [9u8; 32];
        let code = code_for_pubkey(&epk);
        assert_eq!(code.len(), CODE_LEN);
        for c in code.chars() {
            assert!(
                c.is_ascii_uppercase() || c.is_ascii_digit(),
                "Crockford base32 char outside [0-9A-Z]: {c}"
            );
        }
    }

    #[test]
    fn same_pubkey_yields_same_code() {
        let epk = [1, 2, 3, 4, 5];
        assert_eq!(code_for_pubkey(&epk), code_for_pubkey(&epk));
    }

    #[test]
    fn different_pubkeys_yield_different_codes() {
        let a = code_for_pubkey(&[0u8; 32]);
        let b = code_for_pubkey(&[1u8; 32]);
        assert_ne!(a, b);
    }

    #[test]
    fn verify_accepts_matching_code() {
        let epk = [42u8; 32];
        let code = code_for_pubkey(&epk);
        verify_code(&code, &epk).expect("commitment must verify");
    }

    #[test]
    fn verify_rejects_substituted_pubkey() {
        let original = [42u8; 32];
        let attacker = [43u8; 32];
        let code = code_for_pubkey(&original);
        assert!(matches!(
            verify_code(&code, &attacker),
            Err(CommitmentError::Mismatch)
        ));
    }

    #[test]
    fn verify_rejects_wrong_length() {
        assert!(matches!(
            verify_code("ABC", &[0u8; 32]),
            Err(CommitmentError::BadLength(3))
        ));
    }
}
