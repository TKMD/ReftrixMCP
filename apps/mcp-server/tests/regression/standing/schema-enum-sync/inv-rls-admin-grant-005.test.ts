// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-RLS-ADMIN-GRANT-005
 *
 * `reftrix_admin` role の canonical privilege scope を Prisma migration
 * SSOT として永続化する契約検証 (PR-D-9-patch Batch D-1a, INFRA-RLS-ADMIN-GRANT-001,
 * M severity, deadline 2026-05-25).
 *
 * **Background**:
 * - Pre-existing infra drift: `packages/database/scripts/create-rls-roles.sql:101-108`
 *   は canonical SSOT として `GRANT ALL PRIVILEGES` を記述するが、PR-D-9 main 以前
 *   からこの GRANT が migration として永続化されていなかった (d98fece4 PR7d-1)。
 * - Phase 4 RLS Tier 2 test failure (`permission denied for table users` SQLSTATE
 *   42501) の root cause。BYPASSRLS は RLS policy enforcement のみを skip し、
 *   SQL-standard table privileges は別途 GRANT が必要。
 * - Phase 4 emergency GRANT は SELECT/INSERT/UPDATE/DELETE のみで under-restoration、
 *   TRUNCATE/REFERENCES/TRIGGER が欠落していた。本 migration はこれを完全復元。
 *
 * **T1 Canonical (SSOT)**:
 * - `packages/database/prisma/migrations/20260427120000_restore_admin_role_grants/migration.sql`
 *   が canonical migration SSOT (Prisma migration として永続化)。
 * - `packages/database/scripts/create-rls-roles.sql:101-108` は initialization-time
 *   role bootstrap script SSOT (新規環境の role create 時に使用)。
 * - 両 SSOT が同一の privilege set (ALL PRIVILEGES on tables + sequences +
 *   default privileges) を指すことが contract。
 *
 * Canonical SSOT for `reftrix_admin` privilege scope. Migration permanently
 * restores the canonical `GRANT ALL PRIVILEGES` per the role's role-creation
 * directive in `create-rls-roles.sql:101-108`.
 *
 * **Domain placement**:
 * - M1 (PR-D-9-patch Batch D-1a): schema-enum-sync 拡張として配置 (TDA recommend、
 *   CI overhead 0)。Migration SSOT を schema-enum-sync の "schema as canonical
 *   single-source-of-truth" 思想で carrier する。File: `inv-rls-admin-grant-005.test.ts`
 *   per Phase 1 plan §13.16 anchor.
 * - M2 (deferred to ADR-0019 + tracked issue, deadline 2026-Q3): 専用 5th-domain
 *   `infra-grants/` への promotion を検討。M2 promotion criteria carryover is tracked
 *   at Registry §13.17.8 (existing carryover TPA-RLS-01 M, deadline 2026-07-15;
 *   originated in §13.16 IO Plan Decision Phase 1 and preserved in §13.17.8 IO
 *   Impl Decision Phase 2 carryover registry). New L finding FIND-IMPL-TPA-D1a-01
 *   (Phase 3 docs landing, deadline 2026-05-25) anchors this header to that
 *   carryover ID for cross-ref discoverability.
 *
 * **Test cases (4 total)**:
 *  1. Canonical privilege presence — TRUNCATE/REFERENCES/TRIGGER on representative tables
 *  2. ALL-tables coverage — every public.<table> has full ALL PRIVILEGES
 *  3. Default privileges contract — future tables inherit ALL PRIVILEGES
 *  4. audit_logs SSOT entry — INFRA-RLS-ADMIN-GRANT-001 finding entry persisted
 *
 * **Graceful skip**:
 * - `reftrix_admin` role が存在しない環境 (testcontainer with default postgres
 *   role only) では `runIf` で skip。FIND-PLAN-SEC-D1a-04 L (password hardcode
 *   comment) 反映: テスト内で `reftrix_admin` パスワードは hardcode せず、role
 *   存在チェックのみ行う (admin role connection は不要)。
 *
 * @see ADR-0011 (Worker dual-run lock infra runbook framework)
 * @see DATA_RETENTION.md §11.7 (DDL / permission change runbook)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertInvName } from "../_setup/inv-assert";

