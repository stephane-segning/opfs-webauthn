{{/*
Common chart helpers — name, fullname, labels, selectorLabels.
Standard Helm chart idiom; kept here so the templates stay declarative
and the naming logic has exactly one home.
*/}}

{{- define "opfs-share-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opfs-share-backend.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "opfs-share-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opfs-share-backend.labels" -}}
helm.sh/chart: {{ include "opfs-share-backend.chart" . }}
{{ include "opfs-share-backend.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: rendezvous-api
{{- end -}}

{{- define "opfs-share-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opfs-share-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Compose the full image reference. Lets Image Updater (or a
per-env overlay) override either `image.repository` or `image.tag`
without forcing both.

Tag resolution:
  1. `.Values.image.tag` if set (ArgoCD Image Updater writes the
     resolved digest here on every promotion).
  2. else `.Chart.AppVersion` — the publish workflow rewrites this
     to the `<short-sha>` it just pushed so a released chart pins
     to a real image.
  3. else `"latest"` — fallback for a fresh `helm install` from
     repo source before CI has bumped `appVersion`. The build
     workflow always pushes a `:latest` tag, so this is a real,
     resolvable image; it's just mutable, which is fine for a dev
     install and irrelevant in production (Updater rewrites it).
*/}}
{{- define "opfs-share-backend.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion | default "latest" -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
