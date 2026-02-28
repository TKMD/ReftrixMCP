-- Migration: Add WebGL Animation Pattern Tables
-- Version: 20260118000000_add_webgl_animation_tables
-- Description: WebGLAnimationPattern and WebGLAnimationEmbedding tables for
--              WebGL/Canvas shader animation detection via visual frame analysis
--              Supports WebGL 1.0/2.0, Three.js, Custom shaders

-- =============================================================================
-- 1. Create ENUM type for WebGL Animation Category
-- =============================================================================

-- WebGLアニメーションのカテゴリ分類
CREATE TYPE "WebGLAnimationCategory" AS ENUM (
    'fade',       -- フェードイン/アウト
    'pulse',      -- 脈動・点滅
    'wave',       -- 波状アニメーション
    'particle',   -- パーティクルシステム
    'morph',      -- 形状変形
    'rotation',   -- 回転アニメーション
    'parallax',   -- パララックス効果
    'noise',      -- ノイズベースアニメーション（Perlin等）
    'complex'     -- 複合・分類不能
);

-- =============================================================================
-- 2. Create webgl_animation_patterns table
-- =============================================================================

CREATE TABLE "webgl_animation_patterns" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "web_page_id" UUID,

    -- パターン基本情報
    "name" VARCHAR(200) NOT NULL,
    "category" "WebGLAnimationCategory" NOT NULL,
    "description" TEXT,

    -- Canvas要素情報
    "canvas_selector" VARCHAR(500),
    "canvas_width" INTEGER,
    "canvas_height" INTEGER,
    "webgl_version" INTEGER,  -- 1 = WebGL 1.0, 2 = WebGL 2.0

    -- 検出ライブラリ情報
    "detected_libraries" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- フレーム解析結果（必須）
    "frame_analysis" JSONB NOT NULL,

    -- 変化領域（BoundingBox[]）
    "change_regions" JSONB NOT NULL DEFAULT '[]',

    -- 視覚特徴
    "visual_features" JSONB NOT NULL DEFAULT '{}',

    -- パフォーマンス情報
    "performance" JSONB NOT NULL DEFAULT '{}',

    -- アクセシビリティ
    "accessibility" JSONB NOT NULL DEFAULT '{}',

    -- 検出信頼度（0-1）
    "confidence" DOUBLE PRECISION,

    -- ソース情報
    "source_url" TEXT,
    "usage_scope" TEXT NOT NULL DEFAULT 'inspiration_only',

    -- メタデータ
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',

    -- タイムスタンプ
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "webgl_animation_patterns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webgl_animation_patterns_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT "webgl_animation_patterns_webgl_version_check" CHECK (webgl_version IS NULL OR webgl_version IN (1, 2))
);

-- =============================================================================
-- 3. Create webgl_animation_embeddings table
-- =============================================================================

CREATE TABLE "webgl_animation_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "webgl_animation_pattern_id" UUID NOT NULL,

    -- Embedding (768D, multilingual-e5-base)
    "embedding" vector(768),

    -- テキスト表現（Embedding生成元）
    "text_representation" TEXT,

    -- メタデータ
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- タイムスタンプ
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "webgl_animation_embeddings_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- 4. Create B-tree indexes for webgl_animation_patterns
-- =============================================================================

CREATE INDEX "webgl_animation_patterns_web_page_id_idx"
ON "webgl_animation_patterns"("web_page_id");

CREATE INDEX "webgl_animation_patterns_category_idx"
ON "webgl_animation_patterns"("category");

CREATE INDEX "webgl_animation_patterns_detected_at_idx"
ON "webgl_animation_patterns"("detected_at" DESC);

-- =============================================================================
-- 5. Create unique index for webgl_animation_embeddings
-- =============================================================================

CREATE UNIQUE INDEX "webgl_animation_embeddings_webgl_animation_pattern_id_key"
ON "webgl_animation_embeddings"("webgl_animation_pattern_id");

-- =============================================================================
-- 6. Create HNSW Vector Index for webgl_animation_embeddings
-- Parameters: m=16 (connectivity), ef_construction=64 (build quality)
-- Distance: cosine (for normalized embeddings from multilingual-e5-base)
-- Performance Target: Vector Search P95 < 100ms
-- =============================================================================

CREATE INDEX "idx_webgl_animation_embeddings_hnsw"
ON "webgl_animation_embeddings"
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- 7. Add foreign keys
-- =============================================================================

-- webgl_animation_patterns -> web_pages
ALTER TABLE "webgl_animation_patterns"
ADD CONSTRAINT "webgl_animation_patterns_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- webgl_animation_embeddings -> webgl_animation_patterns
ALTER TABLE "webgl_animation_embeddings"
ADD CONSTRAINT "webgl_animation_embeddings_webgl_animation_pattern_id_fkey"
FOREIGN KEY ("webgl_animation_pattern_id") REFERENCES "webgl_animation_patterns"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 8. Create helper function: find_similar_webgl_animations
-- Purpose: Semantic search for similar WebGL animation patterns using HNSW index
-- Parameters:
--   - query_embedding: 768D vector from embedding model
--   - category_filter: Optional filter by WebGL animation category
--   - min_similarity: Minimum cosine similarity threshold (0-1)
--   - result_limit: Maximum number of results
-- =============================================================================

