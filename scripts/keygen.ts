/**
 * Generate the JWT signing keypair (RS256) into ./keys. Idempotent-ish: it
 * overwrites, so re-running invalidates existing tokens.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("keys", { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
writeFileSync("keys/jwt_private.pem", privateKey, { mode: 0o600 });
writeFileSync("keys/jwt_public.pem", publicKey);
process.stdout.write("wrote keys/jwt_private.pem and keys/jwt_public.pem\n");
