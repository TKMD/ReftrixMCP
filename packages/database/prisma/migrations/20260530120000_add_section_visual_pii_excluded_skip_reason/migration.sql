-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0018 Amendment (PR-C4): Additively extend the section_visual terminal-skip
-- CHECK constraint on `section_embeddings.vision_skip_reason` with the new value
-- `section_visual_pii_excluded` (2 values -> 3 values).
--
-- INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011 (large-page) +
-- INV-SCHEMA-ENUM-004 additive (23-value lockstep)
-- Companion plan: 
-- Companion ADR:  
-- Precedent:      20260524192012_add_section_visual_skip_reason (initial 2-value CHECK)
--
-- Root cause (PII asymmetry): the backfill section_visual pending predicate left
-- high-PII sections — that the work side intentionally excludes for PII
-- data-minimisation (GDPR Art.5(1)(c)) — permanently pending because the pending
-- side lacked the symmetric PII filter (the work side reaches neither DINOv2 nor
-- writeSectionVisionSkipReason for high-PII sections). `section_visual_pii_excluded`
-- is written at the work-side PII-exclusion site as the GDPR Art.30 processing
-- trail ("intentionally not visually embedded due to PII"), and — like the existing
-- `section_visual_uncroppable` / `section_visual_duplicate` reasons — a non-NULL
-- value excludes the row from the section_visual pending query (single SSOT
-- exclusion predicate `sectionVisualPendingExclusionPredicate`), allowing the page
-- to reach `completed`. `skipReasonToBackfillStatus()` maps it to `not_required`.
--
-- The literal set MUST stay in lockstep with EMBEDDING_SECTION_VISUAL_SKIP_REASONS
-- (TS SSOT derived from EMBEDDING_SKIP_REASONS via .filter()); INV-SCHEMA-ENUM-004
-- additive test pins the migration CHECK <-> TS SSOT <-> Prisma schema field
-- equality (now 3 values). Future terminal-reason additions MUST extend both this
-- CHECK and the SSOT subset additively (ADR-0018 §7.5 req4).
--
-- Non-breaking additive migration: the CHECK is re-created with one additional
-- allowed literal. Existing rows are unaffected (NULL stays valid, the two prior
-- values stay valid); no row is rejected by the widened constraint, so this cannot
-- fail on existing data (RISKS R3). The DROP/ADD CONSTRAINT idiom mirrors the
-- precedent migration 20260524192012 lines 47-52. SQL injection surface: none —
-- the literal set is enum-bound and there is no user-input interpolation
-- (SEC-RV1-01 confirmed pattern).
--
-- Rollback: db:restore from the db:migrate:safe auto-backup, OR
--   `prisma migrate resolve --rolled-back 20260530120000_add_section_visual_pii_excluded_skip_reason`
--   then re-create the CHECK with only the original two values:
--     ALTER TABLE "section_embeddings"
--       DROP CONSTRAINT IF EXISTS "section_embeddings_vision_skip_reason_check";
--     ALTER TABLE "section_embeddings"
--       ADD CONSTRAINT "section_embeddings_vision_skip_reason_check"
--       CHECK ("vision_skip_reason" IS NULL
--         OR "vision_skip_reason" IN ('section_visual_uncroppable', 'section_visual_duplicate'));
--
-- Privacy (mirrors precedent migration 20260524192012 Privacy block lines 28-34):
-- vision_skip_reason stores only an enum value (section_visual_uncroppable /
-- section_visual_duplicate / section_visual_pii_excluded), no PII, not personal
-- data under GDPR Art.4(1). CASCADE-deleted with the parent
-- section_patterns -> web_pages row; no independent retention horizon; subsumed by
-- GDPR Art.17 data.delete row deletion (no additional erasure step). The new value
-- strengthens GDPR Art.5(1)(c) data-minimisation + Art.30 processing-records (it
-- records WHY the high-PII section's visual was not generated).

-- Additively widen the CHECK constraint to the 3-value SSOT-derived terminal subset
-- (or NULL). The partial index from migration 20260524192012 already covers all
-- non-NULL terminal-skip rows and requires no change (it is value-agnostic).
ALTER TABLE "section_embeddings"
  DROP CONSTRAINT IF EXISTS "section_embeddings_vision_skip_reason_check";
ALTER TABLE "section_embeddings"
  ADD CONSTRAINT "section_embeddings_vision_skip_reason_check"
  CHECK ("vision_skip_reason" IS NULL
    OR "vision_skip_reason" IN ('section_visual_uncroppable', 'section_visual_duplicate', 'section_visual_pii_excluded'));
