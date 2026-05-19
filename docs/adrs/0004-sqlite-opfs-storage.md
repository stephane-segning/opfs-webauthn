# ADR 0004 — SQLite + OPFS storage

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We need durable, queryable, offline-first storage for notes. Options
considered: IndexedDB directly, IndexedDB through Dexie, OPFS with a
hand-rolled file format, SQLite-WASM with the `opfs` VFS, SQLite-WASM
with the `opfs-sahpool` VFS, and absurd-sql.

Constraints:
- Full-text search over decrypted note bodies.
- Synchronous-feeling API for the UI (read a note, render it).
- Survives page reloads, tab kills, browser updates.
- Works on iOS Safari, Android Chrome, desktop Chrome/Firefox/Safari.

## Decision

Use the official **`sqlite-wasm`** build with the **`opfs-sahpool`** VFS.

- `opfs-sahpool` uses synchronous access handles, which sqlite-wasm needs
  to behave like real SQLite. It must run inside a Worker (the sync
  handle API is worker-only).
- A single dedicated Worker owns the SQLite handle and is the sole
  writer. The page communicates via `postMessage` (wrapped in a
  request/response RPC helper).
- The schema is owned by `crates/repo` (see ADR 0003). The worker calls
  `core_wasm.current_schema_sql()` on boot and runs migrations before
  accepting requests.
- Note bodies and titles are stored as `BLOB` ciphertext + `BLOB` nonce.
  Indexed columns (id, created_at, updated_at, archived) are plaintext.
- Full-text search is implemented over a transient in-memory index
  rebuilt from the decrypted set on load. We do not store an FTS5 index
  of plaintext on disk.

## Consequences

- iOS Safari supports OPFS sync access handles in dedicated workers, so
  the storage layer works on every target browser we care about.
- "One writer" means we get strong write ordering and avoid the OPFS
  cross-tab lock failure modes. Reads from other tabs go through the same
  worker via `SharedWorker` (preferred) or via a leader-election scheme
  (see ADR 0006).
- We trade on-disk FTS for simplicity and confidentiality. Rebuilding the
  search index in memory is O(notes); we accept this until the corpus
  exceeds a few thousand notes.
- Migrations are linear and owned by Rust. The schema version is stored
  in a `meta` table.

## Alternatives considered

- **IndexedDB / Dexie**: works everywhere but the query story is poor
  and we would re-invent half of SQLite to get joined / sorted reads.
- **`opfs` VFS (non-sahpool)**: more flexible filesystem layout but
  slower and historically less stable.
- **absurd-sql**: superseded by the official sqlite-wasm OPFS support;
  no reason to take on a third-party VFS.
- **Hand-rolled OPFS file format**: too much code to write and audit for
  what amounts to a worse SQLite.
