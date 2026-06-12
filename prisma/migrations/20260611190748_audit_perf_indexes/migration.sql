-- CreateIndex
CREATE INDEX "signs_status_deploy_by_date_idx" ON "signs"("status", "deploy_by_date");

-- CreateIndex
CREATE INDEX "signs_status_updated_at_idx" ON "signs"("status", "updated_at");
