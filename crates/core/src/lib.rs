//! wasm-bindgen surface for `opfs-webauthn`.
//!
//! This crate is the only thing the JS side imports from Rust. It
//! exposes a small, audited surface over the underlying crates so the
//! JS bridge has exactly one place to evolve.
//!
//! All actual logic lives in the private `core` module so it can be
//! unit-tested with `cargo test` (the `#[wasm_bindgen]` wrappers
//! cannot be invoked outside a wasm runtime).
//!
//! Built into a JS + .wasm bundle via:
//!
//! ```sh
//! wasm-pack build crates/core \
//!   --target web \
//!   --out-dir ../../packages/core-wasm/dist \
//!   --out-name opfs_core
//! ```

extern crate alloc;

// `pub` items inside `mod core` are reachable from the rest of the
// crate but not from outside. `pub(crate)` would lint as
// `redundant_pub_crate` (the mod is already private); `pub` lints as
// `unreachable_pub` from outside the crate. We pick `pub` + allow the
// outside-the-crate unreachability, since the items are very much
// reachable inside the crate, which is what matters for testing.
#[allow(unreachable_pub)]
mod core;

use alloc::vec::Vec;
use opfs_crypto::{KEY_LEN, NONCE_LEN, TAG_LEN, commitment};
use wasm_bindgen::prelude::*;

pub use opfs_crypto;
pub use opfs_repo;
pub use opfs_share_protocol;

/// Length in bytes of the data-encryption key (DEK). Always 32.
#[wasm_bindgen(js_name = dekLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 32; wasm-bindgen rejects const fn"
)]
pub fn dek_len() -> u32 {
    KEY_LEN as u32
}

/// Length in bytes of the AES-GCM nonce that wraps the DEK (and is also
/// the per-row nonce length). Always 12.
#[wasm_bindgen(js_name = aesGcmNonceLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 12; wasm-bindgen rejects const fn"
)]
pub fn aes_gcm_nonce_len() -> u32 {
    NONCE_LEN as u32
}

/// Length in bytes of the AES-GCM authentication tag (suffix on every
/// ciphertext we produce). Always 16.
#[wasm_bindgen(js_name = aesGcmTagLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 16; wasm-bindgen rejects const fn"
)]
pub fn aes_gcm_tag_len() -> u32 {
    TAG_LEN as u32
}

/// Protocol version (mirrors `opfs_share_protocol::PROTOCOL_VERSION`).
#[wasm_bindgen(js_name = protocolVersion)]
#[must_use]
#[allow(
    clippy::missing_const_for_fn,
    reason = "wasm-bindgen does not support const fn in the public surface"
)]
pub fn protocol_version() -> u8 {
    opfs_share_protocol::PROTOCOL_VERSION
}

/// Length in bytes of an X25519 public key (always 32).
#[wasm_bindgen(js_name = x25519PubkeyLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 32; wasm-bindgen rejects const fn"
)]
pub fn x25519_pubkey_len() -> u32 {
    opfs_share_protocol::X25519_PUBKEY_LEN as u32
}

/// Length of the rendezvous pickup code in Crockford-base32 characters.
#[wasm_bindgen(js_name = commitmentCodeLen)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 12; wasm-bindgen rejects const fn"
)]
pub fn commitment_code_len() -> u32 {
    commitment::CODE_LEN as u32
}

/// Derive the rendezvous pickup code for a recipient's ephemeral X25519
/// public key. Returns 12 Crockford-base32 characters (60 bits of
/// entropy bound to the key) — see ADR 0007.
///
/// Returns an empty string if `epk` is not exactly 32 bytes: the
/// protocol commits to an X25519 public key and arbitrary-length
/// inputs would silently produce mismatching codes downstream.
#[wasm_bindgen(js_name = codeForPubkey)]
#[must_use]
pub fn code_for_pubkey(epk: &[u8]) -> String {
    if epk.len() != opfs_share_protocol::X25519_PUBKEY_LEN {
        return String::new();
    }
    commitment::code_for_pubkey(epk)
}

