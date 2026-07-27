-- Reference data the signs UI depends on: canonical tags + zones.
-- Idempotent: re-running re-asserts name/color/zone fields without duplicating.
-- Column names are the snake_case DB columns (Prisma @map), not the camelCase
-- client fields. Run: npx prisma db execute --file prisma/seeds/reference-data.sql

-- ---- Sign tags (11 canonical) -------------------------------------------------
INSERT INTO "sign_tags" ("name", "slug", "color") VALUES
  ('Priority',     'priority',     '#EF4444'),
  ('Rotating',     'rotating',     '#F59E0B'),
  ('Sponsor',      'sponsor',      '#8B5CF6'),
  ('Registration', 'registration', '#06B6D4'),
  ('Contest',      'contest',      '#EC4899'),
  ('Village',      'village',      '#10B981'),
  ('Stage',        'stage',        '#3B82F6'),
  ('Wayfinding',   'wayfinding',   '#14B8A6'),
  ('Bar',          'bar',          '#F97316'),
  ('Chillout',     'chillout',     '#A78BFA'),
  ('Vendor',       'vendor',       '#22C55E'),
  -- Added for DC33 sign-sheet section -> tag mapping
  ('Party',        'party',        '#D946EF'),
  ('Workshop',     'workshop',     '#0EA5E9'),
  ('Community',    'community',     '#84CC16'),
  ('Command Map',  'command-map',  '#64748B'),
  ('Flying Sign',  'flying-sign',  '#FB7185'),
  ('Banner',       'banner',       '#F472B6'),
  ('Meter Board',  'meterboard',   '#94A3B8'),
  ('Venue Map',    'venue-map',    '#2DD4BF'),
  -- Added for DC34 master department -> tag mapping
  ('Training',     'training',     '#6366F1'),
  ('Goon',         'goon',         '#475569'),
  ('Demo Labs',    'demo-labs',    '#7C3AED'),
  ('EAC',          'eac',          '#DB2777'),
  ('Talks',        'talks',        '#2563EB'),
  ('NFO',          'nfo',          '#CA8A04'),
  ('A&E',          'a-e',          '#EA580C'),
  -- All-venue standing signs (QM stock pile): Code of Conduct, Hotline, venue
  -- maps, etc. — the non-space bulk layer seeded by all-venue-signs.sql.
  ('All-Venue',    'all-venue',    '#0891B2'),
  -- Workflow status: a space whose live-sheet signage request is still a
  -- "confirm with <person>" TODO (sign list not finalized). Filterable in the UI;
  -- cleared as items get confirmed.
  ('Needs Confirmation', 'needs-confirmation', '#DC2626'),
  -- SYSTEM tag (M18): provenance marker for signs sourced from Nikita's master
  -- Google Sheet. Reconcile scopes to it; the app hides it from the user tag
  -- editor / filter chips (lib/tags.ts) so it can't be accidentally cleared.
  ('Master Sheet', 'master-sheet', '#334155')
ON CONFLICT ("slug") DO UPDATE
  SET "name"  = EXCLUDED."name",
      "color" = EXCLUDED."color";

-- ---- Zones (LVCC West: 3 levels + Halls 1-4; LVCC North: North Hall) ----------
INSERT INTO "zones"
  ("zone_code", "zone_name", "building", "floor", "deployment_priority", "is_active")
VALUES
  ('LVCC-L1', 'LVCC West — Level 1', 'LVCC West', '1', 1, true),
  ('LVCC-L2', 'LVCC West — Level 2', 'LVCC West', '2', 2, true),
  ('LVCC-L3', 'LVCC West — Level 3', 'LVCC West', '3', 3, true),
  -- Halls 1-4 (Level 1 exhibition halls) as their own zones. Distinct
  -- priorities (4-7) so they sort after the levels in priority-ordered UI.
  ('LVCC-H1', 'LVCC West — Hall 1', 'LVCC West', '1', 4, true),
  ('LVCC-H2', 'LVCC West — Hall 2', 'LVCC West', '1', 5, true),
  ('LVCC-H3', 'LVCC West — Hall 3', 'LVCC West', '1', 6, true),
  ('LVCC-H4', 'LVCC West — Hall 4', 'LVCC West', '1', 7, true),
  -- North Hall: the separate LVCC building across the tram (Diamond ballrooms +
  -- N2xx workshop/training rooms). One zone; everything there is Level 2.
  ('LVCC-NH', 'North Hall', 'LVCC North', '2', 8, true)
ON CONFLICT ("zone_code") DO UPDATE
  SET "zone_name"           = EXCLUDED."zone_name",
      "building"            = EXCLUDED."building",
      "floor"              = EXCLUDED."floor",
      "deployment_priority" = EXCLUDED."deployment_priority",
      "is_active"           = true;
