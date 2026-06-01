import type { WorkflowDefinition, XY } from "./types";

/**
 * A tiny breadth-first layered layout. We use it ONLY when a node has no
 * persisted `_pos` — once the user drags a node, that position sticks.
 *
 * Nodes are laid out in columns by their distance from the start node; siblings
 * within a column are spread vertically.
 */
const COL = 260;
const ROW = 110;

export function autoLayout(def: WorkflowDefinition): Record<string, XY> {
  const out: Record<string, XY> = {};
  const depth: Record<string, number> = {};
  const succ = (id: string): string[] => {
    const n = def.nodes[id];
    if (!n) return [];
    if (n.type === "CONDITION") return [n.next_true, n.next_false].filter(Boolean) as string[];
    return n.next ? [n.next] : [];
  };

  // BFS to assign depth.
  const queue: [string, number][] = [[def.start_node, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (id in depth) continue;
    depth[id] = d;
    for (const s of succ(id)) queue.push([s, d + 1]);
  }
  // Anything unreached (orphans) gets pushed to the right at depth max+1.
  const maxDepth = Math.max(0, ...Object.values(depth));
  for (const id of Object.keys(def.nodes)) {
    if (!(id in depth)) depth[id] = maxDepth + 1;
  }

  // Group by column, place evenly within each column.
  const byCol: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) (byCol[d] ??= []).push(id);
  for (const [colStr, ids] of Object.entries(byCol)) {
    const col = Number(colStr);
    ids.sort();
    ids.forEach((id, i) => {
      out[id] = { x: 80 + col * COL, y: 60 + i * ROW };
    });
  }
  return out;
}