/// Verify a pickup code matches a fetched ephemeral pubkey.
///
/// Returns `true` on match, `false` on mismatch or wrong code / key
/// length — callers can branch without try/catch. The implementation
/// is constant-time inside the matched-length case.
#[wasm_bindgen(js_name = verifyCode)]
#[must_use]
pub fn verify_code(code: &str, epk: &[u8]) -> bool {
    // Short-circuit on either bad length so we never hash a wrong-sized
    // key just to reject it; `commitment::verify_code` would catch the
    // code-length case anyway, but failing fast here is friendlier.
    if epk.len() != opfs_share_protocol::X25519_PUBKEY_LEN || code.len() != commitment::CODE_LEN {
        return false;
    }
    commitment::verify_code(code, epk).is_ok()
}

// ---------------------------------------------------------------
// `opfs-repo` re-exports.
//
// The Rust crate `opfs-repo` is the canonical source for the SQL
// schema, the per-field AEAD AAD construction, and the row-id
// Crockford-base32 codec. These wasm-bindgen wrappers expose them
// to `@opfs/storage` so the JS side stops re-declaring the same
// constants and codec in TypeScript.
// ---------------------------------------------------------------

/// Canonical schema SQL — the `notes` + `schema_meta` DDL and the
/// `idx_notes_recent` partial index. The JS-side worker hands this
/// verbatim to `sqlite-wasm`'s `db.exec` on cold start.
#[wasm_bindgen(js_name = schemaSql)]
#[must_use]
pub fn schema_sql() -> String {
    opfs_repo::SCHEMA_SQL.to_owned()
}

/// Current schema version recorded in `schema_meta.version`. Bumped
/// whenever a new forward-migration lands.
#[wasm_bindgen(js_name = schemaVersion)]
#[must_use]
#[allow(
    clippy::missing_const_for_fn,
    reason = "wasm-bindgen does not accept const fn"
)]
pub fn schema_version() -> u32 {
    opfs_repo::SCHEMA_VERSION
}

/// The domain-separator prefix every per-field AAD starts with.
/// Exposed so JS callers can recognise / validate AAD bytes without
/// hard-coding the string.
#[wasm_bindgen(js_name = rowAad)]
#[must_use]
pub fn row_aad() -> String {
    opfs_repo::ROW_AAD.to_owned()
}

/// Build the AES-GCM AAD bytes for a given row + field, matching
/// `aad_for` in the `opfs-repo` crate. Format is
/// `{ROW_AAD}/{field}/{row_id}`; see the crate docs for invariants.
#[wasm_bindgen(js_name = aadFor)]
#[must_use]
pub fn aad_for(row_id: &str, field: &str) -> Vec<u8> {
    opfs_repo::aad_for(row_id, field)
}

/// Encode 16 bytes as a 26-character Crockford-base32 row id.
/// Throws on the wrong input length (caller's bug — the row-id
/// length is a fixed contract).
#[wasm_bindgen(js_name = encodeRowId)]
pub fn encode_row_id(bytes: &[u8]) -> Result<String, JsError> {
    // `opfs_repo::Error` is `thiserror`-derived → `Display`, but
    // doesn't implement the local `core::DisplayError` trait that
    // `into_js_error` requires. Inline the `.to_string()` here to
    // bridge the two error worlds without widening the local trait.
    opfs_repo::encode_row_id(bytes).map_err(|e| JsError::new(&alloc::string::ToString::to_string(&e)))
}

/// Decode a 26-character Crockford-base32 row id back into its
/// 16-byte form. Throws on the wrong length or any non-Crockford
/// character (including non-ASCII look-alikes — see the codec
/// docs).
#[wasm_bindgen(js_name = decodeRowId)]
pub fn decode_row_id(id: &str) -> Result<Vec<u8>, JsError> {
    opfs_repo::decode_row_id(id).map_err(|e| JsError::new(&alloc::string::ToString::to_string(&e)))
}

