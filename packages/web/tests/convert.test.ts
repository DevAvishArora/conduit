import { describe, expect, it } from "vitest";
import { defToGraph, graphToDef, newFlowNode } from "../src/builder/convert";
import type { WorkflowDefinition } from "../src/builder/types";

// Fixture: trigger → condition → notify on true-branch, false-branch is null.
const definition: WorkflowDefinition = {
  schema_version: "1.0",
  name: "demo",
  start_node: "in",
  nodes: {
    in: { type: "TRIGGER_INPUT", next: "check" },
    check: {
      type: "CONDITION",
      condition: { left: "{{trigger.payload.priority}}", op: "eq", right: "high" },
      next_true: "notify",
      next_false: null,
    },
    notify: {
      type: "NOTIFY",
      channel: "slack",
      config: { webhook_url_secret: "slack_hook", message: "x" },
      next: null,
    },
  },
};

describe("defToGraph", () => {
  it("creates one node per definition entry", () => {
    const { nodes } = defToGraph(definition);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.id).sort()).toEqual(["check", "in", "notify"]);
  });

  it("flags the trigger as the start node", () => {
    const { nodes } = defToGraph(definition);
    const start = nodes.find((n) => n.data.isStart);
    expect(start?.id).toBe("in");
  });

  it("renders condition edges with true/false sourceHandles", () => {
    const { edges } = defToGraph(definition);
    const checkEdges = edges.filter((e) => e.source === "check");
    expect(checkEdges).toHaveLength(1); // only next_true is set
    expect(checkEdges[0]!.sourceHandle).toBe("true");
    expect(checkEdges[0]!.target).toBe("notify");
    expect(checkEdges[0]!.label).toBe("true");
  });

  it("renders normal edges without a labeled sourceHandle", () => {
    const { edges } = defToGraph(definition);
    const inEdge = edges.find((e) => e.source === "in");
    expect(inEdge?.target).toBe("check");
    expect(inEdge?.label).toBeUndefined();
  });

  it("assigns positions via auto-layout when _pos missing", () => {
    const { nodes } = defToGraph(definition);
    // Every node should have a non-zero coordinate from BFS layout.
    for (const n of nodes) {
      expect(n.position.x).toBeGreaterThanOrEqual(0);
      expect(n.position.y).toBeGreaterThanOrEqual(0);
    }
    // Different columns -> different x for trigger vs successor.
    const ix = nodes.find((n) => n.id === "in")!.position.x;
    const cx = nodes.find((n) => n.id === "check")!.position.x;
    expect(cx).toBeGreaterThan(ix);
  });

  it("respects persisted _pos when present", () => {
    const withPos: WorkflowDefinition = {
      ...definition,
      nodes: {
        ...definition.nodes,
        in: { ...definition.nodes["in"]!, _pos: { x: 42, y: 99 } },
      },
    } as WorkflowDefinition;
    const { nodes } = defToGraph(withPos);
    const start = nodes.find((n) => n.id === "in")!;
    expect(start.position).toEqual({ x: 42, y: 99 });
  });
});

describe("graphToDef", () => {
  it("rejects a graph with no trigger node", () => {
    const r = graphToDef("x", [], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Trigger node/);
  });

  it("rejects a graph with more than one trigger", () => {
    const a = newFlowNode("TRIGGER_INPUT", { x: 0, y: 0 }, new Set());
    const b = newFlowNode("TRIGGER_INPUT", { x: 0, y: 100 }, new Set([a.id]));
    const r = graphToDef("x", [a, b], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only one Trigger/);
  });

  it("round-trips a definition through defToGraph → graphToDef", () => {
    const { nodes, edges } = defToGraph(definition);
    const r = graphToDef("demo", nodes, edges);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.start_node).toBe("in");
    // The condition's next_true should be preserved and next_false stays null.
    const check = r.def.nodes["check"];
    if (check?.type !== "CONDITION") throw new Error("expected CONDITION");
    expect(check.next_true).toBe("notify");
    expect(check.next_false).toBeNull();
    // Terminal node's next is null.
    const notify = r.def.nodes["notify"];
    if (notify?.type !== "NOTIFY") throw new Error("expected NOTIFY");
    expect(notify.next).toBeNull();
  });

  it("stamps each saved node with a rounded _pos", () => {
    const { nodes, edges } = defToGraph(definition);
    // Nudge one node so we can see persistence.
    const c = nodes.find((n) => n.id === "check")!;
    c.position = { x: 123.7, y: 456.3 };
    const r = graphToDef("demo", nodes, edges);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.nodes["check"]!._pos).toEqual({ x: 124, y: 456 });
  });
});

describe("LOOP node — separate body / next edges", () => {
  const looping: WorkflowDefinition = {
    schema_version: "1.0",
    name: "looper",
    start_node: "in",
    nodes: {
      in: { type: "TRIGGER_INPUT", next: "loop1" },
      loop1: { type: "LOOP", count: 5, body: "step", next: "done" },
      step: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      done: { type: "HTTP_REQUEST", config: { method: "GET", url: "y" }, next: null },
    },
  };

  it("emits both body + out edges from a LOOP", () => {
    const { edges } = defToGraph(looping);
    const loopEdges = edges.filter((e) => e.source === "loop1");
    expect(loopEdges).toHaveLength(2);
    expect(loopEdges.some((e) => e.sourceHandle === "body" && e.target === "step")).toBe(true);
    expect(loopEdges.some((e) => e.sourceHandle === "out" && e.target === "done")).toBe(true);
  });

  it("round-trips a LOOP through graphToDef without losing body/next", () => {
    const { nodes, edges } = defToGraph(looping);
    const r = graphToDef("looper", nodes, edges);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loop = r.def.nodes["loop1"];
    if (loop?.type !== "LOOP") throw new Error("expected LOOP");
    expect(loop.body).toBe("step");
    expect(loop.next).toBe("done");
    expect(loop.count).toBe(5);
  });

  it("rejects a LOOP that has no body edge connected", () => {
    const { nodes, edges } = defToGraph(looping);
    const filtered = edges.filter((e) => !(e.source === "loop1" && e.sourceHandle === "body"));
    const r = graphToDef("looper", nodes, filtered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs a body/);
  });
});

describe("newFlowNode", () => {
  it("returns a unique id per call", () => {
    const a = newFlowNode("HTTP_REQUEST", { x: 0, y: 0 }, new Set());
    const b = newFlowNode("HTTP_REQUEST", { x: 0, y: 0 }, new Set([a.id]));
    expect(a.id).not.toBe(b.id);
  });
  it("flags a trigger as start, others as not start", () => {
    const t = newFlowNode("TRIGGER_INPUT", { x: 0, y: 0 }, new Set());
    const h = newFlowNode("HTTP_REQUEST", { x: 0, y: 0 }, new Set([t.id]));
    expect(t.data.isStart).toBe(true);
    expect(h.data.isStart).toBe(false);
  });
});
