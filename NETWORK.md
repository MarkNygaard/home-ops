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
| 192.168.42.10 | `cluster_api_addr` — Kubernetes API server |
| 192.168.42.11 | `cluster_dns_gateway_addr` — k8s-gateway (internal DNS) |
| 192.168.42.12 | `cluster_gateway_addr` — internal Envoy Gateway |
| 192.168.42.13 | `cloudflare_gateway_addr` — external Envoy Gateway (Cloudflare Tunnel) |
| 192.168.42.100 | MS-01 node 1 |
| 192.168.42.101 | MS-01 node 2 |
| 192.168.42.102 | MS-01 node 3 |
| 192.168.42.200 | TrueNAS (Phase 3) |
| 192.168.42.201 | Mac Mini (Home Assistant) |

These are the values that go into `cluster.yaml` and `nodes.yaml`. Keep `.2`–`.9` and `.14`–`.99` free for future cluster LoadBalancer IPs.

Set the SERVERS VLAN DHCP range to `.150`–`.254` so DHCP never hands out addresses in the reserved ranges above.

> **Mac Mini note:** currently running Proxmox with a HAOS VM and a Docker VM — will be migrated to HAOS directly in the future. Keep the same IP (`192.168.42.201`) through the migration so nothing that talks to Home Assistant needs reconfiguring.

---

## Firewall rules

| Source | Destination | Action | Notes |
|--------|-------------|--------|-------|
| TRUSTED | SERVERS | Allow | Management access to cluster and services |
| TRUSTED | IOT | Allow | Control smart home devices from trusted devices |
| TRUSTED | DEFAULT | Allow | Reach legacy devices |
| TRUSTED | internet | Allow | |
| SERVERS | internet | Allow | Pull container images, Cloudflare Tunnel, external APIs |
| SERVERS | IOT | Allow | Home Assistant (192.168.42.201) needs to reach IoT devices to send commands and poll state |
| SERVERS | TRUSTED | Block | Servers don't initiate to client devices |
| IOT | SERVERS:1883 | Allow | MQTT — IoT devices publish to broker on SERVERS (Zigbee2MQTT etc.) |
| IOT | internet | Allow | Smart home cloud connectivity |
| IOT | SERVERS | Block | Default block — must come after the specific MQTT allow above |
| IOT | TRUSTED | Block | |
| GUEST | internet | Allow | |
| GUEST | SERVERS | Block | |
| GUEST | TRUSTED | Block | |
| GUEST | IOT | Block | |
| DEFAULT | internet | Allow | During transition — tighten later |
| DEFAULT | SERVERS | Block | |
| DEFAULT | TRUSTED | Block | |

> **UniFi controller inform:** UniFi devices call home to the controller on port 8080. The controller runs on the cluster (SERVERS VLAN) in Phase 1–2. Add a specific rule: `any → SERVERS:8080 allow` so APs and switches on other VLANs can reach it. This rule can be removed in Phase 3 when the controller moves to the UDM Pro Max.

> **Home Assistant mDNS discovery:** IoT devices announce themselves via mDNS (multicast) which doesn't cross VLANs by default. Enable mDNS reflection on the IOT network in UniFi (Settings → Networks → IOT → enable mDNS) so Home Assistant can discover devices as if they were on the same network.

---

## Wireless networks

| SSID | VLAN | Notes |
|------|------|-------|
| MM | TRUSTED | Personal devices |
| MM-IoT | IOT | Smart home devices — hidden SSID, separate SSID keeps them isolated |
| MM-Guest | GUEST | Guest access — visible SSID |

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

8. **Add port-specific rules** — replace the broad `Allow IOT to SERVERS` rule with specific ports:
   - IOT → SERVERS:1883 (MQTT)
   - IOT → SERVERS:8123 (Home Assistant, if needed)
9. **Add DEFAULT block rules** — if all devices are off the DEFAULT VLAN by now:
   - Block DEFAULT → SERVERS
   - Block DEFAULT → TRUSTED

---

## UniFi setup steps

~~Do this before the servers arrive~~ — **completed.**

1. ~~Log into UniFi Network controller~~
2. ~~**Create VLANs:** Settings → Networks → Add Network for each VLAN above (set VLAN ID, subnet, enable DHCP)~~
3. ~~**Create WiFi networks:** Settings → WiFi → Add WiFi for MM/MM-IoT/MM-Guest, assign each to its VLAN~~
4. ~~**Set port profiles:** Devices → switch → Port Manager — assign profiles per the table above~~
5. ~~**Add firewall rules:** Settings → Firewall & Security → add rules per the table above~~
6. **Move devices:** reassign each device to its VLAN — _in progress_ (personal devices → TRUSTED, IoT devices → MM-IoT, Mac Mini → SERVERS)
7. **Reserve SERVERS IPs:** in the SERVERS DHCP scope, add static reservations for the cluster IPs listed above so they never get handed out to other devices
8. **Tighten DEFAULT rules:** after all devices are off the DEFAULT VLAN, add Block DEFAULT→SERVERS and Block DEFAULT→TRUSTED rules
