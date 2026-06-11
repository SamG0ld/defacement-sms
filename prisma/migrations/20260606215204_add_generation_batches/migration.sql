-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "generation_batch_id" INTEGER;

-- CreateTable
CREATE TABLE "generation_batches" (
    "id" SERIAL NOT NULL,
    "label" TEXT,
    "pipeline" TEXT NOT NULL DEFAULT 'figma-mcp',
    "figma_url" TEXT,
    "sign_count" INTEGER NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_by_email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_batches_created_at_idx" ON "generation_batches"("created_at");

-- CreateIndex
CREATE INDEX "signs_generation_batch_id_idx" ON "signs"("generation_batch_id");

-- AddForeignKey
ALTER TABLE "signs" ADD CONSTRAINT "signs_generation_batch_id_fkey" FOREIGN KEY ("generation_batch_id") REFERENCES "generation_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
