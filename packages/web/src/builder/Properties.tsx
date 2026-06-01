import { useId } from "react";
import type { FlowData, FlowNode } from "./convert";
import type { WorkflowNode } from "./types";
import { PALETTE } from "./types";

interface Props {
  node: FlowNode;
  onChange(cfg: WorkflowNode): void;
  onRename(newId: string): void;
  onDelete(): void;
  conflictIds: Set<string>; // existing node ids — to validate rename
}

export function Properties({
  node,
  onChange,
  onRename,
  onDelete,
  conflictIds,
}: Props): JSX.Element {
  const d = node.data as FlowData;
  const cfg = d.config;
  const meta = PALETTE[d.type];
  // Single id base; concrete field ids are `${base}-${key}`. Lets us associate
  // labels with inputs (a11y + testing-library's getByLabelText) without
  // calling useId() conditionally.
  const idBase = useId();
  const fid = (k: string): string => `${idBase}-${k}`;

  function update<T extends WorkflowNode>(patch: Partial<T>): void {
    onChange({ ...(cfg as T), ...patch });
  }
  function updateNested(path: string[], value: unknown): void {
    const next = structuredClone(cfg) as unknown as Record<string, unknown>;
    let cur: Record<string, unknown> = next;
    for (let i = 0; i < path.length - 1; i++) {
      cur[path[i]!] = (cur[path[i]!] as Record<string, unknown>) ?? {};
      cur = cur[path[i]!] as Record<string, unknown>;
    }
    cur[path.at(-1)!] = value;
    onChange(next as unknown as WorkflowNode);
  }

  return (
    <aside className="props">
      <div className="props__head">
        <span className="props__chip" style={{ background: meta.color }}>
          {meta.emoji} {meta.label}
        </span>
        <div className="spacer" />
        <button className="ghost danger" onClick={onDelete} title="Delete node">
          Delete
        </button>
      </div>

      <div className="field">
        <label htmlFor={fid("nid")}>Node id</label>
        <input
          id={fid("nid")}
          value={d.nid}
          onChange={(e) => {
            const v = e.target.value.replace(/[^a-zA-Z0-9_]/g, "_");
            if (v && v !== d.nid && !conflictIds.has(v)) onRename(v);
          }}
        />
        <div className="muted" style={{ fontSize: 11 }}>
          Used in references and run logs. Letters, digits, and underscores.
        </div>
      </div>

      {cfg.type === "TRIGGER_INPUT" && (
        <div className="muted" style={{ fontSize: 12 }}>
          The trigger node is the entry point of the workflow. Attach a webhook or cron trigger on
          the workflow page to fire it.
        </div>
      )}

      {cfg.type === "HTTP_REQUEST" && (
        <>
          <div className="field">
            <label htmlFor={fid("method")}>Method</label>
            <select
              id={fid("method")}
              value={cfg.config.method ?? "GET"}
              onChange={(e) => updateNested(["config", "method"], e.target.value)}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={fid("url")}>URL</label>
            <input
              id={fid("url")}
              value={cfg.config.url}
              onChange={(e) => updateNested(["config", "url"], e.target.value)}
              placeholder="https://api.example.com/x"
            />
          </div>
          <div className="field">
            <label htmlFor={fid("body")}>
              Body (JSON or text — use {`{{trigger.payload.x}}`} to template)
            </label>
            <textarea
              id={fid("body")}
              rows={4}
              value={
                typeof cfg.config.body === "string"
                  ? cfg.config.body
                  : JSON.stringify(cfg.config.body ?? "", null, 2)
              }
              onChange={(e) => {
                const v = e.target.value;
                let parsed: unknown = v;
                try {
                  parsed = JSON.parse(v);
                } catch {
                  /* keep as string */
                }
                updateNested(["config", "body"], parsed);
              }}
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
          </div>
          <details>
            <summary className="muted">Advanced</summary>
            <div className="field">
              <label htmlFor={fid("headers")}>Headers (JSON)</label>
              <textarea
                id={fid("headers")}
                rows={3}
                value={JSON.stringify(cfg.config.headers ?? {}, null, 2)}
                onChange={(e) => {
                  try {
                    updateNested(["config", "headers"], JSON.parse(e.target.value));
                  } catch {
                    /* ignore */
                  }
                }}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </div>
            <div className="field">
              <label htmlFor={fid("timeout")}>Timeout (ms)</label>
              <input
                id={fid("timeout")}
                type="number"
                value={cfg.timeout_ms ?? ""}
                onChange={(e) =>
                  update({ timeout_ms: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder="30000"
              />
            </div>
          </details>
        </>
      )}

      {cfg.type === "CONDITION" && (
        <>
          <div className="field">
            <label htmlFor={fid("left")}>Left (path or value, supports {`{{...}}`})</label>
            <input
              id={fid("left")}
              value={cfg.condition.left}
              onChange={(e) => updateNested(["condition", "left"], e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={fid("op")}>Operator</label>
            <select
              id={fid("op")}
              value={cfg.condition.op}
              onChange={(e) => updateNested(["condition", "op"], e.target.value)}
            >
              {(
                [
                  "eq",
                  "neq",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "contains",
                  "not_contains",
                  "exists",
                  "not_exists",
                  "matches",
                ] as const
              ).map((op) => (
                <option key={op}>{op}</option>
              ))}
            </select>
          </div>
          {!["exists", "not_exists"].includes(cfg.condition.op) && (
            <div className="field">
              <label htmlFor={fid("right")}>Right</label>
              <input
                id={fid("right")}
                value={String(cfg.condition.right ?? "")}
                onChange={(e) => updateNested(["condition", "right"], e.target.value)}
              />
            </div>
          )}
          <div className="muted" style={{ fontSize: 11 }}>
            Connect the bottom-left handle as the <strong>true</strong> branch and the bottom-right
            as <strong>false</strong>.
          </div>
        </>
      )}

      {cfg.type === "DELAY" && (
        <div className="field">
          <label htmlFor={fid("delay")}>Delay (milliseconds)</label>
          <input
            id={fid("delay")}
            type="number"
            min={0}
            value={cfg.delay_ms}
            onChange={(e) => update({ delay_ms: Number(e.target.value) })}
          />
          <div className="muted" style={{ fontSize: 11 }}>
            5000 = 5 seconds. The dispatcher schedules the next step at this time without occupying
            a worker during the wait.
          </div>
        </div>
      )}

      {cfg.type === "LOOP" && (
        <>
          <div className="field">
            <label htmlFor={fid("count")}>Iterations (count)</label>
            <input
              id={fid("count")}
              type="number"
              min={1}
              max={1000}
              value={cfg.count}
              onChange={(e) => update({ count: Number(e.target.value) })}
            />
            <div className="muted" style={{ fontSize: 11 }}>
              The body sub-flow runs this many times. Each iteration can read{" "}
              <code>{`{{nodes.${d.nid}.index}}`}</code> and{" "}
              <code>{`{{nodes.${d.nid}.count}}`}</code>.
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Connect the <strong style={{ color: "#a855f7" }}>body</strong> handle (left) to the
            first node of your loop body. The body&apos;s terminal (a node whose <em>next</em> is
            empty) signals the end of one iteration. Connect the <strong>next</strong> handle
            (right) to whatever runs after the loop completes.
          </div>
        </>
      )}

      {cfg.type === "NOTIFY" && (
        <>
          <div className="field">
            <label htmlFor={fid("channel")}>Channel</label>
            <select
              id={fid("channel")}
              value={cfg.channel}
              onChange={(e) => update({ channel: e.target.value as "slack" | "email" })}
            >
              <option value="slack">Slack</option>
              <option value="email">Email</option>
            </select>
          </div>
          {cfg.channel === "slack" && (
            <div className="field">
              <label htmlFor={fid("slack_secret")}>Webhook URL — secret name</label>
              <input
                id={fid("slack_secret")}
                value={cfg.config.webhook_url_secret ?? ""}
                onChange={(e) => updateNested(["config", "webhook_url_secret"], e.target.value)}
                placeholder="slack_hook"
              />
              <div className="muted" style={{ fontSize: 11 }}>
                The plaintext URL lives in Secrets — store it there and reference the name here.
              </div>
            </div>
          )}
          {cfg.channel === "email" && (
            <>
              <div className="field">
                <label htmlFor={fid("to")}>To</label>
                <input
                  id={fid("to")}
                  value={cfg.config.to ?? ""}
                  onChange={(e) => updateNested(["config", "to"], e.target.value)}
                  placeholder="alerts@example.com"
                />
              </div>
              <div className="field">
                <label htmlFor={fid("subject")}>Subject</label>
                <input
                  id={fid("subject")}
                  value={cfg.config.subject ?? ""}
                  onChange={(e) => updateNested(["config", "subject"], e.target.value)}
                />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor={fid("message")}>Message (supports {`{{...}}`})</label>
            <textarea
              id={fid("message")}
              rows={4}
              value={cfg.config.message}
              onChange={(e) => updateNested(["config", "message"], e.target.value)}
            />
          </div>
        </>
      )}
    </aside>
  );
}