/// Length in bytes of a row id at rest (always 16).
#[wasm_bindgen(js_name = rowIdBytes)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 16; wasm-bindgen rejects const fn"
)]
pub fn row_id_bytes() -> u32 {
    opfs_repo::ROW_ID_BYTES as u32
}

/// Length in characters of a Crockford-encoded row id (always 26).
#[wasm_bindgen(js_name = rowIdChars)]
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn,
    reason = "compile-time constant is 26; wasm-bindgen rejects const fn"
)]
pub fn row_id_chars() -> u32 {
    opfs_repo::ROW_ID_CHARS as u32
}

/// The opened vault. Holds the in-memory DEK; never exposes it to JS.
/// Drop semantics zeroize the DEK.
#[wasm_bindgen]
#[derive(Debug)]
pub struct CryptoVault(core::CryptoVault);

#[wasm_bindgen]
impl CryptoVault {
    /// Enroll: generate a fresh random DEK inside wasm, wrap it with a
    /// KEK derived from the `WebAuthn` PRF output, and return both the
    /// wrapped DEK (to persist) and an unlocked vault ready to
    /// encrypt rows.
    ///
    /// The DEK and wrap nonce are generated via `getrandom` (which
    /// the "js" feature wires to `crypto.getRandomValues` in the
    /// browser), so the raw key bytes never appear in JS — see
    /// ADR 0005.
    ///
    /// `prfOutput` is the PRF result from the `WebAuthn` ceremony.
    /// `prfSalt` is the per-vault salt persisted alongside the
    /// credential id.
    #[wasm_bindgen(js_name = enroll)]
    pub fn enroll(prf_output: &[u8], prf_salt: &[u8]) -> Result<EnrollResult, JsError> {
        core::CryptoVault::enroll(prf_output, prf_salt)
            .map(EnrollResult::from)
            .map_err(into_js_error)
    }

    /// Unlock: derive the KEK from `prfOutput` and unwrap the
    /// persisted DEK to instantiate a vault. Throws on authentication
    /// failure (wrong PRF output, tampered ciphertext).
    #[wasm_bindgen(js_name = unlock)]
    pub fn unlock(
        prf_output: &[u8],
        prf_salt: &[u8],
        wrapped_dek: &[u8],
        wrap_nonce: &[u8],
    ) -> Result<Self, JsError> {
        core::CryptoVault::unlock(prf_output, prf_salt, wrapped_dek, wrap_nonce)
            .map(Self)
            .map_err(into_js_error)
    }

    /// Encrypt `plaintext` under the vault DEK with the caller-supplied
    /// fresh nonce. The 16-byte GCM tag is appended to the returned
    /// ciphertext.
    #[wasm_bindgen]
    pub fn encrypt(&self, nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.encrypt(nonce, aad, plaintext).map_err(into_js_error)
    }

    /// Decrypt `ciphertext` (which must include the trailing 16-byte
    /// GCM tag) under the vault DEK.
    #[wasm_bindgen]
    pub fn decrypt(&self, nonce: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0
            .decrypt(nonce, aad, ciphertext)
            .map_err(into_js_error)
    }
}

/// Result of `CryptoVault.enroll`. Holds the wrapped DEK + wrap nonce
/// for the caller to persist, plus the freshly-opened `CryptoVault`
/// which is moved out via `takeVault()`.
#[wasm_bindgen]
#[derive(Debug)]
pub struct EnrollResult(core::EnrollResult);

impl From<core::EnrollResult> for EnrollResult {
    fn from(value: core::EnrollResult) -> Self {
        Self(value)
    }
}

#[wasm_bindgen]
impl EnrollResult {
    /// AES-GCM ciphertext of the DEK (including the 16-byte tag).
    /// Persist this alongside the credential id and the PRF salt.
    #[wasm_bindgen(getter, js_name = wrappedDek)]
    #[must_use]
    pub fn wrapped_dek(&self) -> Vec<u8> {
        self.0.wrapped_dek.clone()
    }

