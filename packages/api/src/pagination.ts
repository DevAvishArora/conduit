import { badRequest } from "@conduit/shared";

/**
 * Opaque keyset cursor over (timestamp, uuid) — stable under inserts.
 *
 * Encoded form is `base64url(<ts>|<id>)`. The pipe delimiter is safe because
 * ISO-8601 timestamps and UUIDs never contain `|`. Length-bounded so a hostile
 * client can't ship a multi-megabyte cursor.
 */
export interface Cursor {
  ts: string;
  id: string;
}

const MAX_RAW = 256;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  if (raw.length > MAX_RAW) throw badRequest("invalid cursor");
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw badRequest("invalid cursor");
  }
  const parts = decoded.split("|");
  // Reject anything that isn't exactly two non-empty parts — guards against
  // truncation, multiple delimiters, or empty halves slipping through.
  if (parts.length !== 2) throw badRequest("invalid cursor");
  const [ts, id] = parts;
  if (!ts || !id) throw badRequest("invalid cursor");
  return { ts, id };
}

export function parseLimit(raw: unknown, def = 50, max = 200): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit must be 1..${max}`);
  return n;
}
