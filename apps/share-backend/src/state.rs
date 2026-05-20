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
    /// Lowercase HTTP header name the proxy uses to communicate the
    /// real client IP (e.g. `x-real-ip` behind nginx-ingress,
    /// `cf-connecting-ip` behind Cloudflare). When `None` the rate
    /// limiter degrades to a global "unknown" bucket — best-effort,
    /// per ADR 0011. **Never** read `X-Forwarded-For` directly:
    /// codex's review on PR #26 caught that taking the first hop is
    /// client-controllable and trivially spoofs the rate limit.
    pub trusted_ip_header: Arc<Option<String>>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("store", &self.store)
            .field("allowed_origins", &self.allowed_origins)
            .field("now", &"<fn>")
            .field("trusted_ip_header", &self.trusted_ip_header)
            .finish()
    }
}

impl AppState {
    pub fn new(
        store: SharedStore,
        allowed_origins: Vec<String>,
        trusted_ip_header: Option<String>,
    ) -> Self {
        Self {
            store,
            allowed_origins: Arc::new(allowed_origins),
            now: system_clock(),
            trusted_ip_header: Arc::new(trusted_ip_header.map(|h| h.to_ascii_lowercase())),
        }
    }

    /// Test constructor — inject a deterministic clock and an
    /// explicit trusted-header name so the rate-limit test can hand
    /// each synthetic client a distinct IP.
    pub fn with_clock(
        store: SharedStore,
        allowed_origins: Vec<String>,
        now: Clock,
        trusted_ip_header: Option<String>,
    ) -> Self {
        Self {
            store,
            allowed_origins: Arc::new(allowed_origins),
            now,
            trusted_ip_header: Arc::new(trusted_ip_header.map(|h| h.to_ascii_lowercase())),
        }
    }
}
