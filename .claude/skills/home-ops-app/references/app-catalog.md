# App Catalog

Pre-filled settings for all apps planned in SETUP.md.

When the user asks to add an app listed here, present these values for confirmation rather than asking from scratch. Values marked `CHANGEME` need the user to supply them.

Port note: ports listed are internal container ports. They do not conflict between apps.

---

## default namespace

### homepage

| Field | Value |
|-------|-------|
| Image | `ghcr.io/gethomepage/homepage` |
| Port | `3000` |
| Ingress | `envoy-internal` |
| PVC | No (config lives in ConfigMap alongside manifests) |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Service discovery via Kubernetes annotations on Service resources. Config is YAML in a ConfigMap, not a database. |

---

## network namespace

### adguard-home

| Field | Value |
|-------|-------|
| Image | `adguard/adguardhome` |
| Port | `3000` (web UI), `53` (DNS) |
| Ingress | `envoy-internal` (web UI only) |
| PVC | Yes — `2Gi` (config state) |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Deploy as DaemonSet for HA (one pod per node). DNS port 53 needs hostNetwork or dedicated LoadBalancer IP. |

### unifi-dns

| Field | Value |
|-------|-------|
| Image | `ghcr.io/kashalls/external-dns-unifi-webhook` |
| Port | `8888` |
| Ingress | No (internal service only) |
| PVC | No |
| Volsync | No |
| SOPS secrets | Yes — `UNIFI_HOST`, `UNIFI_USER`, `UNIFI_PASSWORD` |
| dependsOn | None |
| Notes | Sidecar/webhook for external-dns. Watches HTTPRoute resources and writes DNS records to UniFi gateway. |

---

## monitoring namespace

### kube-prometheus-stack

| Field | Value |
|-------|-------|
| Image | Bundled chart (Prometheus + Grafana + Alertmanager) |
| Port | `3000` (Grafana), `9090` (Prometheus) |
| Ingress | `envoy-internal` (Grafana only) |
| PVC | Yes — Prometheus: `20Gi`, Grafana: `2Gi` |
| Volsync | No (rebuildable metrics; Grafana config in code) |
| SOPS secrets | Yes — `GF_SECURITY_ADMIN_PASSWORD` |
| dependsOn | None |
| Notes | Use the `kube-prometheus-stack` Helm chart. Grafana datasources and dashboards configured via chart values. |

### alloy

| Field | Value |
|-------|-------|
| Image | `grafana/alloy` |
| Port | `12345` |
| Ingress | No |
| PVC | No |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Deploy as DaemonSet. Tails container logs on every node and ships to Loki. Config via ConfigMap. |

### loki

| Field | Value |
|-------|-------|
| Image | `grafana/loki` |
| Port | `3100` |
| Ingress | No (queried via Grafana datasource) |
| PVC | Yes — `10Gi` |
| Volsync | No (logs are not critical to back up) |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Receives logs from Alloy via HTTP push. Start with `filesystem` storage mode for Phase 1. |

### gatus

| Field | Value |
|-------|-------|
| Image | `ghcr.io/twin/gatus` |
| Port | `8080` |
| Ingress | `envoy-external` (public status page) |
| PVC | Yes — `1Gi` (SQLite) |
| Volsync | No |
| SOPS secrets | Yes — `NTFY_TOKEN` (alert notifications) |
| dependsOn | None |
| Notes | Deploy as StatefulSet. Config via ConfigMap. Optional gatus-sidecar container auto-discovers HTTPRoute endpoints. Needs ClusterRole to read cluster resources. |

### ntfy

| Field | Value |
|-------|-------|
| Image | `binwiederhier/ntfy` |
| Port | `80` |
| Ingress | `envoy-internal` |
| PVC | Yes — `2Gi` (SQLite message history, optional) |
| Volsync | No |
| SOPS secrets | No (or optional auth token) |
| dependsOn | None |
| Notes | Push notification server. Mobile app subscribes without Google/Apple accounts. Receives alerts from Gatus, Alertmanager, n8n. |

### smartctl-exporter

