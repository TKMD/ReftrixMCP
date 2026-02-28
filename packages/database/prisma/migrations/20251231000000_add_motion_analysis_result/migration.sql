-- CreateTable: motion_analysis_results
-- FrameImageAnalysisの結果（AnimationZone, LayoutShift, MotionVector）を保存

CREATE TABLE "motion_analysis_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID,
    "result_type" TEXT NOT NULL,
    "frame_index" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL DEFAULT 30,
    "result_data" JSONB NOT NULL,
    "affected_regions" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "source_url" TEXT,
    "usage_scope" TEXT NOT NULL DEFAULT 'inspiration_only',
    "analyzed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "motion_analysis_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable: motion_analysis_embeddings
-- セマンティック検索用Embedding

CREATE TABLE "motion_analysis_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "motion_analysis_result_id" UUID NOT NULL,
    "embedding" vector(768),
    "text_representation" TEXT,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "motion_analysis_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: motion_analysis_results
CREATE INDEX "motion_analysis_results_web_page_id_idx" ON "motion_analysis_results"("web_page_id");
CREATE INDEX "motion_analysis_results_result_type_idx" ON "motion_analysis_results"("result_type");
CREATE INDEX "motion_analysis_results_frame_index_idx" ON "motion_analysis_results"("frame_index");
CREATE INDEX "motion_analysis_results_web_page_id_result_type_idx" ON "motion_analysis_results"("web_page_id", "result_type");
CREATE INDEX "motion_analysis_results_analyzed_at_idx" ON "motion_analysis_results"("analyzed_at" DESC);

-- CreateIndex: motion_analysis_embeddings
CREATE UNIQUE INDEX "motion_analysis_embeddings_motion_analysis_result_id_key" ON "motion_analysis_embeddings"("motion_analysis_result_id");

-- HNSW Index for vector search (cosine similarity)
CREATE INDEX "motion_analysis_embeddings_embedding_hnsw_idx"
ON "motion_analysis_embeddings" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- AddForeignKey: motion_analysis_results -> web_pages
ALTER TABLE "motion_analysis_results"
ADD CONSTRAINT "motion_analysis_results_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: motion_analysis_embeddings -> motion_analysis_results
ALTER TABLE "motion_analysis_embeddings"
ADD CONSTRAINT "motion_analysis_embeddings_motion_analysis_result_id_fkey"
FOREIGN KEY ("motion_analysis_result_id") REFERENCES "motion_analysis_results"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
