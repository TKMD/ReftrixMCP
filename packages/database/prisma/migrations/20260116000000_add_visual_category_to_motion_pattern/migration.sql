-- Phase3: MotionPatternテーブルに視覚的カテゴリ分類用カラムを追加
-- visual_category: フレーム差分解析から分類したアニメーションカテゴリ
-- visual_confidence: 分類信頼度 (0.0-1.0)
-- visual_metrics: フレーム差分から算出した詳細メトリクス

-- Add visual category column
ALTER TABLE "motion_patterns" ADD COLUMN IF NOT EXISTS "visual_category" VARCHAR(50);

-- Add visual confidence column
ALTER TABLE "motion_patterns" ADD COLUMN IF NOT EXISTS "visual_confidence" DOUBLE PRECISION;

-- Add visual metrics column (JSON)
ALTER TABLE "motion_patterns" ADD COLUMN IF NOT EXISTS "visual_metrics" JSONB;

-- Create index for visual category filtering
CREATE INDEX IF NOT EXISTS "motion_patterns_visual_category_idx" ON "motion_patterns"("visual_category");
