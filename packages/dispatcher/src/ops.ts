import {
  type Db,
  DelayedQueue,
  idempotencyKey,
  loadConfig,
  logger,
  metrics,
  type NodeCompletedMessage,
  type NodeExecutionTask,
  queues,
  redis,
  STREAMS,
  successors,
  TERMINAL_RUN_STATUSES,
  type WorkflowDefinition,
  withTenant,
} from "@conduit/shared";
import { notifyOnFailure } from "./failureNotify.js";

/**
 * Dispatcher operations: the single owner of run-level state transitions
 * (review fix #7). The worker only owns node-level state; this module wraps
 * every change in a SELECT ... FOR UPDATE on the run so two dispatcher
 * instances racing on the same nodeCompleted message can't double-advance.
 */

/** Envelope on the delayed ZSET — tags the destination stream. */
export interface DelayedEnvelope {
  stream: "node_tasks" | "node_completed";
  body: NodeExecutionTask | NodeCompletedMessage;
}

interface LoopFrame {
  loop_node_id: string;
  count: number;
  index: number;
  body_next: string;
  next_after_loop: string | null;
}

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_version_id: string;
  status: string;
  node_count: number;
  resume_node_id: string | null;
  loop_state: LoopFrame | null;
}

async function loadRunForUpdate(db: Db, runId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    `SELECT id, tenant_id, workflow_version_id, status, node_count, resume_node_id, loop_state
       FROM runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  return rows[0] ?? null;
}

async function loadDef(db: Db, versionId: string): Promise<WorkflowDefinition | null> {
  const { rows } = await db.query<{ definition: WorkflowDefinition }>(
    "SELECT definition FROM workflow_versions WHERE id = $1",
    [versionId],
  );
  return rows[0]?.definition ?? null;
}

async function emit(
  db: Db,
  runId: string,
  tenantId: string,
  type: string,
  payload?: unknown,
): Promise<void> {
  await db.query(
    "INSERT INTO run_events (tenant_id, run_id, event_type, payload) VALUES ($1,$2,$3,$4)",
    [tenantId, runId, type, payload ? JSON.stringify(payload) : null],
  );
}

async function finalize(
  db: Db,
  runId: string,
  tenantId: string,
  status: "SUCCEEDED" | "FAILED",
  errorSummary?: string,
): Promise<void> {
  const { rows } = await db.query<{ started_at: string; workflow_id: string }>(
    "UPDATE runs SET status = $2, ended_at = now(), error_summary = $3, updated_at = now() WHERE id = $1 RETURNING started_at, workflow_id",
    [runId, status, errorSummary ?? null],
  );
  await emit(db, runId, tenantId, status === "SUCCEEDED" ? "RunSucceeded" : "RunFailed", {
    error: errorSummary ?? null,
  });
  metrics.runsFinalized.inc({ tenant_id: tenantId, status });
  if (rows[0]) {
    const seconds = (Date.now() - new Date(rows[0].started_at).getTime()) / 1000;
    metrics.runDuration.observe({ status }, seconds);
  }
  // Fire active failure notification (best-effort, fire-and-forget) — runs
  // outside the current transaction so a delivery hiccup doesn't roll back
  // the finalize itself.
  if (status === "FAILED" && rows[0]) {
    const ctx = {
      run_id: runId,
      workflow_id: rows[0].workflow_id,
      error_summary: errorSummary ?? null,
    };
    setImmediate(() => {
      notifyOnFailure(tenantId, ctx).catch((err) =>
        logger.error({ err, run_id: runId }, "notifyOnFailure threw"),
      );
    });
  }
}

/**
 * Schedule a node for execution.
 *  - DELAY:        record SUCCEEDED attempt + emit NodeStarted, then push a
 *                  delayed NodeCompleted continuation; the dispatcher advances
 *                  to the DELAY's successor when the continuation fires.
 *  - everything else: publish a NodeExecutionTask to the worker stream.
 *
 * Must be called inside a withTenant transaction. Caller is expected to have
 * loaded the run FOR UPDATE already.
 */
export async function scheduleNode(
  db: Db,
  run: RunRow,
  def: WorkflowDefinition,
  nodeId: string,
): Promise<void> {
  const cfg = loadConfig();

  // Runaway cap (§7.4.1).
  const newCount = run.node_count + 1;
  if (newCount > cfg.RUN_MAX_NODES) {
    await finalize(
      db,
      run.id,
      run.tenant_id,
      "FAILED",
      `RUNAWAY: exceeded ${cfg.RUN_MAX_NODES} nodes`,
    );
    return;
  }
  await db.query("UPDATE runs SET node_count = $2, updated_at = now() WHERE id = $1", [
    run.id,
    newCount,
  ]);

  const node = def.nodes[nodeId];
  if (!node) {
    await finalize(db, run.id, run.tenant_id, "FAILED", `unknown node '${nodeId}'`);
    return;
  }
  // Trigger input nodes shouldn't be scheduled as a step — they're the entry.
  if (node.type === "TRIGGER_INPUT") {
    await finalize(db, run.id, run.tenant_id, "FAILED", `TRIGGER_INPUT cannot be a successor`);
    return;
  }

  if (node.type === "DELAY") {
    await handleDelay(db, run, nodeId, node.delay_ms);
    return;
  }

  if (node.type === "LOOP") {
    await handleLoopEnter(db, run, nodeId, node.count, node.body, node.next);
    return;
  }

  // Normal worker-handled node: HTTP_REQUEST / CONDITION / NOTIFY.
  // The dispatcher does NOT insert a node_attempts row — that's the worker's
  // job (see worker loop dedup). Pre-inserting RUNNING here makes the worker
  // mistake its own task for an in-flight peer's and skip.
  const attempt = await nextAttempt(db, run.id, nodeId);
  await emit(db, run.id, run.tenant_id, "NodeStarted", { node_id: nodeId, attempt });

  const task: NodeExecutionTask = {
    run_id: run.id,
    tenant_id: run.tenant_id,
    node_id: nodeId,
    attempt,
    idem_key: idempotencyKey(run.id, nodeId),
  };
  await queues(redis()).nodeTasks.publish(task);
}

/**
 * Enter a LOOP: set the run's loop_state frame to iteration 0, record an
 * attempt for the LOOP node itself (so the timeline shows it), and schedule
 * the body's first node. The body's terminal (next:null) is what triggers the
 * next iteration — see continueOrFinalize().
 *
 * v1: one active loop per run, no nesting. The schema validator allows the
 * back-edge from body → loop_node; the dispatcher's iteration logic is what
 * actually drives the rerun.
 */
async function handleLoopEnter(
  db: Db,
  run: RunRow,
  nodeId: string,
  count: number,
  bodyNext: string,
  nextAfterLoop: string | null,
): Promise<void> {
  if (run.loop_state) {
    // Nested loops aren't supported in v1; finalize the run with a clear error.
    await finalize(
      db,
      run.id,
      run.tenant_id,
      "FAILED",
      `nested LOOP not supported (already inside loop ${run.loop_state.loop_node_id})`,
    );
    return;
  }
  const frame: LoopFrame = {
    loop_node_id: nodeId,
    count,
    index: 0,
    body_next: bodyNext,
    next_after_loop: nextAfterLoop,
  };
  await db.query(`UPDATE runs SET loop_state = $2::jsonb, updated_at = now() WHERE id = $1`, [
    run.id,
    JSON.stringify(frame),
  ]);
  const attempt = await nextAttempt(db, run.id, nodeId);
  await db.query(
    `INSERT INTO node_attempts (tenant_id, run_id, node_id, node_type, attempt_number, status, idempotency_key, output_snapshot, ended_at)
     VALUES ($1,$2,$3,'LOOP',$4,'SUCCEEDED',$5,$6,now())`,
    [
      run.tenant_id,
      run.id,
      nodeId,
      attempt,
      idempotencyKey(run.id, nodeId),
      JSON.stringify({ count, index: 0, phase: "enter" }),
    ],
  );
  await emit(db, run.id, run.tenant_id, "NodeStarted", {
    node_id: nodeId,
    attempt,
    type: "LOOP",
    count,
  });
  await emit(db, run.id, run.tenant_id, "NodeCompleted", {
    node_id: nodeId,
    attempt,
    output: { phase: "enter", count, index: 0 },
  });
  await scheduleNode(
    { ...db } as Db,
    { ...run, loop_state: frame },
    await reloadDef(db, run.workflow_version_id),
    bodyNext,
  );
}

async function reloadDef(db: Db, versionId: string): Promise<WorkflowDefinition> {
  const def = await loadDef(db, versionId);
  if (!def) throw new Error(`workflow_versions row missing for ${versionId}`);
  return def;
}

async function handleDelay(db: Db, run: RunRow, nodeId: string, delayMs: number): Promise<void> {
  const attempt = await nextAttempt(db, run.id, nodeId);
  // Record the DELAY attempt as RUNNING; the continuation will mark SUCCEEDED.
  await db.query(
    `INSERT INTO node_attempts (tenant_id, run_id, node_id, node_type, attempt_number, status, idempotency_key, output_snapshot)
     VALUES ($1,$2,$3,'DELAY',$4,'RUNNING',$5,$6)`,
    [
      run.tenant_id,
      run.id,
      nodeId,
      attempt,
      idempotencyKey(run.id, nodeId),
      JSON.stringify({ delay_ms: delayMs }),
    ],
  );
  await emit(db, run.id, run.tenant_id, "NodeStarted", {
    node_id: nodeId,
    attempt,
    type: "DELAY",
    delay_ms: delayMs,
  });

  const dueAt = Date.now() + delayMs;
  await db.query(
    "UPDATE runs SET wake_at = to_timestamp($2 / 1000.0), updated_at = now() WHERE id = $1",
    [run.id, dueAt],
  );

  const envelope: DelayedEnvelope = {
    stream: "node_completed",
    body: {
      run_id: run.id,
      tenant_id: run.tenant_id,
      node_id: nodeId,
      attempt,
      outcome: "SUCCEEDED",
      output: { delayed_for_ms: delayMs, source: "delay" },
    },
  };
  await new DelayedQueue(redis()).schedule(JSON.stringify(envelope), dueAt);
}

async function nextAttempt(db: Db, runId: string, nodeId: string): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
       FROM node_attempts WHERE run_id = $1 AND node_id = $2`,
    [runId, nodeId],
  );
  return rows[0]!.next;
}

