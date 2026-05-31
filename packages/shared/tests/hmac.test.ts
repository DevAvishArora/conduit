import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signWebhook, verifyWebhook } from "../src/crypto/hmac.js";

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = '{"hello":"world"}';
  const ts = 1_716_290_132;
  const sig = signWebhook(secret, body, ts);

  it("verifies a valid signature", () => {
    const r = verifyWebhook({
      secret,
      rawBody: body,
      header: sig,
      windowSeconds: 300,
      nowMs: ts * 1000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const r = verifyWebhook({
      secret,
      rawBody: '{"hello":"WORLD"}',
      header: sig,
      windowSeconds: 300,
      nowMs: ts * 1000,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a stale timestamp outside the window", () => {
    const r = verifyWebhook({
      secret,
      rawBody: body,
      header: sig,
      windowSeconds: 300,
      nowMs: (ts + 1000) * 1000, // 1000s later
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects a missing header", () => {
    const r = verifyWebhook({ secret, rawBody: body, header: undefined, windowSeconds: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("rejects a malformed header", () => {
    const r = verifyWebhook({ secret, rawBody: body, header: "garbage", windowSeconds: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects a signature signed by a different secret", () => {
    const other = signWebhook("not-the-secret", body, ts);
    const r = verifyWebhook({
      secret,
      rawBody: body,
      header: other,
      windowSeconds: 300,
      nowMs: ts * 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  it("generated secret has the whsec_ prefix and decent length", () => {
    const s = generateWebhookSecret();
    expect(s.startsWith("whsec_")).toBe(true);
    expect(s.length).toBeGreaterThan(24);
  });
});
