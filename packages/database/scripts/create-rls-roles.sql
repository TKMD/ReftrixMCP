-- RLS Database Roles Creation Script
-- Reference: docs/plans/rls-implementation-plan.md Section 4.11
-- SEC-RLS-001: Dedicated database roles for RLS bypass (no session variables)
--
-- USAGE:
-- psql -h localhost -p 26432 -U postgres -d reftrix -f create-rls-roles.sql
--
-- IMPORTANT:
-- - Replace 'secure_app_password' and 'secure_admin_password' with actual passwords
-- - Store passwords in environment variables, never in code
-- - Run this script as a superuser (postgres)

-- ============================================================================
-- 1. Application Role (RLS Enforced)
-- ============================================================================
-- This role is used for normal application connections.
-- It does NOT have BYPASSRLS privilege, ensuring RLS is always enforced.

DO $$
BEGIN
  -- Drop role if exists (for idempotent execution)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reftrix_app') THEN
    -- Revoke all privileges first
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM reftrix_app;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM reftrix_app;
    REVOKE USAGE ON SCHEMA public FROM reftrix_app;
    REVOKE CONNECT ON DATABASE reftrix FROM reftrix_app;
    DROP ROLE reftrix_app;
  END IF;
END $$;

-- Create application role
-- NOTE: Replace 'secure_app_password' with actual password from environment
CREATE ROLE reftrix_app WITH
  LOGIN
  PASSWORD 'secure_app_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;
  -- IMPORTANT: NO BYPASSRLS - RLS is always enforced

-- Grant connection privilege
GRANT CONNECT ON DATABASE reftrix TO reftrix_app;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO reftrix_app;

-- Grant table privileges (SELECT, INSERT, UPDATE, DELETE only - no TRUNCATE, REFERENCES)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reftrix_app;

-- Grant sequence privileges (for auto-generated IDs)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reftrix_app;

-- Apply grants to future tables/sequences as well
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reftrix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO reftrix_app;

COMMENT ON ROLE reftrix_app IS
  'Application connection role. RLS is enforced (no BYPASSRLS). SEC-RLS-001 compliant.';

-- ============================================================================
-- 2. Admin Role (RLS Bypass)
-- ============================================================================
-- This role is used for admin operations and migrations.
-- It HAS BYPASSRLS privilege for administrative operations.
-- Usage must be logged and audited.

DO $$
BEGIN
  -- Drop role if exists (for idempotent execution)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reftrix_admin') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM reftrix_admin;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM reftrix_admin;
    REVOKE USAGE ON SCHEMA public FROM reftrix_admin;
    REVOKE CONNECT ON DATABASE reftrix FROM reftrix_admin;
    DROP ROLE reftrix_admin;
  END IF;
END $$;

-- Create admin role
-- NOTE: Replace 'secure_admin_password' with actual password from environment
CREATE ROLE reftrix_admin WITH
  LOGIN
  PASSWORD 'secure_admin_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  BYPASSRLS;  -- IMPORTANT: Can bypass RLS for admin operations

-- Grant connection privilege
GRANT CONNECT ON DATABASE reftrix TO reftrix_admin;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO reftrix_admin;

-- Grant full table privileges (including schema modifications)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO reftrix_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO reftrix_admin;

-- Apply grants to future tables/sequences as well
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO reftrix_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO reftrix_admin;

COMMENT ON ROLE reftrix_admin IS
  'Admin connection role. RLS bypass enabled. Usage must be audited. SEC-RLS-001 compliant.';

-- ============================================================================
-- 3. Verification
-- ============================================================================
-- Run this to verify roles were created correctly:

-- Check role privileges
SELECT
  rolname,
  rolsuper,
  rolbypassrls,
  rolcanlogin
FROM pg_roles
WHERE rolname IN ('reftrix_app', 'reftrix_admin')
ORDER BY rolname;

-- Expected output:
-- rolname       | rolsuper | rolbypassrls | rolcanlogin
-- --------------+----------+--------------+------------
-- reftrix_admin | f        | t            | t
-- reftrix_app   | f        | f            | t

-- ============================================================================
-- 4. Environment Variables Setup (Reference)
-- ============================================================================
-- Add to .env or .env.local:
--
-- # Application connection (RLS enforced)
-- DATABASE_URL="postgresql://reftrix_app:secure_app_password@localhost:26432/reftrix"
--
-- # Admin connection (RLS bypass) - for migrations and admin operations
-- ADMIN_DATABASE_URL="postgresql://reftrix_admin:secure_admin_password@localhost:26432/reftrix"
