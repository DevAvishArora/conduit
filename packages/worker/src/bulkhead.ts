import { KEYS, redis } from "@conduit/shared";

/**
 * Per-tenant concurrency bulkhead (review fix #6). One tenant can't occupy
 * more than `cap` worker slots — preventing the doc's single FIFO from causing
 * head-of-line blocking for everyone else. This is a coarse fix; per-tenant
 * streams + weighted dispatch would be the next step.
 */
export async function acquireSlot(tenantId: string, cap: number): Promise<boolean> {
  const key = KEYS.tenantInflight(tenantId);
  const n = await redis().incr(key);
  if (n === 1) await redis().expire(key, 600); // self-heal stuck counters
  if (n > cap) {
    await redis().decr(key);
    return false;
  }
  return true;
}

export async function releaseSlot(tenantId: string): Promise<void> {
  await redis().decr(KEYS.tenantInflight(tenantId));
}