/**
 * Handle a RunStartCommand: PENDING → RUNNING+enqueue start, or resume from
 * resume_node_id. Idempotent: a redelivered command on an already-running run
 * with no resume hint is a no-op.
 */
export async function handleRunStart(runId: string, tenantId: string): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const run = await loadRunForUpdate(db, runId);
    if (!run) {
      logger.warn({ runId }, "runStart: unknown run");
      return;
    }
    if (TERMINAL_RUN_STATUSES.has(run.status as never)) {
      logger.info({ runId, status: run.status }, "runStart: run already terminal");
      return;
    }
    const def = await loadDef(db, run.workflow_version_id);
    if (!def) {
      await finalize(db, run.id, run.tenant_id, "FAILED", "workflow version not found");
      return;
    }

    if (run.status === "PENDING") {
      await db.query("UPDATE runs SET status='RUNNING', updated_at = now() WHERE id = $1", [runId]);
      await emit(db, runId, tenantId, "RunStarted");
      const start = def.nodes[def.start_node];
      if (!start) {
        await finalize(
          db,
          run.id,
          run.tenant_id,
          "FAILED",
          `start_node '${def.start_node}' missing`,
        );
        return;
      }
      // Entry node is TRIGGER_INPUT (advance to its successor immediately).
      const firstReal = start.type === "TRIGGER_INPUT" ? start.next : def.start_node;
      if (firstReal === null) {
        await finalize(db, run.id, run.tenant_id, "SUCCEEDED");
        return;
      }
      await scheduleNode(db, { ...run, status: "RUNNING" }, def, firstReal);
      return;
    }

    if (run.status === "RUNNING" && run.resume_node_id) {
      const target = run.resume_node_id;
      await db.query("UPDATE runs SET resume_node_id = NULL, updated_at = now() WHERE id = $1", [
        runId,
      ]);
      await scheduleNode(db, { ...run, resume_node_id: null }, def, target);
      return;
    }

    logger.debug({ runId, status: run.status }, "runStart: nothing to do");
  });
}

