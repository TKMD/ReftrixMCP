-- Migration: Add external CSS content fields to SectionPattern
-- Description: Store fetched external CSS file contents separately from inline CSS
-- Author: Reftrix Contributors
-- Date: 2026-01-05

-- =============================================================================
-- Purpose:
--   - cssSnippet: Inline styles, <style> tags, @import references (existing)
--   - externalCssContent: Actual content from <link rel="stylesheet"> files
--   - externalCssMeta: Metadata about fetch results (count, sizes, URLs)
-- =============================================================================

-- Add externalCssContent column (nullable TEXT for large CSS files)
ALTER TABLE section_patterns
ADD COLUMN IF NOT EXISTS external_css_content TEXT;

-- Add externalCssMeta column (nullable JSONB for fetch metadata)
ALTER TABLE section_patterns
ADD COLUMN IF NOT EXISTS external_css_meta JSONB;

-- Add comment for documentation
COMMENT ON COLUMN section_patterns.external_css_content IS
  'External CSS file contents fetched from <link rel="stylesheet"> tags. Can be large (100KB-5MB). Separate from cssSnippet which stores inline/style tag CSS.';

COMMENT ON COLUMN section_patterns.external_css_meta IS
  'Metadata about external CSS fetch: { fetchedCount, failedCount, totalSize, urls: [{ url, size, success }], fetchedAt }';
