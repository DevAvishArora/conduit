import { describe, expect, it } from "vitest";
import { referencedSecrets, validateWorkflow } from "../src/validate.js";
import type { WorkflowDefinition } from "../src/types.js";

const linear = {
  schema_version: "1.0",
  name: "linear",
  start_node: "in",
  nodes: {
    in: { type: "TRIGGER_INPUT", next: "a" },
    a: { type: "HTTP_REQUEST", config: { method: "GET", url: "https://example.com" }, next: null },
  },
};

const branching = {
  schema_version: "1.0",
  name: "branch",
  start_node: "in",
  nodes: {
    in: { type: "TRIGGER_INPUT", next: "c" },
    c: {
      type: "CONDITION",
      condition: { left: "{{x}}", op: "eq", right: "yes" },
      next_true: "a",
      next_false: null,
    },
    a: {
      type: "NOTIFY",
      channel: "slack",
      config: { webhook_url_secret: "s", message: "hi" },
      next: null,
    },
  },
};

describe("workflow validation", () => {
  it("accepts a valid linear DAG", () => {
    const r = validateWorkflow(linear);
    expect(r.ok).toBe(true);
  });
  it("accepts a valid branching DAG", () => {
    const r = validateWorkflow(branching);
    expect(r.ok).toBe(true);
  });

  it("detects an unknown start_node", () => {
    const bad = { ...linear, start_node: "missing" };
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/start_node/);
  });

  it("detects unresolved references", () => {
    const bad = {
      ...linear,
      nodes: { in: { type: "TRIGGER_INPUT", next: "ghost" } },
    };
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown node 'ghost'/);
  });

  it("detects cycles", () => {
    const bad = {
      schema_version: "1.0",
      name: "cycle",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "a" },
        a: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: "b" },
        b: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: "a" }, // cycle a->b->a
      },
    };
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/cycle/);
  });

  it("detects unreachable nodes", () => {
    const bad = {
      schema_version: "1.0",
      name: "orphan",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: null },
        ghost: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      },
    };
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unreachable/);
  });

  it("rejects schema-shape errors", () => {
    const r = validateWorkflow({ schema_version: "1.0", name: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("LOOP nodes — validator allows controlled back-edges", () => {
  it("accepts a LOOP whose body's terminal returns to the LOOP", () => {
    const def = {
      schema_version: "1.0",
      name: "with-loop",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "loop1" },
        loop1: { type: "LOOP", count: 3, body: "step", next: null },
        step: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: null },
      },
    };
    const r = validateWorkflow(def);
    expect(r.ok).toBe(true);
  });

  it("still rejects a real cycle that is NOT through a LOOP body", () => {
    const def = {
      schema_version: "1.0",
      name: "cycle-not-loop",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "a" },
        a: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: "b" },
        b: { type: "HTTP_REQUEST", config: { method: "GET", url: "x" }, next: "a" }, // a→b→a
      },
    };
    const r = validateWorkflow(def);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/cycle/);
  });

  it("rejects a LOOP whose body references a missing node", () => {
    const def = {
      schema_version: "1.0",
      name: "bad-body",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "loop1" },
        loop1: { type: "LOOP", count: 3, body: "ghost", next: null },
      },
    };
    const r = validateWorkflow(def);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown node 'ghost'/);
  });
});

describe("referencedSecrets", () => {
  const def = {
    schema_version: "1.0",
    name: "x",
    start_node: "in",
    nodes: {
      in: { type: "TRIGGER_INPUT", next: "n1" },
      n1: {
        type: "NOTIFY",
        channel: "slack",
        config: { webhook_url_secret: "slack_a", message: "" },
        next: "n2",
      },
      n2: {
        type: "NOTIFY",
        channel: "slack",
        config: { webhook_url_secret: "slack_b", message: "" },
        next: "n3",
      },
      n3: {
        type: "NOTIFY",
        channel: "slack",
        // duplicate name must still de-dup
        config: { webhook_url_secret: "slack_a", message: "" },
        next: "n4",
      },
      n4: {
        type: "NOTIFY",
        channel: "email",
        // email channel must NOT contribute a slack secret
        config: { to: "a@b.com", message: "" },
        next: null,
      },
    },
  } as unknown as WorkflowDefinition;

  it("collects unique slack webhook secret names", () => {
    expect(referencedSecrets(def).sort()).toEqual(["slack_a", "slack_b"]);
  });

  it("returns empty for a workflow with no slack notifies", () => {
    const noSlack = {
      ...def,
      nodes: { in: { type: "TRIGGER_INPUT", next: null } },
    } as unknown as WorkflowDefinition;
    expect(referencedSecrets(noSlack)).toEqual([]);
  });
});
