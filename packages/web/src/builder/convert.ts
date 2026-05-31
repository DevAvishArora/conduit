import type { Edge, Node } from "@xyflow/react";
import { autoLayout } from "./layout";
import {
  defaultNode,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowNode,
  type XY,
} from "./types";

/**
 * Node data carried on each React Flow node. We keep the source-of-truth
 * config here so the properties panel and the JSON exporter share one place.
 */
export interface FlowData extends Record<string, unknown> {
  /** node id (also matches React Flow's node.id) */
  nid: string;
  type: NodeType;
  config: WorkflowNode;
  isStart: boolean;
}

export type FlowNode = Node<FlowData>;
export type FlowEdge = Edge;

// ── JSON → graph ────────────────────────────────────────────────
export function defToGraph(def: WorkflowDefinition): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const layout = autoLayout(def);
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  for (const [id, n] of Object.entries(def.nodes)) {
    const pos = n._pos ?? layout[id] ?? { x: 0, y: 0 };
    nodes.push({
      id,
      type: "flowNode",
      position: pos,
      data: { nid: id, type: n.type, config: n, isStart: id === def.start_node },
    });
    if (n.type === "CONDITION") {
      if (n.next_true) edges.push(makeEdge(id, n.next_true, "true"));
      if (n.next_false) edges.push(makeEdge(id, n.next_false, "false"));
    } else if (n.type === "LOOP") {
      if (n.body) edges.push(makeEdge(id, n.body, "body"));
      if (n.next) edges.push(makeEdge(id, n.next, "out"));
    } else if ("next" in n && n.next) {
      edges.push(makeEdge(id, n.next));
    }
  }
  return { nodes, edges };
}

function edgeLabel(handle?: string): string | undefined {
  if (handle === "true") return "true";
  if (handle === "false") return "false";
  if (handle === "body") return "body";
  return undefined;
}

function makeEdge(source: string, target: string, sourceHandle?: string): FlowEdge {
  return {
    id: `${source}::${sourceHandle ?? "out"}::${target}`,
    source,
    target,
    sourceHandle,
    label: edgeLabel(sourceHandle),
    type: "smoothstep",
    animated: false,
  };
}

// ── graph → JSON ────────────────────────────────────────────────
export function graphToDef(
  name: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
): { ok: true; def: WorkflowDefinition } | { ok: false; error: string } {
  const triggers = nodes.filter((n) => n.data.type === "TRIGGER_INPUT");
  if (triggers.length === 0)
    return { ok: false, error: "add a Trigger node — every workflow needs an entry point" };
  if (triggers.length > 1) return { ok: false, error: "only one Trigger node is allowed" };

  const startNodeId = triggers[0]!.id;
  const out: Record<string, WorkflowNode> = {};

  for (const n of nodes) {
    const cfg = structuredClone(n.data.config);
    cfg._pos = { x: Math.round(n.position.x), y: Math.round(n.position.y) };

    if (cfg.type === "CONDITION") {
      cfg.next_true =
        edges.find((e) => e.source === n.id && e.sourceHandle === "true")?.target ?? null;
      cfg.next_false =
        edges.find((e) => e.source === n.id && e.sourceHandle === "false")?.target ?? null;
    } else if (cfg.type === "LOOP") {
      // LOOP has a separate `body` source handle for the iteration entry, and
      // `out` for the post-loop continuation.
      cfg.body = edges.find((e) => e.source === n.id && e.sourceHandle === "body")?.target ?? "";
      cfg.next =
        edges.find((e) => e.source === n.id && (!e.sourceHandle || e.sourceHandle === "out"))
          ?.target ?? null;
      if (!cfg.body) {
        return {
          ok: false,
          error: `LOOP "${n.id}" needs a body — connect its body handle to the first node of the loop body`,
        };
      }
    } else {
      cfg.next =
        edges.find((e) => e.source === n.id && (!e.sourceHandle || e.sourceHandle === "out"))
          ?.target ?? null;
    }
    out[n.id] = cfg;
  }

  return {
    ok: true,
    def: {
      schema_version: "1.0",
      name,
      start_node: startNodeId,
      nodes: out,
    },
  };
}

// ── helpers used by the canvas ──────────────────────────────────
let counter = 0;
export function freshId(type: NodeType, existing: Set<string>): string {
  // Human-friendly id: lowercased type + counter, avoiding collisions.
  const base = type.toLowerCase().replace("_", "");
  do {
    counter++;
    const id = `${base}_${counter}`;
    if (!existing.has(id)) return id;
  } while (counter < 10_000);
  return `${base}_${Date.now()}`;
}

export function newFlowNode(type: NodeType, position: XY, existingIds: Set<string>): FlowNode {
  const id = freshId(type, existingIds);
  return {
    id,
    type: "flowNode",
    position,
    data: { nid: id, type, config: defaultNode(type), isStart: type === "TRIGGER_INPUT" },
  };
}
