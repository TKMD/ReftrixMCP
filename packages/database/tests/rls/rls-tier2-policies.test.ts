// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLS Tier 2 Policies Tests
 *
 * Tests for Row Level Security policies on Tier 2 tables:
 * - project_brand_settings (1 JOIN via projects)
 *
 * [Phase 1] Removed tables and their tests:
 * - project_pages, project_briefs, project_layout_versions,
 *   project_code_exports, project_layout_scores
 *
 * Reference: docs/plans/rls-implementation-plan.md Section 4.5-4.10
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
  "RLS Policies - Tier 2 Tables",
  () => {
    let prisma: PrismaClient;

  // Test users
  const userAId = "00000000-0000-0000-0000-000000000011";
  const userBId = "00000000-0000-0000-0000-000000000012";

  // Test data IDs (will be populated in beforeAll)
  let userAProjectId: string;
  let userBProjectId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();

    try {
      // Create test data using admin bypass (bypasses RLS)
      await withAdminBypass(
        "test_setup_tier2_rls",
        "Creating test data for Tier 2 RLS tests",
        async (adminPrisma) => {
          // Create test users
          await adminPrisma.$executeRaw`
          INSERT INTO users (id, email, name, created_at, updated_at)
          VALUES
            (${userAId}::uuid, 'user-a-tier2@test.com', 'User A Tier2', NOW(), NOW()),
            (${userBId}::uuid, 'user-b-tier2@test.com', 'User B Tier2', NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `;

          // Create test projects for both users
          const projectA = await adminPrisma.$queryRaw<{ id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userAId}::uuid, 'User A Project T2', 'user-a-project-t2-' || gen_random_uuid()::text, 'draft', NOW(), NOW())
          RETURNING id::text
        `;
          userAProjectId = projectA[0]?.id ?? "";

          const projectB = await adminPrisma.$queryRaw<{ id: string }[]>`
          INSERT INTO projects (id, user_id, name, slug, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userBId}::uuid, 'User B Project T2', 'user-b-project-t2-' || gen_random_uuid()::text, 'draft', NOW(), NOW())
          RETURNING id::text
        `;
          userBProjectId = projectB[0]?.id ?? "";

          // Create brand settings for User A's project
          await adminPrisma.$executeRaw`
          INSERT INTO project_brand_settings (id, project_id, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userAProjectId}::uuid, NOW(), NOW())
          ON CONFLICT (project_id) DO NOTHING
        `;

          // Create brand settings for User B's project
          await adminPrisma.$executeRaw`
          INSERT INTO project_brand_settings (id, project_id, created_at, updated_at)
          VALUES (gen_random_uuid(), ${userBProjectId}::uuid, NOW(), NOW())
          ON CONFLICT (project_id) DO NOTHING
        `;
        }
      );
    } catch (error) {
      console.error("Setup failed:", error);
      throw error;
    }
  });

  afterAll(async () => {
    // Cleanup test data using admin bypass (cascade will handle child tables)
    try {
      await withAdminBypass(
        "test_cleanup_tier2_rls",
        "Cleaning up test data for Tier 2 RLS tests",
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

  // ===========================================================================
  // project_brand_settings table tests (P1: 1 JOIN)
  // ===========================================================================
  describe("project_brand_settings table (P1: 1 JOIN via projects)", () => {
    it("should allow owner to read their brand settings", async () => {
      const settings = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$queryRaw<{ id: string; project_id: string }[]>`
          SELECT id::text, project_id::text FROM project_brand_settings
        `;
      });

      expect(settings.length).toBeGreaterThanOrEqual(1);
      expect(settings.every((s) => s.project_id === userAProjectId)).toBe(true);
    });

    it("should deny access to other users brand settings", async () => {
      const settings = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM project_brand_settings WHERE project_id = ${userBProjectId}::uuid
        `;
      });

      expect(settings).toHaveLength(0);
    });

    it("should deny updating other users brand settings", async () => {
      const result = await withRlsContext(prisma, userAId, async (tx) => {
        return tx.$executeRaw`
          UPDATE project_brand_settings SET brand_id = 'hacked' WHERE project_id = ${userBProjectId}::uuid
        `;
      });

      expect(result).toBe(0);
    });
  });

  // ===========================================================================
  // Fail-close behavior verification for Tier 2 tables
  // ===========================================================================
  describe("Fail-close behavior for Tier 2 tables", () => {
    it("should fail-close on project_brand_settings with null context", async () => {
      const settings = await withRlsContext(prisma, null, async (tx) => {
        return tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM project_brand_settings`;
      });

      expect(settings).toHaveLength(0);
    });
  });
  }
);
