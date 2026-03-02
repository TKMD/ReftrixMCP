-- ============================================================================
-- Migration: add_responsive_analysis_embeddings
-- Description: Add ResponsiveAnalysisEmbedding table for semantic search
--              on responsive design analysis results (viewport differences,
--              breakpoints, screenshot diffs)
-- Created: 2026-03-01
-- ============================================================================

-- CreateTable: responsive_analysis_embeddings
-- Purpose: Vector embeddings for semantic search on responsive analyses
-- HNSW Index: m=16, ef_construction=64, vector_cosine_ops
CREATE TABLE "responsive_analysis_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "responsive_analysis_id" UUID NOT NULL,
    "embedding" vector(768),
    "text_representation" TEXT,
    "search_vector" tsvector GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE("text_representation", ''))
    ) STORED,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "responsive_analysis_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique constraint on responsive_analysis_id (1:1 relationship)
CREATE UNIQUE INDEX "responsive_analysis_embeddings_responsive_analysis_id_key"
ON "responsive_analysis_embeddings"("responsive_analysis_id");

-- CreateIndex: HNSW index for vector similarity search
-- Parameters: m=16, ef_construction=64, vector_cosine_ops
-- Performance Target: P95 < 100ms
CREATE INDEX IF NOT EXISTS "idx_responsive_analysis_embeddings_hnsw"
ON "responsive_analysis_embeddings"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- CreateIndex: GIN index for full-text search on search_vector
CREATE INDEX IF NOT EXISTS "idx_responsive_analysis_embeddings_search_vector"
ON "responsive_analysis_embeddings"
USING gin ("search_vector");

-- AddForeignKey: responsive_analysis_embeddings -> responsive_analyses
ALTER TABLE "responsive_analysis_embeddings"
ADD CONSTRAINT "responsive_analysis_embeddings_responsive_analysis_id_fkey"
FOREIGN KEY ("responsive_analysis_id") REFERENCES "responsive_analyses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Helper Function: find_similar_responsive_analyses
-- ============================================================================

-- Function: find_similar_responsive_analyses
-- Purpose: Find similar responsive analyses by vector embedding
-- Parameters:
--   query_embedding: 768-dimensional vector to search
--   match_count: Number of results to return (default 10)
--   similarity_threshold: Minimum similarity score (default 0.5)
-- Returns: Table of responsive analysis IDs, similarity scores, and metadata
CREATE OR REPLACE FUNCTION find_similar_responsive_analyses(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  id UUID,
  responsive_analysis_id UUID,
  web_page_id UUID,
  url TEXT,
  similarity FLOAT,
  text_representation TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    rae.id,
    rae.responsive_analysis_id,
    ra.web_page_id,
    wp.url,
    (1 - (rae.embedding <=> query_embedding))::FLOAT AS similarity,
    rae.text_representation,
    ra.created_at
  FROM responsive_analysis_embeddings rae
  JOIN responsive_analyses ra ON rae.responsive_analysis_id = ra.id
  JOIN web_pages wp ON ra.web_page_id = wp.id
  WHERE rae.embedding IS NOT NULL
    AND (1 - (rae.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY rae.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON TABLE responsive_analysis_embeddings IS 'Vector embeddings for semantic search on responsive design analysis results';
COMMENT ON COLUMN responsive_analysis_embeddings.embedding IS '768D vector embedding (multilingual-e5-base), HNSW indexed with cosine similarity';
COMMENT ON COLUMN responsive_analysis_embeddings.text_representation IS 'Structured text representation used for embedding generation (passage: prefixed)';
COMMENT ON COLUMN responsive_analysis_embeddings.search_vector IS 'Auto-generated tsvector for full-text search, GIN indexed';
COMMENT ON FUNCTION find_similar_responsive_analyses IS 'Find responsive analyses similar to query embedding using HNSW cosine similarity';
