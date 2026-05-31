import { createHash } from "node:crypto";
import type { RetryPolicy } from "./types.js";

/**
 * Exponential backoff with optional full jitter (§5.4.2):
 *   delay = min(base * 2^(attempt-1), max) (+ jitter up to that delay)
 * `attempt` is the attempt that just FAILED (1-based).
 */
export function computeBackoff(
  attempt: number,
  policy: Pick<RetryPolicy, "backoff_ms" | "max_backoff_ms" | "jitter">,
  rng: () => number = Math.random,
): number {
  const raw = policy.backoff_ms * 2 ** (attempt - 1);
  const capped = Math.min(raw, policy.max_backoff_ms);
  if (!policy.jitter) return capped;
  // Full jitter: random in [0, capped]. Spreads retries, avoids thundering herd.
  return Math.floor(rng() * capped);
}

/**
 * Idempotency key for a node's logical execution.
 *
 * Review fix #1: this is STABLE across retry attempts (no attempt number), so
 * a retried side effect carries the SAME `Idempotency-Key` to the external
 * service and is de-duplicated there. The doc's key included attempt_number,
 * which made every retry look like a brand-new operation (double charges).
 */
export function idempotencyKey(runId: string, nodeId: string): string {
  return createHash("sha256").update(`${runId}:${nodeId}`).digest("hex");
}
