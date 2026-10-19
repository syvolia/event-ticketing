# ---------------------------------------------------------------------------
# Stage 1: deps — install node_modules with all workspace manifests present.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --workspace=@ticketing/api --include-workspace-root

RUN mkdir -p apps/api/node_modules packages/shared/node_modules

# ---------------------------------------------------------------------------
# Stage 2: build — typecheck only. tsx runs TypeScript at runtime, so there
# is no JS emit step. `npm run typecheck` requires package.json to resolve
# the workspace, exactly like the web Dockerfile's `npm run build`.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY package.json package-lock.json tsconfig.base.json ./

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN ls -la /app/ | head -20 && test -f /app/package.json || \
    (echo "FATAL: /app/package.json missing — COPY didn't land" && exit 1)

RUN npm run typecheck --workspace=@ticketing/api

# ---------------------------------------------------------------------------
# Stage 3: runtime — minimal image, non-root user, tini as PID 1.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/tsconfig.base.json ./
COPY --from=build /app/package.json ./

USER node
EXPOSE 3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "apps/api/src/index.ts"]