-- Add full-text search (tsvector) columns to JS/WebGL animation embedding tables
-- for Hybrid Search (RRF: 60% vector + 40% full-text)
--
-- Uses GENERATED ALWAYS AS (STORED) for automatic maintenance:
-- PostgreSQL auto-updates search_vector when text_representation changes.
-- No application-level triggers or manual updates needed.

-- ============================================================================
-- 1. js_animation_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE js_animation_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_js_animation_embeddings_search_vector
ON js_animation_embeddings USING GIN (search_vector);

-- ============================================================================
-- 2. webgl_animation_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE webgl_animation_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_webgl_animation_embeddings_search_vector
ON webgl_animation_embeddings USING GIN (search_vector);
