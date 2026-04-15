-- Migration: add_embedding_backfill_skipped_screenshot_missing
-- Purpose: Add `skipped_screenshot_missing` to the `EmbeddingBackfillStatus`
--          enum so that the PR7d-1 repair script can transition rows whose
--          persisted screenshot was destroyed by the PR7b-c retention-over-
--          deletion bug (see ADR-0010).
-- 目的: PR7b-c の retention-over-deletion バグ（ADR-0010）で永続化 screenshot
--       が消失した `queued` / `in_progress` 行を修復スクリプトで
--       `failed` + `skipped_screenshot_missing` に遷移できるよう、
--       enum 値を追加する（v0.4.0 PR7d-1）。
--
-- Safety:
--   - PostgreSQL の `ALTER TYPE ... ADD VALUE` は非破壊的（既存行は変更されない）
--   - New enum value is appended — existing rows are unaffected
--   - Rollback: `DROP TYPE` ではなく手動で列値を書き戻す必要があるため CAUTION
--   - Rollback: cannot simply `DROP VALUE` in PostgreSQL; would require
--     rewriting affected rows manually

ALTER TYPE "EmbeddingBackfillStatus" ADD VALUE IF NOT EXISTS 'skipped_screenshot_missing';
