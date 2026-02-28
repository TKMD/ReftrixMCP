-- Add project_id column to web_pages table
-- This enables filtering WebPages by project for listByProject API

-- Add nullable project_id column
ALTER TABLE "web_pages" ADD COLUMN "project_id" UUID;

-- Add foreign key constraint
ALTER TABLE "web_pages" ADD CONSTRAINT "web_pages_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add indexes for efficient querying
CREATE INDEX "web_pages_project_id_idx" ON "web_pages"("project_id");
CREATE INDEX "web_pages_project_id_analysis_status_idx" ON "web_pages"("project_id", "analysis_status");
