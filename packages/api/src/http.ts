import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type Role, unauthorized } from "@conduit/shared";

/** Authenticated request context attached by the auth middleware. */
export interface Auth {
  userId: string;
  tenantId: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  auth?: Auth;
  rawBody?: Buffer;
}

/**
 * Resolve the authenticated context. Throws a 401 (NOT a generic 500) when the
 * route was reached without `authenticate` first running — surfacing missing
 * auth as the correct status code rather than a server error.
 */
export function requireAuth(req: AuthedRequest): Auth {
  if (!req.auth) throw unauthorized("Authentication required");
  return req.auth;
}

/**
 * Wrap an async handler so BOTH synchronous throws and rejected promises reach
 * the error middleware. Without the try/catch wrapper, a sync `throw` before
 * the first `await` would crash the process because Express only forwards
 * errors that arrive via `next()` or a rejected `Promise`.
 */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req as AuthedRequest, res, next);
      if (out && typeof (out as { catch?: unknown }).catch === "function") {
        (out as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}
