-- ════════════════════════════════════════════════════════════════
-- 0002 — Workflows, immutable versions, triggers
-- ════════════════════════════════════════════════════════════════
CREATE TABLE workflows (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    -- the draft definition being edited (published into workflow_versions)
    draft_definition JSONB,
    -- points at the live published version; resolved at trigger-fire time so
    -- webhooks always run the latest version (review fix #5)
    current_version_id UUID,
    current_version  INT,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
CREATE INDEX idx_workflows_tenant ON workflows(tenant_id) WHERE status = 'active';

CREATE TABLE workflow_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version_number  INT NOT NULL,
    definition      JSONB NOT NULL,            -- full DAG, immutable (ADR-004)
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by    UUID REFERENCES users(id),
    UNIQUE (workflow_id, version_number)
);
CREATE INDEX idx_wfversions_wf ON workflow_versions(workflow_id);

-- FK from workflows.current_version_id, added now that the table exists.
ALTER TABLE workflows
  ADD CONSTRAINT fk_workflows_current_version
  FOREIGN KEY (current_version_id) REFERENCES workflow_versions(id);

-- Review fix #5: triggers belong to the WORKFLOW (stable id => stable webhook
-- URL), not to a version. A run snapshots the resolved version at creation.
CREATE TABLE triggers (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workflow_id              UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    type                     TEXT NOT NULL CHECK (type IN ('webhook','cron')),
    webhook_secret_ciphertext BYTEA,            -- encrypted under tenant DEK; null for cron
    cron_expr                TEXT,              -- null for webhook
    last_fired_at            TIMESTAMPTZ,
    next_fire_at             TIMESTAMPTZ,       -- computed for cron
    missed_fire_policy       TEXT NOT NULL DEFAULT 'fire_latest_only'
                               CHECK (missed_fire_policy IN ('fire_all','fire_latest_only','skip')),
    active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Scheduler's hot query: due cron triggers.
CREATE INDEX idx_triggers_next_fire ON triggers(next_fire_at) WHERE type = 'cron' AND active = TRUE;
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);
