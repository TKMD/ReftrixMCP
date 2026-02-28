-- RLS Tier 1 Policies Migration
-- Target tables: projects, accounts, sessions, api_keys
-- Reference: docs/plans/rls-implementation-plan.md
-- SEC Audit Reference: SEC-2025-12-001

-- ============================================================================
-- IMPORTANT NOTES:
-- 1. All policies use get_current_user_id() which returns NULL on empty/missing
--    context, ensuring fail-close behavior (SEC-RLS-004)
-- 2. FORCE ROW LEVEL SECURITY ensures RLS applies even to table owners
-- 3. Policies are named with _owner_policy suffix for consistency
-- ============================================================================

-- ============================================================================
-- 1. projects table RLS
-- ============================================================================

-- Enable RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Owner policy: users can only access their own projects
-- user_id column uses snake_case in DB (maps to userId in Prisma)
CREATE POLICY projects_owner_policy ON projects
  FOR ALL
  USING (user_id::text = get_current_user_id())
  WITH CHECK (user_id::text = get_current_user_id());

-- Add comment for documentation
COMMENT ON POLICY projects_owner_policy ON projects IS
  'Tier 1 RLS: Users can only access their own projects. Fail-close on NULL context.';

-- ============================================================================
-- 2. accounts table RLS
-- ============================================================================

-- Enable RLS
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

-- Owner policy: users can only access their own OAuth accounts
CREATE POLICY accounts_owner_policy ON accounts
  FOR ALL
  USING (user_id::text = get_current_user_id())
  WITH CHECK (user_id::text = get_current_user_id());

-- Add comment for documentation
COMMENT ON POLICY accounts_owner_policy ON accounts IS
  'Tier 1 RLS: Users can only access their own OAuth accounts. Fail-close on NULL context.';

-- ============================================================================
-- 3. sessions table RLS
-- ============================================================================

-- Enable RLS
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

-- Owner policy: users can only access their own sessions
CREATE POLICY sessions_owner_policy ON sessions
  FOR ALL
  USING (user_id::text = get_current_user_id())
  WITH CHECK (user_id::text = get_current_user_id());

-- Add comment for documentation
COMMENT ON POLICY sessions_owner_policy ON sessions IS
  'Tier 1 RLS: Users can only access their own sessions. Fail-close on NULL context.';

-- ============================================================================
-- 4. api_keys table RLS
-- ============================================================================

-- Enable RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Owner policy: users can only access their own API keys
CREATE POLICY api_keys_owner_policy ON api_keys
  FOR ALL
  USING (user_id::text = get_current_user_id())
  WITH CHECK (user_id::text = get_current_user_id());

-- Add comment for documentation
COMMENT ON POLICY api_keys_owner_policy ON api_keys IS
  'Tier 1 RLS: Users can only access their own API keys. Fail-close on NULL context.';

-- ============================================================================
-- Verification queries (can be run after migration)
-- ============================================================================
-- SELECT tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename IN ('projects', 'accounts', 'sessions', 'api_keys');
--
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN ('projects', 'accounts', 'sessions', 'api_keys');
