-- Sample signs so /signs isn't empty during local verification.
-- All rows flagged is_test_data=true and removed first, so this seed is safely
-- re-runnable (the delete cascades to status_history + tag assignments).
-- Zone + tag FKs resolved by code so we don't depend on autoincrement ids.
-- Run: npx prisma db execute --file prisma/seeds/sample-signs.sql

DELETE FROM "signs" WHERE "is_test_data" = true;

INSERT INTO "signs" (
  "item_id", "sign_text", "sign_type", "size", "quantity",
  "double_sided", "needs_easel", "placement_area", "zone_id",
  "deployment_priority", "deployment_slot", "cost_per_unit", "total_cost",
  "status", "requestor", "notes", "is_test_data", "updated_at"
) VALUES
  ('DC-101', 'Registration This Way', '24"x36"', '24"x36"', 2,
   true, true, 'West Hall main entrance',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L1'),
   1, 'THU_AM', 18.00, 36.00,
   'pending', 'reg-team', 'Double-sided, faces both directions.', true, NOW()),

  ('DC-102', 'Talks — Track 1', '22"x28"', '22"x28"', 1,
   false, true, 'Level 2 corridor',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L2'),
   2, 'THU_PM', 12.50, 12.50,
   'printed', 'content-team', NULL, true, NOW()),

  ('DC-103', 'Capture The Flag', 'Socks', 'Socks', 1,
   false, false, 'Contest area',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L3'),
   1, 'FRI_AM', 18.00, 18.00,
   'delivered', 'ctf-team', 'Hang near the CTF entrance.', true, NOW()),

  ('DC-104', 'Chillout Lounge', '22"x28"', '22"x28"', 3,
   false, false, 'Level 1 atrium',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L1'),
   3, 'FRI_PM', 8.00, 24.00,
   'deployed', 'ops', NULL, true, NOW()),

  ('DC-105', 'Vendor Hall', 'Banner', 'Banner', 1,
   false, false, 'West Hall vendor entrance',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L2'),
   2, 'SAT_AM', 65.00, 65.00,
   'pending', 'vendor-team', 'Large banner — confirm rigging.', true, NOW()),

  ('DC-106', 'Sponsor Stage', 'Meterboard (4''x8'')', '4''x8'' Double', 1,
   true, false, 'Main stage backdrop',
   (SELECT "id" FROM "zones" WHERE "zone_code" = 'LVCC-L3'),
   1, 'SAT_PM', 45.00, 45.00,
   'printed', 'sponsor-team', NULL, true, NOW());

-- A couple of tag assignments so the tag filter has something to match.
INSERT INTO "sign_tag_assignments" ("sign_id", "tag_id")
SELECT s."id", t."id"
FROM "signs" s, "sign_tags" t
WHERE s."is_test_data" = true
  AND (
    (s."item_id" = 'DC-101' AND t."slug" IN ('priority', 'registration', 'wayfinding')) OR
    (s."item_id" = 'DC-103' AND t."slug" IN ('contest', 'priority')) OR
    (s."item_id" = 'DC-104' AND t."slug" IN ('chillout', 'wayfinding')) OR
    (s."item_id" = 'DC-105' AND t."slug" IN ('vendor')) OR
    (s."item_id" = 'DC-106' AND t."slug" IN ('sponsor', 'stage', 'rotating'))
  )
ON CONFLICT DO NOTHING;
