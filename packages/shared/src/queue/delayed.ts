import type { Redis } from "../redis.js";
import { KEYS } from "./names.js";

/**
 * Delayed-task store: a ZSET scored by due-at (ms). Used for retry backoff and
 * DELAY nodes. The pop is an atomic Lua script (ZRANGEBYSCORE + ZREM in one
 * round trip), so running N pumps can never double-dispatch the same member
 * (review fix #9). Durability for long DELAYs is NOT solely here — the run also
 * persists wake_at in Postgres, so a Redis flush is recoverable.
 */
const POP_DUE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local due = redis.call('ZRANGEBYSCORE', key, '-inf', now, 'LIMIT', 0, limit)
if #due > 0 then
  redis.call('ZREM', key, unpack(due))
end
return due
`;

export interface DelayedItem {
  /** opaque payload (JSON-encoded NodeExecutionTask) */
  payload: string;
}

export class DelayedQueue {
  constructor(private readonly r: Redis) {}

  /** Schedule `payload` to become due at `dueAtMs` (epoch ms). */
  async schedule(payload: string, dueAtMs: number): Promise<void> {
    await this.r.zadd(KEYS.delayed, dueAtMs, payload);
  }

  /** Atomically remove and return up to `limit` items now due. */
  async popDue(limit = 100, now = Date.now()): Promise<string[]> {
    const res = (await this.r.eval(
      POP_DUE_LUA,
      1,
      KEYS.delayed,
      String(now),
      String(limit),
    )) as string[];
    return res ?? [];
  }

  async size(): Promise<number> {
    return this.r.zcard(KEYS.delayed);
  }
}
