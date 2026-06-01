import "./env.js"; // soft-load .env before reading process.env
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * Centralised, validated configuration. Fail fast at boot if the environment
 * is misconfigured rather than discovering it on the first request.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number(v)))
    .pipe(z.number().int());

const Schema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),

  API_PORT: int(8080),
  PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),

  DATABASE_URL: z.string(),
  DATABASE_ADMIN_URL: z.string().optional(),
  PG_POOL_MAX: int(10),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_PRIVATE_KEY_PATH: z.string().default("keys/jwt_private.pem"),
  JWT_PUBLIC_KEY_PATH: z.string().default("keys/jwt_public.pem"),
  JWT_ALG: z.enum(["RS256", "EdDSA"]).default("RS256"),
  ACCESS_TOKEN_TTL_SECONDS: int(3600),
  REFRESH_TOKEN_TTL_SECONDS: int(2592000),

  SECRETS_ROOT_KEK: z.string(),

  WEBHOOK_REPLAY_WINDOW_SECONDS: int(300),
  WEBHOOK_NONCE_TTL_SECONDS: int(300),

  WORKER_CONCURRENCY: int(10),
  WORKER_LEASE_MS: int(60000),
  NODE_DEFAULT_TIMEOUT_MS: int(30000),
  RUN_MAX_NODES: int(1000),
  RETRY_BASE_MS: int(1000),
  RETRY_MAX_MS: int(60000),

  SCHEDULER_LEASE_TTL_MS: int(30000),
  SCHEDULER_RENEW_INTERVAL_MS: int(10000),

  EGRESS_BLOCK_PRIVATE_IPS: bool(true),
  EGRESS_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  // Google OAuth — optional. If client id/secret aren't set, the OAuth routes
  // return 503 with a clear message instead of crashing at boot, so the app
  // still runs in demo mode without Google credentials.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Must EXACTLY match an "Authorized redirect URI" in the Google Cloud console.
  GOOGLE_REDIRECT_URI: z.string().optional(),
  // Origin where the React app lives — the API redirects here with tokens in
  // the URL fragment after OAuth. In prod, often the same origin as the API.
  WEB_BASE_URL: z.string().default("http://localhost:5173"),

  // CORS allowed origins. Comma-separated list. Empty/unset = same-origin only.
  // Use `*` ONLY in dev — disables credentials in browsers and weakens auth.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  // /metrics endpoint protection. METRICS_ENABLED=false (or 0) disables it
  // entirely. METRICS_TOKEN, if set, requires `Authorization: Bearer <token>`
  // on every /metrics request (defence-in-depth on top of network policy).
  METRICS_ENABLED: bool(true),
  METRICS_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof Schema> & {
  jwtPrivateKey: string;
  jwtPublicKey: string;
  secretsRootKek: Buffer;
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = Schema.parse(process.env);

  // Key material is read lazily so non-auth services (worker/dispatcher) can
  // run without the keypair present, but the API will fail fast if missing.
  const root = process.env.FLOW_REPO_ROOT ?? process.cwd();
  const readKey = (p: string): string => {
    const abs = isAbsolute(p) ? p : join(root, p);
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return "";
    }
  };

  cached = {
    ...parsed,
    jwtPrivateKey: readKey(parsed.JWT_PRIVATE_KEY_PATH),
    jwtPublicKey: readKey(parsed.JWT_PUBLIC_KEY_PATH),
    secretsRootKek: Buffer.from(parsed.SECRETS_ROOT_KEK, "base64"),
  };

  if (cached.secretsRootKek.length !== 32) {
    throw new Error(
      `SECRETS_ROOT_KEK must decode to 32 bytes, got ${cached.secretsRootKek.length}`,
    );
  }
  return cached;
}

/** Test-only: reset memoised config. */
export function _resetConfig(): void {
  cached = null;
}
