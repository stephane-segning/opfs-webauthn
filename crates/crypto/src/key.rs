//! Symmetric key wrapper that zeroizes on drop.

use crate::KEY_LEN;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("invalid key length: expected {KEY_LEN}, got {0}")]
    BadLength(usize),
}

/// A 256-bit symmetric key. Zeroized on drop.
#[derive(Clone, ZeroizeOnDrop)]
pub struct Key([u8; KEY_LEN]);

impl Key {
    /// Build a `Key` from raw bytes.
    pub const fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Build a `Key` from a slice, validating length.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, KeyError> {
        let arr: [u8; KEY_LEN] = bytes
            .try_into()
            .map_err(|_| KeyError::BadLength(bytes.len()))?;
        Ok(Self(arr))
    }

    /// Generate a new random key using the supplied RNG.
    pub fn random(rng: &mut impl rand_core::RngCore) -> Self {
        let mut bytes = [0u8; KEY_LEN];
        rng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// Borrow the raw bytes. Prefer `expose()` to make intent explicit.
    pub const fn expose(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// Move the raw bytes out and consume the key. The caller is
    /// responsible for zeroizing the returned buffer once it is no
    /// longer needed.
    pub fn into_bytes(mut self) -> [u8; KEY_LEN] {
        let mut out = [0u8; KEY_LEN];
        out.copy_from_slice(&self.0);
        self.0.zeroize();
        out
    }
}

impl core::fmt::Debug for Key {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Key(<redacted>)")
    }
}

/// Constant-time equality comparison for two byte slices of equal length.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.ct_eq(b).into()
}

/// Wipe a buffer in place.
pub fn wipe(buf: &mut [u8]) {
    buf.zeroize();
}

/// Convenience: produce an owned, zeroizing `Vec<u8>` that wipes on drop.
#[derive(Clone)]
pub struct ZeroizingVec(Vec<u8>);

impl ZeroizingVec {
    pub const fn new(v: Vec<u8>) -> Self {
        Self(v)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for ZeroizingVec {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl core::fmt::Debug for ZeroizingVec {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ZeroizingVec(<redacted>)")
    }
}
