import { closePool, closeRedis, loadConfig, logger } from "@conduit/shared";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const app = buildApp();
const server = app.listen(cfg.API_PORT, () => {
  logger.info({ port: cfg.API_PORT }, "api listening");
});

async function shutdown(sig: string): Promise<void> {
  logger.info({ sig }, "api shutting down");
  server.close();
  await closeRedis().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
