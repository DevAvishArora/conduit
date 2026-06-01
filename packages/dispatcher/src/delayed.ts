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
      // Pipeline the xadds so a slow Redis doesn't serialise the whole batch
      // and exceed our lease TTL — otherwise a peer could acquire leadership
      // mid-pump and re-pop the same items we're still publishing.
      const pipe = r.pipeline();
      for (const raw of due) {
        let env: DelayedEnvelope;
        try {
          env = JSON.parse(raw) as DelayedEnvelope;
        } catch (err) {
          logger.error({ err, raw }, "delayed: bad envelope, dropping");
          continue;
        }
        // Explicit allow-list rather than `=== "node_tasks" ? a : b` — any
        // unexpected value should be loudly rejected, not silently routed to
        // node_completed where it could re-enter the dispatcher in disguise.
        let dest: string;
        if (env.stream === "node_tasks") dest = STREAMS.nodeTasks;
        else if (env.stream === "node_completed") dest = STREAMS.nodeCompleted;
        else {
          logger.error(
            { stream: env.stream, raw },
            "delayed: envelope has unknown stream, dropping",
          );
          continue;
        }
        pipe.xadd(dest, "*", "d", JSON.stringify(env.body));
      }
      await pipe.exec();
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
