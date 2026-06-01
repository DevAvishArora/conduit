import { register } from "./registry.js";
import { type ExecuteArgs, type NodeHandler } from "./types.js";

/**
 * CONDITION connector. `config` is the node's `condition` object with `left`
 * already resolved against run context (templating done by the worker). Returns
 * `{ result }`; the dispatcher routes to next_true / next_false on that.
 */
class ConditionHandler implements NodeHandler {
  readonly typeId = "CONDITION" as const;

  async execute(args: ExecuteArgs): Promise<Record<string, unknown>> {
    const { left, op, right } = args.config as {
      left: unknown;
      op: string;
      right?: unknown;
    };
    return { result: evaluate(left, op, right), left, op, right };
  }
}

export function evaluate(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "exists":
      return left !== undefined && left !== null;
    case "not_exists":
      return left === undefined || left === null;
    case "eq":
      return looseEq(left, right);
    case "neq":
      return !looseEq(left, right);
    case "gt":
      return num(left) > num(right);
    case "gte":
      return num(left) >= num(right);
    case "lt":
      return num(left) < num(right);
    case "lte":
      return num(left) <= num(right);
    case "contains":
      return contains(left, right);
    case "not_contains":
      return !contains(left, right);
    case "matches":
      try {
        return new RegExp(String(right)).test(String(left));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function isNumeric(v: unknown): boolean {
  return (
    (typeof v === "number" && !Number.isNaN(v)) ||
    (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
  );
}
function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((x) => looseEq(x, needle));
  if (typeof haystack === "string") return haystack.includes(String(needle));
  return false;
}

register(new ConditionHandler());
export { ConditionHandler };
