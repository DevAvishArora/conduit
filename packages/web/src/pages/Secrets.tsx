import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

interface Secret {
  name: string;
  created_at: string;
}

export function Secrets(): JSX.Element {
  const [items, setItems] = useState<Secret[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  async function refresh(): Promise<void> {
    try {
      const r = await api.get<{ items: Secret[] }>("/v1/secrets");
      setItems(r.items);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  useEffect(() => void refresh(), []);

  async function put(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      await api.post("/v1/secrets", { name, value });
      setName("");
      setValue("");
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  async function del(n: string): Promise<void> {
    if (!confirm(`Delete secret ${n}?`)) return;
    try {
      await api.del(`/v1/secrets/${n}`);
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      <h1>Secrets</h1>
      <p className="muted">
        Values are write-only — once stored they&apos;re encrypted and never returned by the API.
      </p>
      {err && <div className="problem">{err}</div>}
      <div className="card">
        <form onSubmit={put}>
          <div className="row" style={{ gap: 8 }}>
            <input
              placeholder="name (alnum, ., _, -)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              pattern="[a-zA-Z0-9_.\-]+"
              style={{ width: 180 }}
            />
            <input
              placeholder="value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              type="password"
              style={{ flex: 1 }}
            />
            <button>Save</button>
          </div>
        </form>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items?.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="muted">{new Date(s.created_at).toLocaleString()}</td>
                <td style={{ width: 80 }}>
                  <button className="ghost danger" onClick={() => del(s.name)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {items && items.length === 0 && (
              <tr>
                <td colSpan={3} className="muted" style={{ textAlign: "center", padding: 18 }}>
                  No secrets.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
