import {
  computeBackoff,
  type Db,
  DelayedQueue,
  FatalError,
  getHandler,
  loadConfig,
  logger,
  metrics,
  type NodeAttemptStatus,
  type NodeCompletedMessage,
  type NodeExecutionTask,
  type NodeDef,
  queues,
  redis,
  renderDeep,
  RetryableError,
  RetryPolicy,
  secretResolver,
  STREAMS,
  type WorkflowDefinition,
  withTenant,
} from "@conduit/shared";
import { acquireSlot, releaseSlot } from "./bulkhead.js";

/**
 * Process one NodeExecutionTask. The full lifecycle is here so it's easy to
 * reason about: bulkhead → dedup → render → execute → record. Any throw is
 * caught upstream so the task stays in PEL and XAUTOCLAIM recovers it.
 */
export async function processTask(task: NodeExecutionTask): Promise<void> {
  const cfg = loadConfig();
  const log = logger.child({
    run_id: task.run_id,
    node_id: task.node_id,
    attempt: task.attempt,
    tenant_id: task.tenant_id,
  });

  // ── 1. Per-tenant bulkhead. ───────────────────────────────────
  const cap = cfg.WORKER_CONCURRENCY * 2;
  if (!(await acquireSlot(task.tenant_id, cap))) {
    log.debug("tenant bulkhead full, delaying task");
    // Re-publish through the delayed queue so we don't busy-spin on this tenant.
    await new DelayedQueue(redis()).schedule(
      JSON.stringify({ stream: "node_tasks", body: task }),
      Date.now() + 250,
    );
    return;
  }

  try {
    await processWithSlot(task, log);
  } finally {
    await releaseSlot(task.tenant_id);
  }
}

