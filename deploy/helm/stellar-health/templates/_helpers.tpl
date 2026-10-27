{{- define "sh.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sh.fullname" -}}
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

{{- define "sh.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "sh.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component: include "sh.selector" (list . "api") */}}
{{- define "sh.selector" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ include "sh.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* Image for one component: include "sh.image" (list . "api") */}}
{{- define "sh.image" -}}
{{- $root := index . 0 -}}
{{- $img := $root.Values.image -}}
{{- printf "%s/%s-%s:%s" $img.registry $img.repository (index . 1) (default $root.Chart.AppVersion $img.tag) -}}
{{- end -}}

{{- define "sh.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "sh.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "sh.secretName" -}}
{{- default (printf "%s-app" (include "sh.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{- define "sh.postgresHost" -}}
{{- printf "%s-postgresql" (include "sh.fullname" .) -}}
{{- end -}}

{{- define "sh.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- printf "redis://%s-redis:6379" (include "sh.fullname" .) -}}
{{- else -}}
{{- required "externalRedis.url is required when redis.enabled is false" .Values.externalRedis.url -}}
{{- end -}}
{{- end -}}

{{/*
Postgres password: the given value, else the one stored by a previous release, else random.
The result is written back into .Values so every template in this render sees the same value.
*/}}
{{- define "sh.postgresPassword" -}}
{{- if not .Values.postgresql.password -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-postgresql" (include "sh.fullname" .)) -}}
{{- if and $existing $existing.data (index $existing.data "password") -}}
{{- $_ := set .Values.postgresql "password" (index $existing.data "password" | b64dec) -}}
{{- else -}}
{{- $_ := set .Values.postgresql "password" (randAlphaNum 32) -}}
{{- end -}}
{{- end -}}
{{- .Values.postgresql.password -}}
{{- end -}}

{{/* Environment shared by the api, worker and migration containers. */}}
{{- define "sh.appEnv" -}}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "sh.secretName" . }}, key: DATABASE_URL } }
- name: REDIS_URL
  {{- if and .Values.existingSecret (not .Values.redis.enabled) }}
  valueFrom: { secretKeyRef: { name: {{ include "sh.secretName" . }}, key: REDIS_URL } }
  {{- else }}
  value: {{ include "sh.redisUrl" . | quote }}
  {{- end }}
- name: SECRETS_ENCRYPTION_KEY
  valueFrom: { secretKeyRef: { name: {{ include "sh.secretName" . }}, key: SECRETS_ENCRYPTION_KEY } }
- name: NODE_ENV
  value: production
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
- name: TESTNET_RPC_URL
  value: {{ .Values.config.testnetRpcUrl | quote }}
- name: MAINNET_RPC_URL
  value: {{ .Values.config.mainnetRpcUrl | quote }}
- name: FUTURENET_RPC_URL
  value: {{ .Values.config.futurenetRpcUrl | quote }}
{{- with .Values.config.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Writable scratch space, since the root filesystem is read-only. */}}
{{- define "sh.tmpVolume" -}}
- name: tmp
  emptyDir: {}
{{- end -}}
