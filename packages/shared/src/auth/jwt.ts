import jwt from "jsonwebtoken";
import { loadConfig } from "../config.js";

/**
 * Asymmetric JWTs (ADR-007, review fix #11). Only the API/auth service holds
 * the private key; every other service verifies with the public key. HS256
 * (the doc's choice) shares one secret across every validator — large blast
 * radius if any service is compromised.
 */
export type Role = "admin" | "editor" | "viewer";

export interface AccessClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
  typ: "access";
}

export interface RefreshClaims {
  sub: string;
  tid: string;
  /** rotation family id — lets us revoke a whole refresh chain */
  fam: string;
  typ: "refresh";
}

export function signAccess(claims: Omit<AccessClaims, "typ">): string {
  const cfg = loadConfig();
  return jwt.sign({ ...claims, typ: "access" }, cfg.jwtPrivateKey, {
    algorithm: cfg.JWT_ALG as jwt.Algorithm,
    expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS,
    issuer: "flow",
  });
}

export function signRefresh(claims: Omit<RefreshClaims, "typ">): string {
  const cfg = loadConfig();
  return jwt.sign({ ...claims, typ: "refresh" }, cfg.jwtPrivateKey, {
    algorithm: cfg.JWT_ALG as jwt.Algorithm,
    expiresIn: cfg.REFRESH_TOKEN_TTL_SECONDS,
    issuer: "flow",
  });
}

export function verifyAccess(token: string): AccessClaims {
  const cfg = loadConfig();
  const c = jwt.verify(token, cfg.jwtPublicKey, {
    algorithms: [cfg.JWT_ALG as jwt.Algorithm],
    issuer: "flow",
  }) as unknown as AccessClaims;
  if (c.typ !== "access") throw new Error("not an access token");
  return c;
}

export function verifyRefresh(token: string): RefreshClaims {
  const cfg = loadConfig();
  const c = jwt.verify(token, cfg.jwtPublicKey, {
    algorithms: [cfg.JWT_ALG as jwt.Algorithm],
    issuer: "flow",
  }) as unknown as RefreshClaims;
  if (c.typ !== "refresh") throw new Error("not a refresh token");
  return c;
}
