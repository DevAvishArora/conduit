import type { NextFunction, Response } from "express";
import { KEYS, redis, tooManyRequests } from "@conduit/shared";
import type { AuthedRequest } from "../http.js";

/**
 * Per-tenant fixed-window rate limiter in Redis (§5.3.1).
 *
 * Implementation note: previously this was `INCR` followed by `EXPIRE`, which
 * could leave a key un-expired if the process crashed between the two calls
 * (a slow leak of unbounded windows). The atomic Lua script below does both
 * in a single round trip — `EXPIRE` only fires on the first increment of a
 * fresh key, so windows always have a TTL.
 */
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`.trim();

export function rateLimit(opts: { bucket: string; limit: number; windowSec: number }) {
  if (!Number.isInteger(opts.windowSec) || opts.windowSec <= 0) {
    throw new Error(`rateLimit windowSec must be a positive integer, got ${opts.windowSec}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`rateLimit limit must be a positive integer, got ${opts.limit}`);
  }

  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const tenant = req.auth?.tenantId ?? req.ip ?? "anon";
    const key = KEYS.rateLimit(tenant, opts.bucket);
    try {
      const n = (await redis().eval(SCRIPT, 1, key, String(opts.windowSec))) as number;
      res.setHeader("X-RateLimit-Limit", String(opts.limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.limit - n)));
      if (n > opts.limit) return next(tooManyRequests());
      next();
    } catch {
      // Fail open on limiter errors — availability over strict limiting.
      next();
    }
  };
}
