-- Webdesign HNSW Indexes
-- This SQL should be executed AFTER the Prisma migration
-- to create HNSW indexes for vector similarity search.
--
-- Reference: docs/plans/webdesign/07-database-schema.md
-- pgvector version: 0.8.x
-- HNSW parameters: m=16, ef_construction=64

-- ============================================================================
-- Section Embeddings HNSW Indexes
-- ============================================================================

-- Index for text-based embedding search (v1)
CREATE INDEX IF NOT EXISTS idx_section_embeddings_text_hnsw
ON section_embeddings USING hnsw (text_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index for vision-based embedding search (v2 future)
CREATE INDEX IF NOT EXISTS idx_section_embeddings_vision_hnsw
ON section_embeddings USING hnsw (vision_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index for combined embedding search (v2 future)
CREATE INDEX IF NOT EXISTS idx_section_embeddings_combined_hnsw
ON section_embeddings USING hnsw (combined_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- Motion Embeddings HNSW Index
-- ============================================================================

-- Index for motion pattern embedding search
CREATE INDEX IF NOT EXISTS idx_motion_embeddings_hnsw
ON motion_embeddings USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- Performance Monitoring Functions
-- ============================================================================

-- Function to get HNSW index statistics
CREATE OR REPLACE FUNCTION webdesign_get_hnsw_stats()
RETURNS TABLE (
    index_name text,
    table_name text,
    index_size text,
    num_vectors bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        i.indexrelname::text,
        i.relname::text,
        pg_size_pretty(pg_relation_size(i.indexrelid))::text,
        t.n_live_tup::bigint
    FROM pg_stat_user_indexes i
    JOIN pg_stat_user_tables t ON i.relid = t.relid
    WHERE i.indexrelname LIKE '%hnsw%'
      AND (i.relname = 'section_embeddings' OR i.relname = 'motion_embeddings');
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Search Time ef_search Configuration
-- ============================================================================
-- Note: These settings can be adjusted per-query for precision/speed tradeoff
-- Default: ef_search = 40 (balanced)
-- High precision: ef_search = 100
-- High speed: ef_search = 10

-- Example: Set search-time parameter for current session
-- SET hnsw.ef_search = 40;

-- ============================================================================
-- Usage Notes
-- ============================================================================
--
-- 1. Run this SQL after the Prisma migration is applied
-- 2. HNSW indexes are built incrementally - initial build is fast
-- 3. For optimal performance, ensure sufficient shared_buffers
-- 4. Monitor index size with webdesign_get_hnsw_stats() function
--
-- Recommended PostgreSQL settings for pgvector:
--   shared_buffers = 256MB (minimum)
--   effective_cache_size = 1GB (minimum)
--   maintenance_work_mem = 512MB (for index builds)
