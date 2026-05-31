import cronParser from "cron-parser";
import { Router } from "express";
import { z } from "zod";
import {
  type Db,
  generateWebhookSecret,
  KEYS,
  loadConfig,
  metrics,
  notFound,
  queues,
  redis,
  type RunStartCommand,
  secrets,
  unprocessable,
  verifyWebhook,
  withSystem,
  withTenant,
} from "@conduit/shared";
import { asyncHandler, type AuthedRequest, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../audit.js";

export const triggersRouter = Router({ mergeParams: true }); // mounted at /v1/workflows/:id/triggers
export const webhookRouter = Router();

function webhookUrl(triggerId: string): string {
  return `${loadConfig().PUBLIC_BASE_URL}/v1/triggers/webhook/${triggerId}`;
}

/** Trigger summaries for a workflow, with webhook URLs (no secrets). */
export async function triggerSummaries(db: Db, workflowId: string) {
  const { rows } = await db.query<{
    id: string;
    type: "webhook" | "cron";
    cron_expr: string | null;
    active: boolean;
    last_fired_at: string | null;
    next_fire_at: string | null;
  }>(
    `SELECT id, type, cron_expr, active, last_fired_at, next_fire_at
       FROM triggers WHERE workflow_id = $1 ORDER BY created_at`,
    [workflowId],
  );
  return rows.map((t) => ({
    ...t,
    webhook_url: t.type === "webhook" ? webhookUrl(t.id) : undefined,
  }));
}

const AttachBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("webhook") }),
  z.object({
    type: z.literal("cron"),
    cron_expr: z.string().min(1),
    missed_fire_policy: z.enum(["fire_all", "fire_latest_only", "skip"]).optional(),
  }),
]);

