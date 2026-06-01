import { Router } from "express";
import { z } from "zod";
import {
  badRequest,
  conflict,
  type Db,
  hashPassword,
  type Role,
  SignInSchema,
  signAccess,
  signRefresh,
  SignUpSchema,
  unauthorized,
  verifyPassword,
  verifyRefresh,
  withSystem,
} from "@conduit/shared";
import { asyncHandler } from "../http.js";

export const authRouter = Router();

// Single source of truth for credential constraints — same zod schemas the
// React forms use via @conduit/shared/schemas. Server and client can't drift.
const Credentials = SignInSchema;
const Register = SignUpSchema;

interface UserRow {
  id: string;
  tenant_id: string;
  hashed_password: string;
  role: Role;
}

async function newFamily(db: Db, userId: string, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO refresh_families (user_id, tenant_id) VALUES ($1,$2) RETURNING id",
    [userId, tenantId],
  );
  return rows[0]!.id;
}

async function issueTokens(userId: string, tenantId: string, role: Role) {
  const fam = await withSystem((db) => newFamily(db, userId, tenantId));
  return {
    access_token: signAccess({ sub: userId, tid: tenantId, role }),
    refresh_token: signRefresh({ sub: userId, tid: tenantId, fam }),
    token_type: "Bearer" as const,
  };
}

// Bootstrap a tenant + its first admin. (Self-service onboarding is a v3 item;
// this gives the system a way in for demos/tests.)
authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = Register.parse(req.body);
    const out = await withSystem(async (db) => {
      // The dup-check + INSERT live in the SAME withSystem transaction so two
      // concurrent registrations can't both pass the check and both insert.
      // Even with the check, a unique-violation on (email) is still possible
      // under high concurrency — caught below and translated into a clean 409.
      const dup = await db.query("SELECT 1 FROM users WHERE email = $1", [body.email]);
      if (dup.rowCount > 0) throw conflict("email already registered");
      try {
        const tenant = await db.query<{ id: string }>(
          "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
          [body.tenant_name],
        );
        const tenantId = tenant.rows[0]!.id;
        const hashed = await hashPassword(body.password);
        const user = await db.query<{ id: string }>(
          "INSERT INTO users (tenant_id, email, hashed_password, role) VALUES ($1,$2,$3,'admin') RETURNING id",
          [tenantId, body.email, hashed],
        );
        return { userId: user.rows[0]!.id, tenantId };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw conflict("email already registered");
        throw err;
      }
    });
    res.status(201).json(await issueTokens(out.userId, out.tenantId, "admin"));
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = Credentials.parse(req.body);
    const user = await withSystem(async (db) => {
      const { rows } = await db.query<UserRow>(
        "SELECT id, tenant_id, hashed_password, role FROM users WHERE email = $1",
        [body.email],
      );
      return rows[0];
    });
    // Verify even when the user is missing to avoid a timing oracle on emails.
    const ok = await verifyPassword(
      body.password,
      user?.hashed_password ?? "$2a$12$0000000000000000000000000000000000000000000000000000",
    );
    if (!user || !ok) throw unauthorized("invalid credentials");
    res.json(await issueTokens(user.id, user.tenant_id, user.role));
  }),
);

/**
 * Refresh-token rotation. The presented refresh token has its family REVOKED
 * and a brand-new family minted in the same transaction. This means:
 *   - Each successful refresh produces a fresh `fam` claim in the new token.
 *   - Re-presenting the OLD refresh token fails because its family is now
 *     revoked (token-replay detection — essentially the BCP-style "rotated
 *     refresh token" pattern).
 *   - The lookup is keyed on (id, user_id, tenant_id) so a token whose tenant
 *     claim doesn't match the family's stored tenant is rejected as if the
 *     family were unknown.
 */
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = z.object({ refresh_token: z.string() }).parse(req.body).refresh_token;
    let claims;
    try {
      claims = verifyRefresh(token);
    } catch {
      throw unauthorized("invalid refresh token");
    }
    const result = await withSystem(async (db) => {
      const fam = await db.query<{ revoked: boolean }>(
        // Lookup is keyed on the FULL identity (id + user + tenant) so a token
        // whose claims have drifted from the stored family fails closed.
        // FOR UPDATE serialises concurrent refreshes on the same family — only
        // one wins; the other re-reads `revoked=true` and is rejected.
        `SELECT revoked FROM refresh_families
          WHERE id = $1 AND user_id = $2 AND tenant_id = $3
          FOR UPDATE`,
        [claims.fam, claims.sub, claims.tid],
      );
      if (fam.rowCount === 0) throw unauthorized("unknown refresh family");
      if (fam.rows[0]!.revoked) {
        // Token-replay detection: a revoked family means someone else already
        // rotated this token. The presented one is no longer valid; require
        // the user to re-authenticate.
        throw unauthorized("refresh token already rotated; re-authenticate");
      }
      // Revoke the old family and mint a brand-new one.
      await db.query("UPDATE refresh_families SET revoked = TRUE WHERE id = $1", [claims.fam]);
      const u = await db.query<{ role: Role }>(
        "SELECT role FROM users WHERE id = $1 AND tenant_id = $2",
        [claims.sub, claims.tid],
      );
      if (u.rowCount === 0) throw unauthorized("user gone");
      const newFam = await newFamily(db, claims.sub, claims.tid);
      return { role: u.rows[0]!.role, fam: newFam };
    });
    res.json({
      access_token: signAccess({ sub: claims.sub, tid: claims.tid, role: result.role }),
      refresh_token: signRefresh({ sub: claims.sub, tid: claims.tid, fam: result.fam }),
      token_type: "Bearer",
    });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ refresh_token: z.string() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("refresh_token required");
    try {
      const claims = verifyRefresh(parsed.data.refresh_token);
      await withSystem((db) =>
        // Revoke ONLY if the family genuinely belongs to the user+tenant from
        // the token — defends against a stolen token being used to revoke an
        // arbitrary family by id-guess. If nothing matches, the request still
        // returns 204 (logout is meant to be idempotent).
        db.query(
          "UPDATE refresh_families SET revoked = TRUE WHERE id = $1 AND user_id = $2 AND tenant_id = $3",
          [claims.fam, claims.sub, claims.tid],
        ),
      );
    } catch {
      /* already invalid — treat as success */
    }
    res.status(204).end();
  }),
);
