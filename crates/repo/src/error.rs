//! Typed errors for the row id codec.
//!
//! `thiserror` is workspace-defaulted to `no_std`, so this carries
//! the same surface in the wasm build as on a native host.

use thiserror::Error;

/// Errors returned by the [`crate::id`] codec.
#[derive(Debug, PartialEq, Eq, Error)]
pub enum Error {
    /// The byte slice handed to [`crate::id::encode`] or the string
    /// handed to [`crate::id::decode`] wasn't the expected length.
    ///
    /// For `encode`, `expected` is [`crate::id::ROW_ID_BYTES`] (16);
    /// for `decode`, it's [`crate::id::ROW_ID_CHARS`] (26).
    #[error("row id must be {expected} units, got {got}")]
    WrongRowIdLength {
        /// Expected length (bytes for encode, chars for decode).
        expected: usize,
        /// Length we actually got.
        got: usize,
    },

    /// A character in the [`crate::id::decode`] input isn't a
    /// Crockford-base32 digit (case-insensitive).
    #[error("row id contains non-Crockford character {ch:?}")]
    InvalidRowIdChar {
        /// The offending character.
        ch: char,
    },
}
