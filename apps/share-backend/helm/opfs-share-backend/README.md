# opfs-share-backend (Helm chart)

Knative `Service` for the opfs-webauthn share rendezvous
([ADR 0012](../../../../docs/adrs/0012-self-hosted-rust-share-backend.md)).

## Install from OCI

The chart is published as an OCI artifact to GHCR alongside the
container image. Both are signed keylessly via Sigstore by the
build workflow.

Pick a published version (the build workflow auto-bumps the patch
version per push to `main`, so `0.1.0` from this source tree is
**not** what's on the registry):

```sh
helm pull oci://ghcr.io/stephane-segning/charts/opfs-share-backend --version 0.1.42
# or, inline:
helm install opfs-share-backend \
  oci://ghcr.io/stephane-segning/charts/opfs-share-backend \
  --version 0.1.42 \
  --namespace opfs --create-namespace
```

Or, for ArgoCD, point the `Application` `source` at the OCI
chart instead of a Git path:

```yaml
spec:
  source:
    repoURL: ghcr.io/stephane-segning/charts
    chart: opfs-share-backend
    targetRevision: 0.1.*
    helm:
      values: |
        env:
          # Required — the chart default is empty, which rejects
          # every Origin'd request with 403. See below.
          allowedOrigins: https://opfs-web.opfs.example.com
```

See `../argocd-application.example.yaml` for the full `Application`
with cosign verification + Image Updater annotations.

## Configuration

The full set of knobs is in [`values.yaml`](./values.yaml). The
common overrides:

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` | `ghcr.io/stephane-segning/opfs-share-backend` | Forks / org migrations override here. |
| `image.tag` | `""` (→ `Chart.AppVersion` → `latest`) | Published charts pin AppVersion to a short SHA; Image Updater rewrites this to digest. |
| `autoscaling.maxScale` | `"1"` | The in-memory store is per-pod; raising this needs a shared store first. |
| `env.allowedOrigins` | `""` (rejects all) | **Set per cluster.** Comma-separated CORS list. Empty default means every Origin'd request gets 403 — the failure surfaces immediately instead of after a successful-looking POST. |
| `env.trustedIpHeader` | `x-real-ip` | Per-IP rate-limit key; never `X-Forwarded-For`. |

### Configuring `allowedOrigins`

The frontend (`opfs-web`) and this backend land on two different
Knative-assigned hostnames in the same cluster (ADR 0014, runtime
config). The browser issues cross-origin POSTs, which the CORS
middleware gates on `ALLOWED_ORIGINS`. The cluster knows the
frontend hostname; the chart doesn't, so the default is empty.

Set it to the value `kubectl` reports for the frontend KSvc:

```sh
kubectl -n opfs get ksvc opfs-web -o jsonpath='{.status.url}'
```

…and write that into the ArgoCD `Application` values block.
Comma-separate for preview / staging environments.

## Verify a signed chart

The build workflow signs the chart's OCI digest the same way it
signs the container image. The signing identity is this repo's
deploy workflow on `main`:

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/stephane-segning/opfs-webauthn/\.github/workflows/deploy-share-backend\.yml@.*$' \
  ghcr.io/stephane-segning/charts/opfs-share-backend:0.1.0
```

`cosign verify` exits non-zero (and prints "no matching signatures")
on any chart that wasn't signed by this workflow. Use it in your
admission policy or in a manual install gate.

## Local development

```sh
# Render the manifest without installing.
helm template opfs-share-backend \
  apps/share-backend/helm/opfs-share-backend \
  --namespace opfs

# Lint.
helm lint apps/share-backend/helm/opfs-share-backend

# Package locally.
helm package apps/share-backend/helm/opfs-share-backend
```
