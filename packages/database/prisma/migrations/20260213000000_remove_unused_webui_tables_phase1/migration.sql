-- Phase 1: Remove unused WebUI tables
-- Removes 12 tables that are no longer used after WebUI deletion
-- Tables with data (14 tables) are NOT touched
-- User, Project, ProjectBrandSetting are retained (Phase 2)

-- ============================================================================
-- Step 1: Drop FK constraint from projects.default_page_id -> project_pages
-- ============================================================================
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_default_page_id_fkey";
ALTER TABLE "projects" DROP COLUMN IF EXISTS "default_page_id";

-- ============================================================================
-- Step 2: Drop Studio/Project child tables (deepest FK first)
-- ============================================================================

-- project_layout_scores -> project_layout_versions
DROP TABLE IF EXISTS "project_layout_scores";

-- project_code_exports -> project_pages, project_layout_versions
DROP TABLE IF EXISTS "project_code_exports";

-- project_layout_versions -> project_pages, users
DROP TABLE IF EXISTS "project_layout_versions";

-- project_briefs -> project_pages, users
DROP TABLE IF EXISTS "project_briefs";

-- project_pages -> projects
DROP TABLE IF EXISTS "project_pages";

-- ============================================================================
-- Step 3: Drop RBAC tables (deepest FK first)
-- ============================================================================

-- role_permissions -> roles, permissions
DROP TABLE IF EXISTS "role_permissions";

-- user_roles -> users, roles
DROP TABLE IF EXISTS "user_roles";

-- roles (no FK dependencies remaining)
DROP TABLE IF EXISTS "roles";

-- permissions (no FK dependencies remaining)
DROP TABLE IF EXISTS "permissions";

-- ============================================================================
-- Step 4: Drop Auth.js v5 tables (User is retained)
-- ============================================================================

-- accounts -> users
DROP TABLE IF EXISTS "accounts";

-- sessions -> users
DROP TABLE IF EXISTS "sessions";

-- verification_tokens (no FK)
DROP TABLE IF EXISTS "verification_tokens";

-- ============================================================================
-- Step 5: Drop enums that are no longer referenced
-- ============================================================================
DROP TYPE IF EXISTS "ProjectPageType";
DROP TYPE IF EXISTS "BriefScope";
DROP TYPE IF EXISTS "LayoutSourceType";
