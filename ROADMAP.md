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
- **Sign management** — filtered/paged list, detail view with a status-history timeline and
  sign-art previews, lead-gated CRUD, a category-aware status workflow (deploy items run
  `pending → generated → printed → delivered → sorted → deployed`), click-then-confirm and bulk
  multi-select status changes, and easel/meterboard hardware tracking. Single per-sign status
  changes are offline-resilient — a durable IndexedDB queue that survives connectivity drops and
  syncs in the background (idempotent on a client key). Desktop table + mobile cards.
- **Sign categories & external-item lifecycle** — signs are categorized (easel posters,
  meterboards, socks, ops maps, union-installed items), assigned automatically on CSV import.
  Externally-installed items run a delivery/handoff chain of custody
  (`delivered → handed_off → installed`) with optional proof photos stored privately and served
  through an auth-gated route.
- **CSV import / export** — source-aware import wizard with a non-destructive dry-run preview
  (valid / invalid / duplicate flagging), automatic category assignment from the sheet's section
  structure, and a filtered export that round-trips with import.
- **Inventory** — equipment types with per-year counts, a year-over-year matrix, and a live,
  category-aware print summary derived from the sign list (honors per-sign easel flags and counts
  meterboard stands only for meterboard items).
- **Floor maps** — sign placement against venue floor maps.
- **Field-deployment PWA** (`/deploy`) — offline-first, installable; crews claim batches of
  `sorted` signs under an exclusive lock and mark them deployed with an optional photo, working
  with no network and syncing on reconnect (IndexedDB outbox over the `/api/native/*` JSON API).
- **Admin & user management** — add/role/deactivate users, clear test data or all signs behind a
  typed confirmation, with destructive actions written to an audit log.

## In progress / planned

- **Sign-art generation pipeline** — turning the finalized sign list into print-ready art.
  Generation batches, a Figma export of the sign list, and pulling rendered previews back from
  Figma by Item-ID are in place; the final print-ready art rendering is the most complex remaining
  piece.
- **Production deployment** — Vercel + a managed Postgres + Upstash + Resend. See
  [DEPLOY.md](DEPLOY.md).

## Deferred

- **Native iOS client** — designed against the same `/api/native/*` API the deploy PWA uses, but
  deferred. The web PWA is the con-critical deliverable and ships without it.

## Notes

The tokenized one-time-invitation-link flow in `lib/invitations.ts` is intentionally parked as
redundant — closed registration plus magic-link sign-in already cover inviting a teammate (add
them on `/users`, they receive a sign-in link).
