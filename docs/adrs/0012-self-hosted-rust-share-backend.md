# ADR 0012 — Self-hosted Rust share backend on Knative

- **Status**: Accepted
- **Date**: 2026-05-20
- **Supersedes**: the deployment portion of [ADR 0007](./0007-deployment-and-sharing-backend.md)

## Context

ADR 0007 picked Cloudflare Workers + KV + R2 as the rendezvous
backend. After two months of iteration the trade-offs we accepted
there started to bite:

- **Vendor coupling.** Wrangler config, KV / R2 bindings, CF
  `unsafe.bindings`, and the per-account-id deploy story all leak
  into the workflow files and the runtime. Moving off Cloudflare
  would mean rewriting the entire deploy surface.
- **Language fragmentation.** Every other Rust artifact in this
  project (crypto, commitment, repo, share-protocol) lives in
  `crates/`. The Worker was the lone TypeScript service hand-rolling
  the same commitment derivation in JS, and we paid for it: the
  pinned reference vector existed precisely to catch JS↔Rust drift.
- **Self-hostable story.** The brief is a research vehicle; we want
  every piece to be deployable on infrastructure we control. A
  Cloudflare Worker isn't that.
- **KV / R2 trade-offs.** KV is eventually-consistent and R2's
  conditional put is a workaround for KV's missing CAS. A single-
  process Rust service with an in-memory store gets us real atomic
  single-upload at zero infra cost, and the door stays open for a
  shared store (Redis, Postgres) behind the existing
  `RendezvousStore` trait once we need multi-replica.

## Decision

Replace the Cloudflare Worker with a self-hosted Rust HTTP service
deployed on Kubernetes via Knative.

### Stack

- **`apps/share-backend/`** — Rust binary using `axum` on
  `tokio`. Same HTTP contract as the existing Worker
  (`POST /rendezvous`, `GET /rendezvous/:code`,
  `POST /rendezvous/:code/blob`, `GET /rendezvous/:code/blob`),
  same status-code mapping, same body framing — so
  `@opfs/share-client` flips a `baseUrl` and nothing else.
- **`opfs_crypto::commitment`** is consumed directly. No more JS
  port of the BLAKE3 truncation — the same Rust function the wasm
  side already pins is what the server runs.
- **Storage** lives behind a `RendezvousStore` trait. The shipped
  impl is `MemoryRendezvousStore` — a `Mutex<HashMap>` with TTL
  sweep — designed for a single-replica Knative deploy. A Redis
  / Postgres / Durable-Object impl plugs into the same trait when
  we need multi-replica.
- **CORS** is a hand-rolled middleware over an `ALLOWED_ORIGINS`
  env var. Allow-list enforced before any handler runs, matching
  the Worker's behaviour the client already expects.
- **Container**: multi-stage Dockerfile, runtime image is
  `gcr.io/distroless/cc:nonroot` so the published artifact is
  ~50 MiB and has no shell (the `cc` flavour bundles libssl/
  libcrypto, which is the difference vs the ~15 MiB scratch
  variant). Layer caching is delegated to the buildx GHA cache;
  `cargo-chef` was tempting but its current release requires
  Rust 1.88+ and our workspace MSRV is 1.85.
- **Deploy model**: GitOps via ArgoCD. **CI never touches the
  cluster.** The build workflow's job is to produce an image
  ArgoCD can trust:
    1. `docker build + push` to GHCR (both `:latest` and
       `:<git-sha>`).
    2. `cosign sign --yes` the image **keylessly** via Sigstore
       (Fulcio + Rekor, OIDC token from the workflow). No private
       key material to manage; the signing identity is the
       repository's GitHub Actions workflow.
    3. `cosign verify` immediately after, asserting the
       just-published image carries our signature.
  ArgoCD reconciles the Knative `Service` from
  `apps/share-backend/k8s/`. The Image Updater annotations on the
  ArgoCD `Application` (see `k8s/argocd-application.example.yaml`)
  pin specific signed digests as new builds land, so the
  committed manifest stays at `:latest` without churn.

### What stays the same

- The cryptographic contract (60-bit BLAKE3 commitment, X25519
  share, AES-GCM AEAD).
- The HTTP contract — `@opfs/share-client` is unchanged.
- The threat model: the backend is treated as untrusted. The
  commitment is verified locally on the sender side before any
  encryption happens. The Worker storing ciphertext-only is now
  the Rust service storing ciphertext-only.

### What changes

| | ADR 0007 (Cloudflare) | ADR 0012 (Rust/Knative) |
| --- | --- | --- |
| Language | TypeScript | Rust |
| Runtime | Cloudflare Workers | Container on Knative |
| Rendezvous metadata | KV (`expirationTtl`) | `Mutex<HashMap>` w/ TTL sweep |
| Blob staging | R2 (conditional put) | Same `Mutex<HashMap>` |
| Single-upload atomicity | R2 `etagDoesNotMatch: "*"` | Native CAS under a `Mutex` |
| Rate limit | KV counter (best-effort) | In-memory counter (best-effort) |
| Hard rate enforcement | Cloudflare zone WAF | Ingress / k8s NetworkPolicy |
| Commitment derivation | JS port pinned to Rust | Single Rust crate, end-to-end |
| Deploy auth | `CLOUDFLARE_API_TOKEN` | ArgoCD GitOps; CI signs the image via Sigstore OIDC |
| Image trust | implicit (CF runtime) | `cosign` keyless signature + Rekor transparency log |

## Consequences

- **Operational footprint**: we now own a Knative cluster (or a
  cluster of one) for the rendezvous service. The Pages frontend
  is unaffected.
- **Cold-start**: Knative can scale to zero. A first request after
  idle has the cold-start latency of the binary (~50 ms for axum +
  hyper without TLS). Documented; acceptable for a research-quality
  share flow.
- **State on scale-to-zero**: the in-memory store loses outstanding
  rendezvous when the pod terminates. Rendezvous are 5-min
  short-lived; the recipient just remints. Documented in the
  backend README.
- **Multi-replica**: capped at one until the storage layer moves to
  Redis. Knative's autoscaler keeps this honest via `maxScale: "1"`.
- **CI**: builds the image, pushes to GHCR, signs with Sigstore.
  `id-token: write` is required for the OIDC handshake against
  Fulcio. No cluster credentials in the repo at all — that
  surface lives with the ArgoCD install, not here.
- **Removed**: `wrangler`, the CF KV namespace, the R2 bucket, the
  `apps/share-backend/` TS package. Done in a follow-up PR once the
  Rust service is live so we never have a window with no working
  backend.

## Alternatives considered

- **Fly.io / Render / Railway.** Smaller blast radius than a k8s
  cluster, but the brief specifically calls out k8s+Knative as the
  target.
- **Bare hyper + no axum.** Saves a dependency but reinvents the
  routing/extractor surface the test suite leans on heavily.
- **Postgres / Redis from the start.** Premature for a research
  project. The trait keeps the door open without forcing the
  infra investment.
- **Durable Objects.** Cloudflare-specific and re-locks us into
  the vendor we just left.
