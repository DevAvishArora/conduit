import { Router } from "express";
import { z } from "zod";
import {
  badRequest,
  conflict,
  notFound,
  referencedSecrets,
  unprocessable,
  validateWorkflow,
  withTenant,
} from "@conduit/shared";
import { asyncHandler, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../audit.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import { triggerSummaries } from "./triggers.js";

export const workflowsRouter = Router();

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  definition: z.unknown().optional(),
});
const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  definition: z.unknown().optional(),
});

// ── list ────────────────────────────────────────────────────────
workflowsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const limit = parseLimit(req.query["limit"]);
    const cursor = decodeCursor(req.query["cursor"] as string | undefined);
    const rows = await withTenant(tenantId, async (db) => {
      const params: unknown[] = [];
      let where = "";
      if (cursor) {
        params.push(cursor.ts, cursor.id);
        where = `WHERE (created_at, id) < ($1, $2)`;
      }
      params.push(limit + 1);
      const { rows } = await db.query<{
        id: string;
        name: string;
        status: string;
        current_version: number | null;
        created_at: string;
      }>(
        `SELECT id, name, status, current_version, created_at
           FROM workflows ${where}
          ORDER BY created_at DESC, id DESC
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
      next_cursor: hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null,
    });
  }),
);

// ── create draft ────────────────────────────────────────────────
workflowsRouter.post(
  "/",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = requireAuth(req);
    const body = CreateBody.parse(req.body);
    const row = await withTenant(tenantId, async (db) => {
      const dup = await db.query("SELECT 1 FROM workflows WHERE name = $1", [body.name]);
      if (dup.rowCount > 0) throw conflict("a workflow with that name exists");
      const { rows } = await db.query<{ id: string; created_at: string }>(
        `INSERT INTO workflows (tenant_id, name, draft_definition, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
        [tenantId, body.name, body.definition ? JSON.stringify(body.definition) : null, userId],
      );
      const id = rows[0]!.id;
      await audit(db, req, {
        action: "workflow.create",
        resourceType: "workflow",
        resourceId: id,
        after: { name: body.name },
      });
      return rows[0]!;
    });
    res
      .status(201)
      .json({ id: row.id, name: body.name, status: "active", created_at: row.created_at });
  }),
);

// ── get ─────────────────────────────────────────────────────────
workflowsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const data = await withTenant(tenantId, async (db) => {
      const wf = await db.query<{
        id: string;
        name: string;
        status: string;
        current_version: number | null;
        current_version_id: string | null;
        draft_definition: unknown;
        created_at: string;
        updated_at: string;
      }>("SELECT * FROM workflows WHERE id = $1", [id]);
      if (wf.rowCount === 0) return null;
      const triggers = await triggerSummaries(db, id);
      return { ...wf.rows[0]!, triggers };
    });
    if (!data) throw notFound("workflow not found");
    res.json(data);
  }),
);

