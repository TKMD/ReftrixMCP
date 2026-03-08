-- ============================================================================
-- Migration: add_preference_profiling
-- Description: Add PreferenceProfile and PreferenceSignal tables
--              for user preference profiling (preference.hear / .get / .reset)
-- Created: 2026-03-07
-- ============================================================================

-- Ensure pgvector extension is available (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable: preference_profiles
-- Purpose: Store user design preference profiles with vector embeddings
-- Relationship: 1:N with PreferenceSignal
CREATE TABLE "preference_profiles" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "name" VARCHAR(100) NOT NULL DEFAULT 'default',
    "preference_embedding" vector(768),
    "preference_text" TEXT,
    "interaction_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: preference_signals
-- Purpose: Store individual preference feedback signals (hearing_positive, etc.)
-- Relationship: N:1 with PreferenceProfile (CASCADE on delete)
CREATE TABLE "preference_signals" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "profile_id" UUID NOT NULL,
    "signal_type" VARCHAR(50) NOT NULL,
    "signal_weight" DOUBLE PRECISION NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID NOT NULL,
    "feedback_text" TEXT,
    "embedding" vector(768),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_signals_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- Indexes: preference_profiles
-- ============================================================================

-- CreateIndex: HNSW index for preference embedding vector similarity search
-- Parameters: m=16, ef_construction=64, vector_cosine_ops
-- Performance Target: P95 < 100ms
CREATE INDEX "idx_preference_profiles_embedding_hnsw" ON "preference_profiles"
USING hnsw ("preference_embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- Indexes: preference_signals
-- ============================================================================

-- CreateIndex: B-tree indexes for common query patterns
CREATE INDEX "preference_signals_profile_id_idx" ON "preference_signals"("profile_id");
CREATE INDEX "preference_signals_signal_type_idx" ON "preference_signals"("signal_type");
CREATE INDEX "preference_signals_target_type_target_id_idx" ON "preference_signals"("target_type", "target_id");
CREATE INDEX "preference_signals_created_at_idx" ON "preference_signals"("created_at" DESC);

-- ============================================================================
-- Foreign Keys
-- ============================================================================

-- AddForeignKey: preference_signals -> preference_profiles (CASCADE on delete)
ALTER TABLE "preference_signals" ADD CONSTRAINT "preference_signals_profile_id_fkey"
FOREIGN KEY ("profile_id") REFERENCES "preference_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE "preference_profiles" IS
  'User design preference profiles with vector embeddings for semantic similarity search. HNSW indexed (m=16, ef_construction=64).';

COMMENT ON TABLE "preference_signals" IS
  'Individual preference feedback signals captured by preference.hear. Types: hearing_positive/negative/neutral, code_generate, search_click.';

COMMENT ON COLUMN "preference_profiles"."preference_embedding" IS
  '768D vector (multilingual-e5-base) representing aggregated design preferences. HNSW indexed for cosine similarity.';

COMMENT ON COLUMN "preference_profiles"."preference_text" IS
  'Source text for embedding generation. Example: "minimalist dark design with bold typography and smooth animations".';

COMMENT ON COLUMN "preference_profiles"."interaction_count" IS
  'Cumulative number of preference signals received for this profile.';

COMMENT ON COLUMN "preference_signals"."signal_type" IS
  'Type of preference signal: hearing_positive, hearing_negative, hearing_neutral, code_generate, search_click.';

COMMENT ON COLUMN "preference_signals"."signal_weight" IS
  'Signal weight: positive values indicate preference, negative values indicate aversion.';

COMMENT ON COLUMN "preference_signals"."target_type" IS
  'Polymorphic target type: web_page, section_pattern, motion_pattern, background_design.';

COMMENT ON COLUMN "preference_signals"."feedback_text" IS
  'LLM-summarized feedback text (not raw user input). Used for embedding generation.';
