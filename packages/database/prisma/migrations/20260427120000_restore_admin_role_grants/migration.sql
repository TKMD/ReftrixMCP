-- INFRA-RLS-ADMIN-GRANT-001: Restore canonical reftrix_admin GRANTs as Prisma SSOT
--
-- Background:
-- - Pre-existing infra drift since d98fece4 (PR7d-1, before PR-D-9 main).
-- - packages/database/scripts/create-rls-roles.sql:101-108 specifies canonical
--   `GRANT ALL PRIVILEGES` but was not previously SSOT-ified as a Prisma migration.
--   Environments running only the init script lacked admin role table-level GRANTs.
-- - PR-D-9-patch Phase 4 RLS Tier 2 test failure (`permission denied for table users`
--   SQLSTATE 42501) root cause.
-- - BYPASSRLS skips RLS policy enforcement only; SQL-standard table privileges
--   require separate GRANT.
-- - Phase 4 emergency GRANT applied SELECT/INSERT/UPDATE/DELETE only — under-restoration
--   for TRUNCATE/REFERENCES/TRIGGER. This migration restores canonical ALL PRIVILEGES.
--
-- Severity: M (deny-by-default; data leak / privilege escalation impossible)
-- Deadline: 2026-05-25
-- Cross-ref:
--   - SEC-INFRA-RLS-001 (M, SEC sign-off conditional GRANTED)
--   - TDA-INFRA-RLS-001 (M, infra-migration-drift category)
--   - LCC-OPINION-RLS-01 (M, GDPR Art.32(1)(b) + AGPL §5 + APPI Art.23)
--   - INV-RLS-ADMIN-GRANT-005 (standing regression, schema-enum-sync domain M1)
--
-- Least-privilege justification (FIND-PLAN-SEC-D1a-01):
-- `reftrix_admin` is the BYPASSRLS admin role (`create-rls-roles.sql:85-92`) intended
-- to perform DBA-level operations (migrations, backups, schema repairs).
-- `GRANT ALL PRIVILEGES` is the canonical SSOT scope per the role's COMMENT directive
-- ("Admin connection role. RLS bypass enabled. Usage must be audited"). The least-
-- privilege principle is enforced by **role separation** (reftrix_app vs reftrix_admin),
-- not by privilege subsetting on the admin role:
--   - `reftrix_app` (application role): RLS-enforced, restricted to
--     SELECT/INSERT/UPDATE/DELETE only (no TRUNCATE, REFERENCES, TRIGGER).
--   - `reftrix_admin` (DBA role): BYPASSRLS, ALL PRIVILEGES — required for DDL,
--     migration-time TRUNCATE on test fixtures, and trigger maintenance.
-- This migration touches only `reftrix_admin`; `reftrix_app` privilege scope is
-- unchanged.
--
-- Idempotency:
-- - GRANT statements are idempotent at PostgreSQL level (no error on re-grant).
-- - audit_logs INSERT uses WHERE NOT EXISTS guard (TPA-RLS-05 M) to prevent
--   duplicate entry on migration re-apply (e.g. production rollback+re-apply).
--
-- Cross-ref ADR-0011 (Worker dual-run lock) for the broader infra runbook framework
-- under which RLS role lifecycle is managed.

DO $$
BEGIN
  -- Graceful skip: if reftrix_admin role does not exist, skip entire migration
  -- body. This handles single-role test/CI environments where create-rls-roles.sql
  -- was not executed (e.g. testcontainer with default postgres role only).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reftrix_admin') THEN
    RAISE NOTICE 'reftrix_admin role does not exist; skipping GRANT (likely test/CI env using single-role setup).';
    RETURN;
  END IF;

  -- Restore canonical GRANT ALL PRIVILEGES per create-rls-roles.sql:101-108 SSOT.
  -- These statements are idempotent: re-running on an already-granted role is a
  -- no-op at the PostgreSQL privilege catalog level.
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO reftrix_admin';
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO reftrix_admin';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO reftrix_admin';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO reftrix_admin';

  -- audit_logs SSOT entry per LCC-OPINION-RLS-01 (GDPR Art.32(1)(b) + AGPL §5 + APPI Art.23).
  -- Idempotency guard (TPA-RLS-05 M): WHERE NOT EXISTS prevents duplicate entry on
  -- re-apply. PII contract (FIND-PLAN-LCC-D1A-01 M): no operator names, connection
  -- strings, or sensitive metadata are persisted in `details`.
  --
  -- FIND-IMPL-TPA-D1a-02 L (Phase 3 docs landing, Registry §13.17.4 + §13.17.7):
  -- The WHERE NOT EXISTS 4-tuple match (action + actor + target_id + finding)
  -- does NOT constrain on result='success'. The INSERT path below always writes
  -- result='success', so this is structurally minor — failed-emit rows would
  -- need to use a different action / actor / finding combination to avoid
  -- false-positive idempotency hits. Tracked at Registry §13.17.4
  -- FIND-IMPL-TPA-D1a-02 L (deadline 2026-05-25, doc-only landing).
  IF NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action = 'admin_role_grant'
      AND actor = 'system:migration'
      AND target_id = 'reftrix_admin'
      AND details->>'finding' = 'INFRA-RLS-ADMIN-GRANT-001'
  ) THEN
    INSERT INTO audit_logs (action, actor, target_type, target_id, details, result)
    VALUES (
      'admin_role_grant',
      'system:migration',
      'role',
      'reftrix_admin',
      jsonb_build_object(
        'migration', '20260427120000_restore_admin_role_grants',
        'finding', 'INFRA-RLS-ADMIN-GRANT-001',
        'tables', 'ALL TABLES IN SCHEMA public',
        'sequences', 'ALL SEQUENCES IN SCHEMA public',
        'privileges', 'ALL PRIVILEGES + DEFAULT PRIVILEGES',
        'rationale', 'Restore canonical GRANT per create-rls-roles.sql:101-108 SSOT (PR-D-9-patch Phase 4 RLS Tier 2 fix)',
        'severity', 'M',
        'deadline', '2026-05-25'
      ),
      'success'
    );
  END IF;
END $$;
