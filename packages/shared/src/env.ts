/**
 * Soft .env loader. Import this FIRST (config.ts does). It walks up from CWD to
 * find the repo-root .env, so it works whether a service is started from the
 * repo root or from its own package directory (pnpm --filter sets CWD there).
 *
 * Unlike Node's process.loadEnvFile (which overrides), this never clobbers a
 * variable already present in the environment — so compose-injected vars win
 * inside containers even if a .env was copied in.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function findRoot(): { envPath: string | null; root: string } {
  if (process.env.DOTENV_PATH)
    return { envPath: process.env.DOTENV_PATH, root: dirname(process.env.DOTENV_PATH) };
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".env"))) return { envPath: join(dir, ".env"), root: dir };
    // pnpm workspace marker as a fallback root
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return { envPath: null, root: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { envPath: null, root: process.cwd() };
}

const { envPath: path, root } = findRoot();
process.env.FLOW_REPO_ROOT = root;
if (path && existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    if (key in process.env) continue; // real env wins
    let val = m[2]!;
    if (/^#/.test(val)) continue;
    val = val.replace(/^["']|["']$/g, "");
    process.env[key] = val;
  }
}
