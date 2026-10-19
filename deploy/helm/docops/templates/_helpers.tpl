{{/*
Chart name, truncated to the 63 characters Kubernetes allows in a label value.
*/}}
{{- define "docops.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Release-scoped name: "<release>-<chart>", or just the release name when it already contains the chart name.
*/}}
{{- define "docops.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "docops.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels are shared by the API and every worker group. The NetworkPolicy selects on them, and
each Deployment adds its own app.kubernetes.io/component on top.
*/}}
{{- define "docops.selectorLabels" -}}
app.kubernetes.io/name: {{ include "docops.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "docops.labels" -}}
helm.sh/chart: {{ include "docops.chart" . }}
{{ include "docops.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: docops
{{- end }}

{{/* Names of the API and of one worker group. The worker helper takes (dict "root" $ "group" $group). */}}
{{- define "docops.apiName" -}}
{{- printf "%s-api" (include "docops.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "docops.workerName" -}}
{{- printf "%s-worker-%s" (include "docops.fullname" .root) .group.name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "docops.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "docops.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image reference. global.imageRegistry (a mirror) wins over image.registry; image.digest wins over image.tag.
*/}}
{{- define "docops.image" -}}
{{- $registry := default .Values.image.registry .Values.global.imageRegistry -}}
{{- $prefix := "" -}}
{{- if $registry -}}
{{- $prefix = printf "%s/" (trimSuffix "/" $registry) -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- printf "%s%s@%s" $prefix .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s%s:%s" $prefix .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end }}

{{/* The Secret that holds DATABASE_URL, and the Secret with the signing secrets, tokens and integration credentials. */}}
{{- define "docops.databaseSecretName" -}}
{{- default (printf "%s-database" (include "docops.fullname" .)) .Values.database.existingSecret }}
{{- end }}

{{- define "docops.secretName" -}}
{{- default (include "docops.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{/*
External base URL of the API: publicUrl, else the first ingress host, else the in-cluster service.
*/}}
{{- define "docops.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- trimSuffix "/" .Values.publicUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts -}}
{{- $host := (first .Values.ingress.hosts).host -}}
{{- if .Values.ingress.tls -}}
{{- printf "https://%s" $host -}}
{{- else -}}
{{- printf "http://%s" $host -}}
{{- end -}}
{{- else -}}
{{- printf "http://%s.%s.svc:%v" (include "docops.apiName" .) .Release.Namespace .Values.api.service.port -}}
{{- end -}}
{{- end }}

{{/*
Environment entries read from a Secret; every key is optional so that a Secret only needs the keys
it uses. Usage: include "docops.secretEnv" (dict "secret" "<name>" "keys" (list "A" "B")) | trim | nindent N
*/}}
{{- define "docops.secretEnv" -}}
{{- $secret := .secret -}}
{{- range $key := .keys }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- end }}

{{/*
Settings both roles need. Everything is optional or has a default, so nothing is rendered as an empty
string (an empty WORKER_QUEUES, for example, would mean "no queues").
*/}}
{{- define "docops.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "docops.databaseSecretName" . }}
      key: {{ .Values.database.secretKey }}
{{- end }}

{{/*
The API's S3 access key (objectStorage.type s3), from objectStorage.s3.credentials.existingSecret or else the
chart's Secret. The key ID and the secret are required, so that a missing key stops the pod with a clear event
instead of failing on the first upload; the session token is optional.
*/}}
{{- define "docops.s3Env" -}}
{{- $credentials := .Values.objectStorage.s3.credentials -}}
{{- $secret := default (include "docops.secretName" .) $credentials.existingSecret -}}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $credentials.accessKeyIdKey }}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $credentials.secretAccessKeyKey }}
- name: AWS_SESSION_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $credentials.sessionTokenKey }}
      optional: true
{{- end }}

{{/* One NetworkPolicy egress rule. Usage: include "docops.egressRule" (dict "to" <peers> "ports" <ports>) */}}
{{- define "docops.egressRule" -}}
- to:
    {{- toYaml .to | nindent 4 }}
  ports:
    {{- range .ports }}
    - protocol: TCP
      port: {{ . }}
    {{- end }}
{{- end }}

{{/*
Checks that fail the render with a clear message instead of producing a release that cannot work.
Called from configmap.yaml, which every Deployment includes for its checksum annotation.
*/}}
{{- define "docops.validate" -}}
{{- $root := . -}}
{{- $storage := .Values.objectStorage.type -}}
{{- if not (or (eq $storage "filesystem") (eq $storage "s3")) -}}
{{- fail (printf "objectStorage.type must be filesystem or s3, got %v" $storage) -}}
{{- end -}}
{{- if and (eq $storage "s3") (not .Values.objectStorage.s3.bucket) -}}
{{- fail "objectStorage.type is s3, but objectStorage.s3.bucket is empty: set it to the name of an existing bucket." -}}
{{- end -}}
{{- /* Blobs on the filesystem: every API replica needs the same ReadWriteMany claim. A bucket needs no shared volume. */ -}}
{{- if and (eq $storage "filesystem") (or .Values.api.autoscaling.enabled (gt (int .Values.api.replicaCount) 1)) (not .Values.objectStorage.filesystem.existingClaim) -}}
{{- fail "api.replicaCount is greater than 1 (or api.autoscaling.enabled is true), but objectStorage.filesystem.existingClaim is empty. With objectStorage.type filesystem every API replica needs the same ReadWriteMany PersistentVolumeClaim: create one and set objectStorage.filesystem.existingClaim, or keep the blobs in an S3-compatible bucket (objectStorage.type s3)." -}}
{{- end -}}
{{- /* The worker refuses to start unless WORKER_CONCURRENCY is a positive integer. */ -}}
{{- range $group := .Values.worker.groups -}}
{{- $concurrency := $root.Values.worker.concurrency -}}
{{- if hasKey $group "concurrency" -}}{{- $concurrency = $group.concurrency -}}{{- end -}}
{{- if or (lt (int $concurrency) 1) (ne (toString (int $concurrency)) (toString $concurrency)) -}}
{{- fail (printf "worker concurrency must be a positive integer, got %v (worker group %v)" $concurrency (get $group "name")) -}}
{{- end -}}
{{- end -}}
{{- end }}
