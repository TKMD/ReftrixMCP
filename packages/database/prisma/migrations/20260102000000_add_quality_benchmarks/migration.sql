-- Migration: Add Pattern-Driven Quality Evaluation Support
-- Version: 20260102000000_add_quality_benchmarks
-- Description: QualityBenchmark table for high-quality pattern storage,
--              new columns for QualityEvaluation, helper functions, materialized views

-- =============================================================================
-- 1. Create quality_benchmarks table
-- =============================================================================

CREATE TABLE "quality_benchmarks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "section_pattern_id" UUID,
    "web_page_id" UUID,
    "section_type" TEXT NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "characteristics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" vector(768),
    "axis_scores" JSONB NOT NULL,
    "industry" TEXT,
    "audience" TEXT,
    "source_url" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'award_gallery',
    "html_snippet" TEXT,
    "preview_url" TEXT,
    "extracted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "quality_benchmarks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_benchmarks_overall_score_check" CHECK (overall_score >= 85 AND overall_score <= 100)
);

-- =============================================================================
-- 2. Create B-tree indexes for quality_benchmarks
-- =============================================================================

CREATE INDEX "quality_benchmarks_section_type_idx" ON "quality_benchmarks"("section_type");
CREATE INDEX "quality_benchmarks_overall_score_idx" ON "quality_benchmarks"("overall_score" DESC);
CREATE INDEX "quality_benchmarks_grade_idx" ON "quality_benchmarks"("grade");
CREATE INDEX "quality_benchmarks_industry_idx" ON "quality_benchmarks"("industry");
CREATE INDEX "quality_benchmarks_source_type_idx" ON "quality_benchmarks"("source_type");
CREATE INDEX "quality_benchmarks_extracted_at_idx" ON "quality_benchmarks"("extracted_at" DESC);

-- =============================================================================
-- 3. Create HNSW Vector Index for quality_benchmarks
-- Parameters: m=16 (connectivity), ef_construction=64 (build quality)
-- Distance: cosine (for normalized embeddings from multilingual-e5-base)
-- =============================================================================

CREATE INDEX "idx_quality_benchmarks_embedding_hnsw"
ON "quality_benchmarks"
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- 4. Add foreign keys for quality_benchmarks
-- =============================================================================

ALTER TABLE "quality_benchmarks" ADD CONSTRAINT "quality_benchmarks_section_pattern_id_fkey"
FOREIGN KEY ("section_pattern_id") REFERENCES "section_patterns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quality_benchmarks" ADD CONSTRAINT "quality_benchmarks_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- 5. Add new columns to quality_evaluations
-- =============================================================================

ALTER TABLE "quality_evaluations"
ADD COLUMN IF NOT EXISTS "referenced_patterns" JSONB,
ADD COLUMN IF NOT EXISTS "pattern_similarity" JSONB,
ADD COLUMN IF NOT EXISTS "evaluation_context" JSONB;

-- =============================================================================
-- 6. Create GIN index for referenced_patterns JSONB search
-- =============================================================================

CREATE INDEX "quality_evaluations_referenced_patterns_idx"
ON "quality_evaluations"
USING GIN ("referenced_patterns");

-- =============================================================================
-- 7. Create helper function: find_similar_benchmarks
-- Purpose: Semantic search for similar quality benchmarks using HNSW index
-- Parameters:
--   - query_embedding: 768D vector from embedding model
--   - section_type_filter: Optional filter by section type
--   - min_similarity: Minimum cosine similarity threshold (0-1)
--   - result_limit: Maximum number of results
-- =============================================================================

