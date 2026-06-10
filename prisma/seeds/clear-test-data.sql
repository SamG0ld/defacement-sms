-- Remove sample/test signs once you're done testing, BEFORE or AFTER importing
-- real data — they're disjoint sets. Only deletes rows flagged is_test_data=true
-- (the sample-signs.sql seed); imported and hand-created signs (is_test_data=false)
-- are untouched. Cascades to status_history + tag assignments.
--   npx prisma db execute --file prisma/seeds/clear-test-data.sql
DELETE FROM "signs" WHERE "is_test_data" = true;
