import type { NextFunction, Response } from "express";
import { forbidden, type Role, unauthorized, verifyAccess } from "@conduit/shared";
import type { AuthedRequest } from "../http.js";

/**
 * Authenticate the bearer token and resolve the tenant from its claims
 * (§5.3.1). The tenant is taken ONLY from the verified token — never from a
 * client-supplied header — so a caller can't cross tenants.
 */
export function authenticate(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized());
  try {
    const claims = verifyAccess(header.slice("Bearer ".length).trim());
    req.auth = { userId: claims.sub, tenantId: claims.tid, role: claims.role };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** Require at least the given role (admin > editor > viewer). */
export function requireRole(min: Role) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (RANK[req.auth.role] < RANK[min]) return next(forbidden(`requires ${min} role`));
    next();
  };
}
