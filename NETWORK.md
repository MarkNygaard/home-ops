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

| Device | Role | Reason |
|--------|------|--------|
| UniFi USW-Aggregation | SFP+ aggregation | 8× SFP+ ports — connects all 3 MS-01 nodes + TrueNAS at 10G, with SFP+ uplink to UDM Pro. Bought together with the NAS. |
| UniFi US-8-60W | PoE switch (kept) | Existing 8-port PoE switch — continues to serve APs and low-bandwidth devices. Connects to UDM Pro via GbE uplink. |

> **Phase 1 (before NAS):** MS-01 nodes connect directly to UDM Pro via 1GbE ports. SFP+ ports are unused until the USW-Aggregation arrives in Phase 3.

> **Future:** When more ports are needed (new house, additional devices), add a 48-port switch (e.g. USW-48-PoE) to replace the US-8-60W.

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
| 192.168.42.10 | `cluster_api_addr` — Kubernetes API server |
| 192.168.42.11 | `cluster_dns_gateway_addr` — k8s-gateway |
| 192.168.42.12 | `cluster_gateway_addr` — internal Envoy Gateway |
| 192.168.42.13 | `cloudflare_gateway_addr` — external Envoy Gateway (Cloudflare Tunnel) |
| 192.168.42.100 | MS-01 node 1 |
| 192.168.42.101 | MS-01 node 2 |
| 192.168.42.102 | MS-01 node 3 |
| 192.168.42.200 | TrueNAS (Phase 3) |
| 192.168.42.201 | Mac Mini (Proxmox host) |
| 192.168.42.202 | Home Assistant VM |
| 192.168.42.203 | Docker VM |

These are the values that go into `cluster.yaml` and `nodes.yaml`. Keep `.2`–`.9` and `.14`–`.99` free for future cluster LoadBalancer IPs.

Set the SERVERS VLAN DHCP range to `.150`–`.254` so DHCP never hands out addresses in the reserved ranges above.

> **Mac Mini note:** running Proxmox at `.201` with Home Assistant VM at `.202` and Docker VM at `.203`. When MS-01s arrive, `.10` and `.11` will be used for cluster services (already freed).

---

## Firewall rules

Using the **Zone-Based Firewall** with **custom zones**. Each VLAN is assigned to its own zone (or shares one with a similar trust level). The default posture between custom zones is **Block All**, so only explicit allow rules are needed — no block rules required.

### Zones

| Zone | VLAN(s) | Purpose |
|------|---------|---------|
| Trusted | TRUSTED | Personal devices, full management access |
| Servers | SERVERS | Kubernetes nodes, NAS, Home Assistant |
| IoT | IOT | Smart home devices — isolated, pin-hole access only |
| Untrusted | GUEST, DEFAULT | Low-trust devices — internet only, no cross-VLAN access |

### Custom policies

**Allow rules:**

| # | Name | Source Zone | Source | Dest Zone | Dest | Notes |
|---|------|------------|--------|-----------|------|-------|
| 1 | Trusted → Servers | Trusted | Any | Servers | Any | Management access to cluster, Proxmox, services |
| 2 | Trusted → IoT | Trusted | Any | IoT | Any | Control smart home devices from personal devices |
| 3 | Trusted → Untrusted | Trusted | Any | Untrusted | Any | Reach legacy/guest devices |
| 4 | Servers → IoT (HA) | Servers | 192.168.42.202 | IoT | Any | HA only — controls WLED, sensors, etc. |
| 5 | IoT → Servers MQTT | IoT | Any | Servers | 192.168.42.202, TCP 1883 | MQTT broker scoped to HA IP |
| 6 | IoT → Servers DNS | IoT | Any | Servers | 192.168.42.12, TCP/UDP 53 | IoT devices resolve via cluster DNS gateway |
| 7 | IoT → Servers (LG TV) | IoT | 192.168.69.10 | Servers | 192.168.42.12, TCP 443 | LG TV needs HTTPS access to internal Envoy Gateway |

**Return traffic rules** (Connection State: Return Traffic):

