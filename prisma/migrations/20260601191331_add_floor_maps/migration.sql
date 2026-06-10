-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "floor_map_id" INTEGER;

-- CreateTable
CREATE TABLE "floor_maps" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "building" TEXT,
    "floor" TEXT,
    "zone_id" INTEGER,
    "image_data" BYTEA NOT NULL,
    "content_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floor_maps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "floor_maps_key_key" ON "floor_maps"("key");

-- CreateIndex
CREATE INDEX "floor_maps_zone_id_idx" ON "floor_maps"("zone_id");

-- CreateIndex
CREATE INDEX "floor_maps_enabled_sort_order_idx" ON "floor_maps"("enabled", "sort_order");

-- CreateIndex
CREATE INDEX "locations_floor_map_id_idx" ON "locations"("floor_map_id");

-- AddForeignKey
ALTER TABLE "floor_maps" ADD CONSTRAINT "floor_maps_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_floor_map_id_fkey" FOREIGN KEY ("floor_map_id") REFERENCES "floor_maps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
