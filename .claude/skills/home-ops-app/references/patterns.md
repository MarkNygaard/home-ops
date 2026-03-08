# YAML Pattern Templates

Templates for all manifest files. Replace `<app>`, `<namespace>`, `<port>`, and other placeholders with actual values.

---

## ks.yaml — Flux Kustomization

### Minimal (no PVC, no Volsync, no dependsOn)

Note: `metadata.namespace` is omitted — the parent Kustomize namespace transformer adds it automatically.

```yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: <app>
spec:
  interval: 1h
  path: ./kubernetes/apps/<namespace>/<app>/app
  postBuild:
    substituteFrom:
      - name: cluster-secrets
        kind: Secret
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  targetNamespace: <namespace>
  wait: false
```

### With dependsOn

```yaml
  dependsOn:
    - name: <other-app>
      namespace: <namespace-where-other-app-lives>
```

The namespace must be the **actual namespace** of the referenced Kustomization (set by the Kustomize namespace transformer), not `flux-system`.

Common dependsOn values:
- `cloudnativepg-cluster` (namespace: `database`) — apps that need PostgreSQL
- `redis` (namespace: `database`) — apps that need Redis/Valkey
- `authentik` (namespace: `security`) — apps protected by SSO
- `cert-manager` (namespace: `cert-manager`) — apps needing TLS certs
- `intel-gpu-resource-driver` (namespace: `kube-system`) — Jellyfin and other GPU apps

### With Volsync component

```yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: <app>
spec:
  components:
    - ../../../../components/volsync
  interval: 1h
  path: ./kubernetes/apps/<namespace>/<app>/app
  postBuild:
    substitute:
      APP: <app>
      VOLSYNC_CAPACITY: 5Gi        # adjust as needed
    substituteFrom:
      - name: cluster-secrets
        kind: Secret
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  targetNamespace: <namespace>
  wait: false
```

---

## app/kustomization.yaml

### Without secrets or standalone PVC

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./ocirepository.yaml
  - ./helmrelease.yaml
```

### With SOPS secret

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./ocirepository.yaml
  - ./helmrelease.yaml
  - ./secret.sops.yaml
```

### With standalone PVC (no Volsync)

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./ocirepository.yaml
  - ./helmrelease.yaml
  - ./secret.sops.yaml    # remove if no secrets
  - ./pvc.yaml
```

> When using the Volsync component, do NOT include `pvc.yaml` here — the component creates the PVC.

---

## app/ocirepository.yaml

```yaml
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: <app>
spec:
  interval: 15m
  layerSelector:
    mediaType: application/vnd.cncf.helm.chart.content.v1.tar+gzip
    operation: copy
  ref:
    tag: 4.6.2      # check https://github.com/bjw-s-labs/helm-charts/releases for latest
  url: oci://ghcr.io/bjw-s-labs/helm/app-template
```

---

## app/helmrelease.yaml — Variants

### Simple stateless app (no PVC, no secrets)

Example: Excalidraw, FlareSolverr, Echo

```yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: <app>
spec:
  chartRef:
    kind: OCIRepository
    name: <app>
  interval: 1h
  values:
    controllers:
      <app>:
        containers:
          app:
            image:
              repository: <image-repo>
              tag: <tag>
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              capabilities: {drop: ["ALL"]}
            resources:
              requests:
                cpu: 50m
              limits:
                memory: 256Mi
    defaultPodOptions:
      securityContext:
        runAsNonRoot: true
        runAsUser: <uid>      # check image docs; common values: 1000, 101, 65534
        runAsGroup: <gid>
    service:
      app:
        ports:
          http:
            port: <port>
    persistence:
      tmp:
        type: emptyDir        # needed if readOnlyRootFilesystem: true
    route:
      app:
        hostnames:
          - "<app>.${SECRET_DOMAIN}"
        parentRefs:
          - name: envoy-internal    # or envoy-external for public access
            namespace: network
            sectionName: https
```

### App with SOPS secrets

Add to the container spec:
```yaml
            envFrom:
              - secretRef:
                  name: <app>-secret
```

Also add annotation to controller for auto-reload:
```yaml
      <app>:
        annotations:
          reloader.stakater.com/auto: "true"
```

### App with PVC (Volsync-managed)

The PVC is created by the component and is named `${APP}` (resolves to the app name). Reference it as `existingClaim`:

```yaml
    persistence:
      config:
        existingClaim: <app>     # matches APP substitute variable
        globalMounts:
          - path: /config
      tmp:
        type: emptyDir
```

### App with standalone PVC (no Volsync)

```yaml
    persistence:
      config:
        existingClaim: <app>
        globalMounts:
          - path: /config
      tmp:
        type: emptyDir
