import { Router } from "express";
import {
  badRequest,
  conflict,
  type Db,
  notFound,
  queues,
  redis,
  type RunStartCommand,
  type RunStatus,
  withTenant,
} from "@conduit/shared";
import { asyncHandler, type AuthedRequest, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../audit.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

export const runsRouter = Router();

async function loadRunStatus(db: Db, id: string): Promise<RunStatus | null> {
  const { rows } = await db.query<{ status: RunStatus }>("SELECT status FROM runs WHERE id = $1", [
    id,
  ]);
  return rows[0]?.status ?? null;
}

async function emit(db: Db, runId: string, tenantId: string, type: string, payload?: unknown) {
  await db.query(
    "INSERT INTO run_events (tenant_id, run_id, event_type, payload) VALUES ($1,$2,$3,$4)",
    [tenantId, runId, type, payload ? JSON.stringify(payload) : null],
  );
}

// ── list runs ───────────────────────────────────────────────────
runsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const limit = parseLimit(req.query["limit"]);
    const cursor = decodeCursor(req.query["cursor"] as string | undefined);
    const status = req.query["status"] as string | undefined;
    const workflowId = req.query["workflow_id"] as string | undefined;

    const rows = await withTenant(tenantId, async (db) => {
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (cursor) {
        params.push(cursor.ts, cursor.id);
        clauses.push(`(started_at, id) < ($${params.length - 1}, $${params.length})`);
      }
      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      if (workflowId) {
        params.push(workflowId);
        clauses.push(`workflow_id = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(limit + 1);
      const { rows } = await db.query<{
        id: string;
        workflow_id: string;
        workflow_version_id: string;
        status: string;
        started_at: string;
        ended_at: string | null;
        error_summary: string | null;
      }>(
        `SELECT id, workflow_id, workflow_version_id, status, started_at, ended_at, error_summary
           FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows;
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    res.json({
      items,
      next_cursor: hasMore && last ? encodeCursor({ ts: last.started_at, id: last.id }) : null,
    });
  }),
);

// ── get run ─────────────────────────────────────────────────────
runsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const run = await withTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT id, workflow_id, workflow_version_id, trigger_id, status, trigger_payload,
                node_count, wake_at, error_summary, started_at, ended_at
           FROM runs WHERE id = $1`,
        [req.params["id"]],
      );
      return rows[0];
    });
    if (!run) throw notFound("run not found");
    res.json(run);
  }),
);

// ── node attempts for a node ────────────────────────────────────
runsRouter.get(
  "/:id/nodes/:nodeId/attempts",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const rows = await withTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT attempt_number, status, node_type, input_snapshot, output_snapshot,
                error_class, error_message, started_at, ended_at
           FROM node_attempts WHERE run_id = $1 AND node_id = $2
          ORDER BY attempt_number, started_at`,
        [req.params["id"], req.params["nodeId"]],
      );
      return rows;
    });
    res.json({ items: rows });
  }),
);

