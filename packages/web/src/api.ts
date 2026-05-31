// Small fetch wrapper around the Flow API.
//
//  - Bearer-token auth from localStorage.
//  - On 401 with a refresh token, we transparently rotate via /v1/auth/refresh
//    and replay the original request ONCE.
//  - SSE helper streams events with the Authorization header (EventSource
//    can't set custom headers, so we do it ourselves on top of fetch).
const TOKEN_KEY = "conduit.access_token";
const REFRESH_KEY = "conduit.refresh_token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Record<string, unknown>,
  ) {
    super(String(problem.detail ?? problem.title ?? `HTTP ${status}`));
  }
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setRefreshToken(t: string | null): void {
  if (t) localStorage.setItem(REFRESH_KEY, t);
  else localStorage.removeItem(REFRESH_KEY);
}
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

// Coalesce concurrent refreshes: if 5 requests get 401 at once, we want ONE
// refresh roundtrip, not 5.
let refreshing: Promise<string | null> | null = null;
async function refreshOnce(): Promise<string | null> {
  if (refreshing) return refreshing;
  const r = getRefreshToken();
  if (!r) return null;
  refreshing = (async (): Promise<string | null> => {
    try {
      const res = await fetch("/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: r }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { access_token: string; refresh_token: string };
      setToken(j.access_token);
      setRefreshToken(j.refresh_token);
      return j.access_token;
    } catch {
      return null;
    } finally {
      // release the lock on next microtask
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && attempt === 0 && getRefreshToken()) {
    const fresh = await refreshOnce();
    if (fresh) return call<T>(method, path, body, attempt + 1);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data as Record<string, unknown>);
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>("GET", p),
  post: <T>(p: string, b?: unknown) => call<T>("POST", p, b),
  patch: <T>(p: string, b?: unknown) => call<T>("PATCH", p, b),
  del: <T>(p: string) => call<T>("DELETE", p),
};

// ── SSE ─────────────────────────────────────────────────────────
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Stream Server-Sent Events with bearer auth. We avoid EventSource because it
 * cannot set Authorization headers. Returns an abort handle.
 */
export function streamSse(
  path: string,
  onEvent: (e: SseEvent) => void,
  opts: { signal?: AbortSignal; onClose?: () => void; onError?: (err: unknown) => void } = {},
): () => void {
  const ac = new AbortController();
  const signal = opts.signal ? mergeSignals(opts.signal, ac.signal) : ac.signal;

  (async (): Promise<void> => {
    const t = getToken();
    try {
      const res = await fetch(path, {
        headers: {
          accept: "text/event-stream",
          ...(t ? { authorization: `Bearer ${t}` } : {}),
        },
        signal,
      });
      if (res.status === 401) {
        const fresh = await refreshOnce();
        if (fresh) return streamSseInternal(path, fresh, onEvent, signal, opts);
        opts.onError?.(new ApiError(401, { title: "Unauthorized" }));
        return;
      }
      if (!res.ok || !res.body) {
        opts.onError?.(new ApiError(res.status, { title: "stream failed" }));
        return;
      }
      await readSse(res.body, onEvent, signal);
      opts.onClose?.();
    } catch (err) {
      if (!signal.aborted) opts.onError?.(err);
    }
  })();

  return () => ac.abort();
}

async function streamSseInternal(
  path: string,
  token: string,
  onEvent: (e: SseEvent) => void,
  signal: AbortSignal,
  opts: { onClose?: () => void; onError?: (err: unknown) => void },
): Promise<void> {
  try {
    const res = await fetch(path, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok || !res.body) {
      opts.onError?.(new ApiError(res.status, { title: "stream failed" }));
      return;
    }
    await readSse(res.body, onEvent, signal);
    opts.onClose?.();
  } catch (err) {
    if (!signal.aborted) opts.onError?.(err);
  }
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // Events are separated by a blank line ("\n\n").
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      onEvent(parseSse(raw));
    }
  }
}

export function parseSse(raw: string): SseEvent {
  const out: SseEvent = { data: "" };
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const k = c < 0 ? line : line.slice(0, c);
    const v = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
    if (k === "data") out.data = out.data ? `${out.data}\n${v}` : v;
    else if (k === "event") out.event = v;
    else if (k === "id") out.id = v;
  }
  return out;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ac = new AbortController();
  const onA = (): void => ac.abort();
  const onB = (): void => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener("abort", onA, { once: true });
    b.addEventListener("abort", onB, { once: true });
  }
  return ac.signal;
}
