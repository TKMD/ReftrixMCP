-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0018 Amendment 13 (visual-backfill truncated-screenshot data-loss fix,
-- Plan §5.6 / §8.8, FIND-RE-TDA-M-01 / CONFLICT-V1-01): additively extend BOTH
-- the part `component_part_embeddings.visual_skip_reason` and the section
-- `section_embeddings.vision_skip_reason` terminal-skip CHECK constraints with
-- the two new values `screenshot_truncated` (non-terminal, bounded-retryable) +
-- `screenshot_truncated_expired` (terminal). Part: 2 -> 4 values; section:
-- 5 -> 7 values.
--
-- INV-SCHEMA-ENUM-004 re-definition (Plan §5.6 (ii)): the per-column CHECK now
-- equals "the full set of WRITABLE skip reasons" = terminal subset ∪
-- {screenshot_truncated} (= every value `writePartVisualTerminalSkipMarker` /
-- `writeSectionVisionSkipReason` can emit, excluding NULL). `screenshot_truncated`
-- is WRITABLE but NON-terminal (it stays pending and is retried via the 3-way
-- pending predicate); only `screenshot_truncated_expired` is added to the
-- terminal subset (`EMBEDDING_PART_VISUAL_SKIP_REASONS` /
-- `EMBEDDING_SECTION_VISUAL_SKIP_REASONS`).
--
-- Companion plan:   (V3)
-- IO Plan Decision V3 = APPROVE (visual-backfill-fork-failure-finding-registry-v3.md)
-- Precedent:       20260531090000_add_section_visual_blank_no_position_skip_reasons (section DROP/ADD, 3->5)
-- Precedent:       20260530120000_add_section_visual_pii_excluded_skip_reason (section DROP/ADD, 2->3)
-- Precedent:       20260524192012_add_section_visual_skip_reason (section initial 2-value CHECK + index)
-- Precedent:       20260523090000_add_part_visual_skip_reason (part initial 2-value CHECK + index)
--
-- Root cause (recoverable permanent data-loss): on a WebGL site Phase 0 persists
-- a viewport-only (1920x1080) truncated fullPage screenshot, so the part/section
-- visual crop guard treats every fold-below part/section as off-screen and writes
-- the terminal `bbox_unresolvable` / `section_visual_uncroppable` marker — the row
-- is excluded from the pending query forever and the page converges to a
-- false-`failed`. Amendment 13 routes the off-screen-DUE-TO-TRUNCATION case
-- (`isScreenshotTruncated()` AND the section-fallback flag ON, Plan §5.9
-- flag-gating) to the bounded-retryable `screenshot_truncated` instead, which the
-- 3-way pending predicate keeps pending so it is retried via the
-- `skipped_fork_error` retry bucket until the PR-B section fallback supplies a
-- real generation source, OR the bounded budget (`SCREENSHOT_TRUNCATED_RETRY_CAP`
-- = 5) converges it fail-loud to the `screenshot_truncated_expired` terminal
-- (page-level `not_required`, NOT `failed`).
--
-- The literal set MUST stay in lockstep with the TS SSOT
-- `EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS` /
-- `EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS` (derived from
-- EMBEDDING_SKIP_REASONS via concat of the `.filter()` terminal subset +
-- {screenshot_truncated}); INV-SCHEMA-ENUM-004 pins the migration CHECK <-> TS
-- writable-set equality. Future writable-reason additions MUST extend both this
-- CHECK and the SSOT writable set additively (ADR-0018 §7.5 req4 / Amendment 13 §8.8).
--
-- Non-breaking additive migration: each CHECK is re-created with the additional
-- allowed literals. Existing rows are unaffected (NULL stays valid, all prior
-- values stay valid); no row is rejected by the widened constraint, so this cannot
-- fail on existing data. The DROP/ADD CONSTRAINT idiom mirrors the precedent
-- migrations 20260531090000 / 20260530120000 / 20260524192012. SQL injection
-- surface: none — the literal set is enum-bound and there is no user-input
-- interpolation (SEC-RV1-01 confirmed pattern).
--
-- Rollback: db:restore from the db:migrate:safe auto-backup, OR
--   `prisma migrate resolve --rolled-back 20260608120000_add_screenshot_truncated_skip_reasons`
--   then re-create both CHECKs with only the prior values:
--     ALTER TABLE "component_part_embeddings"
--       DROP CONSTRAINT IF EXISTS "component_part_embeddings_visual_skip_reason_check";
--     ALTER TABLE "component_part_embeddings"
--       ADD CONSTRAINT "component_part_embeddings_visual_skip_reason_check"
--       CHECK ("visual_skip_reason" IS NULL
--         OR "visual_skip_reason" IN ('bbox_invalid', 'bbox_unresolvable'));
--     ALTER TABLE "section_embeddings"
--       DROP CONSTRAINT IF EXISTS "section_embeddings_vision_skip_reason_check";
--     ALTER TABLE "section_embeddings"
--       ADD CONSTRAINT "section_embeddings_vision_skip_reason_check"
--       CHECK ("vision_skip_reason" IS NULL
--         OR "vision_skip_reason" IN ('section_visual_uncroppable', 'section_visual_duplicate', 'section_visual_pii_excluded', 'section_visual_blank', 'section_visual_no_position'));
--
-- Privacy (mirrors precedent migrations 20260531090000 / 20260530120000):
-- visual_skip_reason / vision_skip_reason store only an enum value, no PII; the
-- two NEW values (`screenshot_truncated` / `screenshot_truncated_expired`) are
-- NON-PII degraded-coverage TECHNICAL metadata (GDPR Recital 26 / Art.4(1): they
-- identify no natural person, not personal data). CASCADE-deleted with the parent
-- component_parts / section_patterns -> web_pages row; no independent retention
-- horizon; subsumed by GDPR Art.17 data.delete row deletion (no additional
-- erasure step). Distinct in meaning from `section_visual_pii_excluded` (a GDPR
-- Art.5(1)(c) data-minimisation PII exclusion) — they MUST NOT be conflated with
-- the PII exclusion reason.

