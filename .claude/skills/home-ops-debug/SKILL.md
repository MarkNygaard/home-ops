---
name: home-ops-debug
description: >
  This skill should be used when the user wants to debug, troubleshoot, or
  diagnose issues in the home-ops Kubernetes cluster, or says phrases like
  "why is [app] broken", "debug [app]", "what's wrong with [app]",
  "[app] is not working", "check [app] status", "why is [app] failing",
  "troubleshoot [app]", "diagnose [app]", "[app] keeps crashing",
  "[app] won't start", "reconciliation failing", "pods are crashing",
  "check cluster health", or "what's firing".
---

# home-ops-debug

Diagnoses issues in the home-ops Kubernetes cluster using the Flux MCP and Grafana MCP tools. Follows a structured triage workflow to identify root causes efficiently.

## Cluster constants

| Property | Value |
|----------|-------|
| Flux namespace | `flux-system` |
| App namespaces | `cert-manager`, `database`, `default`, `flux-system`, `kube-system`, `media`, `monitoring`, `network`, `security`, `storage`, `system-upgrade` |
| Prometheus datasource | Discover UID via `list_datasources` (type: `prometheus`) |
| Loki datasource | Discover UID via `list_datasources` (type: `loki`) |

## Tool mapping

| What to check | MCP tool |
|---------------|----------|
| Flux Kustomization / HelmRelease status | `flux: get_kubernetes_resources` |
| Pod status, events, services | `flux: get_kubernetes_resources` |
| Pod logs | `flux: get_kubernetes_logs` |
| Pod CPU/memory usage | `flux: get_kubernetes_metrics` |
| Force reconciliation | `flux: reconcile_flux_kustomization` / `reconcile_flux_helmrelease` |
| Prometheus metrics | `grafana: query_prometheus` |
| Application logs (Loki) | `grafana: query_loki_logs` |
| Log error patterns | `grafana: find_error_pattern_logs` |
| Firing alerts | `grafana: list_alert_rules` |
| Dashboard visuals | `grafana: get_panel_image` |

## Workflow

### Step 1 — Identify the target

Determine what the user wants to debug:
- **Specific app** — e.g., "radarr is broken" → app=`radarr`, namespace=`media`
- **Namespace-wide** — e.g., "media apps are down" → scan all apps in namespace
- **Cluster-wide** — e.g., "what's broken" → scan all namespaces
- **Specific symptom** — e.g., "reconciliation stuck" → focus on Flux resources

Use the namespace mapping from the app skill:
- `default` — homepage
- `network` — adguard-home, cloudflare-dns, cloudflare-tunnel, envoy-gateway, k8s-gateway, unifi-dns
- `monitoring` — alloy, gatus, grafana, kube-prometheus-stack, loki, ntfy, ntfy-alertmanager, smartctl-exporter, unpoller
- `database` — cloudnativepg, redis
- `media` — bazarr, flaresolverr, jellyfin, prowlarr, qbittorrent, radarr, recyclarr, seerr, sonarr
- `security` — authentik
- `storage` — volsync

### Step 2 — Flux GitOps layer

Check Flux resources top-down. Run these in parallel when possible:

1. **Kustomization status** — check if the app's Kustomization is ready:
   ```
   flux: get_kubernetes_resources
     apiVersion: kustomize.toolkit.fluxcd.io/v1
     kind: Kustomization
     namespace: <namespace>        # the app's namespace (set by Kustomize transformer)
     name: <app>                   # optional, omit for namespace-wide scan
   ```

2. **HelmRelease status** — check if the HelmRelease is reconciled:
   ```
   flux: get_kubernetes_resources
     apiVersion: helm.toolkit.fluxcd.io/v2
     kind: HelmRelease
     namespace: <namespace>
     name: <app>
   ```

3. **OCIRepository status** — check if the chart source is available:
   ```
   flux: get_kubernetes_resources
     apiVersion: source.toolkit.fluxcd.io/v1
     kind: OCIRepository
     namespace: <namespace>
     name: <app>
   ```

**What to look for:**
- `Ready: False` with a message explaining why
- `Suspended: true` — reconciliation paused
- Dependency failures — a `dependsOn` target not ready
- Source fetch errors — OCI registry unreachable or tag not found
- Validation errors — invalid YAML or Helm values

**If Flux resources look healthy**, the issue is at the Kubernetes or application layer — proceed to Step 3.

**If Flux is stuck**, try reconciling:
```
flux: reconcile_flux_kustomization
  name: <app>
  namespace: <namespace>
  with_source: true
```

