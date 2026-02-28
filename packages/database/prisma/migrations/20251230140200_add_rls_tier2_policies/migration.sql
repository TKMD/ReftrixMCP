-- RLS Tier 2 Policies Migration
-- Target tables: project_pages, project_brand_settings, project_briefs,
--                project_layout_versions, project_layout_scores, project_code_exports
-- Reference: docs/plans/rls-implementation-plan.md Section 4.5-4.10
-- SEC Audit Reference: SEC-2025-12-001

-- ============================================================================
-- IMPORTANT NOTES:
-- 1. All policies use EXISTS subqueries to validate ownership via parent tables
-- 2. get_current_user_id() returns NULL on empty/missing context (fail-close)
-- 3. FORCE ROW LEVEL SECURITY ensures RLS applies even to table owners
-- 4. P1 tables: project_pages, project_brand_settings, project_briefs,
--              project_layout_versions, project_code_exports (1-2 JOINs)
-- 5. P2 tables: project_layout_scores (3 JOINs)
-- ============================================================================

-- ============================================================================
-- 1. project_pages table RLS (P1: 1 JOIN via projects)
-- Join path: project_pages.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_pages FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access pages belonging to their projects
CREATE POLICY project_pages_owner_policy ON project_pages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_pages.project_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_pages.project_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_pages_owner_policy ON project_pages IS
  'Tier 2 RLS (P1): Users can access pages via parent project ownership. Fail-close on NULL context.';

-- ============================================================================
-- 2. project_brand_settings table RLS (P1: 1 JOIN via projects)
-- Join path: project_brand_settings.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_brand_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_brand_settings FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access brand settings for their projects
CREATE POLICY project_brand_settings_owner_policy ON project_brand_settings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_brand_settings.project_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_brand_settings.project_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_brand_settings_owner_policy ON project_brand_settings IS
  'Tier 2 RLS (P1): Users can access brand settings via parent project ownership. Fail-close on NULL context.';

-- ============================================================================
-- 3. project_briefs table RLS (P1: 2 JOINs via project_pages -> projects)
-- Join path: project_briefs.project_page_id -> project_pages.id ->
--            project_pages.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_briefs FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access briefs via parent project ownership
CREATE POLICY project_briefs_owner_policy ON project_briefs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_briefs.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_briefs.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_briefs_owner_policy ON project_briefs IS
  'Tier 2 RLS (P1): Users can access briefs via project_pages -> projects ownership. Fail-close on NULL context.';

-- ============================================================================
-- 4. project_layout_versions table RLS (P1: 2 JOINs via project_pages -> projects)
-- Join path: project_layout_versions.project_page_id -> project_pages.id ->
--            project_pages.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_layout_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_layout_versions FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access layout versions via parent project ownership
CREATE POLICY project_layout_versions_owner_policy ON project_layout_versions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_layout_versions.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_layout_versions.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_layout_versions_owner_policy ON project_layout_versions IS
  'Tier 2 RLS (P1): Users can access layout versions via project_pages -> projects ownership. Fail-close on NULL context.';

-- ============================================================================
-- 5. project_code_exports table RLS (P1: 2 JOINs via project_pages -> projects)
-- Join path: project_code_exports.project_page_id -> project_pages.id ->
--            project_pages.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_code_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_code_exports FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access code exports via parent project ownership
CREATE POLICY project_code_exports_owner_policy ON project_code_exports
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_code_exports.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_pages pp
      JOIN projects p ON p.id = pp.project_id
      WHERE pp.id = project_code_exports.project_page_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_code_exports_owner_policy ON project_code_exports IS
  'Tier 2 RLS (P1): Users can access code exports via project_pages -> projects ownership. Fail-close on NULL context.';

-- ============================================================================
-- 6. project_layout_scores table RLS (P2: 3 JOINs via layout_versions -> pages -> projects)
-- Join path: project_layout_scores.project_layout_version_id -> project_layout_versions.id ->
--            project_layout_versions.project_page_id -> project_pages.id ->
--            project_pages.project_id -> projects.id -> projects.user_id
-- ============================================================================

-- Enable RLS
ALTER TABLE project_layout_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_layout_scores FORCE ROW LEVEL SECURITY;

-- Owner policy: users can access layout scores via parent project ownership
CREATE POLICY project_layout_scores_owner_policy ON project_layout_scores
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_layout_versions plv
      JOIN project_pages pp ON pp.id = plv.project_page_id
      JOIN projects p ON p.id = pp.project_id
      WHERE plv.id = project_layout_scores.project_layout_version_id
        AND p.user_id::text = get_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_layout_versions plv
      JOIN project_pages pp ON pp.id = plv.project_page_id
      JOIN projects p ON p.id = pp.project_id
      WHERE plv.id = project_layout_scores.project_layout_version_id
        AND p.user_id::text = get_current_user_id()
    )
  );

-- Add comment for documentation
COMMENT ON POLICY project_layout_scores_owner_policy ON project_layout_scores IS
  'Tier 2 RLS (P2): Users can access layout scores via layout_versions -> project_pages -> projects ownership. Fail-close on NULL context.';

-- ============================================================================
-- Verification queries (can be run after migration)
-- ============================================================================
-- SELECT tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename IN (
--   'project_pages', 'project_brand_settings', 'project_briefs',
--   'project_layout_versions', 'project_layout_scores', 'project_code_exports'
-- );
--
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN (
--   'project_pages', 'project_brand_settings', 'project_briefs',
--   'project_layout_versions', 'project_layout_scores', 'project_code_exports'
-- );
