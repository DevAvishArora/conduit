import { loadConfig } from "./config.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateDek,
  unwrapDek,
  wrapDek,
} from "./crypto/envelope.js";
import { type Db, withTenant } from "./db/pool.js";
import { AppError } from "./errors.js";
import type { SecretResolver } from "./handlers/types.js";

/**
 * Per-tenant secrets with envelope encryption (§7.1.2). DEKs are cached in
 * memory with a short TTL (the doc's 15 min) so we don't unwrap on every call.
 */
const DEK_TTL_MS = 15 * 60 * 1000;
const dekCache = new Map<string, { dek: Buffer; exp: number }>();

async function getOrCreateDek(db: Db, tenantId: string): Promise<Buffer> {
  const cached = dekCache.get(tenantId);
  if (cached && cached.exp > Date.now()) return cached.dek;

  const cfg = loadConfig();
  const { rows } = await db.query<{ wrapped_dek: Buffer }>(
    "SELECT wrapped_dek FROM tenant_keys WHERE tenant_id = $1",
    [tenantId],
  );
  let dek: Buffer;
  if (rows.length > 0) {
    dek = unwrapDek(cfg.secretsRootKek, rows[0]!.wrapped_dek);
  } else {
    dek = generateDek();
    const wrapped = wrapDek(cfg.secretsRootKek, dek);
    // ON CONFLICT guards a race where two requests create the first secret.
    await db.query(
      `INSERT INTO tenant_keys (tenant_id, wrapped_dek) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, wrapped],
    );
    const re = await db.query<{ wrapped_dek: Buffer }>(
      "SELECT wrapped_dek FROM tenant_keys WHERE tenant_id = $1",
      [tenantId],
    );
    dek = unwrapDek(cfg.secretsRootKek, re.rows[0]!.wrapped_dek);
  }
  dekCache.set(tenantId, { dek, exp: Date.now() + DEK_TTL_MS });
  return dek;
}

/** Create or rotate a secret. */
export async function putSecret(tenantId: string, name: string, plaintext: string): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const dek = await getOrCreateDek(db, tenantId);
    const ciphertext = aesGcmEncrypt(dek, Buffer.from(plaintext, "utf8"));
    await db.query(
      `INSERT INTO secrets (tenant_id, name, ciphertext) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, created_at = now()`,
      [tenantId, name, ciphertext],
    );
  });
}

export async function listSecretNames(
  tenantId: string,
): Promise<{ name: string; created_at: string }[]> {
  return withTenant(tenantId, async (db) => {
    const { rows } = await db.query<{ name: string; created_at: string }>(
      "SELECT name, created_at FROM secrets ORDER BY name",
    );
    return rows;
  });
}

export async function deleteSecret(tenantId: string, name: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const { rowCount } = await db.query("DELETE FROM secrets WHERE name = $1", [name]);
    return rowCount > 0;
  });
}

async function resolveSecret(tenantId: string, name: string): Promise<string> {
  return withTenant(tenantId, async (db) => {
    const dek = await getOrCreateDek(db, tenantId);
    const { rows } = await db.query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM secrets WHERE name = $1",
      [name],
    );
    if (rows.length === 0)
      throw new AppError(422, "Unprocessable Entity", `secret not found: ${name}`);
    return aesGcmDecrypt(dek, rows[0]!.ciphertext).toString("utf8");
  });
}

/** A SecretResolver bound to one tenant, handed to connectors at execute time. */
export function secretResolver(tenantId: string): SecretResolver {
  return { get: (name) => resolveSecret(tenantId, name) };
}

/**
 * Encrypt/decrypt arbitrary bytes under a tenant's DEK — used for the webhook
 * HMAC secret stored on triggers (kept out of the named-secrets table).
 */
export async function encryptForTenant(tenantId: string, plaintext: string): Promise<Buffer> {
  return withTenant(tenantId, async (db) => {
    const dek = await getOrCreateDek(db, tenantId);
    return aesGcmEncrypt(dek, Buffer.from(plaintext, "utf8"));
  });
}

export async function decryptForTenant(tenantId: string, blob: Buffer): Promise<string> {
  return withTenant(tenantId, async (db) => {
    const dek = await getOrCreateDek(db, tenantId);
    return aesGcmDecrypt(dek, blob).toString("utf8");
  });
}

/** Test hook. */
export function _clearDekCache(): void {
  dekCache.clear();
}
