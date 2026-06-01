import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type NodeChange,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  defToGraph,
  type FlowData,
  type FlowEdge,
  type FlowNode,
  graphToDef,
  newFlowNode,
} from "./convert";
import { FlowNodeView } from "./FlowNodeView";
import { Properties } from "./Properties";
import { PALETTE, type NodeType, type WorkflowDefinition, type WorkflowNode } from "./types";

const NODE_TYPES = { flowNode: FlowNodeView } as const;
const DEFAULT_EDGE_OPTIONS = { type: "smoothstep", animated: false } as const;

interface BuilderProps {
  name: string;
  initial: WorkflowDefinition | null;
  onSave(def: WorkflowDefinition): Promise<void>;
  onPublish(): Promise<void>;
  disabled?: boolean;
}

export function Builder(props: BuilderProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ name, initial, onSave, onPublish, disabled }: BuilderProps): JSX.Element {
  const wrapper = useRef<HTMLDivElement>(null);
  const rf = useReactFlow<FlowNode, FlowEdge>();

  const seed = useMemo<{ nodes: FlowNode[]; edges: FlowEdge[] }>(() => {
    if (!initial) {
      const trigger = newFlowNode("TRIGGER_INPUT", { x: 100, y: 120 }, new Set());
      return { nodes: [trigger], edges: [] };
    }
    return defToGraph(initial);
  }, [initial]);

  const [nodes, setNodes] = useState<FlowNode[]>(seed.nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(seed.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const idSet = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  const onNodesChange = useCallback(
    (chs: NodeChange<FlowNode>[]) => setNodes((cur) => applyNodeChanges(chs, cur)),
    [],
  );
  const onEdgesChange = useCallback(
    (chs: EdgeChange<FlowEdge>[]) => setEdges((cur) => applyEdgeChanges(chs, cur)),
    [],
  );

  /**
   * onConnect: drag from one node's source handle to another node's target.
   * For CONDITION, we enforce one edge per sourceHandle (true / false) by
   * replacing any existing edge from the same (source, handle) pair.
   */
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    setEdges((cur) => {
      const filtered = cur.filter(
        (e) => !(e.source === c.source && (e.sourceHandle ?? "out") === (c.sourceHandle ?? "out")),
      );
      return addEdge(
        {
          ...c,
          id: `${c.source}::${c.sourceHandle ?? "out"}::${c.target}`,
          label:
            c.sourceHandle === "true" ? "true" : c.sourceHandle === "false" ? "false" : undefined,
          ...DEFAULT_EDGE_OPTIONS,
        } as Edge,
        filtered,
      );
    });
  }, []);

  // ── DnD from palette ────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/flow-node") as NodeType | "";
      if (!type) return;
      if (type === "TRIGGER_INPUT" && nodes.some((n) => n.data.type === "TRIGGER_INPUT")) {
        setStatus("only one Trigger node is allowed");
        return;
      }
      if (!wrapper.current) return;
      const rect = wrapper.current.getBoundingClientRect();
      const position = rf.screenToFlowPosition({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      const fresh = newFlowNode(type, position, idSet);
      setNodes((cur) => cur.concat(fresh));
      setSelected(fresh.id);
    },
    [rf, idSet, nodes],
  );

  // ── Properties panel callbacks ──────────────────────────────
  const selectedNode = nodes.find((n) => n.id === selected) ?? null;

  function applyConfig(cfg: WorkflowNode): void {
    setNodes((cur) =>
      cur.map((n) =>
        n.id === selected
          ? ({
              ...n,
              data: { ...n.data, type: cfg.type, config: cfg } as FlowData,
            } as FlowNode)
          : n,
      ),
    );
  }
  function renameSelected(newId: string): void {
    if (!selected || newId === selected || idSet.has(newId)) return;
    setNodes((cur) =>
      cur.map((n) =>
        n.id === selected
          ? ({ ...n, id: newId, data: { ...n.data, nid: newId } as FlowData } as FlowNode)
          : n,
      ),
    );
    setEdges((cur) =>
      cur.map((e) => ({
        ...e,
        source: e.source === selected ? newId : e.source,
        target: e.target === selected ? newId : e.target,
      })),
    );
    setSelected(newId);
  }
  function deleteSelected(): void {
    if (!selected) return;
    setNodes((cur) => cur.filter((n) => n.id !== selected));
    setEdges((cur) => cur.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  }

  // ── save / publish ──────────────────────────────────────────
  async function save(): Promise<void> {
    setStatus(null);
    const r = graphToDef(name, nodes, edges);
    if (!r.ok) {
      setStatus(r.error);
      return;
    }
    setSaving(true);
    try {
      await onSave(r.def);
      setStatus("draft saved");
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function saveAndPublish(): Promise<void> {
    setStatus(null);
    const r = graphToDef(name, nodes, edges);
    if (!r.ok) {
      setStatus(r.error);
      return;
    }
    setSaving(true);
    try {
      await onSave(r.def);
      await onPublish();
      setStatus("published 🎉");
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="builder">
      {/* Palette */}
      <div className="palette">
        <div className="palette__title">Add nodes</div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
          Drag onto the canvas. Connect by dragging from a node&apos;s bottom handle.
        </div>
        {(
          ["TRIGGER_INPUT", "HTTP_REQUEST", "CONDITION", "DELAY", "LOOP", "NOTIFY"] as NodeType[]
        ).map((t) => {
          const meta = PALETTE[t];
          const disabled =
            t === "TRIGGER_INPUT" && nodes.some((n) => n.data.type === "TRIGGER_INPUT");
          return (
            <div
              key={t}
              className={`palette__item ${disabled ? "palette__item--off" : ""}`}
              draggable={!disabled}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/flow-node", t);
                e.dataTransfer.effectAllowed = "move";
              }}
              style={{ borderLeft: `4px solid ${meta.color}` }}
              title={disabled ? "only one Trigger allowed" : `Drag to add ${meta.label}`}
            >
              <span className="palette__emoji">{meta.emoji}</span>
              <div>
                <div className="palette__name">{meta.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {meta.sub}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Canvas */}
      <div className="canvas" ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
          nodeTypes={NODE_TYPES}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          fitView
          minZoom={0.4}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e2e8f0" />
          <Controls position="bottom-right" />
          <MiniMap pannable zoomable position="bottom-left" />
          <Panel position="top-right" className="builder__panel">
            {status && (
              <span
                className={status.startsWith("draft") || status.includes("publish") ? "ok" : "bad"}
              >
                {status}
              </span>
            )}
            <button className="ghost" onClick={save} disabled={disabled || saving}>
              {saving ? "…" : "Save draft"}
            </button>
            <button onClick={saveAndPublish} disabled={disabled || saving}>
              {saving ? "…" : "Save & publish"}
            </button>
          </Panel>
        </ReactFlow>
      </div>

      {/* Properties (only when a node is selected) */}
      {selectedNode ? (
        <Properties
          node={selectedNode}
          onChange={applyConfig}
          onRename={renameSelected}
          onDelete={deleteSelected}
          conflictIds={idSet}
        />
      ) : (
        <aside className="props props--empty">
          <div className="muted">Select a node to edit its properties.</div>
        </aside>
      )}
    </div>
  );
}
