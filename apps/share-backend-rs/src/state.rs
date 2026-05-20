//! Per-process app state shared into every handler via
//! `axum::extract::State`. Holds the storage handle, the CORS allow
//! list, and an injectable clock so tests can roll time forward
//! without sleeping.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::store::SharedStore;

/// Unix-seconds clock. Tests pass a deterministic counter instead.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    })
}

#[derive(Clone)]
pub struct AppState {
    pub store: SharedStore,
    pub allowed_origins: Arc<Vec<String>>,
    pub now: Clock,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("store", &self.store)
            .field("allowed_origins", &self.allowed_origins)
            .field("now", &"<fn>")
            .finish()
    }
}

impl AppState {
    pub fn new(store: SharedStore, allowed_origins: Vec<String>) -> Self {
        Self {
            store,
            allowed_origins: Arc::new(allowed_origins),
            now: system_clock(),
        }
    }

    /// Test constructor — inject a deterministic clock.
    pub fn with_clock(store: SharedStore, allowed_origins: Vec<String>, now: Clock) -> Self {
        Self {
            store,
            allowed_origins: Arc::new(allowed_origins),
            now,
        }
    }
}
