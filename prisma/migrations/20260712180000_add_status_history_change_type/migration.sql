-- Add a change-type discriminator to status_history so it can record format
-- changes on the same per-sign timeline as status changes. Existing rows are all
-- status changes, so the NOT NULL DEFAULT 'status' backfills them correctly with
-- no data loss. "format" rows reuse old_status/new_status to carry the from/to
-- format labels; the render layer branches on change_type.
ALTER TABLE "status_history" ADD COLUMN "change_type" TEXT NOT NULL DEFAULT 'status';
