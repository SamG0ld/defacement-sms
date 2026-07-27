# Defacement SMS — Signage Management System

Signage management for a large hacking conference's signage team — a single source of truth for the
hundreds of signs deployed across the conference each year, replacing the spreadsheet
workflow with a database-backed web app.

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | NextAuth v5 (JWT sessions) — Google OAuth + passwordless magic-link email (Resend) |
| ORM | Prisma 7 (`@prisma/adapter-pg` driver adapter) |
| Database | PostgreSQL (any managed Postgres) |
| Rate limiting | Upstash Redis (optional in dev) |
| Error monitoring | Sentry (optional off Vercel; required on Vercel deploys) |
| Hosting (target) | Vercel + a managed Postgres |

## What's built

- **Public landing "door"** — the public entry at `/login` is one same-origin flow: a mono kicker,
  a `DEFACEMENT HQ` wordmark, an **animated DC34 spray-can circuit emblem** (light beams travel
  along each circuit trace via SVG `stroke-dashoffset`), a `GOONS ONLY BEYOND THIS POINT` threshold
  line, and a `Tap to authenticate` CTA that plays a terminal boot and wipes into the sign-in screen
  (reduced-motion users skip straight to sign-in). On the apex domain (`LANDING_APEX_HOST`) the bare
  URL serves the door; the app subdomain is unchanged. The auth underneath is exactly the two methods
  below — the door only restyles the surface (see [Deploy](DEPLOY.md) §5c to enable the apex).
- **Two sign-in methods** via NextAuth v5, with JWT sessions (7-day lifetime, 24-hour refresh):
  **Google OAuth** and **passwordless magic-link email** (Resend) for teammates whose email
  backend isn't Google. Both honor closed registration.
- **Closed registration** — sign-in is invitation-gated in the `signIn` callback: only an
  email with a pre-existing (admin-created) user row may authenticate. No open self-signup. The
  magic-link path enforces this before sending — a link is only ever mailed to a known active user.
- **Sign-in hardening** — Google sign-in requires a verified email (`email_verified`) so a
  pre-provisioned row can't be claimed by an unverified address; magic links expire in 15 minutes
  and the send path avoids account enumeration; and post-login redirects are constrained to
  same-origin/relative `callbackUrl`s to block open redirects.
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
- **Upload validation** — uploaded images are validated by **magic bytes**, not the declared
  content type (PNG/JPEG/WebP only — an SVG, HTML, or renamed binary is rejected), with a size cap
  and a decompression-bomb guard (`lib/image-upload.ts`); stored blob IDs are sanitized so a crafted
  name can't escape its path (`lib/blob-image.ts`).
- **Security headers** — HSTS, `X-Frame-Options`, `Referrer-Policy`, a locked-down
  `Permissions-Policy`, and more (`next.config.ts`), plus a **per-request, nonce-based CSP**
  (`lib/csp.ts` + `proxy.ts`): `script-src` uses a fresh per-response nonce with `strict-dynamic`
  instead of `unsafe-inline`. It runs report-only or enforcing via `CSP_MODE`, with violations
  POSTing to `/api/csp-report` for a data-driven report→enforce flip.
- **Production env preflight** — a boot-time check refuses to start in production with missing
  config or a weak/placeholder `AUTH_SECRET`, so a misconfigured deploy fails fast instead of
  running insecure (`lib/env.ts`).
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
  `/api/native/*` JSON API; private photo storage). The layout is **device-adaptive** — a
  full-screen field flow on phones (bottom-sheet deploy confirm, claim bar docked above the tab bar)
  that widens on desktop into a multi-column console: the sign lists beside a live sync queue and a
  click-to-preview pane.
- **Zones** — configurable venue zones (the reference-data seed ships example convention-center
  zones — multiple levels plus exhibit halls); the importer maps location text to the right zone.
- **Admin & user management** — `/users` (add by email + role, change role, deactivate), and an
  admin `/signs/manage` to clear test data or all signs (typed confirmation), with every
  destructive action written to an audit log.
- **Login audit history** — `/activity` → **Logins** tab (admin-only) records successful and denied
  sign-in attempts with coarse location (Vercel edge geo headers, no raw IP), device type, and
  sign-in method. Login records older than 90 days are auto-purged daily by a scheduled Vercel Cron job.
- **Generation by sign size** — batches, export, and a per-size record view (`/signs/by-size`) so a
  print run is organised the way the printer actually needs it, with a resize-drift diagnostic that
  flags signs whose size no longer matches their batch.
- **Figma reconcile** — a per-size manifest that matches the app's records against the rendered
  Figma file, surfacing stale/orphan nodes and text-edit corrections instead of silently drifting.
  Batch URLs are canonicalised on save so the per-size view and reconcile dedup by file.
- **Reversible soft-remove** — removing a generated sign sets an `archived` tombstone rather than
  deleting it, so a removal can be restored. The add/remove/move engine treats a tombstone plus a
  live re-add as the intended end state, not a double-create.
- **Master-sheet reconcile** — signs sourced from the master planning sheet carry a provenance tag
  and a stable sheet identity, so a re-import reconciles (add / remove / move) against what is
  already there instead of duplicating it. Concurrent applies are locked and re-authorised.