    /// AES-GCM nonce used when wrapping the DEK. Persist alongside the
    /// wrapped DEK so `unlock` can find it.
    #[wasm_bindgen(getter, js_name = wrapNonce)]
    #[must_use]
    pub fn wrap_nonce(&self) -> Vec<u8> {
        self.0.wrap_nonce.clone()
    }

    /// Take ownership of the unlocked vault. Can only be called once;
    /// throws on the second call so a programming error is loud.
    #[wasm_bindgen(js_name = takeVault)]
    pub fn take_vault(&mut self) -> Result<CryptoVault, JsError> {
        self.0
            .take_vault()
            .map(CryptoVault)
            .ok_or_else(|| JsError::new("EnrollResult.takeVault called twice"))
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "by-value matches the .map_err function-pointer coercion"
)]
fn into_js_error<E: core::DisplayError>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

// ---------------------------------------------------------------
// Share flow (ADR 0007). Recipient mints a `RecipientHandle` and
// publishes `.pubkey`; sender calls `sealShare(recipient_pk, blob)`;
// recipient calls `handle.openShare(sender_pk, nonce, ciphertext)`.
// ---------------------------------------------------------------

/// Recipient-side keypair handle. Holds the X25519 secret in wasm
/// memory; JS only ever sees the matching public key and the opaque
/// handle. Dropping it from JS frees the secret bytes.
#[wasm_bindgen]
#[derive(Debug)]
pub struct RecipientHandle(core::RecipientHandle);

#[wasm_bindgen]
impl RecipientHandle {
    /// Mint a fresh recipient keypair. The matching public key is
    /// the value to publish via `POST /rendezvous`. Throws if the
    /// platform entropy source is unavailable — JS sees a recoverable
    /// error rather than a wasm panic.
    #[wasm_bindgen(js_name = prepare)]
    pub fn prepare() -> Result<Self, JsError> {
        core::RecipientHandle::prepare()
            .map(Self)
            .map_err(into_js_error)
    }

    /// The X25519 public key as raw 32 bytes — what the rendezvous
    /// backend stores and the sender fetches.
    #[wasm_bindgen(getter, js_name = pubkey)]
    #[must_use]
    pub fn pubkey(&self) -> Vec<u8> {
        self.0.pubkey().to_vec()
    }

    /// Decrypt a sealed share addressed to this recipient. Throws if
    /// the inputs are malformed or the tag does not verify (the
    /// most likely cause is a substituted sender pubkey or a
    /// recipient/sender mix-up).
    #[wasm_bindgen(js_name = openShare)]
    pub fn open_share(
        &self,
        sender_pubkey: &[u8],
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        self.0
            .open(sender_pubkey, nonce, ciphertext)
            .map_err(into_js_error)
    }
}

/// JS-visible result of `sealShare`. Opaque to keep the struct
/// shape stable across protocol revisions; readers go through the
/// typed getters.
#[wasm_bindgen]
#[derive(Debug)]
pub struct SealedShare(opfs_crypto::SealedShare);

#[wasm_bindgen]
impl SealedShare {
    /// Sender's ephemeral X25519 public key. Goes into the
    /// `ShareBlob` envelope verbatim.
    #[wasm_bindgen(getter, js_name = senderPubkey)]
    #[must_use]
    pub fn sender_pubkey(&self) -> Vec<u8> {
        self.0.sender_pubkey.to_vec()
    }

    /// AES-GCM nonce.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.0.nonce.to_vec()
    }

    /// AES-256-GCM ciphertext (including the 16-byte tag suffix).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.0.ciphertext.clone()
    }
}

/// Seal `plaintext` for the recipient identified by `recipientPubkey`.
///
/// The sender's ephemeral X25519 secret is generated inside wasm and
/// dropped (zeroized) before this function returns; JS only ever sees
/// the public-key + ciphertext output.
#[wasm_bindgen(js_name = sealShare)]
pub fn seal_share(recipient_pubkey: &[u8], plaintext: &[u8]) -> Result<SealedShare, JsError> {
    core::seal_share(recipient_pubkey, plaintext)
        .map(SealedShare)
        .map_err(into_js_error)
}
