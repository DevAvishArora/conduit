import pg from "pg";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pg;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

// pg returns BIGINT/NUMERIC as strings by default to avoid precision loss.
// BIGINT ids (run_events.id) fit in JS safe integers at our volumes; parse them.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (_pool) return _pool;
  const cfg = loadConfig();
  _pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.PG_POOL_MAX,
    application_name: process.env.SERVICE_NAME ?? "flow",
  });
  _pool.on("error", (err) => logger.error({ err }, "pg pool error"));
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Thin query helper bound to a specific client (inside a transaction). */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

function wrap(client: PoolClient): Db {
  return {
    async query(text, params) {
      const res = await client.query(text, params as unknown[]);
      return { rows: res.rows as never[], rowCount: res.rowCount ?? 0 };
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction with `app.tenant_id` bound for the transaction
 * (SET LOCAL semantics via set_config(..., true)). Postgres RLS policies use
 * this GUC, so this is the *only* sanctioned way to touch tenant data from the
 * API plane (§7.2). Safe with PgBouncer transaction pooling.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("withTenant: invalid tenant id");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(wrap(client));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Control-plane / cross-tenant transaction. Sets `app.bypass=on` which the RLS
 * policies honour. ONLY for trusted infrastructure (scheduler reading all cron
 * triggers, login resolving a user by email before the tenant is known). These
 * paths must still filter by tenant_id explicitly in their SQL.
 */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.bypass', 'on', true)");
    const out = await fn(wrap(client));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
