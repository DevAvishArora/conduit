/**
 * Demo seed: registers a tenant, stores a Slack-style secret, creates and
 * publishes a sample CONDITION → NOTIFY workflow, attaches a webhook trigger,
 * and prints a ready-to-run curl that fires it with a valid HMAC signature.
 *
 *   pnpm seed
 */
import { createHmac } from "node:crypto";

const BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
const EMAIL = process.env.SEED_EMAIL ?? "demo@flow.dev";
const PASSWORD = process.env.SEED_PASSWORD ?? "password123";
const TENANT = process.env.SEED_TENANT ?? "Demo";

interface Tokens {
  access_token: string;
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data as T;
}

async function login(): Promise<string> {
  try {
    return (await call<Tokens>("POST", "/v1/auth/login", { email: EMAIL, password: PASSWORD }))
      .access_token;
  } catch {
    return (
      await call<Tokens>("POST", "/v1/auth/register", {
        email: EMAIL,
        password: PASSWORD,
        tenant_name: TENANT,
      })
    ).access_token;
  }
}

const definition = {
  schema_version: "1.0",
  name: "demo-on-call-router",
  start_node: "in",
  nodes: {
    in: { type: "TRIGGER_INPUT", next: "is_critical" },
    is_critical: {
      type: "CONDITION",
      condition: { left: "{{trigger.payload.priority}}", op: "eq", right: "critical" },
      next_true: "page_oncall",
      next_false: "log_only",
    },
    page_oncall: {
      type: "NOTIFY",
      channel: "slack",
      config: {
        webhook_url_secret: "slack_hook",
        message: "🚨 Critical: {{trigger.payload.title}}",
      },
      next: null,
    },
    log_only: {
      type: "HTTP_REQUEST",
      config: {
        method: "POST",
        url: "https://httpbin.org/anything",
        body: { logged: "{{trigger.payload.title}}" },
      },
      next: null,
    },
  },
};

async function main(): Promise<void> {
  const token = await login();
  console.log(`✓ logged in as ${EMAIL}`);

  await call(
    "POST",
    "/v1/secrets",
    { name: "slack_hook", value: "https://httpbin.org/post" },
    token,
  );
  console.log("✓ stored secret slack_hook");

  let wfId: string;
  try {
    const w = await call<{ id: string }>(
      "POST",
      "/v1/workflows",
      { name: definition.name, definition },
      token,
    );
    wfId = w.id;
    console.log(`✓ created workflow ${wfId}`);
  } catch {
    // already exists — fetch it
    const list = await call<{ items: { id: string; name: string }[] }>(
      "GET",
      "/v1/workflows",
      undefined,
      token,
    );
    wfId = list.items.find((w) => w.name === definition.name)!.id;
    await call("PATCH", `/v1/workflows/${wfId}`, { definition }, token);
    console.log(`✓ updated existing workflow ${wfId}`);
  }

  const pub = await call<{ version_number: number }>(
    "POST",
    `/v1/workflows/${wfId}/publish`,
    {},
    token,
  );
  console.log(`✓ published v${pub.version_number}`);

  const trg = await call<{ id: string; webhook_url: string; secret_shown_once: string }>(
    "POST",
    `/v1/workflows/${wfId}/triggers`,
    { type: "webhook" },
    token,
  );
  console.log(`✓ webhook trigger: ${trg.webhook_url}`);

  const body = JSON.stringify({ priority: "critical", title: "Prod is on fire" });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac("sha256", trg.secret_shown_once).update(`${ts}.${body}`).digest("hex")}`;

  console.log("\nFire it (signature valid for the next ~5 min):\n");
  console.log(
    `  curl -X POST ${trg.webhook_url} \\\n` +
      `    -H 'content-type: application/json' \\\n` +
      `    -H "x-flow-signature: ${sig}" \\\n` +
      `    -H 'x-flow-delivery-id: $(uuidgen)' \\\n` +
      `    -d '${body}'\n`,
  );
  console.log(`Or open the UI:  http://localhost:5173  (sign in as ${EMAIL} / ${PASSWORD})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
