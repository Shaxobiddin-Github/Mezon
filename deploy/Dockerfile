# syntax=docker/dockerfile:1
FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Copy root configuration files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json tsconfig.base.json ./

# Copy package sources
COPY packages/domain/ ./packages/domain/
COPY packages/contracts/ ./packages/contracts/
COPY packages/rules/ ./packages/rules/
COPY packages/db-local/ ./packages/db-local/
COPY packages/db-cloud/ ./packages/db-cloud/
COPY packages/drivers/ ./packages/drivers/
COPY packages/test-utils/ ./packages/test-utils/
COPY apps/cloud/ ./apps/cloud/

# Install dependencies and build cloud package
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mezon/cloud build

# Production runtime stage
FROM node:24-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

COPY --from=builder /app /app

EXPOSE 4000

CMD ["pnpm", "--filter", "@mezon/cloud", "start"]
