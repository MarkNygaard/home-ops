# Deployment Checklist

Step-by-step guide to follow when the servers arrive. Work top to bottom — each phase depends on the one above it. See [SETUP.md](SETUP.md) for the reasoning behind each decision.

---

### Do this now — no servers needed

- [x] Fork / create your repo from the cluster-template
- [x] Install mise and run `mise install` to get all tooling
- [x] **Collect secrets from your current Docker setup** — copy `secrets.env.sample` to `.private/secrets.env` and fill in all values from your existing Docker Compose configs (API keys, passwords, WireGuard keys, etc.). `.private/` is gitignored. Having everything in one place before you start avoids hunting through old configs mid-setup.
- [x] Install the Renovate GitHub App on your repo
- [x] Extend Renovate config: create `.renovate/autoMerge.json5` and `.renovate/groups.json5` (see Renovate section in SETUP.md). Also update `.renovaterc.json5`: set timezone to `Europe/Copenhagen` and add `ignorePaths: ["**/resources/**"]` to prevent Renovate scanning Gatus config files.
- [x] Create a Cloudflare R2 bucket (`cluster-volsync`) and generate an API token for it
- [x] Create a Cloudflare Tunnel in the Cloudflare dashboard and download the credentials file as `cloudflare-tunnel.json` into the repo root — this is required before `task template:configure`
- [x] Run `task template:init` — this renames the `.sample` config files, generates your `age.key` (SOPS encryption), and generates a `github-deploy.key` (SSH key pair for Flux)
- [x] Fill in `cluster.yaml` with your domain, Cloudflare token, gateway IPs, and repo name
- [x] Generate a schematic at factory.talos.dev with: `siderolabs/intel-ucode`, `siderolabs/i915`, `siderolabs/mei`, `siderolabs/thunderbolt` — note the schematic ID
- [x] Add the deploy key to GitHub: open `github-deploy.key.pub`, paste it into your repo → Settings → Deploy keys → Add deploy key (read-only is enough). This is how Flux authenticates to read your repo.
- [x] Download the Talos ISO from factory.talos.dev (keep it ready for JetKVM)

---

### 1 — Talos bootstrap

Servers are in hand from here.

- [ ] Connect all 3 Thunderbolt 4 cables (full mesh) before powering the nodes on — interfaces must be present at first boot
- [ ] For each node: enter BIOS via JetKVM and set Thunderbolt security level to **No Security** — required for the TB4 link to establish between nodes
- [ ] Boot each node via JetKVM virtual media — upload the ISO in the JetKVM web UI, mount it as a virtual USB drive, then boot the node from it. No physical USB drive needed.
- [ ] For each node: run `talosctl get disks -n <ip> --insecure` and `talosctl get links -n <ip> --insecure` to find `disk`, `mac_addr`, and TB4 interface names/PCI paths
- [ ] Fill in `schematic_id`, `disk`, `mac_addr`, and `address` for each node in `nodes.yaml`
- [ ] Configure TB4 interfaces in your machineconfig using `deviceSelector.driver: thunderbolt_net` — do NOT use interface names or MAC addresses as both are unstable for TB4 (see Networking section in SETUP.md)
- [ ] Run `task template:configure` — renders all configs from `cluster.yaml`/`nodes.yaml`, validates schemas, and encrypts all SOPS secrets
- [ ] Run `task bootstrap:talos` to initialise the cluster
- [ ] Verify the cluster is healthy: `kubectl get nodes` — all three should show `Ready`
- [ ] Run `task bootstrap:apps` to deploy Flux and all base applications
- [ ] Verify Flux is running: `flux get kustomizations` — all should show `Applied revision`
- [ ] Deploy the Flux Operator (`flux-operator` HelmRelease + `FluxInstance` CRD) — once running, the operator manages the Flux lifecycle and the CLI-bootstrapped Flux can be removed (see SETUP.md for details)
- [ ] Set up `flux-operator-mcp` locally in Claude Code — gives Claude access to Flux resources, failure tracing, and root cause analysis. Do this now so Claude can help debug issues throughout the rest of the deployment.
- [ ] Run `task template:tidy` — archives the template files (cluster.yaml, nodes.yaml, templates/) that are no longer needed after bootstrap

---

### 2 — kube-system prerequisites

Deploy these before anything else — other apps depend on them.

- [ ] `kube-system/snapshot-controller` — required by Volsync; deploy first
- [ ] `kube-system/intel-gpu-resource-driver` — required by Jellyfin QuickSync
- [ ] `kube-system/system-upgrade` — Talos upgrade controller + UpgradePlan

---

