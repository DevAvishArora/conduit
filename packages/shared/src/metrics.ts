import client, { type Counter, type Histogram, type Registry } from "prom-client";

/**
 * Prometheus metrics for the §7.3.1 SLIs. Lazily initialized so a service that
 * doesn't expose /metrics still pays the import cost only once. Default labels
 * tag every metric with the service name from SERVICE_NAME.
 */
export const registry: Registry = new client.Registry();
client.collectDefaultMetrics({
  register: registry,
  labels: { service: process.env.SERVICE_NAME ?? "flow" },
});

// ── Runs ────────────────────────────────────────────────────────
export const runsStarted: Counter<string> = new client.Counter({
  name: "flow_runs_started_total",
  help: "Runs created (a new RunStartCommand published)",
  labelNames: ["tenant_id", "trigger_type"],
  registers: [registry],
});
export const runsFinalized: Counter<string> = new client.Counter({
  name: "flow_runs_finalized_total",
  help: "Runs that reached a terminal status",
  labelNames: ["tenant_id", "status"], // SUCCEEDED | FAILED | CANCELLED
  registers: [registry],
});
export const runDuration: Histogram<string> = new client.Histogram({
  name: "flow_run_duration_seconds",
  help: "Wall-clock duration of a run from start to terminal status",
  labelNames: ["status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 1800],
  registers: [registry],
});

// ── Node attempts ───────────────────────────────────────────────
export const nodeAttempts: Counter<string> = new client.Counter({
  name: "flow_node_attempts_total",
  help: "Node attempts settled — successful or failed",
  labelNames: ["node_type", "status", "error_class"],
  registers: [registry],
});
export const nodeDuration: Histogram<string> = new client.Histogram({
  name: "flow_node_attempt_duration_seconds",
  help: "Per-attempt wall-clock duration",
  labelNames: ["node_type", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});
export const retriesScheduled: Counter<string> = new client.Counter({
  name: "flow_retries_scheduled_total",
  help: "Retries queued via the delayed queue",
  labelNames: ["node_type", "error_class"],
  registers: [registry],
});

// ── Trigger ingress ─────────────────────────────────────────────
export const webhookIngress: Counter<string> = new client.Counter({
  name: "flow_webhook_ingress_total",
  help: "Webhook ingress requests by outcome",
  labelNames: ["outcome"], // accepted | bad_signature | replay | unknown_trigger | no_version
  registers: [registry],
});
export const cronFires: Counter<string> = new client.Counter({
  name: "flow_cron_fires_total",
  help: "Cron triggers fired by the scheduler",
  labelNames: ["tenant_id"],
  registers: [registry],
});

// ── API ─────────────────────────────────────────────────────────
export const httpRequests: Counter<string> = new client.Counter({
  name: "flow_http_requests_total",
  help: "API HTTP requests by method, path-template and status family",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});
export const httpRequestDuration: Histogram<string> = new client.Histogram({
  name: "flow_http_request_duration_seconds",
  help: "API HTTP request latency",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// ── Queues ──────────────────────────────────────────────────────
export const queueDepth: Histogram<string> = new client.Histogram({
  name: "flow_stream_lag",
  help: "Consumer group lag (approximate queue depth) per stream",
  labelNames: ["stream", "group"],
  buckets: [0, 1, 10, 100, 1000, 10_000, 100_000],
  registers: [registry],
});
