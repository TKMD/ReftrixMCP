-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0018 Amendment (PR-BACKFILL-TERMINAL 系統B / System B): Section visual
-- terminal-skip per-row marker column `section_embeddings.vision_skip_reason`.
--
-- INV-BACKFILL-TERMINAL-COMPLETED-007 (Block D/E) + INV-SCHEMA-ENUM-004 additive
-- Companion plan: 
--
-- A non-NULL value (one of the SSOT-derived terminal subset
-- EMBEDDING_SECTION_VISUAL_SKIP_REASONS = {section_visual_uncroppable,
-- section_visual_duplicate}) excludes the row from the section_visual pending
-- query (single SSOT exclusion predicate `sectionVisualPendingExclusionPredicate`,
-- symmetry with part_visual NF-TPA-01 infinite re-fetch closure). NULL = not
-- terminally skipped (real-leak / retry target, INV-(b) orthogonality per
-- ADR-0018 §7.5). The two reasons are written only on the backfill path
-- (`fallbackEnabled === false`): `section_visual_uncroppable` at the
-- no_crop_buffer exit when `isOutOfRange === true` (the persisted fullPage
-- screenshot cannot crop the section and the backfill worker does not launch
-- Playwright per-section capture), and `section_visual_duplicate` at the dedup
-- exit (a same-type sibling at cosine > 0.995 represents the visual, so a
-- DINOv2 embedding is genuinely unnecessary — Type-aware dedup contract).
--
-- Non-breaking additive migration: nullable column with default NULL, so
-- existing rows are unaffected and concurrent INSERTs do not conflict (RISKS §6).
-- Rollback: db:restore from the db:migrate:safe auto-backup, OR
--   `prisma migrate resolve --rolled-back 20260524192012_add_section_visual_skip_reason`
--   then `ALTER TABLE section_embeddings DROP COLUMN vision_skip_reason;`.
--
-- Privacy (ADR-0018 §7.5 req5, mirrors precedent migration
-- 20260523090000_add_part_visual_skip_reason Privacy block lines 20-23):
-- vision_skip_reason stores only an enum value (section_visual_uncroppable /
-- section_visual_duplicate), no PII, not personal data under GDPR Art.4(1).
-- CASCADE-deleted with the parent section_patterns -> web_pages row; no
-- independent retention horizon; subsumed by GDPR Art.17 data.delete row
-- deletion (no additional erasure step).

-- Step 1: add nullable TEXT column (additive, default NULL).
ALTER TABLE "section_embeddings"
  ADD COLUMN IF NOT EXISTS "vision_skip_reason" TEXT;

-- Step 2: CHECK constraint restricting the column to the SSOT-derived terminal
-- subset (or NULL). The literal set MUST stay in lockstep with
-- EMBEDDING_SECTION_VISUAL_SKIP_REASONS (TS SSOT derived from
-- EMBEDDING_SKIP_REASONS via .filter()); INV-SCHEMA-ENUM-004 additive test pins
-- the migration CHECK <-> TS SSOT <-> Prisma schema field equality. Future
-- terminal-reason additions MUST extend both this CHECK and the SSOT subset
-- additively (ADR-0018 §7.5 req4).
ALTER TABLE "section_embeddings"
  DROP CONSTRAINT IF EXISTS "section_embeddings_vision_skip_reason_check";
ALTER TABLE "section_embeddings"
  ADD CONSTRAINT "section_embeddings_vision_skip_reason_check"
  CHECK ("vision_skip_reason" IS NULL
    OR "vision_skip_reason" IN ('section_visual_uncroppable', 'section_visual_duplicate'));

-- Step 3: partial index for the exclusion-predicate scan (only the small
-- terminal-skip subset is indexed; NULL rows — the common case — are excluded).
CREATE INDEX IF NOT EXISTS "section_embeddings_vision_skip_reason_idx"
  ON "section_embeddings" ("vision_skip_reason")
  WHERE "vision_skip_reason" IS NOT NULL;
