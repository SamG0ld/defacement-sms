-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "map_x" DOUBLE PRECISION,
ADD COLUMN     "map_y" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "location_id" INTEGER,
ADD COLUMN     "map_floor" TEXT,
ADD COLUMN     "map_x" DOUBLE PRECISION,
ADD COLUMN     "map_y" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "signs_location_id_idx" ON "signs"("location_id");

-- AddForeignKey
ALTER TABLE "signs" ADD CONSTRAINT "signs_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
