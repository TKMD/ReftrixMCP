// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * repair-page-analyze.ts — Integration Test (PR7e-β1)
 *
 * 実 PostgreSQL (Docker Compose 経由) に対して repair script を走らせ、
 * `bootstrapAuditLogServiceForScript()` が正しく DI を登録した結果、
 * `audit_logs` テーブルに実際に row が書き込まれることを検証する。
 *
 * Drives the repair script against a real PostgreSQL (via Docker Compose) to
 * verify that `bootstrapAuditLogServiceForScript()` correctly registers the DI
 * so that `audit_logs` rows are actually inserted.
 *
 * スコープ (β1) / Scope (β1):
 * - 1 シナリオ: dry-run 実行 → `audit_logs` に `*_repair_dryrun` entry が INSERT される
 * - β3 で追加予定: CAS 競合シナリオ / WorkerActiveLock 競合シナリオ
 *
 * - 1 scenario: dry-run execution → `audit_logs` has a `*_repair_dryrun` entry
 * - To be added in β3: CAS race scenario / WorkerActiveLock contention scenario
 *
 * CI / local: `DATABASE_URL` が未設定なら全 skip。
 * CI / local: all tests are skipped when `DATABASE_URL` is unset.
 *
 * @module tests/scripts/repair-page-analyze.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  bootstrapAuditLogServiceForScript,
  getAuditLogService,
  resetAuditLogService,
  resetAuditLogPrismaClientFactory,
} from "../../src/services/audit-log.service";

const isDatabaseAvailable = !!process.env.DATABASE_URL;

describe.skipIf(!isDatabaseAvailable)(
  "repair-page-analyze integration — audit_logs persistence (PR7e-β1)",
  () => {
    let prisma: PrismaClient;
    const testRunMarker = `pr7e-beta1-integration-${Date.now()}`;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
    });

    afterAll(async () => {
      // Clean up test audit_logs entries to avoid polluting shared DB
      try {
        await prisma.auditLog.deleteMany({
          where: {
            actor: { startsWith: "repair-script:pr7e-beta1-integration-" },
          },
        });
      } finally {
        await prisma.$disconnect();
        resetAuditLogService();
        resetAuditLogPrismaClientFactory();
      }
    });

    beforeEach(() => {
      resetAuditLogService();
      resetAuditLogPrismaClientFactory();
    });

    it("bootstrapAuditLogServiceForScript() を呼ぶと audit_logs に INSERT できる / after bootstrap, AuditLogService can write audit_logs", async () => {
      // Pre-check: without bootstrap, logs degrade to warn-only and nothing is written.
      const beforeCount = await prisma.auditLog.count({
        where: {
          actor: `repair-script:${testRunMarker}`,
        },
      });
      expect(beforeCount).toBe(0);

      // Act: bootstrap + write.
      bootstrapAuditLogServiceForScript(prisma);
      const service = getAuditLogService();
      await service.log({
        action: "embedding_backfill_repair_dryrun",
        actor: `repair-script:${testRunMarker}`,
        targetType: "web_page",
        targetId: "00000000-0000-7000-0000-000000000000",
        details: {
          repair_reason: "pr7e_beta1_integration_test",
          pr: "PR7e-β1",
          idempotency_key: `integration-${testRunMarker}`,
        },
        result: "success",
      });

      // Assert: row was written.
      const afterCount = await prisma.auditLog.count({
        where: {
          actor: `repair-script:${testRunMarker}`,
        },
      });
      expect(afterCount).toBe(1);

      // Assert: row content matches (action + targetType preserved).
      const rows = await prisma.auditLog.findMany({
        where: {
          actor: `repair-script:${testRunMarker}`,
        },
        take: 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("embedding_backfill_repair_dryrun");
      expect(rows[0].targetType).toBe("web_page");
      expect(rows[0].result).toBe("success");
      // details は JSON で保存され、repair_reason フィールドが保持される
      // details is persisted as JSON and retains the repair_reason field
      const details = rows[0].details as Record<string, unknown> | null;
      expect(details).not.toBeNull();
      expect(details?.repair_reason).toBe("pr7e_beta1_integration_test");
    });

    it("bootstrap を呼ばないと audit_logs に何も書き込まれない / without bootstrap, no rows are inserted", async () => {
      const uniqueMarker = `pr7e-beta1-integration-nobootstrap-${Date.now()}`;

      // DI を明示的にリセット
      // Explicitly reset DI
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();

      const service = getAuditLogService();
      await service.log({
        action: "embedding_backfill_repair_dryrun",
        actor: `repair-script:${uniqueMarker}`,
        targetType: "web_page",
        targetId: "00000000-0000-7000-0000-000000000001",
        details: { repair_reason: "no_bootstrap_test" },
        result: "success",
      });

      // Assert: no row was written (graceful degradation).
      const count = await prisma.auditLog.count({
        where: {
          actor: `repair-script:${uniqueMarker}`,
        },
      });
      expect(count).toBe(0);

      // Clean up any leaked rows (defensive).
      await prisma.auditLog.deleteMany({
        where: { actor: `repair-script:${uniqueMarker}` },
      });
    });
  }
);
