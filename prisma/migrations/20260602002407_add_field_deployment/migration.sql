-- AlterTable
ALTER TABLE "signs" ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by_crew_id" INTEGER,
ADD COLUMN     "claimed_by_user_id" TEXT,
ADD COLUMN     "deploy_photo_url" TEXT;

-- CreateTable
CREATE TABLE "crews" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_members" (
    "crew_id" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_members_pkey" PRIMARY KEY ("crew_id","user_id")
);

-- CreateTable
CREATE TABLE "deploy_events" (
    "id" SERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "sign_id" INTEGER NOT NULL,
    "crew_id" INTEGER,
    "deployed_by_user_id" TEXT,
    "deployed_by_email" TEXT,
    "deployed_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "photo_url" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deploy_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crews_is_active_idx" ON "crews"("is_active");

-- CreateIndex
CREATE INDEX "crew_members_user_id_idx" ON "crew_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "deploy_events_client_id_key" ON "deploy_events"("client_id");

-- CreateIndex
CREATE INDEX "deploy_events_sign_id_idx" ON "deploy_events"("sign_id");

-- CreateIndex
CREATE INDEX "deploy_events_crew_id_idx" ON "deploy_events"("crew_id");

-- CreateIndex
CREATE INDEX "deploy_events_created_at_idx" ON "deploy_events"("created_at");

-- CreateIndex
CREATE INDEX "signs_claimed_by_crew_id_idx" ON "signs"("claimed_by_crew_id");

-- CreateIndex
CREATE INDEX "signs_status_claimed_by_crew_id_idx" ON "signs"("status", "claimed_by_crew_id");

-- AddForeignKey
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
