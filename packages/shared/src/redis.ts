import Redis from "ioredis";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

/**
 * Shared Redis connections. Blocking reads (XREADGROUP BLOCK) tie up a
 * connection, so callers that block get their own dedicated connection via
 * `newRedis()`; everything else shares the singleton.
 */
let _shared: Redis | null = null;

export function redis(): Redis {
  if (_shared) return _shared;
  _shared = newRedis();
  return _shared;
}

export function newRedis(): Redis {
  const cfg = loadConfig();
  const client = new Redis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null, // required for blocking commands
    enableReadyCheck: true,
  });
  client.on("error", (err) => logger.error({ err }, "redis error"));
  return client;
}

export async function closeRedis(): Promise<void> {
  if (_shared) {
    await _shared.quit();
    _shared = null;
  }
}

export type { Redis };
