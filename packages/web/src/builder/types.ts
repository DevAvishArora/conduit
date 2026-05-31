// Frontend-only mirrors of the @conduit/shared types — we keep this lightweight so
// the web bundle doesn't need to import the server-side package.
export type NodeType = "TRIGGER_INPUT" | "HTTP_REQUEST" | "CONDITION" | "DELAY" | "NOTIFY" | "LOOP";

export interface XY {
  x: number;
  y: number;
}

interface WithPos {
  _pos?: XY;
}

export type WorkflowNode =
  | ({ type: "TRIGGER_INPUT"; next: string | null } & WithPos)
  | ({
      type: "HTTP_REQUEST";
      config: {
        method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      };
      next: string | null;
      retry?: Partial<{
        max_attempts: number;
        backoff_ms: number;
        max_backoff_ms: number;
        jitter: boolean;
      }>;
      timeout_ms?: number;
    } & WithPos)
  | ({
      type: "CONDITION";
      condition: {
        left: string;
        op:
          | "eq"
          | "neq"
          | "gt"
          | "gte"
          | "lt"
          | "lte"
          | "contains"
          | "not_contains"
          | "exists"
          | "not_exists"
          | "matches";
        right?: unknown;
      };
      next_true: string | null;
      next_false: string | null;
    } & WithPos)
  | ({ type: "DELAY"; delay_ms: number; next: string | null } & WithPos)
  | ({
      type: "NOTIFY";
      channel: "slack" | "email";
      config: { webhook_url_secret?: string; to?: string; subject?: string; message: string };
      next: string | null;
    } & WithPos)
  | ({
      type: "LOOP";
      count: number;
      body: string; // first node id of the body sub-flow
      next: string | null;
    } & WithPos);

export interface WorkflowDefinition {
  schema_version: "1.0";
  name: string;
  start_node: string;
  nodes: Record<string, WorkflowNode>;
}

/** A factory for empty-but-valid default configs for each node type. */
export function defaultNode(type: NodeType): WorkflowNode {
  switch (type) {
    case "TRIGGER_INPUT":
      return { type, next: null };
    case "HTTP_REQUEST":
      return { type, config: { method: "GET", url: "https://" }, next: null };
    case "CONDITION":
      return {
        type,
        condition: { left: "{{trigger.payload.priority}}", op: "eq", right: "high" },
        next_true: null,
        next_false: null,
      };
    case "DELAY":
      return { type, delay_ms: 5000, next: null };
    case "NOTIFY":
      return {
        type,
        channel: "slack",
        config: { webhook_url_secret: "slack_hook", message: "{{trigger.payload.title}}" },
        next: null,
      };
    case "LOOP":
      return { type, count: 3, body: "", next: null };
  }
}

/** UI palette metadata per node type. */
export const PALETTE: Record<
  NodeType,
  { label: string; color: string; emoji: string; sub: string }
> = {
  TRIGGER_INPUT: { label: "Trigger", color: "#22c55e", emoji: "⚡", sub: "Webhook/cron entry" },
  HTTP_REQUEST: { label: "HTTP", color: "#3b82f6", emoji: "🌐", sub: "Call any HTTPS API" },
  CONDITION: { label: "Condition", color: "#f59e0b", emoji: "🔀", sub: "Branch on data" },
  DELAY: { label: "Delay", color: "#64748b", emoji: "⏱", sub: "Pause the run" },
  NOTIFY: { label: "Notify", color: "#ec4899", emoji: "🔔", sub: "Slack / email" },
  LOOP: { label: "Loop", color: "#a855f7", emoji: "🔁", sub: "Repeat body N times" },
};

/** Are we allowed to drop into the canvas from a palette item? */
export const ALLOW_MULTIPLE_TRIGGERS = false;