// ── update draft ────────────────────────────────────────────────
workflowsRouter.patch(
  "/:id",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const body = PatchBody.parse(req.body);
    if (body.name === undefined && body.definition === undefined)
      throw badRequest("nothing to update");
    const updated = await withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE workflows
            SET name = COALESCE($2, name),
                draft_definition = COALESCE($3, draft_definition),
                updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING id`,
        [id, body.name ?? null, body.definition ? JSON.stringify(body.definition) : null],
      );
      if (rows.length)
        await audit(db, req, {
          action: "workflow.update",
          resourceType: "workflow",
          resourceId: id,
        });
      return rows[0];
    });
    if (!updated) throw notFound("workflow not found or archived");
    res.status(204).end();
  }),
);

// ── publish ─────────────────────────────────────────────────────
workflowsRouter.post(
  "/:id/publish",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = requireAuth(req);
    const id = req.params["id"]!;
    const result = await withTenant(tenantId, async (db) => {
      const wf = await db.query<{ draft_definition: unknown; current_version: number | null }>(
        "SELECT draft_definition, current_version FROM workflows WHERE id = $1 AND status='active' FOR UPDATE",
        [id],
      );
      if (wf.rowCount === 0) throw notFound("workflow not found or archived");
      const draft = wf.rows[0]!.draft_definition;
      if (!draft) throw unprocessable("workflow has no draft definition to publish");

      const v = validateWorkflow(draft);
      if (!v.ok || !v.definition) throw unprocessable("invalid workflow", { errors: v.errors });

      // Referenced secrets must resolve before we publish.
      const needed = referencedSecrets(v.definition);
      if (needed.length) {
        const found = await db.query<{ name: string }>(
          "SELECT name FROM secrets WHERE name = ANY($1)",
          [needed],
        );
        const have = new Set(found.rows.map((r) => r.name));
        const missing = needed.filter((n) => !have.has(n));
        if (missing.length) throw unprocessable("unresolved secret references", { missing });
      }

      const nextVersion = (wf.rows[0]!.current_version ?? 0) + 1;
      const ver = await db.query<{ id: string; published_at: string }>(
        `INSERT INTO workflow_versions (tenant_id, workflow_id, version_number, definition, published_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, published_at`,
        [tenantId, id, nextVersion, JSON.stringify(v.definition), userId],
      );
      await db.query(
        "UPDATE workflows SET current_version = $2, current_version_id = $3, updated_at = now() WHERE id = $1",
        [id, nextVersion, ver.rows[0]!.id],
      );
      await audit(db, req, {
        action: "workflow.publish",
        resourceType: "workflow_version",
        resourceId: ver.rows[0]!.id,
        after: { version_number: nextVersion },
      });
      const triggers = await triggerSummaries(db, id);
      return {
        version_id: ver.rows[0]!.id,
        version_number: nextVersion,
        published_at: ver.rows[0]!.published_at,
        triggers,
      };
    });
    res.status(201).json({ workflow_id: id, ...result });
  }),
);

// ── archive ─────────────────────────────────────────────────────
workflowsRouter.post(
  "/:id/archive",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const ok = await withTenant(tenantId, async (db) => {
      const { rowCount } = await db.query(
        "UPDATE workflows SET status='archived', updated_at=now() WHERE id=$1 AND status='active'",
        [id],
      );
      if (rowCount) {
        await db.query("UPDATE triggers SET active=FALSE WHERE workflow_id=$1", [id]);
        await audit(db, req, {
          action: "workflow.archive",
          resourceType: "workflow",
          resourceId: id,
        });
      }
      return rowCount > 0;
    });
    if (!ok) throw notFound("workflow not found or already archived");
    res.status(204).end();
  }),
);

// ── hard delete ─────────────────────────────────────────────────
// Strict: refuses if any runs (active or historical) reference the workflow.
// Forces the user to archive (soft-delete) instead, which preserves the run
// history. To bypass this safety, the caller can use `?force=true` to cascade
// through workflow_versions / triggers / runs / events / attempts.
workflowsRouter.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const force = req.query["force"] === "true";

    const result = await withTenant(tenantId, async (db) => {
      const wf = await db.query("SELECT 1 FROM workflows WHERE id = $1 FOR UPDATE", [id]);
      if (wf.rowCount === 0) return { kind: "not_found" as const };

      const runs = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM runs WHERE workflow_id = $1",
        [id],
      );
      const runCount = runs.rows[0]!.n;

      if (runCount > 0 && !force) {
        return { kind: "has_runs" as const, runCount };
      }
      if (runCount > 0 && force) {
        // Wipe the run history for this workflow. Partitioned tables have no
        // FK to runs (by design — partition-FKs are painful), so cascade them
        // manually before deleting the runs themselves.
        await db.query(
          "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = $1)",
          [id],
        );
        await db.query(
          "DELETE FROM node_attempts WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = $1)",
          [id],
        );
        await db.query("DELETE FROM runs WHERE workflow_id = $1", [id]);
      }
      // workflow_versions + triggers cascade via FK ON DELETE CASCADE.
      await db.query("DELETE FROM workflows WHERE id = $1", [id]);
      await audit(db, req, {
        action: "workflow.delete",
        resourceType: "workflow",
        resourceId: id,
        before: { runs: runCount, force },
      });
      return { kind: "deleted" as const };
    });

    if (result.kind === "not_found") throw notFound("workflow not found");
    if (result.kind === "has_runs")
      throw conflict(
        `workflow has ${result.runCount} run(s); archive instead or call DELETE with ?force=true to wipe run history`,
      );
    res.status(204).end();
  }),
);

// ── versions ────────────────────────────────────────────────────
workflowsRouter.get(
  "/:id/versions",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const rows = await withTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT id, version_number, published_at, published_by
           FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number DESC`,
        [id],
      );
      return rows;
    });
    res.json({ items: rows });
  }),
);
