import http, { type Server } from "node:http";
import { logger } from "./logger.js";
import { registry } from "./metrics.js";

/**
 * Minimal HTTP server exposing /metrics and /healthz on a single port. Each
 * service that isn't already an HTTP server (dispatcher, worker, scheduler)
 * boots one so Prometheus can scrape it.
 *
 * Honours METRICS_PORT (defaults to 0 = random) so multiple services on the
 * same host don't collide. The chosen port is logged at boot.
 */
export function startMetricsServer(port = Number(process.env.METRICS_PORT ?? 0)): Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"status":"ok"}`);
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // A metrics endpoint failing to bind must NEVER crash the service it runs in
  // — observability is best-effort. We log and degrade.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.warn({ port }, "metrics port in use; observability degraded for this instance");
    } else {
      logger.error({ err }, "metrics server error");
    }
  });
  server.listen(port, () => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    logger.info({ port: bound }, "metrics server listening");
  });
  return server;
}
