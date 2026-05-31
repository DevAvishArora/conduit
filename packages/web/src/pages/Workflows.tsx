import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";

interface Workflow {
  id: string;
  name: string;
  status: string;
  current_version: number | null;
  created_at: string;
}

const SAMPLE_DEF = JSON.stringify(
  {
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
        config: { webhook_url_secret: "slack_hook", message: "high: {{trigger.payload.title}}" },
        next: null,
      },
    },
  },
  null,
  2,
);

export function Workflows(): JSX.Element {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [def, setDef] = useState(SAMPLE_DEF);
  const nav = useNavigate();

  async function refresh(): Promise<void> {
    try {
      const r = await api.get<{ items: Workflow[] }>("/v1/workflows");
      setItems(r.items);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  useEffect(() => void refresh(), []);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      const parsed = JSON.parse(def);
      const r = await api.post<{ id: string }>("/v1/workflows", { name, definition: parsed });
      nav(`/workflows/${r.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <>
      <div className="row">
        <h1>Workflows</h1>
        <div className="spacer" />
        <button onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New"}</button>
      </div>
      {creating && (
        <div className="card">
          <form onSubmit={create}>
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label>Definition (JSON DAG)</label>
              <textarea
                value={def}
                onChange={(e) => setDef(e.target.value)}
                rows={16}
                style={{ width: "100%", fontFamily: "ui-monospace, monospace" }}
              />
            </div>
            {err && <div className="problem">{err}</div>}
            <button>Create draft</button>
          </form>
        </div>
      )}
      {!creating && err && <div className="problem">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((w) => (
              <tr
                key={w.id}
                style={{ cursor: "pointer" }}
                onClick={() => nav(`/workflows/${w.id}`)}
              >
                <td>
                  <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                </td>
                <td>{w.status}</td>
                <td>{w.current_version ?? <span className="muted">— draft</span>}</td>
                <td className="muted">{new Date(w.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {items && items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 24 }} className="muted">
                  No workflows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
