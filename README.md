# Defacement SMS — Signage Management System

Signage management for a large hacking conference's signage team — a single source of truth for the
hundreds of signs deployed across the conference each year, replacing the spreadsheet
workflow with a database-backed web app.

> **Status — active rewrite, core complete.** This is the Next.js rebuild of a production-tested
> Flask app that ran the signage workflow in production for several years. Authentication, the full data model, the
> core domain UI (sign management, CSV import/export, inventory, admin/user management), the
> external-item delivery/handoff lifecycle, and the offline-first field-deployment PWA are all in
> place. What remains is finishing the sign-art generation pipeline and production deployment. See
> the [Roadmap](#roadmap).

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | NextAuth v5 (JWT sessions) — Google OAuth + passwordless magic-link email (Resend) |
| ORM | Prisma 7 (`@prisma/adapter-pg` driver adapter) |
| Database | PostgreSQL (e.g. [Neon](https://neon.tech) serverless, or any Postgres) |
| Rate limiting | Upstash Redis (optional in dev) |
| Hosting (target) | Vercel + a managed Postgres |

## What's built

- **Two sign-in methods** via NextAuth v5, with JWT sessions (7-day lifetime, 24-hour refresh):
  **Google OAuth** and **passwordless magic-link email** (Resend) for teammates whose email
  backend isn't Google. Both honor closed registration.
- **Closed registration** — sign-in is invitation-gated in the `signIn` callback: only an
  email with a pre-existing (admin-created) user row may authenticate. No open self-signup. The
  magic-link path enforces this before sending — a link is only ever mailed to a known active user.
- **Role-based access** — `admin` / `lead` / `volunteer` tiers (`lib/rbac.ts`).
- **Session kill-switch** — a per-user `tokenVersion`; bumping it invalidates outstanding
  sessions within an hour (the JWT re-reads the DB once per `REFRESH_INTERVAL_MS`).
- **Edge auth gate + rate limiting** — `proxy.ts` (Next.js 16 middleware) guards
  authenticated routes and throttles auth endpoints. Per-actor backstop limiters also cover
  the `/api/native/*` sync surface and the mutating server actions; all limiters fail open
  on an Upstash outage (best-effort throttling never takes down login or the floor sync).
- **CSRF defense on the native API** — `/api/native/*` mutations require same-origin
  browser metadata (`Sec-Fetch-Site`/`Origin`) plus a JSON content type
  (`lib/deploy/api-guards.ts`); non-browser clients are unaffected.
- **Security headers** — HSTS, a report-only CSP (violations POST to `/api/csp-report` for a
  data-driven report→enforce flip), `X-Frame-Options`, and more in `next.config.ts`.
- **Data model** — the full domain schema (signs, zones, locations, tags, equipment, status
  history, audit log) defined in Prisma with migrations applied.
- **Dashboard** — at-a-glance status counts, a deployment-progress bar, and deploy-by-today /
  overdue tiles, each linking into the matching filtered list.
- **Sign management** — list with filters (status / zone / tag / deploy slot / type / category /
  search) and a pager, a detail view with a status-history timeline and sign-art previews,
  lead-gated create/edit/delete, and a category-aware status workflow (deploy items run
  `pending → generated → printed → delivered → sorted → deployed`).
  Change a sign's status from the list with a deliberate **click-then-confirm** to any stage, or use
  **bulk multi-select** — set status (any user) or zone / slot / tag / delete (lead+), acting on
  the checked rows or every row matching the current filter. Single per-sign status changes are
  **offline-resilient** — written to a durable IndexedDB queue that survives connectivity drops and
  syncs in the background (idempotent on a client key). Easel and meterboard signs also track
  whether their **hardware has been collected**. Every change records status history and keeps
  delivery/deploy timestamps consistent. Desktop table (with per-column tooltips) + mobile cards.
- **Sign categories & external-item lifecycle** — signs are categorized (easel posters, meterboards,
  socks, ops maps, union-installed items), set automatically on CSV import and editable on the form.
  Externally-installed items (banners, floor/wall graphics, sticker walls, ops maps) are produced
  off-site, so their detail page walks a **delivery & handoff** chain of custody: accept delivery →
  hand off to a named crew → confirm installed (`delivered → handed_off → installed`), each step
  recording who/when with an optional proof photo stored privately and served through an auth-gated
  route.
- **CSV import / export** — a source-aware import wizard (conference sign sheet, master inventory, or
  generic CSV) with a non-destructive dry-run preview that flags valid / invalid / duplicate rows;
  sign categories assigned automatically from the sheet's section structure; filtered export that
  round-trips with import; formula-injection-safe output and size/row caps.
- **Inventory** — equipment types with per-year counts and a year-over-year matrix, plus a
  category-aware print summary derived live from the sign list (counts per category and size,
  honoring per-sign easel flags and counting meterboard stands only for meterboard items).
- **Field-deployment PWA** (`/deploy`) — an offline-first, installable web app where crews claim
  batches of `sorted` signs (exclusive lock) and mark them deployed with an optional photo, working
  with no network on a hostile-RF floor and syncing on reconnect (durable IndexedDB outbox over the
  `/api/native/*` JSON API; private photo storage).
- **Zones** — configurable venue zones (the reference-data seed ships example convention-center
  zones — multiple levels plus exhibit halls); the importer maps location text to the right zone.
- **Admin & user management** — `/users` (add by email + role, change role, deactivate), and an
  admin `/signs/manage` to clear test data or all signs (typed confirmation), with every
  destructive action written to an audit log.

## Getting started

### Prerequisites

- Node.js 20+ (developed on 24)
- A PostgreSQL database — a free [Neon](https://neon.tech) project is one easy option, but any
  Postgres works (including a local Docker container)
- A Google OAuth 2.0 client (for login)

### Setup

```bash
git clone https://github.com/SamG0ld/defacement-sms.git
cd defacement-sms
npm install

# Configure environment — see .env.example for the full, documented list:
cp .env.example .env
#   DATABASE_URL / DIRECT_URL   Postgres connection strings (pooled + direct)
#   AUTH_SECRET                 openssl rand -base64 32
#   AUTH_GOOGLE_ID / _SECRET    Google OAuth client credentials
#   NEXTAUTH_URL                http://localhost:3000
#   BOOTSTRAP_ADMIN_EMAILS      your email — auto-provisions you as admin (see First login)

# Generate the Prisma client and apply migrations
# (with a pooled Postgres provider, run migrations against the DIRECT/unpooled URL — see DEPLOY.md)
npx prisma generate
npx prisma migrate deploy

# Seed the reference data (zones + tags) the UI and CSV import depend on
npx prisma db execute --file prisma/seeds/reference-data.sql

npm run dev          # → http://localhost:3000
```

### First login

Registration is closed — there is no open signup. To create the first admin, add your Google
address to `BOOTSTRAP_ADMIN_EMAILS` in `.env`:

```bash
BOOTSTRAP_ADMIN_EMAILS="you@example.com"
```

Then start the app and sign in with Google — you're auto-provisioned as an `admin` on first
login. Everyone else stays locked out until invited. (Clear this variable once real admins exist.)

> Magic-link email is **Google-independent for everyone except the first admin** — bootstrap
> self-provisioning is Google-only, so seed the first admin with a Google account; once they
> exist, teammates you add can sign in with either Google or a magic link. Magic links need Resend configured
> (`AUTH_RESEND_KEY` / `EMAIL_FROM`); see [`.env.example`](.env.example) and [DEPLOY.md](DEPLOY.md).

### Sample data (kick the tires)

Two fixtures ship in `fixtures/` so you can populate a fresh database and exercise the whole
import → list/filters → export → inventory flow in one pass. First, seed the reference data the UI
depends on (zones + tags), or every row will warn on import:

```bash
npx prisma db execute --file prisma/seeds/reference-data.sql
```

Then go to **Signs → Import** and upload one of:

- **`fixtures/dc33-seed.csv`** — a 16-row slice of representative public conference wayfinding signage
  (venue maps, workshops, demo labs, registration), to see the app populated with realistic data.
- **`fixtures/ui-coverage-sample.csv`** — a 16-row fixture that deliberately hits every part of the
  importer: valid/duplicate/invalid rows, zone/tag/slot warnings, an ignored column, every sign-type
  bucket, and the easel/meterboard hardware logic.

Pick the **Generic CSV** source for either. Rows land as **test data** by default — wipe them
anytime with **Clear test data**. Two things to know: the CSV can't set status (everything imports
as `pending` — change it with the row/bulk status controls), and duplicate detection is an exact
`Map# + Sign Text` match. The UI-coverage fixture is guarded by
`tests/unit/ui-coverage-fixture.test.ts`, which re-validates it on every `npm test`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest, no DB) |
| `npm run coverage` | Unit tests with coverage |
| `npm run test:integration` | Integration tests (needs a test DB — see Testing) |
| `npm run test:e2e` | Playwright smoke (boots/reuses the dev server) |

## Project structure

```
app/
  (app)/         Authenticated area (layout gates on session.isActive)
    page.tsx     Dashboard (status counts, deployment progress, due/overdue)
    signs/       List/detail/CRUD, status workflow, bulk multi-select, import wizard, export, admin manage
    inventory/   Equipment counts + year-over-year + derived print summary
    deploy/      Offline-first field-deployment PWA
    map/         Floor-map sign placement
    activity/    Admin/lead activity + deploy log
    users/       Admin user management
  (public)/
    login/       Google sign-in
  api/auth/      NextAuth route handler
  api/native/    JSON API backing the deploy PWA (claims, crews, sync, photos)
  api/health/    Health check
  api/maps/      Floor-map image serving
lib/
  auth.ts        NextAuth config — callbacks, kill-switch, redirect guard
  db.ts          Prisma client singleton (pg driver adapter)
  rbac.ts        Role helpers — requireSession / requireRole
  ratelimit.ts   Upstash limiter (no-ops when unconfigured)
  invitations.ts SHA-256 hashed, constant-time invitation tokens
prisma/
  schema.prisma  19 models (auth + domain)
  migrations/
  seeds/         Reference data, equipment types, floor maps, sample signs
fixtures/        Importable sample CSVs
proxy.ts         Edge middleware — auth gate + auth-endpoint rate limiting
next.config.ts   Security headers + CSP
tests/           unit (Vitest) + integration (Prisma) + e2e (Playwright)
.github/         CI workflow
```

## Roles

| Role | Capabilities |
|------|--------------|
| **Admin** | Everything, including user management |
| **Lead** | Sign CRUD, import/export, equipment |
| **Volunteer** | View signs, update deployment status |

## Security

Security headers, a report-only CSP with violation reporting (`/api/csp-report`, promotable to
enforcing), an edge auth gate, same-origin CSRF defense on the `/api/native/*` API, per-actor
rate limiters that fail open, hashed single-use invitation tokens, formula-injection-safe CSV
export, and a per-user session kill-switch are in place. Server-side authorization is centralized
in `lib/rbac.ts` (`requireSession` / `requireRole`). Secrets live only in `.env` (gitignored);
`.env.example` is the documented source of truth for variable names.

## Testing

Three layers, run in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) on every push/PR:

- **Unit** (`npm test`) — pure domain logic (status workflow, CSV import parsers, print-summary,
  zone labels); no database, always runnable.
- **Integration** (`npm run test:integration`) — Server Actions against a real Postgres. Needs a
  **disposable** test DB: copy `.env.test.example` → `.env.test` and point it at a throwaway DB. A
  safety guard refuses to run unless the database name looks like a test DB, so it can never touch
  your dev data. CI runs it against an ephemeral `postgres:16` container.
- **E2E** (`npm run test:e2e`) — a Playwright unauthenticated smoke (login renders, protected
  routes redirect). Reuses a running dev server locally; `npx playwright install chromium` once.

## Roadmap

See [ROADMAP.md](ROADMAP.md). In short: auth, the data model, the core domain UI, and the
offline-first deploy PWA are done. What's left is the **sign-art generation pipeline** and
**production deployment** (see [DEPLOY.md](DEPLOY.md)). A native iOS client on the same API is
designed but deferred — the web PWA is the con-critical deliverable.

## License

[Apache-2.0](LICENSE).
