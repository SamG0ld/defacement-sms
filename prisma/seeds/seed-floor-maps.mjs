// Seed the venue floor maps into the floor_maps table from the bundled source
// PNGs in prisma/seeds/floor-maps/. Image bytes go into a Postgres bytea column,
// which a hand-written .sql seed can't carry cleanly — so this is a small Node
// script using `pg` (already a dependency) with the buffer as a bytea parameter.
//
// Idempotent: upserts by `key`. Re-running refreshes the image + metadata but
// preserves an admin's `enabled` choice (so a disabled map stays disabled).
//
// Run (loads DATABASE_URL from .env via dotenv):
//   node prisma/seeds/seed-floor-maps.mjs
// Portable to staging/prod — run the same script there against that DATABASE_URL.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// The stable LVCC West levels. zoneCode links each map to its deployment zone so
// a sign's default floor can be derived from its zone (see lib/sign-pin.ts).
const MAPS = [
  { key: "lvcc-west-l1", label: "LVCC West — Level 1", floor: "1", zoneCode: "LVCC-L1", sortOrder: 1 },
  { key: "lvcc-west-l2", label: "LVCC West — Level 2", floor: "2", zoneCode: "LVCC-L2", sortOrder: 2 },
  { key: "lvcc-west-l3", label: "LVCC West — Level 3", floor: "3", zoneCode: "LVCC-L3", sortOrder: 3 },
];

// Read width/height straight from the PNG IHDR (bytes 16–23, big-endian uint32).
// Advisory metadata only — pins are percentages, so exact pixels don't matter.
function pngDimensions(buf) {
  const isPng =
    buf.length > 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return { width: null, height: null };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const m of MAPS) {
      const bytes = readFileSync(join(here, "floor-maps", `${m.key}.png`));
      const { width, height } = pngDimensions(bytes);

      const zone = await client.query(
        `SELECT id, building FROM "zones" WHERE "zone_code" = $1`,
        [m.zoneCode],
      );
      if (zone.rowCount === 0) {
        throw new Error(
          `Zone ${m.zoneCode} not found — run prisma/seeds/reference-data.sql first.`,
        );
      }
      const zoneId = zone.rows[0].id;
      const building = zone.rows[0].building ?? "LVCC West";

      await client.query(
        `INSERT INTO "floor_maps"
           ("key", "label", "building", "floor", "zone_id",
            "image_data", "content_type", "width", "height", "sort_order", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT ("key") DO UPDATE SET
           "label"        = EXCLUDED."label",
           "building"     = EXCLUDED."building",
           "floor"        = EXCLUDED."floor",
           "zone_id"      = EXCLUDED."zone_id",
           "image_data"   = EXCLUDED."image_data",
           "content_type" = EXCLUDED."content_type",
           "width"        = EXCLUDED."width",
           "height"       = EXCLUDED."height",
           "sort_order"   = EXCLUDED."sort_order",
           "updated_at"   = NOW()`,
        [m.key, m.label, building, m.floor, zoneId,
         bytes, "image/png", width, height, m.sortOrder],
      );
      console.log(`seeded ${m.key} (${bytes.length} bytes, ${width}x${height}, zone ${m.zoneCode})`);
    }
    console.log(`done — ${MAPS.length} floor maps.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("seed-floor-maps failed:", err);
  process.exit(1);
});