/**
 * Handle a NodeCompletedMessage: advance the run, respecting pause/cancel.
 */
export async function handleNodeCompleted(msg: NodeCompletedMessage): Promise<void> {
  await withTenant(msg.tenant_id, async (db) => {
    const run = await loadRunForUpdate(db, msg.run_id);
    if (!run) {
      logger.warn({ run: msg.run_id }, "nodeCompleted: unknown run");
      return;
    }
    if (TERMINAL_RUN_STATUSES.has(run.status as never)) return; // cancelled / done

    // Idempotency-finalise the attempt: if it's still RUNNING (DELAY continuation
    // path), mark it SUCCEEDED here. Worker-completed attempts are already final.
    await db.query(
      `UPDATE node_attempts SET status = $4, ended_at = now(), output_snapshot = COALESCE(output_snapshot, $5)
        WHERE run_id = $1 AND node_id = $2 AND attempt_number = $3 AND status = 'RUNNING'`,
      [
        msg.run_id,
        msg.node_id,
        msg.attempt,
        msg.outcome,
        msg.output ? JSON.stringify(msg.output) : null,
      ],
    );
    await emit(
      db,
      msg.run_id,
      msg.tenant_id,
      msg.outcome === "SUCCEEDED" ? "NodeCompleted" : "NodeFailed",
      {
        node_id: msg.node_id,
        attempt: msg.attempt,
        output: msg.output ?? null,
      },
    );

    if (msg.outcome === "FAILED") {
      await finalize(
        db,
        run.id,
        run.tenant_id,
        "FAILED",
        `node ${msg.node_id} failed after exhausting retries`,
      );
      return;
    }

    const def = await loadDef(db, run.workflow_version_id);
    if (!def) {
      await finalize(db, run.id, run.tenant_id, "FAILED", "workflow version not found");
      return;
    }
    const completed = def.nodes[msg.node_id];
    if (!completed) {
      await finalize(db, run.id, run.tenant_id, "FAILED", `unknown node '${msg.node_id}'`);
      return;
    }

    // Compute the next node — CONDITION branches on output.result.
    let nextId: string | null;
    if (completed.type === "CONDITION") {
      const result = Boolean((msg.output as { result?: unknown } | undefined)?.result);
      nextId = result ? completed.next_true : completed.next_false;
    } else if (completed.type === "LOOP") {
      // LOOP completions are emitted inline by handleLoopEnter / loop iteration
      // logic below; they don't normally re-enter via the worker stream. If we
      // somehow get here, advance to the LOOP's next as a defensive default.
      nextId = completed.next;
    } else {
      nextId = successors(completed)[0] ?? null;
    }

    // Pause handshake: stash the next node and transition to PAUSED.
    if (run.status === "PAUSING") {
      await db.query(
        "UPDATE runs SET status='PAUSED', resume_node_id=$2, wake_at=NULL, updated_at = now() WHERE id = $1",
        [run.id, nextId],
      );
      await emit(db, run.id, run.tenant_id, "RunPaused");
      return;
    }

    if (nextId === null) {
      // If we're inside a LOOP body, the terminal isn't really "done" — it
      // signals "this iteration finished; iterate again or exit the loop".
      if (run.loop_state) {
        await advanceLoop(db, run, def);
        return;
      }
      await finalize(db, run.id, run.tenant_id, "SUCCEEDED");
      return;
    }
    await scheduleNode(db, run, def, nextId);
  });
}

