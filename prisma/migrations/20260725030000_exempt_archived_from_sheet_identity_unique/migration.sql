-- Supersedes the predicate created by 20260724120000_add_signs_sheet_identity_unique.
--
-- WHY THIS EXISTS: that migration's index refused a shape the app produces on purpose.
-- `archived` is a soft-removal tombstone for the DC34 add/remove/move engine, retained
-- so a removal stays reversible. Remove a sign, let the sheet re-add it, and you get
-- exactly one tombstone plus one live row sharing an identity — the INTENDED end
-- state, not a double create. The original index failed to build against two such
-- pairs (Postgres 23505), leaving a failed migration row and a P3009 restart
-- loop. "Fixing" that by deleting the tombstones would destroy
-- the undo the per-size engine is built on, so the predicate is what changes.
--
-- The guard #228 actually exists for is untouched: the concurrent/repeat reconcile
-- apply race inserts rows with status 'pending' (signs/reconcile/actions.ts), so both
-- racers are non-archived, still collide, and are still blocked.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING 20260724120000: `migrate deploy` keys on the
-- migration FOLDER NAME, not the file's contents. Editing an already-applied migration
-- in place is a silent no-op — deploy reports "No pending migrations to apply", exits
-- 0, and leaves the old index. Verified end-to-end: a DB that had applied the original
-- kept `WHERE ((is_test_data = false) AND (sheet_name IS NOT NULL))` after deploying an
-- amended file, with no error and no checksum complaint. CI would not catch it either,
-- because CI builds a fresh database every run and applies the amended body first-time.
--
-- BUILD-THEN-SWAP, NOT DROP-THEN-CREATE. This is the important part.
--
-- Prisma's migration engine splits this file on `;` and runs each statement in
-- AUTOCOMMIT — there is no enclosing transaction. So a naive
--   DROP INDEX old; CREATE UNIQUE INDEX old (new predicate);
-- has the DROP **commit on its own**, and any failure of the CREATE leaves the table
-- with NO index of this name at all — the constraint fully removed, not half-built.
-- Reproduced twice against a real database. Two ways that CREATE realistically fails:
--   1. genuine duplicate live rows (what the troubleshooting query at the bottom finds);
--   2. the `lock_timeout` below — `CREATE UNIQUE INDEX` queues for its SHARE lock
--      behind an in-flight reconcile apply (which can hold a `signs` transaction for up
--      to 30s per APPLY_TX_OPTIONS) and times out at 5s on its own. The fail-fast guard
--      becomes the trigger. (Measured: this is independent of any preceding DROP — a
--      `DROP INDEX IF EXISTS` on an absent index takes no table lock and returns in
--      ~1ms even while another session holds SHARE ROW EXCLUSIVE on `signs`.)
-- Where `migrate deploy` runs automatically at container start, that surfaces loudly
-- (P3009 restart loop, app down, no writes possible). Where migrations are instead run
-- by hand against the managed Postgres while the app is live (DEPLOY.md), it does not:
-- the app stays UP and serving writes with this guard silently absent, no alert and no
-- symptom. It does not self-heal — recovery is hand-reconciling prod data before any
-- retry can succeed.
--
-- So: build the replacement under a temporary name FIRST, and only swap once it is
-- known good. Where the old index exists it stays live and enforcing for the whole
-- build, and during the overlap the STRICTER predicate applies, so nothing can slip
-- through the seam. (Measured: DROP INDEX takes ACCESS EXCLUSIVE on the table, ALTER
-- INDEX ... RENAME takes ShareUpdateExclusive on the index only — so at no instant of
-- the sequence below is the identity unenforced.) NOTE: on a database where
-- 20260724120000 was SKIPPED via `--applied` — which is the documented prod path, see
-- ORDERING NOTE below — there is no old index to stay live, so that property does not
-- hold there. Prod is unguarded today regardless, so this is still strictly an
-- improvement, and the CREATE's SHARE lock blocks writes while it builds.
-- If the CREATE fails, nothing has been dropped: the old index is intact, the real
-- 23505 detail is preserved in `_prisma_migrations.logs` for triage, and a retry is
-- clean (the leading `DROP ... IF EXISTS ..._new` plus the RESUME GUARD below make this
-- idempotent from any partial state). The trailing DROP + RENAME are catalog-only.
--
-- The interval between the old-name DROP and the RENAME is NOT a protection gap:
-- Postgres enforces on an index's DEFINITION, not its name, so `..._new` is live and
-- checked by every insert throughout that interval — it is simply wearing its temporary
-- name at the time.
--
-- (An explicit `BEGIN; ... COMMIT;` wrapper also closes the window and was verified to
-- work — Prisma does honor embedded transaction control. It was NOT chosen: a failure
-- inside it leaves `_prisma_migrations.logs` EMPTY and surfaces "current transaction is
-- aborted" instead of the root cause, which breaks step 1 of the P3009 runbook. It also
-- leans on an incidental behavior of the current engine rather than plain SQL.)
--
-- Still NOT `CONCURRENTLY`: a failed concurrent build leaves an INVALID index behind
-- that a later `IF NOT EXISTS` would silently accept, leaving the constraint
-- unenforced with no error.
--
-- ORDERING NOTE FOR A DATABASE THAT HAS NEVER RUN 20260724120000 (this includes PROD):
-- `migrate deploy` applies migrations in order, so 20260724120000 runs FIRST and will
-- fail with 23505 on any database that already holds a tombstone+live pair — and P3009
-- then blocks this migration from ever running. Pre-flight with the query at the bottom
-- of this file BEFORE deploying. If it returns rows only because of archived tombstones,
-- the supported move is to skip the superseded migration rather than delete real data:
--   npx prisma migrate resolve --applied 20260724120000_add_signs_sheet_identity_unique
-- then deploy, and this migration builds the correct index directly. That is why the
-- old-name DROP below is `IF EXISTS` — it must work whether or not 20260724120000 ever
-- created anything. See DEPLOY.md for the migration runbook.
--
-- If the CREATE below then fails on prod, it is reporting genuine LIVE duplicates (see
-- the query at the end). That leaves prod with no index of this name — which is the
-- status quo, not a regression, and it fails loudly at the operator's terminal. Fix the
-- duplicate rows and re-run; do NOT reach for `migrate resolve --applied` on THIS
-- migration, which would record the guard as installed when it is not.
--
-- AFTER APPLYING, VERIFY THE PREDICATE ACTUALLY CHANGED (this check is what catches a
-- silent no-op — `migrate deploy` reporting success is NOT proof):
--   SELECT indexdef FROM pg_indexes
--   WHERE indexname = 'signs_item_id_sheet_name_category_key';
--   -- expect: ... WHERE is_test_data = false AND sheet_name IS NOT NULL
--   --                AND status <> 'archived'::"SignStatus"
--
-- If the CREATE below fails, it is reporting two LIVE rows for one identity — a real
-- double-create to reconcile by hand. Find them with the same predicate the index uses:
--   SELECT item_id, sheet_name, category, COUNT(*), ARRAY_AGG(id)
--   FROM signs
--   WHERE is_test_data = false AND sheet_name IS NOT NULL AND status <> 'archived'
--   GROUP BY 1,2,3 HAVING COUNT(*) > 1;
SET lock_timeout = '5s';

