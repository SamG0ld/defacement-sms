-- Backfill Sign.exact_destination from item_id for master-sheet-sourced signs.
-- The exact_destination column already existed (init migration); this one-time
-- DATA step populates existing rows so the DC34 "Room" export column is filled.
-- Idempotent (NULL-guarded) and scoped to the `master-sheet` provenance tag, so
-- all-venue / hand-added signs are never touched. New imports + reconcile set the
-- room at insert time (app/(app)/signs/import/_parsers/master.ts), so this only
-- backfills legacy rows created before that change.
UPDATE "signs" s
SET "exact_destination" = s."item_id"
WHERE s."exact_destination" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "sign_tag_assignments" sta
    JOIN "sign_tags" t ON t."id" = sta."tag_id"
    WHERE sta."sign_id" = s."id"
      AND t."slug" = 'master-sheet'
  );
