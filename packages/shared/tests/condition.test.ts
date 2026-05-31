import { describe, expect, it } from "vitest";
import { evaluate } from "../src/handlers/condition.js";

describe("condition evaluator", () => {
  it("eq / neq with type coercion for numeric strings", () => {
    expect(evaluate("42", "eq", 42)).toBe(true);
    expect(evaluate("high", "eq", "high")).toBe(true);
    expect(evaluate("low", "neq", "high")).toBe(true);
  });
  it("numeric comparisons", () => {
    expect(evaluate(10, "gt", 5)).toBe(true);
    expect(evaluate("3", "lt", "10")).toBe(true);
    expect(evaluate("ten", "gt", 5)).toBe(false); // NaN
    expect(evaluate(5, "gte", 5)).toBe(true);
    expect(evaluate(5, "lte", 5)).toBe(true);
  });
  it("contains: arrays and strings", () => {
    expect(evaluate(["a", "b", "c"], "contains", "b")).toBe(true);
    expect(evaluate(["a", "b"], "not_contains", "c")).toBe(true);
    expect(evaluate("hello world", "contains", "world")).toBe(true);
  });
  it("exists / not_exists", () => {
    expect(evaluate(undefined, "exists")).toBe(false);
    expect(evaluate(null, "not_exists")).toBe(true);
    expect(evaluate(0, "exists")).toBe(true);
    expect(evaluate("", "exists")).toBe(true);
  });
  it("matches: regex", () => {
    expect(evaluate("error: timed out", "matches", "timed")).toBe(true);
    expect(evaluate("OK", "matches", "^FAIL$")).toBe(false);
    expect(evaluate("any", "matches", "[")).toBe(false); // invalid regex returns false, not throw
  });
  it("unknown op returns false", () => {
    expect(evaluate(1, "wat" as never, 1)).toBe(false);
  });
});