### 3 — Networking

The template already deploys Envoy Gateway, cert-manager, external-dns, and cloudflared. Add the apps that aren't in the template:

- [ ] `network/adguard-home` — deploy and point your router's DNS at the cluster IP
- [ ] `network/unifi-dns` — auto DNS via external-dns-unifi-webhook (controller runs on UDM Pro)
- [ ] Verify HTTPRoutes resolve correctly via AdGuard and Cloudflare Tunnel

---

### 4 — Databases

Must be running before any app that needs PostgreSQL.

- [ ] `database/cloudnativepg` — deploy the operator first, wait for it to be ready
- [ ] `database/cloudnativepg` cluster — deploy `cluster.yaml` (TimescaleDB image), wait for cluster to show `Cluster in healthy state`
- [ ] `database/redis` — deploy

---

### 5 — Security & Identity

- [ ] `security/authentik` — deploy; on first boot open the web UI and complete the initial setup wizard (creates the default admin account)
- [ ] Configure Authentik providers and applications for each app you want SSO on
- [ ] Configure forward auth on Envoy Gateway HTTPRoutes for protected apps

---

### 6 — Observability

- [ ] `monitoring/kube-prometheus-stack` — Prometheus + Grafana + Alertmanager
- [ ] `monitoring/loki` — log aggregation
- [ ] `monitoring/alloy` — deploy after Loki; collects pod logs on every node and ships to Loki
- [ ] `monitoring/ntfy` — deploy first so Gatus and Alertmanager have somewhere to send alerts
- [ ] `monitoring/gatus` — deploy; annotate HTTPRoutes with `gatus.home-operations.com/enabled: "true"` as you add apps
- [ ] `monitoring/smartctl-exporter` — NVMe SMART metrics
- [ ] `monitoring/unifi-poller` — UniFi metrics; import Grafana dashboard ID `11315`
- [ ] `monitoring/flux-webui` — Flux Operator Web UI for live cluster inventory
- [ ] Configure Alertmanager webhook → ntfy-alertmanager → Ntfy topic
- [ ] Add Flux → Grafana annotations: deploy a Grafana `Provider` + `Alert` in `flux-system` so Flux deployments appear as markers on Grafana dashboards

---

### 7 — Backup

- [ ] `storage/volsync` — deploy the operator
- [ ] Add the volsync component to `radarr`, `sonarr`, `prowlarr`, and `authentik` kustomization files
- [ ] Verify first backup completes: `kubectl get replicationsources -A`

---

### 8 — Media

Deploy in this order to avoid broken links between apps.

- [ ] `media/jellyfin` — verify hardware transcoding works (check logs for `i915` device)
- [ ] `media/prowlarr` — add indexers
- [ ] `media/radarr` — connect to Prowlarr and qBittorrent
- [ ] `media/sonarr` — connect to Prowlarr and qBittorrent
- [ ] `media/bazarr` — connect to Radarr and Sonarr
- [ ] `media/flaresolverr` — add as a proxy in Prowlarr (internal only, no HTTPRoute)
- [ ] `media/qbittorrent` (+ Gluetun sidecar) — verify VPN tunnel is up before adding to Radarr/Sonarr
- [ ] `media/recyclarr` — deploy CronJob, run once manually to apply TRaSH Guides profiles
- [ ] `media/seerr` — connect to Jellyfin, Radarr, and Sonarr
- [ ] Configure Ntfy webhooks in Radarr, Sonarr, and Seerr (Settings → Notifications → Webhook)

---

### 9 — Dashboard

- [ ] `default/homepage` — configure service groups; add Homepage annotations to each app's Service as you go

---

### 10 — Automation & AI

These have no hard dependencies on the media stack — deploy whenever you're ready.

- [ ] `automation/n8n` — deploy; connect to PostgreSQL
- [ ] `database/qdrant` — deploy with persistent storage
- [ ] `automation/crawl4ai` — deploy with `emptyDir` shm volume (replaces Docker's `shm_size`); add OpenAI API key as SOPS secret

---

### 11 — Productivity

- [ ] `productivity/excalidraw` — deploy; expose via HTTPRoute behind Authentik forward auth

---

### Post-deployment — local tooling

These run on your development machine, not in the cluster.

- [ ] Set up `grafana/mcp-grafana` in Claude Code — gives Claude read access to Loki logs, Prometheus metrics, dashboards, and annotations

---

### Done

At this point the full Phase 1 cluster is running. Renovate will start opening PRs for dependency updates automatically. When the NAS arrives, continue with Phase 3 (democratic-csi, KEDA, nfs-scaler, UniFi migration).
