import cronParser from "cron-parser";
import {
  closePool,
  closeRedis,
  Lease,
  loadConfig,
  logger,
  metrics,
  newRedis,
  queues,
  redis,
  type RunStartCommand,
  startMetricsServer,
  withSystem,
  withTenant,
} from "@conduit/shared";

/**
 * Cron scheduler (ADR-003, §6.4.2).
 *  - Single active instance via Redis lease with PROPER RENEW (review fix #3).
 *  - Fires are atomic per (trigger, scheduled_for) via the cron_fires unique
 *    key (review fix #4): a crash between enqueue and next_fire_at advance
 *    cannot double-fire on restart.
 *  - next_fire_at is computed from the SCHEDULED time, not wall-clock now, so
 *    drift doesn't accumulate.
 *  - Missed-fire policy per trigger: fire_latest_only (default), fire_all, skip.
 */

let stopping = false;

interface TriggerRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  cron_expr: string;
  next_fire_at: string;
  missed_fire_policy: "fire_all" | "fire_latest_only" | "skip";
}

async function fireOnce(t: TriggerRow, scheduledFor: Date): Promise<void> {
  // Atomic: insert cron_fires first; if conflict, another scheduler already
  // claimed this scheduled time — abort fire silently (review fix #4).
  await withTenant(t.tenant_id, async (db) => {
    const ins = await db.query<{ trigger_id: string }>(
      `INSERT INTO cron_fires (trigger_id, scheduled_for) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING trigger_id`,
      [t.id, scheduledFor.toISOString()],
    );
    if (ins.rowCount === 0) return; // already fired by another instance

    const wf = await db.query<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM workflows WHERE id = $1 AND status = 'active'",
      [t.workflow_id],
    );
    const versionId = wf.rows[0]?.current_version_id;
    if (!versionId) {
      logger.warn(
        { trigger_id: t.id, workflow_id: t.workflow_id },
        "cron skipped: no published version",
      );
      return;
    }
    const run = await db.query<{ id: string }>(
      `INSERT INTO runs (tenant_id, workflow_id, workflow_version_id, trigger_id, status, trigger_payload)
       VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING id`,
      [
        t.tenant_id,
        t.workflow_id,
        versionId,
        t.id,
        JSON.stringify({ payload: { scheduled_for: scheduledFor.toISOString() } }),
      ],
    );
    const runId = run.rows[0]!.id;
    await db.query(
      "UPDATE cron_fires SET run_id = $2 WHERE trigger_id = $1 AND scheduled_for = $3",
      [t.id, runId, scheduledFor.toISOString()],
    );
    const cmd: RunStartCommand = { run_id: runId, tenant_id: t.tenant_id };
    await queues(redis()).runStart.publish(cmd);
    metrics.cronFires.inc({ tenant_id: t.tenant_id });
    metrics.runsStarted.inc({ tenant_id: t.tenant_id, trigger_type: "cron" });
    logger.info(
      { trigger_id: t.id, run_id: runId, scheduled_for: scheduledFor.toISOString() },
      "cron fired",
    );
  });
}

/**
 * Decide which scheduled instants to fire and what the new next_fire_at is,
 * based on policy. Cron base is always the previous scheduled time, never the
 * wall clock — eliminates drift.
 */
function plan(
  expr: string,
  fromScheduled: Date,
  now: Date,
  policy: TriggerRow["missed_fire_policy"],
): { toFire: Date[]; nextAt: Date } {
  let cur = fromScheduled;
  const due: Date[] = [];
  // Step from the previous scheduled time forward, collecting every fire <= now.
  while (cur <= now) {
    due.push(cur);
    cur = cronParser.parseExpression(expr, { currentDate: cur, utc: true }).next().toDate();
    if (due.length > 10_000) break; // hard safety stop on bad cron
  }
  if (due.length === 0) return { toFire: [], nextAt: cur };
  if (policy === "skip") return { toFire: [], nextAt: cur };
  if (policy === "fire_latest_only") return { toFire: [due[due.length - 1]!], nextAt: cur };
  // fire_all — capped to avoid floods if the scheduler was off for days
  return { toFire: due.slice(-50), nextAt: cur };
}

async function tick(): Promise<void> {
  const due = await withSystem(async (db) => {
    const { rows } = await db.query<TriggerRow>(
      `SELECT id, tenant_id, workflow_id, cron_expr, next_fire_at, missed_fire_policy
         FROM triggers
        WHERE type = 'cron' AND active = TRUE AND next_fire_at <= now()
        ORDER BY next_fire_at LIMIT 100`,
    );
    return rows;
  });
  const now = new Date();
  for (const t of due) {
    let nextAt: Date;
    try {
      const { toFire, nextAt: na } = plan(
        t.cron_expr,
        new Date(t.next_fire_at),
        now,
        t.missed_fire_policy,
      );
      nextAt = na;
      for (const sched of toFire) await fireOnce(t, sched);
    } catch (err) {
      logger.error(
        { err, trigger_id: t.id, cron_expr: t.cron_expr },
        "cron plan/fire failed; deactivating",
      );
      await withTenant(t.tenant_id, (db) =>
        db.query("UPDATE triggers SET active = FALSE WHERE id = $1", [t.id]),
      );
      continue;
    }
    // Advance pointer regardless of policy.
    await withTenant(t.tenant_id, (db) =>
      db.query("UPDATE triggers SET last_fired_at = now(), next_fire_at = $2 WHERE id = $1", [
        t.id,
        nextAt.toISOString(),
      ]),
    );
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const r = newRedis();
  const lease = new Lease(r, "scheduler", cfg.SCHEDULER_LEASE_TTL_MS);

  while (!stopping) {
    try {
      if (!(await lease.acquireOrRenew())) {
        await sleep(5_000);
        continue;
      }
      await tick();
      // Sleep ~10s — fine for second-resolution cron at our SLO (skew p99 30s).
      await sleep(10_000);
    } catch (err) {
      logger.error({ err }, "scheduler cycle error");
      await sleep(5_000);
    }
  }
  await lease.release().catch(() => {});
}

async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ sig }, "scheduler shutting down");
  await sleep(1000);
  await closeRedis().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("scheduler starting");
startMetricsServer(Number(process.env.METRICS_PORT ?? 8083));
main().catch((err) => {
  logger.error({ err }, "scheduler boot failed");
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
