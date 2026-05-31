// Browser-safe re-exports. Anything that touches Node-only deps (pg, ioredis,
// pino, fs, etc.) must NOT be re-exported from here — it's how the web bundle
// pulls validation in via `@conduit/shared/schemas` without dragging the
// server runtime along.
export * from "./auth.js";
