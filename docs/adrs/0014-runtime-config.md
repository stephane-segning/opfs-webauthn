# ADR 0014 — Runtime config for the share-backend URL

- **Status**: Accepted
- **Date**: 2026-05-20

## Context

The frontend's share UI is gated on knowing where the
share-rendezvous backend lives. Before this ADR, the URL was
pinned at **build time** via `NEXT_PUBLIC_SHARE_BACKEND_URL`,
inlined into the static bundle by Next.js. Three problems with
that:

1. **Per-environment images.** A staging build and a production
   build had to be **different image digests** because they
   embedded different backend URLs. Promotion was a rebuild, not
   a tag move. ArgoCD Image Updater's digest-pinning flow stops
   working — you can't promote-by-digest if the digest itself is
   environment-specific.
2. **No deploy-time override.** Setting the URL in the Helm
   chart's values had no effect on a build that had already
   baked the wrong value in.
3. **The frontend and the share-backend land on Knative-assigned
   default domains** (`<ksvc>.<ns>.<config-domain>`), which are
   per-cluster strings the build pipeline doesn't know.

The chart could in principle template a per-deploy nginx config
that hard-redirects API calls, but that's a heavy hammer for one
URL.

## Decision

The frontend image is **cluster-agnostic**. Same digest deploys
anywhere. The share-backend URL is a **runtime** input.

Mechanics:

1. `apps/web/docker/config.js.template` is a tiny JS file with a
   `${SHARE_BACKEND_URL}` placeholder:
   ```js
   window.__OPFS_CONFIG__ = Object.freeze({
     shareBackendUrl: "${SHARE_BACKEND_URL}",
   });
   ```
2. `apps/web/docker/40-render-config.sh` runs inside
   `/docker-entrypoint.d/` (nginx-unprivileged's standard
   pre-launch hook), substitutes the env var via `envsubst`, and
   writes the result to `/usr/share/nginx/html/config.js`. Empty
   env var → empty string → share UI disabled.
3. `apps/web/src/app/layout.tsx` loads `/config.js` with a
   classic blocking `<script>` in `<head>` — that lands before
   the bundle scripts (which Next.js auto-defers) and
   `window.__OPFS_CONFIG__` is set by the time any client
   component runs.
4. `apps/web/src/share/share-config.ts` reads
   `window.__OPFS_CONFIG__?.shareBackendUrl` lazily inside
   `getShareConfig()`. Lazy read keeps the module SSR-safe even
   though the only caller is a `"use client"` component.
5. `apps/web/helm/opfs-web/values.yaml` exposes
   `env.shareBackendUrl` (empty default); the chart template
   pipes it through to the pod as `SHARE_BACKEND_URL`.

Two domains, not one. The frontend lives at the Knative-assigned
URL for `opfs-web`; the share-backend lives at the
Knative-assigned URL for `opfs-share-backend`. Browser issues
**cross-origin** POSTs, which the share-backend's CORS allow-list
gates. The chart's `env.allowedOrigins` default is empty for the
same reason — must be set per cluster.

## Consequences

- **One image, every cluster.** Production / staging / preview
  all run the same digest. ArgoCD Image Updater's digest pinning
  works end-to-end again.
- **Config flows through Helm.** A consumer in their GitOps repo
  sets `env.shareBackendUrl` in the `Application`'s values block
  for opfs-web, and `env.allowedOrigins` for opfs-share-backend,
  and that's all the per-cluster config the deploy needs.
- **One extra runtime file.** `/config.js` is ~120 bytes,
  rendered at container start in <10 ms. Service worker has to
  cache-bust it on update (currently `no-cache` via the nginx
  catch-all location — fine, it's tiny).
- **No build-time URL constants left in repo.** The
  `SHARE_BACKEND_URL` workflow env, the Dockerfile `ARG`, and
  the build-args block in `docker/build-push-action` are all
  gone. The default render of the chart from a fresh checkout
  produces a runnable image with sharing **off** — visible
  symptom, not a silent regression.

## Alternatives considered

- **Bake URL at build time + per-environment images.** The
  status quo we're leaving. Forces N rebuilds for N environments;
  defeats digest-based promotion.
- **Fetch config from a `/config.json` endpoint at app boot.**
  Same result, but async. Means the share button has to wait on
  a network round-trip to know whether it's enabled, and the
  first render either flickers or has to be gated on the fetch.
  Synchronous `/config.js` is simpler.
- **Use Next.js `output: "standalone"` + a Node server in the
  runtime image** that reads env per request. Trades the
  static-export shape (small image, no Node CVEs) for an
  ergonomic Next.js handler. Not worth it for one URL.
- **Service worker rewrites the URL.** Conceptually clever,
  practically awful — SW upgrades have their own delays, and
  the URL gating has to work on first paint before the SW even
  registers.
