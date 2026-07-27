# Roadmap

A high-level view of where Defacement SMS is and where it's going. This is the Next.js rebuild of
a Flask app that ran a large hacking conference's signage workflow in production for several years.

## Done

- **Authentication** — NextAuth v5 with Google OAuth and passwordless magic-link email, JWT
  sessions, closed registration (invitation-gated sign-in), role tiers (admin / lead / volunteer),
  and a per-user session kill-switch.
- **Security baseline** — edge auth gate + auth-endpoint rate limiting (`proxy.ts`), security
  headers and a per-request nonce-based CSP, and formula-injection-safe CSV export.
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
- **Floor maps** — sign placement against venue floor maps, with map delete and resolution-aware
  deep zoom for large venue plans.
- **Generation & reconcile workflow** — generation batches with a render-ready handoff CSV,
  generation and export **by sign size**, a per-size record view and print manifest, and a Figma
  reconcile pass that surfaces stale/orphan nodes, text-edit corrections, and resize drift instead
  of letting the app and the art file silently diverge.
- **Master-sheet reconcile** — signs sourced from the master planning sheet carry a provenance tag
  and a stable sheet identity, so a re-import reconciles (add / remove / move) rather than
  duplicating. Removal is a reversible `archived` tombstone, restorable at any point.
- **Sign Format as single source of truth** — format picker, bulk set-format, a format-mismatch
  audit, and format/size changes recorded on the per-sign change-history timeline.
- **QM stock & specialty intake** — stock check-out with grouped UI, an all-venue standing-sign
  layer seeded as individually trackable rows, a bulk specialty intake path, and three-state
  hardware lifecycle tracking including return at strike time.
- **Room mapping** — room-code normalisation that prevents variant-spelling duplicates, a Room
  column that round-trips through export/import, and bulk auto-pin of signs to rooms by room code.
- **Observability & cost control** — Sentry across server, edge, and browser runtimes behind a
  structured error funnel with URL/header/body scrubbing, a DB-readiness probe (`/api/ready`), and
  denial-of-wallet defenses including a signed spend-management auto-pause kill-switch.
- **Field-deployment PWA** (`/deploy`) — offline-first, installable; crews claim batches of
  `sorted` signs under an exclusive lock and mark them deployed with an optional photo, working
  with no network and syncing on reconnect (IndexedDB outbox over the `/api/native/*` JSON API).
  Device-adaptive layout — a full-screen field flow on phones, a multi-column console on desktop.
- **Admin & user management** — add/role/deactivate users, clear test data or all signs behind a
  typed confirmation, with destructive actions written to an audit log. A **login audit history**
  (admin-only Logins tab) records successful and denied sign-ins with coarse location and device,
  auto-purged after 90 days by a scheduled job.

## In progress / planned

- **Sign-art rendering** — turning the finalized sign list into print-ready art. Everything around
  the render is now in place (batches, per-size manifests, the handoff CSV, Figma preview import,
  and the reconcile pass); the print-ready art rendering step itself is the most complex remaining
  piece.
- **Production deployment** — finalizing the production hosting environment.

## Deferred

- **Native iOS client** — designed against the same `/api/native/*` API the deploy PWA uses, but
  deferred. The web PWA is the con-critical deliverable and ships without it.

## Notes

A tokenized one-time-invitation-link flow is intentionally parked as redundant — closed
registration plus magic-link sign-in already cover inviting a teammate (add them on `/users`, they
receive a sign-in link).
