-- M17 #97: drop the dead SignTemplate model + 9 legacy PSD-pipeline columns.
-- These had zero application code (the live pipeline is Figma — generationPipeline /
-- figmaInstanceNodeId / previewImagePath / generationBatchId are kept).

-- DropForeignKey
ALTER TABLE "signs" DROP CONSTRAINT "signs_template_id_fkey";

-- DropIndex
DROP INDEX "signs_template_id_idx";

-- AlterTable
ALTER TABLE "signs"
  DROP COLUMN "template_id",
  DROP COLUMN "psd_generated",
  DROP COLUMN "psd_filepath",
  DROP COLUMN "psd_approved",
  DROP COLUMN "fitted_text",
  DROP COLUMN "calculated_font_size",
  DROP COLUMN "legibility_score",
  DROP COLUMN "needs_manual_review",
  DROP COLUMN "export_pdf_path",
  DROP COLUMN "generation_error";

-- DropTable
DROP TABLE "sign_templates";
