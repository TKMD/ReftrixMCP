// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLS Fail-Close Behavior Tests
 *
 * SEC-RLS-004: Verifies that RLS policies return empty result sets
 * (fail-close) when user context is not properly established.
 *
 * CRITICAL: Fail-open behavior (returning all rows when context is missing)
 * is a security vulnerability and must NEVER occur.
 *
 * Reference: docs/plans/rls-implementation-plan.md Section 8.4
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withRlsContext } from "../../src/utils/rls-transaction";
import { withAdminBypass } from "../../src/utils/admin-operation";

// Test requires a running PostgreSQL database with RLS policies applied
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL;

describe.skipIf(!DATABASE_URL || !ADMIN_DATABASE_URL)(
  "RLS Fail-Close Behavior (SEC-RLS-004)",
  () => {
    let prisma: PrismaClient;

    // Test user with known projects
    const testUserId = "00000000-0000-0000-0000-000000000099";
    let testProjectId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();

      // Create test user and project using admin bypass (bypasses RLS)
      // This is intentional for test setup - admin operations require ADMIN_DATABASE_URL
      await withAdminBypass(
        "test_setup_fail_close",
        "Creating test data for fail-close RLS tests",
        async (adminPrisma) => {
          await adminPrisma.$executeRaw`
          INSERT INTO users (id, email, name, created_at, updated_at)
          VALUES (${testUserId}::uuid, 'fail-close-test@test.com', 'Fail Close Test', NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `;

          const result = await adminPrisma.$queryRaw<{ id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${testUserId}::uuid, 'Fail Close Test Project', 'fail-close-test-' || gen_random_uuid()::text, 'draft', NOW(), NOW())
          RETURNING id::text
        `;
          testProjectId = result[0]?.id ?? "";
        }
      );
    });

    afterAll(async () => {
      // Cleanup using admin bypass
      await withAdminBypass(
        "test_cleanup_fail_close",
        "Cleaning up test data for fail-close RLS tests",
        async (adminPrisma) => {
          await adminPrisma.$executeRaw`
          DELETE FROM projects WHERE user_id = ${testUserId}::uuid
        `;
          await adminPrisma.$executeRaw`
          DELETE FROM users WHERE id = ${testUserId}::uuid
        `;
        }
      );
      await prisma.$disconnect();
    });

  describe("when userId is null", () => {
    it("should return empty result set (fail-close)", async () => {
      const projects = await withRlsContext(prisma, null, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM projects`;
      });

      // Fail-close: empty result set
      expect(projects).toHaveLength(0);
    });

    it("should NOT return all rows (fail-open is NOT acceptable)", async () => {
      const projects = await withRlsContext(prisma, null, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM projects`;
      });

      // Fail-open check: test project should NOT be visible
      const ids = projects.map((p) => p.id);
      expect(ids).not.toContain(testProjectId);
    });

    it("should block INSERT operations", async () => {
      // Attempting to insert with null context should fail
      // The WITH CHECK clause will reject the insert
      await expect(
        withRlsContext(prisma, null, async (tx) => {
          return tx.$executeRaw`
            INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
            VALUES (gen_random_uuid(), ${testUserId}::uuid, 'Should Fail', 'should-fail', 'draft', NOW(), NOW())
          `;
        })
      ).rejects.toThrow();
    });

    it("should block UPDATE operations on existing data", async () => {
      const result = await withRlsContext(prisma, null, async (tx) => {
        return tx.$executeRaw`
          UPDATE projects SET name = 'Hacked' WHERE id = ${testProjectId}::uuid
        `;
      });

      // No rows should be updated (RLS blocks access)
      expect(result).toBe(0);
    });

    it("should block DELETE operations on existing data", async () => {
      const result = await withRlsContext(prisma, null, async (tx) => {
        return tx.$executeRaw`
          DELETE FROM projects WHERE id = ${testProjectId}::uuid
        `;
      });

      // No rows should be deleted (RLS blocks access)
      expect(result).toBe(0);
    });
  });

  describe("when userId is empty string", () => {
    it("should return empty result set (fail-close)", async () => {
      const projects = await withRlsContext(prisma, "", async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM projects`;
      });

      expect(projects).toHaveLength(0);
    });

    it("should NOT return the test project", async () => {
      const projects = await withRlsContext(prisma, "", async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM projects WHERE id = ${testProjectId}::uuid
        `;
      });

      expect(projects).toHaveLength(0);
    });
  });

  describe("when userId is undefined", () => {
    it("should return empty result set (fail-close)", async () => {
      const projects = await withRlsContext(prisma, undefined, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM projects`;
      });

      expect(projects).toHaveLength(0);
    });
  });

  describe("when SET LOCAL is not called (direct transaction)", () => {
    it("should return empty result set due to NULL current_user_id", async () => {
      // This simulates a scenario where code forgets to call withRlsContext
      // and directly uses a transaction without setting the context
      const projects = await prisma.$transaction(async (tx) => {
        // Intentionally NOT calling SET LOCAL
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM projects`;
      });

      // Fail-close: NULL user context means no access
      expect(projects).toHaveLength(0);
    });
  });

  describe("SQL-level verification of get_current_user_id()", () => {
    it("should return NULL when context is not set", async () => {
      const result = await prisma.$queryRaw<{ is_null: boolean }[]>`
        SELECT get_current_user_id() IS NULL AS is_null
      `;

      expect(result[0]?.is_null).toBe(true);
    });

    it("should return NULL when context is empty string", async () => {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.current_user_id = ''`;
        return tx.$queryRaw<{ is_null: boolean }[]>`
          SELECT get_current_user_id() IS NULL AS is_null
        `;
      });

      expect(result[0]?.is_null).toBe(true);
    });

    it("should return the user ID when properly set", async () => {
      const result = await prisma.$transaction(async (tx) => {
        // Note: SET LOCAL doesn't support parameter binding, use $executeRawUnsafe
        // This is safe here as testUserId is a constant defined in tests
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_user_id = '${testUserId}'`
        );
        return tx.$queryRaw<{ user_id: string }[]>`
          SELECT get_current_user_id() AS user_id
        `;
      });

      expect(result[0]?.user_id).toBe(testUserId);
    });
  });

  // [Phase 1] Cross-table fail-close verification removed
  // accounts, sessions tables deleted in Phase 1
  // [DELETED OSS] api_keys table deleted in OSS cleanup

  describe("Authorized access verification", () => {
    it("should allow access with valid user context", async () => {
      const projects = await withRlsContext(prisma, testUserId, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM projects WHERE id = ${testProjectId}::uuid
        `;
      });

      // With valid context, user should see their project
      expect(projects).toHaveLength(1);
      expect(projects[0]?.id).toBe(testProjectId);
    });
  });
  }
);
