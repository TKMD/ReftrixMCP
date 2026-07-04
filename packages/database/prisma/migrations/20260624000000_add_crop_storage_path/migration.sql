-- SPDX-License-Identifier: AGPL-3.0-only
-- W6 Issue A PR-3a (Crop Persistence): additively add a nullable
-- `crop_storage_path TEXT` column to BOTH `section_embeddings` and
-- `component_part_embeddings` to persist the per-section / per-part viewable PNG
-- crop that Phase 5 generates in-memory at embedding time (just before the
-- 224-downscale discard). Vision-scoped parity column:
--   vision_embedding  IS NOT NULL  <=>  crop_storage_path IS NOT NULL  (section)
--   visual_embedding  IS NOT NULL  <=>  crop_storage_path IS NOT NULL  (part)
-- (PII-skipped rows excluded on both sides, INV-CROP-COVERAGE-PARITY-001).
--
-- Additive nullable: existing rows are unaffected (column defaults to NULL). The
-- column stays NULL for every row while `CROP_PERSISTENCE_ENABLED` is OFF
-- (default, opt-in; GDPR sequencing anchor 019ef5ca). retention = until
-- data.delete (ADR-0041 aligned, no TTL cron revival; crop dir GDPR cascade is
-- wired in PR-3b).
--
-- Companion plan:   §2.4
-- Finding Registry:  (W3)
-- Precedent:       20260608120000_add_screenshot_truncated_skip_reasons

ALTER TABLE "section_embeddings" ADD COLUMN "crop_storage_path" TEXT NULL;
ALTER TABLE "component_part_embeddings" ADD COLUMN "crop_storage_path" TEXT NULL;
