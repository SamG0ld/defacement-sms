# CLAUDE.md — Defacement SMS

Project context for AI coding sessions and contributors. This file is the project-specific
guidance for working in this repository.

## What this is

Signage management system for the DEF CON Defacement team — a Next.js rebuild of a
production-tested Flask app. Authentication, the full data model, and the core domain UI (sign
management, CSV import/export, inventory, floor maps, admin/user management) and the offline-first
field-deployment PWA are all in place. What remains is the sign-art generation pipeline and
production deployment — see `README.md` and `ROADMAP.md`.

## Stack

- **Next.js 16** (App Router, Turbopack) + **TypeScript**
- **NextAuth v5** (JWT sessions) — Google OAuth + passwordless magic-link email (Resend), Prisma adapter
- **Prisma 7** + **PostgreSQL** via the `@prisma/adapter-pg` driver adapter
- **Tailwind v4**; **Upstash Redis** for rate limiting (optional in dev)
- Target hosting: **Vercel** + a managed Postgres

> Next.js 16 has breaking changes from earlier versions — see `AGENTS.md`. Note middleware
> lives in `proxy.ts` (renamed from `middleware.ts` in v16).

## Layout

- `app/(app)/` — authenticated area; `app/(public)/login` — sign-in; `app/api/auth/[...nextauth]` — handler
- `app/api/native/` — JSON API backing the offline deploy PWA
- `lib/auth.ts` NextAuth config · `lib/db.ts` Prisma singleton · `lib/rbac.ts` roles ·
  `lib/ratelimit.ts` Upstash · `lib/invitations.ts` hashed tokens
- `proxy.ts` edge auth gate + rate limiting · `next.config.ts` security headers / CSP
- `prisma/schema.prisma` (14 models: auth + domain) · `prisma/migrations/`
- Generated Prisma client → `app/generated/prisma` (gitignored)

## Commands

- `npm run dev` — dev server at http://localhost:3000
- `npx prisma generate` — regenerate the client after editing the schema
- `npx prisma migrate dev --name <name>` — create & apply a migration
- `npx prisma studio` — inspect/edit data
- `npm run build` · `npm run lint` · `npm run typecheck`
- `npm test` — unit tests (Vitest, no DB) · `npm run coverage`
- `npm run test:integration` — Prisma Server-Action tests; needs a disposable test DB (`.env.test`)
- `npm run test:e2e` — Playwright smoke (`npx playwright install chromium` once)

## Auth model

Closed registration: the `signIn` callback in `lib/auth.ts` rejects any email without a
pre-existing User row, so only admin-created accounts can sign in (NextAuth's Prisma adapter
would otherwise auto-provision anyone). Two sign-in methods, both closed-registration-gated:
**Google OAuth** and **passwordless magic-link email** (Resend, `lib/email.ts`) — the
magic-link path checks for a known active user *before* sending, so no link reaches a non-user.
Roles: `admin` / `lead` / `volunteer`. A per-user `tokenVersion` acts as a session kill-switch.
The first admin is bootstrapped via the `BOOTSTRAP_ADMIN_EMAILS` env allowlist (auto-provisions
as admin on first sign-in — **Google-only**; magic-link never self-provisions); see README →
First login.

## Conventions

- Server-side authorization goes through `lib/rbac.ts` (`requireSession` / `requireRole`).
- Secrets live only in `.env` (gitignored); `.env.example` is the documented source of truth.
- Conventional commits (`feat|fix|refactor|docs|chore|...`).
- Prefer immutable updates and small, focused files. Validate user input (zod schemas exist).
- Match effort to risk; verify changes locally (typecheck / lint / test / build) before
  claiming done.
