-- RLS Performance Indexes Migration
-- Optimizes EXISTS subqueries in RLS policies for Tier 1 and Tier 2 tables
-- Reference: docs/plans/rls-implementation-plan.md Section 7.1
-- SEC Audit Reference: SEC-2025-12-001

-- ============================================================================
-- IMPORTANT NOTES:
-- 1. These indexes optimize the EXISTS subqueries in RLS policies
-- 2. All indexes use IF NOT EXISTS to be idempotent
-- 3. Performance targets:
--    - projects list: < 50ms
--    - project_pages: < 30ms (1 JOIN)
--    - project_briefs: < 50ms (2 JOINs)
--    - project_layout_scores: < 80ms (3 JOINs)
-- ============================================================================

-- ============================================================================
-- Tier 1: Direct ownership indexes
-- ============================================================================

-- projects.user_id - Primary RLS lookup for all project-related queries
-- Used by: projects_owner_policy USING clause
CREATE INDEX IF NOT EXISTS idx_projects_user_id
  ON projects(user_id);

-- Comment for documentation
COMMENT ON INDEX idx_projects_user_id IS
  'RLS optimization: Direct lookup for project ownership by user_id';

-- ============================================================================
-- Tier 2 P1: Single-hop indexes (1 JOIN)
-- ============================================================================

-- project_pages.project_id - Links pages to parent project
-- Used by: project_pages_owner_policy EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_project_pages_project_id
  ON project_pages(project_id);

COMMENT ON INDEX idx_project_pages_project_id IS
  'RLS optimization: Links project_pages to parent project for ownership check';

-- project_brand_settings.project_id - Links brand settings to parent project
-- Note: This column has a UNIQUE constraint which already provides an index,
-- but we add an explicit index for consistency and documentation
CREATE INDEX IF NOT EXISTS idx_project_brand_settings_project_id
  ON project_brand_settings(project_id);

COMMENT ON INDEX idx_project_brand_settings_project_id IS
  'RLS optimization: Links project_brand_settings to parent project for ownership check';

-- ============================================================================
-- Tier 2 P1: Two-hop indexes (2 JOINs)
-- ============================================================================

-- project_briefs.project_page_id - Links briefs to parent page
-- Used by: project_briefs_owner_policy EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_project_briefs_project_page_id
  ON project_briefs(project_page_id);

COMMENT ON INDEX idx_project_briefs_project_page_id IS
  'RLS optimization: Links project_briefs to parent project_page for ownership check';

-- project_layout_versions.project_page_id - Links layout versions to parent page
-- Used by: project_layout_versions_owner_policy EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_project_layout_versions_project_page_id
  ON project_layout_versions(project_page_id);

COMMENT ON INDEX idx_project_layout_versions_project_page_id IS
  'RLS optimization: Links project_layout_versions to parent project_page for ownership check';

-- project_code_exports.project_page_id - Links code exports to parent page
-- Used by: project_code_exports_owner_policy EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_project_code_exports_project_page_id
  ON project_code_exports(project_page_id);

COMMENT ON INDEX idx_project_code_exports_project_page_id IS
  'RLS optimization: Links project_code_exports to parent project_page for ownership check';

-- ============================================================================
-- Tier 2 P2: Three-hop indexes (3 JOINs)
-- ============================================================================

-- project_layout_scores.project_layout_version_id - Links scores to parent layout version
-- Used by: project_layout_scores_owner_policy EXISTS subquery
CREATE INDEX IF NOT EXISTS idx_project_layout_scores_version_id
  ON project_layout_scores(project_layout_version_id);

COMMENT ON INDEX idx_project_layout_scores_version_id IS
  'RLS optimization: Links project_layout_scores to parent layout_version for ownership check';

-- ============================================================================
-- Composite index for common query patterns
-- ============================================================================

-- projects(user_id, id) - Covering index for RLS + filtering by project
-- Avoids heap access when checking ownership
CREATE INDEX IF NOT EXISTS idx_projects_user_id_id_covering
  ON projects(user_id, id);

COMMENT ON INDEX idx_projects_user_id_id_covering IS
  'RLS optimization: Covering index for ownership check + project id filtering';

-- ============================================================================
-- Verification query (can be run after migration)
-- ============================================================================
-- SELECT indexname, tablename, indexdef
-- FROM pg_indexes
-- WHERE indexname LIKE 'idx_%'
--   AND tablename IN (
--     'projects', 'project_pages', 'project_brand_settings',
--     'project_briefs', 'project_layout_versions',
--     'project_layout_scores', 'project_code_exports'
--   )
-- ORDER BY tablename, indexname;
