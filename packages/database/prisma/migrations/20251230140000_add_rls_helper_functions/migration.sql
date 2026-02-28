-- RLS Helper Functions Migration
-- SEC-RLS-004: Fail-Close behavior guaranteed
-- Reference: docs/plans/rls-implementation-plan.md

-- ============================================================================
-- get_current_user_id() - Current user ID retrieval with fail-close guarantee
-- ============================================================================
-- Returns NULL when:
--   1. app.current_user_id is not set
--   2. app.current_user_id is empty string
-- This ensures RLS policies return empty result sets (fail-close)
-- when user context is not properly established.

CREATE OR REPLACE FUNCTION get_current_user_id() RETURNS TEXT AS $$
  SELECT CASE
    WHEN current_setting('app.current_user_id', true) IS NULL THEN NULL
    WHEN current_setting('app.current_user_id', true) = '' THEN NULL
    ELSE current_setting('app.current_user_id', true)
  END;
$$ LANGUAGE sql STABLE;

-- Add comment for documentation
COMMENT ON FUNCTION get_current_user_id() IS
  'Returns current user ID from session context. Returns NULL if not set or empty (fail-close behavior). SEC-RLS-004 compliant.';
