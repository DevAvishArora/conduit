import { Router } from "express";
import { z } from "zod";
import { notFound, withTenant } from "@conduit/shared";
import { asyncHandler, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../audit.js";

/**
 * Tenant-level configuration endpoints (admin-only).
 *
 * Today we only expose the failure-notify target — a NOTIFY config shape
 * (channel + slack secret name or email recipient + optional message template
 * with run.* placeholders). The dispatcher reads it at finalize(FAILED) and
 * fires the existing Notify connector inline.
 */
export const tenantRouter = Router();

const FailureNotifyBody = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("slack"),
    config: z.object({
      webhook_url_secret: z.string().min(1),
      message: z.string().optional(),
    }),
  }),
  z.object({
    channel: z.literal("email"),
    config: z.object({
      to: z.string().email(),
      subject: z.string().optional(),
      message: z.string().optional(),
    }),
  }),
]);

tenantRouter.get(
  "/failure-notify",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const cfg = await withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ config: unknown }>(
        "SELECT config FROM connector_configs WHERE connector_type = 'failure_notify' LIMIT 1",
      );
      return rows[0]?.config ?? null;
    });
    if (!cfg) throw notFound("no failure-notify config set");
    res.json(cfg);
  }),
);

tenantRouter.put(
  "/failure-notify",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const body = FailureNotifyBody.parse(req.body);
    await withTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO connector_configs (tenant_id, connector_type, config)
         VALUES ($1, 'failure_notify', $2)
         ON CONFLICT (tenant_id, connector_type)
           DO UPDATE SET config = EXCLUDED.config`,
        [tenantId, JSON.stringify(body)],
      );
      await audit(db, req, {
        action: "tenant.failure_notify.set",
        resourceType: "tenant",
        resourceId: tenantId,
        after: { channel: body.channel },
      });
    });
    res.status(204).end();
  }),
);

tenantRouter.delete(
  "/failure-notify",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    await withTenant(tenantId, async (db) => {
      const { rowCount } = await db.query(
        "DELETE FROM connector_configs WHERE connector_type = 'failure_notify'",
      );
      if (rowCount > 0) {
        await audit(db, req, {
          action: "tenant.failure_notify.clear",
          resourceType: "tenant",
          resourceId: tenantId,
        });
      }
    });
    res.status(204).end();
  }),
);
