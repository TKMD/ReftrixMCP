-- Add vision_embedding to MotionEmbedding table
-- This migration adds support for multimodal vision embeddings for motion patterns
--
-- New Fields:
--   - vision_embedding: 768D vector for visual motion similarity search
--   - vision_text_representation: Source text for vision embedding generation
--
-- HNSW Parameters (Project Standard):
--   m=16: Graph connectivity (balance between recall and memory)
--   ef_construction=64: Index build quality (higher = better recall, slower build)
--   vector_cosine_ops: Cosine similarity for normalized embeddings (768D)
--
-- Performance Target: Vector Search P95 < 100ms
-- Reference: 

-- Add new columns to motion_embeddings table
-- Columns are NULLABLE for backward compatibility
ALTER TABLE "motion_embeddings"
ADD COLUMN IF NOT EXISTS "vision_embedding" vector(768),
ADD COLUMN IF NOT EXISTS "vision_text_representation" TEXT;

-- Create HNSW index for vision_embedding
-- Enables semantic search: "Find motion patterns with similar visual appearance"
-- Note: For production with large tables, consider running CREATE INDEX CONCURRENTLY
-- manually outside of Prisma migrate transaction
CREATE INDEX IF NOT EXISTS "idx_motion_embeddings_vision_hnsw"
ON "motion_embeddings" USING hnsw ("vision_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Note: COMMENT ON COLUMN requires table ownership
-- If running as application user, comments are skipped
-- Comments can be added separately by a database admin:
-- COMMENT ON COLUMN "motion_embeddings"."vision_embedding" IS '768D embedding for visual motion similarity search (multilingual-e5-base)';
-- COMMENT ON COLUMN "motion_embeddings"."vision_text_representation" IS 'Source text for vision embedding (e.g., "visual_category: pulse, intensity: medium, regions: center")';
