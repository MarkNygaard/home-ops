# Network Setup

Home network design for the cluster. See [SETUP.md](SETUP.md) for cluster-specific networking (TB4 mesh, node interfaces).

---

## Hardware

### Current (Phase 1)

| Device | Role |
|--------|------|
| UniFi UDM Pro | Gateway / firewall — replaced USG-3P; built-in controller (removes UniFi controller from cluster); 8× 1GbE LAN ports for nodes |
| UniFi US-8-60W | Main switch (PoE for APs) |
| UniFi UAP-AC-Pro | WiFi (WiFi 5) |
| UniFi U6-Pro | WiFi (WiFi 6) |

### Phase 3 upgrade (new house + rack)

| Device | Replaces | Reason |
|--------|----------|--------|
| UniFi USW-Pro-HD-24-PoE | US-8-60W | 22× 2.5GbE + 2× 10GbE RJ45 + 4× SFP+; enough SFP+ for NAS + nodes without a separate aggregation switch. Connects to UDM Pro via SFP+ uplink. |

---

## VLANs

| VLAN | ID | Subnet | Purpose |
|------|----|--------|---------|
| DEFAULT | 1 | 192.168.1.0/24 | Untagged catch-all — devices that don't support VLANs; new devices before assignment |
| TRUSTED | 10 | 192.168.10.0/24 | Personal computers, phones, management access |
| SERVERS | 42 | 192.168.42.0/24 | Kubernetes nodes, NAS, Mac Mini (Home Assistant) |
| GUEST | 50 | 192.168.50.0/24 | Guest WiFi — internet only |
| IOT | 69 | 192.168.69.0/24 | Smart home devices — isolated from everything else |

VLAN IDs match the third octet for easy cross-referencing.

---

## Reserved IPs — SERVERS VLAN (192.168.42.0/24)

| IP | Purpose |
|----|---------|
| 192.168.42.1 | Gateway (UDM Pro) |
| 192.168.42.10 | **Temporary:** Mac Mini (Proxmox) — becomes `cluster_api_addr` (Kubernetes API server) when MS-01s arrive |
| 192.168.42.11 | **Temporary:** Home Assistant VM — becomes `cluster_dns_gateway_addr` (k8s-gateway) when MS-01s arrive |
| 192.168.42.12 | `cluster_gateway_addr` — internal Envoy Gateway |
| 192.168.42.13 | `cloudflare_gateway_addr` — external Envoy Gateway (Cloudflare Tunnel) |
| 192.168.42.100 | MS-01 node 1 |
| 192.168.42.101 | MS-01 node 2 |
| 192.168.42.102 | MS-01 node 3 |
| 192.168.42.200 | TrueNAS (Phase 3) |
| 192.168.42.201 | Mac Mini (HAOS) — after MS-01 arrival, reinstall Proxmox → HAOS directly |

These are the values that go into `cluster.yaml` and `nodes.yaml`. Keep `.2`–`.9` and `.14`–`.99` free for future cluster LoadBalancer IPs.

Set the SERVERS VLAN DHCP range to `.150`–`.254` so DHCP never hands out addresses in the reserved ranges above.

> **Mac Mini note:** currently running Proxmox (`.10`) with a HAOS VM (`.11`) and a Docker VM. When MS-01s arrive: reinstall Mac Mini with HAOS directly at `.201`, update firewall rules to reference `.201`, and free `.10`/`.11` for cluster services.

---

## Firewall rules

Using the **Zone-Based Firewall** (upgraded from the legacy rule-based model). All VLANs are in the **Internal** zone. The default Internal → Internal posture is **Allow All**, so explicit allow rules are needed above corresponding block rules. Rules with "Return Traffic" use the **Connection State: Return Traffic** setting in UniFi.

**Custom policies (Internal → Internal):**

| # | Name | Action | Source | Destination | Notes |
|---|------|--------|--------|-------------|-------|
| 1 | Servers → IoT (HA) | Allow | 192.168.42.11 | IoT | HA needs to reach IoT devices (e.g. WLED, sensors) |
| 2 | IoT → Servers MQTT | Allow | IoT | 192.168.42.11, TCP 1883 | MQTT broker scoped to HA IP |
| 3 | IoT → Servers (HA Return) | Allow | IoT | 192.168.42.11 | Connection State: Return Traffic — IoT replies to HA |
| 4 | IoT → Trusted (Return Traffic) | Allow | IoT | Trusted | Connection State: Return Traffic — IoT replies when controlled directly from Trusted devices |
| 5 | IoT → Servers | Block | IoT | Servers | |
| 6 | IoT → Trusted | Block | IoT | Trusted | |
| 7 | Trusted → Servers | Allow | Trusted | Servers | Management access to cluster, Proxmox, services |
| 8 | Servers → Trusted (Return Traffic) | Allow | Servers | Trusted | Connection State: Return Traffic — servers respond to trusted-initiated connections |
| 9 | Servers → Trusted | Block | Servers | Trusted | Servers don't initiate to client devices |
| 10 | Guest → Servers | Block | Guest | Servers | |
| 11 | Guest → Trusted | Block | Guest | Trusted | |
| 12 | Guest → IoT | Block | Guest | IoT | |
| 13 | Default → Trusted (Return Traffic) | Allow | Default | Trusted | Connection State: Return Traffic — Default replies when accessed from Trusted devices |
| 14 | Default → Servers | Block | Default | Servers | |
| 15 | Default → Trusted | Block | Default | Trusted | |

