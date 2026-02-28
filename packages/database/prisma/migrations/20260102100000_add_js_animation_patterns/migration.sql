-- Migration: Add JS Animation Patterns Support
-- Version: 20260102100000_add_js_animation_patterns
-- Description: JSAnimationPattern and JSAnimationEmbedding tables for
--              JS animation library detection (GSAP, Framer Motion, anime.js, Three.js, Lottie)
--              with Web Animations API and CDP data storage

-- =============================================================================
-- 1. Create ENUM types for JS Animation
-- =============================================================================

-- JSアニメーションライブラリの種別
CREATE TYPE "JSAnimationLibrary" AS ENUM (
    'gsap',
    'framer_motion',
    'anime_js',
    'three_js',
    'lottie',
    'web_animations_api',
    'unknown'
);

-- JSアニメーションの種別
CREATE TYPE "JSAnimationType" AS ENUM (
    'tween',
    'timeline',
    'spring',
    'physics',
    'keyframe',
    'morphing',
    'path',
    'scroll_driven',
    'gesture'
);

-- =============================================================================
-- 2. Create js_animation_patterns table
-- =============================================================================

CREATE TABLE "js_animation_patterns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID,

    -- ライブラリ情報
    "library_type" "JSAnimationLibrary" NOT NULL,
    "library_version" VARCHAR(50),

    -- アニメーション基本情報
    "name" VARCHAR(200) NOT NULL,
    "animation_type" "JSAnimationType" NOT NULL,
    "description" TEXT,

    -- ターゲット要素
    "target_selector" VARCHAR(500),
    "target_count" INTEGER,
    "target_tag_names" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- タイミング情報
    "duration_ms" INTEGER,
    "delay_ms" INTEGER,
    "easing" VARCHAR(100),
    "iterations" INTEGER,
    "direction" VARCHAR(20),
    "fill_mode" VARCHAR(20),

    -- キーフレーム情報（Web Animations API）
    "keyframes" JSONB DEFAULT '[]',

    -- プロパティ変化情報
    "properties" JSONB NOT NULL DEFAULT '[]',

    -- トリガー情報
    "trigger_type" VARCHAR(50),
    "trigger_config" JSONB DEFAULT '{}',

    -- CDP（Chrome DevTools Protocol）固有データ
    "cdp_animation_id" VARCHAR(100),
    "cdp_source_type" VARCHAR(50),
    "cdp_play_state" VARCHAR(20),
    "cdp_current_time" DOUBLE PRECISION,
    "cdp_start_time" DOUBLE PRECISION,
    "cdp_raw_data" JSONB,

    -- ライブラリ固有データ
    "library_specific_data" JSONB DEFAULT '{}',

    -- パフォーマンス情報
    "performance" JSONB NOT NULL DEFAULT '{}',

    -- アクセシビリティ
    "accessibility" JSONB NOT NULL DEFAULT '{}',

    -- ソース情報
    "source_url" TEXT,
    "usage_scope" TEXT NOT NULL DEFAULT 'inspiration_only',

    -- メタデータ
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,

    -- タイムスタンプ
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "js_animation_patterns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "js_animation_patterns_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

-- =============================================================================
-- 3. Create js_animation_embeddings table
-- =============================================================================

CREATE TABLE "js_animation_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "js_animation_pattern_id" UUID NOT NULL,

    -- Embedding (768D, multilingual-e5-base)
    "embedding" vector(768),

    -- テキスト表現
    "text_representation" TEXT,

    -- メタデータ
    "model_version" TEXT NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- タイムスタンプ
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "js_animation_embeddings_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- 4. Create B-tree indexes for js_animation_patterns
-- =============================================================================

CREATE INDEX "js_animation_patterns_web_page_id_idx"
ON "js_animation_patterns"("web_page_id");

CREATE INDEX "js_animation_patterns_library_type_idx"
ON "js_animation_patterns"("library_type");

CREATE INDEX "js_animation_patterns_animation_type_idx"
ON "js_animation_patterns"("animation_type");

CREATE INDEX "js_animation_patterns_trigger_type_idx"
ON "js_animation_patterns"("trigger_type");

CREATE INDEX "js_animation_patterns_library_animation_idx"
ON "js_animation_patterns"("library_type", "animation_type");

CREATE INDEX "js_animation_patterns_detected_at_idx"
ON "js_animation_patterns"("detected_at" DESC);

-- =============================================================================
-- 5. Create unique index for js_animation_embeddings
-- =============================================================================

CREATE UNIQUE INDEX "js_animation_embeddings_js_animation_pattern_id_key"
ON "js_animation_embeddings"("js_animation_pattern_id");

-- =============================================================================
-- 6. Create HNSW Vector Index for js_animation_embeddings
-- Parameters: m=16 (connectivity), ef_construction=64 (build quality)
-- Distance: cosine (for normalized embeddings from multilingual-e5-base)
-- Performance Target: Vector Search P95 < 100ms
-- =============================================================================

CREATE INDEX "idx_js_animation_embeddings_hnsw"
ON "js_animation_embeddings"
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- 7. Add foreign keys
-- =============================================================================

