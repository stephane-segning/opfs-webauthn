//! In-memory `RendezvousStore`.
//!
//! The default impl Knative ships with when `containerConcurrency:
//! 1`-style scaling keeps the service to a single replica. Records
//! are short-lived (5 min TTL) so the whole store stays small;
//! everything is wrapped in a single `parking_lot::Mutex` for
//! simplicity — handlers are I/O-bound on the network, the
//! lock-hold time is microseconds.
//!
//! Multi-replica deployments would swap this for a Redis or
//! Postgres impl behind the same `RendezvousStore` trait. The
//! contract is identical.
//!
//! Sweep policy (after codex's review on PR #26):
//!   - Eviction runs only on **writes** (`put_rendezvous`,
//!     `put_blob`, `increment_mint_counter`). Reads never sweep,
//!     so an expired-but-not-yet-evicted rendezvous remains visible
//!     to `get_rendezvous` — the handler then answers `410 Gone`
//!     instead of `404 Not Found`, preserving the documented API
//!     distinction.
//!   - Expiry on `take_blob` is checked against the handler's
//!     injectable clock, not the wall clock the sweep uses. The
//!     sweep is just memory hygiene; correctness of the response
//!     status doesn't depend on it firing in time.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use crate::store::{RendezvousRecord, RendezvousStore};

#[derive(Debug)]
struct StoredRecord {
    epk: Vec<u8>,
    expires_at: u64,
}

#[derive(Debug)]
struct StoredBlob {
    bytes: Vec<u8>,
    expires_at: u64,
}

#[derive(Debug)]
struct Counter {
    count: u32,
    expires_at: u64,
}

trait Expirable {
    fn expires_at(&self) -> u64;
}

impl Expirable for StoredRecord {
    fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

impl Expirable for StoredBlob {
    fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

impl Expirable for Counter {
    fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

#[derive(Debug, Default)]
struct Inner {
    records: HashMap<String, StoredRecord>,
    blobs: HashMap<String, StoredBlob>,
    counters: HashMap<String, Counter>,
}

#[derive(Debug, Default)]
pub struct MemoryRendezvousStore {
    inner: Mutex<Inner>,
}

impl MemoryRendezvousStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wall-clock unix seconds used by the sweep. Independent of
    /// the handler's injectable clock — sweep is best-effort
    /// memory hygiene, not a correctness boundary.
    fn wall_now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }

    /// Evict every entry whose `expires_at` is in the past.
    /// Unbudgeted — the maps are bounded by traffic × 5-min TTL
    /// and stay small under the single-replica deploy this impl
    /// targets. A pathological cache would have other problems
    /// (memory) that would surface before sweep cost did.
    fn sweep(inner: &mut Inner) {
        let now = Self::wall_now();
        retain_unexpired(&mut inner.records, now);
        retain_unexpired(&mut inner.blobs, now);
        retain_unexpired(&mut inner.counters, now);
    }
}

fn retain_unexpired<V: Expirable>(map: &mut HashMap<String, V>, now: u64) {
    map.retain(|_, v| v.expires_at() > now);
}

impl RendezvousStore for MemoryRendezvousStore {
    fn put_rendezvous(&self, code: &str, record: RendezvousRecord) -> bool {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        if inner.records.contains_key(code) {
            return false;
        }
        inner.records.insert(
            code.to_owned(),
            StoredRecord {
                epk: record.epk,
                expires_at: record.expires_at,
            },
        );
        true
    }

    fn get_rendezvous(&self, code: &str) -> Option<RendezvousRecord> {
        // Deliberately no sweep here — see the module-level comment:
        // we want expired-but-still-present records to be visible
        // so the handler answers `410 Gone`.
        let inner = self.inner.lock();
        inner.records.get(code).map(|r| RendezvousRecord {
            epk: r.epk.clone(),
            expires_at: r.expires_at,
        })
    }

    fn put_blob(&self, code: &str, blob: Vec<u8>, expires_at: u64) -> bool {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        if inner.blobs.contains_key(code) {
            return false;
        }
        inner.blobs.insert(
            code.to_owned(),
            StoredBlob {
                bytes: blob,
                expires_at,
            },
        );
        true
    }

    fn take_blob(&self, code: &str, now: u64) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock();
        // Reject expired blobs explicitly. The sweep is best-effort,
        // so a stale blob can survive past `expires_at` until the
        // next write; we don't want to serve it.
        let expired = inner.blobs.get(code).is_some_and(|b| b.expires_at <= now);
        if expired {
            inner.blobs.remove(code);
            return None;
        }
        inner.blobs.remove(code).map(|b| b.bytes)
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "the guard has to be held for the whole sweep+entry CAS"
    )]
    fn increment_mint_counter(&self, ip: &str, ttl_seconds: u64) -> u32 {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        let expires_at = Self::wall_now().saturating_add(ttl_seconds);
        let entry = inner
            .counters
            .entry(ip.to_owned())
            .or_insert_with(|| Counter {
                count: 0,
                expires_at,
            });
        entry.count = entry.count.saturating_add(1);
        // Rolling window: each hit extends the deadline. Cheap and
        // matches the best-effort defense posture (ADR 0011).
        entry.expires_at = expires_at;
        entry.count
    }
}
