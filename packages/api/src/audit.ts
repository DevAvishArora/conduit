import type { Db } from "@conduit/shared";
import type { AuthedRequest } from "./http.js";

/**
 * Append an audit record (§7.1.4). Call inside the same withTenant transaction
 * as the state change so the audit row commits atomically with it.
 */
export async function audit(
  db: Db,
  req: AuthedRequest,
  entry: {
    action: string;
    resourceType: string;
    resourceId?: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  const auth = req.auth;
  await db.query(
    `INSERT INTO audit_log
       (tenant_id, actor_user_id, action, resource_type, resource_id, before, after, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      auth?.tenantId ?? null,
      auth?.userId ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      req.ip ?? null,
      req.headers["user-agent"] ?? null,
    ],
  );
}
