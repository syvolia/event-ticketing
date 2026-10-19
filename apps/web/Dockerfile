# Web app is a static SPA. Multi-stage: build in Node, serve in nginx.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace=@ticketing/web --include-workspace-root

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# VITE_API_URL is baked into the bundle at build time. It MUST be the public
# URL of the API, not a runtime env var.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build --workspace=@ticketing/web

FROM nginx:1.27-alpine AS runtime
# SPA fallback: any unmatched path serves index.html. Security headers are
# set here because nginx is the edge; the API's Helmet headers do not apply
# to the web origin.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1