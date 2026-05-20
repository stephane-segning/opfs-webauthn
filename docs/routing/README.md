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
| [`traefik-ingressroute.yaml`](./traefik-ingressroute.yaml) | **Traefik 3.6+ with the experimental Knative provider** (the topology this project uses). Traefik IS the Knative networking layer; this `IngressRoute` adds the public-host path routing on top of the Knative-managed internal routes. |
| [`httproute.yaml`](./httproute.yaml) | Gateway API ≥ v1.0 — Traefik v3+, Cilium Gateway, Envoy Gateway, Contour, anything conformant. Pick this only if Knative is *also* configured to use the Gateway API networking layer (not the case in this project's deploy). |
| [`istio-virtualservice.yaml`](./istio-virtualservice.yaml) | Knative on Istio. Reference only; not used in this project's deploy. |

## Why path routing across two KSvcs needs a separate manifest

Knative does **not** natively support multiple Knative Services
sharing one hostname with path-based routing — see
[knative/serving#12588](https://github.com/knative/serving/issues/12588).
`DomainMapping` is strictly 1:1; `config-domain` only changes the
default suffix; the internal `Ingress` CRD isn't designed to be
authored by hand. So whichever networking layer you run with,
the same-origin pattern is necessarily **two layers**:

1. Knative's networking layer (Traefik, Kourier, Istio, or
   Gateway API) handles the auto-generated KSvc routes on
   their per-service hostnames (e.g.
   `opfs-web.opfs.svc.cluster.local`).
2. A custom routing manifest on the public host (`ocs.vaam.store`)
   path-routes to each KSvc.

## How `traefik-ingressroute.yaml` keeps scale-to-zero working

Every Knative Service has a *public* Kubernetes Service whose
endpoints are managed by Knative's SKS (`ServerlessService`)
reconciler ([scaling/SYSTEM.md](https://github.com/knative/serving/blob/main/docs/scaling/SYSTEM.md)).
When the KSvc is warm, those endpoints point at the Revision
pods. When it scales to zero, SKS flips to Proxy mode and the
endpoints become Activator addresses, which scale the KSvc back
up on the next request.

So an `IngressRoute` that targets `Service: opfs-web` in `opfs`
inherits the Activator path automatically. We don't have to
forward to Kourier and we don't have to rewrite the `Host`
header — Knative's machinery sits behind the K8s Service
transparently, regardless of who put a packet in front of it.

## Wiring contract

The Traefik manifest assumes:

- Two Knative Services in namespace `opfs`: `opfs-web` (the
  frontend) and `opfs-share-backend` (the rendezvous API).
- A single inbound host (`ocs.vaam.store`) terminated at
  Traefik's `websecure` entrypoint.
- The share-backend listens on the same paths the frontend
  expects (`/rendezvous`, `/rendezvous/:code`, …). The routing
  layer **rewrites** `/api/rendezvous` → `/rendezvous` before
  forwarding via the `stripPrefix` Middleware.

## Verifying after install

From a browser console at the live host:

```js
// Same-origin GET — no CORS preflight, no Origin header.
await fetch("/api/health").then(r => r.status);  // expect 200/204
crossOriginIsolated;                              // expect true
```

If the API call hits the frontend instead of the backend, the
`/api/*` rule isn't matching first — check `priority` on both
`IngressRoute` rules.
