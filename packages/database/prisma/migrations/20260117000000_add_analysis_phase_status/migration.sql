-- Phase2-2: 段階的分析ステータス管理
-- WebPageモデルに段階的分析の進捗を追跡するフィールドを追加
-- 各フェーズ（Layout, Motion, Quality）完了時にステータスを更新し、
-- タイムアウト時も部分結果を保持できるようにする

-- AnalysisPhaseStatus Enum を作成
CREATE TYPE "AnalysisPhaseStatus" AS ENUM (
    'pending',      -- 未開始
    'layout_done',  -- Layoutフェーズ完了
    'motion_done',  -- Layout + Motionフェーズ完了
    'quality_done', -- 全フェーズ完了（completedと同義）
    'completed',    -- 完全完了（quality_doneのエイリアス）
    'failed'        -- 失敗（エラー発生）
);

-- WebPageテーブルに段階的分析ステータス関連フィールドを追加
ALTER TABLE "web_pages" ADD COLUMN "analysis_phase_status" "AnalysisPhaseStatus" NOT NULL DEFAULT 'pending';
ALTER TABLE "web_pages" ADD COLUMN "last_analyzed_phase" TEXT;
ALTER TABLE "web_pages" ADD COLUMN "analysis_error" TEXT;
ALTER TABLE "web_pages" ADD COLUMN "analysis_started_at" TIMESTAMP(3) WITH TIME ZONE;
ALTER TABLE "web_pages" ADD COLUMN "analysis_completed_at" TIMESTAMP(3) WITH TIME ZONE;

-- 既存データのマイグレーション: analysis_statusがcompletedの場合、analysis_phase_statusもcompletedに
UPDATE "web_pages"
SET "analysis_phase_status" = 'completed'
WHERE "analysis_status" = 'completed';

-- 既存データのマイグレーション: analysis_statusがprocessingの場合、pendingのまま
-- （処理中だったものは再開が必要）

-- 既存データのマイグレーション: analysis_statusがfailedの場合、failedに
UPDATE "web_pages"
SET "analysis_phase_status" = 'failed'
WHERE "analysis_status" = 'failed';

-- インデックスを追加
CREATE INDEX "web_pages_analysis_phase_status_idx" ON "web_pages"("analysis_phase_status");
CREATE INDEX "web_pages_project_id_analysis_phase_status_idx" ON "web_pages"("project_id", "analysis_phase_status");
