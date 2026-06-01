/**
 * End-to-end integration test against real Postgres + Redis containers.
 *
 *   pnpm test:integration
 *
 * Skipped automatically when INTEGRATION=1 isn't set, so the unit-only
 * `pnpm test` stays fast and Docker-free.
 *
 * What it proves:
 *   - Migrations run against a fresh Postgres
 *   - The API plane accepts auth, creates a workflow, publishes, attaches a
 *     webhook, and verifies HMAC signatures
 *   - The dispatcher's RunStart handler transitions PENDING → RUNNING and
 *     enqueues the first real node
 *   - The worker's processTask consumes the task, executes the CONDITION
 *     handler, persists a SUCCEEDED node_attempt, and emits NodeCompleted
 *   - The dispatcher's NodeCompleted handler finalizes the run as SUCCEEDED
 */
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const RUN_IT = process.env.INTEGRATION === "1";

describe.skipIf(!RUN_IT)("engine e2e (real Postgres + Redis)", () => {
  let pg: StartedPostgreSqlContainer;
  let rd: StartedRedisContainer;
  let request: ReturnType<typeof supertest>;
  let dispatcher: typeof import("../../packages/dispatcher/src/ops.js");
  let worker: typeof import("../../packages/worker/src/loop.js");
  let shared: typeof import("../../packages/shared/src/index.js");

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("flow")
      .withUsername("flow")
      .withPassword("flow")
      .start();
    rd = await new RedisContainer("redis:7-alpine").start();

    // JWT keypair into a throwaway temp dir, env wired up to point at containers.
    const tmp = mkdtempSync(join(tmpdir(), "flow-it-"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(join(tmp, "priv.pem"), privateKey);
    writeFileSync(join(tmp, "pub.pem"), publicKey);

    const url = (port: number, db = "") =>
      `postgres://flow:flow@${pg.getHost()}:${pg.getMappedPort(5432)}${db ? `/${db}` : "/flow"}`;
    process.env.DATABASE_URL = url(0);
    process.env.DATABASE_ADMIN_URL = url(0);
    process.env.REDIS_URL = `redis://${rd.getHost()}:${rd.getMappedPort(6379)}`;
    process.env.JWT_PRIVATE_KEY_PATH = join(tmp, "priv.pem");
    process.env.JWT_PUBLIC_KEY_PATH = join(tmp, "pub.pem");
    process.env.SECRETS_ROOT_KEK = Buffer.alloc(32, 7).toString("base64");
    process.env.FLOW_REPO_ROOT = REPO_ROOT;
    process.env.PUBLIC_BASE_URL = "http://localhost:0";
    process.env.SERVICE_NAME = "integration";

    // Now load modules (config is memoised; env must be set first).
    shared = await import("../../packages/shared/src/index.js");
    const { runMigrations } = await import("../../packages/shared/src/db/migrate.js");
    await runMigrations({
      connectionString: process.env.DATABASE_URL,
      migrationsDir: join(REPO_ROOT, "migrations"),
    });

    // Tests connect as the table owner (we didn't create flow_app in this
    // ephemeral container); RLS still applies if app.tenant_id is set, which
    // withTenant always does for tenant-scoped paths.
    // Boot the API in-process and reach it via supertest.
    const { buildApp } = await import("../../packages/api/src/app.js");
    request = supertest(buildApp());

    // Wire up engine handlers (in-process) and ensure consumer groups exist.
    dispatcher = await import("../../packages/dispatcher/src/ops.js");
    worker = await import("../../packages/worker/src/loop.js");
    await import("../../packages/shared/src/handlers/index.js"); // side-effect register
    const q = shared.queues(shared.redis());
    await q.runStart.ensureGroup();
    await q.nodeTasks.ensureGroup();
    await q.nodeCompleted.ensureGroup();
  }, 120_000);

  afterAll(async () => {
    await shared?.closeRedis().catch(() => {});
    await shared?.closePool().catch(() => {});
    await rd?.stop();
    await pg?.stop();
  }, 60_000);

  it("registers, publishes a workflow, fires a webhook, and runs to SUCCEEDED", async () => {
    // ── 1. register a tenant + admin ─────────────────────────
    const reg = await request
      .post("/v1/auth/register")
      .send({ email: "it@flow.test", password: "password123", tenant_name: "IT" })
      .expect(201);
    const token = reg.body.access_token as string;
    const bearer = `Bearer ${token}`;

    // ── 2. create + publish a workflow that needs NO external HTTP ───
    const definition = {
      schema_version: "1.0",
      name: "it-demo",
      start_node: "in",
      nodes: {
        in: { type: "TRIGGER_INPUT", next: "check" },
        check: {
          type: "CONDITION",
          condition: { left: "{{trigger.payload.priority}}", op: "eq", right: "high" },
          next_true: null,
          next_false: null,
        },
      },
    };
    const wf = await request
      .post("/v1/workflows")
      .set("authorization", bearer)
      .send({ name: definition.name, definition })
      .expect(201);
    const wid = wf.body.id as string;
    await request.post(`/v1/workflows/${wid}/publish`).set("authorization", bearer).expect(201);

    // ── 3. attach a webhook trigger ──────────────────────────
    const trg = await request
      .post(`/v1/workflows/${wid}/triggers`)
      .set("authorization", bearer)
      .send({ type: "webhook" })
      .expect(201);
    const trgId = trg.body.id as string;
    const secret = trg.body.secret_shown_once as string;

    // ── 4. fire it with a valid signature ────────────────────
    const body = JSON.stringify({ priority: "high", title: "it-test" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const fire = await request
      .post(`/v1/triggers/webhook/${trgId}`)
      .set("content-type", "application/json")
      .set("x-flow-signature", sig)
      .set("x-flow-delivery-id", randomUUID())
      .send(body)
      .expect(202);
    const runId = fire.body.run_id as string;

    // ── 5. drive the engine in-process to drain the streams ──
    await driveEngineUntilTerminal(runId, dispatcher, worker, shared);

    // ── 6. final run state ──────────────────────────────────
    const final = await request.get(`/v1/runs/${runId}`).set("authorization", bearer).expect(200);
    expect(final.body.status).toBe("SUCCEEDED");

    const events = await request
      .get(`/v1/runs/${runId}/events`)
      .set("authorization", bearer)
      .expect(200);
    const types = (events.body.items as { event_type: string }[]).map((e) => e.event_type);
    expect(types).toContain("RunStarted");
    expect(types).toContain("NodeStarted");
    expect(types).toContain("NodeCompleted");
    expect(types).toContain("RunSucceeded");

    const attempts = await request
      .get(`/v1/runs/${runId}/nodes/check/attempts`)
      .set("authorization", bearer)
      .expect(200);
    expect(attempts.body.items).toHaveLength(1);
    expect(attempts.body.items[0].status).toBe("SUCCEEDED");
  }, 60_000);
});

/**
 * Small drain loop — pumps each stream into its handler until the run reaches
 * a terminal status. Mirrors the dispatcher/worker main loops but synchronous.
 */
async function driveEngineUntilTerminal(
  runId: string,
  dispatcher: typeof import("../../packages/dispatcher/src/ops.js"),
  worker: typeof import("../../packages/worker/src/loop.js"),
  shared: typeof import("../../packages/shared/src/index.js"),
): Promise<void> {
  const r = shared.redis();
  const q = shared.queues(r);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const startMsgs = await q.runStart.consume("test-disp", { count: 5, blockMs: 200 });
    for (const m of startMsgs) {
      await dispatcher.handleRunStart(m.body.run_id, m.body.tenant_id);
      await q.runStart.ack(m.id);
    }
    const taskMsgs = await q.nodeTasks.consume("test-worker", { count: 5, blockMs: 200 });
    for (const m of taskMsgs) {
      await worker.processTask(m.body);
      await q.nodeTasks.ack(m.id);
    }
    const compMsgs = await q.nodeCompleted.consume("test-disp", { count: 5, blockMs: 200 });
    for (const m of compMsgs) {
      await dispatcher.handleNodeCompleted(m.body);
      await q.nodeCompleted.ack(m.id);
    }

    // Check terminal status via direct query — we can't use withTenant here
    // without knowing the tenant; use withSystem which all engine code uses.
    const status = await shared.withSystem(async (db) => {
      const { rows } = await db.query<{ status: string }>("SELECT status FROM runs WHERE id = $1", [
        runId,
      ]);
      return rows[0]?.status;
    });
    if (status && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status)) return;
  }
  throw new Error("integration test timed out waiting for terminal status");
}
