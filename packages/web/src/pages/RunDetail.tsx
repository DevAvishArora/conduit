import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, streamSse } from "../api";

interface Run {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  trigger_payload: unknown;
  started_at: string;
  ended_at: string | null;
  error_summary: string | null;
  node_count: number;
}
interface Event {
  id: number;
  event_type: string;
  payload: { node_id?: string; attempt?: number } & Record<string, unknown>;
  occurred_at: string;
}
interface Attempt {
  attempt_number: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  node_type: string;
  input_snapshot: unknown;
  output_snapshot: unknown;
  error_class: string | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export function RunDetail(): JSX.Element {
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [err, setErr] = useState<string | null>(null);

  // Initial snapshot + open the SSE stream from the last id. SSE is the
  // primary path (no polling); we briefly poll the RUN summary only because
  // status transitions don't all show up as events.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let stopSse: (() => void) | null = null;

    (async (): Promise<void> => {
      try {
        const r = await api.get<Run>(`/v1/runs/${id}`);
        if (cancelled) return;
        setRun(r);

        // bootstrap the event history before opening the stream
        const e = await api.get<{ items: Event[] }>(`/v1/runs/${id}/events?after_id=0`);
        if (cancelled) return;
        const lastId = e.items.at(-1)?.id ?? 0;
        setEvents(e.items);

        if (TERMINAL.has(r.status)) return; // nothing to stream

        stopSse = streamSse(
          `/v1/runs/${id}/events?after_id=${lastId}`,
          (ev) => {
            if (ev.event === "done") {
              api
                .get<Run>(`/v1/runs/${id}`)
                .then((next) => !cancelled && setRun(next))
                .catch(() => {});
              return;
            }
            try {
              const parsed = JSON.parse(ev.data) as Event;
              setEvents((prev) =>
                prev.some((p) => p.id === parsed.id) ? prev : [...prev, parsed],
              );
              // Status transitions arrive as events — refresh the run summary
              // on terminal events so the header tag updates.
              if (parsed.event_type.startsWith("Run")) {
                api
                  .get<Run>(`/v1/runs/${id}`)
                  .then((next) => !cancelled && setRun(next))
                  .catch(() => {});
              }
            } catch {
              /* ignore malformed frame */
            }
          },
          { onError: (e) => setErr(e instanceof ApiError ? e.message : String(e)) },
        );
      } catch (ex) {
        setErr(ex instanceof ApiError ? ex.message : String(ex));
      }
    })();

    return () => {
      cancelled = true;
      stopSse?.();
    };
  }, [id]);

  async function loadAttempts(nodeId: string): Promise<void> {
    if (attempts[nodeId]) return;
    try {
      const r = await api.get<{ items: Attempt[] }>(`/v1/runs/${id}/nodes/${nodeId}/attempts`);
      setAttempts((prev) => ({ ...prev, [nodeId]: r.items }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  function toggleNode(nodeId: string): void {
    setExpanded((cur) => (cur === nodeId ? null : nodeId));
    void loadAttempts(nodeId);
  }

  // Group events by node, preserving order, so the inspector shows a clean
  // per-node timeline. Run-level events are interleaved as banners.
  const grouped = useMemo(() => groupByNode(events), [events]);

  async function control(action: "pause" | "resume" | "cancel" | "retry"): Promise<void> {
    setErr(null);
    try {
      await api.post(`/v1/runs/${id}/${action}`);
      const next = await api.get<Run>(`/v1/runs/${id}`);
      setRun(next);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!run) return <div>{err ?? "loading…"}</div>;
  const terminal = TERMINAL.has(run.status);

  return (
    <>
      <div className="row">
        <h1>Run {run.id.slice(0, 8)}</h1>
        <span className={`tag ${run.status.toLowerCase()}`}>{run.status}</span>
        <div className="spacer" />
        {run.status === "RUNNING" && (
          <button className="ghost" onClick={() => control("pause")}>
            Pause
          </button>
        )}
        {run.status === "PAUSED" && <button onClick={() => control("resume")}>Resume</button>}
        {!terminal && (
          <button className="ghost danger" onClick={() => control("cancel")}>
            Cancel
          </button>
        )}
        {(run.status === "FAILED" || run.status === "CANCELLED") && (
          <button onClick={() => control("retry")}>Retry</button>
        )}
      </div>

      {err && <div className="problem">{err}</div>}

      <div className="card">
        <div className="row" style={{ gap: 24 }}>
          <Stat label="Workflow" value={run.workflow_id.slice(0, 8)} />
          <Stat label="Version" value={run.workflow_version_id.slice(0, 8)} />
          <Stat label="Nodes scheduled" value={String(run.node_count)} />
          <Stat
            label="Duration"
            value={
              run.ended_at
                ? `${((+new Date(run.ended_at) - +new Date(run.started_at)) / 1000).toFixed(1)}s`
                : "—"
            }
          />
        </div>
        {run.error_summary && (
          <div className="problem" style={{ marginTop: 12 }}>
            {run.error_summary}
          </div>
        )}
      </div>

      <h2>Trigger payload</h2>
      <pre className="code">{JSON.stringify(run.trigger_payload, null, 2)}</pre>

      <h2>Timeline</h2>
      <div className="card">
        <div className="timeline">
          {events.length === 0 && <div className="muted">no events yet…</div>}
          {grouped.map((row, i) =>
            row.kind === "run" ? (
              <div key={`r${i}`} className="ev" style={{ background: "#fafafa" }}>
                <span className="t">{new Date(row.occurred_at).toLocaleTimeString()}</span>
                <span className="k">{row.event_type}</span>
                {row.payload != null && (
                  <span className="muted"> · {JSON.stringify(row.payload)}</span>
                )}
              </div>
            ) : (
              <div key={`n${row.nodeId}-${i}`}>
                <div
                  className="ev"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleNode(row.nodeId)}
                  title="Click to inspect attempts"
                >
                  <span className="t">{new Date(row.firstAt).toLocaleTimeString()}</span>
                  <span className="k">{row.nodeId}</span>
                  <span className="muted"> · {row.summary}</span>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {expanded === row.nodeId ? "▼" : "▶"}
                  </span>
                </div>
                {expanded === row.nodeId && (
                  <AttemptsPanel items={attempts[row.nodeId]} loading={!attempts[row.nodeId]} />
                )}
              </div>
            ),
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="muted">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function AttemptsPanel({
  items,
  loading,
}: {
  items: Attempt[] | undefined;
  loading: boolean;
}): JSX.Element {
  if (loading || !items)
    return (
      <div className="muted" style={{ padding: "6px 0 12px 14px" }}>
        loading attempts…
      </div>
    );
  if (items.length === 0)
    return (
      <div className="muted" style={{ padding: "6px 0 12px 14px" }}>
        no attempts yet
      </div>
    );
  return (
    <div style={{ padding: "4px 0 14px 14px", borderLeft: "2px solid var(--line)", marginLeft: 6 }}>
      {items.map((a) => (
        <div
          key={a.attempt_number}
          style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)" }}
        >
          <div className="row" style={{ gap: 8 }}>
            <span className="muted">attempt #{a.attempt_number}</span>
            <span className={`tag ${a.status.toLowerCase()}`}>{a.status}</span>
            <span className="muted">{a.node_type}</span>
            <span className="muted">
              {new Date(a.started_at).toLocaleTimeString()}
              {a.ended_at ? ` → ${new Date(a.ended_at).toLocaleTimeString()}` : ""}
            </span>
          </div>
          {a.error_class && (
            <div className="problem" style={{ margin: "6px 0" }}>
              <strong>{a.error_class}</strong>
              {a.error_message ? `: ${a.error_message}` : ""}
            </div>
          )}
          {a.input_snapshot != null && (
            <details>
              <summary className="muted">input</summary>
              <pre className="code" style={{ maxHeight: 220 }}>
                {JSON.stringify(a.input_snapshot, null, 2)}
              </pre>
            </details>
          )}
          {a.output_snapshot != null && (
            <details>
              <summary className="muted">output</summary>
              <pre className="code" style={{ maxHeight: 220 }}>
                {JSON.stringify(a.output_snapshot, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

type GroupedRow =
  | { kind: "run"; occurred_at: string; event_type: string; payload: unknown }
  | { kind: "node"; nodeId: string; firstAt: string; summary: string };

function groupByNode(events: Event[]): GroupedRow[] {
  // Coalesce consecutive events that share a node_id into one expandable row.
  // Run-level events (RunStarted, RunSucceeded, …) remain as banners.
  const out: GroupedRow[] = [];
  const nodeBuckets = new Map<string, { firstAt: string; types: string[] }>();
  // First pass: collect all node events per node_id.
  for (const e of events) {
    const nid = e.payload?.node_id;
    if (typeof nid === "string") {
      const b = nodeBuckets.get(nid) ?? { firstAt: e.occurred_at, types: [] };
      b.types.push(e.event_type.replace(/^Node/, ""));
      nodeBuckets.set(nid, b);
    }
  }
  // Second pass: emit run events in order; emit a single node row at the
  // FIRST appearance of each node id.
  const emitted = new Set<string>();
  for (const e of events) {
    const nid = e.payload?.node_id;
    if (typeof nid === "string") {
      if (!emitted.has(nid)) {
        emitted.add(nid);
        const b = nodeBuckets.get(nid)!;
        out.push({ kind: "node", nodeId: nid, firstAt: b.firstAt, summary: b.types.join(" → ") });
      }
    } else {
      out.push({
        kind: "run",
        occurred_at: e.occurred_at,
        event_type: e.event_type,
        payload: e.payload,
      });
    }
  }
  return out;
}
