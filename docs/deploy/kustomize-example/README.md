# Reference kustomize overlay

A complete, kustomize-build-able tree for deploying opfs-webauthn
via ArgoCD with GitHub Deployments notifications wired up. Drop
into your GitOps repo, fork the placeholder strings to your
cluster, and apply.

## Layout

```
docs/deploy/kustomize-example/
├── README.md                         (you are here)
├── kustomization.yaml                entry point
├── opfs-web.patch.yaml               JSON6902 patches for opfs-web Application
├── opfs-share-backend.patch.yaml     JSON6902 patches for opfs-share-backend Application
└── argocd-notifications-cm.yaml      argocd-notifications config + GitHub templates
```

`kustomization.yaml` pulls both `argocd-application.example.yaml`
files from this repo's `main` branch as `resources:`, applies the
per-app patches, and includes the notifications ConfigMap. Output
is three Kubernetes objects in namespace `argocd`:

- `Application/opfs-web`
- `Application/opfs-share-backend`
- `ConfigMap/argocd-notifications-cm`

## What you have to change before applying

### 1. URLs in the patch files

Each patch file sets the URL knobs hardcoded for the example
cluster — replace them with your own:

| File | Field | Default |
|------|-------|---------|
| `opfs-web.patch.yaml` | `env.shareBackendUrl` | `https://opfs-share-backend-opfs--sls.ssegning.com` |
| `opfs-web.patch.yaml` | `opfs.vaam.store/url` annotation | `https://opfs-web-opfs--sls.ssegning.com` |
| `opfs-share-backend.patch.yaml` | `env.allowedOrigins` | `https://opfs-web-opfs--sls.ssegning.com` |
| `opfs-share-backend.patch.yaml` | `opfs.vaam.store/url` annotation | `https://opfs-share-backend-opfs--sls.ssegning.com` |

Discover the Knative-assigned URLs in your cluster with:

```sh
kubectl -n opfs get ksvc opfs-web opfs-share-backend \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.status.url}{"\n"}{end}'
```

### 2. GitOps repo URL + write-back target

In both patches, the Image Updater annotations point at a
placeholder GitOps repo:

```yaml
- op: replace
  path: /metadata/annotations/argocd-image-updater.argoproj.io~1git-repository
  value: https://github.com/stephane-segning/<your-gitops-repo>.git
- op: replace
  path: /metadata/annotations/argocd-image-updater.argoproj.io~1write-back-target
  value: helmvalues:envs/production/opfs-<app>.values.yaml
```

Use HTTPS form (not SSH) — the existing `repo-creds` Secret
authenticates via the GitHub App's installation token, which is
HTTPS basic-auth only.

### 3. ArgoCD UI URL

In `argocd-notifications-cm.yaml`, the `context` block has:

```yaml
context: |
  argocdUrl: https://argocd.example.com
```

Replace with your real ArgoCD UI URL. This shows up as the
`logURL` on each GitHub Deployment status.

### 4. GitHub App IDs

The notifications ConfigMap's `service.github` has placeholders
for the App's numeric `appID` and `installationID`:

```yaml
service.github: |
  appID: <YOUR_APP_ID>
  installationID: <YOUR_INSTALLATION_ID>
  privateKey: $github-privateKey
```

Copy them from your existing repo-creds Secret:

```sh
kubectl -n argocd get secret github-app-creds--stephane-segning \
  -o jsonpath='{.data.githubAppID}' | base64 -d
kubectl -n argocd get secret github-app-creds--stephane-segning \
  -o jsonpath='{.data.githubAppInstallationID}' | base64 -d
```

### 5. GitHub repo the Deployments land on

Both templates in `argocd-notifications-cm.yaml` have:

```yaml
repoURLPath: '{{ "https://github.com/<your-org>/<your-repo>" }}'
```

Set this to **the repo your GitHub App is installed on with
`Deployments: write`**. If the App can't reach the URL the
controller logs `403/404` and no Deployment is posted. For
operators tracking opfs-webauthn directly, this is
`https://github.com/stephane-segning/opfs-webauthn`; for forks,
your fork URL.

Edit it in **both** the `template.app-deployed` and
`template.app-deployed-failed` blocks.

## Secret that lives **outside** kustomize

The notifications controller reads `$github-privateKey` from a
`Secret` named `argocd-notifications-secret` in the `argocd`
namespace. The private key has to land there — the GitOps repo
isn't the place for it (use sealed-secrets / external-secrets /
SOPS / whatever you have).

If you already have the App key in your existing repo-creds
Secret, pipe it directly — no on-disk intermediate so the
private key never persists if the command is interrupted
between `kubectl get` and `kubectl create`:

```sh
kubectl -n argocd get secret github-app-creds--stephane-segning \
  -o jsonpath='{.data.githubAppPrivateKey}' \
  | base64 -d \
  | kubectl -n argocd create secret generic argocd-notifications-secret \
      --from-file=github-privateKey=/dev/stdin \
      --dry-run=client -o yaml \
  | kubectl apply -f -
```

If `argocd-notifications-secret` already exists with other tokens
(Slack, email auth, etc.), `kubectl patch` it instead — the
above command will overwrite the whole Secret with just the one
key.

## App permissions checklist

The GitHub App backing `repo-creds` needs three permission grants
for everything in this overlay to function. Check at
`https://github.com/settings/installations/{installationID}`:

| Scope | Read | Write | What it powers |
|-------|------|-------|----------------|
| Contents | ✅ | ✅ | ArgoCD source-fetch (read) + Image Updater write-back (write) |
| Deployments | — | ✅ | argocd-notifications GitHub Deployments creation |
| Metadata | ✅ | — | Implicit for any App |

If any are still on the install's default Read or unset, change
them on the App's permissions page and re-acknowledge on the
installation page.

## Apply

```sh
# Render to stdout to sanity-check
kustomize build docs/deploy/kustomize-example/

# Or via kubectl
kubectl apply -k docs/deploy/kustomize-example/
```

`Application` resources land in `argocd`; ArgoCD picks them up
and starts reconciling.

## Verifying the notifications side

After the first successful sync of either Application:

1. `kubectl -n argocd logs deploy/argocd-notifications-controller --tail=200` — should show `"trigger triggered" trigger=on-deployed app=opfs-web` and `"notification sent"` lines.
2. Refresh <https://github.com/stephane-segning/opfs-webauthn/deployments> — a new Environment per app appears, with a green-rocket "Active" badge linking to the URL annotation you set.
3. The repo home sidebar shows the same active deploys.

If nothing posts:

- Re-check the App's `Deployments: write` permission.
- Look for `level=error` in the notifications-controller logs; the GitHub service's error responses (404/403) get logged verbatim.

## Dropping the temporary image.tag override

Both patches currently override `image.tag: latest`. That's only
necessary until you've confirmed the published chart's
`AppVersion` matches a real short-SHA image tag on the registry
(post-PRs #37 + #38, this is true for any new release). Once
you'd rather pin to the chart's bundled tag (so Image Updater
can rewrite it to a digest), strip the `image:` block from each
`helm.values:` patch. The Helm chart's
`.Values.image.tag | default .Chart.AppVersion` resolution does
the right thing on its own.