| Field | Value |
|-------|-------|
| Image | `ghcr.io/prometheus-community/smartctl-exporter` |
| Port | `9633` |
| Ingress | No |
| PVC | No |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Deploy as DaemonSet. Needs `privileged: true` and `/dev/sda` host device access to read SMART data. Exposes Prometheus metrics. |

### unifi-poller

| Field | Value |
|-------|-------|
| Image | `ghcr.io/unpoller/unpoller` |
| Port | `9130` |
| Ingress | No |
| PVC | No |
| Volsync | No |
| SOPS secrets | Yes — `UP_UNIFI_DEFAULT_USER`, `UP_UNIFI_DEFAULT_PASS`, `UP_UNIFI_DEFAULT_URL` |
| dependsOn | None |
| Notes | Scrapes UDM Pro API and exposes Prometheus metrics. Grafana dashboard ID: `11315`. |

---

## database namespace

### cloudnativepg

| Field | Value |
|-------|-------|
| Image | Operator chart (`cnpg/cloudnative-pg`) |
| Port | N/A (operator only, clusters defined separately) |
| Ingress | No |
| PVC | Yes (per cluster, defined in cluster YAML) |
| Volsync | No (clusters are rebuildable; WAL archiving skipped for Phase 1) |
| SOPS secrets | No (cluster CRs define credentials) |
| dependsOn | None |
| Notes | Install the operator first; then define Cluster CRs for authentik, n8n, homeassistant, prometheus databases. Use TimescaleDB image for homeassistant and prometheus clusters. |

### redis (valkey)

| Field | Value |
|-------|-------|
| Image | `valkey/valkey` |
| Port | `6379` |
| Ingress | No (internal only) |
| PVC | No (`emptyDir` — ephemeral cache only) |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Used as ephemeral cache by Authentik. Loss of Redis forces re-authentication only. No backup needed. |

### qdrant

| Field | Value |
|-------|-------|
| Image | `qdrant/qdrant` |
| Port | `6333` (HTTP), `6334` (gRPC) |
| Ingress | No (internal only, accessed by n8n) |
| PVC | Yes — `10Gi` |
| Volsync | No (rebuildable embeddings) |
| SOPS secrets | No (or optional API key) |
| dependsOn | None |
| Notes | Vector database for RAG pipelines. Queried by n8n workflows. |

---

## media namespace

### jellyfin

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/jellyfin` |
| Port | `8096` |
| Ingress | `envoy-external` |
| PVC | Yes — `10Gi` (config/metadata; media on NFS in Phase 3) |
| Volsync | No (rebuildable metadata) |
| SOPS secrets | No |
| dependsOn | `intel-gpu-resource-driver` |
| Notes | Intel QuickSync via `i915`. Add resource claim for GPU: `resourceClaimTemplateName: jellyfin`. In Phase 1, media is on local-path PVC; in Phase 3, mount NFS share at `/media`. |

### qbittorrent

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/qbittorrent` |
| Port | `8080` |
| Ingress | `envoy-internal` |
| PVC | Yes — `5Gi` config + large downloads PVC |
| Volsync | No |
| SOPS secrets | Yes — `GLUETUN_WIREGUARD_PRIVATE_KEY`, `GLUETUN_WIREGUARD_ADDRESSES` (VPN creds) |
| dependsOn | None |
| Notes | Requires Gluetun sidecar container for VPN (shared network namespace). Gluetun needs `NET_ADMIN` capability and `/dev/net/tun` device. Talos needs `tun` kernel module enabled in schematic. |

### prowlarr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/prowlarr` |
| Port | `80` (override via `PROWLARR__SERVER__PORT: 80`) |
| Ingress | `envoy-internal` |
| PVC | Yes — `5Gi` |
| Volsync | Yes |
| SOPS secrets | Yes — `PROWLARR__AUTH__APIKEY` |
| dependsOn | None |
| Notes | Indexer manager. Connects to Radarr, Sonarr, qBittorrent. VOLSYNC_CAPACITY: 5Gi |

