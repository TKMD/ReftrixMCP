-- CreateTable: component_parts
CREATE TABLE "component_parts" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "web_page_id" UUID NOT NULL,
    "section_pattern_id" UUID NOT NULL,
    "part_type" VARCHAR(50) NOT NULL,
    "part_subtype" VARCHAR(100),
    "html_snippet" TEXT,
    "computed_styles" JSONB NOT NULL DEFAULT '{}',
    "bounding_box" JSONB NOT NULL DEFAULT '{}',
    "css_classes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "interaction_info" JSONB NOT NULL DEFAULT '{}',
    "visual_signature" VARCHAR(64),
    "sample_index" INTEGER NOT NULL DEFAULT 0,
    "pii_risk_level" VARCHAR(10) NOT NULL DEFAULT 'none',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "source_url" TEXT,
    "usage_scope" VARCHAR(20) NOT NULL DEFAULT 'inspiration_only',
    "extracted_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "component_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: component_part_embeddings
CREATE TABLE "component_part_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_uuidv7(),
    "component_part_id" UUID NOT NULL,
    "visual_embedding" vector(768),
    "text_embedding" vector(768),
    "text_representation" TEXT,
    -- search_vector will be replaced by GENERATED ALWAYS below
    "visual_model_version" VARCHAR(50) NOT NULL,
    "text_model_version" VARCHAR(50) NOT NULL,
    "embedding_timestamp" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "component_part_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: B-tree indexes for component_parts
CREATE INDEX "component_parts_web_page_id_idx" ON "component_parts"("web_page_id");
CREATE INDEX "component_parts_section_pattern_id_idx" ON "component_parts"("section_pattern_id");
CREATE INDEX "component_parts_part_type_idx" ON "component_parts"("part_type");
CREATE INDEX "component_parts_web_page_id_part_type_idx" ON "component_parts"("web_page_id", "part_type");
CREATE INDEX "component_parts_pii_risk_level_idx" ON "component_parts"("pii_risk_level");

-- CreateIndex: Unique constraint for deduplication
CREATE UNIQUE INDEX "component_parts_section_pattern_id_visual_signature_key" ON "component_parts"("section_pattern_id", "visual_signature");

-- CreateIndex: B-tree index for component_part_embeddings
CREATE UNIQUE INDEX "component_part_embeddings_component_part_id_key" ON "component_part_embeddings"("component_part_id");
CREATE INDEX "component_part_embeddings_component_part_id_idx" ON "component_part_embeddings"("component_part_id");

-- AddForeignKey: component_parts -> web_pages
ALTER TABLE "component_parts" ADD CONSTRAINT "component_parts_web_page_id_fkey" FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: component_parts -> section_patterns
ALTER TABLE "component_parts" ADD CONSTRAINT "component_parts_section_pattern_id_fkey" FOREIGN KEY ("section_pattern_id") REFERENCES "section_patterns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: component_part_embeddings -> component_parts
ALTER TABLE "component_part_embeddings" ADD CONSTRAINT "component_part_embeddings_component_part_id_fkey" FOREIGN KEY ("component_part_id") REFERENCES "component_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Generated tsvector column for full-text search
-- Replaces the Prisma-defined search_vector with a GENERATED ALWAYS column
ALTER TABLE "component_part_embeddings"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', COALESCE("text_representation", ''))) STORED;

-- HNSW indexes for vector similarity search (m=16, ef_construction=64)
CREATE INDEX idx_component_part_embeddings_visual_hnsw
  ON "component_part_embeddings"
  USING hnsw ("visual_embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_component_part_embeddings_text_hnsw
  ON "component_part_embeddings"
  USING hnsw ("text_embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search
CREATE INDEX idx_component_part_embeddings_search_vector
  ON "component_part_embeddings"
  USING gin ("search_vector");
