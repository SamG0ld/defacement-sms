# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js 16 app, producing a lean standalone runtime.
# Build on a host with the source checked out, then reference the resulting image
# by tag from your container host / compose file.

# ---- deps: install all deps (incl. dev — needed for `next build` + prisma) ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The Prisma schema + config must be present before install: the root `postinstall`
# runs `prisma generate` (so a plain `npm install && next build` finds the generated
# client). Without the schema here, that postinstall fails the deps stage — the
# builder regenerates anyway, but the install itself must still succeed.
COPY prisma ./prisma
COPY prisma.config.ts ./
# `npm install` (not `npm ci`): the lockfile's optional wasm deps for Tailwind v4's
# native engine (@tailwindcss/oxide → @emnapi/*) don't reconcile under strict `npm ci`
# across npm versions (lock written by npm 11, image runs npm 10). install resolves
# the tree fresh and is reliable here. Follow-up: standardize node/npm across
# local/CI/Docker and return to `npm ci`.
RUN npm install --no-audit --no-fund

# ---- builder: generate the Prisma client + build the standalone server --------
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client is generated to app/generated/prisma (gitignored) — must run here.
RUN npx prisma generate
# Placeholder env for `next build` only: lib/db.ts constructs Prisma at import and
# throws without DATABASE_URL, which breaks page-data collection (the Docker build
# has no .env). Server env is NOT inlined into the bundle (only NEXT_PUBLIC_*), so
# these throwaway values never reach runtime — the container's real env does.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV AUTH_SECRET="build-only-placeholder-not-used-at-runtime"
# output: "standalone" (next.config.ts) emits .next/standalone/server.js
RUN npm run build

# ---- runner: minimal runtime image -------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Prisma's migration engine (run by `migrate deploy` on startup) needs OpenSSL,
# which node:slim omits; ca-certificates for outbound TLS (Upstash REST).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Standalone server + the assets it doesn't trace (static/ and public/).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Schema + migrations + the full node_modules and prisma.config.ts, so the
# entrypoint's `prisma migrate deploy` resolves the CLI, migration engine,
# prisma/config, and dotenv (prisma.config.ts imports it). The datasource has no
# url in the schema — prisma.config.ts supplies it from DATABASE_URL. Heavier than
# a pure-standalone image; trimming is tracked in Tech Debt.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY prisma.config.ts ./

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
