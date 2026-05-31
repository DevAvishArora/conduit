/** Centralised Redis key / stream / group names. */
export const STREAMS = {
  /** RunStartCommand → Dispatcher */
  runStart: "conduit:stream:run_start",
  /** NodeExecutionTask → Worker pool */
  nodeTasks: "conduit:stream:node_tasks",
  /** NodeCompletedMessage → Dispatcher */
  nodeCompleted: "conduit:stream:node_completed",
} as const;

export const GROUPS = {
  dispatcher: "dispatcher",
  workers: "workers",
} as const;

export const KEYS = {
  /** ZSET of delayed tasks scored by due_at_ms (retries + DELAY nodes). */
  delayed: "conduit:zset:delayed",
  /** Leader-election lease for singleton loops (scheduler, delayed pump). */
  lease: (name: string) => `flow:lease:${name}`,
  /** Per-tenant in-flight node counter (concurrency bulkhead, review fix #6). */
  tenantInflight: (tenantId: string) => `flow:tenant_inflight:${tenantId}`,
  /** Webhook replay-protection nonce. */
  webhookNonce: (triggerId: string, deliveryId: string) =>
    `flow:wh_nonce:${triggerId}:${deliveryId}`,
  /** Sliding-window rate-limit counter per tenant+route. */
  rateLimit: (tenantId: string, bucket: string) => `flow:rl:${tenantId}:${bucket}`,
} as const;
