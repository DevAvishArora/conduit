import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { loadConfig, logger, metricsRegistry, pool, redis } from "@conduit/shared";
import type { AuthedRequest } from "./http.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { metricsMiddleware } from "./middleware/metrics.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { oauthRouter } from "./routes/oauth.js";
import { runsRouter } from "./routes/runs.js";
import { secretsRouter } from "./routes/secrets.js";
import { tenantRouter } from "./routes/tenant.js";
import { triggerDeleteRouter, triggersRouter, webhookRouter } from "./routes/triggers.js";
import { workflowsRouter } from "./routes/workflows.js";

export function buildApp(): Express {
  const cfg = loadConfig();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(helmet());

  // CORS: explicit allow-list from CORS_ORIGINS. Empty list = no cross-origin
  // requests allowed (server-to-server or same-origin only). A wildcard `*`
  // entry is honoured (dev-only) but logged as a warning.
  if (cfg.CORS_ORIGINS.includes("*")) {
    logger.warn("CORS configured with '*' — only safe in development");
    app.use(cors({ origin: true, credentials: false }));
  } else {
    app.use(
      cors({
        origin: cfg.CORS_ORIGINS.length === 0 ? false : cfg.CORS_ORIGINS,
        credentials: true,
      }),
    );
  }

  // Capture the raw body for webhook HMAC verification while still parsing JSON
  // for everything else. 1 MB request cap (§5.3.1).
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as AuthedRequest).rawBody = buf;
      },
    }),
  );

  // request-scoped child logger
  app.use((req, _res, next) => {
    (req as AuthedRequest & { log?: unknown }).log = logger.child({ path: req.path });
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // Real readiness: probe Postgres + Redis with short timeouts. Returns 503 if
  // either dep is unreachable so orchestrators can stop sending traffic.
  app.get("/readyz", async (_req, res) => {
    const checks = await Promise.allSettled([
      Promise.race([
        pool().query("SELECT 1"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("pg timeout")), 1500)),
      ]),
      Promise.race([
        redis().ping(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("redis timeout")), 1500)),
      ]),
    ]);
    const [pg, rd] = checks;
    const ok = pg.status === "fulfilled" && rd.status === "fulfilled";
    res.status(ok ? 200 : 503).json({
      status: ok ? "ready" : "not-ready",
      postgres: pg.status === "fulfilled" ? "ok" : ((pg.reason as Error)?.message ?? "fail"),
      redis: rd.status === "fulfilled" ? "ok" : ((rd.reason as Error)?.message ?? "fail"),
    });
  });

  // Prometheus scrape endpoint. Gated by METRICS_ENABLED (default on) AND, if
  // METRICS_TOKEN is set, requires `Authorization: Bearer <token>` so it can
  // be safely exposed via the public load balancer instead of relying on a
  // private network policy.
  if (cfg.METRICS_ENABLED) {
    app.get("/metrics", async (req, res) => {
      if (cfg.METRICS_TOKEN) {
        const hdr = req.headers.authorization;
        if (hdr !== `Bearer ${cfg.METRICS_TOKEN}`) {
          res.status(401).end();
          return;
        }
      }
      res.setHeader("content-type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    });
  }

  app.use(metricsMiddleware);

  // ── public ──────────────────────────────────────────────────
  // OAuth FIRST so its more-specific prefix wins (otherwise /v1/auth catches
  // it first and rate-limits the request twice before falling through).
  app.use("/v1/auth/oauth", rateLimit({ bucket: "oauth", limit: 30, windowSec: 60 }), oauthRouter);
  app.use("/v1/auth", rateLimit({ bucket: "auth", limit: 30, windowSec: 60 }), authRouter);
  // Webhook ingress is unauthenticated (HMAC-secured) — mounted before authn.
  app.use(
    "/v1/triggers",
    rateLimit({ bucket: "webhook", limit: 600, windowSec: 60 }),
    webhookRouter,
  );

  // ── authenticated ───────────────────────────────────────────
  app.use("/v1", authenticate, rateLimit({ bucket: "api", limit: 300, windowSec: 60 }));

  // Most-specific first: trigger-attach is nested under a workflow.
  app.use("/v1/workflows/:id/triggers", triggersRouter); // mergeParams -> sees :id
  app.use("/v1/workflows", workflowsRouter);
  app.use("/v1/triggers", triggerDeleteRouter);
  app.use("/v1/runs", runsRouter);
  app.use("/v1/secrets", secretsRouter);
  app.use("/v1/audit", auditRouter);
  app.use("/v1/tenant", tenantRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
