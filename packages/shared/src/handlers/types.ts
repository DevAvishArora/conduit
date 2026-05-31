import type { Logger } from "../logger.js";
import type { NodeType } from "../types.js";

/**
 * Connector contract (§6.5.1). A handler is pure w.r.t. Flow internals: it
 * receives resolved inputs + config and returns this node's output. It must
 * classify failures by raising RetryableError vs FatalError so the engine can
 * apply the declarative retry policy.
 */
export type ErrorClass = "NETWORK_ERROR" | "TIMEOUT" | "HTTP_5XX" | "HTTP_429";

export class RetryableError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message?: string,
    readonly output?: Record<string, unknown>,
  ) {
    super(message ?? errorClass);
    this.name = "RetryableError";
  }
}

export class FatalError extends Error {
  constructor(
    message: string,
    readonly output?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FatalError";
  }
}

/** Resolves a tenant secret by name. Values never leave the handler context. */
export interface SecretResolver {
  get(name: string): Promise<string>;
}

/** Read-only view of run data available to a node: trigger + prior outputs. */
export interface RunContext {
  trigger: { payload: unknown };
  nodes: Record<string, unknown>;
}

export interface ExecuteArgs {
  inputs: RunContext;
  /** node.config with `{{...}}` already rendered against `inputs`. */
  config: Record<string, unknown>;
  secrets: SecretResolver;
  idempotencyKey: string;
  timeoutMs: number;
  signal: AbortSignal;
  log: Logger;
}

export interface NodeHandler {
  readonly typeId: NodeType;
  execute(args: ExecuteArgs): Promise<Record<string, unknown>>;
}
