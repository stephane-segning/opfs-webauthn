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

use std::collections::HashMap;
use std::time::Duration;

use parking_lot::Mutex;

use crate::store::{RendezvousRecord, RendezvousStore};

/// Bound the per-call sweep so a pathological cache (lots of dead
/// keys) doesn't tie up the lock. 5 min × 10 calls/sec is well under
/// this anyway.
const MAX_SWEEP_PER_CALL: usize = 256;

#[derive(Debug)]
struct StoredRecord {
    epk: Vec<u8>,
    expires_at: u64,
    /// Wall-clock deadline for sweep eviction. Independent of
    /// `expires_at` (which is what the handler hands to clients) so
    /// tests can inject a custom clock without affecting eviction.
    sweep_deadline: std::time::Instant,
}

#[derive(Debug)]
struct StoredBlob {
    bytes: Vec<u8>,
    sweep_deadline: std::time::Instant,
}

#[derive(Debug)]
struct Counter {
    count: u32,
    sweep_deadline: std::time::Instant,
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

    fn sweep(inner: &mut Inner) {
        let now = std::time::Instant::now();
        let mut budget = MAX_SWEEP_PER_CALL;
        inner.records.retain(|_, r| {
            if budget == 0 {
                return true;
            }
            budget -= 1;
            r.sweep_deadline > now
        });
        budget = MAX_SWEEP_PER_CALL;
        inner.blobs.retain(|_, b| {
            if budget == 0 {
                return true;
            }
            budget -= 1;
            b.sweep_deadline > now
        });
        budget = MAX_SWEEP_PER_CALL;
        inner.counters.retain(|_, c| {
            if budget == 0 {
                return true;
            }
            budget -= 1;
            c.sweep_deadline > now
        });
    }
}

fn sweep_deadline(ttl_seconds: u64) -> std::time::Instant {
    std::time::Instant::now() + Duration::from_secs(ttl_seconds)
}

impl RendezvousStore for MemoryRendezvousStore {
    fn put_rendezvous(&self, code: &str, record: RendezvousRecord, ttl_seconds: u64) -> bool {
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
                sweep_deadline: sweep_deadline(ttl_seconds),
            },
        );
        true
    }

    fn get_rendezvous(&self, code: &str) -> Option<RendezvousRecord> {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        inner.records.get(code).map(|r| RendezvousRecord {
            epk: r.epk.clone(),
            expires_at: r.expires_at,
        })
    }

    fn put_blob(&self, code: &str, blob: Vec<u8>, ttl_seconds: u64) -> bool {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        if inner.blobs.contains_key(code) {
            return false;
        }
        inner.blobs.insert(
            code.to_owned(),
            StoredBlob {
                bytes: blob,
                sweep_deadline: sweep_deadline(ttl_seconds),
            },
        );
        true
    }

    fn take_blob(&self, code: &str) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        inner.blobs.remove(code).map(|b| b.bytes)
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "the guard has to be held for the whole CAS-style sweep+entry"
    )]
    fn increment_mint_counter(&self, ip: &str, ttl_seconds: u64) -> u32 {
        let mut inner = self.inner.lock();
        Self::sweep(&mut inner);
        let deadline = sweep_deadline(ttl_seconds);
        let entry = inner
            .counters
            .entry(ip.to_owned())
            .or_insert_with(|| Counter {
                count: 0,
                sweep_deadline: deadline,
            });
        entry.count = entry.count.saturating_add(1);
        // Rolling window: each hit extends the deadline. Cheap and
        // matches the "best-effort defense" posture (ADR 0011).
        entry.sweep_deadline = deadline;
        entry.count
    }
}
