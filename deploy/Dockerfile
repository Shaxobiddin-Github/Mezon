# syntax=docker/dockerfile:1
# v1: the whole workspace is copied (see .dockerignore) so the cloud's workspace dependencies are
# always present; only the cloud API and the admin cabinet are built.
FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
# corepack already provides the pinned pnpm: do not let pnpm download its own binary again.
ENV npm_config_manage_package_manager_versions=false

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@mezon/cloud... --filter=@mezon/admin...

# Cloud API runtime
FROM node:24-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
ENV npm_config_manage_package_manager_versions=false

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

COPY --from=builder /app /app

EXPOSE 4000

CMD ["pnpm", "--filter", "@mezon/cloud", "start"]

# HTTPS entry: the admin cabinet (static) and the API on ONE origin (the cabinet calls the API with
# relative URLs and its refresh cookie is SameSite=Strict).
FROM caddy:2-alpine AS web

COPY --from=builder /app/apps/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
