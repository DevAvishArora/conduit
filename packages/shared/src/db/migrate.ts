/**
 * Minimal forward-only migration runner. Applies migrations/*.sql in lexical
 * order inside a transaction each, tracked in schema_migrations. Runs as the
 * table OWNER (DATABASE_ADMIN_URL) — RLS does not apply to the owner, which is
 * what we want for DDL. The running services connect as the non-owner app role.
 *
 *   tsx migrate.ts up      apply pending migrations
 *   tsx migrate.ts down    DROP & recreate schema public (dev reset only!)
 */
import "../env.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, "../../../../migrations");

function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
  return url;
}

export interface RunOpts {
  connectionString?: string;
  migrationsDir?: string;
}

/** Apply pending migrations. Safe to call repeatedly. Returns count applied. */
export async function runMigrations(opts: RunOpts = {}): Promise<number> {
  const cn = opts.connectionString ?? adminUrl();
  const dir = opts.migrationsDir
    ? isAbsolute(opts.migrationsDir)
      ? opts.migrationsDir
      : resolve(process.cwd(), opts.migrationsDir)
    : DEFAULT_MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString: cn });
  await client.connect();
  let applied = 0;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const have = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (have.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      process.stdout.write(`▶ applying ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied++;
        process.stdout.write("ok\n");
      } catch (err) {
        await client.query("ROLLBACK");
        process.stdout.write("FAILED\n");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Drop and recreate `public` — dev convenience only. */
export async function resetSchema(opts: RunOpts = {}): Promise<void> {
  const cn = opts.connectionString ?? adminUrl();
  const client = new pg.Client({ connectionString: cn });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const hasAppRole =
      (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'flow_app'")).rowCount ?? 0;
    if (hasAppRole > 0) {
      await client.query("GRANT USAGE ON SCHEMA public TO flow_app");
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flow_app`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO flow_app`);
    }
  } finally {
    await client.end();
  }
}

// CLI entry — invoked when run as a script (tsx packages/shared/src/db/migrate.ts).
const isCli =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/db/migrate.ts");
if (isCli) {
  const cmd = process.argv[2] ?? "up";
  (cmd === "down"
    ? resetSchema().then(() => process.stdout.write("schema reset\n"))
    : runMigrations().then(() => process.stdout.write("migrations up to date\n"))
  ).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
