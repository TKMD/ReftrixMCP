-- AlterTable: design_narratives — add tags column
-- Matches existing pattern in background_designs, section_patterns, motion_patterns, etc.
ALTER TABLE "design_narratives" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
