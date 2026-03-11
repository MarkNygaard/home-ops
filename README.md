<div align="center">

### My Home Operations Repository

_... managed with Flux, Renovate, and GitHub Actions_

</div>

<div align="center">

[![Talos](https://img.shields.io/badge/Talos-v1.12.4-blue?style=for-the-badge&logo=talos&logoColor=white)](https://talos.dev)&nbsp;&nbsp;
[![Kubernetes](https://img.shields.io/badge/Kubernetes-v1.35.2-blue?style=for-the-badge&logo=kubernetes&logoColor=white)](https://kubernetes.io)&nbsp;&nbsp;
[![Flux](https://img.shields.io/badge/Flux-Operator-blue?style=for-the-badge&logo=flux&logoColor=white)](https://fluxcd.io)&nbsp;&nbsp;
[![Renovate](https://img.shields.io/badge/Renovate-enabled-blue?style=for-the-badge&logo=renovatebot&logoColor=white)](https://developer.mend.io/github/MarkNygaard/home-ops)

</div>

---

## Overview

This is a mono repository for my home Kubernetes cluster, following Infrastructure as Code (IaC) and GitOps practices. The cluster runs on bare-metal [Talos Linux](https://www.talos.dev/) across 3 Minisforum MS-01 mini PCs interconnected with a Thunderbolt 4 mesh.

Built from the [onedr0p/cluster-template](https://github.com/onedr0p/cluster-template).

---

## Kubernetes

### Core Components

- **GitOps**: [Flux Operator](https://github.com/controlplaneio-fluxcd/flux-operator) manages Flux declaratively via `FluxInstance` CRD
- **CNI**: [Cilium](https://github.com/cilium/cilium) for eBPF-based networking
- **Ingress**: [Envoy Gateway](https://github.com/envoyproxy/gateway) with internal and external gateways
- **TLS**: [cert-manager](https://github.com/cert-manager/cert-manager) with Cloudflare DNS01 challenges
- **DNS**: [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) + [k8s-gateway](https://github.com/k8s-gateway/k8s_gateway) + [external-dns](https://github.com/kubernetes-sigs/external-dns) (Cloudflare & UniFi)
- **Secrets**: [SOPS](https://github.com/getsops/sops) with age encryption
- **Storage**: [local-path-provisioner](https://github.com/rancher/local-path-provisioner) (Phase 1)
- **Database**: [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) (PostgreSQL 16 + pgvecto.rs) + [Valkey](https://github.com/valkey-io/valkey) (Redis-compatible cache)
- **Backup**: [Volsync](https://github.com/backube/volsync) to Cloudflare R2

### Apps

<details>
  <summary>Click to expand the full app list</summary>

| Namespace      | App                   | Description                                      |
| -------------- | --------------------- | ------------------------------------------------ |
| **media**      | Jellyfin              | Media server with Intel QuickSync HW transcoding |
|                | Sonarr                | TV show management                               |
|                | Radarr                | Movie management                                 |
|                | Prowlarr              | Indexer manager                                  |
|                | Bazarr                | Subtitle management                              |
|                | qBittorrent           | Download client                                  |
|                | Seerr                 | Media request management                         |
|                | Recyclarr             | TRaSH Guides sync                                |
|                | FlareSolverr          | Cloudflare challenge solver                      |
| **monitoring** | kube-prometheus-stack | Prometheus + Alertmanager                        |
|                | Grafana               | Dashboards (operator-managed)                    |
|                | Loki                  | Log aggregation                                  |
|                | Alloy                 | Log collector                                    |
|                | Gatus                 | Uptime monitoring & status page                  |
|                | ntfy                  | Push notifications                               |
|                | smartctl-exporter     | NVMe SMART metrics                               |
|                | Unpoller              | UniFi metrics                                    |
|                | Flux Web UI           | Flux Operator dashboard                          |
| **network**    | AdGuard Home          | DNS server (LB .14)                              |
|                | cloudflared           | Cloudflare Tunnel                                |
|                | external-dns          | DNS record sync (Cloudflare)                     |
|                | unifi-dns             | DNS record sync (UniFi)                          |
|                | k8s-gateway           | Internal cluster DNS                             |
|                | Envoy Gateway         | Ingress controller                               |
| **security**   | Authentik             | SSO & identity provider                          |
| **database**   | CloudNativePG         | PostgreSQL operator + cluster                    |
|                | Valkey                | Redis-compatible cache                           |
| **storage**    | Volsync               | PVC backup to R2                                 |
| **default**    | Homepage              | Dashboard                                        |

</details>

### Directories

```sh
📁 kubernetes
├── 📁 apps       # applications grouped by namespace
├── 📁 components # re-useable kustomize components
└── 📁 flux       # flux system configuration
```

### GitOps

[Flux](https://github.com/fluxcd/flux2) watches the `kubernetes/apps` folder and reconciles the cluster state to match this Git repository. [Renovate](https://github.com/renovatebot/renovate) automatically opens PRs for dependency updates (Helm charts, container images, GitHub Actions).

---

## DNS

Two instances of [external-dns](https://github.com/kubernetes-sigs/external-dns) run in the cluster:

- **Cloudflare** for public DNS records (external gateway)
- **UniFi** for private DNS records on the UDM Pro (internal gateway)

[AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) serves as the primary DNS resolver for the home network, with conditional forwarding to [k8s-gateway](https://github.com/k8s-gateway/k8s_gateway) for cluster service resolution.

---

## Cloud Dependencies

| Service                                   | Use                                    |
| ----------------------------------------- | -------------------------------------- |
| [Cloudflare](https://www.cloudflare.com/) | Domain, DNS, Tunnel, R2 backup storage |
| [GitHub](https://github.com/)             | Repository hosting, CI/CD, Renovate    |
|                                           |                                        |

---

## Networking

| VLAN | Name    | Subnet          | Purpose                  |
| ---- | ------- | --------------- | ------------------------ |
| 1    | Default | 192.168.1.0/24  | Default network          |
| 10   | Trusted | 192.168.10.0/24 | Trusted devices          |
| 42   | Servers | 192.168.42.0/24 | Cluster nodes & services |
| 50   | Guest   | 192.168.50.0/24 | Guest WiFi               |
| 69   | IoT     | 192.168.69.0/24 | IoT devices              |

### Cluster IPs (SERVERS VLAN)

| IP        | Function               |
| --------- | ---------------------- |
| .10       | Kubernetes API         |
| .11       | k8s-gateway DNS        |
| .12       | Envoy internal gateway |
| .13       | Envoy external gateway |
| .14       | AdGuard Home DNS       |
| .100–.102 | Cluster nodes          |

---

## Hardware

| Device           | Qty | CPU             | RAM       | Storage                  | OS          | Function                            |
| ---------------- | --- | --------------- | --------- | ------------------------ | ----------- | ----------------------------------- |
| Minisforum MS-01 | 3   | Intel i9-13900H | 16GB DDR5 | 1TB Samsung 990 Pro NVMe | Talos Linux | Kubernetes (control-plane + worker) |
| UniFi UDM Pro    | 1   | -               | -         | -                        | -           | Gateway / firewall                  |
| UniFi US-8-60W   | 1   | -               | -         | -                        | -           | PoE switch (APs)                    |
| UniFi UAP-AC-Pro | 1   | -               | -         | -                        | -           | WiFi 5 AP                           |
| UniFi U6-Pro     | 1   | -               | -         | -                        | -           | WiFi 6 AP                           |

The 3 MS-01 nodes are interconnected via **Thunderbolt 4** in a full mesh topology (10.0.10.0/24). Each node has 2x SFP+ 10GbE ports reserved for a future USW-Aggregation switch and TrueNAS NAS.

---

## Gratitude and Thanks

Thanks to all the people who donate their time to the [Home Operations](https://discord.gg/home-operations) Discord community. Be sure to check out [kubesearch.dev](https://kubesearch.dev/) for ideas on how to deploy applications.

This cluster was built using the [onedr0p/cluster-template](https://github.com/onedr0p/cluster-template).
