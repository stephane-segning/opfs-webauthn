# ADR 0014 — Same-origin routing for the frontend + share-backend

- **Status**: Accepted
- **Date**: 2026-05-20
- **Supersedes**: the cross-origin assumption baked into
  [ADR 0007](./0007-deployment-and-sharing-backend.md) and the
  per-host split in
  [ADR 0012](./0012-self-hosted-rust-share-backend.md).

## Context

ADR 0007 set up the frontend on GitHub Pages and the share
rendezvous on a separate origin (Cloudflare Worker at the time,
then Knative under `api.ocs.vaam.store` per ADR 0012). The split
hosts came from the deploy boundary, not from any architectural
need: the share-backend talks plain HTTP, the frontend never
reads its cookies, the two are independent in every way except
that one calls the other.

After ADR 0013 brought the frontend onto Knative as well, both
services live in the same cluster and the same ingress. Keeping
them on two hostnames buys us nothing and costs three things:

1. **A build-time URL pin.** `NEXT_PUBLIC_SHARE_BACKEND_URL` is
   inlined into the static bundle at build time; the bundle
   becomes per-environment. Every staging slice needs a separate
   image, and a misconfigured build silently ships sharing off
   (`getShareConfig` short-circuits when the env is empty).
2. **CORS.** The browser preflights every non-simple POST,
   doubling latency on every share operation and adding a tower
   of edge cases (origin allow-list, vary-on-origin caching,
   credentialless vs require-corp, …).
3. **Two TLS certificates.** Trivial to provision via
   cert-manager but still two failure modes — `ocs.vaam.store`
   could be green while `api.ocs.vaam.store` has a stale cert.

The COOP / COEP setup in ADR 0013 only needs to hold for the
*document*. The fetch responses for `/api/*` don't influence
`crossOriginIsolated`. So nothing about the same-origin choice
relaxes the security posture established there.

## Decision

The production deployment serves both the frontend and the
share-backend from a **single host** (`ocs.vaam.store`). The
cluster ingress routes by path:

- `/api/*` → the `opfs-share-backend` Knative service, with the
  `/api` prefix stripped before forwarding.
- `/*` → the `opfs-web` Knative service (the Next.js static
  export behind nginx-unprivileged).

Concretely:

- Frontend default `baseUrl` in `apps/web/src/share/share-config.ts`
  is `/api`. The Dockerfile sets `ARG NEXT_PUBLIC_SHARE_BACKEND_URL=/api`
  as the build-time default. The build workflow no longer pins
  the URL.
- The share-backend's HTTP routes (`/rendezvous`,
  `/rendezvous/:code`, `/rendezvous/:code/blob`) stay
  prefix-free. The ingress URL-rewrite strips `/api` so the
  backend doesn't need to know where it's mounted.
- Reference routing manifests live in
  [`docs/routing/`](../routing/) covering three shapes:
  - `traefik-ingressroute.yaml` — the topology this project
    uses in production: Traefik at the cluster edge forwarding
    to Kourier (the default networking layer installed by the
    KnativeServing operator). Traefik terminates TLS, picks
    backends by path, and **rewrites the `Host` header** to the
    KSvc's cluster-local DNS name so Kourier routes to the
    right Revision pod.
  - `httproute.yaml` — Gateway API HTTPRoute, the
    forward-compatible default for any conformant gateway
    (Traefik v3+, Cilium Gateway, Envoy Gateway, Contour).
    Doesn't need the Host rewrite because Gateway API is itself
    a Knative-supported networking layer.
  - `istio-virtualservice.yaml` — Knative on Istio with the
    classic VirtualService model. Same "is the networking
    layer" property — no Host rewrite needed.

  None of the three is packaged inside the Helm charts: the
  routing layer is cluster-specific and we don't want to force
  an ingress implementation on consumers.

Cross-origin overrides remain supported. Setting
`NEXT_PUBLIC_SHARE_BACKEND_URL=https://staging-api.example`
flips the client back to absolute URLs for dev / staging that
isn't behind the ingress yet. An explicit empty string still
disables sharing entirely. The share-backend's CORS allow-list
is unchanged — same-origin POSTs send the `Origin` header and
match the production allow-list transparently, so one config
serves both deploys.

## Consequences

- **No more build-time URL pin.** Every image is the same image;
  promotion is a tag move, not a rebuild.
- **No CORS preflights** on the production deploy. One fewer
  round-trip per share operation.
- **One TLS cert** for the production host.
- **The deploy gains an ingress prerequisite.** Operators must
  install one routing manifest per cluster on top of the two
  Knative services. The reference manifests in `docs/routing/`
  are 30 lines each; the README documents the contract.
- **The Helm charts stay narrowly scoped.** Neither chart owns
  the routing layer. Adding an Application-level overlay
  (Gateway API kit, Istio operator, …) is a separate concern
  that lives in the consumer's GitOps repo.
- **CORS code stays in.** It's still load-bearing for dev and
  staging; deleting it would re-introduce a cross-origin gap
  whenever the deploy shape changes. The doc comments make the
  same-origin / cross-origin duality explicit.

## Alternatives considered

- **Single container with nginx + Rust under supervisord.**
  Tempting for ops simplicity — one image, one signing identity,
  one ArgoCD `Application`. Rejected because the frontend and
  the rendezvous have **opposite** scaling profiles: the
  frontend is stateless and scales horizontally with traffic,
  the rendezvous holds in-memory state and is pinned to
  `maxScale: 1`. Sharing a pod would pin the frontend to one
  replica too, or introduce a separate shared store before any
  other multi-replica work.
- **Rust as a Node N-API addon, served from a Next.js handler.**
  Trades the static export for a Node runtime in the runtime
  image, plus FFI overhead on every request. The static export
  is doing real work — small image, no V8 GC pauses, no Node
  CVEs to track. Not worth it for a rendezvous that's <30 ms
  per request even with the network round-trip.
- **Keep the two hosts, fix the CORS friction with cookies-less
  preflight caching.** Solves the latency but not the build-time
  URL pin or the two-cert exposure. Half a solution.
