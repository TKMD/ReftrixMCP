-- Sprint 4: Remove SVG-related models for WebDesign-only Reftrix
-- This migration removes 14 models + 1 enum related to SVG functionality

-- DropForeignKey
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_parent_id_fkey";

-- DropForeignKey
ALTER TABLE "crawl_job_items" DROP CONSTRAINT IF EXISTS "crawl_job_items_job_id_fkey";

-- DropForeignKey
ALTER TABLE "crawl_job_items" DROP CONSTRAINT IF EXISTS "crawl_job_items_svg_id_fkey";

-- DropForeignKey
ALTER TABLE "crawl_jobs" DROP CONSTRAINT IF EXISTS "crawl_jobs_source_id_fkey";

-- DropForeignKey
ALTER TABLE "crawl_source_stats" DROP CONSTRAINT IF EXISTS "crawl_source_stats_source_id_fkey";

-- DropForeignKey
ALTER TABLE "project_svg_links" DROP CONSTRAINT IF EXISTS "project_svg_links_project_page_id_fkey";

-- DropForeignKey
ALTER TABLE "project_svg_links" DROP CONSTRAINT IF EXISTS "project_svg_links_svg_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_assets" DROP CONSTRAINT IF EXISTS "svg_assets_category_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_assets" DROP CONSTRAINT IF EXISTS "svg_assets_crawl_source_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_assets" DROP CONSTRAINT IF EXISTS "svg_assets_license_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_assets" DROP CONSTRAINT IF EXISTS "svg_assets_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_crawl_history" DROP CONSTRAINT IF EXISTS "svg_crawl_history_job_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_crawl_history" DROP CONSTRAINT IF EXISTS "svg_crawl_history_source_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_crawl_history" DROP CONSTRAINT IF EXISTS "svg_crawl_history_svg_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_tags" DROP CONSTRAINT IF EXISTS "svg_tags_svg_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_tags" DROP CONSTRAINT IF EXISTS "svg_tags_tag_id_fkey";

-- DropForeignKey
ALTER TABLE "svg_versions" DROP CONSTRAINT IF EXISTS "svg_versions_svg_id_fkey";

-- DropForeignKey
ALTER TABLE "usage_history" DROP CONSTRAINT IF EXISTS "usage_history_svg_id_fkey";

-- DropIndex (HNSW indexes that may reference removed tables)
DROP INDEX IF EXISTS "idx_motion_embeddings_hnsw";
DROP INDEX IF EXISTS "idx_section_embeddings_combined_hnsw";
DROP INDEX IF EXISTS "idx_section_embeddings_text_hnsw";
DROP INDEX IF EXISTS "idx_section_embeddings_vision_hnsw";

-- DropTable (order matters due to dependencies)
DROP TABLE IF EXISTS "svg_crawl_history";
DROP TABLE IF EXISTS "crawl_job_items";
DROP TABLE IF EXISTS "crawl_source_stats";
DROP TABLE IF EXISTS "crawl_jobs";
DROP TABLE IF EXISTS "crawl_sources";
DROP TABLE IF EXISTS "svg_tags";
DROP TABLE IF EXISTS "svg_versions";
DROP TABLE IF EXISTS "usage_history";
DROP TABLE IF EXISTS "project_svg_links";
DROP TABLE IF EXISTS "svg_assets";
DROP TABLE IF EXISTS "categories";
DROP TABLE IF EXISTS "licenses";
DROP TABLE IF EXISTS "tags";
DROP TABLE IF EXISTS "ingest_jobs";

-- DropEnum
DROP TYPE IF EXISTS "SvgUsageType";

-- Recreate HNSW indexes for remaining tables (motion_embeddings, section_embeddings)
CREATE INDEX IF NOT EXISTS "idx_motion_embeddings_hnsw" ON "motion_embeddings" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_text_hnsw" ON "section_embeddings" USING hnsw (text_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_vision_hnsw" ON "section_embeddings" USING hnsw (vision_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_combined_hnsw" ON "section_embeddings" USING hnsw (combined_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
