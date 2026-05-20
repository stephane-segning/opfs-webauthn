//! Library entry for the rendezvous backend (ADR 0012).
//!
//! `main.rs` only knows about env-var parsing + Tokio bootstrap;
//! every interesting unit lives here so the integration tests can
//! reach it without spinning up a socket.

pub mod config;
pub mod cors;
pub mod errors;
pub mod handlers;
pub mod router;
pub mod state;
pub mod store;
pub mod store_memory;

pub use router::build_router;
pub use state::{AppState, Clock, system_clock};
pub use store::{RendezvousRecord, RendezvousStore, SharedStore};
pub use store_memory::MemoryRendezvousStore;