-- js_animation_patterns -> web_pages
ALTER TABLE "js_animation_patterns"
ADD CONSTRAINT "js_animation_patterns_web_page_id_fkey"
FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- js_animation_embeddings -> js_animation_patterns
ALTER TABLE "js_animation_embeddings"
ADD CONSTRAINT "js_animation_embeddings_js_animation_pattern_id_fkey"
FOREIGN KEY ("js_animation_pattern_id") REFERENCES "js_animation_patterns"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 8. Create helper function: find_similar_js_animations
-- Purpose: Semantic search for similar JS animation patterns using HNSW index
-- Parameters:
--   - query_embedding: 768D vector from embedding model
--   - library_type_filter: Optional filter by JS library type
--   - animation_type_filter: Optional filter by animation type
--   - min_similarity: Minimum cosine similarity threshold (0-1)
--   - result_limit: Maximum number of results
-- =============================================================================

CREATE OR REPLACE FUNCTION find_similar_js_animations(
  query_embedding vector(768),
  library_type_filter "JSAnimationLibrary" DEFAULT NULL,
  animation_type_filter "JSAnimationType" DEFAULT NULL,
  min_similarity FLOAT DEFAULT 0.7,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  pattern_id UUID,
  library_type "JSAnimationLibrary",
  animation_type "JSAnimationType",
  name VARCHAR(200),
  similarity FLOAT,
  duration_ms INT,
  easing VARCHAR(100),
  source_url TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    jap.id as pattern_id,
    jap.library_type,
    jap.animation_type,
    jap.name,
    (1 - (jae.embedding <=> query_embedding))::FLOAT as similarity,
    jap.duration_ms,
    jap.easing,
    jap.source_url
  FROM js_animation_patterns jap
  INNER JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
  WHERE jae.embedding IS NOT NULL
    AND (library_type_filter IS NULL OR jap.library_type = library_type_filter)
    AND (animation_type_filter IS NULL OR jap.animation_type = animation_type_filter)
    AND 1 - (jae.embedding <=> query_embedding) >= min_similarity
  ORDER BY similarity DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 9. Create helper function: get_js_animation_stats
-- Purpose: Get statistics about JS animation patterns by library type
-- =============================================================================

CREATE OR REPLACE FUNCTION get_js_animation_stats()
RETURNS TABLE (
  library_type "JSAnimationLibrary",
  pattern_count BIGINT,
  avg_duration_ms NUMERIC,
  with_embedding_count BIGINT,
  most_common_animation_type "JSAnimationType"
) AS $$
BEGIN
  RETURN QUERY
  WITH animation_counts AS (
    SELECT
      jap.library_type,
      jap.animation_type,
      COUNT(*) as type_count,
      ROW_NUMBER() OVER (PARTITION BY jap.library_type ORDER BY COUNT(*) DESC) as rn
    FROM js_animation_patterns jap
    GROUP BY jap.library_type, jap.animation_type
  )
  SELECT
    jap.library_type,
    COUNT(*)::BIGINT as pattern_count,
    ROUND(AVG(jap.duration_ms)::NUMERIC, 2) as avg_duration_ms,
    COUNT(jae.id)::BIGINT as with_embedding_count,
    ac.animation_type as most_common_animation_type
  FROM js_animation_patterns jap
  LEFT JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
  LEFT JOIN animation_counts ac ON ac.library_type = jap.library_type AND ac.rn = 1
  GROUP BY jap.library_type, ac.animation_type
  ORDER BY pattern_count DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 10. Add GIN index for JSONB search (keyframes, properties)
-- =============================================================================

CREATE INDEX "js_animation_patterns_keyframes_gin_idx"
ON "js_animation_patterns"
USING GIN ("keyframes");

CREATE INDEX "js_animation_patterns_properties_gin_idx"
ON "js_animation_patterns"
USING GIN ("properties");

CREATE INDEX "js_animation_patterns_library_specific_data_gin_idx"
ON "js_animation_patterns"
USING GIN ("library_specific_data");

-- =============================================================================
-- 11. Add comment documentation
-- =============================================================================

COMMENT ON TABLE js_animation_patterns IS 'JS animation library patterns (GSAP, Framer Motion, anime.js, Three.js, Lottie) detected from web pages';
COMMENT ON COLUMN js_animation_patterns.library_type IS 'JS animation library type: gsap, framer_motion, anime_js, three_js, lottie, web_animations_api, unknown';
COMMENT ON COLUMN js_animation_patterns.animation_type IS 'Animation type: tween, timeline, spring, physics, keyframe, morphing, path, scroll_driven, gesture';
COMMENT ON COLUMN js_animation_patterns.keyframes IS 'Web Animations API keyframes: [{ offset: 0, transform: "..." }, ...]';
COMMENT ON COLUMN js_animation_patterns.cdp_animation_id IS 'Chrome DevTools Protocol Animation ID';
COMMENT ON COLUMN js_animation_patterns.cdp_raw_data IS 'Raw CDP Animation.animationCreated event data';
COMMENT ON COLUMN js_animation_patterns.library_specific_data IS 'Library-specific data (GSAP timeline, Framer Motion variants, Lottie metadata)';
COMMENT ON COLUMN js_animation_patterns.confidence IS 'Detection confidence score (0-1)';

COMMENT ON TABLE js_animation_embeddings IS 'Vector embeddings for JS animation patterns (768D multilingual-e5-base)';
COMMENT ON COLUMN js_animation_embeddings.embedding IS '768D vector embedding, HNSW indexed with cosine similarity';
COMMENT ON COLUMN js_animation_embeddings.text_representation IS 'Text representation used for embedding generation';

COMMENT ON FUNCTION find_similar_js_animations IS 'Find JS animation patterns similar to query embedding using HNSW cosine similarity';
COMMENT ON FUNCTION get_js_animation_stats IS 'Get statistics about JS animation patterns grouped by library type';
