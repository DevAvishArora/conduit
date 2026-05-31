import { z } from "zod";

// ────────────────────────────────────────────────────────────────
// Workflow definition (stored in workflow_versions.definition JSONB).
//
// Design note vs the doc: CONDITION uses a *structured* operator object
// rather than a free-form string expression like
//   "$.payload.labels[*] contains 'critical'".
// A string DSL needs an evaluator (an injection / sandbox-escape surface and
// hard to test). A small typed operator set is safe, validatable, and unit-
// testable. String fields support `{{path}}` templating against run context.
// ────────────────────────────────────────────────────────────────

export const RetryPolicy = z.object({
  max_attempts: z.number().int().min(1).max(20).default(3),
  backoff_ms: z.number().int().min(0).default(1000),
  max_backoff_ms: z.number().int().min(0).default(60000),
  jitter: z.boolean().default(true),
  retry_on: z
    .array(z.enum(["NETWORK_ERROR", "TIMEOUT", "HTTP_5XX", "HTTP_429"]))
    .default(["NETWORK_ERROR", "TIMEOUT", "HTTP_5XX", "HTTP_429"]),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

const baseNode = {
  retry: RetryPolicy.partial().optional(),
  timeout_ms: z.number().int().positive().optional(),
};

export const TriggerInputNode = z.object({
  type: z.literal("TRIGGER_INPUT"),
  next: z.string().nullable(),
});

export const HttpRequestNode = z.object({
  type: z.literal("HTTP_REQUEST"),
  config: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
  }),
  next: z.string().nullable(),
  ...baseNode,
});

export const ConditionNode = z.object({
  type: z.literal("CONDITION"),
  condition: z.object({
    left: z.string(), // template, e.g. "{{trigger.payload.priority}}"
    op: z.enum([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "not_contains",
      "exists",
      "not_exists",
      "matches",
    ]),
    right: z.unknown().optional(),
  }),
  next_true: z.string().nullable(),
  next_false: z.string().nullable(),
});

export const DelayNode = z.object({
  type: z.literal("DELAY"),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1000), // <= 30d
  next: z.string().nullable(),
});

export const NotifyNode = z.object({
  type: z.literal("NOTIFY"),
  channel: z.enum(["slack", "email"]),
  config: z.object({
    // Slack
    webhook_url_secret: z.string().optional(),
    // Email
    to: z.string().optional(),
    subject: z.string().optional(),
    // both
    message: z.string(),
  }),
  next: z.string().nullable(),
  ...baseNode,
});

// LOOP iterates its body N times. v1 supports count-based iteration only;
// "iterate over array" (a `path` mode) is a tracked follow-up. The dispatcher
// keeps loop state on the run row; the body's terminal (next:null) signals
// "iterate again or exit" — which the dispatcher decides from loop_state.
//
// Cycle detection is loop-aware: an edge that returns to the LOOP node from
// somewhere in its body subgraph is allowed and ignored.
export const LoopNode = z.object({
  type: z.literal("LOOP"),
  count: z.number().int().min(1).max(1000),
  body: z.string().min(1), // first node of the body sub-flow
  next: z.string().nullable(),
});

export const NodeDef = z.discriminatedUnion("type", [
  TriggerInputNode,
  HttpRequestNode,
  ConditionNode,
  DelayNode,
  NotifyNode,
  LoopNode,
]);
export type NodeDef = z.infer<typeof NodeDef>;
export type NodeType = NodeDef["type"];

export const WorkflowDefinition = z.object({
  schema_version: z.literal("1.0"),
  name: z.string().min(1),
  start_node: z.string().min(1),
  nodes: z.record(NodeDef).refine((n) => Object.keys(n).length > 0, {
    message: "workflow must have at least one node",
  }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

/** Successors of a node, used by validation and the dispatcher. */
export function successors(node: NodeDef): (string | null)[] {
  if (node.type === "CONDITION") return [node.next_true, node.next_false];
  if (node.type === "LOOP") return [node.body, node.next];
  return [node.next];
}

/** Returns true if `node` is a LOOP whose body wraps back to itself. */
export function isLoopNode(node: NodeDef): node is Extract<NodeDef, { type: "LOOP" }> {
  return node.type === "LOOP";
}

// ────────────────────────────────────────────────────────────────
// Run / execution domain
// ────────────────────────────────────────────────────────────────

export const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export type NodeAttemptStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export type RunEventType =
  | "RunStarted"
  | "RunResumed"
  | "PauseRequested"
  | "RunPaused"
  | "NodeStarted"
  | "NodeCompleted"
  | "NodeFailed"
  | "NodeRetryScheduled"
  | "RunSucceeded"
  | "RunFailed"
  | "RunCancelled";

// ────────────────────────────────────────────────────────────────
// Queue messages
// ────────────────────────────────────────────────────────────────

/** Produced by Trigger API / Scheduler; consumed by the Dispatcher. */
export interface RunStartCommand {
  run_id: string;
  tenant_id: string;
}

/** Produced by the Dispatcher; consumed by the Worker pool. */
export interface NodeExecutionTask {
  run_id: string;
  tenant_id: string;
  node_id: string;
  attempt: number;
  /** Stable across retries (review fix #1) — used as external Idempotency-Key. */
  idem_key: string;
}

/** Produced by the Worker after a node settles; consumed by the Dispatcher. */
export interface NodeCompletedMessage {
  run_id: string;
  tenant_id: string;
  node_id: string;
  attempt: number;
  outcome: "SUCCEEDED" | "FAILED";
  /** condition result / branch hint, dispatcher reads this to pick next node */
  output?: Record<string, unknown>;
}
