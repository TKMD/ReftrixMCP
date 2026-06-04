-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0018 Amendment 7 §7.1 (Plan v2 PR-B, UB-9): Part visual terminal-skip
-- per-row marker column `component_part_embeddings.visual_skip_reason`.
--
-- INV-PART-VISUAL-SKIP-TERMINAL-001 + INV-SCHEMA-ENUM-004 additive
-- Companion plan: 
--
-- A non-NULL value (one of the SSOT-derived terminal subset
-- EMBEDDING_PART_VISUAL_SKIP_REASONS = {bbox_invalid, bbox_unresolvable})
-- excludes the row from the part_visual pending query (single SSOT exclusion
-- predicate, NF-TPA-01 infinite re-fetch closure). NULL = not terminally
-- skipped (real-leak / retry target, INV-(b) orthogonality per ADR §7.5).
--
-- Non-breaking additive migration: nullable column with default NULL, so
-- existing rows are unaffected and concurrent INSERTs do not conflict (RISKS §6).
-- Rollback: db:restore from the db:migrate:safe auto-backup, OR
--   `prisma migrate resolve --rolled-back 20260523090000_add_part_visual_skip_reason`
--   then `ALTER TABLE component_part_embeddings DROP COLUMN visual_skip_reason;`.
--
-- Privacy (ADR §7.5 req5): visual_skip_reason stores only an enum value
-- (bbox_invalid / bbox_unresolvable), no PII. CASCADE-deleted with the parent
-- web_pages / component_parts row; no independent retention horizon; subsumed
-- by GDPR Art.17 data.delete row deletion (no additional erasure step).

-- Step 1: add nullable TEXT column (additive, default NULL).
ALTER TABLE "component_part_embeddings"
  ADD COLUMN IF NOT EXISTS "visual_skip_reason" TEXT;

-- Step 2: CHECK constraint restricting the column to the SSOT-derived terminal
-- subset (or NULL). The literal set MUST stay in lockstep with
-- EMBEDDING_PART_VISUAL_SKIP_REASONS (TS SSOT derived from EMBEDDING_SKIP_REASONS);
-- INV-SCHEMA-ENUM-004 additive test pins the 4-site (Prisma CHECK ↔ TS ↔ Zod ↔
-- MCP spec) equality. Future terminal-reason additions MUST extend both this
-- CHECK and the SSOT subset additively (ADR §7.5 req4).
ALTER TABLE "component_part_embeddings"
  DROP CONSTRAINT IF EXISTS "component_part_embeddings_visual_skip_reason_check";
ALTER TABLE "component_part_embeddings"
  ADD CONSTRAINT "component_part_embeddings_visual_skip_reason_check"
  CHECK ("visual_skip_reason" IS NULL
    OR "visual_skip_reason" IN ('bbox_invalid', 'bbox_unresolvable'));

-- Step 3: partial index for the exclusion-predicate scan (only the small
-- terminal-skip subset is indexed; NULL rows — the common case — are excluded).
CREATE INDEX IF NOT EXISTS "component_part_embeddings_visual_skip_reason_idx"
  ON "component_part_embeddings" ("visual_skip_reason")
  WHERE "visual_skip_reason" IS NOT NULL;
