import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@conduit/shared";

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

export function requireAuth(req: AuthedRequest): Auth {
  if (!req.auth) throw new Error("requireAuth called on unauthenticated request");
  return req.auth;
}

/** Wrap an async handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}
