-- ════════════════════════════════════════════════════════════════
-- 0006 — LOOP node support + per-tenant failure-notification config
-- ════════════════════════════════════════════════════════════════

-- ── LOOPs ───────────────────────────────────────────────────────
-- A single JSONB column holds the active loop frame for the run:
--   { loop_node_id, count, index, body_next, next_after_loop }
-- v1 supports one active loop per run (no nesting). We could promote this to
-- a JSON ARRAY for a stack if/when nesting is needed.
ALTER TABLE runs
  ADD COLUMN loop_state JSONB;

-- ── Per-tenant failure notification target ──────────────────────
-- `connector_configs` already exists; the brief's "error notifications to the
-- user" maps cleanly onto a row with connector_type='failure_notify'. Enforce
-- that there's at most one such row per tenant.
ALTER TABLE connector_configs
  ADD CONSTRAINT connector_configs_tenant_type_uq
  UNIQUE (tenant_id, connector_type);
