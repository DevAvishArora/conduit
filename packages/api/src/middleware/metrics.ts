import type { NextFunction, Request, Response } from "express";
import { metrics } from "@conduit/shared";

/**
 * Per-request instrumentation. `req.route?.path` is the route TEMPLATE (e.g.
 * `/v1/workflows/:id`), so the cardinality stays bounded — using `req.path`
 * would explode with one label per UUID.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? req.baseUrl ?? "unknown";
    const status = String(res.statusCode);
    metrics.httpRequests.inc({ method: req.method, route, status });
    metrics.httpRequestDuration.observe({ method: req.method, route, status }, dur);
  });
  next();
}
