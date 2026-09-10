-- Workflow registry schema for ai-harness.
--
-- Applied by the harness-registry-schema Job. Every statement is guarded with
-- IF NOT EXISTS so the Job is safe to re-run: Flux recreates it whenever the
-- name is bumped, and a retried pod must not fail on the second pass.
BEGIN;

-- Someone who may publish. Keyed on GitHub's numeric id, never the login:
-- logins can be renamed and the old one re-registered by somebody else, so
-- trusting it would let an account be inherited along with its workflows.
CREATE TABLE IF NOT EXISTS registry_publishers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id     bigint NOT NULL UNIQUE,
    github_login  text   NOT NULL,
    display_name  text,
    avatar_url    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Set to stop a publisher publishing further, without deleting their work.
    blocked_at    timestamptz
);

-- What a token the harness holds proves. Phase 2; create it when publishing
-- lands. Stored as a hash — the registry can verify a token, never reproduce
-- one, exactly as `harness_tokens` does.
CREATE TABLE IF NOT EXISTS registry_publisher_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id uuid NOT NULL REFERENCES registry_publishers(id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,
    name         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS registry_publisher_tokens_publisher_idx
    ON registry_publisher_tokens (publisher_id);

-- One per published workflow. `slug` is the library's identifier and is NOT the
-- local file name: the harness writes `.harness/workflows/<name>.yaml`, and a
-- slug must not be able to silently shadow a bundled workflow. Collisions are
-- resolved at install time by asking.
CREATE TABLE IF NOT EXISTS registry_workflows (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         text NOT NULL UNIQUE,
    title        text NOT NULL,
    description  text NOT NULL,
    tags         text[] NOT NULL DEFAULT '{}',
    publisher_id uuid NOT NULL REFERENCES registry_publishers(id),
    -- Settable only by a registry admin. Deliberately not inferred from the
    -- publisher, or the first lookalike account inherits the badge.
    official     boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    -- Soft delete: an unlisted workflow disappears from the library but the
    -- installs that already took it keep resolving.
    unlisted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS registry_workflows_publisher_idx ON registry_workflows (publisher_id);
CREATE INDEX IF NOT EXISTS registry_workflows_listed_idx
    ON registry_workflows (official, updated_at DESC) WHERE unlisted_at IS NULL;

-- Immutable published versions. `version` is a plain per-workflow counter, not
-- semver: the author presses Publish, and nobody wants to choose a number for
-- that. Ordering is all the update check needs.
CREATE TABLE IF NOT EXISTS registry_versions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id  uuid NOT NULL REFERENCES registry_workflows(id) ON DELETE CASCADE,
    version      integer NOT NULL,
    yaml         text NOT NULL,
    changelog    text,
    published_at timestamptz NOT NULL DEFAULT now(),
    -- A version pulled after the fact. Installs holding it are told; nothing is
    -- removed from under them.
    withdrawn_at timestamptz,
    UNIQUE (workflow_id, version)
);

-- One row per (workflow, installation) — the install count is count(*) over
-- this, never a stored number. See "Install count — records, not a counter".
-- `installation_id` is an opaque UUID the harness generates once for itself: not
-- a user, not a hostname.
CREATE TABLE IF NOT EXISTS registry_installs (
    workflow_id     uuid NOT NULL REFERENCES registry_workflows(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    version         integer NOT NULL,
    installed_at    timestamptz NOT NULL DEFAULT now(),
    -- Refreshed whenever that harness reads the library, so a count can later
    -- be narrowed to installs still alive.
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_id, installation_id)
);
CREATE INDEX IF NOT EXISTS registry_installs_seen_idx ON registry_installs (last_seen_at);

COMMIT;
