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
*/}}
{{- define "opfs-share-backend.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
