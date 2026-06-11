-- AlterTable
ALTER TABLE "status_history" ADD COLUMN     "client_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "status_history_client_id_key" ON "status_history"("client_id");