### radarr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/radarr` |
| Port | `80` (override via `RADARR__SERVER__PORT: 80`) |
| Ingress | `envoy-internal` |
| PVC | Yes — `5Gi` |
| Volsync | Yes |
| SOPS secrets | Yes — `RADARR__AUTH__APIKEY` |
| dependsOn | None |
| Notes | Movie management. VOLSYNC_CAPACITY: 5Gi |

### sonarr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/sonarr` |
| Port | `80` (override via `SONARR__SERVER__PORT: 80`) |
| Ingress | `envoy-internal` |
| PVC | Yes — `5Gi` |
| Volsync | Yes |
| SOPS secrets | Yes — `SONARR__AUTH__APIKEY` |
| dependsOn | None |
| Notes | TV show management. VOLSYNC_CAPACITY: 5Gi |

### bazarr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/home-operations/bazarr` |
| Port | `6767` |
| Ingress | `envoy-internal` |
| PVC | Yes — `5Gi` |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Subtitle management. Connects to Radarr and Sonarr. |

### flaresolverr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/flaresolverr/flaresolverr` |
| Port | `8191` |
| Ingress | No (internal only, used by Prowlarr) |
| PVC | No |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Cloudflare bypass utility for Prowlarr. No web UI needed. |

### recyclarr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/recyclarr/recyclarr` |
| Port | N/A |
| Ingress | No |
| PVC | No |
| Volsync | No |
| SOPS secrets | Yes — `RADARR_API_KEY`, `SONARR_API_KEY` |
| dependsOn | `radarr`, `sonarr` |
| Notes | Deploy as a CronJob (not a Deployment). Runs on schedule to sync TRaSH Guide quality profiles. Use `controllers.<app>.type: cronjob` in app-template. |

### seerr

| Field | Value |
|-------|-------|
| Image | `ghcr.io/seerr-team/seerr` |
| Port | `5055` |
| Ingress | `envoy-external` |
| PVC | Yes — `5Gi` |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | `jellyfin` |
| Notes | Media request management for Jellyfin. Phase 1: local-path PVC for config. |

---

## automation namespace

### n8n

| Field | Value |
|-------|-------|
| Image | `ghcr.io/n8n-io/n8n` |
| Port | `5678` |
| Ingress | `envoy-internal` |
| PVC | No (state in PostgreSQL) |
| Volsync | No (PostgreSQL is the source of truth) |
| SOPS secrets | Yes — `DB_POSTGRESDB_PASSWORD`, `N8N_ENCRYPTION_KEY` |
| dependsOn | `cloudnativepg` |
| Notes | Workflow automation. Uses PostgreSQL via CloudNativePG. Set `DB_TYPE=postgresdb` env vars. |

### crawl4ai

| Field | Value |
|-------|-------|
| Image | `ghcr.io/unclecode/crawl4ai` |
| Port | `11235` |
| Ingress | `envoy-internal` |
| PVC | No |
| Volsync | No |
| SOPS secrets | Yes — `OPENAI_API_KEY` |
| dependsOn | None |
| Notes | Needs emptyDir with `medium: Memory` and `sizeLimit: 1Gi` at `/dev/shm` (replaces Docker's `shm_size`). |

---

## security namespace

### authentik

| Field | Value |
|-------|-------|
| Image | `ghcr.io/goauthentik/server` |
| Port | `9000` (server), `9300` (metrics) |
| Ingress | `envoy-external` |
| PVC | No (state in PostgreSQL; Redis is ephemeral) |
| Volsync | No (PostgreSQL is the source of truth) |
| SOPS secrets | Yes — `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_POSTGRESQL__PASSWORD`, `AUTHENTIK_REDIS__PASSWORD` (optional) |
| dependsOn | `cloudnativepg`, `redis` |
| Notes | Deploy both `server` and `worker` containers in the same HelmRelease. High priority for backup (indirectly via CloudNativePG). |

---

## productivity namespace

### excalidraw

| Field | Value |
|-------|-------|
| Image | `excalidraw/excalidraw` |
| Port | `80` |
| Ingress | `envoy-internal` |
| PVC | No (stateless) |
| Volsync | No |
| SOPS secrets | No |
| dependsOn | None |
| Notes | Stateless whiteboard app. No database. Just a static web UI. uid/gid: 101. |
