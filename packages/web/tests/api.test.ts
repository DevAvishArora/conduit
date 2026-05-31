import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  getRefreshToken,
  getToken,
  parseSse,
  setRefreshToken,
  setToken,
} from "../src/api";

describe("parseSse", () => {
  it("parses a complete event with id + event + data", () => {
    const raw = 'id: 7\nevent: NodeStarted\ndata: {"node":"a"}';
    const ev = parseSse(raw);
    expect(ev.id).toBe("7");
    expect(ev.event).toBe("NodeStarted");
    expect(ev.data).toBe('{"node":"a"}');
  });

  it("concatenates multi-line data fields with newlines", () => {
    const raw = "data: line1\ndata: line2";
    const ev = parseSse(raw);
    expect(ev.data).toBe("line1\nline2");
  });

  it("strips a single leading space after the colon", () => {
    const ev = parseSse("data: hello");
    expect(ev.data).toBe("hello");
  });

  it("ignores comment lines that start with `:`", () => {
    const ev = parseSse(": keep-alive heartbeat\nevent: ping\ndata: {}");
    expect(ev.event).toBe("ping");
    expect(ev.data).toBe("{}");
  });

  it("ignores unknown fields silently", () => {
    const ev = parseSse("retry: 5000\ndata: ok");
    expect(ev.data).toBe("ok");
  });

  it("returns empty data when none provided", () => {
    const ev = parseSse("event: just-an-event");
    expect(ev.data).toBe("");
    expect(ev.event).toBe("just-an-event");
  });
});

describe("token storage", () => {
  beforeEach(() => localStorage.clear());

  it("setToken / getToken round-trip", () => {
    setToken("abc.def");
    expect(getToken()).toBe("abc.def");
  });
  it("setToken(null) removes the entry", () => {
    setToken("a");
    setToken(null);
    expect(getToken()).toBeNull();
  });
  it("refresh token storage is independent of access token", () => {
    setToken("access");
    setRefreshToken("refresh");
    expect(getToken()).toBe("access");
    expect(getRefreshToken()).toBe("refresh");
    setToken(null);
    expect(getRefreshToken()).toBe("refresh");
  });
});

describe("api fetch wrapper", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("sends Authorization when a token is present", async () => {
    setToken("tok");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await api.get("/x");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("throws an ApiError on non-2xx with the problem JSON", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: "Bad Request", detail: "nope" }), {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        }),
    ) as unknown as typeof fetch;
    await expect(api.get("/x")).rejects.toBeInstanceOf(ApiError);
    try {
      await api.get("/x");
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("nope");
    }
  });

  it("returns undefined on 204 No Content", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const r = await api.del("/x");
    expect(r).toBeUndefined();
  });

  it("auto-refreshes once on 401 when a refresh token is present, then replays", async () => {
    setToken("expired");
    setRefreshToken("ref");
    let nthCall = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      nthCall++;
      // 1st call → original path returns 401
      if (nthCall === 1) {
        return new Response(JSON.stringify({ title: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      // 2nd call → refresh endpoint returns new tokens
      if (nthCall === 2 && url.endsWith("/v1/auth/refresh")) {
        return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "ref2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // 3rd call → original path replayed with new token
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = (await api.get<{ ok: boolean }>("/v1/secrets"))!;
    expect(res.ok).toBe(true);
    expect(getToken()).toBe("fresh");
    expect(getRefreshToken()).toBe("ref2");
  });

  it("does NOT refresh when there is no refresh token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(api.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
  });
});
