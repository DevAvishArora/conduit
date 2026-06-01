import { promisify } from "node:util";
import { closePool, closeRedis, loadConfig, logger } from "@conduit/shared";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const app = buildApp();
const server = app.listen(cfg.API_PORT, () => {
  logger.info({ port: cfg.API_PORT }, "api listening");
});

const closeServer = promisify(server.close.bind(server));

async function shutdown(sig: string): Promise<void> {
  logger.info({ sig }, "api shutting down");
  // 10s grace for in-flight requests; after that we proceed regardless so the
  // orchestrator's kill timer doesn't beat us to it.
  const grace = setTimeout(() => logger.warn("shutdown grace exceeded"), 10_000);
  try {
    await closeServer();
  } catch (err) {
    logger.error({ err }, "server close failed");
  }
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
  clearTimeout(grace);
  // Use exitCode rather than process.exit() so any remaining logs flush.
  process.exitCode = 0;
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