CREATE OR REPLACE FUNCTION find_similar_webgl_animations(
  query_embedding vector(768),
  category_filter "WebGLAnimationCategory" DEFAULT NULL,
  min_similarity FLOAT DEFAULT 0.7,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  pattern_id UUID,
  category "WebGLAnimationCategory",
  name VARCHAR(200),
  similarity FLOAT,
  detected_libraries TEXT[],
  source_url TEXT,
  webgl_version INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    wap.id as pattern_id,
    wap.category,
    wap.name,
    (1 - (wae.embedding <=> query_embedding))::FLOAT as similarity,
    wap.detected_libraries,
    wap.source_url,
    wap.webgl_version
  FROM webgl_animation_patterns wap
  INNER JOIN webgl_animation_embeddings wae ON wae.webgl_animation_pattern_id = wap.id
  WHERE wae.embedding IS NOT NULL
    AND (category_filter IS NULL OR wap.category = category_filter)
    AND 1 - (wae.embedding <=> query_embedding) >= min_similarity
  ORDER BY similarity DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 9. Create helper function: get_webgl_animation_stats
-- Purpose: Get statistics about WebGL animation patterns by category
-- =============================================================================

CREATE OR REPLACE FUNCTION get_webgl_animation_stats()
RETURNS TABLE (
  category "WebGLAnimationCategory",
  pattern_count BIGINT,
  avg_confidence NUMERIC,
  with_embedding_count BIGINT,
  most_common_library TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH library_counts AS (
    SELECT
      wap.category AS lib_category,
      unnest(wap.detected_libraries) as library,
      COUNT(*) as lib_count
    FROM webgl_animation_patterns wap
    WHERE array_length(wap.detected_libraries, 1) > 0
    GROUP BY wap.category, library
  ),
  top_libraries AS (
    SELECT DISTINCT ON (lc.lib_category)
      lc.lib_category,
      lc.library as most_common
    FROM library_counts lc
    ORDER BY lc.lib_category, lc.lib_count DESC
  )
  SELECT
    wap.category,
    COUNT(*)::BIGINT as pattern_count,
    ROUND(AVG(wap.confidence)::NUMERIC, 3) as avg_confidence,
    COUNT(wae.id)::BIGINT as with_embedding_count,
    tl.most_common as most_common_library
  FROM webgl_animation_patterns wap
  LEFT JOIN webgl_animation_embeddings wae ON wae.webgl_animation_pattern_id = wap.id
  LEFT JOIN top_libraries tl ON tl.lib_category = wap.category
  GROUP BY wap.category, tl.most_common
  ORDER BY pattern_count DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 10. Add GIN index for JSONB search (frame_analysis, visual_features)
-- =============================================================================

CREATE INDEX "webgl_animation_patterns_frame_analysis_gin_idx"
ON "webgl_animation_patterns"
USING GIN ("frame_analysis");

CREATE INDEX "webgl_animation_patterns_visual_features_gin_idx"
ON "webgl_animation_patterns"
USING GIN ("visual_features");

CREATE INDEX "webgl_animation_patterns_change_regions_gin_idx"
ON "webgl_animation_patterns"
USING GIN ("change_regions");

-- =============================================================================
-- 11. Add comment documentation
-- =============================================================================

COMMENT ON TABLE webgl_animation_patterns IS 'WebGL/Canvas shader animation patterns detected via visual frame analysis. Supports WebGL 1.0/2.0, Three.js, Pixi.js, custom shaders';
COMMENT ON COLUMN webgl_animation_patterns.category IS 'Animation category: fade, pulse, wave, particle, morph, rotation, parallax, noise, complex';
COMMENT ON COLUMN webgl_animation_patterns.canvas_selector IS 'CSS selector for the canvas element';
COMMENT ON COLUMN webgl_animation_patterns.webgl_version IS 'WebGL version: 1 = WebGL 1.0, 2 = WebGL 2.0';
COMMENT ON COLUMN webgl_animation_patterns.detected_libraries IS 'Detected libraries: three.js, pixi.js, babylon.js, custom, etc.';
COMMENT ON COLUMN webgl_animation_patterns.frame_analysis IS 'Frame analysis results: totalFrames, analyzedFrames, fps, duration_ms, avgDiffPercentage, maxDiffPercentage, animationIntensity';
COMMENT ON COLUMN webgl_animation_patterns.change_regions IS 'Bounding boxes of changed regions: [{ x, y, width, height, changeRatio }]';
COMMENT ON COLUMN webgl_animation_patterns.visual_features IS 'Visual features: dominantColors, motionDirection, periodicPattern, hasParticles, hasGradients, usesBlending';
COMMENT ON COLUMN webgl_animation_patterns.confidence IS 'Detection confidence score (0-1)';

COMMENT ON TABLE webgl_animation_embeddings IS 'Vector embeddings for WebGL animation patterns (768D multilingual-e5-base)';
COMMENT ON COLUMN webgl_animation_embeddings.embedding IS '768D vector embedding, HNSW indexed with cosine similarity';
COMMENT ON COLUMN webgl_animation_embeddings.text_representation IS 'Text representation used for embedding generation';

COMMENT ON FUNCTION find_similar_webgl_animations IS 'Find WebGL animation patterns similar to query embedding using HNSW cosine similarity';
COMMENT ON FUNCTION get_webgl_animation_stats IS 'Get statistics about WebGL animation patterns grouped by category';
