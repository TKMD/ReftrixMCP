-- Migration: add_embedding_backfill_status
-- Purpose: Track Phase 5 embedding completeness per web_page so silently
--          skipped runs can be enqueued for backfill (PR2 of v0.4.0 6-PR series).
-- 目的: web_page 単位で Phase 5 embedding の完了状態を追跡し、サイレントに
--       スキップされたジョブを backfill キューに投入できるようにする
--       （v0.4.0 の 6-PR シリーズ PR2）。

-- 1. Enum 型 "EmbeddingBackfillStatus" を作成
--    Create enum type "EmbeddingBackfillStatus"
CREATE TYPE "EmbeddingBackfillStatus" AS ENUM (
  -- 全 embedding が同期生成済み（通常パス） / All embeddings generated inline (normal path)
  'not_required',
  -- Backfill Queue 投入待ち（PR4 で使用） / Queued for backfill worker (used by PR4)
  'queued',
  -- Backfill Worker 処理中（PR4） / Backfill worker in progress (PR4)
  'in_progress',
  -- Backfill 完了（PR4） / Backfill completed (PR4)
  'completed',
  -- Backfill が明確に失敗した / Backfill explicitly failed
  'failed',
  -- メモリ圧迫により Phase 5 をスキップ / Phase 5 skipped due to memory pressure
  'skipped_memory_pressure',
  -- fork child のエラーで Phase 5 をスキップ / Phase 5 skipped due to fork child error
  'skipped_fork_error'
);

-- 2. web_pages テーブルにカラムを追加（デフォルト 'not_required'）
--    Add column to web_pages (default 'not_required')
ALTER TABLE "web_pages"
  ADD COLUMN "embedding_backfill_status" "EmbeddingBackfillStatus"
  NOT NULL DEFAULT 'not_required';

-- 3. Backfill 対象（not_required 以外）のみを高速に検索するパーシャルインデックス
--    Partial index for fast lookup of pages needing backfill (non-default rows only)
CREATE INDEX "idx_web_pages_embedding_backfill_status"
  ON "web_pages" ("embedding_backfill_status")
  WHERE "embedding_backfill_status" != 'not_required';