async function processWithSlot(
  task: NodeExecutionTask,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const cfg = loadConfig();

  // ── 2. Dedup via advisory xact lock — review fix #2. ──────────
  // Two workers racing on the same task (XAUTOCLAIM redelivery) serialise on
  // hashtextextended(idem_key,0) and only one inserts the RUNNING attempt; the
  // other sees it and skips. The partitioned table's UNIQUE constraint can't
  // give us this; an advisory lock can.
  type DedupResult = "skip-done" | "skip-running-fresh" | "go" | "go-takeover";
  type Decision = {
    kind: DedupResult;
    def?: WorkflowDefinition;
    ctx?: Record<string, unknown>;
    node?: NodeDef;
  };

  const decision: Decision = await withTenant(task.tenant_id, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [task.idem_key]);
    const existing = await db.query<{ status: NodeAttemptStatus; started_at: string }>(
      `SELECT status, started_at FROM node_attempts
        WHERE run_id = $1 AND node_id = $2 AND attempt_number = $3
        ORDER BY started_at DESC LIMIT 1`,
      [task.run_id, task.node_id, task.attempt],
    );
    if (existing.rowCount > 0 && existing.rows[0]!.status === "SUCCEEDED") {
      return { kind: "skip-done" };
    }
    if (existing.rowCount > 0 && existing.rows[0]!.status === "RUNNING") {
      const ageMs = Date.now() - new Date(existing.rows[0]!.started_at).getTime();
      if (ageMs < cfg.WORKER_LEASE_MS) return { kind: "skip-running-fresh" };
      // Stale RUNNING: original worker likely crashed. Take over; the stable
      // idempotency key (review fix #1) keeps the external side effect safe.
      await db.query(
        `UPDATE node_attempts SET status='FAILED', error_class='LEASE_LOST', ended_at = now()
          WHERE run_id=$1 AND node_id=$2 AND attempt_number=$3 AND status='RUNNING'`,
        [task.run_id, task.node_id, task.attempt],
      );
    }

    // Load run + def + node, build inputs context, render config — all inside
    // the same tx so we have a consistent snapshot.
    const wf = await db.query<{ workflow_version_id: string; status: string }>(
      "SELECT workflow_version_id, status FROM runs WHERE id = $1",
      [task.run_id],
    );
    if (wf.rowCount === 0) return { kind: "skip-done" }; // run gone
    if (["CANCELLED", "FAILED", "SUCCEEDED"].includes(wf.rows[0]!.status))
      return { kind: "skip-done" };

    const defRow = await db.query<{ definition: WorkflowDefinition }>(
      "SELECT definition FROM workflow_versions WHERE id = $1",
      [wf.rows[0]!.workflow_version_id],
    );
    const def = defRow.rows[0]!.definition;
    const node = def.nodes[task.node_id];
    if (!node) return { kind: "skip-done" };

    const ctx = await buildContext(db, task.run_id);

    // Insert RUNNING attempt (input snapshot only — output set later).
    await db.query(
      `INSERT INTO node_attempts (tenant_id, run_id, node_id, node_type, attempt_number, status, idempotency_key, input_snapshot)
       VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7)`,
      [
        task.tenant_id,
        task.run_id,
        task.node_id,
        node.type,
        task.attempt,
        task.idem_key,
        JSON.stringify(truncate(ctx)),
      ],
    );
    return { kind: existing.rowCount > 0 ? "go-takeover" : "go", def, ctx, node };
  });

  if (decision.kind === "skip-done") {
    log.info("attempt already completed; emitting NodeCompleted for dispatcher");
    await emitCompleted(task, "SUCCEEDED");
    return;
  }
  if (decision.kind === "skip-running-fresh") {
    log.info("attempt is RUNNING and fresh on a peer; skipping");
    return;
  }

  // ── 3. Execute the handler outside the DB transaction. ────────
  const node = decision.node!;
  const def = decision.def!;
  const ctx = decision.ctx!;
  const handler = getHandler(node.type);
  if (!handler) {
    metrics.nodeAttempts.inc({ node_type: node.type, status: "FAILED", error_class: "NO_HANDLER" });
    await finalizeAttempt(task, "FAILED", {
      error_class: "NO_HANDLER",
      error_message: `no handler for ${node.type}`,
    });
    await emitCompleted(task, "FAILED");
    return;
  }

  const cfgPayload = nodeConfig(node);
  const rendered = renderDeep(cfgPayload, ctx) as Record<string, unknown>;

  const timeoutMs =
    "timeout_ms" in node && node.timeout_ms
      ? node.timeout_ms
      : loadConfig().NODE_DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const tStart = process.hrtime.bigint();
  const observe = (status: string): void => {
    const sec = Number(process.hrtime.bigint() - tStart) / 1e9;
    metrics.nodeDuration.observe({ node_type: node.type, status }, sec);
  };
  try {
    const output = await handler.execute({
      inputs: ctx as never,
      config: rendered,
      secrets: secretResolver(task.tenant_id),
      idempotencyKey: task.idem_key,
      timeoutMs,
      signal: ac.signal,
      log,
    });
    clearTimeout(t);
    observe("SUCCEEDED");
    metrics.nodeAttempts.inc({ node_type: node.type, status: "SUCCEEDED", error_class: "" });
    await finalizeAttempt(task, "SUCCEEDED", { output_snapshot: truncate(output) });
    await emitCompleted(task, "SUCCEEDED", output);
  } catch (err) {
    clearTimeout(t);
    observe("FAILED");
    if (err instanceof RetryableError) {
      metrics.nodeAttempts.inc({
        node_type: node.type,
        status: "FAILED",
        error_class: err.errorClass,
      });
      await onRetryable(task, def, err, log);
    } else if (err instanceof FatalError) {
      metrics.nodeAttempts.inc({ node_type: node.type, status: "FAILED", error_class: "FATAL" });
      await finalizeAttempt(task, "FAILED", {
        error_class: "FATAL",
        error_message: err.message,
        output_snapshot: truncate(err.output ?? null),
      });
      await emitCompleted(task, "FAILED");
    } else {
      const e = err as Error;
      metrics.nodeAttempts.inc({
        node_type: node.type,
        status: "FAILED",
        error_class: "UNEXPECTED",
      });
      await finalizeAttempt(task, "FAILED", {
        error_class: "UNEXPECTED",
        error_message: e.message,
      });
      await emitCompleted(task, "FAILED");
    }
  }
}

async function onRetryable(
  task: NodeExecutionTask,
  def: WorkflowDefinition,
  err: RetryableError,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const cfg = loadConfig();
  const node = def.nodes[task.node_id]!;
  const policy = RetryPolicy.parse({
    ...((node as { retry?: unknown }).retry ?? {}),
    backoff_ms:
      (node as { retry?: { backoff_ms?: number } }).retry?.backoff_ms ?? cfg.RETRY_BASE_MS,
    max_backoff_ms:
      (node as { retry?: { max_backoff_ms?: number } }).retry?.max_backoff_ms ?? cfg.RETRY_MAX_MS,
  });

  // Record this attempt as FAILED before deciding whether to retry.
  await finalizeAttempt(task, "FAILED", {
    error_class: err.errorClass,
    error_message: err.message,
    output_snapshot: truncate(err.output ?? null),
  });

  if (!policy.retry_on.includes(err.errorClass)) {
    log.info({ errorClass: err.errorClass }, "non-retryable per policy; failing run");
    await emitCompleted(task, "FAILED");
    return;
  }
  if (task.attempt >= policy.max_attempts) {
    log.info({ attempt: task.attempt, max: policy.max_attempts }, "retries exhausted");
    await emitCompleted(task, "FAILED");
    return;
  }

  const delay = computeBackoff(task.attempt, policy);
  const nextTask: NodeExecutionTask = { ...task, attempt: task.attempt + 1 };
  await new DelayedQueue(redis()).schedule(
    JSON.stringify({ stream: "node_tasks", body: nextTask }),
    Date.now() + delay,
  );
  metrics.retriesScheduled.inc({
    node_type: def.nodes[task.node_id]?.type ?? "unknown",
    error_class: err.errorClass,
  });
  await withTenant(task.tenant_id, async (db) => {
    await db.query(
      "INSERT INTO run_events (tenant_id, run_id, event_type, payload) VALUES ($1,$2,'NodeRetryScheduled',$3)",
      [
        task.tenant_id,
        task.run_id,
        JSON.stringify({ node_id: task.node_id, next_attempt: nextTask.attempt, delay_ms: delay }),
      ],
    );
  });
}

