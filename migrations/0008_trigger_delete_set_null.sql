-- ════════════════════════════════════════════════════════════════
-- 0008 — Allow trigger deletion when historical runs exist.
--
-- Previously runs.trigger_id was `UUID REFERENCES triggers(id)` with no
-- ON DELETE clause, which defaults to NO ACTION. Postgres then refused to
-- delete a trigger that had ever fired a run (23503 / runs_trigger_id_fkey).
--
-- Swap to ON DELETE SET NULL: historical run rows survive (audit/observability
-- want this), the trigger_id reference simply becomes NULL once its parent
-- trigger is gone. The column was already nullable so no data migration is
-- needed. cron_state.trigger_id keeps ON DELETE CASCADE — scheduling state
-- is ephemeral and correctly dies with its trigger.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE runs DROP CONSTRAINT runs_trigger_id_fkey;
ALTER TABLE runs ADD CONSTRAINT runs_trigger_id_fkey
  FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE SET NULL;
