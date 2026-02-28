// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLS Policies Tests
 *
 * Tests for Row Level Security policies on Tier 1 tables:
 * - projects
 * - accounts
 * - sessions
 * - api_keys
 *
 * Reference: docs/plans/rls-implementation-plan.md
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withRlsContext } from "../../src/utils/rls-transaction";
import { withAdminBypass } from "../../src/utils/admin-operation";

// Test requires a running PostgreSQL database with RLS policies applied
// Skip tests if DATABASE_URL or ADMIN_DATABASE_URL is not available
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL;

describe.skipIf(!DATABASE_URL || !ADMIN_DATABASE_URL)(
  "RLS Policies - Tier 1 Tables",
  () => {
    let prisma: PrismaClient;

    // Test users
    const userAId = "00000000-0000-0000-0000-000000000001";
    const userBId = "00000000-0000-0000-0000-000000000002";

    // Test data IDs
    let userAProjectId: string;
    let userBProjectId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();

      // Create test users and projects using admin bypass (bypasses RLS)
      try {
        await withAdminBypass(
          "test_setup_rls_policies",
          "Creating test data for RLS policies tests",
          async (adminPrisma) => {
            // Create test users
            await adminPrisma.$executeRaw`
          INSERT INTO users (id, email, name, created_at, updated_at)
          VALUES
            (${userAId}::uuid, 'user-a@test.com', 'User A', NOW(), NOW()),
            (${userBId}::uuid, 'user-b@test.com', 'User B', NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `;

            // Create test projects
            const projectA = await adminPrisma.$queryRaw<{ id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userAId}::uuid, 'User A Project', 'user-a-project-' || gen_random_uuid()::text, 'draft', NOW(), NOW())
          RETURNING id::text
        `;
            userAProjectId = projectA[0]?.id ?? "";

            const projectB = await adminPrisma.$queryRaw<{ id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userBId}::uuid, 'User B Project', 'user-b-project-' || gen_random_uuid()::text, 'draft', NOW(), NOW())
          RETURNING id::text
        `;
            userBProjectId = projectB[0]?.id ?? "";
          }
        );
      } catch (error) {
        console.error("Setup failed:", error);
        throw error;
      }
    });

    afterAll(async () => {
      // Cleanup test data using admin bypass
      try {
        await withAdminBypass(
          "test_cleanup_rls_policies",
          "Cleaning up test data for RLS policies tests",
          async (adminPrisma) => {
            await adminPrisma.$executeRaw`
          DELETE FROM projects WHERE user_id IN (${userAId}::uuid, ${userBId}::uuid)
        `;
            await adminPrisma.$executeRaw`
          DELETE FROM users WHERE id IN (${userAId}::uuid, ${userBId}::uuid)
        `;
          }
        );
      } catch (error) {
        console.error("Cleanup failed:", error);
      }

      await prisma.$disconnect();
    });

  describe("projects table", () => {
    it("should allow owner to read their own projects", async () => {
      const projects = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$queryRaw<{ id: string; user_id: string }[]>`
          SELECT id::text, user_id::text FROM projects
        `;
      });

      // User A should only see their own projects
      expect(projects.length).toBeGreaterThanOrEqual(1);
      expect(projects.every((p) => p.user_id === userAId)).toBe(true);
    });

    it("should deny access to other users projects", async () => {
      const projects = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM projects WHERE id = ${userBProjectId}::uuid
        `;
      });

      // User A should not see User B's project
      expect(projects).toHaveLength(0);
    });

    it("should allow owner to create their own project", async () => {
      const newSlug = `test-create-${Date.now()}`;

      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$queryRaw<{ id: string; user_id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userAId}::uuid, 'Test Create', ${newSlug}, 'draft', NOW(), NOW())
          RETURNING id::text, user_id::text
        `;
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.user_id).toBe(userAId);

      // Cleanup
      await prisma.$executeRaw`DELETE FROM projects WHERE slug = ${newSlug}`;
    });

    it("should deny creating project for another user", async () => {
      const newSlug = `test-deny-${Date.now()}`;

      // User A tries to create a project owned by User B
      await expect(
        withRlsContext(prisma, userAId, async (tx) => {
          return tx.$executeRaw`
            INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
            VALUES (gen_random_uuid(), ${userBId}::uuid, 'Malicious', ${newSlug}, 'draft', NOW(), NOW())
          `;
        })
      ).rejects.toThrow();
    });

    it("should allow owner to update their own project", async () => {
      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$executeRaw`
          UPDATE projects SET name = 'Updated Name' WHERE id = ${userAProjectId}::uuid
        `;
      });

      // Should update 1 row
      expect(result).toBe(1);

      // Revert
      await prisma.$executeRaw`
        UPDATE projects SET name = 'User A Project' WHERE id = ${userAProjectId}::uuid
      `;
    });

    it("should deny updating other users project", async () => {
      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$executeRaw`
          UPDATE projects SET name = 'Hacked' WHERE id = ${userBProjectId}::uuid
        `;
      });

      // Should not update any rows (RLS blocks the update)
      expect(result).toBe(0);
    });

    it("should allow owner to delete their own project", async () => {
      // Create a project to delete using admin bypass (test setup)
      const slug = `test-delete-${Date.now()}`;
      let projectId: string | undefined;

      await withAdminBypass(
        "test_setup_delete_project",
        "Creating project for delete test",
        async (adminPrisma) => {
          const created = await adminPrisma.$queryRaw<{ id: string }[]>`
            INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
            VALUES (gen_random_uuid(), ${userAId}::uuid, 'To Delete', ${slug}, 'draft', NOW(), NOW())
            RETURNING id::text
          `;
          projectId = created[0]?.id;
        }
      );

      // Test the actual delete operation with RLS context
      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$executeRaw`
          DELETE FROM projects WHERE id = ${projectId}::uuid
        `;
      });

      expect(result).toBe(1);
    });

    it("should deny deleting other users project", async () => {
      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$executeRaw`
          DELETE FROM projects WHERE id = ${userBProjectId}::uuid
        `;
      });

      // Should not delete any rows
      expect(result).toBe(0);
    });
  });

  // [Phase 1] accounts table and sessions table tests removed
  // These tables were deleted during Phase 1 DB cleanup

  // [DELETED OSS] api_keys table tests removed
  // ApiKey table was deleted during OSS cleanup
  }
);
