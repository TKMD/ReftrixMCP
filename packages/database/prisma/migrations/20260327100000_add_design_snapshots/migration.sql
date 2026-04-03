-- CreateTable: design_snapshots (v0.3.0 T2-DCT)
-- デザイン変更時系列追跡（スナップショット）
-- Design change temporal tracking (snapshots)

CREATE TABLE "design_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID NOT NULL,
    "snapshot_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "section_count" INTEGER NOT NULL,
    "overall_score" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "design_snapshots_web_page_id_fkey" FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: design_snapshot_sections (v0.3.0 T2-DCT)
-- スナップショット内セクション（Embedding含む）
-- Sections within a snapshot (including embeddings)

CREATE TABLE "design_snapshot_sections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "section_type" TEXT NOT NULL,
    "section_name" TEXT,
    "position_index" INTEGER NOT NULL,
    "text_embedding" vector(768),
    "vision_embedding" vector(768),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_snapshot_sections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "design_snapshot_sections_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "design_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "design_snapshots_web_page_id_snapshot_at_idx" ON "design_snapshots"("web_page_id", "snapshot_at" DESC);
CREATE INDEX "design_snapshot_sections_snapshot_id_idx" ON "design_snapshot_sections"("snapshot_id");
