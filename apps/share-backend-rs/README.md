# opfs-share-backend (Rust)

Self-hosted Rust HTTP backend for the recipient-first share rendezvous
([ADR 0012](../../docs/adrs/0012-self-hosted-rust-share-backend.md)).
Replaces the Cloudflare Worker that used to live in `apps/share-backend/`;
the HTTP contract is identical so the page-side `@opfs/share-client`
needs no changes beyond pointing `NEXT_PUBLIC_SHARE_BACKEND_URL` at
the new deploy.

## Endpoints

| Method + Path | Purpose |
| --- | --- |
| `POST /rendezvous` | Recipient mints a rendezvous. Body: raw 32-byte X25519 pubkey. Response: `{code, expiresAt}` JSON. |
| `GET /rendezvous/:code` | Sender fetches the recipient's pubkey (raw bytes). The sender must locally re-derive the code from the returned pubkey before encrypting. |
| `POST /rendezvous/:code/blob` | Sender uploads the encrypted share blob (single-shot, atomic at the `Mutex` boundary). |
| `GET /rendezvous/:code/blob` | Recipient picks up the blob exactly once; the server deletes after the first successful read. |

All non-`OPTIONS` requests are CORS-checked against `ALLOWED_ORIGINS`
before any handler runs. Rate limit: `MINT_RATE_LIMIT` mints per IP
per TTL window (currently 10 per 5 min); hard enforcement against
brute-force / DoS is configured at the ingress / k8s
`NetworkPolicy` layer.

## Run locally

```sh
PORT=8080 \
HOST=127.0.0.1 \
ALLOWED_ORIGINS=http://localhost:3000 \
cargo run -p opfs-share-backend
```

Then in another shell:

```sh
curl -v -X POST http://127.0.0.1:8080/rendezvous \
  --data-binary @<(printf '%0.s\xAA' $(seq 32)) \
  -H 'origin: http://localhost:3000'
```

## Tests

```sh
cargo test -p opfs-share-backend
```

10 integration tests drive the router through `tower::ServiceExt::oneshot`
against a real `MemoryRendezvousStore` and an injected clock — happy
path, single-pickup, TTL expiry → 410, payload cap → 413, per-IP rate
limit → 429, CORS preflight/rejection. The commitment-derivation
test vector lives in `crates/crypto`; both the wasm and the
server consume it directly, so there's no JS↔Rust drift to guard
against any more.

## Deploy

Manifests + CI workflow land in the follow-up PR. The shape will
be:

- Multi-stage Dockerfile (`cargo-chef` for layer caching, distroless
  `cc` runtime, ~15 MiB image).
- Knative `Service` with `containerConcurrency: 100` and
  `autoscaling.knative.dev/maxScale: "1"` so the in-memory store
  stays correct without a shared backend.
- GitHub Actions workflow that builds the image, pushes to the
  configured registry, and `kubectl apply`s the manifest. Skips
  gracefully when the cluster credentials aren't present so fork
  CI stays green.
