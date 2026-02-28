-- Phase 5-4: Add mood/brandTone embeddings to SectionEmbedding table
-- These fields store embeddings for Vision AI detected mood and brandTone features
--
-- New Fields:
--   - mood_embedding: 768D vector for mood similarity search
--   - brand_tone_embedding: 768D vector for brandTone similarity search
--   - mood_text_representation: Source text for mood embedding generation
--   - brand_tone_text_representation: Source text for brandTone embedding generation
--
-- HNSW Parameters (Project Standard):
--   m=16: Graph connectivity (balance between recall and memory)
--   ef_construction=64: Index build quality (higher = better recall, slower build)
--   vector_cosine_ops: Cosine similarity for normalized embeddings (768D)
--
-- Performance Target: Vector Search P95 < 100ms
-- Reference: 

-- Add new columns to section_embeddings table
ALTER TABLE "section_embeddings"
ADD COLUMN IF NOT EXISTS "mood_embedding" vector(768),
ADD COLUMN IF NOT EXISTS "brand_tone_embedding" vector(768),
ADD COLUMN IF NOT EXISTS "mood_text_representation" TEXT,
ADD COLUMN IF NOT EXISTS "brand_tone_text_representation" TEXT;

-- Create HNSW index for mood_embedding
-- Enables semantic search: "Find sections with similar mood (professional, playful, minimal)"
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_mood_hnsw"
ON "section_embeddings" USING hnsw ("mood_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Create HNSW index for brand_tone_embedding
-- Enables semantic search: "Find sections with similar brandTone (corporate, startup, luxury)"
CREATE INDEX IF NOT EXISTS "idx_section_embeddings_brand_tone_hnsw"
ON "section_embeddings" USING hnsw ("brand_tone_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Add comments for documentation
COMMENT ON COLUMN "section_embeddings"."mood_embedding" IS 'Phase 5-4: 768D embedding for mood similarity search (multilingual-e5-base)';
COMMENT ON COLUMN "section_embeddings"."brand_tone_embedding" IS 'Phase 5-4: 768D embedding for brandTone similarity search (multilingual-e5-base)';
COMMENT ON COLUMN "section_embeddings"."mood_text_representation" IS 'Phase 5-4: Source text for mood embedding (e.g., "primary: professional, secondary: minimal")';
COMMENT ON COLUMN "section_embeddings"."brand_tone_text_representation" IS 'Phase 5-4: Source text for brandTone embedding (e.g., "primary: corporate, secondary: innovative")';
