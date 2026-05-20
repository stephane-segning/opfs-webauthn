//! Persistence trait for the rendezvous backend.
//!
//! Splits transport from storage so the in-memory impl
//! (single-replica Knative) and any future shared-store impl (Redis,
//! Postgres) plug in behind the same surface.

use std::sync::Arc;

/// The recipient's ephemeral X25519 public key + expiry timestamp.
#[derive(Debug, Clone)]
pub struct RendezvousRecord {
    pub epk: Vec<u8>,
    pub expires_at: u64,
}

/// `Send + Sync` is required because the store is held inside an
/// `Arc` shared across axum's worker tasks.
pub trait RendezvousStore: Send + Sync + std::fmt::Debug {
    /// Insert a fresh rendezvous. Returns `true` if the code was
    /// unused. `false` means the same 12-char code is already taken
    /// inside the TTL window — a real 60-bit pre-image collision;
    /// the caller should ask the client to retry with a fresh epk.
    fn put_rendezvous(&self, code: &str, record: RendezvousRecord, ttl_seconds: u64) -> bool;

    /// Look up a record by code. Returns the record even if expired
    /// so the handler can answer `410 Gone` vs `404 Not Found`.
    fn get_rendezvous(&self, code: &str) -> Option<RendezvousRecord>;

    /// Stage the encrypted blob under `code`. Returns `false` if a
    /// blob is already present — uploads are single-shot per
    /// ADR 0007. The in-memory impl gives us a real atomic
    /// insert-if-absent under a `Mutex`, which the previous KV+R2
    /// pair couldn't.
    fn put_blob(&self, code: &str, blob: Vec<u8>, ttl_seconds: u64) -> bool;

    /// Atomically read-and-delete the blob for `code`. `None` if
    /// missing (or already-picked-up by another recipient).
    fn take_blob(&self, code: &str) -> Option<Vec<u8>>;

    /// Increment the per-IP mint counter inside the current TTL
    /// window. Returns the post-increment count so the handler can
    /// throttle.
    fn increment_mint_counter(&self, ip: &str, ttl_seconds: u64) -> u32;
}

pub type SharedStore = Arc<dyn RendezvousStore>;
