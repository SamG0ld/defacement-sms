#!/bin/sh
# Apply outstanding migrations, then start the standalone Next.js server.
# Fail fast: if migrate fails, do not start a server against an unmigrated DB.
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)…"
# Local prisma CLI; prisma.config.ts supplies the datasource url from DATABASE_URL.
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Starting Next.js (standalone) on ${HOSTNAME}:${PORT}…"
exec node server.js
