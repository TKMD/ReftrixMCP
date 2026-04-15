-- v0.4.0 PR7a-1: Add embedding backfill retry tracking columns to web_pages
-- v0.4.0 PR7a-1: web_pages に embedding backfill 再投入追跡カラムを追加
--
-- Purpose / 目的:
--   Phase 5 skip recovery + 全 7 カテゴリ Queue 化 (PR7a) の DB 基盤。
--   4 面監査の指摘 SEC HIGH-1 (無限ループ防御) / TPA H-1 (stale 判定役割分離)
--   に対応するため、以下 2 カラムを追加する。
--
--   DB foundation for Phase 5 skip recovery + 7-category Queue coverage (PR7a).
--   Adds the following 2 columns to address 4-agent audit findings:
--     SEC HIGH-1 (infinite-loop defense) / TPA H-1 (stale-detection role separation).
--
-- Added columns / 追加カラム:
--   1. embedding_backfill_retry_count  INTEGER  NOT NULL DEFAULT 0
--      - 1 ページあたりの Queue 再投入回数。skip recovery cron が skipped_fork_error
--        / skipped_memory_pressure から Queue へ戻すたびにインクリメントする。
--      - Worker 側で 5 回超過を検出したら embedding_backfill_status を 'failed' に
--        固定し、永続的メモリ不足 / fork 障害による無限ループを防止する (SEC HIGH-1)。
--
--      - Per-page re-enqueue count. Incremented by the skip recovery cron each time a
--        page is moved back to the queue from skipped_fork_error / skipped_memory_pressure.
--      - Workers detect counts exceeding 5 and pin embedding_backfill_status to 'failed',
--        preventing infinite re-enqueue loops from persistent memory pressure / fork
--        failures (SEC HIGH-1).
--
--   2. embedding_backfill_skipped_at   TIMESTAMPTZ  NULL
--      - status が skipped_fork_error / skipped_memory_pressure に遷移した時刻。
--      - embedding_backfill_started_at (PR6) とは役割を分離する (TPA H-1):
--          startedAt: queued / in_progress の stale 判定 (1h 経過で reconciliation)
--          skippedAt: skipped_* からの recovery スケジューリング
--        単一列に両 semantics を混在させると、リカバリ対象特定が updated_at のゆらぎ
--        に影響されうるため、専用列として分離する。
--
--      - Timestamp when status transitioned to skipped_fork_error / skipped_memory_pressure.
--      - Role-separated from embedding_backfill_started_at (PR6) per TPA H-1:
--          startedAt: stale detection for queued / in_progress (1h-aged reconciliation)
--          skippedAt: recovery scheduling from skipped_*
--        Keeping both semantics in one column would make recovery-target selection
--        susceptible to unrelated updated_at fluctuations, hence the dedicated column.
--
-- Non-breaking / 後方互換性:
--   - 既存行には DEFAULT 0 / NULL が適用される。
--     retry_count=0 かつ skipped_at IS NULL の行は過去データと区別不能だが、
--     skip recovery cron は status フィルタ (skipped_fork_error / skipped_memory_pressure)
--     で対象を絞るため、既存 not_required / completed 行への影響はない。
--   - Existing rows receive DEFAULT 0 / NULL. Rows with retry_count=0 and
--     skipped_at IS NULL are indistinguishable from historical data, but the
--     skip recovery cron filters targets by status (skipped_fork_error /
--     skipped_memory_pressure) so existing not_required / completed rows are unaffected.
--
-- Index strategy / インデックス戦略:
--   - Partial index on embedding_backfill_skipped_at for rows in skipped_* state only.
--     Skip recovery cron queries these states; partial index minimizes size and keeps
--     the sweep fast even as historical skipped rows accumulate.
--   - Partial インデックスを skipped_* 状態の行のみに作成する。Skip recovery cron は
--     これらの状態を対象に走査するため、インデックスサイズを最小化し、skipped 行の
--     蓄積後も sweep を高速に保つ。

ALTER TABLE "web_pages"
  ADD COLUMN "embedding_backfill_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "embedding_backfill_skipped_at" TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS "idx_web_pages_backfill_skipped"
  ON "web_pages" ("embedding_backfill_skipped_at")
  WHERE "embedding_backfill_status" IN ('skipped_fork_error', 'skipped_memory_pressure');