CREATE OR REPLACE FUNCTION find_similar_benchmarks(
  query_embedding vector(768),
  section_type_filter TEXT DEFAULT NULL,
  min_similarity FLOAT DEFAULT 0.7,
  result_limit INT DEFAULT 5
)
RETURNS TABLE (
  benchmark_id UUID,
  section_type TEXT,
  overall_score INT,
  grade TEXT,
  similarity FLOAT,
  source_url TEXT,
  preview_url TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    qb.id as benchmark_id,
    qb.section_type,
    qb.overall_score,
    qb.grade,
    (1 - (qb.embedding <=> query_embedding))::FLOAT as similarity,
    qb.source_url,
    qb.preview_url
  FROM quality_benchmarks qb
  WHERE qb.embedding IS NOT NULL
    AND (section_type_filter IS NULL OR qb.section_type = section_type_filter)
    AND 1 - (qb.embedding <=> query_embedding) >= min_similarity
  ORDER BY similarity DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 8. Create helper function: calculate_quality_percentile
-- Purpose: Calculate percentile ranking for a quality score
-- Parameters:
--   - input_score: Quality score to evaluate (0-100)
--   - section_type_filter: Optional filter by section type
-- Returns: Percentile value (0-100)
-- =============================================================================

CREATE OR REPLACE FUNCTION calculate_quality_percentile(
  input_score INT,
  section_type_filter TEXT DEFAULT NULL
)
RETURNS FLOAT AS $$
DECLARE
  percentile FLOAT;
BEGIN
  SELECT
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE qe.overall_score <= input_score) / NULLIF(COUNT(*), 0),
      2
    )
  INTO percentile
  FROM quality_evaluations qe
  WHERE qe.created_at > NOW() - INTERVAL '90 days'
    AND (section_type_filter IS NULL OR qe.target_type = 'section_pattern')
  ;

  RETURN COALESCE(percentile, 50.0);
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 9. Create materialized view: mv_industry_quality_averages
-- Purpose: Cache industry-level quality statistics for fast dashboard queries
-- Refresh: Should be scheduled hourly via pg_cron or application job
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_industry_quality_averages AS
SELECT
  qe.evaluation_context->>'target_industry' as industry,
  COUNT(*) as evaluation_count,
  ROUND(AVG(qe.overall_score), 2) as avg_overall_score,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qe.overall_score) as median_score,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY qe.overall_score) as p90_score
FROM quality_evaluations qe
WHERE qe.evaluation_context->>'target_industry' IS NOT NULL
  AND qe.created_at > NOW() - INTERVAL '90 days'
GROUP BY qe.evaluation_context->>'target_industry'
HAVING COUNT(*) >= 10;

CREATE UNIQUE INDEX IF NOT EXISTS mv_industry_quality_averages_idx
ON mv_industry_quality_averages (industry);

-- =============================================================================
-- 10. Create materialized view: mv_section_type_benchmarks
-- Purpose: Aggregate benchmark statistics by section type
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_section_type_benchmarks AS
SELECT
  qb.section_type,
  COUNT(*) as benchmark_count,
  ROUND(AVG(qb.overall_score), 2) as avg_score,
  MAX(qb.overall_score) as max_score,
  MIN(qb.overall_score) as min_score,
  ARRAY_AGG(DISTINCT qb.industry) FILTER (WHERE qb.industry IS NOT NULL) as industries
FROM quality_benchmarks qb
GROUP BY qb.section_type;

CREATE UNIQUE INDEX IF NOT EXISTS mv_section_type_benchmarks_idx
ON mv_section_type_benchmarks (section_type);

-- =============================================================================
-- 11. Add comment documentation
-- =============================================================================

COMMENT ON TABLE quality_benchmarks IS 'High-quality design patterns (score >= 85) used as evaluation benchmarks';
COMMENT ON COLUMN quality_benchmarks.embedding IS '768D vector embedding from multilingual-e5-base model, HNSW indexed';
COMMENT ON COLUMN quality_benchmarks.characteristics IS 'Array of design characteristics for filtering (e.g., gradient-background, bold-typography)';
COMMENT ON COLUMN quality_benchmarks.axis_scores IS 'JSON with originality, craftsmanship, contextuality scores';

COMMENT ON COLUMN quality_evaluations.referenced_patterns IS 'UUIDs of patterns referenced during evaluation (sections, motions, benchmarks)';
COMMENT ON COLUMN quality_evaluations.pattern_similarity IS 'Similarity metrics (avg similarities, uniqueness score, closest match)';
COMMENT ON COLUMN quality_evaluations.evaluation_context IS 'Context info (project, palette, industry, audience)';

COMMENT ON FUNCTION find_similar_benchmarks IS 'Find quality benchmarks similar to query embedding using HNSW cosine similarity';
COMMENT ON FUNCTION calculate_quality_percentile IS 'Calculate percentile ranking for a quality score within 90-day window';

COMMENT ON MATERIALIZED VIEW mv_industry_quality_averages IS 'Industry-level quality statistics (refresh hourly)';
COMMENT ON MATERIALIZED VIEW mv_section_type_benchmarks IS 'Section type benchmark aggregates';