/**
 * Body terminal reached while inside a LOOP: advance to the next iteration or
 * exit the loop and advance to `next_after_loop`.
 */
async function advanceLoop(db: Db, run: RunRow, def: WorkflowDefinition): Promise<void> {
  const frame = run.loop_state!;
  const newIndex = frame.index + 1;

  if (newIndex < frame.count) {
    const nextFrame: LoopFrame = { ...frame, index: newIndex };
    await db.query("UPDATE runs SET loop_state = $2::jsonb, updated_at = now() WHERE id = $1", [
      run.id,
      JSON.stringify(nextFrame),
    ]);
    await emit(db, run.id, run.tenant_id, "NodeCompleted", {
      node_id: frame.loop_node_id,
      attempt: newIndex,
      output: { phase: "iterate", index: newIndex, count: frame.count },
    });
    await scheduleNode(db, { ...run, loop_state: nextFrame }, def, frame.body_next);
    return;
  }

  // Loop exhausted — clear state and either advance or finalize.
  await db.query("UPDATE runs SET loop_state = NULL, updated_at = now() WHERE id = $1", [run.id]);
  await emit(db, run.id, run.tenant_id, "NodeCompleted", {
    node_id: frame.loop_node_id,
    attempt: frame.count,
    output: { phase: "exit", index: frame.index, count: frame.count },
  });
  if (frame.next_after_loop === null) {
    await finalize(db, run.id, run.tenant_id, "SUCCEEDED");
    return;
  }
  await scheduleNode(db, { ...run, loop_state: null }, def, frame.next_after_loop);
}

/** Convenience for delayed pump routing. */
export const STREAM_NAMES = STREAMS;
