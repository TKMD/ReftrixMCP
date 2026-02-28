-- ============================================================================
-- Migration: add_design_narrative
-- Description: Add DesignNarrative and DesignNarrativeEmbedding tables
--              for storing design narrative/mood/tone analysis results
-- Created: 2026-02-05
-- ============================================================================

-- CreateEnum: MoodCategory (16 mood categories)
CREATE TYPE "MoodCategory" AS ENUM (
  'professional',
  'playful',
  'premium',
  'tech',
  'organic',
  'minimalist',
  'bold',
  'elegant',
  'artistic',
  'trustworthy',
  'innovative',
  'warm',
  'mysterious',
  'energetic',
  'serene',
  'other'
);

-- CreateTable: design_narratives
-- Purpose: Store design narrative/mood/tone analysis results
-- Relationship: 1:1 with WebPage (unique web_page_id)
CREATE TABLE "design_narratives" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "web_page_id" UUID NOT NULL,
    "mood_category" "MoodCategory" NOT NULL,
    "mood_description" TEXT,
    "color_impression" TEXT,
    "typography_personality" TEXT,
    "motion_emotion" TEXT,
    "overall_tone" TEXT,
    "layout_structure" JSONB NOT NULL DEFAULT '{}',
    "visual_hierarchy" JSONB NOT NULL DEFAULT '{}',
    "spacing_rhythm" JSONB NOT NULL DEFAULT '{}',
    "section_relationships" JSONB NOT NULL DEFAULT '{}',
    "graphic_elements" JSONB NOT NULL DEFAULT '{}',
    "source_url" TEXT,
    "confidence" DOUBLE PRECISION DEFAULT 0.0,
    "analyzed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analyzer_version" VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "design_narratives_pkey" PRIMARY KEY ("id")
);

-- CreateTable: design_narrative_embeddings
-- Purpose: Vector embeddings for semantic search on design narratives
-- HNSW Index: m=16, ef_construction=64, vector_cosine_ops
CREATE TABLE "design_narrative_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "design_narrative_id" UUID NOT NULL,
    "embedding" vector(768),
    "text_representation" TEXT,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "design_narrative_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique constraint on web_page_id (1:1 relationship)
CREATE UNIQUE INDEX "design_narratives_web_page_id_key" ON "design_narratives"("web_page_id");

-- CreateIndex: B-tree indexes for common query patterns
CREATE INDEX "design_narratives_web_page_id_idx" ON "design_narratives"("web_page_id");
CREATE INDEX "design_narratives_mood_category_idx" ON "design_narratives"("mood_category");
CREATE INDEX "design_narratives_analyzed_at_idx" ON "design_narratives"("analyzed_at" DESC);
CREATE INDEX "design_narratives_confidence_idx" ON "design_narratives"("confidence" DESC);

-- CreateIndex: Unique constraint on design_narrative_id (1:1 relationship)
CREATE UNIQUE INDEX "design_narrative_embeddings_design_narrative_id_key" ON "design_narrative_embeddings"("design_narrative_id");

-- CreateIndex: HNSW index for vector similarity search
-- Parameters: m=16, ef_construction=64, vector_cosine_ops
-- Performance Target: P95 < 100ms
CREATE INDEX "idx_design_narrative_embeddings_hnsw" ON "design_narrative_embeddings"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- CreateIndex: GIN indexes for JSONB columns
CREATE INDEX "design_narratives_layout_structure_gin_idx" ON "design_narratives"
USING GIN ("layout_structure");

CREATE INDEX "design_narratives_visual_hierarchy_gin_idx" ON "design_narratives"
USING GIN ("visual_hierarchy");

CREATE INDEX "design_narratives_spacing_rhythm_gin_idx" ON "design_narratives"
USING GIN ("spacing_rhythm");

CREATE INDEX "design_narratives_section_relationships_gin_idx" ON "design_narratives"
USING GIN ("section_relationships");

CREATE INDEX "design_narratives_graphic_elements_gin_idx" ON "design_narratives"
USING GIN ("graphic_elements");

-- AddForeignKey: design_narratives -> web_pages
ALTER TABLE "design_narratives" ADD CONSTRAINT "design_narratives_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: design_narrative_embeddings -> design_narratives
ALTER TABLE "design_narrative_embeddings" ADD CONSTRAINT "design_narrative_embeddings_design_narrative_id_fkey"
FOREIGN KEY ("design_narrative_id") REFERENCES "design_narratives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Helper Functions for Design Narrative Search
-- ============================================================================

