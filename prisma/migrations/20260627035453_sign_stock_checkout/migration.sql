-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "quantity_taken" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sign_stock_checkouts" (
    "id" SERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "sign_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "by_user_id" TEXT,
    "by_email" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_stock_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_stock_checkouts_client_id_key" ON "sign_stock_checkouts"("client_id");

-- CreateIndex
CREATE INDEX "sign_stock_checkouts_sign_id_idx" ON "sign_stock_checkouts"("sign_id");

-- CreateIndex
CREATE INDEX "sign_stock_checkouts_created_at_idx" ON "sign_stock_checkouts"("created_at");
