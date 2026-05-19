# ADR 0006 — Multi-tab sync

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

A user may open the app in two tabs of the same browser, or in a PWA
window plus a tab. Both instances see the same OPFS directory. OPFS sync
access handles are exclusive: if tab A holds them, tab B's open fails.
We must:

- Never corrupt the SQLite DB.
- Let any tab read and write.
- Propagate writes from one tab to the other within a perceptible
  threshold (~500ms).

## Decision

A single **SharedWorker** owns the sqlite-wasm instance and its OPFS
handles. Every page (every tab, every PWA window) connects to that
SharedWorker and talks to it via a typed RPC over the dedicated
`MessagePort` returned by `SharedWorker.port`.

- The SharedWorker is the **sole writer**. Tabs send queries; the worker
  runs them and replies.
- Reads also go through the worker so we get a single coherent view and
  one cache.
- After every successful write, the worker broadcasts a `tx-applied`
  message containing the affected entity IDs over a `BroadcastChannel`.
  Tabs subscribe and refresh their Zustand store's affected slices.
- On every read, the page passes a small cache hint (`since` token) so
  the worker can answer "nothing changed for you" cheaply.
- **Transport rule.** `BroadcastChannel` is reserved for *fan-out
  notifications* (`tx-applied`, `vault-locked`, `leader-elected`).
  Request/response RPC always rides a private `MessagePort` so requests
  do not have to be filtered out by every listening tab and we get
  native back-pressure per channel.

### Fallback: no SharedWorker

iOS Safari historically does not implement SharedWorker. On platforms
where `SharedWorker` is unavailable we fall back to a **leader-election**
pattern using the Web Locks API:

- Each tab attempts to take a named lock (`opfs-db-writer`).
- The tab that holds the lock becomes the leader and spawns a dedicated
  Worker that owns sqlite-wasm.
- The leader announces itself on a `BroadcastChannel` (`leader-elected`,
  with a per-leader UUID). Non-leader tabs respond with a `pair-request`
  carrying one end of a freshly created `MessageChannel`; the leader
  keeps the matching port and answers RPC over that private channel.
  **BroadcastChannel is only used for discovery + fan-out**, never for
  RPC payloads.
- When the leader tab closes, the lock releases, another tab takes it
  and becomes the new leader. The new leader re-announces and every
  client re-pairs with a fresh `MessageChannel`. In-flight requests are
  retried once by the client RPC layer with the same request ID.

### RPC layer

A small package `packages/storage/rpc` provides:

- `createWriterClient()` — returns a typed `Repo` object backed by either
  SharedWorker or the leader-election path; the caller does not care
  which.
- Request IDs, timeouts, and one retry on leader change.

## Consequences

- Writes are serialized through a single sqlite-wasm instance. No DB
  corruption.
- The "one writer" rule is the same on both platforms; only the
  transport differs.
- We pay one `postMessage` round-trip per query. We measure and revisit
  if it shows up in profiles.
- We must test the leader-handover path; flaky reconnection is the most
  likely bug source.

## Alternatives considered

- **Two writers with OPFS file locks**: SQLite-WASM does not safely
  support cross-context concurrent writers on OPFS today.
- **All-in-page sqlite-wasm**: works in one tab; breaks the moment a
  second tab opens because of the exclusive OPFS handle.
- **Service Worker as the writer**: service workers can be evicted at
  any moment and their lifecycle is wrong for "hold a database handle".
