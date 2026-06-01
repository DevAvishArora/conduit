import { httpRequest } from "./httpClient.js";
import { register } from "./registry.js";
import { FatalError, RetryableError, type ExecuteArgs, type NodeHandler } from "./types.js";

/**
 * HTTP_REQUEST connector (§6.6.2). Classifies failures for the retry policy:
 *   - timeout / network               -> RetryableError  (thrown by transport)
 *   - 429 / 5xx                       -> RetryableError
 *   - other 4xx                       -> FatalError (won't fix itself)
 * Sends the stable idempotency key as `Idempotency-Key` (review fix #1).
 */
class HttpRequestHandler implements NodeHandler {
  readonly typeId = "HTTP_REQUEST" as const;

  async execute(args: ExecuteArgs): Promise<Record<string, unknown>> {
    const c = args.config as {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    };

    const res = await httpRequest({
      method: c.method ?? "GET",
      url: c.url,
      headers: { ...(c.headers ?? {}), "idempotency-key": args.idempotencyKey },
      body: c.body,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
    });

    const output = { status_code: res.status, body: res.body, headers: res.headers };
    if (res.status === 429) throw new RetryableError("HTTP_429", `HTTP ${res.status}`, output);
    if (res.status >= 500) throw new RetryableError("HTTP_5XX", `HTTP ${res.status}`, output);
    if (res.status >= 400) throw new FatalError(`HTTP_4XX: ${res.status}`, output);
    return output;
  }
}

register(new HttpRequestHandler());
export { HttpRequestHandler };
