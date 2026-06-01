import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: string;
}

const ACTION_TAG: Record<string, string> = {
  create: "succeeded",
  publish: "running",
  update: "running",
  archive: "cancelled",
  delete: "failed",
  pause: "cancelled",
  resume: "succeeded",
  cancel: "failed",
  retry: "running",
};

export function Audit(): JSX.Element {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load(reset = false): Promise<void> {
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (!reset && cursor) qs.set("cursor", cursor);
      if (actionFilter) qs.set("action", actionFilter);
      const r = await api.get<{ items: AuditEntry[]; next_cursor: string | null }>(
        `/v1/audit?${qs.toString()}`,
      );
      setItems((cur) => (reset ? r.items : [...cur, ...r.items]));
      setCursor(r.next_cursor);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  useEffect(() => {
    setItems([]);
    setCursor(null);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter]);

  function tagClass(action: string): string {
    const verb = action.split(".")[1] ?? "";
    return `tag ${ACTION_TAG[verb] ?? "pending"}`;
  }

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Every state-changing API call writes a row. Admin-only. Append-only — there&apos;s no
        delete.
      </p>
      {err && <div className="problem">{err}</div>}

      <div className="card" style={{ padding: 12 }}>
        <div className="row">
          <label style={{ margin: 0 }}>Filter by action:</label>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">all</option>
            {[
              "workflow.create",
              "workflow.update",
              "workflow.publish",
              "workflow.archive",
              "trigger.create",
              "trigger.delete",
              "run.pause",
              "run.resume",
              "run.cancel",
              "run.retry",
            ].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => {
              const isOpen = expanded === e.id;
              return (
                <>
                  <tr
                    key={e.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => setExpanded(isOpen ? null : e.id)}
                  >
                    <td className="muted">{new Date(e.occurred_at).toLocaleString()}</td>
                    <td className="muted">{e.actor_user_id?.slice(0, 8) ?? "—"}</td>
                    <td>
                      <span className={tagClass(e.action)}>{e.action}</span>
                    </td>
                    <td className="muted">
                      {e.resource_type}
                      {e.resource_id ? ` · ${e.resource_id.slice(0, 8)}` : ""}
                    </td>
                    <td className="muted">{e.ip_address ?? "—"}</td>
                  </tr>
                  {isOpen && (e.before || e.after || e.user_agent) && (
                    <tr key={`${e.id}-d`}>
                      <td colSpan={5} style={{ background: "var(--panel-2)" }}>
                        <div className="muted" style={{ marginBottom: 4 }}>
                          user-agent: {e.user_agent ?? "—"}
                        </div>
                        {e.before != null && (
                          <details>
                            <summary className="muted">before</summary>
                            <pre className="code" style={{ maxHeight: 220 }}>
                              {JSON.stringify(e.before, null, 2)}
                            </pre>
                          </details>
                        )}
                        {e.after != null && (
                          <details open>
                            <summary className="muted">after</summary>
                            <pre className="code" style={{ maxHeight: 220 }}>
                              {JSON.stringify(e.after, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 22 }}>
                  No audit entries yet. Do something (create a workflow, publish, attach a trigger)
                  and refresh.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {cursor && (
        <div className="row" style={{ marginTop: 12 }}>
          <div className="spacer" />
          <button className="ghost" onClick={() => load(false)}>
            Load more
          </button>
        </div>
      )}
    </>
  );
}
