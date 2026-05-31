import type { NodeType } from "../types.js";
import type { NodeHandler } from "./types.js";

/**
 * Handler registry (§6.5.3). The doc discovers connectors via Python entry
 * points; the Node analogue is registering modules here at worker startup. A
 * third-party connector ships as its own package and calls `register()` from
 * its entry module — no core change needed.
 */
const registry = new Map<NodeType, NodeHandler>();

export function register(handler: NodeHandler): void {
  registry.set(handler.typeId, handler);
}

export function getHandler(type: NodeType): NodeHandler | undefined {
  return registry.get(type);
}

export function registeredTypes(): NodeType[] {
  return [...registry.keys()];
}
