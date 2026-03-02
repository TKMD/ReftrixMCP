-- CreateTable: responsive_analyses
-- レスポンシブデザイン分析結果を保持するテーブル
-- マルチビューポート比較、ブレークポイント検出、スクリーンショット差分

CREATE TABLE "responsive_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_page_id" UUID NOT NULL,
    "viewports_analyzed" JSONB NOT NULL,
    "differences" JSONB NOT NULL,
    "breakpoints" JSONB,
    "screenshot_diffs" JSONB,
    "quality_metrics" JSONB,
    "analysis_time_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "responsive_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idx_responsive_analyses_web_page_id
CREATE INDEX "idx_responsive_analyses_web_page_id" ON "responsive_analyses"("web_page_id");

-- AddForeignKey: responsive_analyses.web_page_id → web_pages.id (CASCADE)
ALTER TABLE "responsive_analyses" ADD CONSTRAINT "responsive_analyses_web_page_id_fkey" FOREIGN KEY ("web_page_id") REFERENCES "web_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
