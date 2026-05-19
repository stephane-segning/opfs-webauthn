//! Crypto primitives for `opfs-webauthn`.
//!
//! See `docs/adrs/0005-webauthn-prf-key-derivation.md` for the key
//! hierarchy and `docs/adrs/0007-deployment-and-sharing-backend.md`
//! for the commitment-code construction. This crate is intentionally
//! small and side-effect free so it can be lifted into other projects.

#![no_std]

extern crate alloc;

pub mod aead;
pub mod commitment;
pub mod hkdf;
pub mod key;
pub mod share;

pub use aead::{Aead, AeadError, NONCE_LEN, TAG_LEN};
pub use commitment::{CommitmentError, code_for_pubkey, verify_code};
pub use hkdf::{HkdfError, derive_kek};
pub use key::{Key, KeyError};
pub use share::{
    RecipientSecret, SealedShare, ShareError, X25519_PUBKEY_LEN, X25519_SECRET_LEN,
    open as share_open, seal as share_seal,
};

/// Length in bytes of the symmetric keys used everywhere in this crate.
pub const KEY_LEN: usize = 32;