- **Sign Format as single source of truth** — a format picker, bulk set-format, and a
  format-mismatch audit, with format and size changes recorded on the per-sign change-history
  timeline.
- **QM stock** — check-out of stock signs, grouped stock UI, and an all-venue standing-sign layer
  (Code of Conduct, policy, wayfinding and venue maps) seeded as individually trackable rows.
- **Specialty bulk intake** (`/signs/specialty`) — a dedicated entry path for floor/wall graphics,
  venue maps and sticker walls, which the sheet importer deliberately skips.
- **Hardware lifecycle** — three-state hardware tracking including return at strike time, plus
  received-quantity and type-change handling on intake.
- **Room mapping** — room-code normalisation (preventing variant-spelling duplicates), a Room
  column that round-trips through export/import, and bulk auto-pin of signs to rooms by room code.
- **Floor maps** — delete support and resolution-aware deep zoom for large venue plans.
- **Error monitoring & observability** — Sentry wired into the server, edge, and browser runtimes
  behind a structured error funnel, with URL/header/body scrubbing so tokens and user data never
  reach the wire. Unset = complete no-op; required on Vercel deploys so it can't silently ship off.
- **Denial-of-wallet defenses** — the Next.js image optimizer is disabled outright (nothing uses
  `next/image`), request bodies are capped, and a signed Vercel Spend Management webhook can
  auto-pause the project at 100% spend so a runaway spike 503s instead of running up the bill.
- **Link previews** — an Open Graph / Twitter card so shared links unfurl with a proper title,
  description and image.

## Getting started

### Prerequisites

- Node.js 22 (see `.nvmrc`; `engines` pins 22.x)
- A PostgreSQL database — any managed Postgres works, including a local Docker
  container
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
      by-size/   Per-size record view + print manifest + resize-drift diagnostic
      generate/  Generation batches + render-ready handoff CSV + Figma previews
      reconcile/ Master-sheet add/remove/move reconcile
      specialty/ Bulk intake for floor/wall graphics, venue maps, sticker walls
      pin/       Bulk auto-pin signs to rooms by room code
    inventory/   Equipment counts + year-over-year + derived print summary
    deploy/      Offline-first field-deployment PWA
    map/         Floor-map sign placement
    activity/    Admin/lead activity + deploy log + login audit
    users/       Admin user management
  (public)/
    login/       Landing "door" → Google sign-in + magic-link email
  api/auth/      NextAuth route handler
  api/native/    JSON API backing the deploy PWA (claims, crews, sync, photos)
  api/health/    Health check
  api/ready/     Readiness probe
  api/maps/      Floor-map image serving
  api/cron/      Scheduled jobs (login-audit retention purge)
  api/webhooks/  Vercel Spend Management auto-pause kill-switch
  api/csp-report/ CSP violation reports (rate-capped)
lib/
  auth.ts        NextAuth config — callbacks, kill-switch, redirect guard
  db.ts          Prisma client singleton (pg driver adapter)
  rbac.ts        Role helpers — requireSession / requireRole
  ratelimit.ts   Upstash limiter (no-ops when unconfigured)
  csp.ts         Per-request, nonce-based Content-Security-Policy builder
prisma/
  schema.prisma  19 models (auth + domain)
  migrations/
  seeds/         Reference data, equipment types, floor maps, sample signs
fixtures/        Importable sample CSVs
proxy.ts         Edge middleware — auth gate, rate limiting, per-request nonce CSP
next.config.ts   Static security headers (CSP is set per-request in proxy.ts)
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

Security headers, a per-request nonce-based CSP with violation reporting (`/api/csp-report`,
report-only or enforcing via `CSP_MODE`), an edge auth gate, same-origin CSRF defense on the
`/api/native/*` API, per-actor rate limiters that fail open, formula-injection-safe CSV
export, and a per-user session kill-switch are in place. Server-side authorization is centralized
in `lib/rbac.ts` (`requireSession` / `requireRole`). Secrets live only in `.env` (gitignored);
`.env.example` is the documented source of truth for variable names.

Additional hardening: the rate limiters key on a client IP derived from the *right* of
`x-forwarded-for` (`lib/client-ip.ts`, `TRUST_PROXY_DEPTH`) so the header can't be rotated to win a
fresh budget; the sign-in path throttles the login Server Actions themselves, avoids roster
enumeration, and re-reads roles rather than trusting a stale token; mutation paths lock,
re-authorize, and guard against archived-row resurrection and concurrent double-creates; request
bodies are capped; a production boot fails loudly rather than silently shipping with rate limiting,
CSP enforcement, or error reporting switched off; and Sentry events are scrubbed of URLs, headers
and bodies so tokens and user data never leave the process.

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

See [ROADMAP.md](ROADMAP.md). In short: auth, the data model, the core domain UI, the
offline-first deploy PWA, and the generation/reconcile workflow (batches, per-size manifests,
Figma reconcile) are done. What's left is the **sign-art rendering step** itself and
**production deployment** (see [DEPLOY.md](DEPLOY.md)). A native iOS client on the same API is
designed but deferred — the web PWA is the con-critical deliverable.

## License

[Apache-2.0](LICENSE).
