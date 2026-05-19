# @opfs/storage

OPFS-backed SQLite (via [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm))
running in a dedicated worker. Single writer per page. The page-side
`Repo` holds the [`CryptoVault`](../core-wasm) and encrypts/decrypts
row content before/after the worker ever sees it — the worker stores
ciphertext-only.

Single-tab safety today; [ADR 0006](../../docs/adrs/0006-multi-tab-sync.md)
multi-tab (SharedWorker + Web-Locks leader election) lands in a
follow-up PR.

## Public surface

```ts
import { createRepo } from "@opfs/storage";
import type { CryptoVault } from "@opfs/core-wasm";

const repo = await createRepo({ vault });

// Insert / update
await repo.upsertNote({ title: "hello", body: "world" });

// Page through notes (newest-first, day-bucketed then id-tiebreaker)
const first = await repo.listNotes({ limit: 20 });
if (first.nextCursor) {
	const more = await repo.listNotes({ cursor: first.nextCursor });
}

await repo.archiveNote(note.id);

// On vault lock:
await repo.close();
```

Subscribe to `tx-applied` if you need to invalidate caches on commit:

```ts
const unsubscribe = repo.subscribeTxApplied((ids) => {
	for (const id of ids) cache.invalidate(id);
});
```

## On-disk layout

Per [ADR 0004](../../docs/adrs/0004-sqlite-opfs-storage.md):

```sql
CREATE TABLE notes (
  id BLOB PRIMARY KEY,                -- 16 random bytes
  updated_day INTEGER,                -- day-quantised; never per-second
  archived INTEGER DEFAULT 0,
  title_nonce BLOB,
  title_ciphertext BLOB,              -- AES-256-GCM
  body_nonce BLOB,
  body_ciphertext BLOB
);
```

The id is random (NOT a ULID — those would leak a millisecond
timestamp into the plaintext primary key column and defeat the
day-quantisation). On the JS side ids are encoded as 26-character
Crockford base32 for ergonomic logging.

AAD bound into each row: `opfs-webauthn/v1/note-row/{field}/{id}`
(`{field}` ∈ `{"title", "body"}`). Different field, different id, or
different protocol version → tag mismatch on decrypt.

## Notes on hosting

The OPFS-SAHPool VFS we use does NOT require COOP/COEP, so the live
GitHub Pages deploy at `/opfs-webauthn` can serve sqlite-wasm
unmodified. The bundle (sqlite3.wasm + JS shims) lives in
`apps/web/.next/static/...` after Next's webpack run.

## Status

Single-tab only. Multi-tab safety + the `vault-locked` broadcast
event arrive in the [ADR 0006](../../docs/adrs/0006-multi-tab-sync.md)
PR (SharedWorker writer + Web Locks leader-election fallback).
