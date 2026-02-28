-- ============================================================================
-- Migration: add_background_design
-- Description: Add BackgroundDesign and BackgroundDesignEmbedding tables
--              for storing background design pattern detection results
--              (gradients, glassmorphism, noise textures, SVG patterns, etc.)
-- Created: 2026-02-06
-- ============================================================================

-- CreateEnum: BackgroundDesignType (14 background design categories)
CREATE TYPE "BackgroundDesignType" AS ENUM (
  'solid_color',
  'linear_gradient',
  'radial_gradient',
  'conic_gradient',
  'mesh_gradient',
  'image_background',
  'pattern_background',
  'video_background',
  'animated_gradient',
  'glassmorphism',
  'noise_texture',
  'svg_background',
  'multi_layer',
  'unknown'
);

-- CreateTable: background_designs
-- Purpose: Store detected background design patterns from web pages
-- Relationships: N:1 with WebPage (nullable), N:1 with SectionPattern (nullable)
CREATE TABLE "background_designs" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "web_page_id" UUID,
    "section_pattern_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "design_type" "BackgroundDesignType" NOT NULL,
    "css_value" TEXT NOT NULL,
    "selector" VARCHAR(500),
    "position_index" INTEGER NOT NULL DEFAULT 0,
    "color_info" JSONB NOT NULL DEFAULT '{}',
    "gradient_info" JSONB,
    "visual_properties" JSONB NOT NULL DEFAULT '{}',
    "animation_info" JSONB,
    "css_implementation" TEXT,
    "performance" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "source_url" TEXT,
    "usage_scope" TEXT NOT NULL DEFAULT 'inspiration_only',
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "background_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: background_design_embeddings
-- Purpose: Vector embeddings for semantic search on background designs
-- HNSW Index: m=16, ef_construction=64, vector_cosine_ops
CREATE TABLE "background_design_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "background_design_id" UUID NOT NULL,
    "embedding" vector(768),
    "text_representation" TEXT,
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "background_design_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: B-tree indexes for common query patterns
CREATE INDEX "background_designs_web_page_id_idx" ON "background_designs"("web_page_id");
CREATE INDEX "background_designs_design_type_idx" ON "background_designs"("design_type");
CREATE INDEX "background_designs_section_pattern_id_idx" ON "background_designs"("section_pattern_id");
CREATE INDEX "background_designs_detected_at_idx" ON "background_designs"("detected_at" DESC);

-- CreateIndex: Unique constraint on background_design_id (1:1 relationship)
CREATE UNIQUE INDEX "background_design_embeddings_background_design_id_key" ON "background_design_embeddings"("background_design_id");

-- CreateIndex: HNSW index for vector similarity search
-- Parameters: m=16, ef_construction=64, vector_cosine_ops
-- Performance Target: P95 < 100ms
CREATE INDEX IF NOT EXISTS "idx_background_design_embeddings_hnsw" ON "background_design_embeddings"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- AddForeignKey: background_designs -> web_pages
ALTER TABLE "background_designs" ADD CONSTRAINT "background_designs_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: background_designs -> section_patterns
ALTER TABLE "background_designs" ADD CONSTRAINT "background_designs_section_pattern_id_fkey"
FOREIGN KEY ("section_pattern_id") REFERENCES "section_patterns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: background_design_embeddings -> background_designs
ALTER TABLE "background_design_embeddings" ADD CONSTRAINT "background_design_embeddings_background_design_id_fkey"
FOREIGN KEY ("background_design_id") REFERENCES "background_designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Helper Functions for Background Design Search
-- ============================================================================

-- Function: find_similar_background_designs
-- Purpose: Find similar background designs by vector embedding
-- Parameters:
--   query_embedding: 768-dimensional vector to search
--   match_count: Number of results to return (default 10)
--   similarity_threshold: Minimum similarity score (default 0.7)
-- Returns: Table of background design IDs, similarity scores, and metadata
CREATE OR REPLACE FUNCTION find_similar_background_designs(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  background_design_id UUID,
  design_type "BackgroundDesignType",
  name VARCHAR(200),
  similarity FLOAT,
  source_url TEXT,
  detected_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    bde.id,
    bde.background_design_id,
    bd.design_type,
    bd.name,
    (1 - (bde.embedding <=> query_embedding))::FLOAT AS similarity,
    bd.source_url,
    bd.detected_at
  FROM background_design_embeddings bde
  JOIN background_designs bd ON bde.background_design_id = bd.id
  WHERE bde.embedding IS NOT NULL
    AND (1 - (bde.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY bde.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function: find_similar_background_designs_by_type
-- Purpose: Find similar background designs filtered by design type
-- Parameters:
--   query_embedding: 768-dimensional vector to search
--   type_filter: BackgroundDesignType to filter by
--   match_count: Number of results to return (default 10)
--   similarity_threshold: Minimum similarity score (default 0.7)
CREATE OR REPLACE FUNCTION find_similar_background_designs_by_type(
  query_embedding vector(768),
  type_filter "BackgroundDesignType",
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  background_design_id UUID,
  design_type "BackgroundDesignType",
  name VARCHAR(200),
  similarity FLOAT,
  source_url TEXT,
  detected_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    bde.id,
    bde.background_design_id,
    bd.design_type,
    bd.name,
    (1 - (bde.embedding <=> query_embedding))::FLOAT AS similarity,
    bd.source_url,
    bd.detected_at
  FROM background_design_embeddings bde
  JOIN background_designs bd ON bde.background_design_id = bd.id
  WHERE bde.embedding IS NOT NULL
    AND bd.design_type = type_filter
    AND (1 - (bde.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY bde.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE "background_designs" IS
  'Background design patterns detected from web pages. Supports gradients, glassmorphism, noise textures, SVG patterns, etc.';

COMMENT ON TABLE "background_design_embeddings" IS
  'Vector embeddings for semantic search on background designs. HNSW indexed (m=16, ef_construction=64).';

COMMENT ON COLUMN "background_designs"."design_type" IS
  'Background design type classification (14 categories): solid_color, linear_gradient, glassmorphism, noise_texture, etc.';

COMMENT ON COLUMN "background_designs"."color_info" IS
  'JSONB: Dominant colors, color count, alpha presence, color space. Example: {"dominantColors": ["#1a1a2e"], "colorCount": 3}';

COMMENT ON COLUMN "background_designs"."gradient_info" IS
  'JSONB: Gradient type, angle, stops, repeating flag. Example: {"type": "linear", "angle": 135, "stops": [...]}';

COMMENT ON COLUMN "background_designs"."visual_properties" IS
  'JSONB: Blur radius, opacity, blend mode, overlay, layers. Example: {"blurRadius": 0, "opacity": 1.0, "blendMode": "normal"}';

COMMENT ON COLUMN "background_designs"."animation_info" IS
  'JSONB: Animation name, duration, easing for animated backgrounds. Example: {"isAnimated": true, "duration": "3s"}';

COMMENT ON COLUMN "background_designs"."performance" IS
  'JSONB: GPU acceleration, paint triggers, estimated impact. Example: {"gpuAccelerated": true, "estimatedImpact": "low"}';

COMMENT ON FUNCTION find_similar_background_designs IS
  'Find similar background designs by vector embedding. Performance target: P95 < 100ms.';

COMMENT ON FUNCTION find_similar_background_designs_by_type IS
  'Find similar background designs filtered by design type. Performance target: P95 < 100ms.';
