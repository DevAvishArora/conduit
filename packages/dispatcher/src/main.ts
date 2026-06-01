import { randomUUID } from "node:crypto";
import {
  closePool,
  closeRedis,
  logger,
  newRedis,
  type NodeCompletedMessage,
  queues,
  type RunStartCommand,
  startMetricsServer,
  type StreamMessage,
  type StreamQueue,
} from "@conduit/shared";
import { handleNodeCompleted, handleRunStart } from "./ops.js";
import { runDelayedPump } from "./delayed.js";
import { runReaper } from "./reaper.js";

const consumer = `dispatcher-${randomUUID().slice(0, 8)}`;
let stopping = false;
const stop = (): boolean => stopping;

/**
 * Run XGROUP CREATE on each stream using a SHORT-LIVED redis client that we
 * close immediately afterwards — previously this leaked an extra connection
 * for the whole lifetime of the process.
 */
async function ensureGroups(): Promise<void> {
  const r = newRedis();
  try {
    const q = queues(r);
    await q.runStart.ensureGroup();
    await q.nodeCompleted.ensureGroup();
    await q.nodeTasks.ensureGroup(); // worker's group; the API publishes to this stream too
  } finally {
    await r.quit().catch((err) => logger.warn({ err }, "ensureGroups redis quit failed"));
  }
}

/**
 * Generic consume loop:
 *  - reclaim stale entries from peers (XAUTOCLAIM) so a crashed dispatcher's
 *    work is picked up — review fix #10
 *  - block-read new entries via XREADGROUP
 *  - ack on success; on failure leave un-ACKed so the next claim cycle gets it
 */
async function runConsumer<T>(
  name: string,
  q: StreamQueue<T>,
  handler: (m: T) => Promise<void>,
): Promise<void> {
  const claimEveryNCycles = 5;
  let cycle = 0;
  while (!stopping) {
    cycle++;
    try {
      if (cycle % claimEveryNCycles === 0) {
        const stale = await q.claimStale(consumer, 60_000, 20);
        for (const m of stale) await processMessage(name, q, m, handler);
      }
      const msgs = await q.consume(consumer, { count: 10, blockMs: 2000 });
      for (const m of msgs) await processMessage(name, q, m, handler);
    } catch (err) {
      logger.error({ err, name }, "consumer cycle error");
      await sleep(1000);
    }
  }
}

async function processMessage<T>(
  name: string,
  q: StreamQueue<T>,
  m: StreamMessage<T>,
  handler: (m: T) => Promise<void>,
): Promise<void> {
  try {
    await handler(m.body);
    await q.ack(m.id);
  } catch (err) {
    logger.error({ err, name, id: m.id }, "handler failed; leaving un-acked for retry");
    // Don't ack — XAUTOCLAIM will pick it up after idle window.
  }
}

async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ sig }, "dispatcher shutting down");
  // 5s grace — long enough for the slowest in-flight handler (typical p99
  // node execution is <2s), short enough that an orchestrator kill timer
  // won't beat us. The consume loop already checks `stopping` between cycles.
  await sleep(5000);
  try {
    await closeRedis();
  } catch (err) {
    logger.error({ err }, "redis close failed");
  }
  try {
    await closePool();
  } catch (err) {
    logger.error({ err }, "pg pool close failed");
  }
  // exitCode rather than exit() so logs flush before exit.
  process.exitCode = 0;
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

(async (): Promise<void> => {
  logger.info({ consumer }, "dispatcher starting");
  startMetricsServer(Number(process.env.METRICS_PORT ?? 8081));
  await ensureGroups();
  const q = queues(newRedis());

  // Run consumers + ancillary loops concurrently; they share `stopping`. Each
  // gets a .catch so a thrown rejection doesn't sink into the event-loop's
  // unhandledRejection and crash the whole dispatcher silently.
  const guard = (name: string) => (err: unknown) => {
    logger.error({ err, loop: name }, "background loop rejected; dispatcher continues");
  };
  void runConsumer<RunStartCommand>("runStart", q.runStart, (m) =>
    handleRunStart(m.run_id, m.tenant_id),
  ).catch(guard("runStart"));
  void runConsumer<NodeCompletedMessage>(
    "nodeCompleted",
    q.nodeCompleted,
    handleNodeCompleted,
  ).catch(guard("nodeCompleted"));
  void runDelayedPump(stop).catch(guard("delayedPump"));
  void runReaper(stop).catch(guard("reaper"));
  logger.info("dispatcher ready");
})().catch((err) => {
  logger.error({ err }, "dispatcher boot failed");
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
