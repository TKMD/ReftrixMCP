-- Plan v3 T3-Backfill V1 §3.1 axis B + axis F (atomic Prisma migration)
-- INV-BACKFILL-FAILURE-REASON-MIGRATION-007 + INV-SCHEMA-ENUM-004 4-layer sync
-- ADR-0007 Amendment 1 §A1.2.1 (C-1 winning contract) + §A1.2.4 (axis F screenshot defer)
-- IO Plan Decision V0 §4.1 C-1 + §13.5 U-T3B-5
--
-- Schema additions (atomic landing, single migration step per IO §6.3 Wave 2 atomicity):
--   1. ALTER TYPE EmbeddingBackfillStatus ADD VALUE 'failed_with_known_reason' (axis B)
--   2. ALTER TABLE web_pages ADD COLUMN embedding_backfill_failure_reason TEXT (axis B)
--   3. ALTER TABLE web_pages ADD COLUMN embedding_backfill_failed_at TIMESTAMPTZ (axis B)
--   4. ALTER TABLE web_pages ADD COLUMN screenshot_deletion_deferred_at TIMESTAMPTZ (axis F)
--   5. CREATE INDEX on embedding_backfill_failure_reason (recovery scheduler scan)
--   6. CREATE INDEX on screenshot_deletion_deferred_at (cleanup cron scan)

-- Step 1: ALTER TYPE additive (axis B). New enum value cannot be used
-- in the same transaction as ALTER TYPE in PostgreSQL <12, so the
-- migration runner runs ALTER TYPE first, commits, and then runs the
-- remaining DDL in a follow-up transaction.
ALTER TYPE "EmbeddingBackfillStatus" ADD VALUE IF NOT EXISTS 'failed_with_known_reason';

-- Step 2: axis B columns on web_pages
ALTER TABLE "web_pages" ADD COLUMN IF NOT EXISTS "embedding_backfill_failure_reason" TEXT;
ALTER TABLE "web_pages" ADD COLUMN IF NOT EXISTS "embedding_backfill_failed_at" TIMESTAMPTZ;

-- Step 3: axis F column on web_pages (single-deferral cap timestamp)
ALTER TABLE "web_pages" ADD COLUMN IF NOT EXISTS "screenshot_deletion_deferred_at" TIMESTAMPTZ;

-- Step 4: indexes for recovery scheduler scan (axis B) + axis F cron scan
CREATE INDEX IF NOT EXISTS "web_pages_embedding_backfill_failure_reason_idx"
  ON "web_pages" ("embedding_backfill_failure_reason")
  WHERE "embedding_backfill_failure_reason" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "web_pages_screenshot_deletion_deferred_at_idx"
  ON "web_pages" ("screenshot_deletion_deferred_at")
  WHERE "screenshot_deletion_deferred_at" IS NOT NULL;
