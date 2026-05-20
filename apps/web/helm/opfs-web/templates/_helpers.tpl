{{- define "opfs-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opfs-web.fullname" -}}
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

{{- define "opfs-web.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opfs-web.labels" -}}
helm.sh/chart: {{ include "opfs-web.chart" . }}
{{ include "opfs-web.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: frontend
{{- end -}}

{{- define "opfs-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opfs-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Tag resolution:
  1. `.Values.image.tag` if set (ArgoCD Image Updater writes the
     resolved digest here on every promotion).
  2. else `.Chart.AppVersion` — the publish workflow rewrites this
     to the `<short-sha>` it just pushed so a released chart pins
     to a real image.
  3. else `"latest"` — fallback for a fresh `helm install` from
     repo source before CI has bumped `appVersion`. The build
     workflow always pushes a `:latest` tag.
*/}}
{{- define "opfs-web.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion | default "latest" -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
