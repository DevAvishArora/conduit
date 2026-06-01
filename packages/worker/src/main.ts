import { randomUUID } from "node:crypto";
import "@conduit/shared/handlers"; // side-effect: register built-in connectors
import {
  closePool,
  closeRedis,
  loadConfig,
  logger,
  newRedis,
  type NodeExecutionTask,
  queues,
  startMetricsServer,
  type StreamMessage,
  type StreamQueue,
} from "@conduit/shared";
import { processTask } from "./loop.js";

const consumer = `worker-${randomUUID().slice(0, 8)}`;
let stopping = false;

async function ensureGroups(): Promise<void> {
  const q = queues(newRedis());
  await q.nodeTasks.ensureGroup();
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  const q = queues(newRedis());
  let cycle = 0;
  while (!stopping) {
    cycle++;
    try {
      // Reclaim stale tasks from peers periodically (XAUTOCLAIM).
      if (cycle % 5 === 0) {
        const stale = await q.nodeTasks.claimStale(consumer, cfg.WORKER_LEASE_MS, 10);
        if (stale.length) await dispatchBatch(q.nodeTasks, stale);
      }
      const msgs = await q.nodeTasks.consume(consumer, {
        count: cfg.WORKER_CONCURRENCY,
        blockMs: 2000,
      });
      if (msgs.length) await dispatchBatch(q.nodeTasks, msgs);
    } catch (err) {
      logger.error({ err }, "worker cycle error");
      await sleep(1000);
    }
  }
}

async function dispatchBatch(
  q: StreamQueue<NodeExecutionTask>,
  batch: StreamMessage<NodeExecutionTask>[],
): Promise<void> {
  await Promise.all(
    batch.map(async (m) => {
      try {
        await processTask(m.body);
        await q.ack(m.id);
      } catch (err) {
        logger.error({ err, id: m.id }, "task handler errored; leaving un-acked");
        // Don't ack — XAUTOCLAIM picks it up after the lease window.
      }
    }),
  );
}

async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ sig }, "worker shutting down");
  await sleep(2000);
  await closeRedis().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

(async (): Promise<void> => {
  logger.info({ consumer }, "worker starting");
  startMetricsServer(Number(process.env.METRICS_PORT ?? 8082));
  await ensureGroups();
  await run();
})().catch((err) => {
  logger.error({ err }, "worker boot failed");
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
