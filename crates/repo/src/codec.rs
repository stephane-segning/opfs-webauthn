//! Per-field AES-GCM AAD construction.
//!
//! Every encrypted column in the `notes` table carries an AAD that
//! binds the ciphertext to:
//!
//! 1. The repo-wide domain separator ([`crate::schema::ROW_AAD`])
//! 2. The field name (`"title"`, `"body"`, …)
//! 3. The row id (Crockford-base32 string)
//!
//! Tampering — swapping fields across rows, replaying an older row
//! at a new id — fails AEAD authentication. The construction must
//! match the JS-side string formatting in
//! `packages/storage/src/row-codec.ts`:
//!
//! ```text
//! `${ROW_AAD}/${field}/${rowId}`
//! ```
//!
//! Byte-identical means cross-side encrypt-on-JS / decrypt-on-Rust
//! (or vice versa) round-trips.

use alloc::vec::Vec;

use crate::schema::ROW_AAD;

/// Build the AES-GCM AAD bytes for the row `row_id` and column
/// `field`.
///
/// `row_id` is the Crockford-encoded string (see [`crate::id`]); we
/// take a `&str` rather than the raw 16 bytes so the encoding is
/// pinned at the call site — the same string the JS-side
/// `row-codec.ts` `aadFor` would have used.
///
/// `field` is the SQL column name **without** the `_nonce` /
/// `_ciphertext` suffix — e.g. pass `"title"` for both
/// `title_nonce` / `title_ciphertext`. The codec consumes the same
/// AAD when it later opens that ciphertext.
#[must_use]
pub fn aad_for(row_id: &str, field: &str) -> Vec<u8> {
    // Compute the exact final length up front. Avoids the four-byte
    // doubling churn of `Vec::push` and matches what the encrypt /
    // decrypt loops want.
    let mut out = Vec::with_capacity(ROW_AAD.len() + 1 + field.len() + 1 + row_id.len());
    out.extend_from_slice(ROW_AAD.as_bytes());
    out.push(b'/');
    out.extend_from_slice(field.as_bytes());
    out.push(b'/');
    out.extend_from_slice(row_id.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aad_matches_js_format() {
        // Reference value: `opfs-webauthn/v1/note-row/title/00000000000000000000000000`
        let row_id = "00000000000000000000000000";
        let aad = aad_for(row_id, "title");
        assert_eq!(
            core::str::from_utf8(&aad).unwrap(),
            "opfs-webauthn/v1/note-row/title/00000000000000000000000000",
        );
    }

    #[test]
    fn aad_differs_per_field() {
        let row_id = "00000000000000000000000000";
        assert_ne!(aad_for(row_id, "title"), aad_for(row_id, "body"));
    }

    #[test]
    fn aad_differs_per_row() {
        let a = aad_for("00000000000000000000000000", "title");
        let b = aad_for("ZZZZZZZZZZZZZZZZZZZZZZZZZW", "title");
        assert_ne!(a, b);
    }

    #[test]
    fn empty_field_and_row_still_distinguish_via_separators() {
        let aad = aad_for("", "");
        assert_eq!(
            core::str::from_utf8(&aad).unwrap(),
            "opfs-webauthn/v1/note-row//",
        );
    }
}