**Implicitly allowed by the default Allow All posture** (no rules needed):

| Traffic | Why |
|---------|-----|
| TRUSTED → IOT | Control smart home devices from trusted devices (return traffic handled by rule 4) |
| TRUSTED → DEFAULT | Reach legacy devices (return traffic handled by rule 13) |
| All VLANs → internet | Internal → External defaults to Allow All |

> **Why explicit allow + return traffic rules?** The zone-based firewall's default Allow All posture doesn't reliably handle return traffic when a block rule exists below. For example, Trusted → Servers worked implicitly, but Proxmox couldn't respond back through the Servers → Trusted block. Adding explicit allow rules with Connection State: Return Traffic above the blocks fixed this.

> **Home Assistant mDNS discovery:** mDNS proxy is enabled on SERVERS and IOT VLANs (Gateway mDNS Proxy → Custom scope). IoT devices announce via mDNS and Home Assistant discovers them across VLANs.

---

## Wireless networks

| SSID | VLAN | Notes |
|------|------|-------|
| MM | TRUSTED | Personal devices — WPA2/WPA3 |
| MM-IoT | IOT | Smart home devices — WPA2/WPA3, hidden SSID |
| MM-Guest | GUEST | Guest access — WPA2, visible SSID, client device isolation enabled |

No wireless network for SERVERS — nodes and NAS are wired only.

---

## Switch port profiles

| Port | Profile | Notes |
|------|---------|-------|
| MS-01 nodes | SERVERS (access) | Untagged SERVERS VLAN |
| NAS | SERVERS (access) | Untagged SERVERS VLAN (Phase 3) |
| APs | Trunk | Tagged: TRUSTED, IOT, GUEST; untagged: DEFAULT |
| Inter-switch uplink | Trunk | All VLANs tagged |
| Unassigned ports | DEFAULT | Safe default for unknown devices |

---

## Phase 3 — USW-Pro-HD-24-PoE switch upgrade

When the USW-Pro-HD-24-PoE arrives (new house), swap out the US-8-60W and move nodes to faster ports.

### Replace the switch

1. **Backup controller config:** Settings → System → Backup → Download backup
2. Unplug US-8-60W, plug in USW-Pro-HD-24-PoE
3. Connect SFP+ uplink from the new switch to the UDM Pro's SFP+ LAN port
4. Adopt the new switch in the UDM Pro controller
5. Reassign port profiles (SERVERS access, AP trunk, etc.) on the new switch
6. Move MS-01 nodes from UDM Pro 1GbE ports to 2.5GbE / SFP+ ports on the new switch
7. Connect TrueNAS NAS via SFP+ to the new switch

### After migration — tighten firewall rules

The UDM Pro doesn't have the USG-3P's overriding "allow all LAN" default rules, so port-specific rules work. Revisit the firewall:

8. ~~**Add port-specific rules** — IoT ↔ Servers rules already scoped to HA IP (192.168.42.11) with MQTT on TCP 1883~~
9. ~~**Add DEFAULT block rules** — Default → Servers and Default → Trusted blocks already in place~~

---

## UniFi setup steps

**Completed** — UDM Pro set up from scratch (no USG-3P backup restore).

1. ~~Log into UniFi Network controller~~
2. ~~**Create VLANs:** Settings → Networks → Add Network for each VLAN above (set VLAN ID, subnet, enable DHCP)~~
3. ~~**Create WiFi networks:** Settings → WiFi → Add WiFi for MM/MM-IoT/MM-Guest, assign each to its VLAN~~
4. ~~**Set port profiles:** Devices → switch → Port Manager — assign profiles per the table above~~
5. ~~**Upgrade to Zone-Based Firewall** and add policies per the firewall rules table above~~
6. ~~**Configure mDNS:** Gateway mDNS Proxy → Custom, scope: Servers + IoT~~
7. ~~**Move devices:** personal devices → MM, IoT devices (Echo, WLED, Sonos) → MM-IoT, Mac Mini → SERVERS~~
8. ~~**Add DEFAULT block rules:** Default → Servers block, Default → Trusted block~~
9. **Reserve SERVERS IPs:** in the SERVERS DHCP scope, add static reservations for the cluster IPs listed above so they never get handed out to other devices
