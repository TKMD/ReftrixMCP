-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "svg_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(250) NOT NULL,
    "description" TEXT,
    "svg_raw" TEXT NOT NULL,
    "svg_optimized" TEXT,
    "embedding" vector(768),
    "license_id" UUID NOT NULL,
    "category_id" UUID,
    "style" VARCHAR(50),
    "purpose" VARCHAR(50),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "file_size" INTEGER,
    "viewbox" VARCHAR(100),
    "width" INTEGER,
    "height" INTEGER,
    "colors" JSONB NOT NULL DEFAULT '[]',
    "source_url" TEXT,
    "source_name" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "svg_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "spdx_id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "url" TEXT,
    "commercial_use" BOOLEAN NOT NULL DEFAULT true,
    "modification" BOOLEAN NOT NULL DEFAULT true,
    "distribution" BOOLEAN NOT NULL DEFAULT true,
    "private_use" BOOLEAN NOT NULL DEFAULT true,
    "attribution_required" BOOLEAN NOT NULL DEFAULT false,
    "copyleft" BOOLEAN NOT NULL DEFAULT false,
    "same_license" BOOLEAN NOT NULL DEFAULT false,
    "attribution_template" TEXT,
    "description" TEXT,
    "osi_approved" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "name_ja" VARCHAR(100),
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "svg_tags" (
    "svg_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "svg_tags_pkey" PRIMARY KEY ("svg_id","tag_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "name_ja" VARCHAR(100),
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "parent_id" UUID,
    "level" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT NOT NULL DEFAULT '',
    "type" VARCHAR(20) NOT NULL,
    "icon" VARCHAR(50),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "svg_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "svg_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "svg_content" TEXT NOT NULL,
    "change_note" TEXT,
    "changed_by" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "svg_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "svg_id" UUID NOT NULL,
    "project_name" VARCHAR(200),
    "action" VARCHAR(50) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "source_path" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "processed_items" INTEGER NOT NULL DEFAULT 0,
    "success_items" INTEGER NOT NULL DEFAULT 0,
    "failed_items" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "svg_assets_slug_key" ON "svg_assets"("slug");

-- CreateIndex
CREATE INDEX "svg_assets_category_id_idx" ON "svg_assets"("category_id");

-- CreateIndex
CREATE INDEX "svg_assets_license_id_idx" ON "svg_assets"("license_id");

-- CreateIndex
CREATE INDEX "svg_assets_style_idx" ON "svg_assets"("style");

-- CreateIndex
CREATE INDEX "svg_assets_purpose_idx" ON "svg_assets"("purpose");

-- CreateIndex
CREATE INDEX "svg_assets_created_at_idx" ON "svg_assets"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "licenses_spdx_id_key" ON "licenses"("spdx_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tags_name_idx" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tags_usage_count_idx" ON "tags"("usage_count" DESC);

-- CreateIndex
CREATE INDEX "svg_tags_tag_id_idx" ON "svg_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX "categories_type_idx" ON "categories"("type");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_parent_id_key" ON "categories"("name", "parent_id");

-- CreateIndex
CREATE INDEX "svg_versions_svg_id_idx" ON "svg_versions"("svg_id");

-- CreateIndex
CREATE INDEX "svg_versions_created_at_idx" ON "svg_versions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "svg_versions_svg_id_version_key" ON "svg_versions"("svg_id", "version");

-- CreateIndex
CREATE INDEX "usage_history_svg_id_idx" ON "usage_history"("svg_id");

-- CreateIndex
CREATE INDEX "usage_history_created_at_idx" ON "usage_history"("created_at" DESC);

-- CreateIndex
CREATE INDEX "usage_history_action_idx" ON "usage_history"("action");

-- CreateIndex
CREATE INDEX "ingest_jobs_status_idx" ON "ingest_jobs"("status");

-- CreateIndex
CREATE INDEX "ingest_jobs_created_at_idx" ON "ingest_jobs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "svg_assets" ADD CONSTRAINT "svg_assets_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_assets" ADD CONSTRAINT "svg_assets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_tags" ADD CONSTRAINT "svg_tags_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_tags" ADD CONSTRAINT "svg_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_versions" ADD CONSTRAINT "svg_versions_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_history" ADD CONSTRAINT "usage_history_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
