# harness-registry

The workflow registry for ai-harness: a `harness-registry` database and role on
the shared `postgres` CNPG cluster.

**Nothing here is reachable from outside the cluster, by design.** The only
client is the registry API service, which runs in the cluster and is itself
published at `registry.${SECRET_DOMAIN}` through the Cloudflare Tunnel. Postgres
stays on the LAN.

Deliberately a separate database from `ai-harness`. The registry API is a
different program with a different blast radius, so it must not hold the
credential that can also read `harness_tokens`, `harness_credentials` or a run's
activity log.

| Resource | What it is |
|---|---|
| `databaserole.yaml` | The `harness-registry` login role — no superuser, no CREATEDB/CREATEROLE, 30 connections |
| `database.yaml` | The `harness-registry` database, owned by that role |
| `secret.sops.yaml` | Its password, as a `kubernetes.io/basic-auth` secret |
| `schema-job.yaml` + `resources/schema.sql` | Applies the `registry_*` tables |

`gen_random_uuid()` is core PostgreSQL from 13 on, so the schema needs no
extension on 16.

## How the registry is reached

An earlier revision of this directory put a LoadBalancer on 192.168.42.19 and a
WAN port-forward in front of it, so that a Vercel serverless function could
speak the Postgres wire protocol directly. That is not how it works, and the
reasoning is worth keeping because the alternative looks harder than it is.

Direct exposure meant the Postgres protocol on the internet with no source-IP
restriction, since Vercel has no stable egress range without Secure Compute.
It also made the lockdown depend on `externalTrafficPolicy: Local`: under the
default `Cluster` policy Cilium SNATs the client to a node address in
192.168.42.0/24, which pg_hba has to trust for all roles because LAN clients
arriving via `postgres-lb` look the same — so one wrong field and the rules
would have been decorative.

Instead the registry API is a small service in the cluster that owns this
database and exposes HTTP. That is better on three counts, only one of which is
about exposure:

- **HTTP through the tunnel needs no open port at all.** `cloudflared` dials
  out, so there is nothing to forward on the UDM Pro and no listening port on
  the WAN. The Postgres wire protocol could not use the tunnel — TCP ingress
  needs `cloudflared access tcp` running beside the caller — which is what
  forced the port-forward in the first place.
- **The credential never leaves the cluster.** Rotating it is a Flux
  reconcile, not a coordinated change with an external platform's env vars.
- **The registry API is a separate, private program**, not part of the
  open-source harness. Publisher tokens, blocking, the `official` flag and
  anti-abuse rules are things the *operator* of a registry does; shipping them
  in the harness would put endpoints for this registry on every self-hosted
  instance.

The harness reaches the API as a client over HTTPS with a publisher token, so
that half stays open source — it is the same code anyone self-hosting uses to
publish here. Instances inside this cluster skip the tunnel and use cluster DNS.

## Changing the schema

Edit `resources/schema.sql` **and** bump the Job's `-v1` suffix in
`schema-job.yaml` in the same commit. The SQL is mounted from a hash-suffixed
ConfigMap, so editing it changes the Job's pod spec, and a completed Job is
immutable — without the bump Flux fails the reconcile. Every statement is
`IF NOT EXISTS`, so re-running is safe. Delete the superseded Job by hand.

## Rotating the password

```sh
sops set kubernetes/apps/database/harness-registry/app/secret.sops.yaml \
  '["stringData"]["password"]' "\"$(head -c 36 /dev/urandom | base64 | tr -d /+=)\""
```

Commit; CNPG applies it to the role, and the registry API picks it up on restart
(it is annotated for Reloader). No external system needs updating, which is one
of the reasons the credential stays inside.

Note that `sops` on Windows does not match this repo's `.sops.yaml` path rules —
pass `--config` with a permissive rule, or run it from WSL2.
