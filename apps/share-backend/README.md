# opfs-share-backend (Rust)

Self-hosted Rust HTTP backend for the recipient-first share rendezvous
([ADR 0012](../../docs/adrs/0012-self-hosted-rust-share-backend.md)).
Replaces the TypeScript Cloudflare Worker that used to live here;
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

### Pipeline shape (CI vs. ArgoCD)

The split is GitOps-strict: **CI never touches the cluster.**

- **`.github/workflows/deploy-share-backend.yml`** builds the
  multi-stage Dockerfile (~50 MiB distroless image), pushes to
  GHCR (`ghcr.io/<owner>/opfs-share-backend:latest` +
  `:<git-sha>`), and **signs** each image with `cosign` keyless
  via Sigstore. The GH Actions OIDC token is exchanged for a
  short-lived Fulcio cert and the signature lands in the Rekor
  transparency log — no private key material to manage.
- **ArgoCD** pulls the Helm chart from
  `oci://ghcr.io/<owner>/charts/opfs-share-backend` (published by
  the same workflow, signed by the same Sigstore keyless flow)
  and reconciles a Knative `Service` from it. The chart sources
  live in `apps/share-backend/helm/opfs-share-backend/`; the
  release boundary is the OCI artifact, not the Git path.
- See `apps/share-backend/helm/argocd-application.example.yaml`
  for a ready-to-adapt `Application` with Image Updater + cosign
  verification annotations wired against the OCI chart source.

Permissions the workflow requires (already set in the workflow file):

- `contents: read`
- `packages: write` (push to GHCR)
- `id-token: write` (cosign keyless via Sigstore)

No `KUBE_CONFIG` secret is needed; the cluster credentials live
with the ArgoCD install, not this repo.

### Manifest defaults

The committed manifest is applyable as-is — the only knobs are
its env vars, which carry the production defaults:

| Env var | Default | Notes |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://ocs.vaam.store` | Comma-separated; override per env via a Kustomize patch. |
| `TRUSTED_IP_HEADER` | `x-real-ip` | Required for per-IP rate limiting. Never read `X-Forwarded-For` directly (client-controllable first hop). |
| `PORT` | `8080` | Matches the binary default. |

The frontend reads **`NEXT_PUBLIC_SHARE_BACKEND_URL`** at build
time; set it to `https://api.ocs.vaam.store` as a repo variable
when the cluster + ingress are live.
