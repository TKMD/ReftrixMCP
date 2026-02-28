-- Add full-text search (tsvector) columns to embedding tables
-- for Hybrid Search (RRF: 60% vector + 40% full-text)
--
-- Uses GENERATED ALWAYS AS (STORED) for automatic maintenance:
-- PostgreSQL auto-updates search_vector when text_representation changes.
-- No application-level triggers or manual updates needed.

-- ============================================================================
-- 1. section_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE section_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_section_embeddings_search_vector
ON section_embeddings USING GIN (search_vector);

-- ============================================================================
-- 2. motion_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE motion_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_motion_embeddings_search_vector
ON motion_embeddings USING GIN (search_vector);

-- ============================================================================
-- 3. background_design_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE background_design_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_bg_design_embeddings_search_vector
ON background_design_embeddings USING GIN (search_vector);