// ── events: paginated OR SSE stream ─────────────────────────────
runsRouter.get(
  "/:id/events",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const id = req.params["id"]!;
    const wantsStream = req.headers.accept?.includes("text/event-stream");

    if (!wantsStream) {
      const afterId = Number(req.query["after_id"] ?? 0);
      const rows = await withTenant(tenantId, async (db) => {
        const { rows } = await db.query(
          `SELECT id, event_type, payload, occurred_at FROM run_events
            WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 500`,
          [id, afterId],
        );
        return rows;
      });
      res.json({ items: rows });
      return;
    }

    // SSE: poll the event log and push new rows. Reconnect via Last-Event-ID.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastId = Number(req.headers["last-event-id"] ?? req.query["after_id"] ?? 0);
    let open = true;
    req.on("close", () => {
      open = false;
    });
    while (open) {
      const { rows, terminal } = await withTenant(tenantId, async (db) => {
        const r = await db.query<{
          id: number;
          event_type: string;
          payload: unknown;
          occurred_at: string;
        }>(
          `SELECT id, event_type, payload, occurred_at FROM run_events
            WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 200`,
          [id, lastId],
        );
        const st = await loadRunStatus(db, id);
        return { rows: r.rows, terminal: st && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(st) };
      });
      for (const ev of rows) {
        lastId = ev.id;
        res.write(`id: ${ev.id}\nevent: ${ev.event_type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      if (terminal && rows.length === 0) {
        res.write(`event: done\ndata: {}\n\n`);
        break;
      }
      await sleep(750);
    }
    res.end();
  }),
);

// ── control: pause / resume / cancel / retry ────────────────────
runsRouter.post(
  "/:id/pause",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    await control(req, "pause");
    res.status(202).json({ status: "PAUSING" });
  }),
);
runsRouter.post(
  "/:id/resume",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    await control(req, "resume");
    res.status(202).json({ status: "RUNNING" });
  }),
);
runsRouter.post(
  "/:id/cancel",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    await control(req, "cancel");
    res.status(202).json({ status: "CANCELLED" });
  }),
);
runsRouter.post(
  "/:id/retry",
  requireRole("editor"),
  asyncHandler(async (req, res) => {
    await control(req, "retry");
    res.status(202).json({ status: "RUNNING" });
  }),
);

/**
 * Run control. The Run Service only flips status + records intent; the
 * Dispatcher remains the single owner of progression (review fix #7). Resume
 * and retry re-kick the dispatcher by re-publishing a RunStartCommand, which
 * the dispatcher interprets via resume_node_id.
 */
async function control(
  req: AuthedRequest,
  action: "pause" | "resume" | "cancel" | "retry",
): Promise<void> {
  const { tenantId } = requireAuth(req);
  const id = req.params["id"]!;
  let kick = false;
  await withTenant(tenantId, async (db) => {
    const { rows } = await db.query<{ status: RunStatus }>(
      "SELECT status FROM runs WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (rows.length === 0) throw notFound("run not found");
    const status = rows[0]!.status;

    switch (action) {
      case "pause":
        if (status !== "RUNNING") throw conflict(`cannot pause a ${status} run`);
        await db.query("UPDATE runs SET status='PAUSING', updated_at=now() WHERE id=$1", [id]);
        await emit(db, id, tenantId, "PauseRequested");
        break;
      case "resume":
        if (status !== "PAUSED") throw conflict(`cannot resume a ${status} run`);
        await db.query("UPDATE runs SET status='RUNNING', updated_at=now() WHERE id=$1", [id]);
        await emit(db, id, tenantId, "RunResumed");
        kick = true;
        break;
      case "cancel":
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(status))
          throw conflict(`cannot cancel a ${status} run`);
        await db.query(
          "UPDATE runs SET status='CANCELLED', ended_at=now(), updated_at=now() WHERE id=$1",
          [id],
        );
        await emit(db, id, tenantId, "RunCancelled");
        break;
      case "retry": {
        if (!["FAILED", "CANCELLED"].includes(status))
          throw conflict(`can only retry a FAILED/CANCELLED run, not ${status}`);
        // Resume from the last failed node.
        const failed = await db.query<{ node_id: string }>(
          `SELECT node_id FROM node_attempts WHERE run_id=$1 AND status='FAILED'
            ORDER BY started_at DESC LIMIT 1`,
          [id],
        );
        const node = failed.rows[0]?.node_id;
        if (!node) throw badRequest("no failed node to retry");
        await db.query(
          "UPDATE runs SET status='RUNNING', resume_node_id=$2, ended_at=NULL, error_summary=NULL, updated_at=now() WHERE id=$1",
          [id, node],
        );
        await emit(db, id, tenantId, "RunResumed", { retry_from: node });
        kick = true;
        break;
      }
    }
    await audit(db, req, { action: `run.${action}`, resourceType: "run", resourceId: id });
  });
  if (kick) {
    const cmd: RunStartCommand = { run_id: id, tenant_id: tenantId };
    await queues(redis()).runStart.publish(cmd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
