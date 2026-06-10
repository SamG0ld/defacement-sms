# Roadmap

A high-level view of where Defacement SMS is and where it's going. This is the Next.js rebuild of
a Flask app that ran the DEF CON Defacement signage workflow in production through DC33.

## Done

- **Authentication** — NextAuth v5 with Google OAuth and passwordless magic-link email, JWT
  sessions, closed registration (invitation-gated sign-in), role tiers (admin / lead / volunteer),
  and a per-user session kill-switch.
- **Security baseline** — edge auth gate + auth-endpoint rate limiting (`proxy.ts`), security
  headers and a report-only CSP, formula-injection-safe CSV export, hashed single-use tokens.
- **Data model** — full domain schema (signs, zones, locations, tags, equipment, status history,
  audit log) in Prisma, with migrations.
- **Dashboard** — status counts, deployment progress, deploy-by-today / overdue tiles.
- **Sign management** — filtered/paged list, detail view with status-history timeline, lead-gated
  CRUD, a six-stage status workflow, click-then-confirm and bulk multi-select status changes, and
  easel/meterboard hardware tracking. Desktop table + mobile cards.
- **CSV import / export** — source-aware import wizard with a non-destructive dry-run preview
  (valid / invalid / duplicate flagging) and a filtered export that round-trips with import.
- **Inventory** — equipment types with per-year counts, a year-over-year matrix, and a live print
  summary derived from the sign list.
- **Floor maps** — sign placement against venue floor maps.
- **Field-deployment PWA** (`/deploy`) — offline-first, installable; crews claim batches of
  `sorted` signs under an exclusive lock and mark them deployed with an optional photo, working
  with no network and syncing on reconnect (IndexedDB outbox over the `/api/native/*` JSON API).
- **Admin & user management** — add/role/deactivate users, clear test data or all signs behind a
  typed confirmation, with destructive actions written to an audit log.

## In progress / planned

- **Sign-art generation pipeline** — turning the finalized sign list into print-ready art. The
  most complex remaining piece.
- **Production deployment** — Vercel + a managed Postgres + Upstash + Resend. See
  [DEPLOY.md](DEPLOY.md).

## Deferred

- **Native iOS client** — designed against the same `/api/native/*` API the deploy PWA uses, but
  deferred. The web PWA is the con-critical deliverable and ships without it.

## Notes

The tokenized one-time-invitation-link flow in `lib/invitations.ts` is intentionally parked as
redundant — closed registration plus magic-link sign-in already cover inviting a teammate (add
them on `/users`, they receive a sign-in link).
