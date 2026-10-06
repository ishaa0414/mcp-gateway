# syntax=docker/dockerfile:1
#
# MCP Gateway, standalone. Build from the repository root (the gateway depends on workspace packages):
#
#   docker build -f apps/gateway/Dockerfile -t mcp-gateway .
#
# Everything is configured through environment variables; there is no config file. Required:
#   DATABASE_URL, REDIS_URL, ENCRYPTION_KEY (64 hex characters)
# Optional: PORT / GATEWAY_PORT (default 4000), DATABASE_POOL_MAX, TOOL_CALL_TIMEOUT_MS,
#   TOOL_RESPONSE_MAX_BYTES, CONFIG_CACHE_TTL_SECONDS, API_KEY_CACHE_TTL_SECONDS. See .env.example.
# The image does not run database migrations; apply them with `pnpm db:migrate:deploy`.

ARG NODE_VERSION=22

# ---- build: install everything, compile, then extract just the gateway -----------------------
FROM node:${NODE_VERSION}-slim AS build
# Keep in step with "packageManager" in the root package.json.
RUN npm install --global pnpm@12.8.1
WORKDIR /repo

# Manifests first: the install layer is reused until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/openapi-tools/package.json packages/openapi-tools/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mcp-gateway/gateway..."

COPY packages ./packages
COPY apps/gateway ./apps/gateway
# "..." also builds the workspace packages the gateway imports, in dependency order.
RUN pnpm --filter "@mcp-gateway/gateway..." run build

# A self-contained folder: the gateway's compiled code plus production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @mcp-gateway/gateway deploy --prod /out

# ---- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Never run as root.
USER node

EXPOSE 4000

# /health checks Postgres and Redis; the port is whatever the platform assigned.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.GATEWAY_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/index.js"]
