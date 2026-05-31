import http from "node:http";
import https from "node:https";
import { loadConfig } from "../config.js";
import { assertUrlAllowed, SsrfBlockedError, validatingLookup } from "./ssrf.js";
import { FatalError, RetryableError } from "./types.js";

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

export interface HttpRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * SSRF-guarded HTTP transport shared by the HTTP_REQUEST and NOTIFY connectors.
 * Throws RetryableError for transport faults (timeout/network) and FatalError
 * for blocked egress; returns the response (incl. 4xx/5xx) otherwise so the
 * caller classifies status codes per its own policy.
 */
export function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const cfg = loadConfig();
  let url: URL;
  try {
    url = assertUrlAllowed(opts.url, cfg.EGRESS_ALLOWLIST);
  } catch (err) {
    if (err instanceof SsrfBlockedError) return Promise.reject(new FatalError(err.message));
    return Promise.reject(err);
  }

  const lib = url.protocol === "https:" ? https : http;
  const isJson = opts.body !== undefined && typeof opts.body !== "string";
  const bodyBuf =
    opts.body === undefined
      ? undefined
      : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));

  const headers: Record<string, string> = {
    "user-agent": "flow-worker/1.0",
    ...(isJson ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  if (bodyBuf) headers["content-length"] = String(bodyBuf.length);

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: (opts.method ?? "GET").toUpperCase(),
        headers,
        timeout: opts.timeoutMs,
        lookup: validatingLookup(cfg.EGRESS_BLOCK_PRIVATE_IPS),
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: tryJson(raw), headers: res.headers });
        });
      },
    );
    req.on("timeout", () => req.destroy(new RetryableError("TIMEOUT", "request timed out")));
    req.on("error", (err) => {
      if (err instanceof RetryableError || err instanceof FatalError) return reject(err);
      if (err instanceof SsrfBlockedError) return reject(new FatalError(err.message));
      if ((err as { name?: string }).name === "AbortError")
        return reject(new RetryableError("TIMEOUT", "aborted"));
      reject(new RetryableError("NETWORK_ERROR", err.message));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function tryJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
