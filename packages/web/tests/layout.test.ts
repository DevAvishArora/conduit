import { describe, expect, it } from "vitest";
import { autoLayout } from "../src/builder/layout";
import type { WorkflowDefinition } from "../src/builder/types";

describe("autoLayout", () => {
  it("assigns the start node to column 0 and successors to higher columns", () => {
    const def: WorkflowDefinition = {
      schema_version: "1.0",
      name: "x",
      start_node: "a",
      nodes: {
        a: { type: "TRIGGER_INPUT", next: "b" },
        b: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: "c" },
        c: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      },
    };
    const layout = autoLayout(def);
    expect(layout["a"]!.x).toBeLessThan(layout["b"]!.x);
    expect(layout["b"]!.x).toBeLessThan(layout["c"]!.x);
  });

  it("places condition branches at the same depth", () => {
    const def: WorkflowDefinition = {
      schema_version: "1.0",
      name: "x",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "c" },
        c: {
          type: "CONDITION",
          condition: { left: "{{x}}", op: "eq", right: "y" },
          next_true: "t",
          next_false: "f",
        },
        t: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
        f: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      },
    };
    const layout = autoLayout(def);
    // true and false branches both come from the condition, so column-equal
    expect(layout["t"]!.x).toBe(layout["f"]!.x);
    // they should be at separate y positions (different rows in the column)
    expect(layout["t"]!.y).not.toBe(layout["f"]!.y);
  });

  it("pushes orphan nodes to the right of the deepest reachable node", () => {
    const def: WorkflowDefinition = {
      schema_version: "1.0",
      name: "x",
      start_node: "a",
      nodes: {
        a: { type: "TRIGGER_INPUT", next: null },
        ghost: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      },
    };
    const layout = autoLayout(def);
    expect(layout["ghost"]!.x).toBeGreaterThan(layout["a"]!.x);
  });
});