| # | Name | Source Zone | Dest Zone | Covers return for |
|---|------|------------|-----------|-------------------|
| 8 | Servers → Trusted (Return) | Servers | Trusted | Rule 1 |
| 9 | IoT → Trusted (Return) | IoT | Trusted | Rule 2 |
| 10 | Untrusted → Trusted (Return) | Untrusted | Trusted | Rule 3 |
| 11 | IoT → Servers (Return) | IoT | Servers | Rule 4 |
| 12 | Servers → IoT (Return) | Servers | IoT | Rules 5, 6, 7 |

**Blocked by default** (no rules needed — inter-zone default is Block All):

| Traffic | Why blocked |
|---------|-------------|
| IoT → Trusted | IoT devices can't initiate to personal devices |
| IoT → Untrusted | No reason for IoT to reach guest/default devices |
| Servers → Trusted | Servers don't initiate to client devices |
| Servers → Untrusted | Servers don't need guest/default access |
| Untrusted → Servers | Guest/default devices can't reach cluster |
| Untrusted → Trusted | Guest/default devices can't reach personal devices |
| Untrusted → IoT | Guest/default devices can't reach smart home |
| Guest ↔ Default | Isolated from each other within the Untrusted zone (inter-zone block) |

> **Why per-pair return traffic rules?** The UDM Pro's "Auto Allow Return Traffic" checkbox on allow rules does not work reliably. Explicit return traffic rules (Connection State: Return Traffic) are required for each zone pair that has an allow rule. Without them, responses to allowed connections get dropped by the inter-zone Block All default.

> **mDNS discovery:** mDNS proxy is enabled on TRUSTED, SERVERS, and IOT VLANs (per-network mDNS checkbox). IoT devices announce via mDNS; Home Assistant and Trusted devices discover them via `.local` names across VLANs. The proxy only rebroadcasts service announcements — it does not bypass firewall rules.

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

| Port | Switch | Profile | Notes |
|------|--------|---------|-------|
| MS-01 nodes (SFP+) | USW-Aggregation | SERVERS (access) | Untagged SERVERS VLAN (Phase 3; UDM Pro 1GbE ports until then) |
| NAS (SFP+) | USW-Aggregation | SERVERS (access) | Untagged SERVERS VLAN (Phase 3) |
| USW-Aggregation uplink | UDM Pro | Trunk | SFP+ — all VLANs tagged |
| APs | US-8-60W | Trunk | Tagged: TRUSTED, IOT, GUEST; untagged: DEFAULT |
| US-8-60W uplink | UDM Pro | Trunk | GbE — all VLANs tagged |
| Unassigned ports | Either | DEFAULT | Safe default for unknown devices |

---

## Phase 3 — USW-Aggregation switch addition

When the USW-Aggregation arrives, add it alongside the existing US-8-60W and move nodes to SFP+ ports.

### Add the aggregation switch

1. **Backup controller config:** Settings → System → Backup → Download backup
2. Connect SFP+ uplink from USW-Aggregation to the UDM Pro's SFP+ LAN port
3. Adopt the USW-Aggregation in the UDM Pro controller
4. Assign port profiles on the USW-Aggregation (SERVERS access for all SFP+ ports carrying node/NAS traffic)
5. Move MS-01 nodes from UDM Pro 1GbE ports to SFP+ ports on the USW-Aggregation
6. Connect TrueNAS NAS via SFP+ to the USW-Aggregation
7. US-8-60W stays in place for APs and other devices (connected to UDM Pro via GbE)

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
6. ~~**Configure mDNS:** Enable mDNS checkbox on Trusted, Servers, and IoT networks~~
7. ~~**Move devices:** personal devices → MM, IoT devices (Echo, WLED, Sonos) → MM-IoT, Mac Mini → SERVERS~~
8. ~~**Add DEFAULT block rules:** Default → Servers block, Default → Trusted block~~
9. **Reserve SERVERS IPs:** in the SERVERS DHCP scope, add static reservations for the cluster IPs listed above so they never get handed out to other devices