async function finalizeAttempt(
  task: NodeExecutionTask,
  status: "SUCCEEDED" | "FAILED",
  extras: {
    output_snapshot?: unknown;
    error_class?: string;
    error_message?: string;
  },
): Promise<void> {
  await withTenant(task.tenant_id, async (db) => {
    await db.query(
      `UPDATE node_attempts
          SET status = $4, ended_at = now(),
              output_snapshot = COALESCE($5, output_snapshot),
              error_class = COALESCE($6, error_class),
              error_message = COALESCE($7, error_message)
        WHERE run_id = $1 AND node_id = $2 AND attempt_number = $3 AND status = 'RUNNING'`,
      [
        task.run_id,
        task.node_id,
        task.attempt,
        status,
        extras.output_snapshot !== undefined ? JSON.stringify(extras.output_snapshot) : null,
        extras.error_class ?? null,
        extras.error_message ?? null,
      ],
    );
  });
}

async function emitCompleted(
  task: NodeExecutionTask,
  outcome: "SUCCEEDED" | "FAILED",
  output?: Record<string, unknown>,
): Promise<void> {
  const msg: NodeCompletedMessage = {
    run_id: task.run_id,
    tenant_id: task.tenant_id,
    node_id: task.node_id,
    attempt: task.attempt,
    outcome,
    output,
  };
  await queues(redis()).nodeCompleted.publish(msg);
  // Also XADD to STREAMS.nodeCompleted is what queues() does — left explicit
  // here as a marker that this is the dispatcher hand-off.
  void STREAMS;
}

/** Build the run context: trigger payload + outputs of all completed nodes. */
async function buildContext(db: Db, runId: string): Promise<Record<string, unknown>> {
  const run = await db.query<{
    trigger_payload: { payload: unknown } | null;
    loop_state: { loop_node_id: string; count: number; index: number } | null;
  }>("SELECT trigger_payload, loop_state FROM runs WHERE id = $1", [runId]);
  const nodes: Record<string, unknown> = {};
  const attempts = await db.query<{ node_id: string; output_snapshot: unknown }>(
    `SELECT DISTINCT ON (node_id) node_id, output_snapshot
       FROM node_attempts
      WHERE run_id = $1 AND status = 'SUCCEEDED'
      ORDER BY node_id, attempt_number DESC, started_at DESC`,
    [runId],
  );
  for (const a of attempts.rows) nodes[a.node_id] = a.output_snapshot;
  // Expose the live LOOP iteration to body templates as
  //   {{nodes.<loop_id>.index}} / .count — overrides whatever was stamped
  //   onto the LOOP's static node_attempt at loop enter.
  const loop = run.rows[0]?.loop_state;
  if (loop) {
    nodes[loop.loop_node_id] = { index: loop.index, count: loop.count };
  }
  return {
    trigger: run.rows[0]?.trigger_payload ?? { payload: null },
    nodes,
  };
}

/** Extract the type-specific config blob the handler expects. */
function nodeConfig(node: NodeDef): Record<string, unknown> {
  switch (node.type) {
    case "HTTP_REQUEST":
      return node.config as Record<string, unknown>;
    case "CONDITION":
      return node.condition as unknown as Record<string, unknown>;
    case "NOTIFY":
      return { channel: node.channel, ...(node.config as Record<string, unknown>) };
    case "DELAY":
      return { delay_ms: node.delay_ms };
    case "TRIGGER_INPUT":
      return {};
    case "LOOP":
      // LOOPs are dispatched inline (see dispatcher/ops.handleLoopEnter); they
      // never reach the worker. This branch only exists for type exhaustiveness.
      return { count: node.count, body: node.body };
  }
}

const MAX_SNAPSHOT_BYTES = 256 * 1024;
function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (!s || s.length <= MAX_SNAPSHOT_BYTES) return v;
  return { _truncated: true, _size: s.length, _preview: s.slice(0, 1024) };
}
