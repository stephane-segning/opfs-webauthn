# Same-origin routing examples

This directory holds **reference manifests** for routing
`https://<host>/api/*` to the share-backend Knative service while
`/` falls through to the opfs-web Knative service. ADR 0014
explains *why* same-origin; these files are *how*.

The manifests are **not** packaged in either Helm chart on
purpose: the routing layer is cluster-specific (Istio? Contour?
Cilium Gateway? Plain nginx-ingress?), and bundling one shape
into the chart would force every operator onto that exact
ingress implementation. Pick the file that matches your cluster
and drop it into your GitOps repo alongside the two `Application`
manifests.

## Files

| File | When to use |
|------|-------------|
| [`httproute.yaml`](./httproute.yaml) | Gateway API ≥ v1.0. The forward-compatible default — adopt this if you can. |
| [`istio-virtualservice.yaml`](./istio-virtualservice.yaml) | Knative on Istio with the classic VirtualService routing model. |

## Wiring contract

Both manifests assume:

- Two Knative Services in namespace `opfs`: `opfs-web` (the
  frontend) and `opfs-share-backend` (the rendezvous API).
- A single inbound host (`ocs.vaam.store`) terminated at the
  cluster's gateway / ingress.
- The share-backend listens on the same paths the frontend
  expects (`/rendezvous`, `/rendezvous/:code`, …). The routing
  layer **rewrites** `/api/rendezvous` → `/rendezvous` before
  forwarding, so the backend stays oblivious to the prefix.

## Verifying after install

From a browser console at the live host:

```js
// Same-origin GET — no CORS preflight, no Origin header.
await fetch("/api/health").then(r => r.status);  // expect 200/204
crossOriginIsolated;                              // expect true
```

If the API call hits the frontend instead of the backend, the
ingress isn't matching `/api/*` first — Gateway API and
VirtualService both evaluate rules in the order written, so the
more-specific `/api/` rule must come **before** the catch-all
`/` rule.
