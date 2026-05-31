import { Router } from "express";
import { withTenant } from "@conduit/shared";
import { asyncHandler, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

/**
 * Audit-log read API (§7.1.4). Admin-only because audit data may contain
 * before/after diffs of tenant configuration — sensitive enough to gate.
 */
export const auditRouter = Router();

auditRouter.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const limit = parseLimit(req.query["limit"]);
    const cursor = decodeCursor(req.query["cursor"] as string | undefined);
    const action = req.query["action"] as string | undefined;

    const rows = await withTenant(tenantId, async (db) => {
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (cursor) {
        params.push(cursor.ts, cursor.id);
        clauses.push(`(occurred_at, id::text) < ($${params.length - 1}, $${params.length})`);
      }
      if (action) {
        params.push(action);
        clauses.push(`action = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(limit + 1);
      const { rows } = await db.query<{
        id: string;
        actor_user_id: string | null;
        action: string;
        resource_type: string;
        resource_id: string | null;
        before: unknown;
        after: unknown;
        ip_address: string | null;
        user_agent: string | null;
        occurred_at: string;
      }>(
        `SELECT id::text, actor_user_id, action, resource_type, resource_id,
                before, after, ip_address, user_agent, occurred_at
           FROM audit_log
          ${where}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return rows;
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    res.json({
      items,
      next_cursor: hasMore && last ? encodeCursor({ ts: last.occurred_at, id: last.id }) : null,
    });
  }),
);
