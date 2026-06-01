import { randomUUID } from "node:crypto";
import type { Redis } from "../redis.js";
import { KEYS } from "./names.js";
import { logger } from "../logger.js";

/**
 * Single-active leader election via a Redis lease (ADR-003).
 *
 * Fixes review issue #3: the doc's renew path never extended the TTL, so the
 * leader's key expired every 30s and leadership churned. Here renewal is an
 * atomic compare-and-extend (`SET key me XX PX ttl` only succeeds for the
 * current holder; we additionally guard with a Lua CAS so we never extend a
 * lease another instance has taken).
 */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class Lease {
  readonly instanceId = randomUUID();
  private readonly key: string;
  private heldUntil = 0;

  constructor(
    private readonly r: Redis,
    name: string,
    private readonly ttlMs: number,
  ) {
    this.key = KEYS.lease(name);
  }

  get isLeader(): boolean {
    return Date.now() < this.heldUntil;
  }

  /** Acquire if free, or renew if we already hold it. Returns leadership. */
  async acquireOrRenew(): Promise<boolean> {
    const wasLeader = this.isLeader;
    // Try fresh acquire.
    const acquired = await this.r.set(this.key, this.instanceId, "PX", this.ttlMs, "NX");
    if (acquired === "OK") {
      this.heldUntil = Date.now() + this.ttlMs;
      // Only log on a *transition* into leadership, not on every successful
      // NX after a TTL expiry that the same instance immediately reclaims.
      if (!wasLeader) {
        logger.info({ lease: this.key, instance: this.instanceId }, "lease acquired");
      }
      return true;
    }
    // Already exists — extend only if it's ours (atomic CAS).
    const renewed = (await this.r.eval(
      RENEW_LUA,
      1,
      this.key,
      this.instanceId,
      String(this.ttlMs),
    )) as number;
    if (renewed === 1) {
      this.heldUntil = Date.now() + this.ttlMs;
      return true;
    }
    if (wasLeader) logger.info({ lease: this.key }, "lease lost");
    this.heldUntil = 0;
    return false;
  }

  async release(): Promise<void> {
    await this.r.eval(RELEASE_LUA, 1, this.key, this.instanceId).catch(() => {});
    this.heldUntil = 0;
  }
}