-- Function: find_similar_narratives
-- Purpose: Find similar design narratives by vector embedding
-- Parameters:
--   query_embedding: 768-dimensional vector to search
--   match_count: Number of results to return (default 10)
--   similarity_threshold: Minimum similarity score (default 0.7)
-- Returns: Table of narrative IDs, similarity scores, and metadata
CREATE OR REPLACE FUNCTION find_similar_narratives(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  design_narrative_id UUID,
  web_page_id UUID,
  mood_category "MoodCategory",
  similarity FLOAT,
  source_url TEXT,
  analyzed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dne.id,
    dne.design_narrative_id,
    dn.web_page_id,
    dn.mood_category,
    (1 - (dne.embedding <=> query_embedding))::FLOAT AS similarity,
    dn.source_url,
    dn.analyzed_at
  FROM design_narrative_embeddings dne
  JOIN design_narratives dn ON dne.design_narrative_id = dn.id
  WHERE dne.embedding IS NOT NULL
    AND (1 - (dne.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY dne.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function: find_similar_narratives_by_mood
-- Purpose: Find similar design narratives filtered by mood category
-- Parameters:
--   query_embedding: 768-dimensional vector to search
--   mood_filter: MoodCategory to filter by
--   match_count: Number of results to return (default 10)
--   similarity_threshold: Minimum similarity score (default 0.7)
-- Returns: Table of narrative IDs, similarity scores, and metadata
CREATE OR REPLACE FUNCTION find_similar_narratives_by_mood(
  query_embedding vector(768),
  mood_filter "MoodCategory",
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  design_narrative_id UUID,
  web_page_id UUID,
  mood_category "MoodCategory",
  similarity FLOAT,
  source_url TEXT,
  analyzed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dne.id,
    dne.design_narrative_id,
    dn.web_page_id,
    dn.mood_category,
    (1 - (dne.embedding <=> query_embedding))::FLOAT AS similarity,
    dn.source_url,
    dn.analyzed_at
  FROM design_narrative_embeddings dne
  JOIN design_narratives dn ON dne.design_narrative_id = dn.id
  WHERE dne.embedding IS NOT NULL
    AND dn.mood_category = mood_filter
    AND (1 - (dne.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY dne.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function: get_narrative_stats
-- Purpose: Get statistics about design narratives by mood category
-- Returns: Table of mood categories with counts and average confidence
CREATE OR REPLACE FUNCTION get_narrative_stats()
RETURNS TABLE (
  mood_category "MoodCategory",
  narrative_count BIGINT,
  avg_confidence FLOAT,
  with_embedding_count BIGINT,
  latest_analyzed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dn.mood_category,
    COUNT(*)::BIGINT AS narrative_count,
    AVG(dn.confidence)::FLOAT AS avg_confidence,
    COUNT(dne.id)::BIGINT AS with_embedding_count,
    MAX(dn.analyzed_at) AS latest_analyzed_at
  FROM design_narratives dn
  LEFT JOIN design_narrative_embeddings dne ON dn.id = dne.design_narrative_id
  GROUP BY dn.mood_category
  ORDER BY narrative_count DESC;
END;
$$;

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE "design_narratives" IS
  'Design narrative/mood/tone analysis results from Vision AI and CSS analysis. 1:1 with WebPage.';

COMMENT ON TABLE "design_narrative_embeddings" IS
  'Vector embeddings for semantic search on design narratives. HNSW indexed (m=16, ef_construction=64).';

COMMENT ON COLUMN "design_narratives"."mood_category" IS
  'Primary mood classification (16 categories): professional, playful, premium, tech, etc.';

COMMENT ON COLUMN "design_narratives"."layout_structure" IS
  'JSONB: Layout type, grid system, whitespace usage. Example: {"type": "asymmetric", "grid": "12-column"}';

COMMENT ON COLUMN "design_narratives"."visual_hierarchy" IS
  'JSONB: Visual hierarchy levels and focus areas. Example: {"levels": 4, "primaryFocus": "hero"}';

COMMENT ON COLUMN "design_narratives"."spacing_rhythm" IS
  'JSONB: Spacing pattern and scale. Example: {"pattern": "consistent", "baseUnit": 8}';

COMMENT ON COLUMN "design_narratives"."section_relationships" IS
  'JSONB: Flow and connections between sections. Example: {"flow": "narrative", "connections": [...]}';

COMMENT ON COLUMN "design_narratives"."graphic_elements" IS
  'JSONB: Illustration, icon, and pattern usage. Example: {"icons": "outline", "patterns": "geometric"}';

COMMENT ON FUNCTION find_similar_narratives IS
  'Find similar design narratives by vector embedding. Performance target: P95 < 100ms.';

COMMENT ON FUNCTION find_similar_narratives_by_mood IS
  'Find similar design narratives filtered by mood category. Performance target: P95 < 100ms.';

COMMENT ON FUNCTION get_narrative_stats IS
  'Get statistics about design narratives grouped by mood category.';
