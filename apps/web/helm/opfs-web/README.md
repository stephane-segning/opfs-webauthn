# opfs-web (Helm chart)

Knative `Service` for the opfs-webauthn static frontend
([ADR 0013](../../../../docs/adrs/0013-self-hosted-frontend.md)).
The frontend image bundles a Next.js static export behind
nginx-unprivileged with the COOP / COEP / CORP headers required
for `crossOriginIsolated` mode.

## Install from OCI

The build workflow auto-bumps the chart patch version on every
push to `main`, so `0.1.0` from this source tree is **not** what's
on the registry. Pick a real published version:

```sh
helm install opfs-web \
  oci://ghcr.io/stephane-segning/charts/opfs-web \
  --version 0.1.42 \
  --namespace opfs --create-namespace
```

For ArgoCD:

```yaml
spec:
  source:
    repoURL: ghcr.io/stephane-segning/charts
    chart: opfs-web
    targetRevision: 0.1.*
```

See `../argocd-application.example.yaml` for the full
`Application` with cosign verification + Image Updater
annotations.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` | `ghcr.io/stephane-segning/opfs-web` | Forks override here. |
| `image.tag` | `""` (→ `Chart.AppVersion` → `latest`) | Published charts pin AppVersion to a short SHA; Image Updater rewrites this to digest. |
| `autoscaling.minScale` | `"0"` | Scale-to-zero. Cold start is <100 ms. |
| `autoscaling.maxScale` | `"10"` | Stateless; safe to scale. |
| `containerConcurrency` | `0` | Knative default = no per-pod limit (nginx is happy with many). |
| `resources.requests.memory` | `32Mi` | nginx + ~10 MiB of static assets. |

## Verify a signed chart

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/stephane-segning/opfs-webauthn/\.github/workflows/deploy-web\.yml@.*$' \
  ghcr.io/stephane-segning/charts/opfs-web:0.1.0
```

## Verify cross-origin isolation after deploy

The headers are the load-bearing reason this chart exists. In the
browser console at the live URL:

```js
crossOriginIsolated         // true
typeof SharedArrayBuffer    // "function"
```

If either is `false`/`"undefined"`, the nginx config didn't ship
or the ingress is stripping headers — open both via `curl -I` to
see what's reaching the browser.
