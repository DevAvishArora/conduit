import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowData } from "./convert";
import { PALETTE } from "./types";

/**
 * Visual representation of a single workflow node on the canvas.
 * CONDITION nodes expose two source handles (true / false); every other node
 * type has a single source handle plus a target handle on top.
 */
export function FlowNodeView({ data, selected }: NodeProps): JSX.Element {
  const d = data as FlowData;
  const meta = PALETTE[d.type];
  const cfg = d.config;

  // A compact subtitle that summarises the node's config without opening the panel.
  let subtitle = meta.sub;
  if (cfg.type === "HTTP_REQUEST")
    subtitle = `${cfg.config.method ?? "GET"} ${truncate(cfg.config.url, 28)}`;
  else if (cfg.type === "CONDITION")
    subtitle = `${truncate(String(cfg.condition.left), 18)} ${cfg.condition.op} ${truncate(String(cfg.condition.right ?? ""), 14)}`;
  else if (cfg.type === "DELAY") subtitle = `wait ${formatMs(cfg.delay_ms)}`;
  else if (cfg.type === "NOTIFY")
    subtitle = `${cfg.channel}: ${truncate(cfg.config.message ?? "", 28)}`;
  else if (cfg.type === "TRIGGER_INPUT") subtitle = "webhook / cron entry";
  else if (cfg.type === "LOOP") subtitle = `repeat body × ${cfg.count}`;

  return (
    <div
      className={`fnode ${selected ? "fnode--sel" : ""}`}
      style={{ borderColor: selected ? meta.color : "var(--line)" }}
    >
      {/* every node except TRIGGER_INPUT has an incoming edge */}
      {d.type !== "TRIGGER_INPUT" && (
        <Handle type="target" position={Position.Top} className="fhandle" />
      )}

      <div className="fnode__head" style={{ background: meta.color }}>
        <span className="fnode__emoji">{meta.emoji}</span>
        <span className="fnode__type">{meta.label}</span>
        {d.isStart && <span className="fnode__start">START</span>}
      </div>
      <div className="fnode__body">
        <div className="fnode__id">{d.nid}</div>
        <div className="fnode__sub">{subtitle}</div>
      </div>

      {d.type === "CONDITION" ? (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            className="fhandle fhandle--true"
            style={{ left: "30%" }}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Bottom}
            className="fhandle fhandle--false"
            style={{ left: "70%" }}
          />
          <div className="fnode__branches">
            <span className="fnode__branch fnode__branch--true">true</span>
            <span className="fnode__branch fnode__branch--false">false</span>
          </div>
        </>
      ) : d.type === "LOOP" ? (
        <>
          <Handle
            id="body"
            type="source"
            position={Position.Bottom}
            className="fhandle fhandle--loop"
            style={{ left: "30%" }}
          />
          <Handle
            id="out"
            type="source"
            position={Position.Bottom}
            className="fhandle"
            style={{ left: "70%" }}
          />
          <div className="fnode__branches">
            <span className="fnode__branch fnode__branch--loop">body</span>
            <span className="fnode__branch">next</span>
          </div>
        </>
      ) : (
        <Handle id="out" type="source" position={Position.Bottom} className="fhandle" />
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}
