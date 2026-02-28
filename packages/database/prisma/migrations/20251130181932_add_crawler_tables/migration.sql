-- Enable pgcrypto extension for gen_random_bytes() function
-- Required by gen_uuidv7() function below
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create gen_uuidv7() function for time-sortable UUIDs
-- Reference: https://antonz.org/uuidv7/
-- UUIDv7 provides time-ordered UUIDs which are optimal for:
-- - Chronological sorting of crawl jobs
-- - Better B-tree index performance
-- - Time-based partitioning support
CREATE OR REPLACE FUNCTION gen_uuidv7()
RETURNS uuid
AS $$
DECLARE
    unix_ts_ms bytea;
    uuid_bytes bytea;
BEGIN
    -- Get current Unix timestamp in milliseconds
    unix_ts_ms = substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);

    -- Build the UUIDv7: timestamp (48 bits) + version (4 bits) + random_a (12 bits) + variant (2 bits) + random_b (62 bits)
    uuid_bytes = unix_ts_ms || gen_random_bytes(10);

    -- Set version (4 bits = 0111 = 7) at position 6
    uuid_bytes = set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);

    -- Set variant (2 bits = 10) at position 8
    uuid_bytes = set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);

    RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$
LANGUAGE plpgsql
VOLATILE;

-- Add comment for documentation
COMMENT ON FUNCTION gen_uuidv7() IS 'Generates a UUIDv7 (time-ordered UUID) with millisecond precision timestamp';

-- AlterTable
ALTER TABLE "svg_assets" ADD COLUMN     "content_hash" VARCHAR(64),
ADD COLUMN     "crawl_source_id" UUID,
ADD COLUMN     "crawl_status" VARCHAR(20) DEFAULT 'active',
ADD COLUMN     "last_crawled_at" TIMESTAMPTZ,
ADD COLUMN     "source_item_id" VARCHAR(500);

-- CreateTable
CREATE TABLE "crawl_sources" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(250) NOT NULL,
    "description" TEXT,
    "type" VARCHAR(50) NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_url" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "rate_limit" JSONB NOT NULL DEFAULT '{"requestsPerMinute": 60, "burstLimit": 10}',
    "license_spdx" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "last_crawled_at" TIMESTAMPTZ,
    "last_successful_crawl_at" TIMESTAMPTZ,
    "total_svgs_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "crawl_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_jobs" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "source_id" UUID,
    "job_type" VARCHAR(50) NOT NULL DEFAULT 'full',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "processed_items" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_job_items" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "job_id" UUID NOT NULL,
    "svg_id" UUID,
    "source_item_id" VARCHAR(500),
    "source_url" TEXT NOT NULL,
    "source_name" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "content_hash" VARCHAR(64),
    "file_size" INTEGER,
    "processing_time_ms" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(50),
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_source_stats" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "source_id" UUID NOT NULL,
    "stats_date" DATE NOT NULL,
    "total_svgs" INTEGER NOT NULL DEFAULT 0,
    "new_svgs" INTEGER NOT NULL DEFAULT 0,
    "updated_svgs" INTEGER NOT NULL DEFAULT 0,
    "failed_svgs" INTEGER NOT NULL DEFAULT 0,
    "skipped_svgs" INTEGER NOT NULL DEFAULT 0,
    "crawl_duration_ms" INTEGER,
    "avg_fetch_time_ms" INTEGER,
    "avg_process_time_ms" INTEGER,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_source_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "svg_crawl_history" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "svg_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "job_id" UUID,
    "action" VARCHAR(20) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "previous_hash" VARCHAR(64),
    "changes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "svg_crawl_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crawl_sources_slug_key" ON "crawl_sources"("slug");

-- CreateIndex
CREATE INDEX "crawl_sources_enabled_idx" ON "crawl_sources"("enabled");

-- CreateIndex
CREATE INDEX "crawl_sources_type_idx" ON "crawl_sources"("type");

-- CreateIndex
CREATE INDEX "crawl_sources_last_crawled_at_idx" ON "crawl_sources"("last_crawled_at" DESC);

-- CreateIndex
CREATE INDEX "crawl_sources_priority_idx" ON "crawl_sources"("priority" DESC);

-- CreateIndex
CREATE INDEX "crawl_jobs_source_id_idx" ON "crawl_jobs"("source_id");

-- CreateIndex
CREATE INDEX "crawl_jobs_status_idx" ON "crawl_jobs"("status");

-- CreateIndex
CREATE INDEX "crawl_jobs_created_at_idx" ON "crawl_jobs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "crawl_job_items_job_id_idx" ON "crawl_job_items"("job_id");

-- CreateIndex
CREATE INDEX "crawl_job_items_svg_id_idx" ON "crawl_job_items"("svg_id");

-- CreateIndex
CREATE INDEX "crawl_job_items_status_idx" ON "crawl_job_items"("status");

-- CreateIndex
CREATE INDEX "crawl_job_items_content_hash_idx" ON "crawl_job_items"("content_hash");

-- CreateIndex
CREATE INDEX "crawl_job_items_source_item_id_idx" ON "crawl_job_items"("source_item_id");

-- CreateIndex
CREATE INDEX "crawl_job_items_job_id_status_idx" ON "crawl_job_items"("job_id", "status");

-- CreateIndex
CREATE INDEX "crawl_source_stats_source_id_idx" ON "crawl_source_stats"("source_id");

-- CreateIndex
CREATE INDEX "crawl_source_stats_stats_date_idx" ON "crawl_source_stats"("stats_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "crawl_source_stats_source_id_stats_date_key" ON "crawl_source_stats"("source_id", "stats_date");

-- CreateIndex
CREATE INDEX "svg_crawl_history_svg_id_idx" ON "svg_crawl_history"("svg_id");

-- CreateIndex
CREATE INDEX "svg_crawl_history_source_id_idx" ON "svg_crawl_history"("source_id");

-- CreateIndex
CREATE INDEX "svg_crawl_history_job_id_idx" ON "svg_crawl_history"("job_id");

-- CreateIndex
CREATE INDEX "svg_crawl_history_created_at_idx" ON "svg_crawl_history"("created_at" DESC);

-- CreateIndex
CREATE INDEX "svg_crawl_history_action_idx" ON "svg_crawl_history"("action");

-- CreateIndex
CREATE INDEX "svg_assets_crawl_source_id_idx" ON "svg_assets"("crawl_source_id");

-- CreateIndex
CREATE INDEX "svg_assets_content_hash_idx" ON "svg_assets"("content_hash");

-- CreateIndex
CREATE INDEX "svg_assets_last_crawled_at_idx" ON "svg_assets"("last_crawled_at" DESC);

-- CreateIndex
CREATE INDEX "svg_assets_crawl_source_id_source_item_id_idx" ON "svg_assets"("crawl_source_id", "source_item_id");

-- AddForeignKey
ALTER TABLE "svg_assets" ADD CONSTRAINT "svg_assets_crawl_source_id_fkey" FOREIGN KEY ("crawl_source_id") REFERENCES "crawl_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "crawl_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_job_items" ADD CONSTRAINT "crawl_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "crawl_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_job_items" ADD CONSTRAINT "crawl_job_items_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_source_stats" ADD CONSTRAINT "crawl_source_stats_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "crawl_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_crawl_history" ADD CONSTRAINT "svg_crawl_history_svg_id_fkey" FOREIGN KEY ("svg_id") REFERENCES "svg_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_crawl_history" ADD CONSTRAINT "svg_crawl_history_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "crawl_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_crawl_history" ADD CONSTRAINT "svg_crawl_history_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "crawl_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
