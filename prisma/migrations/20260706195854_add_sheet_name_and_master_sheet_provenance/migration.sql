-- AlterTable: the master sheet's stable Name identifier (M18 reconcile matches on
-- item_id + sheet_name). NULL for non-sheet signs. IF NOT EXISTS so the whole
-- migration is re-runnable (it's hand-applied to Neon on the paved prod path).
ALTER TABLE "signs" ADD COLUMN IF NOT EXISTS "sheet_name" TEXT;

-- ---------------------------------------------------------------------------
-- Data migration (M18 provenance). Idempotent so it is safe to re-run.
-- ---------------------------------------------------------------------------

-- 1. Seed the `master-sheet` system tag (hidden from the user tag editor; the
--    reconcile flow scopes to it). Mirrors prisma/seeds/reference-data.sql.
INSERT INTO "sign_tags" ("name", "slug", "color")
VALUES ('Master Sheet', 'master-sheet', '#334155')
ON CONFLICT ("slug") DO NOTHING;

-- 2. Backfill: every existing REAL sign that is NOT an all-venue standing sign came
--    from the master sheet, so seed its sheet_name from the current sign_text (the
--    printed text and the Name were the same before this split). Only fills NULLs,
--    so re-running never clobbers a set value. Test fixtures are excluded — reconcile
--    only ever considers real signs.
UPDATE "signs" s
SET "sheet_name" = s."sign_text"
WHERE s."sheet_name" IS NULL
  AND s."is_test_data" = false
  AND NOT EXISTS (
    SELECT 1
    FROM "sign_tag_assignments" a
    JOIN "sign_tags" t ON t."id" = a."tag_id"
    WHERE a."sign_id" = s."id" AND t."slug" = 'all-venue'
  );

-- 3. Assign the `master-sheet` tag to those same (real, non-all-venue) signs so they
--    are in scope for reconcile. ON CONFLICT keeps it idempotent.
INSERT INTO "sign_tag_assignments" ("sign_id", "tag_id")
SELECT s."id", mt."id"
FROM "signs" s
CROSS JOIN (SELECT "id" FROM "sign_tags" WHERE "slug" = 'master-sheet') mt
WHERE s."is_test_data" = false
  AND NOT EXISTS (
    SELECT 1
    FROM "sign_tag_assignments" a
    JOIN "sign_tags" t ON t."id" = a."tag_id"
    WHERE a."sign_id" = s."id" AND t."slug" = 'all-venue'
  )
ON CONFLICT ("sign_id", "tag_id") DO NOTHING;
