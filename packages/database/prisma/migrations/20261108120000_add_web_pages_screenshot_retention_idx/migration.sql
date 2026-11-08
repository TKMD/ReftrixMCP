-- SPDX-License-Identifier: AGPL-3.0-only
-- Screenshot retention scan index (ADR-0041 Amendment 5 follow-up, TPA L-2).
--
-- The retention cycle selects rows by `updated_at < cutoff` among rows that still
-- hold a screenshot (`screenshot_storage_path IS NOT NULL`). Without an index the
-- scan is a sequential scan over every web_pages row on each cycle (hourly). This
-- partial index holds only rows that still have a screenshot, so it stays small:
-- rows leave it as soon as the retention cycle or data.delete clears the path.
--
-- 保持期限の削除は「screenshot を持つ行のうち updated_at が cutoff より前」を選ぶ。
-- screenshot を持つ行だけの partial index にし、path が NULL になった行は外れる。
--
-- Additive only: no column or data change. Like the other partial indexes on
-- web_pages (20260412120000, 20260510120000) it is raw SQL and not modelled in
-- schema.prisma (Prisma 6 has no partial-index syntax).

CREATE INDEX IF NOT EXISTS "idx_web_pages_screenshot_retention"
  ON "web_pages" ("updated_at")
  WHERE "screenshot_storage_path" IS NOT NULL;
