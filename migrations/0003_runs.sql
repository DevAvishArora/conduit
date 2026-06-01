-- ════════════════════════════════════════════════════════════════
-- 0003 — Runs, event log, node attempts, cron-fire dedup
-- ════════════════════════════════════════════════════════════════

CREATE TABLE runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    workflow_id         UUID NOT NULL REFERENCES workflows(id),
    workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id),  -- snapshot (ADR-004)
    trigger_id          UUID REFERENCES triggers(id),
    status              TEXT NOT NULL CHECK (status IN
                          ('PENDING','RUNNING','PAUSING','PAUSED',
                           'SUCCEEDED','FAILED','CANCELLED')),
    trigger_payload     JSONB,
    node_count          INT NOT NULL DEFAULT 0,   -- runaway cap (§7.4.1)
    wake_at             TIMESTAMPTZ,              -- DELAY recovery backstop (fix #9)
    -- node to (re)enqueue when a paused run resumes or a failed run is retried
    resume_node_id      TEXT,
    error_summary       TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_tenant_status_started ON runs(tenant_id, status, started_at DESC);
CREATE INDEX idx_runs_workflow ON runs(workflow_id);
-- Reaper scan for delayed continuations whose Redis entry was lost.
CREATE INDEX idx_runs_wake ON runs(wake_at) WHERE status = 'RUNNING' AND wake_at IS NOT NULL;

-- Append-only event log (ADR-001). tenant_id denormalised for RLS + partition
-- locality. Partitioned monthly so retention is a constant-time DETACH/DROP.
CREATE TABLE run_events (
    id           BIGSERIAL,
    tenant_id    UUID NOT NULL,
    run_id       UUID NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_run_events_run ON run_events(run_id, occurred_at);

CREATE TABLE node_attempts (
    id              BIGSERIAL,
    tenant_id       UUID NOT NULL,
    run_id          UUID NOT NULL,
    node_id         TEXT NOT NULL,
    node_type       TEXT NOT NULL,
    attempt_number  INT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
    input_snapshot  JSONB,             -- truncated; overflow ref to object store
    output_snapshot JSONB,
    error_class     TEXT,
    error_message   TEXT,
    idempotency_key TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
-- NOTE: we deliberately do NOT add UNIQUE(run_id,node_id,attempt_number,...).
-- On a partitioned table the partition key must be in every unique constraint,
-- which makes such a constraint unable to actually prevent duplicates (review
-- fix #2). Dedup is enforced in the worker via pg_advisory_xact_lock + a status
-- check, and external side effects are guarded by the stable idempotency key.
CREATE INDEX idx_node_attempts_run ON node_attempts(run_id, node_id, started_at DESC);
CREATE INDEX idx_node_attempts_idem ON node_attempts(idempotency_key);

-- Review fix #4: a cron fire is idempotent per (trigger, scheduled time). A
-- scheduler crash between enqueue and next_fire_at advance can't double-fire.
CREATE TABLE cron_fires (
    trigger_id    UUID NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,
    run_id        UUID,
    fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (trigger_id, scheduled_for)
);

-- ── Partitions ──────────────────────────────────────────────────
-- DEFAULT catch-all guarantees inserts never fail; named monthly partitions
-- (prev/cur/next) demonstrate the retention model. Production would roll these
-- with pg_partman / a monthly job.
DO $$
DECLARE
    base   DATE := date_trunc('month', now())::date;
    m      DATE;
    nextm  DATE;
    tbl    TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['run_events','node_attempts'] LOOP
        EXECUTE format('CREATE TABLE %I_default PARTITION OF %I DEFAULT', tbl, tbl);
        FOR i IN -1..1 LOOP
            m := (base + (i || ' month')::interval)::date;
            nextm := (m + interval '1 month')::date;
            EXECUTE format(
                'CREATE TABLE %I_%s PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                tbl, to_char(m, 'YYYYMM'), tbl, m, nextm);
        END LOOP;
    END LOOP;
END $$;
