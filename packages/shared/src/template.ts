/**
 * Tiny, dependency-free templating for node configs.
 *
 *   "{{trigger.payload.title}}"            -> resolves the raw value
 *   "PR: {{trigger.payload.title}} (#{{n}})" -> string interpolation
 *
 * This is a *reader* only — no code execution, no function calls — so it can't
 * be an injection vector the way an eval-based DSL would be.
 */
const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function getPath(root: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1") // a[0].b -> a.0.b
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Render a single string. If it is exactly one token, return the raw value. */
export function render(tpl: string, ctx: Record<string, unknown>): unknown {
  const whole = tpl.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (whole) return getPath(ctx, whole[1]!);
  return tpl.replace(TOKEN, (_m, path: string) => {
    const v = getPath(ctx, path.trim());
    if (v == null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Recursively render every string in a value. */
export function renderDeep(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === "string") return render(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx);
    return out;
  }
  return value;
}
