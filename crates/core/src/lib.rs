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

/// The opened vault. Holds the in-memory DEK; never exposes it to JS.
/// Drop semantics zeroize the DEK.
#[wasm_bindgen]
#[derive(Debug)]
pub struct CryptoVault(core::CryptoVault);

#[wasm_bindgen]
impl CryptoVault {
    /// Enroll: wrap a freshly-generated random DEK with a KEK derived
    /// from the `WebAuthn` PRF output, and return both the wrapped DEK
    /// (to persist) and an unlocked vault ready to encrypt rows.
    ///
    /// `dekBytes` and `wrapNonce` must come from `crypto.getRandomValues`
    /// (32 and 12 bytes respectively).
    ///
    /// `prfOutput` is the PRF result from the `WebAuthn` ceremony.
    /// `prfSalt` is the per-vault salt persisted alongside the
    /// credential id.
    #[wasm_bindgen(js_name = enroll)]
    pub fn enroll(
        dek_bytes: &[u8],
        wrap_nonce: &[u8],
        prf_output: &[u8],
        prf_salt: &[u8],
    ) -> Result<EnrollResult, JsError> {
        core::CryptoVault::enroll(dek_bytes, wrap_nonce, prf_output, prf_salt)
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