-- RESUME GUARD — must come before the cleanup DROP below. If a previous attempt
-- died between "drop the old name" and "rename the new one into place", the only
-- index enforcing this identity is `..._key_new`. Restarting from the top would
-- then DROP that one — leaving the table genuinely unguarded, letting duplicates
-- land, and making the rebuild fail with no index at all and no self-heal. That is
-- the exact end state this migration's shape exists to prevent, so finish the
-- interrupted swap instead of restarting it. Inert in every other state: when
-- `..._key` exists this does nothing and the normal path below runs.
DO $$
BEGIN
  IF to_regclass('public.signs_item_id_sheet_name_category_key') IS NULL
     AND to_regclass('public.signs_item_id_sheet_name_category_key_new') IS NOT NULL THEN
    EXECUTE 'ALTER INDEX "signs_item_id_sheet_name_category_key_new"
             RENAME TO "signs_item_id_sheet_name_category_key"';
  END IF;
END $$;

DROP INDEX IF EXISTS "signs_item_id_sheet_name_category_key_new";

CREATE UNIQUE INDEX "signs_item_id_sheet_name_category_key_new"
  ON "signs" ("item_id", "sheet_name", "category")
  WHERE "is_test_data" = false
    AND "sheet_name" IS NOT NULL
    AND "status" <> 'archived';

DROP INDEX IF EXISTS "signs_item_id_sheet_name_category_key";

ALTER INDEX "signs_item_id_sheet_name_category_key_new"
  RENAME TO "signs_item_id_sheet_name_category_key";
