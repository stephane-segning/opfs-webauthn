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

Requests with an `Origin` header that isn't on the
`ALLOWED_ORIGINS` allow-list are rejected with `403` before any
route runs — simple cross-origin `POST`s bypass preflight, so the
allow-list has to be enforced server-side. Preflight `OPTIONS`
responses are `204` on allowed origins, `403` otherwise. Requests
without an `Origin` header (curl, server-to-server) are accepted.

Rate limiting in code is best-effort: `MINT_RATE_LIMIT` per IP per
TTL window (currently 10 per 5 min), implemented over KV. Hard
enforcement against brute force and DoS is configured at the
Cloudflare zone level via WAF Rate Limiting Rules; the real
brute-force barrier is the 60-bit commitment, not this counter.

## Storage

- **KV `RENDEZVOUS`** — small metadata records keyed by code
  (`{epk, expiresAt}`) plus the per-IP mint counter. KV's eventual
  consistency is fine here: codes are derived from epks, so the
  worst case is a slightly stale record well within the 5-minute TTL.
- **R2 `BLOBS`** — opaque ciphertext, one object per code. We use
  R2's conditional put (`onlyIf: { etagDoesNotMatch: "*" }`) so two
  senders racing to upload under the same code see exactly one
  success — KV cannot give us that atomicity.

## Deploy

### One-time setup

```sh
# Create the KV namespace + R2 bucket on Cloudflare.
pnpm wrangler kv namespace create RENDEZVOUS   # paste the id into wrangler.jsonc
pnpm wrangler r2 bucket create opfs-share-blobs

# Lock down the allow-list to your real frontend origin(s) in
# wrangler.jsonc `vars.ALLOWED_ORIGINS`.
```

### Manual deploy

```sh
pnpm --filter @opfs/share-backend deploy
```

### CI deploy (recommended)

`.github/workflows/deploy-share-backend.yml` runs `wrangler deploy`
on every push to `main` that touches `apps/share-backend/**`, and on
manual `workflow_dispatch`. It requires two repository-level secrets
/ variables:

1. **`CLOUDFLARE_API_TOKEN`** (repository **secret**) — a Cloudflare
   API token scoped for Workers Scripts, KV, and R2.
2. **`CLOUDFLARE_ACCOUNT_ID`** (repository **variable**) — the
   account id wrangler should publish under.

Once those are set, the next push to `main` deploys the Worker.
After the first deploy, set **`NEXT_PUBLIC_SHARE_BACKEND_URL`** as a
repository **variable** to the published `.workers.dev` (or custom)
URL — the GitHub Pages workflow reads that variable and threads it
into the static build so the share UI lights up in production.

When `CLOUDFLARE_API_TOKEN` is unset, the deploy workflow short-circuits
with a notice rather than failing — forks without Cloudflare access
still get green CI.

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
