import { DelayedQueue, Lease, loadConfig, logger, newRedis, STREAMS } from "@conduit/shared";
import type { DelayedEnvelope } from "./ops.js";

/**
 * Single-leader pump: pops due envelopes from the delayed ZSET (atomic Lua so
 * peers never double-dispatch — review fix #9) and routes them to the right
 * stream. Lease renewed every cycle via Lua CAS.
 */
export async function runDelayedPump(stop: () => boolean): Promise<void> {
  const r = newRedis();
  const lease = new Lease(r, "delayed-pump", loadConfig().SCHEDULER_LEASE_TTL_MS);
  const dq = new DelayedQueue(r);
  while (!stop()) {
    try {
      const isLeader = await lease.acquireOrRenew();
      if (!isLeader) {
        await sleep(2000);
        continue;
      }
      const due = await dq.popDue(100);
      if (due.length === 0) {
        await sleep(500);
        continue;
      }
      for (const raw of due) {
        let env: DelayedEnvelope;
        try {
          env = JSON.parse(raw) as DelayedEnvelope;
        } catch (err) {
          logger.error({ err, raw }, "delayed: bad envelope, dropping");
          continue;
        }
        const dest = env.stream === "node_tasks" ? STREAMS.nodeTasks : STREAMS.nodeCompleted;
        await r.xadd(dest, "*", "d", JSON.stringify(env.body));
      }
    } catch (err) {
      logger.error({ err }, "delayed pump cycle error");
      await sleep(1000);
    }
  }
  await lease.release().catch(() => {});
  await r.quit().catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
