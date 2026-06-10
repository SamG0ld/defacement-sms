-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'lead', 'volunteer');

-- CreateEnum
CREATE TYPE "SignStatus" AS ENUM ('pending', 'printed', 'delivered', 'deployed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'volunteer',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "invitation_token_hash" TEXT,
    "invitationExpiry" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "firstLoginAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "profileCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "zones" (
    "id" SERIAL NOT NULL,
    "zone_code" TEXT NOT NULL,
    "zone_name" TEXT NOT NULL,
    "building" TEXT,
    "floor" TEXT,
    "deployment_priority" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "location_code" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "floor" TEXT,
    "section" TEXT,
    "zone_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_templates" (
    "id" SERIAL NOT NULL,
    "template_name" TEXT NOT NULL,
    "sign_type" TEXT,
    "base_psd_path" TEXT,
    "width_inches" DECIMAL(6,2),
    "height_inches" DECIMAL(6,2),
    "text_layer_name" TEXT,
    "font_name" TEXT,
    "font_size_max" INTEGER,
    "font_size_min" INTEGER,
    "text_color" TEXT,
    "text_alignment" TEXT,
    "figma_file_key" TEXT,
    "figma_component_id" TEXT,
    "figma_text_node_ids" TEXT,
    "figma_page_id" TEXT,
    "text_zones" TEXT,
    "config_json" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signs" (
    "id" SERIAL NOT NULL,
    "item_id" TEXT NOT NULL,
    "sign_text" TEXT NOT NULL,
    "sign_type" TEXT NOT NULL,
    "requestor" TEXT,
    "requestor_email" TEXT,
    "request_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "double_sided" BOOLEAN NOT NULL DEFAULT false,
    "needs_easel" BOOLEAN NOT NULL DEFAULT false,
    "placement_area" TEXT,
    "exact_destination" TEXT,
    "zone_id" INTEGER,
    "deployment_priority" INTEGER NOT NULL DEFAULT 2,
    "deploy_by_date" DATE,
    "cost_per_unit" DECIMAL(10,2),
    "total_cost" DECIMAL(10,2),
    "status" "SignStatus" NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "template_id" INTEGER,
    "psd_generated" BOOLEAN NOT NULL DEFAULT false,
    "psd_filepath" TEXT,
    "psd_approved" BOOLEAN NOT NULL DEFAULT false,
    "fitted_text" TEXT,
    "calculated_font_size" INTEGER,
    "legibility_score" DECIMAL(3,2),
    "needs_manual_review" BOOLEAN NOT NULL DEFAULT false,
    "generation_pipeline" TEXT,
    "figma_instance_node_id" TEXT,
    "preview_image_path" TEXT,
    "export_pdf_path" TEXT,
    "generation_error" TEXT,
    "event_start" TIMESTAMP(3),
    "event_end" TIMESTAMP(3),
    "deployment_slot" TEXT,
    "delivered_by" TEXT,
    "delivered_at" TIMESTAMP(3),
    "deployed_by" TEXT,
    "deployed_at" TIMESTAMP(3),
    "deployment_notes" TEXT,
    "equipment_checked_out" BOOLEAN NOT NULL DEFAULT false,
    "equipment_returned" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "is_test_data" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" SERIAL NOT NULL,
    "sign_id" INTEGER NOT NULL,
    "old_status" TEXT,
    "new_status" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_tags" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#00BCD4',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_tag_assignments" (
    "sign_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,

    CONSTRAINT "sign_tag_assignments_pkey" PRIMARY KEY ("sign_id","tag_id")
);

-- CreateTable
CREATE TABLE "equipment_types" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_inventory" (
    "id" SERIAL NOT NULL,
    "equipment_type_id" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "count_start_of_con" INTEGER NOT NULL DEFAULT 0,
    "count_end_of_con" INTEGER NOT NULL DEFAULT 0,
    "count_ordered" INTEGER NOT NULL DEFAULT 0,
    "count_received" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_invitation_token_hash_key" ON "users"("invitation_token_hash");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "zones_zone_code_key" ON "zones"("zone_code");

-- CreateIndex
CREATE UNIQUE INDEX "locations_location_code_key" ON "locations"("location_code");

-- CreateIndex
CREATE INDEX "signs_status_idx" ON "signs"("status");

-- CreateIndex
CREATE INDEX "signs_requestor_idx" ON "signs"("requestor");

-- CreateIndex
CREATE INDEX "signs_zone_id_idx" ON "signs"("zone_id");

-- CreateIndex
CREATE INDEX "signs_deployment_priority_idx" ON "signs"("deployment_priority");

-- CreateIndex
CREATE INDEX "signs_sign_type_idx" ON "signs"("sign_type");

-- CreateIndex
CREATE INDEX "signs_item_id_idx" ON "signs"("item_id");

-- CreateIndex
CREATE INDEX "signs_event_start_idx" ON "signs"("event_start");

-- CreateIndex
CREATE INDEX "signs_deployment_slot_idx" ON "signs"("deployment_slot");

-- CreateIndex
CREATE INDEX "signs_template_id_idx" ON "signs"("template_id");

-- CreateIndex
CREATE INDEX "signs_generation_pipeline_idx" ON "signs"("generation_pipeline");

-- CreateIndex
CREATE INDEX "status_history_sign_id_idx" ON "status_history"("sign_id");

-- CreateIndex
CREATE UNIQUE INDEX "sign_tags_name_key" ON "sign_tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sign_tags_slug_key" ON "sign_tags"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_types_name_key" ON "equipment_types"("name");

-- CreateIndex
CREATE INDEX "equipment_inventory_year_idx" ON "equipment_inventory"("year");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_inventory_equipment_type_id_year_key" ON "equipment_inventory"("equipment_type_id", "year");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signs" ADD CONSTRAINT "signs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signs" ADD CONSTRAINT "signs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "sign_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_sign_id_fkey" FOREIGN KEY ("sign_id") REFERENCES "signs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_tag_assignments" ADD CONSTRAINT "sign_tag_assignments_sign_id_fkey" FOREIGN KEY ("sign_id") REFERENCES "signs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_tag_assignments" ADD CONSTRAINT "sign_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "sign_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_inventory" ADD CONSTRAINT "equipment_inventory_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
