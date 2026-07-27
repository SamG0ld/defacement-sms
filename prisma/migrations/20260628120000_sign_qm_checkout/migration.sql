-- QM stock check-out rework (#112 -> individual rows + UI grouping).
-- Replace the per-Sign quantity_taken counter with a per-row QM checkout flag, and
-- reshape the idempotency ledger from per-sign (sign_id) to per-group (group_key).

-- AlterTable: signs -- drop the counter, add the per-row QM checkout flag.
ALTER TABLE "signs" DROP COLUMN "quantity_taken";
ALTER TABLE "signs" ADD COLUMN     "qm_taken_at" TIMESTAMP(3);
ALTER TABLE "signs" ADD COLUMN     "qm_taken_by" TEXT;

-- CreateIndex: "remaining at QM" / candidate-row selection filters by qm_taken_at IS NULL.
CREATE INDEX "signs_qm_taken_at_idx" ON "signs"("qm_taken_at");

-- Data: drop the legacy #112 "combined" all-venue rows (one row with quantity > 1).
-- The new model is one row per physical sign, so these stale rows would be counted as
-- a single sign and double-count once the individual-row all-venue seed runs. They
-- are the only quantity > 1 rows in prod (the all-venue pile is exactly the ~88-unit
-- gap between the row count and the print-summary unit total). Scoped to AV-% so it
-- can only remove rows the all-venue reseed re-creates.
-- IMPORTANT: on an EXISTING database this migration MUST be followed by
-- `prisma/seeds/all-venue-signs.sql` to re-create the 97 individual rows; otherwise
-- the QM pile is left empty. No-op on a fresh DB (signs is empty at migrate time).
DELETE FROM "signs" WHERE "item_id" LIKE 'AV-%' AND "quantity" > 1;

-- AlterTable: sign_stock_checkouts -- per-sign ledger -> per-group batch ledger.
-- The old rows keyed a single sign_id under the #112 per-sign counter model, which no
-- longer exists; a group_key can't be derived for them, so clear the table (it is a
-- clientId idempotency guard, not user-facing -- see schema comment).
-- Apply this migration during a QM lull, not mid-dispatch: the TRUNCATE drops any
-- in-flight clientId, so a replay arriving right after the deploy could double-apply.
TRUNCATE TABLE "sign_stock_checkouts";
DROP INDEX "sign_stock_checkouts_sign_id_idx";
ALTER TABLE "sign_stock_checkouts" DROP COLUMN "sign_id";
ALTER TABLE "sign_stock_checkouts" ADD COLUMN     "group_key" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "sign_stock_checkouts_group_key_idx" ON "sign_stock_checkouts"("group_key");
