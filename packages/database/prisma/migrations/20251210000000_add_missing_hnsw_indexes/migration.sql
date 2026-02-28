-- Add missing HNSW indexes for vector search
-- These indexes were created directly on the database but missing from migration history
-- Using actual index names from the database
--
-- HNSW Parameters (Project Standard):
--   m=16: Graph connectivity (balance between recall and memory)
--   ef_construction=64: Index build quality (higher = better recall, slower build)
--   vector_cosine_ops: Cosine similarity for normalized embeddings (768D)
--
-- Performance Target: Vector Search P95 < 100ms
-- Reference: 

-- motion_embeddings HNSW index
CREATE INDEX IF NOT EXISTS "idx_motion_embeddings_hnsw"
ON "motion_embeddings" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- section_embeddings HNSW indexes
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_combined_hnsw"
ON "section_embeddings" USING hnsw ("combined_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "idx_section_embeddings_text_hnsw"
ON "section_embeddings" USING hnsw ("text_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "idx_section_embeddings_vision_hnsw"
ON "section_embeddings" USING hnsw ("vision_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
