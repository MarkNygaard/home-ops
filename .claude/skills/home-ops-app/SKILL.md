---
name: home-ops-app
description: >
  This skill should be used when the user wants to add a new application to
  the home-ops Kubernetes project, requests scaffolding for a new app, wants
  to deploy a specific app to the cluster, or says phrases like "add [app] to
  home-ops", "create a new app for [app]", "scaffold [app] for kubernetes",
  "deploy [app] to the cluster", "set up [app] in home-ops", "create manifests
  for [app]", or "add [app] to the cluster".
---

# home-ops-app

Creates all Kubernetes GitOps manifest files for a new application in the home-ops project, following the project's established patterns.

## Project constants

| Property | Value |
|----------|-------|
| Domain variable | `${SECRET_DOMAIN}` (resolves to `mnygaard.io`) |
| Helm chart | `oci://ghcr.io/bjw-s-labs/helm/app-template` |
| External gateway | `envoy-external` (namespace: `network`) — internet-accessible via Cloudflare Tunnel |
| Internal gateway | `envoy-internal` (namespace: `network`) — LAN-only |
| Phase 1 StorageClass | `local-path` |
| Secrets method | SOPS-encrypted `secret.sops.yaml` (age key, not ExternalSecret) |
| Substitution source | `cluster-secrets` Secret (injected via `postBuild.substituteFrom`) |
| Image preference | `ghcr.io/home-operations/<app>` first, then official images |

Namespaces and their purpose:
- `default` — user-facing dashboards (Homepage)
- `network` — networking infrastructure (Envoy, DNS, cloudflared)
- `monitoring` — observability (Prometheus, Grafana, Loki, Gatus, Ntfy)
- `database` — data stores (CloudNativePG, Redis, Qdrant)
- `media` — media stack (Jellyfin, *arr apps, qBittorrent)
- `automation` — workflow tools (n8n, Crawl4AI)
- `storage` — storage operators (Volsync)
- `security` — identity/auth (Authentik)
- `productivity` — general tools (Excalidraw)

## Port note

Ports do NOT conflict between apps in Kubernetes — each pod has its own network namespace. The container port is simply what the app listens on internally; it is fixed by the app, not chosen by the user. Routing is by hostname (via HTTPRoute), not port. Only LoadBalancer services need a unique IP (from pool `192.168.42.14+`).

## Workflow

### Step 1 — Look up app in catalog

Check `references/app-catalog.md` for the app name. If found, present all pre-filled values for confirmation. If not found, gather each value interactively, explaining what each means:
- **Namespace**: which logical group this app belongs to (see list above)
- **Image**: `ghcr.io/home-operations/<app>` if it exists, otherwise the official image. Include a pinned tag/digest.
- **Container port**: fixed by the app — look it up in the app's docs.
- **Ingress**: does it need a web UI? If yes, `envoy-external` (public) or `envoy-internal` (LAN only)?
- **PVC**: does it store state that must survive pod restarts? If yes, how much capacity (default: `5Gi`).
- **Volsync**: should the PVC be backed up to Cloudflare R2? Only for non-rebuildable state (user config, watch history, SSO data). Skip for rebuildable data (media files, embeddings, cached thumbnails).
- **SOPS secrets**: does it need API keys, passwords, or tokens as env vars? List the variable names.
- **dependsOn**: does it require another Kustomization to be ready first? (e.g., `cloudnativepg` for DB apps, `authentik` for SSO-protected apps)

### Step 2 — Check namespace directory

If `kubernetes/apps/<namespace>/` does not exist, create:
- `kubernetes/apps/<namespace>/namespace.yaml` — see `references/patterns.md`
- `kubernetes/apps/<namespace>/kustomization.yaml` — see `references/patterns.md`

Flux auto-discovers namespace subdirectories — no parent registration needed.

### Step 3 — Create app file structure

```
kubernetes/apps/<namespace>/<app>/
├── ks.yaml                        # Flux Kustomization CR
└── app/
    ├── kustomization.yaml         # Kustomize resource list
    ├── ocirepository.yaml         # Helm chart source
    ├── helmrelease.yaml           # Helm chart config + values
    ├── secret.sops.yaml           # (only if SOPS secrets needed)
    └── pvc.yaml                   # (only if PVC needed AND no Volsync)
```

If Volsync: do NOT create a standalone `pvc.yaml`. The `kubernetes/components/volsync/` component manages the PVC.

Use templates from `references/patterns.md` for each file.

### Step 4 — Update namespace kustomization

Append `- ./<app>/ks.yaml` to `kubernetes/apps/<namespace>/kustomization.yaml` resources list.

### Step 5 — Check Volsync component

If the app uses Volsync and `kubernetes/components/volsync/` does not exist, inform the user it needs to be created and provide the files from `references/patterns.md`. If it already exists, just reference the component in the app's `ks.yaml`.

### Step 6 — Print next steps

After creating files, always print:
1. If `secret.sops.yaml` was created: fill in placeholder values, then encrypt: `sops -e -i kubernetes/apps/<namespace>/<app>/app/secret.sops.yaml`
2. If Volsync is used and `cluster-secrets` doesn't yet have Volsync variables, remind the user to add `VOLSYNC_R2_BUCKET_URL`, `VOLSYNC_RESTIC_PASSWORD`, `VOLSYNC_R2_ACCESS_KEY_ID`, `VOLSYNC_R2_SECRET_ACCESS_KEY` to `kubernetes/components/sops/cluster-secrets.sops.yaml`
3. Commit and push to trigger Flux: `git add -A && git commit -m "feat: add <app>" && git push`
4. Watch reconciliation: `flux get kustomizations -w` or use the Flux Web UI

## Key patterns

- Always add `reloader.stakater.com/auto: "true"` annotation to controllers that use secrets or configmaps
- Always include `tmp: type: emptyDir` persistence if the container needs a writable temp dir (common with `readOnlyRootFilesystem: true`)
- Security context defaults: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities: {drop: ["ALL"]}`
- For apps with port override env vars (all *arr apps), set port to `80` and use `&port 80` YAML anchor
- HTTPRoute `sectionName: https` routes HTTPS traffic from the gateway listener

See `references/patterns.md` for complete YAML templates.
See `references/app-catalog.md` for known app settings.