```

PVC is in `app/pvc.yaml` (see below).

### *arr app pattern (Radarr, Sonarr, Prowlarr, Bazarr)

Uses port override env var to listen on port 80:

```yaml
    controllers:
      <app>:
        annotations:
          reloader.stakater.com/auto: "true"
        containers:
          app:
            image:
              repository: ghcr.io/home-operations/<app>
              tag: <version>@sha256:<digest>    # use pinned digest from ghcr.io
            env:
              TZ: Europe/Copenhagen
              <APP>__APP__INSTANCENAME: <AppName>
              <APP>__APP__THEME: dark
              <APP>__AUTH__METHOD: External
              <APP>__AUTH__REQUIRED: DisabledForLocalAddresses
              <APP>__LOG__DBENABLED: "False"
              <APP>__LOG__LEVEL: info
              <APP>__SERVER__PORT: &port 80
              <APP>__UPDATE__BRANCH: develop
            envFrom:
              - secretRef:
                  name: <app>-secret    # contains <APP>__AUTH__APIKEY
            probes:
              liveness: &probes
                enabled: true
                spec:
                  periodSeconds: 30
                  timeoutSeconds: 5
                  failureThreshold: 5
              readiness:
                <<: *probes
                custom: true
                spec:
                  httpGet:
                    path: /ping
                    port: *port
              startup:
                enabled: true
                spec:
                  failureThreshold: 30
                  periodSeconds: 10
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              capabilities: {drop: ["ALL"]}
            resources:
              requests:
                cpu: 100m
              limits:
                memory: 2Gi
    defaultPodOptions:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
    service:
      app:
        ports:
          http:
            port: *port
    persistence:
      config:
        existingClaim: <app>
      tmp:
        type: emptyDir
    route:
      app:
        hostnames:
          - "<app>.${SECRET_DOMAIN}"
        parentRefs:
          - name: envoy-internal
            namespace: network
            sectionName: https
```

### App with ServiceMonitor (Prometheus scraping)

Add to HelmRelease values:
```yaml
    serviceMonitor:
      app:
        enabled: true
        endpoints:
          - port: http
            scheme: http
            path: /metrics
            interval: 1m
```

### App with no ingress (internal service only)

Omit the `route:` section entirely. The app is reachable only within the cluster via `<app>.<namespace>.svc.cluster.local`.

---

## app/secret.sops.yaml

```yaml
---
# Fill in values before encrypting with: sops -e -i secret.sops.yaml
apiVersion: v1
kind: Secret
metadata:
  name: <app>-secret
stringData:
  <ENV_VAR_NAME>: "CHANGEME"
  <ENV_VAR_NAME2>: "CHANGEME"
```

After filling in values, encrypt:
```bash
sops -e -i kubernetes/apps/<namespace>/<app>/app/secret.sops.yaml
```

The file will have its `stringData` values replaced with ENC[...] ciphertext. Commit the encrypted file.

---

## app/pvc.yaml — Standalone PVC (no Volsync)

Used when an app needs persistent storage but Volsync backup is not required (rebuildable data):

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app>
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi     # adjust as needed
  storageClassName: local-path
```

---

## namespace/namespace.yaml — New namespace

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: <namespace>
  annotations:
    kustomize.toolkit.fluxcd.io/prune: disabled
```

## namespace/kustomization.yaml — Namespace-level Kustomization

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: <namespace>

components:
  - ../../components/sops

resources:
  - ./namespace.yaml
  - ./<app>/ks.yaml      # add one line per app
```

The `namespace:` field is a Kustomize namespace transformer — it sets the namespace on all resources (including Flux Kustomization CRs) in this directory. The `components` reference enables SOPS secret decryption for all child resources.

---

## kubernetes/components/volsync/ — Volsync backup component

Reference: see the `kubernetes/components/volsync/` directory for the component files.

Apps opt in by adding to their `ks.yaml`:
```yaml
  components:
    - ../../../../components/volsync
  postBuild:
    substitute:
      APP: <app>
      VOLSYNC_CAPACITY: 5Gi
```

The component creates: PVC named `${APP}`, a nightly restic backup to R2, and a manual restore trigger.

The component secret uses variables from `cluster-secrets`:
- `VOLSYNC_R2_BUCKET_URL` — e.g., `https://<account-id>.r2.cloudflarestorage.com/cluster-volsync`
- `VOLSYNC_RESTIC_PASSWORD` — strong random password for restic encryption
- `VOLSYNC_R2_ACCESS_KEY_ID` — R2 API token key ID
- `VOLSYNC_R2_SECRET_ACCESS_KEY` — R2 API token secret

These must be present in `kubernetes/components/sops/cluster-secrets.sops.yaml` before Volsync apps can deploy.
