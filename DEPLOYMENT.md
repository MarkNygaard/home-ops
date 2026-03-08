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

- [x] Remove Pi-hole IP from UDM Pro DNS settings — let it fall back to default so the cluster nodes don't depend on the Docker VM for DNS
- [x] Connect all 3 Thunderbolt 4 cables (full mesh) **before** powering the nodes on — interfaces must be present at first boot
- [x] Connect RJ45 from each node to your UDM Pro/switch and assign those switch ports to the SERVERS VLAN (42) — nodes need network connectivity for discovery
- [x] Power on node 1, enter BIOS via JetKVM. The MS-01 BIOS has no dedicated Thunderbolt security setting — it defaults to allowing TB4 devices. Set **DMA Control Guarantee: Disabled** (required for TB4), **Control IOMMU Pre-boot: Enable IOMMU during boot**, and **Secure Boot: Disabled**. Repeat for node 2 and node 3 (move JetKVM between nodes).
- [x] Boot each node from the Talos ISO via JetKVM virtual media — upload the ISO in the JetKVM web UI, mount it as a virtual USB drive, then boot the node from it. No physical USB drive needed. Nodes will get temporary DHCP IPs on the SERVERS VLAN.
- [x] For each node: run `talosctl get disks -n <dhcp-ip> --insecure` and `talosctl get links -n <dhcp-ip> --insecure` to find `disk`, `mac_addr`, and TB4 interface names/PCI paths — use the temporary DHCP IPs (check UDM Pro client list)
- [x] Fill in `disk` and `mac_addr` for each node in `nodes.yaml` (`schematic_id` and `address` are already pre-filled)
- [x] (Optional) Create DHCP reservations on the UDM Pro for .100/.101/.102 using the discovered MACs — prevents IP conflicts, but not required since Talos sets static IPs at the OS level
- [x] Configure TB4 interfaces in your machineconfig using `deviceSelector.driver: thunderbolt-net` — per-node patches created in `templates/config/talos/patches/k8s-{0,1,2}/tb4-network.yaml.j2` + IOMMU kernel args in Image Factory schematic
- [x] Verify TB4 interfaces appear in `talosctl get links` output (look for `thunderbolt-net` in the driver column) — requires `thunderbolt_net` kernel module loaded via `machine.kernel.modules` patch
- [x] Run `task configure` — renders all configs from `cluster.yaml`/`nodes.yaml`, validates schemas, and encrypts all SOPS secrets
- [x] Push to GitHub — repo needs the generated configs and encrypted secrets before bootstrap
- [x] Run `task bootstrap:talos` — applies machineconfigs to each node (nodes switch from DHCP to their static IPs .100/.101/.102 automatically), initialises etcd, and fetches kubeconfig
- [x] Verify the cluster is healthy: `kubectl get nodes` — all three should show `Ready`
- [x] Run `task bootstrap:apps` to deploy Flux and all base applications
- [x] Verify Flux is running: `flux get kustomizations` — all should show `Applied revision`
- [x] Deploy the Flux Operator (`flux-operator` HelmRelease + `FluxInstance` CRD) — deployed via `bootstrap:apps` helmfile
- [x] Set up `flux-operator-mcp` locally in Claude Code — gives Claude access to Flux resources, failure tracing, and root cause analysis. Do this now so Claude can help debug issues throughout the rest of the deployment.
- [x] Run `task template:tidy` — archives the template files (cluster.yaml, nodes.yaml, templates/) that are no longer needed after bootstrap

---

### 2 — kube-system prerequisites

Deploy these before anything else — other apps depend on them.

- [x] `kube-system/snapshot-controller` — required by Volsync; deploy first
- [x] `kube-system/intel-gpu-resource-driver` — required by Jellyfin QuickSync
- [x] `kube-system/system-upgrade` — Talos upgrade controller (tuppr) + TalosUpgrade/KubernetesUpgrade CRs
- [x] `kube-system/local-path-provisioner` — local-path StorageClass (required for any app with PVCs)

---

### 3 — Networking

The template already deploys Envoy Gateway, cert-manager, external-dns, and cloudflared. Add the apps that aren't in the template:

- [x] `network/adguard-home` — deployed with DNS LoadBalancer on `192.168.42.14`
- [x] Verify AdGuard Home is running and reachable at `192.168.42.14`
- [x] Manually set UDM Pro DNS to `192.168.42.14` for Trusted, Servers, and IoT VLANs
- [x] Stop the Pi-hole container on the Docker VM — AdGuard Home is now handling DNS
- [x] `network/unifi-dns` — auto DNS via external-dns-unifi-webhook
- [x] Verify HTTPRoutes resolve correctly via AdGuard and Cloudflare Tunnel

---

### 4 — Databases

