-- DropIndex
DROP INDEX "users_email_idx";

-- CreateIndex
CREATE INDEX "locations_zone_id_idx" ON "locations"("zone_id");

-- CreateIndex
CREATE INDEX "sign_tag_assignments_tag_id_idx" ON "sign_tag_assignments"("tag_id");

-- CreateIndex
CREATE INDEX "signs_status_deployment_priority_item_id_idx" ON "signs"("status", "deployment_priority", "item_id");

-- CreateIndex
CREATE INDEX "signs_zone_id_deployment_priority_item_id_idx" ON "signs"("zone_id", "deployment_priority", "item_id");
