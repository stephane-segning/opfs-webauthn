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

12 integration tests drive the router through `tower::ServiceExt::oneshot`
against a real `MemoryRendezvousStore` and an injected clock — happy
path, single-pickup, TTL expiry → 410, expired-blob → 404 even if the
sweep lags, payload cap → 413, per-IP rate limit → 429, an explicit
"`X-Forwarded-For` spoofing does NOT bypass the per-IP cap" case,
and CORS preflight/rejection. The commitment-derivation test vector
lives in `crates/crypto`; both the wasm and the server consume it
directly, so there's no JS↔Rust drift to guard against any more.

## Deploy

The frontend lives at **`https://ocs.vaam.store`** (GitHub Pages
+ custom DNS); the backend will be served at
**`https://api.ocs.vaam.store`** (Knative). The page-side client
finds it via the `NEXT_PUBLIC_SHARE_BACKEND_URL` build-time
variable.

Repo-level config that needs setting once:

| Where | Name | Value |
| --- | --- | --- |
| Repository variable (Pages build) | `NEXT_PUBLIC_SHARE_BACKEND_URL` | `https://api.ocs.vaam.store` |
| Knative manifest / Deployment env | `ALLOWED_ORIGINS` | `https://ocs.vaam.store` (comma-separated for additional origins) |
| Knative manifest / Deployment env | `TRUSTED_IP_HEADER` | `x-real-ip` — required for per-IP rate limiting. Without it the limiter degrades to a single global bucket. We never read `X-Forwarded-For` directly (client-controllable first hop). |
| Knative manifest / Deployment env | `PORT` | `8080` (default, matches the binary) |

Manifests + CI workflow live in:

- `Dockerfile` — multi-stage build, distroless
  `cc-debian12:nonroot` runtime (~50 MiB; the `cc` flavor bundles
  libssl/libcrypto). Layer caching delegated to the workflow's
  buildx GHA cache instead of `cargo-chef`, which has an MSRV
  conflict with our pinned 1.85 toolchain.
- `k8s/service.yaml` — Knative `Service` with
  `containerConcurrency: 100`, `maxScale: 1` (single replica so
  the in-memory store stays correct), a read-only root filesystem,
  and conservative resource requests.
- `.github/workflows/deploy-share-backend-rs.yml` — on push to
  `main` touching `apps/share-backend-rs/**`, `crates/crypto/**`,
  or `Cargo.toml/lock`: builds + pushes the image to GHCR, applies
  the manifest, and `kubectl wait`s for `Ready=True`. Skips
  gracefully when `KUBE_CONFIG` isn't set so fork CI stays green.

Secrets / variables the workflow expects:

- `KUBE_CONFIG` (**secret**) — `base64 -w0` of a kubeconfig with
  permission to manage the `serving.knative.dev/v1` `Service` in
  the target namespace.
- `KNATIVE_NAMESPACE` (**variable**, optional) — namespace to
  deploy into. Defaults to `default`.

The image is published at `ghcr.io/<owner>/opfs-share-backend`,
tagged `:latest` and `:<git-sha>`.
