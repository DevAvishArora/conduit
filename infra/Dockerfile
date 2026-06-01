# ─────────────────────────────────────────────────────────────────────────────
# Single image for all Node services (api/dispatcher/worker/scheduler).
# Selected at runtime by the compose `command:` (pnpm --filter ...).
# ─────────────────────────────────────────────────────────────────────────────
# We deliberately keep tsx as the runtime: the test path imports `.ts` sources
# directly, and a per-package tsc build (with cross-workspace imports and ESM
# extension rewriting) adds operational complexity we don't currently need.
# What this multi-stage layout buys us:
#   1) deps layer cached on the lockfile alone (fast rebuilds on code change)
#   2) build stage verifies typecheck + lint + format BEFORE we ship anything
#   3) runtime stage drops dev deps + runs as non-root with a HEALTHCHECK
# ─────────────────────────────────────────────────────────────────────────────

# ── 1. base: pnpm-aware Node 22 alpine ──────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
RUN corepack enable && apk add --no-cache curl tini
WORKDIR /app

# ── 2. deps: install with workspace-aware manifests, cache layer ────────────
FROM base AS deps
ENV NODE_ENV=development
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json     packages/shared/
COPY packages/api/package.json        packages/api/
COPY packages/dispatcher/package.json packages/dispatcher/
COPY packages/worker/package.json     packages/worker/
COPY packages/scheduler/package.json  packages/scheduler/
COPY packages/web/package.json        packages/web/
RUN pnpm install --frozen-lockfile || pnpm install

# ── 3. build: verify typecheck + lint + format BEFORE shipping ──────────────
FROM deps AS build
COPY . .
RUN pnpm typecheck && pnpm lint && pnpm format:check

# ── 4. runtime: slim, prod-only deps, non-root, healthcheck ─────────────────
FROM base AS runtime
ENV NODE_ENV=production

# Copy source + lockfile, install ONLY prod dependencies (drops eslint, vitest,
# testing-library, prettier, etc. — keeps tsx because services run via tsx).
COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=build /app/packages/shared/package.json     packages/shared/
COPY --from=build /app/packages/api/package.json        packages/api/
COPY --from=build /app/packages/dispatcher/package.json packages/dispatcher/
COPY --from=build /app/packages/worker/package.json     packages/worker/
COPY --from=build /app/packages/scheduler/package.json  packages/scheduler/
# Workspace deps need to be linked even in prod-only install.
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
# Now bring in the source (excluding what .dockerignore filters out).
COPY --from=build /app/packages/shared/src     packages/shared/src
COPY --from=build /app/packages/shared/tsconfig.json packages/shared/
COPY --from=build /app/packages/api/src        packages/api/src
COPY --from=build /app/packages/api/tsconfig.json    packages/api/
COPY --from=build /app/packages/dispatcher/src packages/dispatcher/src
COPY --from=build /app/packages/dispatcher/tsconfig.json packages/dispatcher/
COPY --from=build /app/packages/worker/src     packages/worker/src
COPY --from=build /app/packages/worker/tsconfig.json packages/worker/
COPY --from=build /app/packages/scheduler/src  packages/scheduler/src
COPY --from=build /app/packages/scheduler/tsconfig.json packages/scheduler/
COPY --from=build /app/tsconfig.base.json      ./
COPY --from=build /app/migrations              migrations
COPY --from=build /app/keys                    keys

# Run as the unprivileged `node` user shipped in the base image.
RUN chown -R node:node /app
USER node

# Tiny shim so `tini` is PID 1 — handles SIGTERM cleanly + reaps zombies.
ENTRYPOINT ["/sbin/tini", "--"]

# Container healthcheck hits the API /readyz; dispatcher/worker/scheduler get
# their own metrics endpoint /healthz served by startMetricsServer.
# Override METRICS_HEALTH_PORT in compose for non-API services.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${HEALTH_PORT:-8080}/healthz" || exit 1

CMD ["pnpm", "--filter", "@conduit/api", "start"]
