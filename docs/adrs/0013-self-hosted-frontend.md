# ADR 0013 — Self-hosted frontend on Knative with cross-origin isolation

- **Status**: Accepted
- **Date**: 2026-05-20
- **Supersedes**: the frontend-on-GitHub-Pages portion of
  [ADR 0007](./0007-deployment-and-sharing-backend.md)

## Context

ADR 0007 picked GitHub Pages for the static frontend. The deploy
itself worked, but two browser symptoms forced a rethink:

1. On Firefox, `installOpfsSAHPoolVfs` fails inside `SharedWorker`
   because `FileSystemFileHandle.prototype.createSyncAccessHandle`
   isn't exposed there. PR #31 added a fallback to `DedicatedWorker`,
   which works on Firefox — **but** sqlite-wasm also tries the
   async OPFS VFS as a second option, and that one fails with
   `Cannot install OPFS: Missing SharedArrayBuffer and/or Atomics.
   The server must emit the COOP/COEP response headers to enable
   those.` That secondary failure is harmless to the app
   (SAH-pool already succeeded) but the console is noisy and the
   message is misleading. More importantly, future OPFS work that
   uses async coordination would actually need SAB.
2. `SharedArrayBuffer` is only available in a **cross-origin
   isolated** browser context, gated on
   `Cross-Origin-Opener-Policy: same-origin` **and**
   `Cross-Origin-Embedder-Policy: require-corp` (or
   `credentialless`) HTTP response headers on the document.
   GitHub Pages doesn't let us set arbitrary response headers, so
   the document never reaches `crossOriginIsolated`.

We can keep Pages and live with the noisy warnings, or self-host
behind a server we control. The cluster is already there for the
share backend (ADR 0012); putting the frontend next to it costs
us another Knative `Service` and a Helm chart but buys cross-
origin isolation, server-pushed cache headers, and a single
deploy story for the whole product.

## Decision

Serve the Next.js static export ourselves on Knative, behind a
custom DNS (`ocs.vaam.store`), with the headers required for
cross-origin isolation.

### Stack

- **`apps/web/`** keeps producing a Next.js static export
  (`NEXT_OUTPUT_EXPORT=1 pnpm --filter @opfs/web build`). The
  output is plain HTML + hashed assets — no Node runtime needed.
- **`apps/web/Dockerfile`** is multi-stage:
    1. `wasm` stage — `rust:1.85-bookworm`, `wasm-pack build
       crates/core` → `packages/core-wasm/dist`.
    2. `frontend` stage — `node:20-bookworm` + `pnpm`. Pulls in
       the wasm artifact, runs the Next build, leaves `out/` on
       disk.
    3. `runtime` stage — `nginxinc/nginx-unprivileged:1.27-alpine`.
       Copies `out/` into `/usr/share/nginx/html`, drops in a
       custom `default.conf`. Total image size around ~80 MiB
       (nginx-alpine base + ~10 MiB of static assets).
- **`apps/web/docker/nginx.conf`** sets the load-bearing headers:
  - `Cross-Origin-Opener-Policy: same-origin` — top-level browsing
    context isolated from popups.
  - `Cross-Origin-Embedder-Policy: credentialless` — allows
    `crossOriginIsolated=true` while still permitting our
    no-credentials `fetch` calls to `api.ocs.vaam.store`. The
    stricter `require-corp` would force every cross-origin asset
    to opt in via CORP headers; we don't need that strictness.
  - `Cross-Origin-Resource-Policy: same-origin` — keeps our
    bundled JS / WASM same-origin-only.
  - Long-immutable caching for `/_next/static/`.
  - `application/wasm` MIME on `.wasm`.
- **Helm chart at `apps/web/helm/opfs-web/`** mirrors the
  share-backend chart (ADR 0012). Knative `Service`,
  `maxScale` left generous since the frontend is stateless.
- **Build workflow `.github/workflows/deploy-web.yml`** mirrors
  the share-backend pipeline: build → push → sign image, then
  package → push → sign Helm chart. Both signed keylessly via
  Sigstore. ArgoCD pulls the chart from
  `oci://ghcr.io/<owner>/charts/opfs-web` and reconciles.
- **DNS** stays at `ocs.vaam.store`, now resolving to the
  Knative ingress instead of `*.github.io`. The `CNAME` file in
  the static export is no longer needed and is removed.

### What stays the same

- Identity, crypto, storage model, share protocol — every byte of
  user-visible behaviour. The pivot is operational only.
- The WebAuthn rpId remains `ocs.vaam.store`. Passkeys enrolled
  against the Pages-hosted version continue to unlock the vault on
  the Knative-hosted version — same hostname.

### What changes

| | ADR 0007 (GitHub Pages) | ADR 0013 (Knative self-host) |
| --- | --- | --- |
| Server | GitHub Pages | nginx-unprivileged on Knative |
| Custom headers | none | `COOP=same-origin`, `COEP=credentialless`, `CORP=same-origin` |
| `crossOriginIsolated` | `false` | `true` |
| `SharedArrayBuffer` | unavailable | available (when needed) |
| Deploy | `actions/deploy-pages` | ArgoCD pulling the OCI chart |
| Custom domain | CNAME file in `out/` | DNS A/AAAA to ingress |

## Consequences

- **Operational footprint**: one more Knative `Service` to keep
  running. Stateless, scales to zero, ~80 MiB image — cheap.
- **Cold start**: nginx boots in <100 ms; not user-perceptible.
- **Custom-domain DNS**: change the apex / CNAME from
  `stephane-segning.github.io` to the cluster ingress IP. Done
  once at the registrar.
- **Cost of mistake**: a broken nginx config breaks the entire
  frontend, where Pages was harder to misconfigure. Mitigated by
  shipping a battle-tested config and using `helm lint` +
  `helm template` in CI.
- **Removed**: `.github/workflows/deploy.yml` (the Pages workflow)
  and `apps/web/public/CNAME` (Pages-specific). The `dev` and
  `build` scripts in `apps/web/package.json` are unchanged.

## Alternatives considered

- **Stay on GitHub Pages, live with the warning.** Possible —
  SAH-pool works on most browsers without isolation. The
  warnings are non-fatal. But future features that genuinely need
  SAB (multi-thread wasm, structured cloning of large buffers) are
  blocked, and the console noise is a poor first impression.
- **Cloudflare Pages (which can set custom headers via `_headers`).**
  Re-introduces vendor coupling we left behind in ADR 0012. The
  Knative cluster is already running.
- **Serve from the same Knative `Service` as the backend.** Would
  unify the deploy further but means embedding a static file
  server in the Rust binary. Harder to swap nginx-grade things
  like CSP, content negotiation, range requests.
- **Use `require-corp` instead of `credentialless`.** Stricter,
  requires every cross-origin asset to ship CORP headers. Our
  share-backend would need `Cross-Origin-Resource-Policy:
  cross-origin` on every response; doable but extra surface.
  `credentialless` is the same isolation outcome with less
  cluster-wide policy.
