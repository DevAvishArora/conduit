import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";

interface Run {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  error_summary: string | null;
}

export function Runs(): JSX.Element {
  const [items, setItems] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  async function refresh(): Promise<void> {
    try {
      const r = await api.get<{ items: Run[] }>("/v1/runs?limit=100");
      setItems(r.items);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <h1>Runs</h1>
      {err && <div className="problem">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => nav(`/runs/${r.id}`)}>
                <td>{r.id.slice(0, 8)}</td>
                <td className="muted">{r.workflow_id.slice(0, 8)}</td>
                <td>
                  <span className={`tag ${r.status.toLowerCase()}`}>{r.status}</span>
                </td>
                <td className="muted">{new Date(r.started_at).toLocaleString()}</td>
                <td className="muted">
                  {r.ended_at
                    ? `${((+new Date(r.ended_at) - +new Date(r.started_at)) / 1000).toFixed(1)}s`
                    : "—"}
                </td>
              </tr>
            ))}
            {items && items.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: 24 }} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
