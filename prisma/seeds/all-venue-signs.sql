-- All-venue standing signs: the non-space bulk layer every con needs but the
-- space roster (master import) never produces — Code of Conduct, Photography
-- Policy, GOON ONLY, Hotline, venue maps, etc. (~66 of DC33's 100 × 24"×36").
--
-- Each standing sign is now its OWN qty-1 row (not one row with a quantity), so the
-- app's counts reflect the true number of physical signs and each can be handled /
-- checked out of QM individually. The /signs + inventory UIs collapse the identical
-- rows of each pile back under one expandable header. generate_series expands every
-- pile into N numbered rows (AV-COC-01 … AV-COC-10). 97 rows across 9 groups.
--
-- Seeded as REAL signs (is_test_data = false) so a prod reload re-creates the QM
-- pile. Idempotent WITHOUT a delete: each row is keyed by a deterministic numbered
-- item_id (AV-*-NN) and inserted only WHERE NOT EXISTS, so a re-run is a no-op and
-- never clobbers in-app edits (unlike the test-data seed, which deletes-then-reinserts).
-- Run: npx prisma db execute --file prisma/seeds/all-venue-signs.sql

INSERT INTO "signs" (
  "item_id", "sign_text", "sign_type", "size", "quantity",
  "category", "needs_easel", "printable", "placement_area",
  "notes", "is_test_data", "updated_at"
)
SELECT
  v.item_id || '-' || LPAD(g.n::text, 2, '0'),
  v.sign_text, v.sign_type, v.size, 1,
  v.category::"SignCategory", v.needs_easel, v.printable, 'Scattered / all-venue',
  v.note, false, NOW()
FROM (VALUES
  ('AV-COC',     'Code of Conduct',             '24"x36"', '24"x36"', 10, 'easel_sign', true,  true, 'Posted at every entrance / high-traffic point.'),
  ('AV-PHOTO',   'Photography Policy',          '24"x36"', '24"x36"', 10, 'easel_sign', true,  true, 'Posted where photography is restricted.'),
  ('AV-NOENTRY', 'No Entry, Exit Only',         '24"x36"', '24"x36"', 10, 'easel_sign', true,  true, 'Door / corridor flow control.'),
  ('AV-GOON',    'GOON ONLY Beyond This Point', '24"x36"', '24"x36"', 15, 'easel_sign', true,  true, 'Staff-only boundary marker.'),
  ('AV-HOTLINE', 'DEF CON Hotline',             '24"x36"', '24"x36"', 20, 'easel_sign', true,  true, 'Posted widely so the hotline number is always visible.'),
  ('AV-AREAMAP', 'LVCC Area Map (info / QM)',   '24"x36"', '24"x36"',  3, 'easel_sign', true,  true, 'Orientation map for info desks / QM.'),
  ('AV-NFOMAP',  'NFO No-Frills Venue Map',     '24"x36"', '24"x36"', 16, 'ops_map',    false, true, 'No-Frills Operations per-booth orientation map.'),
  ('AV-LEADMAP', 'Printed Venue Maps (team leads)',                '24"x36" printed', '24"x36" printed', 10, 'ops_map', false, true, 'Handheld printed map for team leads.'),
  ('AV-OPSMAP',  'No-Frills Venue Map (SOC / Hotline / Dispatch)', '4''x8'' printed', '4''x8'' printed',  3, 'ops_map', false, true, 'Large printed map for SOC / Hotline / Dispatch.')
) AS v(item_id, sign_text, sign_type, size, qty, category, needs_easel, printable, note)
CROSS JOIN LATERAL generate_series(1, v.qty) AS g(n)
WHERE NOT EXISTS (
  SELECT 1 FROM "signs" s
  WHERE s."item_id" = v.item_id || '-' || LPAD(g.n::text, 2, '0')
);

-- Tag every all-venue sign so QM can filter the pile. Idempotent on the
-- (sign_id, tag_id) composite PK; assumes the 'all-venue' tag exists
-- (reference-data.sql). The numbered item_ids still match 'AV-%'.
INSERT INTO "sign_tag_assignments" ("sign_id", "tag_id")
SELECT s."id", t."id"
FROM "signs" s, "sign_tags" t
WHERE s."item_id" LIKE 'AV-%'
  AND t."slug" = 'all-venue'
ON CONFLICT DO NOTHING;
