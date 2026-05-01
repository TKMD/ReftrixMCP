// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 Cleanup Service Tests (v0.4.0 PR7e PR-B / LCC-M3-03)
 *
 * Phase 0 層で失敗した `web_pages` 行の TTL ベース削除を検証する。
 *   - WHERE 条件 (analysisStatus='failed' + lastAnalyzedPhase IS NULL + cutoff)
 *   - maxBatchSize による上限制御
 *   - deletedCount > 0 のみ audit_logs 記録 (GDPR Art.30)
 *   - deletedCount === 0 の no-op パス
 *   - NaN / 負値の防御
 *   - Prisma エラー時の fail-open
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPhase0CleanupService,
  DEFAULT_PHASE0_BATCH_SIZE,
  ABSOLUTE_PHASE0_BATCH_SIZE,
  type IPhase0CleanupPrismaClient,
} from "../../src/services/phase0-cleanup.service";

// Hoisted audit log mock / audit-log のモック
const auditLogMock = vi.hoisted(() => ({
  log: vi.fn(async () => undefined),
}));
vi.mock("../../src/services/audit-log.service", () => ({
  getAuditLogService: (): { log: typeof auditLogMock.log } => auditLogMock,
}));

function buildPrismaMock(rowIds: string[] = []): {
  prisma: IPhase0CleanupPrismaClient;
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async () => rowIds.map((id) => ({ id })));
  const deleteMany = vi.fn(async () => ({ count: rowIds.length }));
  const prisma: IPhase0CleanupPrismaClient = {
    webPage: {
      findMany: findMany as unknown as IPhase0CleanupPrismaClient["webPage"]["findMany"],
      deleteMany: deleteMany as unknown as IPhase0CleanupPrismaClient["webPage"]["deleteMany"],
    },
  };
  return { prisma, findMany, deleteMany };
}

