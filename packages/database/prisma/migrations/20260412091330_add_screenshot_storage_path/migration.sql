-- Migration: add_screenshot_storage_path
-- Purpose: Persist screenshot file path across page.analyze completion
--          for Phase 5 Queue-based Backfill (v0.4.0)
-- 目的: page.analyze 完了後も screenshot ファイルパスを保持し、
--       Phase 5 Queue-based Backfill (v0.4.0) から参照可能にする

ALTER TABLE "web_pages" ADD COLUMN "screenshot_storage_path" TEXT;