### Step 3 — Kubernetes resource layer

Check the workload resources. Run these in parallel:

1. **Pods** — are they running?
   ```
   flux: get_kubernetes_resources
     apiVersion: v1
     kind: Pod
     namespace: <namespace>
     selector: app.kubernetes.io/name=<app>
   ```

2. **Events** — recent warnings or errors:
   ```
   flux: get_kubernetes_resources
     apiVersion: v1
     kind: Event
     namespace: <namespace>
   ```
   Filter events mentioning the app name in the results.

3. **PVCs** — storage bound?
   ```
   flux: get_kubernetes_resources
     apiVersion: v1
     kind: PersistentVolumeClaim
     namespace: <namespace>
     name: <app>
   ```

**What to look for:**
- Pod status: `CrashLoopBackOff`, `ImagePullBackOff`, `Pending`, `OOMKilled`
- Events: `FailedScheduling` (resource constraints), `FailedMount` (PVC issues), `Unhealthy` (probe failures)
- PVC: `Pending` (no storage available)

### Step 4 — Application logs

Fetch logs from the problematic pod. Use the Flux MCP for direct pod logs:

```
flux: get_kubernetes_logs
  pod_name: <pod-name>           # from Step 3 pod listing
  container_name: app            # most apps use "app" as container name
  pod_namespace: <namespace>
  limit: 100
```

If logs are also shipped to Loki, query for broader patterns:

```
grafana: query_loki_logs
  datasourceUid: <loki-uid>
  logql: '{namespace="<namespace>", app_kubernetes_io_name="<app>"} |= "error" or |= "fatal"'
  limit: 50
```

For pattern analysis over time:
```
grafana: find_error_pattern_logs
  name: "<app> error investigation"
  labels: {"namespace": "<namespace>", "app_kubernetes_io_name": "<app>"}
```

### Step 5 — Metrics and alerts (if relevant)

Check resource utilization and alert state:

1. **Pod resource usage:**
   ```
   flux: get_kubernetes_metrics
     pod_namespace: <namespace>
     pod_selector: app.kubernetes.io/name=<app>
   ```

2. **Firing alerts:**
   ```
   grafana: list_alert_rules
   ```
   Filter for rules in `firing` or `pending` state.

3. **Custom PromQL** (when investigating specific symptoms):
   ```
   grafana: query_prometheus
     datasourceUid: <prometheus-uid>
     expr: <query>
     startTime: now-1h
     queryType: instant
   ```

   Useful queries:
   - Restart count: `kube_pod_container_status_restarts_total{namespace="<ns>", pod=~"<app>.*"}`
   - OOM kills: `kube_pod_container_status_last_terminated_reason{namespace="<ns>", reason="OOMKilled"}`
   - CPU throttling: `rate(container_cpu_cfs_throttled_seconds_total{namespace="<ns>", pod=~"<app>.*"}[5m])`
   - Memory usage: `container_memory_working_set_bytes{namespace="<ns>", pod=~"<app>.*", container!=""}`

### Step 6 — Summarize and recommend

Present findings in this structure:

```
## Diagnosis: <app>

**Status:** <one-line summary>

**Root cause:** <what's actually wrong>

**Evidence:**
- <finding 1>
- <finding 2>

**Recommended fix:**
1. <action>
2. <action>
```

Common remediation patterns:
- **Flux validation error** → fix the manifest in the repo, commit, and push
- **Image pull failure** → check image tag/digest, registry availability
- **CrashLoopBackOff** → check logs for startup errors, config issues, missing secrets
- **OOMKilled** → increase memory limits in HelmRelease values
- **PVC Pending** → check StorageClass, node capacity
- **Probe failure** → check if port/path is correct, app startup time vs probe thresholds
- **Dependency not ready** → debug the dependency first (recursive)
- **SOPS decryption failure** → check age key is deployed, secret format is valid

## Important notes

- Always discover datasource UIDs dynamically using `grafana: list_datasources` — never hardcode them.
- Flux Kustomization namespace is the **app's namespace** (set by the Kustomize namespace transformer), not `flux-system`.
- HelmRelease namespace follows the same pattern — it lives in the app's namespace.
- When checking multiple apps, run tool calls in parallel to speed up diagnosis.
- Do NOT take remediation actions (reconcile, delete, apply) without user confirmation — diagnosis only unless asked to fix.
- Pod container names: most apps use `app`, but check the actual container name from the pod spec if `app` doesn't work.
