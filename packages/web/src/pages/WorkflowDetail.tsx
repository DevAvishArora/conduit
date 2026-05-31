import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Builder } from "../builder/Builder";
import type { WorkflowDefinition } from "../builder/types";

interface TriggerSummary {
  id: string;
  type: "webhook" | "cron";
  webhook_url?: string;
  cron_expr?: string | null;
  active: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
}
interface WorkflowDetail {
  id: string;
  name: string;
  status: string;
  current_version: number | null;
  current_version_id: string | null;
  draft_definition: WorkflowDefinition | null;
  triggers: TriggerSummary[];
  created_at: string;
}
interface Version {
  id: string;
  version_number: number;
  published_at: string;
  published_by: string | null;
}

type Tab = "visual" | "json";

export function WorkflowDetail(): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [tab, setTab] = useState<Tab>("visual");
  const [rawJson, setRawJson] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cronExpr, setCronExpr] = useState("*/5 * * * *");

  async function refresh(): Promise<void> {
    setErr(null);
    try {
      const [r, v] = await Promise.all([
        api.get<WorkflowDetail>(`/v1/workflows/${id}`),
        api.get<{ items: Version[] }>(`/v1/workflows/${id}/versions`),
      ]);
      setWf(r);
      setRawJson(JSON.stringify(r.draft_definition ?? {}, null, 2));
      setVersions(v.items);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  // refresh closes over state and is recreated each render; depending on it
  // would loop. We only want to re-fetch when the URL :id changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void refresh(), [id]);

  async function saveFromBuilder(def: WorkflowDefinition): Promise<void> {
    await api.patch(`/v1/workflows/${id}`, { definition: def });
    setRawJson(JSON.stringify(def, null, 2));
  }

  async function publish(): Promise<void> {
    setErr(null);
    try {
      const r = await api.post<{ version_number: number }>(`/v1/workflows/${id}/publish`, {});
      setMsg(`published v${r.version_number}`);
      await refresh();
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveJson(): Promise<void> {
    setErr(null);
    setMsg(null);
    try {
      const parsed = JSON.parse(rawJson);
      await api.patch(`/v1/workflows/${id}`, { definition: parsed });
      setMsg("draft saved");
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function archive(): Promise<void> {
    if (
      !confirm("Archive this workflow? Its triggers will be deactivated; existing runs continue.")
    )
      return;
    try {
      await api.post(`/v1/workflows/${id}/archive`);
      navigate("/workflows");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function addWebhook(): Promise<void> {
    setErr(null);
    try {
      const r = await api.post<{ webhook_url: string; secret_shown_once: string }>(
        `/v1/workflows/${id}/triggers`,
        { type: "webhook" },
      );
      setMsg(
        `Webhook URL: ${r.webhook_url}\nSecret (shown ONCE — copy now): ${r.secret_shown_once}`,
      );
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  async function addCron(): Promise<void> {
    setErr(null);
    try {
      await api.post(`/v1/workflows/${id}/triggers`, { type: "cron", cron_expr: cronExpr });
      setMsg(`cron trigger attached (${cronExpr})`);
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  async function deleteTrigger(tid: string): Promise<void> {
    if (!confirm("Delete this trigger?")) return;
    try {
      await api.del(`/v1/triggers/${tid}`);
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!wf) return <div>{err ?? "loading…"}</div>;
  const archived = wf.status !== "active";

  return (
    <>
      <div className="row">
        <h1>{wf.name}</h1>
        <span className={`tag ${wf.status}`}>{wf.status}</span>
        <span className="muted">
          v{wf.current_version ?? "draft"} · {wf.id.slice(0, 8)}
        </span>
        <div className="spacer" />
        {!archived && (
          <button className="ghost danger" onClick={archive}>
            Archive
          </button>
        )}
      </div>

      {err && <div className="problem">{err}</div>}
      {msg && (
        <div className="success" style={{ whiteSpace: "pre-wrap" }}>
          {msg}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === "visual" ? "tab--active" : ""}`}
          onClick={() => setTab("visual")}
        >
          🎨 Visual builder
        </button>
        <button
          className={`tab ${tab === "json" ? "tab--active" : ""}`}
          onClick={() => setTab("json")}
        >
          {} JSON
        </button>
      </div>

      {tab === "visual" ? (
        <Builder
          name={wf.name}
          initial={wf.draft_definition}
          onSave={saveFromBuilder}
          onPublish={publish}
          disabled={archived}
        />
      ) : (
        <div className="card">
          <textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            rows={26}
            style={{ width: "100%", fontFamily: "ui-monospace, monospace" }}
            disabled={archived}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted">
              Raw JSON view of the draft. Use the visual builder above unless you really want this.
            </span>
            <div className="spacer" />
            <button className="ghost" onClick={saveJson} disabled={archived}>
              Save draft
            </button>
          </div>
        </div>
      )}

      <h2>Triggers</h2>
      <div className="card">
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <button onClick={addWebhook} disabled={archived}>
            + Webhook
          </button>
          <span className="muted">or</span>
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="*/5 * * * *"
            style={{ width: 160 }}
          />
          <button onClick={addCron} disabled={archived}>
            + Cron
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>URL / expr</th>
              <th>Last fired</th>
              <th>Next fire</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {wf.triggers.map((t) => (
              <tr key={t.id}>
                <td>{t.type}</td>
                <td className="muted" style={{ wordBreak: "break-all" }}>
                  {t.type === "webhook" ? t.webhook_url : t.cron_expr}
                </td>
                <td className="muted">
                  {t.last_fired_at ? new Date(t.last_fired_at).toLocaleTimeString() : "—"}
                </td>
                <td className="muted">
                  {t.next_fire_at ? new Date(t.next_fire_at).toLocaleTimeString() : "—"}
                </td>
                <td>
                  <button className="ghost danger" onClick={() => deleteTrigger(t.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {wf.triggers.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 14 }}>
                  No triggers attached.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Version history</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>By</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>
                  v{v.version_number}
                  {v.version_number === wf.current_version && (
                    <span className="tag succeeded" style={{ marginLeft: 8 }}>
                      current
                    </span>
                  )}
                </td>
                <td className="muted">{new Date(v.published_at).toLocaleString()}</td>
                <td className="muted">{v.published_by?.slice(0, 8) ?? "—"}</td>
                <td className="muted">{v.id.slice(0, 8)}</td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: "center", padding: 14 }}>
                  No published versions yet — publish from the visual builder to create v1.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
