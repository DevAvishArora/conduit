import { successors, WorkflowDefinition } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  definition?: WorkflowDefinition;
}

/**
 * Structural validation of a workflow definition (§5.3.2): schema, reference
 * integrity, reachability and acyclicity. Workflows are DAGs at the top level;
 * LOOP nodes introduce a controlled back-edge from any descendant of their
 * body back to the LOOP itself — those back-edges are not "cycles".
 */
export function validateWorkflow(raw: unknown): ValidationResult {
  const parsed = WorkflowDefinition.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const def = parsed.data;
  const errors: string[] = [];
  const ids = new Set(Object.keys(def.nodes));

  if (!ids.has(def.start_node)) errors.push(`start_node '${def.start_node}' is not a defined node`);

  // Reference integrity: every successor points to a real node or null (end).
  for (const [id, node] of Object.entries(def.nodes)) {
    for (const next of successors(node)) {
      if (next !== null && !ids.has(next)) {
        errors.push(`node '${id}' references unknown node '${next}'`);
      }
    }
  }

  // Cycle detection via DFS colouring (white/grey/black). `inBodyOf` tracks
  // the LOOP nodes whose body we're currently descending — back-edges to
  // those are legal (the LOOP iterates).
  const colour = new Map<string, 0 | 1 | 2>();
  const inBodyOf = new Set<string>();
  const dfs = (id: string): void => {
    colour.set(id, 1);
    const node = def.nodes[id];
    if (node) {
      const isLoop = node.type === "LOOP";
      const recur = (target: string | null, viaLoopBody = false): void => {
        if (target === null || !ids.has(target)) return;
        const c = colour.get(target) ?? 0;
        if (c === 1) {
          if (inBodyOf.has(target)) return; // legal loop back-edge
          errors.push(`cycle detected: '${id}' -> '${target}'`);
          return;
        }
        if (c === 0) {
          if (viaLoopBody) inBodyOf.add(id);
          dfs(target);
          if (viaLoopBody) inBodyOf.delete(id);
        }
      };
      if (isLoop) {
        recur(node.body, true);
        recur(node.next);
      } else {
        for (const next of successors(node)) recur(next);
      }
    }
    colour.set(id, 2);
  };
  if (ids.has(def.start_node)) dfs(def.start_node);

  // Reachability: warn about orphan nodes (error — they can never run).
  for (const id of ids) {
    if ((colour.get(id) ?? 0) === 0) errors.push(`node '${id}' is unreachable from start_node`);
  }

  return errors.length === 0 ? { ok: true, errors: [], definition: def } : { ok: false, errors };
}

/** Collect secret names referenced by the definition (for resolvability check). */
export function referencedSecrets(def: WorkflowDefinition): string[] {
  const names = new Set<string>();
  for (const node of Object.values(def.nodes)) {
    if (node.type === "NOTIFY" && node.channel === "slack" && node.config.webhook_url_secret) {
      names.add(node.config.webhook_url_secret);
    }
  }
  return [...names];
}
