-- Backfill Location.floor_map_id for rooms created before rooms attached to a
-- floor map directly (they were keyed by zone only). Idempotent: only fills
-- NULLs. Picks the lowest-sortOrder map for the room's zone if several share it.
-- Run once per environment: npx prisma db execute --file prisma/seeds/backfill-room-floor-maps.sql

UPDATE "locations" l
SET "floor_map_id" = (
  SELECT fm.id
  FROM "floor_maps" fm
  WHERE fm."zone_id" = l."zone_id"
  ORDER BY fm."sort_order" ASC, fm.id ASC
  LIMIT 1
)
WHERE l."floor_map_id" IS NULL
  AND l."zone_id" IS NOT NULL;
