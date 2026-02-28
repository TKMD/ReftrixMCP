-- Add full-text search (tsvector) column to design_narrative_embeddings
-- for Hybrid Search (RRF: 60% vector + 40% full-text)
--
-- Uses GENERATED ALWAYS AS (STORED) for automatic maintenance:
-- PostgreSQL auto-updates search_vector when text_representation changes.
-- No application-level triggers or manual updates needed.
--
-- Pattern: Same as section_embeddings, motion_embeddings, background_design_embeddings
-- (see migration: 20260222000000_add_fulltext_search_tsvector)

-- ============================================================================
-- design_narrative_embeddings: tsvector GENERATED column
-- ============================================================================
ALTER TABLE design_narrative_embeddings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english', COALESCE(text_representation, ''))
) STORED;

-- GIN index for full-text search
CREATE INDEX idx_narrative_embeddings_search_vector
ON design_narrative_embeddings USING GIN (search_vector);
