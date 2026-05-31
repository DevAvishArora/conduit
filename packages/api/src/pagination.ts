import { badRequest } from "@conduit/shared";

/** Opaque keyset cursor over (timestamp, uuid) — stable under inserts. */
export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const [ts, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!ts || !id) throw badRequest("invalid cursor");
  return { ts, id };
}

export function parseLimit(raw: unknown, def = 50, max = 200): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit must be 1..${max}`);
  return n;
}
