# Same-origin routing examples

This directory holds **reference manifests** for routing
`https://<host>/api/*` to the share-backend Knative service while
`/` falls through to the opfs-web Knative service. ADR 0014
explains *why* same-origin; these files are *how*.

The manifests are **not** packaged in either Helm chart on
purpose: the routing layer is cluster-specific, and bundling one
shape into the chart would force every operator onto a specific
ingress implementation. Pick the file that matches your cluster
and drop it into your GitOps repo alongside the two `Application`
manifests.

## Files

| File | When to use |
|------|-------------|
| [`traefik-ingressroute.yaml`](./traefik-ingressroute.yaml) | **Traefik in front of Kourier** (the topology this project uses). Traefik terminates TLS, path-routes, and rewrites `Host` on the way to Knative's networking layer. |
| [`httproute.yaml`](./httproute.yaml) | Gateway API ≥ v1.0 — works with any conformant gateway (Traefik v3+, Contour, Cilium, Envoy Gateway). The forward-compatible default. |
| [`istio-virtualservice.yaml`](./istio-virtualservice.yaml) | Knative on Istio with the classic VirtualService routing model. |

## Wiring contract

All three manifests assume:

- Two Knative Services in namespace `opfs`: `opfs-web` (the
  frontend) and `opfs-share-backend` (the rendezvous API).
- A single inbound host (`ocs.vaam.store`) terminated at the
  cluster's edge (Traefik / Gateway / Istio ingress).
- The share-backend listens on the same paths the frontend
  expects (`/rendezvous`, `/rendezvous/:code`, …). The routing
  layer **rewrites** `/api/rendezvous` → `/rendezvous` before
  forwarding, so the backend stays oblivious to the prefix.

## Talking to Knative from a non-Knative ingress

Heads up if you're using Traefik (or any other ingress that's
**not** part of Knative's networking layer): Knative builds its
internal routes against the **cluster-local DNS name** of each
KSvc (`<name>.<namespace>.svc.cluster.local`). Kourier / Istio
match incoming requests against the `Host` header to pick the
right Revision pod.

A request arriving at Traefik has `Host: ocs.vaam.store`. That
header is meaningless to Kourier — it'll either 404 or route to
a wrong KSvc. So the Traefik manifest **rewrites `Host`** to the
KSvc's cluster-local name before forwarding to Kourier. The
HTTPRoute / VirtualService examples don't need that step because
they ARE the Knative networking layer (Gateway API + Istio are
the two networking-layer choices Knative supports directly).

If you'd rather skip the Host rewrite, the alternative is to
configure Knative's `config-domain` to make
`ocs.vaam.store` an externally-known domain for the KSvc. That
works but couples the KSvc to a specific public host, which is
the opposite of what same-origin routing buys us — easier promotion
across environments.

## Verifying after install

From a browser console at the live host:

```js
// Same-origin GET — no CORS preflight, no Origin header.
await fetch("/api/health").then(r => r.status);  // expect 200/204
crossOriginIsolated;                              // expect true
```

If the API call hits the frontend instead of the backend, the
ingress isn't matching `/api/*` first — every example here puts
the `/api` rule **above** the catch-all on purpose; check the
rule order if you adapted the manifest.
