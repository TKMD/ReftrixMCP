-- CreateTable: search_logs (v0.3.0 T2-FAC)
-- 検索ログ記録・分析（ファセット検索 + MLフィードバックループ基盤）
-- Search log recording & analysis (facet search + ML feedback loop foundation)

CREATE TABLE "search_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query" VARCHAR(200) NOT NULL,
    "query_type" VARCHAR(50),
    "services" TEXT[] NOT NULL DEFAULT '{}',
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "top_result_id" VARCHAR(50),
    "filters" JSONB,
    "latency_ms" INTEGER,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "profile_id" VARCHAR(50),

    CONSTRAINT "search_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_search_logs_timestamp" ON "search_logs"("timestamp");
CREATE INDEX "idx_search_logs_query_type" ON "search_logs"("query_type");
CREATE INDEX "idx_search_logs_cache_hit" ON "search_logs"("cache_hit");
