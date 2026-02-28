-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'in_progress', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ProjectPageType" AS ENUM ('landing', 'dashboard', 'docs', 'blog', 'other');

-- CreateEnum
CREATE TYPE "BriefScope" AS ENUM ('page', 'hero_section', 'section_group');

-- CreateEnum
CREATE TYPE "LayoutSourceType" AS ENUM ('ai_generated', 'imported', 'manual');

-- CreateEnum
CREATE TYPE "SvgUsageType" AS ENUM ('logo', 'hero_kv', 'icon', 'empty_state', 'illustration', 'annotation');

-- NOTE: HNSW indexes are preserved (managed outside of Prisma schema)
-- idx_motion_embeddings_hnsw, idx_section_embeddings_*_hnsw

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(250) NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
    "default_page_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "path" VARCHAR(500) NOT NULL DEFAULT '/',
    "page_type" "ProjectPageType" NOT NULL DEFAULT 'other',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_briefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_page_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scope" "BriefScope" NOT NULL DEFAULT 'page',
    "brief_json" JSONB NOT NULL DEFAULT '{}',
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "validation_report" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_layout_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_page_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source_type" "LayoutSourceType" NOT NULL DEFAULT 'manual',
    "layout_json" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_layout_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_layout_version_id" UUID NOT NULL,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_layout_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_code_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_page_id" UUID NOT NULL,
    "layout_version_id" UUID,
    "framework" VARCHAR(20) NOT NULL DEFAULT 'react',
    "css_framework" VARCHAR(20) NOT NULL DEFAULT 'tailwind',
    "files" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_code_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_brand_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "brand_id" VARCHAR(100),
    "palette_id" UUID,
    "tokens" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_brand_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_svg_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_page_id" UUID NOT NULL,
    "svg_id" UUID NOT NULL,
    "usage_type" "SvgUsageType" NOT NULL DEFAULT 'illustration',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_svg_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "projects_updated_at_idx" ON "projects"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "project_pages_project_id_idx" ON "project_pages"("project_id");

-- CreateIndex
CREATE INDEX "project_pages_project_id_is_primary_idx" ON "project_pages"("project_id", "is_primary");

-- CreateIndex
CREATE INDEX "project_pages_page_type_idx" ON "project_pages"("page_type");

-- CreateIndex
CREATE INDEX "project_briefs_project_page_id_idx" ON "project_briefs"("project_page_id");

-- CreateIndex
CREATE INDEX "project_briefs_validated_idx" ON "project_briefs"("validated");

-- CreateIndex
CREATE UNIQUE INDEX "project_briefs_project_page_id_version_key" ON "project_briefs"("project_page_id", "version");

-- CreateIndex
CREATE INDEX "project_layout_versions_project_page_id_idx" ON "project_layout_versions"("project_page_id");

-- CreateIndex
CREATE INDEX "project_layout_versions_project_page_id_is_active_idx" ON "project_layout_versions"("project_page_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "project_layout_versions_project_page_id_version_key" ON "project_layout_versions"("project_page_id", "version");

-- CreateIndex
CREATE INDEX "project_layout_scores_project_layout_version_id_idx" ON "project_layout_scores"("project_layout_version_id");

-- CreateIndex
CREATE INDEX "project_layout_scores_created_at_idx" ON "project_layout_scores"("created_at" DESC);

-- CreateIndex
CREATE INDEX "project_code_exports_project_page_id_idx" ON "project_code_exports"("project_page_id");

-- CreateIndex
CREATE INDEX "project_code_exports_created_at_idx" ON "project_code_exports"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_brand_settings_project_id_key" ON "project_brand_settings"("project_id");

-- CreateIndex
CREATE INDEX "project_brand_settings_palette_id_idx" ON "project_brand_settings"("palette_id");

-- CreateIndex
CREATE INDEX "project_svg_links_project_page_id_idx" ON "project_svg_links"("project_page_id");

-- CreateIndex
CREATE INDEX "project_svg_links_svg_id_idx" ON "project_svg_links"("svg_id");

-- CreateIndex
CREATE INDEX "project_svg_links_usage_type_idx" ON "project_svg_links"("usage_type");

-- CreateIndex
CREATE UNIQUE INDEX "project_svg_links_project_page_id_svg_id_usage_type_key" ON "project_svg_links"("project_page_id", "svg_id", "usage_type");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_page_id_fkey" FOREIGN KEY ("default_page_id") REFERENCES "project_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_pages" ADD CONSTRAINT "project_pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_project_page_id_fkey" FOREIGN KEY ("project_page_id") REFERENCES "project_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_layout_versions" ADD CONSTRAINT "project_layout_versions_project_page_id_fkey" FOREIGN KEY ("project_page_id") REFERENCES "project_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_layout_versions" ADD CONSTRAINT "project_layout_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_layout_scores" ADD CONSTRAINT "project_layout_scores_project_layout_version_id_fkey" FOREIGN KEY ("project_layout_version_id") REFERENCES "project_layout_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_code_exports" ADD CONSTRAINT "project_code_exports_project_page_id_fkey" FOREIGN KEY ("project_page_id") REFERENCES "project_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_code_exports" ADD CONSTRAINT "project_code_exports_layout_version_id_fkey" FOREIGN KEY ("layout_version_id") REFERENCES "project_layout_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_brand_settings" ADD CONSTRAINT "project_brand_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_brand_settings" ADD CONSTRAINT "project_brand_settings_palette_id_fkey" FOREIGN KEY ("palette_id") REFERENCES "brand_palettes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_svg_links" ADD CONSTRAINT "project_svg_links_project_page_id_fkey" FOREIGN KEY ("project_page_id") REFERENCES "project_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_svg_links" ADD CONSTRAINT "project_svg_links_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
