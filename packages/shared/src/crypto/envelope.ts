import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for tenant secrets (§7.1.2).
 *
 *   plaintext --AES-256-GCM(DEK)--> ciphertext     (stored in secrets.ciphertext)
 *   DEK       --AES-256-GCM(KEK)--> wrapped DEK     (stored in tenant_keys)
 *
 * The KEK ("root" key) lives in KMS in production (here: SECRETS_ROOT_KEK env).
 * One DEK per tenant limits blast radius and enables per-tenant key rotation.
 * Wire format for both layers: [12-byte IV][16-byte GCM tag][ciphertext].
 */
const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function aesGcmDecrypt(key: Buffer, blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export const wrapDek = (kek: Buffer, dek: Buffer): Buffer => aesGcmEncrypt(kek, dek);
export const unwrapDek = (kek: Buffer, wrapped: Buffer): Buffer => aesGcmDecrypt(kek, wrapped);
