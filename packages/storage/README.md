# @opfs/storage

OPFS-backed SQLite, single-writer dedicated/shared worker, leader
election fallback (for browsers without `SharedWorker`), and a typed
RPC client. The public surface is a `Repo` interface plus a
subscribe-only event stream for `tx-applied` and `vault-locked`.

See [ADR 0004](../../docs/adrs/0004-sqlite-opfs-storage.md) and
[ADR 0006](../../docs/adrs/0006-multi-tab-sync.md).

## Status

Stub. `src/index.ts` declares the eventual API shape (`Note`, `Repo`,
`StorageEvent`, `CreateRepo`). The worker, schema, and RPC layer land
in the storage-implementation PR.

## Reuse

Designed to be lifted into other apps that need OPFS-backed SQLite
with multi-tab safety. The `Repo` interface is generic enough; the
schema lives in [`opfs-repo`](../../crates/repo) (Rust) and is the
only thing a consumer changes.
