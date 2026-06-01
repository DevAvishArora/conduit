import {
  DelayedQueue,
  Lease,
  loadConfig,
  logger,
  newRedis,
  type NodeCompletedMessage,
  withSystem,
} from "@conduit/shared";
import type { DelayedEnvelope } from "./ops.js";

/**
 * DELAY recovery backstop (review fix #9). If Redis loses a delayed envelope
 * (worst case: AOF flush window), the run's wake_at < now and status RUNNING
 * is left as evidence — we re-inject the continuation as a NodeCompleted for
 * the RUNNING DELAY attempt. Idempotent: if it already fired and advanced, the
 * dispatcher's handler will see a non-RUNNING attempt and just re-emit a
 * NodeCompleted event (harmless duplicate event).
 */
export async function runReaper(stop: () => boolean): Promise<void> {
  const r = newRedis();
  const lease = new Lease(r, "delay-reaper", loadConfig().SCHEDULER_LEASE_TTL_MS);
  const dq = new DelayedQueue(r);
  const GRACE_MS = 60_000;
  const SCAN_EVERY_MS = 30_000;
  let lastScan = 0;

  while (!stop()) {
    try {
      // Renew every loop iteration so the lease TTL is never reached.
      if (!(await lease.acquireOrRenew())) {
        await sleep(5000);
        continue;
      }
      if (Date.now() - lastScan < SCAN_EVERY_MS) {
        await sleep(5000);
        continue;
      }
      lastScan = Date.now();
      const rows = await withSystem(async (db) => {
        const { rows } = await db.query<{
          run_id: string;
          tenant_id: string;
          node_id: string;
          attempt_number: number;
        }>(
          `SELECT r.id AS run_id, r.tenant_id, na.node_id, na.attempt_number
             FROM runs r
             JOIN LATERAL (
               SELECT node_id, attempt_number FROM node_attempts
                WHERE run_id = r.id AND status = 'RUNNING' AND node_type = 'DELAY'
                ORDER BY started_at DESC LIMIT 1
             ) na ON TRUE
            WHERE r.status = 'RUNNING'
              AND r.wake_at IS NOT NULL
              AND r.wake_at < now() - ($1 || ' milliseconds')::interval
            LIMIT 50`,
          [String(GRACE_MS)],
        );
        return rows;
      });
      for (const row of rows) {
        const msg: NodeCompletedMessage = {
          run_id: row.run_id,
          tenant_id: row.tenant_id,
          node_id: row.node_id,
          attempt: row.attempt_number,
          outcome: "SUCCEEDED",
          output: { source: "reaper" },
        };
        const env: DelayedEnvelope = { stream: "node_completed", body: msg };
        // Schedule due immediately so the pump (or this dispatcher) routes it.
        await dq.schedule(JSON.stringify(env), Date.now());
        logger.warn(
          { run_id: row.run_id, node_id: row.node_id },
          "reaper: re-injected DELAY continuation",
        );
      }
    } catch (err) {
      logger.error({ err }, "reaper cycle error");
      await sleep(5000);
    }
  }
  await lease.release().catch(() => {});
  await r.quit().catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
