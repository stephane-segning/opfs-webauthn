//! Tunable constants for the rendezvous backend.
//!
//! Mirrors the TS Worker's `config.ts` so behaviour matches the
//! existing tests, and the same trade-offs (5-min TTL, 64 KiB blob
//! cap, 10 mints / IP) are reviewable in one file.

/// Default rendezvous lifetime in seconds. 5 minutes per ADR 0007.
pub const RENDEZVOUS_TTL_SECONDS: u64 = 300;

/// Hard cap on the encrypted `ShareBlob` bytes. A single note is a
/// few KiB at most; 64 KiB is generous and bounds memory pressure
/// on the server.
pub const MAX_BLOB_BYTES: usize = 64 * 1024;

/// Per-IP mint cap inside one TTL window. Generous enough for
/// legitimate retries, tight enough that a single host cannot
/// brute-force the 60-bit commitment space.
pub const MINT_RATE_LIMIT: u32 = 10;
