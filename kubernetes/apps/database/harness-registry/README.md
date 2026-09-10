# harness-registry

The workflow registry for ai-harness: a `harness-registry` database and role on
the shared `postgres` CNPG cluster, reachable from a Vercel-hosted API.

Deliberately a separate database from `ai-harness`. The registry role is the one
credential that leaves the house, so it must not be the credential that can also
read `harness_tokens`, `harness_credentials` or a run's activity log.

| Resource | What it is |
|---|---|
| `databaserole.yaml` | The `harness-registry` login role — no superuser, no CREATEDB/CREATEROLE, 30 connections |
| `database.yaml` | The `harness-registry` database, owned by that role |
| `secret.sops.yaml` | Its password, as a `kubernetes.io/basic-auth` secret |
| `service.yaml` | `postgres-registry-lb` on 192.168.42.19 — the address the WAN port-forward targets |
| `schema-job.yaml` + `resources/schema.sql` | Applies the `registry_*` tables |

`gen_random_uuid()` is core PostgreSQL from 13 on, so the schema needs no
extension on 16.

## Changing the schema

Edit `resources/schema.sql` **and** bump the Job's `-v1` suffix in
`schema-job.yaml` in the same commit. The SQL is mounted from a hash-suffixed
ConfigMap, so editing it changes the Job's pod spec, and a completed Job is
immutable — without the bump Flux fails the reconcile. Every statement is
`IF NOT EXISTS`, so re-running is safe. Delete the superseded Job by hand.

## Exposing it to Vercel

Vercel functions speak the Postgres wire protocol and cannot run
`cloudflared access tcp`, so the registry needs a real public `host:5432`.
They also have no stable egress address unless you buy Secure Compute, so the
port cannot be narrowed by source IP — it is open, and the defence is pg_hba
plus TLS plus the password.

Three things guard it:

1. **pg_hba**, in `../cloudnativepg/cluster/cluster.yaml`. `harness-registry` is
   the only role accepted from outside, and only over TLS; every other role is
   restricted to the pod and LAN ranges, and a closing `reject` shadows the
   permissive default CNPG would otherwise append. CNPG's fixed rules (local
   peer maps, `streaming_replica` cert auth) are emitted *before* these, so
   replication, the metrics exporter and the operator are untouched.
2. **`externalTrafficPolicy: Local`** on `postgres-registry-lb`. Not a tuning
   knob — under the default `Cluster` policy Cilium SNATs the client to a node
   address in 192.168.42.0/24, the very range pg_hba trusts for all roles, and
   the lockdown above would mean nothing.
3. **A dedicated LB address** (.19), so the port-forward can be withdrawn
   without disturbing how the LAN reaches Postgres on .15.

### Manual steps — in this order

Do not add the port-forward before the pg_hba change is live, or every role in
the cluster is briefly on the internet.

1. Merge, then confirm the rules landed and the cluster is still healthy:

   ```sh
   kubectl exec -n database postgres-2 -c postgres -- \
     sh -c 'grep -v "^#" $(psql -U postgres -tAc "SHOW hba_file") | grep -v "^$"'
   kubectl get cluster -n database postgres        # 2/2, healthy
   ```

   The `reject` must appear last, after the `streaming_replica` rules.

2. **UDM Pro** → port-forward WAN `5432` → `192.168.42.19:5432`, and a Servers
   zone allow rule for it. Because the service is `externalTrafficPolicy: Local`
   only the node currently hosting the primary answers ARP for .19; a failover
   moves the announcement, so expect a few seconds of ARP cache staleness at the
   router when CNPG switches over.

3. **Cloudflare DNS** → an `A` record for `db.<domain>` at your WAN address,
   **DNS-only (grey cloud)**. Cloudflare cannot proxy the Postgres protocol, and
   `cloudflare-dns` runs with `--cloudflare-proxied` as the default — this record
   is deliberately not managed from Git, since the cluster does not know the
   router's WAN address. If your ISP address is dynamic, add a DDNS updater.

### Connecting from Vercel

Use `sslmode=verify-ca`, not `verify-full`. CNPG's server certificate is issued
by the cluster's own CA with SANs for `postgres-rw` and friends only, so
hostname verification against a public name cannot succeed. `verify-ca` still
pins the connection to your CA, which no one else can issue from.

Grab the two values:

```sh
kubectl get secret -n database harness-registry-db-secret \
  -o jsonpath='{.data.password}' | base64 -d          # DB password
kubectl get secret -n database postgres-ca \
  -o jsonpath='{.data.ca\.crt}' | base64 -d           # PGSSLROOTCERT / ssl.ca
```

Then, with `pg`:

```js
new Pool({
  host: 'db.<domain>',
  port: 5432,
  database: 'harness-registry',
  user: 'harness-registry',
  password: process.env.REGISTRY_DB_PASSWORD,
  ssl: { ca: process.env.REGISTRY_DB_CA, rejectUnauthorized: true },
  max: 1,               // one per invocation; the role's cap is 30
})
```

`rejectUnauthorized: true` with an explicit `ca` and no `servername` is
`verify-ca`. Set `REGISTRY_DB_CA` to the PEM above.

A serverless function opens a connection per invocation, so a traffic spike can
exhaust the role's 30. If that starts happening, put a CNPG `Pooler` (pgbouncer,
transaction mode) in front rather than raising the cap — `max_connections` on
the cluster is 200 and shared with Authentik.

## Rotating the password

```sh
sops set kubernetes/apps/database/harness-registry/app/secret.sops.yaml \
  '["stringData"]["password"]' "\"$(head -c 36 /dev/urandom | base64 | tr -d /+=)\""
```

Commit; CNPG applies it to the role, then update the Vercel env var. Note that
`sops` on Windows does not match this repo's `.sops.yaml` path rules — pass
`--config` with a permissive rule, or run it from WSL2.
