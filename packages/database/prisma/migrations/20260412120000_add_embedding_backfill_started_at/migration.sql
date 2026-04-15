-- v0.4.0 PR6: Add embedding_backfill_started_at column to web_pages
-- v0.4.0 PR6: web_pages に embedding_backfill_started_at カラムを追加
--
-- Purpose / 目的:
--   - backfill-reconciliation.service.ts の stale 判定を updated_at 依存から
--     専用列ベースに切り替え、他カラム更新との衝突を排除する。
--   - Replace updated_at dependency in stale detection logic of
--     backfill-reconciliation.service.ts with a dedicated column to eliminate
--     conflicts with unrelated column updates.
--
-- Non-breaking / 後方互換性:
--   - 既存行は NULL で埋められる。NULL 行は stale 判定対象外（reconciliation
--     は embedding_backfill_status = 'in_progress' かつ started_at NOT NULL を要件とする）。
--   - Existing rows are filled with NULL. NULL rows are exempt from stale detection.
--
-- Index strategy / インデックス戦略:
--   - Partial index: only rows where value IS NOT NULL (the stale-detection hot path).
--     Reduces index size and keeps reconciliation sweep fast.
--   - Partial インデックス: IS NOT NULL のみを対象（stale 判定のホットパス）。
--     インデックスサイズを抑制し reconciliation スイープを高速化。

ALTER TABLE "web_pages"
  ADD COLUMN "embedding_backfill_started_at" TIMESTAMPTZ NULL;

CREATE INDEX "idx_web_pages_backfill_started_at"
  ON "web_pages" ("embedding_backfill_started_at")
  WHERE "embedding_backfill_started_at" IS NOT NULL;