-- Part: additively widen the CHECK to the 4-value writable set (terminal subset
-- {bbox_invalid, bbox_unresolvable, screenshot_truncated_expired} ∪
-- {screenshot_truncated}) or NULL. The partial index from migration 20260523090000
-- already covers all non-NULL rows and requires no change (value-agnostic).
ALTER TABLE "component_part_embeddings"
  DROP CONSTRAINT IF EXISTS "component_part_embeddings_visual_skip_reason_check";
ALTER TABLE "component_part_embeddings"
  ADD CONSTRAINT "component_part_embeddings_visual_skip_reason_check"
  CHECK ("visual_skip_reason" IS NULL
    OR "visual_skip_reason" IN ('bbox_invalid', 'bbox_unresolvable', 'screenshot_truncated_expired', 'screenshot_truncated'));

-- Section: additively widen the CHECK to the 7-value writable set (terminal subset
-- {section_visual_uncroppable, section_visual_duplicate, section_visual_pii_excluded,
-- section_visual_blank, section_visual_no_position, screenshot_truncated_expired} ∪
-- {screenshot_truncated}) or NULL. The partial index from migration 20260524192012
-- already covers all non-NULL rows and requires no change (value-agnostic).
ALTER TABLE "section_embeddings"
  DROP CONSTRAINT IF EXISTS "section_embeddings_vision_skip_reason_check";
ALTER TABLE "section_embeddings"
  ADD CONSTRAINT "section_embeddings_vision_skip_reason_check"
  CHECK ("vision_skip_reason" IS NULL
    OR "vision_skip_reason" IN ('section_visual_uncroppable', 'section_visual_duplicate', 'section_visual_pii_excluded', 'section_visual_blank', 'section_visual_no_position', 'screenshot_truncated_expired', 'screenshot_truncated'));
