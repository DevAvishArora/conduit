import pino from "pino";

/**
 * Structured JSON logging (§7.3.2). Every log line should carry tenant_id,
 * run_id, node_id, trace_id where available — use `logger.child({...})` to
 * bind those at the edges of a request / task.
 *
 * Logger is a small hand-rolled structural interface so the root logger AND
 * `.child()` returns both satisfy it without pino's generic gymnastics.
 */
const REDACT = [
  "password",
  "hashed_password",
  "token",
  "secret",
  "ciphertext",
  "authorization",
  "*.password",
  "*.secret",
  "req.headers.authorization",
  "req.headers['x-flow-signature']",
];

type LogFn = (obj: object | string, msg?: string, ...args: unknown[]) => void;

export interface Logger {
  info: LogFn;
  error: LogFn;
  warn: LogFn;
  debug: LogFn;
  trace: LogFn;
  fatal: LogFn;
  child(bindings: object): Logger;
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "conduit" },
  redact: { paths: REDACT, censor: "[redacted]" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
}) as unknown as Logger;
