# Self-hosted PingWard: the same Worker, run by Cloudflare's open-source runtime (workerd, via
# Wrangler) with a local SQLite D1 database in /data. Cloudflare deploys don't use this file.

# ---- build the static dashboard ---------------------------------------------
# Pinned by digest (a tag can be re-pointed); Dependabot proposes updates.
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY worker/package.json worker/
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: only what the Worker needs ------------------------------------
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
LABEL org.opencontainers.image.source="https://github.com/vxlhr/pingward" \
      org.opencontainers.image.description="PingWard: self-hosted uptime monitor (Cloudflare Worker on workerd + SQLite)" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false \
    PINGWARD_DATA=/data
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY worker/package.json worker/
COPY frontend/package.json frontend/
# Worker + shared dependencies only (Wrangler/workerd included); the dashboard is prebuilt.
RUN npm ci -w worker -w shared && npm cache clean --force
COPY wrangler.toml ./
COPY shared ./shared
COPY worker ./worker
COPY --from=build /app/frontend/out ./frontend/out
COPY docker/start.sh /usr/local/bin/pingward-start
RUN chmod +x /usr/local/bin/pingward-start && mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fs http://localhost:8787/api/health || exit 1
CMD ["pingward-start"]
