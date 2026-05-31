import type { NextFunction, Response } from "express";
import { KEYS, redis, tooManyRequests } from "@conduit/shared";
import type { AuthedRequest } from "../http.js";

/**
 * Per-tenant fixed-window rate limiter in Redis (§5.3.1). INCR + first-write
 * EXPIRE is atomic enough for coarse limiting; a true sliding window would use
 * a sorted set, but this keeps the hot path to one round trip.
 */
export function rateLimit(opts: { bucket: string; limit: number; windowSec: number }) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const tenant = req.auth?.tenantId ?? req.ip ?? "anon";
    const key = KEYS.rateLimit(tenant, opts.bucket);
    try {
      const n = await redis().incr(key);
      if (n === 1) await redis().expire(key, opts.windowSec);
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
