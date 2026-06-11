-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SignStatus" ADD VALUE 'handed_off';
ALTER TYPE "SignStatus" ADD VALUE 'installed';

-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "delivery_condition" TEXT,
ADD COLUMN     "delivery_photo_url" TEXT,
ADD COLUMN     "handed_off_at" TIMESTAMP(3),
ADD COLUMN     "handed_off_by" TEXT,
ADD COLUMN     "handed_off_to" TEXT,
ADD COLUMN     "handoff_notes" TEXT,
ADD COLUMN     "handoff_photo_url" TEXT,
ADD COLUMN     "installed_at" TIMESTAMP(3),
ADD COLUMN     "installed_by" TEXT,
ADD COLUMN     "received_qty" INTEGER;
