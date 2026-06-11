-- CreateEnum
CREATE TYPE "SignCategory" AS ENUM ('easel_sign', 'meterboard', 'socks', 'ops_map', 'union_installed', 'other');

-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "category" "SignCategory" NOT NULL DEFAULT 'other',
ADD COLUMN     "printable" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "signs_category_idx" ON "signs"("category");

-- Backfill: derive `category` from `size` for existing rows. Mirrors the precedence
-- in lib/print-summary.ts categoryFromSize (first match wins). Non-destructive:
-- rows that match nothing keep the `other` default.
UPDATE "signs" SET "category" = CASE
  WHEN "size" ~* 'printed'                       THEN 'ops_map'::"SignCategory"
  WHEN "size" ~* 'sock|21\s*"?\s*x\s*42|flying'  THEN 'socks'::"SignCategory"
  WHEN "size" ~* '8''?\s*x\s*20|banner'          THEN 'union_installed'::"SignCategory"
  WHEN "size" ~* 'floor graphic|wall graphic|sticker wall' THEN 'union_installed'::"SignCategory"
  WHEN "size" ~* '22\s*"?\s*x\s*28'              THEN 'easel_sign'::"SignCategory"
  WHEN "size" ~* '24\s*"?\s*x\s*36'              THEN 'easel_sign'::"SignCategory"
  WHEN "size" ~* 'meter\s*board|4''?\s*x\s*8'    THEN 'meterboard'::"SignCategory"
  ELSE 'other'::"SignCategory"
END;

-- Bare-easel rows ("(easels only)") need easels but print nothing -> not printable.
UPDATE "signs" SET "printable" = false WHERE "sign_text" ~* 'easels?\s*only';