// POST /v1/workflows/:id/triggers  (router mounted with mergeParams)
triggersRouter.post(
  "/",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const workflowId = req.params["id"]!;
    const body = AttachBody.parse(req.body);

    let nextFireAt: Date | null = null;
    if (body.type === "cron") {
      try {
        nextFireAt = cronParser.parseExpression(body.cron_expr, { utc: true }).next().toDate();
      } catch {
        throw unprocessable(`invalid cron expression: ${body.cron_expr}`);
      }
    }

    // Generate + encrypt the webhook secret OUTSIDE the row tx (it opens its own
    // tenant tx); we only get to show the plaintext once.
    let plaintextSecret: string | undefined;
    let secretCipher: Buffer | null = null;
    if (body.type === "webhook") {
      plaintextSecret = generateWebhookSecret();
      secretCipher = await secrets.encryptForTenant(tenantId, plaintextSecret);
    }

    const created = await withTenant(tenantId, async (db) => {
      const wf = await db.query("SELECT 1 FROM workflows WHERE id = $1 AND status='active'", [
        workflowId,
      ]);
      if (wf.rowCount === 0) throw notFound("workflow not found or archived");
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO triggers (tenant_id, workflow_id, type, webhook_secret_ciphertext, cron_expr, next_fire_at, missed_fire_policy)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'fire_latest_only')) RETURNING id`,
        [
          tenantId,
          workflowId,
          body.type,
          secretCipher,
          body.type === "cron" ? body.cron_expr : null,
          nextFireAt,
          body.type === "cron" ? (body.missed_fire_policy ?? null) : null,
        ],
      );
      const id = rows[0]!.id;
      await audit(db, req, {
        action: "trigger.create",
        resourceType: "trigger",
        resourceId: id,
        after: { type: body.type },
      });
      return id;
    });

    res.status(201).json({
      id: created,
      type: body.type,
      ...(body.type === "webhook"
        ? { webhook_url: webhookUrl(created), secret_shown_once: plaintextSecret }
        : { cron_expr: body.cron_expr, next_fire_at: nextFireAt }),
    });
  }),
);

// DELETE /v1/triggers/:triggerId
export const triggerDeleteRouter = Router();
triggerDeleteRouter.delete(
  "/:triggerId",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["triggerId"]!;
    const ok = await withTenant(tenantId, async (db) => {
      const { rowCount } = await db.query("DELETE FROM triggers WHERE id = $1", [id]);
      if (rowCount)
        await audit(db, req, { action: "trigger.delete", resourceType: "trigger", resourceId: id });
      return rowCount > 0;
    });
    if (!ok) throw notFound("trigger not found");
    res.status(204).end();
  }),
);

// ════════════════════════════════════════════════════════════════
// Webhook ingress — POST /v1/triggers/webhook/:triggerId  (NO auth; HMAC)
// ════════════════════════════════════════════════════════════════
webhookRouter.post(
  "/webhook/:triggerId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const cfg = loadConfig();
    const triggerId = req.params["triggerId"]!;
    const rawBody = req.rawBody ?? Buffer.from("");

    // Trigger lookup is cross-tenant (no auth context yet) — withSystem.
    const trig = await withSystem(async (db) => {
      const { rows } = await db.query<{
        tenant_id: string;
        workflow_id: string;
        active: boolean;
        type: string;
        webhook_secret_ciphertext: Buffer | null;
      }>(
        `SELECT tenant_id, workflow_id, active, type, webhook_secret_ciphertext
           FROM triggers WHERE id = $1`,
        [triggerId],
      );
      return rows[0];
    });
    if (!trig || trig.type !== "webhook" || !trig.active || !trig.webhook_secret_ciphertext) {
      metrics.webhookIngress.inc({ outcome: "unknown_trigger" });
      throw notFound("webhook trigger not found");
    }

    const secret = await secrets.decryptForTenant(trig.tenant_id, trig.webhook_secret_ciphertext);
    const verdict = verifyWebhook({
      secret,
      rawBody: rawBody.toString("utf8"),
      header: req.headers["x-flow-signature"] as string | undefined,
      windowSeconds: cfg.WEBHOOK_REPLAY_WINDOW_SECONDS,
    });
    if (!verdict.ok) {
      metrics.webhookIngress.inc({ outcome: "bad_signature" });
      const status = verdict.reason === "malformed" ? 400 : 401;
      res
        .status(status)
        .type("application/problem+json")
        .json({
          type: "about:blank",
          title: status === 400 ? "Bad Request" : "Unauthorized",
          status,
          detail: `signature ${verdict.reason}`,
        });
      return;
    }

    // Replay protection: first writer wins on (trigger, delivery-id).
    const deliveryId =
      (req.headers["x-flow-delivery-id"] as string | undefined) ??
      (req.headers["x-flow-signature"] as string);
    const fresh = await redis().set(
      KEYS.webhookNonce(triggerId, deliveryId),
      "1",
      "EX",
      cfg.WEBHOOK_NONCE_TTL_SECONDS,
      "NX",
    );
    if (fresh !== "OK") {
      metrics.webhookIngress.inc({ outcome: "replay" });
      res.status(409).type("application/problem+json").json({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "duplicate delivery",
      });
      return;
    }

    // Resolve the CURRENT published version (review fix #5) and create the run.
    const payload = safeJson(rawBody);
    const runId = await withTenant(trig.tenant_id, async (db) => {
      const wf = await db.query<{ current_version_id: string | null }>(
        "SELECT current_version_id FROM workflows WHERE id = $1 AND status='active'",
        [trig.workflow_id],
      );
      const versionId = wf.rows[0]?.current_version_id;
      if (!versionId) {
        metrics.webhookIngress.inc({ outcome: "no_version" });
        throw unprocessable("workflow has no published version");
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO runs (tenant_id, workflow_id, workflow_version_id, trigger_id, status, trigger_payload)
         VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING id`,
        [trig.tenant_id, trig.workflow_id, versionId, triggerId, JSON.stringify({ payload })],
      );
      return rows[0]!.id;
    });

    const cmd: RunStartCommand = { run_id: runId, tenant_id: trig.tenant_id };
    await queues(redis()).runStart.publish(cmd);
    metrics.webhookIngress.inc({ outcome: "accepted" });
    metrics.runsStarted.inc({ tenant_id: trig.tenant_id, trigger_type: "webhook" });
    res.status(202).json({ run_id: runId, status: "accepted" });
  }),
);

function safeJson(buf: Buffer): unknown {
  const s = buf.toString("utf8");
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