Must be running before any app that needs PostgreSQL.

- [x] `database/cloudnativepg` — operator v0.27.1 deployed
- [x] `database/cloudnativepg` cluster — PostgreSQL 16 with pgvecto.rs, `Cluster in healthy state`
- [x] `database/redis` — Valkey 8.1.1 ephemeral cache deployed

---

### 5 — Security & Identity

- [x] `security/authentik` — deploy; on first boot open the web UI and complete the initial setup wizard (creates the default admin account)
- [ ] Configure Authentik providers and applications for each app you want SSO on
- [ ] Configure forward auth on Envoy Gateway HTTPRoutes for protected apps

---

### 6 — Observability

- [x] `monitoring/kube-prometheus-stack` — Prometheus + Alertmanager + node-exporter + kube-state-metrics (Grafana disabled, managed separately)
- [x] `monitoring/grafana` — Grafana Operator + Grafana instance CR (dashboards/datasources as CRDs)
- [x] `monitoring/loki` — log aggregation (SingleBinary, filesystem storage, 14d retention)
- [x] `monitoring/alloy` — DaemonSet log collector shipping pod logs to Loki
- [x] `monitoring/ntfy` — push notification server (ntfy v2.18.0, external HTTPRoute, auth enabled)
- [x] `monitoring/gatus` — uptime monitoring with auto HTTPRoute discovery, public status page at status.${SECRET_DOMAIN}
- [x] `monitoring/smartctl-exporter` — NVMe SMART metrics (DaemonSet, one pod per node)
- [x] `monitoring/unpoller` — UniFi metrics from UDM Pro via read-only local admin account
- [x] `monitoring/flux-webui` — Flux Operator Web UI at flux.${SECRET_DOMAIN} (internal HTTPRoute on existing flux-operator service)
- [x] Configure Alertmanager webhook → ntfy `/alertmanager` topic (Watchdog/InfoInhibitor suppressed)
- [x] Add Flux → Grafana annotations: Provider + Alert in `flux-system` for deployment markers

---

### 7 — Backup

- [x] `storage/volsync` — deploy the operator (R2 credentials in cluster-secrets)
- [x] Add the volsync component to `radarr`, `sonarr`, and `prowlarr` kustomization files
- [ ] Add the volsync component to `authentik` kustomization file
- [ ] Verify first backup completes: `kubectl get replicationsources -A`

---

### 8 — Media

Deploy in this order to avoid broken links between apps.

- [x] `media/jellyfin` — deployed on k8s-0 with shared media PVC, Webhook plugin configured to send ntfy notifications
- [x] `media/prowlarr` — deployed, add indexers
- [x] `media/radarr` — deployed on k8s-0, connect to Prowlarr and qBittorrent
- [x] `media/sonarr` — deployed on k8s-0, connect to Prowlarr and qBittorrent
- [x] `media/bazarr` — deployed on k8s-0, connect to Radarr and Sonarr
- [x] `media/flaresolverr` — deployed (internal only, no HTTPRoute)
- [x] `media/qbittorrent` — deployed on k8s-0 with shared media PVC
- [x] `media/recyclarr` — CronJob deployed, TRaSH Guides profiles synced (WEB-1080p for Sonarr, HD Bluray + WEB for Radarr)
- [x] `media/seerr` — connected to Jellyfin, Radarr, and Sonarr
- [x] Configure Jellyfin Webhook plugin → ntfy `/media` topic for new media notifications

---

### 9 — Dashboard

- [x] `default/homepage` — configured with Media, Monitoring, Infrastructure service groups and bookmarks; init container for v1 config compatibility

---

### 10 — Automation & AI

These have no hard dependencies on the media stack — deploy whenever you're ready.

- [x] `automation/n8n` — deployed with PostgreSQL (n8n database created manually in CNPG cluster), Valkey queue, HTTPRoute at `n8n.${SECRET_DOMAIN}`
- [x] `database/qdrant` — deployed with 10Gi persistent storage (REST :6333, gRPC :6334, internal only)
- [x] `automation/crawl4ai` — deployed with emptyDir shm volume, Playwright browsers copied via init container, OpenAI API key as SOPS secret

---

### 11 — Productivity

- [ ] `productivity/excalidraw` — deploy; expose via HTTPRoute behind Authentik forward auth

---

### Post-deployment — local tooling

These run on your development machine, not in the cluster.

- [x] Set up `grafana/mcp-grafana` in Claude Code — gives Claude read access to Loki logs, Prometheus metrics, dashboards, and annotations

---

### Done

At this point the full Phase 1 cluster is running. Renovate will start opening PRs for dependency updates automatically. When the NAS arrives, continue with Phase 3 (democratic-csi, KEDA, nfs-scaler, UniFi migration).
