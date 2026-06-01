import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature scheme (§6.2.4):
 *   signed_payload = `${timestamp}.${raw_body}`
 *   signature      = hex(hmac_sha256(secret, signed_payload))
 *   header         = `t=${timestamp},v1=${signature}`
 */
export function signWebhook(secret: string, rawBody: string, timestamp: number): string {
  const sig = hmacHex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${sig}`;
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export interface ParsedSignature {
  t: number;
  v1: string;
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!Number.isFinite(t) || !v1) return null;
  return { t, v1 };
}

/**
 * Verify a webhook signature in constant time.
 * Returns a typed reason on failure so the caller can pick the status code.
 */
export function verifyWebhook(opts: {
  secret: string;
  rawBody: string;
  header: string | undefined;
  nowMs?: number;
  windowSeconds: number;
}): { ok: true } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" } {
  if (!opts.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return { ok: false, reason: "malformed" };

  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - parsed.t) > opts.windowSeconds) return { ok: false, reason: "expired" };

  const expected = hmacHex(opts.secret, `${parsed.t}.${opts.rawBody}`);
  if (!constantTimeEqualHex(expected, parsed.v1)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(24).toString("base64url");
}