describe("Phase0CleanupService (v0.4.0 PR7e PR-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("WHERE clause contract", () => {
    it("filters by analysisStatus='failed', lastAnalyzedPhase=null, age cutoff", async () => {
      const { prisma, findMany, deleteMany } = buildPrismaMock([
        "11111111-1111-4111-8111-111111111111",
      ]);
      const service = createPhase0CleanupService({ prisma });

      await service.cleanupStaleFailedRows(7 * 24 * 60 * 60 * 1000);

      expect(findMany).toHaveBeenCalledTimes(1);
      const whereArg = findMany.mock.calls[0]![0]!.where as {
        analysisStatus: string;
        analysisCompletedAt: { lt: Date };
        lastAnalyzedPhase: null;
      };
      expect(whereArg.analysisStatus).toBe("failed");
      expect(whereArg.lastAnalyzedPhase).toBeNull();
      expect(whereArg.analysisCompletedAt.lt).toBeInstanceOf(Date);
      expect(deleteMany).toHaveBeenCalledTimes(1);
    });

    it("does NOT delete when no rows match (findMany returns empty)", async () => {
      const { prisma, deleteMany } = buildPrismaMock([]);
      const service = createPhase0CleanupService({ prisma });

      const deleted = await service.cleanupStaleFailedRows(1000);

      expect(deleted).toBe(0);
      expect(deleteMany).not.toHaveBeenCalled();
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });
  });

  describe("maxBatchSize cap", () => {
    it("uses default 1000 when maxBatchSize is not provided", async () => {
      const { prisma, findMany } = buildPrismaMock([]);
      const service = createPhase0CleanupService({ prisma });

      await service.cleanupStaleFailedRows(1000);

      expect(findMany.mock.calls[0]![0]!.take).toBe(DEFAULT_PHASE0_BATCH_SIZE);
    });

    it("clamps maxBatchSize to absolute cap (100_000)", async () => {
      const { prisma, findMany } = buildPrismaMock([]);
      const service = createPhase0CleanupService({ prisma });

      await service.cleanupStaleFailedRows(1000, { maxBatchSize: 999_999_999 });

      expect(findMany.mock.calls[0]![0]!.take).toBe(ABSOLUTE_PHASE0_BATCH_SIZE);
    });

    it("falls back to default when maxBatchSize is NaN / negative / zero", async () => {
      const { prisma, findMany } = buildPrismaMock([]);
      const service = createPhase0CleanupService({ prisma });

      await service.cleanupStaleFailedRows(1000, { maxBatchSize: NaN });
      await service.cleanupStaleFailedRows(1000, { maxBatchSize: -5 });
      await service.cleanupStaleFailedRows(1000, { maxBatchSize: 0 });

      for (const call of findMany.mock.calls) {
        expect(call[0]!.take).toBe(DEFAULT_PHASE0_BATCH_SIZE);
      }
    });
  });

  describe("audit_logs recording (GDPR Art.30)", () => {
    it("records audit entry when deletedCount > 0", async () => {
      const { prisma } = buildPrismaMock([
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
      const service = createPhase0CleanupService({ prisma });

      const deleted = await service.cleanupStaleFailedRows(1000);

      expect(deleted).toBe(2);
      expect(auditLogMock.log).toHaveBeenCalledTimes(1);
      const entry = auditLogMock.log.mock.calls[0]![0];
      expect(entry.action).toBe("phase0_stale_cleanup");
      expect(entry.actor).toBe("system:phase0-cleanup-cron");
      expect(entry.targetType).toBe("web_page");
      expect(entry.result).toBe("success");
      expect(entry.details).toMatchObject({ deletedCount: 2 });
    });

    it("does NOT record audit entry on zero-delete runs", async () => {
      const { prisma } = buildPrismaMock([]);
      const service = createPhase0CleanupService({ prisma });

      await service.cleanupStaleFailedRows(1000);

      expect(auditLogMock.log).not.toHaveBeenCalled();
    });

    it("audit log failure does not block the returned deletedCount", async () => {
      const { prisma } = buildPrismaMock(["11111111-1111-4111-8111-111111111111"]);
      const service = createPhase0CleanupService({ prisma });
      auditLogMock.log.mockRejectedValueOnce(new Error("audit sink unavailable"));

      const deleted = await service.cleanupStaleFailedRows(1000);

      expect(deleted).toBe(1);
    });
  });

  describe("defensive guards", () => {
    it("throws when olderThanMs is negative", async () => {
      const { prisma } = buildPrismaMock();
      const service = createPhase0CleanupService({ prisma });

      await expect(service.cleanupStaleFailedRows(-1)).rejects.toThrow(
        /non-negative finite number/i
      );
    });

    it("throws when olderThanMs is NaN", async () => {
      const { prisma } = buildPrismaMock();
      const service = createPhase0CleanupService({ prisma });

      await expect(service.cleanupStaleFailedRows(NaN)).rejects.toThrow(
        /non-negative finite number/i
      );
    });

    it("throws when olderThanMs is Infinity", async () => {
      const { prisma } = buildPrismaMock();
      const service = createPhase0CleanupService({ prisma });

      await expect(service.cleanupStaleFailedRows(Infinity)).rejects.toThrow(
        /non-negative finite number/i
      );
    });
  });

  describe("fail-open on Prisma errors", () => {
    it("returns 0 when findMany throws", async () => {
      const { prisma } = buildPrismaMock();
      (prisma.webPage.findMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("connection refused")
      );
      const service = createPhase0CleanupService({ prisma });

      const deleted = await service.cleanupStaleFailedRows(1000);

      expect(deleted).toBe(0);
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });

    it("returns 0 when deleteMany throws", async () => {
      const { prisma } = buildPrismaMock(["11111111-1111-4111-8111-111111111111"]);
      (prisma.webPage.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("deadlock detected")
      );
      const service = createPhase0CleanupService({ prisma });

      const deleted = await service.cleanupStaleFailedRows(1000);

      expect(deleted).toBe(0);
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });
  });
});
