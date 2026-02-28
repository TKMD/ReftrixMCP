-- Add motion type to motion_patterns for filtering/search
-- Column is nullable for backward compatibility
ALTER TABLE "motion_patterns"
ADD COLUMN IF NOT EXISTS "type" TEXT;

-- Optional index for fast type filtering
CREATE INDEX IF NOT EXISTS "idx_motion_patterns_type" ON "motion_patterns" ("type");
