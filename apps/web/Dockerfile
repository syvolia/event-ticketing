# ---------------------------------------------------------------------------
# Stage 1: deps — install node_modules with all workspace manifests present.
#
# Why all three workspace package.jsons? The root package.json declares
# "workspaces: ['apps/*', 'packages/*']" and `npm ci` walks the tree before
# filtering by --workspace. Missing any workspace manifest → ENOENT.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --workspace=@ticketing/web --include-workspace-root

# npm's workspace hoisting leaves these dirs absent when nothing local was
# placed in them; COPY --from= in the next stage needs them to exist.
RUN mkdir -p apps/web/node_modules packages/shared/node_modules

# ---------------------------------------------------------------------------
# Stage 2: build — Vite build.
#
# The build stage MUST have package.json at /app/package.json before running
# `npm run build`. `npm run` resolves the workspace root from cwd upward, so
# without it npm errors with ENOENT on /app/package.json — exactly the failure
# the previous Dockerfile hit. The `COPY package.json package-lock.json
# tsconfig.base.json ./` line below is mandatory, not decorative.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# 1. node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# 2. Workspace metadata FIRST — this is what was missing
COPY package.json package-lock.json tsconfig.base.json ./

# 3. Source trees
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# 4. Sanity check. If this RUN fails (or prints "No such file"), the COPY
#    above didn't run and we can see why without waiting for the full build.
RUN ls -la /app/ | head -20 && test -f /app/package.json || \
    (echo "FATAL: /app/package.json missing — COPY didn't land" && exit 1)

# 5. VITE_API_URL is baked into the bundle at build time. It MUST be the
#    public URL the browser will use, not an internal compose hostname.
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL

# 6. Build
RUN npm run build --workspace=@ticketing/web

# ---------------------------------------------------------------------------
# Stage 3: runtime — nginx serving static files.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1