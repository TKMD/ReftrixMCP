-- Add complexity_metrics column to WebPage table
-- Pre-flight Probe results for page complexity analysis
-- Used for dynamic timeout calculation in layout.ingest/page.analyze

-- AlterTable: Add complexity_metrics JSONB column
ALTER TABLE "web_pages" ADD COLUMN "complexity_metrics" JSONB;

-- Add comment describing the JSON structure
COMMENT ON COLUMN "web_pages"."complexity_metrics" IS 'Pre-flight Probe results: {responseTimeMs, htmlSizeBytes, scriptCount, externalResourceCount, hasWebGL, hasSPA, hasHeavyFramework, calculatedTimeoutMs, complexityScore, probedAt, probeVersion}';

-- Optional: Add GIN index for JSONB queries on complexity_metrics
-- This allows efficient filtering by complexity score or detection flags
-- CREATE INDEX "web_pages_complexity_metrics_gin_idx" ON "web_pages" USING GIN ("complexity_metrics");

-- Note: GIN index commented out by default as it may not be needed for initial use case
-- Uncomment if querying by complexity_metrics fields becomes common
