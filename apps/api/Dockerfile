# Multi-stage build. Stage 1 installs and typechecks; stage 2 runs only the
# runtime deps and the source. We do not compile to JS because tsx is used at
# runtime — the size difference is negligible at this scale and we keep the
# source maps for stack traces in production logs.
FROM node:20-alpine AS deps
WORKDIR /app
# Copy manifests first so a source-only change does not invalidate the
# dependency layer.
COPY package.json package-lock.json ./
COPY pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace=@ticketing/api --include-workspace-root

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules 2>/dev/null || true
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules 2>/dev/null || true
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npm run typecheck --workspace=@ticketing/api

FROM node:20-alpine AS runtime
WORKDIR /app
# tini reaps zombies and forwards signals. Without it, PID 1 in Alpine does
# not forward SIGTERM to node, and our graceful shutdown never runs.
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/tsconfig.base.json ./
COPY --from=build /app/package.json ./
# Run as non-root. The node user already exists in the base image.
USER node
EXPOSE 3000
ENV NODE_ENV=production
# Healthcheck hits /health (liveness), not /health/ready (readiness), so a DB
# outage does not make the container appear unhealthy to the runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "apps/api/src/index.ts"]