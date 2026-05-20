# opfs-share-backend (Helm chart)

Knative `Service` for the opfs-webauthn share rendezvous
([ADR 0012](../../../../docs/adrs/0012-self-hosted-rust-share-backend.md)).

## Install from OCI

The chart is published as an OCI artifact to GHCR alongside the
container image. Both are signed keylessly via Sigstore by the
build workflow.

```sh
helm install opfs-share-backend \
  oci://ghcr.io/stephane-segning/charts/opfs-share-backend \
  --version 0.1.0 \
  --namespace opfs --create-namespace
```

Or, for ArgoCD, point the `Application` `source` at the OCI
chart instead of a Git path:

```yaml
spec:
  source:
    repoURL: ghcr.io/stephane-segning/charts
    chart: opfs-share-backend
    targetRevision: 0.1.0
    helm:
      values: |
        env:
          allowedOrigins: https://ocs.vaam.store
```

See `../argocd-application.example.yaml` for the full `Application`
with cosign verification + Image Updater annotations.

## Configuration

The full set of knobs is in [`values.yaml`](./values.yaml). The
common overrides:

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` | `ghcr.io/stephane-segning/opfs-share-backend` | Forks / org migrations override here. |
| `image.tag` | `""` (→ `Chart.AppVersion`) | Image Updater rewrites this to pin digests. |
| `autoscaling.maxScale` | `"1"` | The in-memory store is per-pod; raising this needs a shared store first. |
| `env.allowedOrigins` | `https://ocs.vaam.store` | Comma-separated CORS list. |
| `env.trustedIpHeader` | `x-real-ip` | Per-IP rate-limit key; never `X-Forwarded-For`. |

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