const INV_ID = "INV-RLS-ADMIN-GRANT-005";

/**
 * Representative tables to assert canonical privilege presence (case 1).
 * `users` is intentionally first — it triggered the original Phase 4 RLS Tier 2
 * `permission denied for table users` SQLSTATE 42501 failure that motivated this
 * migration. The remaining tables represent core data domains (web pages, audit
 * trail, queue control, embeddings).
 */
const REPRESENTATIVE_TABLES = [
  "users",
  "web_pages",
  "audit_logs",
  "embedding_backfill_jobs",
  "section_embeddings",
] as const;

/**
 * Full PostgreSQL table-level privilege set returned by `has_table_privilege`.
 * `GRANT ALL PRIVILEGES ON ALL TABLES` corresponds to all 7 of these.
 */
const ALL_TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;

let prisma: PrismaClient;
let adminRoleExists = false;

beforeAll(async () => {
  // fail-closed env guard: globalSetup must have set DATABASE_URL
  if (!process.env.DATABASE_URL) {
    throw new Error(
      `[${INV_ID}] DATABASE_URL not set by globalSetup (testcontainer boot failure?)`
    );
  }
  prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  // Probe whether reftrix_admin role exists. Single-role test envs (e.g.
  // testcontainers with default postgres role only) skip the entire suite.
  const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reftrix_admin') AS exists
  `;
  adminRoleExists = result[0]?.exists === true;
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe(`${INV_ID}: reftrix_admin canonical privilege contract`, () => {
  // INV-RLS-ADMIN-GRANT-005

  it.runIf(adminRoleExists)(
    `${INV_ID}: case 1 — representative tables expose all canonical privileges (TRUNCATE/REFERENCES/TRIGGER inclusive)`,
    async () => {
      assertInvName(expect.getState().currentTestName ?? "", INV_ID);

      for (const table of REPRESENTATIVE_TABLES) {
        for (const privilege of ALL_TABLE_PRIVILEGES) {
          const rows = await prisma.$queryRawUnsafe<Array<{ has_privilege: boolean }>>(
            `SELECT has_table_privilege($1, $2, $3) AS has_privilege`,
            "reftrix_admin",
            `public.${table}`,
            privilege
          );
          expect(
            rows[0]?.has_privilege,
            `[${INV_ID}] reftrix_admin must have ${privilege} on public.${table} (Phase 4 emergency GRANT under-restoration root-cause)`
          ).toBe(true);
        }
      }
    }
  );

  it.runIf(adminRoleExists)(
    `${INV_ID}: case 2 — all public schema tables expose ALL PRIVILEGES`,
    async () => {
      assertInvName(expect.getState().currentTestName ?? "", INV_ID);

      // Discover all tables in public schema (excluding Prisma migration metadata).
      const tableRows = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename
          FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename <> '_prisma_migrations'
         ORDER BY tablename
      `;
      expect(tableRows.length).toBeGreaterThan(0);

      // For each privilege, count tables missing it. This produces a single
      // aggregate assertion rather than O(N*7) per-table assertions for cleaner
      // failure output.
      for (const privilege of ALL_TABLE_PRIVILEGES) {
        const missingRows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
          `SELECT tablename
             FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename <> '_prisma_migrations'
              AND NOT has_table_privilege('reftrix_admin', 'public.' || tablename, $1)
            ORDER BY tablename`,
          privilege
        );
        expect(
          missingRows.map((r) => r.tablename),
          `[${INV_ID}] reftrix_admin missing ${privilege} on these public schema tables`
        ).toEqual([]);
      }
    }
  );

  it.runIf(adminRoleExists)(
    `${INV_ID}: case 3 — default privileges grant ALL PRIVILEGES to future tables/sequences`,
    async () => {
      assertInvName(expect.getState().currentTestName ?? "", INV_ID);

      // pg_default_acl stores ALTER DEFAULT PRIVILEGES grants. We assert that an
      // entry exists for reftrix_admin covering tables ('r') and sequences ('S')
      // in the public schema. Detailed ACL string inspection is brittle across
      // PostgreSQL versions, so we assert presence-by-grantee.
      const aclRows = await prisma.$queryRaw<
        Array<{ defaclobjtype: string; admin_acl: string | null }>
      >`
        SELECT
          d.defaclobjtype,
          (
            SELECT array_to_string(array_agg(acl_entry::text), ',')
              FROM unnest(d.defaclacl) AS acl_entry
             WHERE acl_entry::text LIKE 'reftrix_admin=%'
          ) AS admin_acl
        FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public'
          AND d.defaclobjtype IN ('r', 'S')
      `;

      const tableAcl = aclRows.find((r) => r.defaclobjtype === "r");
      const seqAcl = aclRows.find((r) => r.defaclobjtype === "S");

      expect(
        tableAcl?.admin_acl,
        `[${INV_ID}] ALTER DEFAULT PRIVILEGES for tables must grant reftrix_admin (future-table inheritance contract)`
      ).toBeTruthy();
      expect(
        seqAcl?.admin_acl,
        `[${INV_ID}] ALTER DEFAULT PRIVILEGES for sequences must grant reftrix_admin (future-sequence inheritance contract)`
      ).toBeTruthy();

      // Verify ALL-PRIVILEGE markers in the aclitem strings.
      // PostgreSQL aclitem format: "<grantee>=<privs>/<grantor>" where ALL
      // PRIVILEGES = "arwdDxt" (a=insert, r=select, w=update, d=delete,
      // D=truncate, x=references, t=trigger).
      const fullAclMarkers = ["a", "r", "w", "d", "D", "x", "t"];
      for (const marker of fullAclMarkers) {
        expect(
          tableAcl?.admin_acl?.includes(marker),
          `[${INV_ID}] ALTER DEFAULT PRIVILEGES tables aclitem must include '${marker}' (ALL PRIVILEGES marker)`
        ).toBe(true);
      }
    }
  );

  it.runIf(adminRoleExists)(
    `${INV_ID}: case 4 — audit_logs SSOT entry persists for INFRA-RLS-ADMIN-GRANT-001`,
    async () => {
      // FIND-PLAN-LCC-D1A-04 L: audit_logs SSOT verification case
      assertInvName(expect.getState().currentTestName ?? "", INV_ID);

      const rows = await prisma.$queryRaw<
        Array<{
          action: string;
          actor: string;
          target_type: string;
          target_id: string | null;
          finding: string | null;
          severity: string | null;
          result: string;
        }>
      >`
        SELECT
          action,
          actor,
          target_type,
          target_id,
          details->>'finding' AS finding,
          details->>'severity' AS severity,
          result
        FROM audit_logs
        WHERE action = 'admin_role_grant'
          AND actor = 'system:migration'
          AND target_id = 'reftrix_admin'
          AND details->>'finding' = 'INFRA-RLS-ADMIN-GRANT-001'
      `;

      expect(
        rows.length,
        `[${INV_ID}] audit_logs SSOT entry for INFRA-RLS-ADMIN-GRANT-001 must exist (idempotent INSERT WHERE NOT EXISTS guard)`
      ).toBeGreaterThanOrEqual(1);

      // Idempotency guard contract (TPA-RLS-05 M): re-applying the migration
      // must not duplicate the entry. We assert exactly-one entry to detect
      // accidental duplication regressions.
      expect(
        rows.length,
        `[${INV_ID}] audit_logs SSOT entry must be exactly 1 (idempotency guard); duplicates indicate WHERE NOT EXISTS regression`
      ).toBe(1);

      const entry = rows[0];
      expect(entry.action).toBe("admin_role_grant");
      expect(entry.actor).toBe("system:migration");
      expect(entry.target_type).toBe("role");
      expect(entry.target_id).toBe("reftrix_admin");
      expect(entry.finding).toBe("INFRA-RLS-ADMIN-GRANT-001");
      expect(entry.severity).toBe("M");
      expect(entry.result).toBe("success");
    }
  );

  it("INV-RLS-ADMIN-GRANT-005: skip-marker — reftrix_admin role absent (single-role test env)", () => {
    // Visibility-marker test that always runs to confirm the suite was loaded
    // even when the canonical 4 cases skip via runIf. Without this, vitest
    // would report "no tests found" in single-role envs which masks suite-load
    // regressions.
    assertInvName(expect.getState().currentTestName ?? "", INV_ID);
    expect(typeof adminRoleExists).toBe("boolean");
  });
});
