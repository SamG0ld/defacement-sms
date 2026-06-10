-- Canonical equipment/material types for /inventory. Idempotent on the unique
-- name. Run:  npx prisma db execute --file prisma/seeds/equipment-types.sql
--
-- Three kinds, derived from `category` (see lib/equipment.ts classifyKind):
--   * asset         (category Easel/Meterboard/Stand/Banner) — durable, reconciled
--   * sign_material (category 'Sign Material')               — history-only, derived live
--   * consumable    (anything else, here 'Consumable')       — user-managed restock list

-- Rename fix: the bulk easel was mis-transcribed as "Spider Easels" ("spider" is
-- the meterboard foot, not an easel). Run first so existing DBs migrate the row
-- (keeping its id + history) instead of the INSERT below creating a duplicate.
UPDATE "equipment_types" SET "name" = 'Tent Pole Easels' WHERE "name" = 'Spider Easels';

-- ---- Durable assets (reconciled: need vs have vs gap) --------------------------
INSERT INTO "equipment_types" ("name", "category") VALUES
  -- Easels (silver tripod + black leg tripod + tent pole; tent pole is the bulk)
  ('Tent Pole Easels',           'Easel'),
  ('Black Leg Tripod Easels',    'Easel'),
  ('Silver Tripod Easels',       'Easel'),
  -- Meterboards
  ('Screw Meterboards',          'Meterboard'),
  ('Bowtie Meterboards',         'Meterboard'),
  ('Spider-Foot Meterboards',    'Meterboard'),
  ('Railroad-Tie Meterboards',   'Meterboard'),
  ('Cardboard Meterboards',      'Meterboard'),
  -- Stands
  ('U-Shaped Sock Stands',       'Stand'),
  ('Selfie Walls',               'Stand'),
  ('Sticker Wall Bases',         'Stand'),
  ('Selfie Banner Stands',       'Stand'),
  -- Banners
  ('CTF Selfie Banner',          'Banner'),
  -- Sign-material print totals (history-only; live counts come from the sign list)
  ('Signs 22x28',                'Sign Material'),
  ('Signs 24x36',                'Sign Material'),
  ('Meterboard Signs (Single)',  'Sign Material'),
  ('Meterboard Signs (Double)',  'Sign Material'),
  ('Floor Graphics',             'Sign Material'),
  ('Easels Required',            'Sign Material'),
  -- Consumables (restock list). PROPOSED set — edit in-app to match reality.
  ('Bolts',                      'Consumable'),
  ('Nuts',                       'Consumable'),
  ('Washers',                    'Consumable'),
  ('Wing Nuts',                  'Consumable'),
  ('Zip Ties',                   'Consumable'),
  ('Gaffer Tape',                'Consumable'),
  ('Painter''s Tape',            'Consumable'),
  ('Double-Sided Tape',          'Consumable'),
  ('Velcro Straps',              'Consumable'),
  ('Bungee Cords',               'Consumable'),
  ('Sharpies',                   'Consumable'),
  ('Paracord',                   'Consumable')
ON CONFLICT ("name") DO NOTHING;

-- ---- Cleanup: drop legacy rows that duplicated the live print summary or that
-- ---- don't reflect how the team actually works. None of these carry any
-- ---- equipment_inventory history (see equipment-history.sql), so removing them
-- ---- is lossless. Re-categorize a pre-existing 'Zip Ties' (was 'Supplies').
DELETE FROM "equipment_types"
WHERE "name" IN (
  'Easels',                      -- rollup, duplicated by Easel category + derived need
  'Meter Boards',                -- rollup, duplicated by Meterboard category + derived need
  'Foamcore Stock (4x8 sheets)', -- not tracked as inventory
  'Command Strips',              -- not used
  'Banners',                     -- print material, counted live by the print summary
  'Flying Signs (Socks)'         -- print material, counted live by the print summary
);

UPDATE "equipment_types" SET "category" = 'Consumable'
WHERE "name" = 'Zip Ties' AND "category" IS DISTINCT FROM 'Consumable';
