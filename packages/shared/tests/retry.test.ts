import { describe, expect, it } from "vitest";
import { computeBackoff, idempotencyKey } from "../src/retry.js";

describe("computeBackoff", () => {
  const policy = { backoff_ms: 1000, max_backoff_ms: 60_000, jitter: false };

  it("doubles per attempt without jitter", () => {
    expect(computeBackoff(1, policy)).toBe(1000);
    expect(computeBackoff(2, policy)).toBe(2000);
    expect(computeBackoff(3, policy)).toBe(4000);
    expect(computeBackoff(7, policy)).toBe(60_000); // capped at max
    expect(computeBackoff(10, policy)).toBe(60_000);
  });

  it("with full jitter, result is within [0, capped]", () => {
    const cap = 4000;
    for (let i = 0; i < 50; i++) {
      const v = computeBackoff(3, { ...policy, jitter: true });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(cap);
    }
  });

  it("jitter uses the seeded RNG when provided", () => {
    const seq = [0, 0.5, 1];
    let i = 0;
    const rng = (): number => seq[i++ % seq.length]!;
    expect(computeBackoff(3, { ...policy, jitter: true }, rng)).toBe(0);
    expect(computeBackoff(3, { ...policy, jitter: true }, rng)).toBe(2000);
    expect(computeBackoff(3, { ...policy, jitter: true }, rng)).toBe(4000);
  });
});

describe("idempotencyKey (review fix #1)", () => {
  it("is stable across retry attempts", () => {
    // Critical correctness property: same (run, node) -> same key regardless
    // of attempt number, so a retried external side effect dedupes.
    const k1 = idempotencyKey("00000000-0000-0000-0000-000000000001", "notify");
    const k2 = idempotencyKey("00000000-0000-0000-0000-000000000001", "notify");
    expect(k1).toBe(k2);
  });

  it("differs by node id", () => {
    const a = idempotencyKey("00000000-0000-0000-0000-000000000001", "notify");
    const b = idempotencyKey("00000000-0000-0000-0000-000000000001", "http");
    expect(a).not.toBe(b);
  });
  it("differs by run id", () => {
    const a = idempotencyKey("00000000-0000-0000-0000-000000000001", "notify");
    const b = idempotencyKey("00000000-0000-0000-0000-000000000002", "notify");
    expect(a).not.toBe(b);
  });
});
