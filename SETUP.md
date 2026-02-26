# Cluster Setup

## Hardware

### Nodes (x3)

| Component | Model                              | Specs                          |
|-----------|------------------------------------|--------------------------------|
| Barebone  | Minisforum MS-01                   | —                              |
| RAM       | Crucial DDR5 SODIMM                | 16 GB · 5600 MHz (upgrade planned) |
| Storage   | Samsung 990 Pro NVMe               | 1 TB                           |

All three nodes will act as **controller nodes** for a highly available control plane, as recommended when running 3+ nodes. No dedicated worker nodes are needed — all controllers also run workloads.

### Networking

> Full network design — VLANs, firewall rules, reserved IPs, and UniFi setup steps — is in [NETWORK.md](NETWORK.md).

The MS-01 has 2x Thunderbolt 4 ports per node. With 3 nodes and 3 cables a **full mesh** is possible — every node has a direct 40 Gbps link to every other node:

```
Node 1 [TB4-A] ──── [TB4-A] Node 2
Node 1 [TB4-B] ──── [TB4-A] Node 3
Node 2 [TB4-B] ──── [TB4-B] Node 3
```

| Interface | Speed | Planned use |
|-----------|-------|-------------|
| Thunderbolt 4 (x2 per node) | 40 Gbps | Inter-node cluster traffic (pod-to-pod) |
| 2.5 GbE (x2 per node) | 2.5 Gbps | LAN / management / Kubernetes node IP |
| SFP+ (x2 per node) | 10 Gbps | Storage traffic to TrueNAS via aggregation switch |

> **Talos note:** Thunderbolt networking requires the `thunderbolt` and `thunderbolt_net` kernel modules — both are already in the schematic.

**TB4 interface naming is unstable** — interface names (`thunderbolt0`, `thunderbolt1`) are not fixed to specific ports, and MAC addresses change every time a cable is inserted or removed. Do not configure TB4 interfaces by name or MAC address in Talos.

Instead, use a `deviceSelector` with `driver: thunderbolt_net` in your machineconfig network config — this matches all TB4 interfaces by kernel driver regardless of name or MAC:

```yaml
network:
  interfaces:
    - deviceSelector:
        driver: thunderbolt_net
      dhcp: false
      addresses:
        - 10.0.10.X/24   # unique per node, dedicated inter-node subnet
```

If you need to pin specific interfaces to specific IPs (e.g. two TB4 ports with different peer nodes), use `busPath` instead of `driver` to match by PCI path. Discover PCI paths after first boot by running `talosctl get links -n <ip> --insecure` and cross-referencing with `udevadm info`.

**IOMMU** should be enabled for best TB4 throughput. Add to your machineconfig `extraKernelArgs`:

```yaml
machine:
  kernel:
    modules: []
  install:
    extraKernelArgs:
      - intel_iommu=on
      - iommu=pt
```

**BIOS:** Before applying Talos config, enter BIOS on each node via JetKVM and set the Thunderbolt security level to **No Security**. Talos has no mechanism to authorize Thunderbolt devices, so "User Authorization" would leave the interfaces stuck waiting for approval that never comes.

**Physical cables:** Connect all 3 TB4 cables before first boot so the interfaces are present when Talos initialises networking.

### Other Servers

| Device | Role | VLAN | IP | Notes |
|--------|------|------|----|-------|
| Mac Mini | Home Assistant | SERVERS | 192.168.42.201 | Currently running Proxmox (HAOS VM + Docker VM) — will migrate to HAOS directly in future |

### Out-of-Band Access

| Device | Purpose | Status |
|--------|---------|--------|
| **JetKVM** | Remote KVM / OOB access for bare metal nodes | 1 purchased (2 more planned) |

Each JetKVM plugs into a node via HDMI + USB, allowing remote console access, BIOS entry, and power cycling — completely independent of the OS or network. Essential for recovering a node that fails to boot or needs a Talos reinstall without physical access.

---

## Cluster Software

