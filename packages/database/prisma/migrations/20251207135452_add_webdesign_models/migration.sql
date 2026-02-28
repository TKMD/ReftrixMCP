-- CreateTable
CREATE TABLE "web_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "url" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "source_type" TEXT NOT NULL,
    "source_platform" TEXT,
    "award_info" JSONB,
    "usage_scope" TEXT NOT NULL,
    "license_note" TEXT,
    "html_content" TEXT,
    "html_hash" VARCHAR(64),
    "screenshot_desktop_url" TEXT,
    "screenshot_mobile_url" TEXT,
    "screenshot_full_url" TEXT,
    "analysis_status" TEXT NOT NULL DEFAULT 'pending',
    "analyzed_at" TIMESTAMPTZ,
    "analysis_version" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "crawled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "web_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_patterns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID NOT NULL,
    "section_type" TEXT NOT NULL,
    "section_name" TEXT,
    "position_index" INTEGER NOT NULL,
    "layout_info" JSONB NOT NULL,
    "components" JSONB NOT NULL DEFAULT '[]',
    "visual_features" JSONB NOT NULL DEFAULT '{}',
    "html_snippet" TEXT,
    "css_snippet" TEXT,
    "quality_score" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "section_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "section_pattern_id" UUID NOT NULL,
    "text_embedding" vector(768),
    "vision_embedding" vector(768),
    "combined_embedding" vector(768),
    "text_representation" TEXT,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "section_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "motion_patterns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "animation" JSONB NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '[]',
    "implementation" JSONB NOT NULL,
    "accessibility" JSONB NOT NULL DEFAULT '{}',
    "performance" JSONB NOT NULL DEFAULT '{}',
    "source_url" TEXT,
    "usage_scope" TEXT NOT NULL DEFAULT 'inspiration_only',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "motion_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "motion_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "motion_pattern_id" UUID NOT NULL,
    "embedding" vector(768),
    "text_representation" TEXT,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "motion_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "section_pattern_id" UUID,
    "motion_pattern_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "brand_palette_id" UUID,
    "code_type" TEXT NOT NULL,
    "code_content" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "production_ready" BOOLEAN NOT NULL DEFAULT false,
    "quality_notes" TEXT,
    "quality_score" JSONB,
    "source_attribution" JSONB NOT NULL,
    "generation_params" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "generated_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "anti_ai_cliche" JSONB NOT NULL,
    "design_quality" JSONB,
    "technical_quality" JSONB,
    "recommendations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evaluator_version" TEXT NOT NULL,
    "evaluation_mode" TEXT NOT NULL DEFAULT 'standard',
    "evaluated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_pages_url_key" ON "web_pages"("url");

-- CreateIndex
CREATE INDEX "web_pages_source_type_idx" ON "web_pages"("source_type");

-- CreateIndex
CREATE INDEX "web_pages_source_platform_idx" ON "web_pages"("source_platform");

-- CreateIndex
CREATE INDEX "web_pages_analysis_status_idx" ON "web_pages"("analysis_status");

-- CreateIndex
CREATE INDEX "web_pages_crawled_at_idx" ON "web_pages"("crawled_at" DESC);

-- CreateIndex
CREATE INDEX "web_pages_created_at_idx" ON "web_pages"("created_at" DESC);

-- CreateIndex
CREATE INDEX "section_patterns_web_page_id_idx" ON "section_patterns"("web_page_id");

-- CreateIndex
CREATE INDEX "section_patterns_section_type_idx" ON "section_patterns"("section_type");

-- CreateIndex
CREATE INDEX "section_patterns_web_page_id_position_index_idx" ON "section_patterns"("web_page_id", "position_index");

-- CreateIndex
CREATE UNIQUE INDEX "section_embeddings_section_pattern_id_key" ON "section_embeddings"("section_pattern_id");

-- CreateIndex
CREATE INDEX "motion_patterns_web_page_id_idx" ON "motion_patterns"("web_page_id");

-- CreateIndex
CREATE INDEX "motion_patterns_category_idx" ON "motion_patterns"("category");

-- CreateIndex
CREATE INDEX "motion_patterns_trigger_type_idx" ON "motion_patterns"("trigger_type");

-- CreateIndex
CREATE UNIQUE INDEX "motion_embeddings_motion_pattern_id_key" ON "motion_embeddings"("motion_pattern_id");

-- CreateIndex
CREATE INDEX "generated_codes_section_pattern_id_idx" ON "generated_codes"("section_pattern_id");

-- CreateIndex
CREATE INDEX "generated_codes_brand_palette_id_idx" ON "generated_codes"("brand_palette_id");

-- CreateIndex
CREATE INDEX "generated_codes_code_type_idx" ON "generated_codes"("code_type");

-- CreateIndex
CREATE INDEX "generated_codes_code_hash_idx" ON "generated_codes"("code_hash");

-- CreateIndex
CREATE INDEX "generated_codes_generated_at_idx" ON "generated_codes"("generated_at" DESC);

-- CreateIndex
CREATE INDEX "quality_evaluations_target_type_target_id_idx" ON "quality_evaluations"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "quality_evaluations_overall_score_idx" ON "quality_evaluations"("overall_score");

-- CreateIndex
CREATE INDEX "quality_evaluations_grade_idx" ON "quality_evaluations"("grade");

-- CreateIndex
CREATE INDEX "quality_evaluations_evaluated_at_idx" ON "quality_evaluations"("evaluated_at" DESC);

-- AddForeignKey
ALTER TABLE "section_patterns" ADD CONSTRAINT "section_patterns_web_page_id_fkey" FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_embeddings" ADD CONSTRAINT "section_embeddings_section_pattern_id_fkey" FOREIGN KEY ("section_pattern_id") REFERENCES "section_patterns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "motion_patterns" ADD CONSTRAINT "motion_patterns_web_page_id_fkey" FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "motion_embeddings" ADD CONSTRAINT "motion_embeddings_motion_pattern_id_fkey" FOREIGN KEY ("motion_pattern_id") REFERENCES "motion_patterns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_codes" ADD CONSTRAINT "generated_codes_section_pattern_id_fkey" FOREIGN KEY ("section_pattern_id") REFERENCES "section_patterns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_codes" ADD CONSTRAINT "generated_codes_brand_palette_id_fkey" FOREIGN KEY ("brand_palette_id") REFERENCES "brand_palettes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
