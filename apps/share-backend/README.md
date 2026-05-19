# @opfs/share-backend

Cloudflare Worker that backs the recipient-first cross-device share
flow (ADR 0007). It mediates a short-lived rendezvous keyed by a
BLAKE3-truncated commitment of the recipient's ephemeral X25519 public
key, then ferries a single AEAD-encrypted blob from sender to
recipient. **The Worker never sees plaintext, DEKs, or PRF output —
every body it stores is opaque ciphertext.**

## Endpoints

| Method + Path | Purpose |
| --- | --- |
| `POST /rendezvous` | Recipient mints a rendezvous. Body: raw 32-byte X25519 pubkey. Response: `{code, expiresAt}` JSON. |
| `GET /rendezvous/:code` | Sender fetches the recipient's pubkey (raw bytes). **Sender MUST locally re-derive the code from the returned pubkey before encrypting.** |
| `POST /rendezvous/:code/blob` | Sender uploads the encrypted share blob (single-shot). |
| `GET /rendezvous/:code/blob` | Recipient picks up the blob exactly once; the Worker deletes after first read. |

All non-`OPTIONS` requests are CORS-checked against
`ALLOWED_ORIGINS`. Preflight responses are 204 on allowed origins, 403
otherwise. Rate limit: `MINT_RATE_LIMIT` rendezvous mints per IP per
TTL window (currently 10 per 5 min).

## Deploy

```sh
# One-time: create the two KV namespaces and paste their ids into wrangler.jsonc.
pnpm wrangler kv namespace create RENDEZVOUS
pnpm wrangler kv namespace create BLOBS

pnpm --filter @opfs/share-backend deploy
```

Local development:

```sh
pnpm --filter @opfs/share-backend dev
# → http://127.0.0.1:8787
```

## Tests

```sh
pnpm --filter @opfs/share-backend test
```

The commitment test pins a Rust reference vector
(`FA31QBAS6ZFG` for `epk = [9; 32]`); if the JS port ever drifts from
`crates/crypto/src/commitment.rs`, that test fails immediately and
the share flow is held safe.