**OS:** [Talos Linux](https://github.com/siderolabs/talos) — immutable, API-driven Linux built for Kubernetes.

**Configuration rendered via:** [makejinja](https://github.com/mirkolenz/makejinja) from `cluster.yaml` + `nodes.yaml`.

### Included Components

| Component | Purpose |
|-----------|---------|
| [Flux](https://github.com/fluxcd/flux2) | GitOps continuous delivery |
| [Cilium](https://github.com/cilium/cilium) | CNI / load balancer (replaces kube-proxy) |
| [cert-manager](https://github.com/cert-manager/cert-manager) | TLS certificate management |
| [Envoy Gateway](https://github.com/envoyproxy/gateway) | Internal & external HTTP/S gateway |
| [external-dns / k8s-gateway](https://github.com/kubernetes-sigs/external-dns) | Split-DNS via Cloudflare |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Secure external access via Cloudflare Tunnel |
| [spegel](https://github.com/spegel-org/spegel) | Peer-to-peer OCI image mirror |
| [Reloader](https://github.com/stakater/Reloader) | Automatic pod restarts on config/secret changes |
| [metrics-server](https://github.com/kubernetes-sigs/metrics-server) | Resource metrics for HPA / kubectl top |
| [CoreDNS](https://github.com/coredns/coredns) | In-cluster DNS |

### Tooling

| Tool | Purpose |
|------|---------|
| [mise](https://mise.jdx.dev/) | Dev environment / tool version manager |
| [SOPS + age](https://github.com/getsops/sops) | Secrets encryption at rest |
| [Renovate](https://www.mend.io/renovate) | Automated dependency updates |
| [GitHub Actions](https://github.com/features/actions) | CI/CD workflows |
| [Task](https://taskfile.dev/) | Task runner (`Taskfile.yaml`) |

---

## Configuration Files

Two YAML files drive the entire cluster configuration (copied from the `.sample` files and filled in):

### `cluster.yaml` — required fields

| Field | Description |
|-------|-------------|
| `node_cidr` | Network CIDR of the nodes (e.g. `192.168.1.0/24`) |
| `cluster_api_addr` | Unused IP in `node_cidr` for the Kube API VIP |
| `cluster_gateway_addr` | Unused IP for the internal gateway load balancer |
| `cluster_dns_gateway_addr` | Unused IP for k8s-gateway (split-DNS) |
| `cloudflare_gateway_addr` | Unused IP for the external (Cloudflare) gateway |
| `cloudflare_domain` | Your Cloudflare-managed domain |
| `cloudflare_token` | Cloudflare API token (`Zone:DNS:Edit` + `Account:Cloudflare Tunnel:Read`) |
| `repository_name` | GitHub repository (e.g. `username/home-ops`) |

Optional: `node_dns_servers`, `node_ntp_servers`, `node_default_gateway`, `node_vlan_tag`, `cluster_pod_cidr` (default `10.42.0.0/16`), `cluster_svc_cidr` (default `10.43.0.0/16`).

### `nodes.yaml` — one entry per node

```yaml
nodes:
  - name: ""            # hostname, must match [a-z0-9-]+
    address: ""         # static IP within node_cidr
    controller: true    # true for all 3 nodes (HA control plane)
    disk: ""            # device path (/dev/nvme0n1) or disk serial number
    mac_addr: ""        # NIC MAC address
    schematic_id: ""    # from https://factory.talos.dev/
    # mtu: 1500         # optional, default 1500
    # secureboot: false # optional UEFI SecureBoot
    # encrypt_disk: false # optional TPM disk encryption
```

To find `disk` and `mac_addr` before applying config:
```sh
talosctl get disks  -n <node-ip> --insecure
talosctl get links  -n <node-ip> --insecure
```

---

## Talos Schematic

Visit [factory.talos.dev](https://factory.talos.dev/) to generate a schematic for the MS-01.
The MS-01 uses an Intel CPU, so start with:

- `intel-ucode`
- `i915` (iGPU — required for Jellyfin QuickSync)
- `mei` (Intel Management Engine interface)
- `thunderbolt` (Thunderbolt 4 support)
- `thunderbolt_net` (IP-over-Thunderbolt networking)
- `tun` (virtual network tunnel — required for Gluetun/VPN)

Note the **schematic ID** — it goes in each node's `schematic_id` field.

---

## Roadmap

### Phase 1 — Initial setup (now)

- **Storage:** `local-path-provisioner` — data lives on each node's 990 Pro (slot 1)
- **Limitation:** storage is node-local and not HA. If a node goes down, pods on that node wait until it recovers. Acceptable for media and non-critical workloads.
- No additional drives or external storage needed to get started.

### Phase 2 — RAM upgrade

- Upgrade SODIMMs when DDR5 prices drop (target: 32–64 GB per node)
- More headroom for additional workloads and future NAS caching

### Phase 3 — NAS (TrueNAS on Supermicro CSE-826)

**Hardware:**
- Supermicro CSE-826 (12-bay 2U chassis) running TrueNAS
- Connected to the cluster via SFP+ (10 GbE) directly on the USW-Pro-HD-24-PoE

**Network upgrade (coincides with moving to the new house):**
- Replace US-8-60W with **UniFi USW-Pro-HD-24-PoE** — 22× 2.5GbE + 2× 10GbE RJ45 + 4× SFP+; enough SFP+ ports to connect NAS and nodes directly without a separate aggregation switch
- UDM Pro is already in place (replaced USG-3P in Phase 1) — connect to the new switch via SFP+ uplink

**Network layout:**

```
                  [UDM Pro]
                     |
               SFP+/10G uplink
                     |
          [USW-Pro-HD-24-PoE]
          /      |       \        \
    SFP+/10G  SFP+/10G  2.5GbE  SFP+/10G
        /         |         \        \
  [MS-01 #1] [MS-01 #2] [MS-01 #3] [TrueNAS CSE-826]
        (TB4 full mesh between all three nodes)
```

> MS-01 #3 connects via 2.5GbE RJ45 to free up the 4th SFP+ port. For home media workloads 2.5GbE is sufficient — storage traffic rarely saturates it.

**Kubernetes integration:** [`democratic-csi`](https://github.com/democratic-csi/democratic-csi) — provides StorageClasses backed by TrueNAS:

| Protocol | StorageClass use |
|----------|-----------------|
| NFS | General workloads, media, ReadWriteMany |
| iSCSI | Databases, block storage |

**Migration:** once the NAS is live, redeploy media apps pointing at NFS-backed PVCs and reclaim the space on the 990 Pro drives.

**Additional Phase 3 changes:**
- Deploy **KEDA** (Kubernetes Event-driven Autoscaling) in `kube-system` — enables the `nfs-scaler` component to automatically scale media apps to zero replicas when the NAS goes offline, preventing crash loops
- *(UniFi Network Application was never deployed — the UDM Pro runs the controller natively)*

> **TrueNAS note:** TrueNAS SCALE is recommended over CORE for this setup — it has a smoother `democratic-csi` integration and is Linux-based.

---

### Phase 4 — Rook-Ceph (optional)

If you want fast, fully in-cluster block storage independent of the NAS, add a dedicated NVMe to each MS-01 and deploy [rook-ceph](https://rook.io/).

**Hardware:**
- 1× NVMe per node dedicated as a Ceph OSD (e.g. WD RED SN700) — the MS-01 has two M.2 2280 slots so slot 2 is free after Talos claims slot 1
- Keep the existing 990 Pro drives for the OS; Ceph gets its own dedicated drives

**Why dedicated drives matter:** Ceph generates sustained random writes. Sharing an OS drive with Ceph OSDs degrades performance and wears the drive faster. One dedicated OSD per node avoids this entirely.

**What it gives you:**
- Distributed block storage with 3-way replication across nodes — survives a single node failure
- Fast local NVMe latency vs NFS round-trips to the NAS
- A `ceph-block` StorageClass for apps that need block storage (databases, etc.)

**Coexistence with the NAS:** rook-ceph and democratic-csi run side by side. Use NFS-backed PVCs for media and large files (cost-effective on spinning rust), and Ceph block PVCs for databases and latency-sensitive workloads (fast NVMe).

**Deployment order:**
1. Install the NVMe drives in each node — Talos will ignore them until Ceph claims them
2. Deploy the `rook-ceph` operator in `rook-ceph` namespace
3. Create a `CephCluster` resource referencing the new drives
4. Create a `CephBlockPool` and a `StorageClass` (e.g. `ceph-block`)
5. Migrate any apps you want on fast local storage to the new StorageClass

> This is entirely optional — the NAS via democratic-csi covers most storage needs. Add Ceph if you find NFS latency is a bottleneck for specific workloads, or if you want block storage that doesn't depend on the NAS being online.

---

## Applications

### Dashboard

| App | Purpose | Notes |
|-----|---------|-------|
| **Homepage** | Homelab dashboard | Replaces Homarr — discovers services automatically via Kubernetes annotations on each app's `Service` resource. No database, config lives in YAML alongside your manifests. |

Homepage annotations are added directly to each app's service (e.g. Radarr, Jellyfin, n8n), so the dashboard always reflects exactly what is deployed. No manual dashboard maintenance needed.

### Networking & DNS

| App | Purpose | Notes |
|-----|---------|-------|
| **Envoy Gateway** | Ingress / HTTP routing | Already included in the template — do not add Traefik alongside it, they conflict |
| **AdGuard Home** | Network-wide ad blocking & DNS | Run as a DaemonSet (one pod per node) so DNS stays up if any single node goes down |
| **unifi-dns** | Automatic LAN DNS from Kubernetes | ExternalDNS webhook ([`external-dns-unifi-webhook`](https://github.com/kashalls/external-dns-unifi-webhook)) — watches `HTTPRoute` resources and writes matching DNS records to your UniFi gateway automatically |

> **UniFi controller:** The UDM Pro runs the UniFi Network Application natively — no need to deploy it in the cluster or maintain a separate MongoDB instance.

### Observability

| App | Purpose | Notes |
|-----|---------|-------|
| **kube-prometheus-stack** | Prometheus + Grafana + Alertmanager | The standard Helm chart — installs all three together |
| **Alloy** | Log & metric collection | DaemonSet — tails container logs on every node and ships them to Loki. The officially recommended replacement for Promtail. |
| **Loki** | Log aggregation | Receives logs from Alloy; pairs with Grafana for log querying |
| **Gatus** | Uptime / status page | Monitors HTTP, TCP, and DNS endpoints — exposes a public status page |
| **Ntfy** | Push notifications | Self-hosted notification server — sends alerts to iOS/Android via the Ntfy app |
| **smartctl-exporter** | NVMe drive health | Exports SMART data (health, temperature, wear) from all drives to Prometheus — visible in Grafana |
| **Unifi Poller** | UniFi metrics exporter | Scrapes the UDM Pro API and exposes Prometheus metrics — client counts, traffic, AP stats, switch ports. Community Grafana dashboards available. |

**Log pipeline:** Alloy (DaemonSet) tails container logs on every node → ships to Loki via its HTTP push API → Grafana queries Loki. No PVC or secrets needed — Alloy only needs the Loki endpoint URL in its config.

**Home Assistant → Grafana:** enable the [Prometheus integration](https://www.home-assistant.io/integrations/prometheus/) in HA, then add a Prometheus scrape job pointing at your HA instance. All HA sensor data flows into Grafana automatically.

**UniFi → Grafana:** Unifi Poller scrapes the UDM Pro on a schedule → Prometheus scrapes Unifi Poller → Grafana displays network metrics. Import community dashboard ID `11315` for a ready-made UniFi overview.

**Gatus — auto-discovery via sidecar:** The clever part of onedr0p's setup is the [`gatus-sidecar`](https://github.com/home-operations/gatus-sidecar) — a native Kubernetes sidecar container (initContainer with `restartPolicy: Always`) that watches the cluster for `HTTPRoute` resources and automatically generates Gatus endpoint configs from them. This means you annotate your apps, not Gatus:

```yaml
# On any app's HTTPRoute or Service:
gatus.home-operations.com/enabled: "true"
```

The sidecar picks this up and Gatus starts monitoring that endpoint without any manual config changes. It requires a **ClusterRole** to read `Services`, `Gateways`, and `HTTPRoutes` cluster-wide.

**Gatus config structure:** Two separate config files, both mounted via a Kustomize `configMapGenerator` (not a plain ConfigMap):

| File | Purpose |
|------|---------|
| `resources/config.yaml` | Connectivity checks (ICMP to 1.1.1.1, 8.8.8.8, 9.9.9.9), SQLite storage path, UI title, Prometheus metrics endpoint |
| `resources/buddy.yaml` | Optional: ping an external host + heartbeat from a remote Gatus instance (mutual monitoring) |

**Storage:** Gatus uses SQLite stored in a StatefulSet PVC — 1–5 Gi is plenty. Phase 1: `local-path-provisioner`.

**Alerting:** Use Ntfy as the alert backend — see the Ntfy config example below.

**Prometheus integration:** Add `metrics: true` to `config.yaml` and a `ServiceMonitor` in the HelmRelease — Gatus metrics flow into Prometheus and you can alert via `PrometheusRule` (e.g. fire when an endpoint has been down for 5 minutes).

**Ntfy as the Gatus alert backend:** Instead of Pushover, configure Gatus to send alerts to your self-hosted Ntfy instance. In `buddy.yaml` (or `config.yaml`):

```yaml
alerting:
  ntfy:
    url: https://ntfy.yourdomain.com
    topic: cluster-alerts
    default-alert:
      failure-threshold: 3
      send-on-resolved: true
```

**Ntfy — how it works:**

Ntfy is a pub/sub push notification server. Apps send an HTTP POST to a topic URL; the Ntfy mobile app (iOS/Android) subscribes to that topic and receives the notification — no Google/Apple accounts needed for self-hosted delivery via the Ntfy app's own push relay.

**Integration points across the stack:**

| Source | What it sends |
|--------|--------------|
| **Gatus** | Endpoint down / recovered |
| **Alertmanager** | Prometheus alert rules (node down, disk full, pod crash-looping, etc.) |
| **n8n** | Any custom workflow notification via HTTP POST node |
| **Volsync** | Backup success / failure (via Alertmanager rule) |

**Alertmanager → Ntfy:** Configure an Alertmanager webhook receiver pointing at Ntfy. The community [`ntfy-alertmanager`](https://github.com/alexbakker/ntfy-alertmanager) sidecar translates Alertmanager's payload format into Ntfy messages with proper titles and priorities.

**Storage:** Optional SQLite for message history (useful for catching up on missed alerts). A small PVC (1–2 Gi) is enough.

**Access:** Expose via HTTPRoute for the web UI — useful for reading alerts in a browser. Protect with Authentik forward auth to avoid exposing your notification topics publicly.

### Databases

| App | Purpose | Notes |
|-----|---------|-------|
| **CloudNativePG** | PostgreSQL operator | Manages all PostgreSQL clusters in the cluster |

One CloudNativePG cluster running the **TimescaleDB image** covers all database needs. TimescaleDB is standard PostgreSQL with a time-series extension — regular apps like Authentik use it as normal PostgreSQL, while HA and Prometheus use the TimescaleDB extension for time-series storage.

| Database | Type | Used by |
|----------|------|---------|
| `authentik` | Regular PostgreSQL | Authentik (SSO) |
| `n8n` | Regular PostgreSQL | n8n workflow storage |
| `homeassistant` | TimescaleDB | HA long-term recorder (replaces default SQLite) |
| `prometheus` | TimescaleDB | Prometheus remote write for long-term metrics |

### Media

Full *arr stack migrated from Docker. All services exposed via Envoy Gateway `HTTPRoute` resources on `mnygaard.io` (replaces Traefik labels).

| App | Purpose | Notes |
|-----|---------|-------|
| **Gluetun** | VPN gateway (AirVPN/WireGuard) | Runs as a sidecar with qBittorrent in the same pod — requires `NET_ADMIN` capability and `/dev/net/tun` in Talos |
| **qBittorrent** | Torrent client | Shares Gluetun's pod network namespace — all traffic forced through VPN |
| **Prowlarr** | Indexer manager | Connects to Radarr, Sonarr and qBittorrent |
| **Radarr** | Movie management | |
| **Sonarr** | TV show management | |
| **Bazarr** | Subtitle management | |
| **FlareSolverr** | Cloudflare challenge solver | Internal only, no ingress needed |
| **Recyclarr** | TRaSH Guides sync | Runs as a Kubernetes `CronJob` (not a long-running pod) |
| **Jellyfin** | Media server | Intel QuickSync hardware transcoding — requires `i915` Talos extension + `intel-gpu-resource-driver` in `kube-system` |
| **Seerr** | Media request management | Unified successor to Overseerr and Jellyseerr — supports Jellyfin, Plex, and Emby |

**Storage (per phase):**

| Volume | Phase 1 | Phase 3 (NAS) |
|--------|---------|---------------|
| App configs (Radarr, Sonarr, etc.) | `local-path-provisioner` | NFS |
| Downloads | `local-path-provisioner` (990 Pro) | NFS |
| Movies / TV | `local-path-provisioner` (990 Pro) | NFS |

> **Gluetun in Talos:** `/dev/net/tun` requires enabling the `tun` kernel module. Add it to `kernel_modules` in `nodes.yaml` and include it in your factory.talos.dev schematic.

**Download notifications:** Radarr, Sonarr, and Seerr all have built-in webhook support. Point them directly at your Ntfy topic URL — no extra app needed. When a download completes or a request is approved, a push notification lands on your phone automatically. Configure this in each app's Settings → Notifications → Webhook.

### Automation & AI

| App | Purpose | Notes |
|-----|---------|-------|
| **n8n** | Workflow automation | Self-hosted Zapier/Make alternative — uses PostgreSQL via CloudNativePG |
| **Crawl4AI** | AI web crawler | Extracts structured content from websites for RAG pipelines — needs OpenAI API key (SOPS secret) |
| **Qdrant** | Vector database | Stores embeddings for semantic search and AI agent pipelines — deployed in the `database/` namespace (alongside CloudNativePG and Redis), needs persistent storage |

These three form a natural pipeline: n8n triggers Crawl4AI to scrape content → content is embedded and stored in Qdrant → n8n queries Qdrant for RAG workflows or HA automations.

> **Crawl4AI in Kubernetes:** Docker's `shm_size: 1g` does not exist in Kubernetes. Replace it with an `emptyDir` volume mounted at `/dev/shm` with `medium: Memory` and `sizeLimit: 1Gi` in the pod spec.

### Backup

| App | Purpose | Notes |
|-----|---------|-------|
| **Volsync** | PVC backup & replication | Operator that snapshots PVCs and pushes them to S3-compatible storage |

**Backend: Cloudflare R2**

R2 is S3-compatible and has no egress fees — ideal for off-site PVC backups. Volsync uses **kopia** under the hood (deduplicated, compressed, encrypted snapshots).

Setup steps:
1. Create a Cloudflare R2 bucket (e.g. `cluster-volsync`)
2. Create an R2 API token with Object Read/Write on that bucket
3. Store the credentials in a SOPS-encrypted secret in `components/volsync/`
4. Enable backup for an app by adding the component to its `kustomization.yaml` (see below)

**The component pattern — how Volsync is actually wired up:**

Rather than writing a `ReplicationSource` resource inside every app directory, all the Volsync resources live once in `kubernetes/components/volsync/`. Any app that needs backup simply includes the component:

```yaml
# media/radarr/app/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
components:
  - ../../../../components/volsync
resources:
  - ./helmrelease.yaml
  - ./httproute.yaml
  - ./pvc.yaml
```

Flux substitutes `${APP}` (= `radarr`) into every resource in the component, creating the PVC, `ReplicationSource`, `ReplicationDestination`, and secret automatically. No per-app boilerplate.

**PostgreSQL databases — no backup for now**

CloudNativePG supports WAL archiving to R2 if needed later, but for this home lab setup the databases (Authentik, n8n, HA recorder, Prometheus metrics) are all rebuildable and not backed up. If you want to add it in the future, configure `barmanObjectStore` in `database/cloudnativepg/app/cluster.yaml`.

**Which PVCs to back up with Volsync:**

| App | Priority | Reason |
|-----|---------|--------|
| Authentik | High | User accounts and SSO config |
| Radarr / Sonarr / Prowlarr | Medium | Config and history (re-downloadable but tedious to rebuild) |

Qdrant embeddings and Jellyfin metadata are intentionally excluded — both are fully rebuildable and can grow large. Re-run the n8n/Crawl4AI ingestion pipeline to regenerate embeddings; Jellyfin rebuilds its cache on first scan.

> **Prerequisite:** Volsync's `copyMethod: Snapshot` creates a `VolumeSnapshot` before copying data. This requires the **`snapshot-controller`** to be deployed in `kube-system` first — without it, backups will fail silently. Deploy it as a HelmRelease before enabling Volsync on any app.

> **Note:** The Volsync operator lives in the `storage/` namespace. The shared component resources live in `kubernetes/components/volsync/`. Apps opt in by adding `components: [../../../../components/volsync]` to their `app/kustomization.yaml` — no per-app `ReplicationSource` files needed.

### Security & Identity

| App | Purpose | Notes |
|-----|---------|-------|
| **Authentik** | SSO / identity provider | Needs PostgreSQL (CloudNativePG) and Redis — provides single sign-on across all apps. Redis is used as a **cache only** — losing it just forces users to re-authenticate. No backup needed; `persistenceType: emptyDir` (or a small ephemeral PVC) is fine. |

### Productivity

| App | Purpose | Notes |
|-----|---------|-------|
| **Excalidraw** | Virtual whiteboard / diagram tool | Stateless — no database or persistent storage needed. Just a web UI served as a static app. Expose via HTTPRoute behind Authentik forward auth. |

---

## Repository Structure

### Kustomize Components

`kubernetes/components/` holds reusable resource bundles that any app can include with a single line. They use `${APP}` as a placeholder — Flux substitutes the app name at deploy time.

```
kubernetes/components/
├── sops/               # already in template — injects cluster-secrets Secret into every namespace
├── volsync/            # PVC backup: ReplicationSource + ReplicationDestination + PVC + Secret
│                       # → opt in per app via components: [../../../../components/volsync]
├── alerts/             # Flux Alerts: notifies Alertmanager when any HelmRelease/Kustomization fails
│                       # → include at the namespace level to alert on everything in that namespace
└── nfs-scaler/         # KEDA ScaledObject: scales app to 0 when NAS is offline (Phase 3 only)
```

**alerts vs Gatus:** These catch different failure modes.
- **Gatus** monitors HTTP endpoints — *"is Radarr responding?"*
- **alerts component** watches Flux events — *"did the Radarr HelmRelease fail to upgrade?"*

Both are needed. Wire `alerts` → Alertmanager → Ntfy so all Flux failures land on your phone.

### Pattern

Every app follows the same two-level structure. The namespace folder registers apps with Flux; each app folder contains the actual Kubernetes resources:

```
kubernetes/apps/
└── <namespace>/
    ├── namespace.yaml          # Kubernetes Namespace
    ├── kustomization.yaml      # Lists all ks.yaml files in this namespace
    └── <app-name>/
        ├── ks.yaml             # Flux Kustomization (tells Flux where the app lives)
        └── app/
            ├── kustomization.yaml   # Lists all resource files below
            ├── helmrelease.yaml     # Helm chart + values
            ├── ocirepository.yaml   # Where the Helm chart comes from
            ├── httproute.yaml       # Envoy Gateway routing (replaces Traefik labels)
            ├── secret.sops.yaml     # Encrypted secrets (API keys, passwords)
            └── pvc.yaml             # PersistentVolumeClaim (if storage needed)
```

### Full Layout

```
kubernetes/
│
├── components/
│   ├── sops/                            # already in template — injects cluster-secrets into each namespace
│   ├── volsync/                         # kopia backup to R2 — opt in per app via kustomization.yaml
│   ├── alerts/                          # Flux → Alertmanager → Ntfy on deploy failures
│   └── nfs-scaler/                      # Phase 3: scale app to 0 when NAS is offline
│
└── apps/
    │
    ├── kube-system/                     # already exists in template (cilium, coredns, etc.)
    │   ├── snapshot-controller/
    │   │   └── app/ helmrelease          (prerequisite for Volsync — must deploy first)
    │   ├── intel-gpu-resource-driver/
    │   │   └── app/ helmrelease          (exposes Intel iGPU to pods for Jellyfin QuickSync)
    │   └── system-upgrade/
    │       └── app/ helmrelease (controller), upgradeplan.yaml (target Talos version + schematic)
    │
    ├── default/                         # already exists in template
    │   └── homepage/
    │       └── app/ helmrelease, httproute, configmap (service groups/layout)
    │
    ├── network/                         # already exists in template
    │   ├── adguard-home/
    │   │   └── app/ helmrelease, httproute
    │   ├── unifi-dns/
    │   │   └── app/ helmrelease, secret.sops                (external-dns-unifi-webhook — auto DNS from HTTPRoutes)
    │   └── ... (cloudflare-tunnel, envoy-gateway, etc.)
    │
    ├── monitoring/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   ├── kube-prometheus-stack/
    │   │   └── app/ helmrelease, ocirepository
    │   ├── alloy/
    │   │   └── app/ helmrelease           (DaemonSet — collects pod logs, ships to Loki)
    │   ├── loki/
    │   │   └── app/ helmrelease, ocirepository
    │   ├── gatus/
    │   │   ├── ks.yaml
    │   │   └── app/
    │   │       ├── kustomization.yaml        # uses configMapGenerator (not a plain ConfigMap)
    │   │       ├── helmrelease.yaml          # StatefulSet + gatus-sidecar + ClusterRole
    │   │       ├── ocirepository.yaml
    │   │       ├── prometheusrule.yaml       # alerts when endpoints go down
    │   │       ├── secret.sops.yaml          # Ntfy topic/token
    │   │       └── resources/
    │   │           ├── config.yaml           # connectivity checks, SQLite path, UI config
    │   │           └── buddy.yaml            # optional: external host heartbeat
    │   ├── ntfy/
    │   │   └── app/ helmrelease, httproute, pvc (message history), secret.sops (auth token)
    │   ├── smartctl-exporter/
    │   │   └── app/ helmrelease           (DaemonSet — runs on every node, exports NVMe SMART data)
    │   ├── keda/
    │   │   └── app/ helmrelease           (Phase 3: enables nfs-scaler component)
    │   └── unifi-poller/
    │       └── app/ helmrelease, secret.sops                (UDM Pro credentials)
    │
    ├── database/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   ├── cloudnativepg/
    │   │   └── app/ helmrelease (operator), cluster.yaml (DB cluster + TimescaleDB), secret.sops
    │   ├── redis/
    │   │   └── app/ helmrelease              (used by Authentik as a cache — ephemeral, no backup needed)
    │   └── qdrant/
    │       └── app/ helmrelease, pvc
    │
    ├── media/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   ├── jellyfin/
    │   │   └── app/ helmrelease, httproute, pvc
    │   ├── qbittorrent/               # gluetun runs as a sidecar in the same pod
    │   │   └── app/ deployment (custom), httproute, pvc, secret.sops (WireGuard keys)
    │   ├── radarr/
    │   │   └── app/ helmrelease, httproute, pvc  # + components/volsync in kustomization.yaml
    │   ├── sonarr/
    │   │   └── app/ helmrelease, httproute, pvc  # + components/volsync in kustomization.yaml
    │   ├── prowlarr/
    │   │   └── app/ helmrelease, httproute, pvc  # + components/volsync in kustomization.yaml
    │   ├── bazarr/
    │   │   └── app/ helmrelease, httproute, pvc
    │   ├── flaresolverr/
    │   │   └── app/ helmrelease          (no httproute — internal only)
    │   ├── recyclarr/
    │   │   └── app/ cronjob.yaml, secret.sops  (no HelmRelease — runs as CronJob)
    │   └── seerr/
    │       └── app/ helmrelease, httproute, pvc
    │
    ├── automation/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   ├── n8n/
    │   │   └── app/ helmrelease, httproute, secret.sops (DB credentials)
    │   └── crawl4ai/
    │       └── app/ helmrelease, httproute, secret.sops (OpenAI API key)  # emptyDir shm instead of shm_size
    │
    ├── storage/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   └── volsync/
    │       └── app/ helmrelease, secret.sops (R2 credentials)
    │           # Backup config lives in components/volsync/ — apps opt in via kustomization.yaml
    │
    ├── security/
    │   ├── namespace.yaml
    │   ├── kustomization.yaml
    │   └── authentik/
    │       └── app/ helmrelease, httproute, secret.sops (DB credentials, secret key)
    │
    └── productivity/
        ├── namespace.yaml
        ├── kustomization.yaml
        └── excalidraw/
            └── app/ helmrelease, httproute          (no pvc — stateless)
```

### File roles at a glance

| File | What it does |
|------|-------------|
| `namespace.yaml` | Creates the Kubernetes namespace |
| `kustomization.yaml` (namespace level) | Registers each app's `ks.yaml` with Flux |
| `ks.yaml` | Flux Kustomization — points Flux at the `app/` directory |
| `app/kustomization.yaml` | Lists all resource files Kustomize should apply |
| `app/helmrelease.yaml` | Defines the Helm chart, version, and values |
| `app/ocirepository.yaml` | Where the Helm chart is pulled from |
| `app/httproute.yaml` | Envoy Gateway routing rule (replaces Traefik labels) |
| `app/secret.sops.yaml` | Age-encrypted secrets committed safely to Git |
| `app/pvc.yaml` | PersistentVolumeClaim for app storage |

---

## Bootstrap Order

1. **Generate your age key** — this must happen before anything else:
   ```bash
   age-keygen -o age.key
   ```
   Store `age.key` somewhere safe (password manager). It never goes in the repo. This key is what SOPS uses to encrypt/decrypt all secrets — without it, `task template:render` cannot seal secrets and bootstrap will fail.

2. Flash Talos ISO (from factory.talos.dev) to USB and boot each node.
3. Fill in `cluster.yaml` and `nodes.yaml`.
4. Run `task template:render` to generate configs (uses `age.key` to seal SOPS secrets).
5. Run `task talos:bootstrap` to initialise the cluster.
6. Run `task bootstrap:apps` to deploy Flux and all base applications.
   - This creates the `cluster-secrets` Kubernetes Secret in each namespace (via the `sops` component). Flux uses `substituteFrom` to pull values like `${SECRET_DOMAIN}` and `${SECRET_CLOUDFLARE_TOKEN}` from this Secret into HelmRelease and Kustomization resources.
7. Flux takes over — push changes to GitHub to manage the cluster.

### Talos node upgrades

Talos nodes are upgraded via the **system-upgrade-controller** — a Kubernetes controller that reads upgrade plans from Git and applies them node-by-node, draining workloads first. Add it to `kube-system` alongside an `UpgradePlan` resource that references the target Talos version and schematic ID. Renovate will open PRs when new Talos versions are available, and merging the PR triggers the upgrade automatically.

---

## Renovate

The template already includes a `.renovaterc.json5` with sensible defaults — customManagers for OCI charts and annotated versions, semantic commit messages, GitHub Actions auto-merge, and Flux/helmfile manager config. Without installing the GitHub App, none of this runs.

### 1. Install the Renovate GitHub App

Go to [github.com/apps/renovate](https://github.com/apps/renovate) and install it on your repository. No self-hosting needed — Renovate runs on Mend's infrastructure and opens PRs against your repo.

### 2. Update `.renovaterc.json5`

The existing file just needs two small adjustments:

- Set the timezone: add `":timezone(Europe/Copenhagen)"` to the `extends` array
- Add `ignorePaths: ["**/resources/**"]` to prevent Renovate scanning Gatus config files for version strings

### 3. Add `.renovate/` extension files

The template's `.renovaterc.json5` already covers customManagers. What's worth adding in a `.renovate/` directory:

**`.renovate/autoMerge.json5`** — add digest auto-merge for containers (GitHub Actions auto-merge is already in the base config):

```json5
{
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  packageRules: [
    {
      // Digest updates = same version tag, new image layer (security patches).
      // Lowest risk — always safe to auto-merge.
      description: "Auto-merge digest updates",
      matchDatasources: ["docker"],
      automerge: true,
      automergeType: "pr",
      matchUpdateTypes: ["digest"],
      minimumReleaseAge: "1 day",
    },
  ],
}
```

**`.renovate/groups.json5`** — group related updates into a single PR to reduce noise:

```json5
{
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  packageRules: [
    {
      description: "Group Flux updates",
      matchPackageNames: ["/fluxcd/"],
      groupName: "Flux",
    },
    {
      description: "Group Cilium updates",
      matchPackageNames: ["/cilium/"],
      groupName: "Cilium",
    },
  ],
}
```

### 4. The annotation pattern

For anything Renovate can't detect automatically (Talos versions, tool versions in scripts), add a comment on the line above:

```yaml
# renovate: datasource=docker depName=ghcr.io/siderolabs/talos
version: v1.9.0
```

Renovate reads the comment, queries the container registry, and opens a PR when `v1.10.0` is released.

### 5. Expanding auto-merge over time

Once you've seen a few update cycles and are comfortable with what Renovate produces, add minor/patch auto-merge for specific trusted apps:

```json5
{
  description: "Auto-merge minor/patch for stable infra charts",
  matchPackageNames: [
    "/cert-manager/",
    "/external-dns/",
    "/metrics-server/",
    "/reloader/",
  ],
  automerge: true,
  automergeType: "pr",
  matchUpdateTypes: ["minor", "patch"],
  minimumReleaseAge: "3 days",
}
```

Leave major version bumps and app containers (Radarr, Jellyfin, Authentik, etc.) on manual review permanently — these are the updates most likely to have breaking changes or require config migrations.

