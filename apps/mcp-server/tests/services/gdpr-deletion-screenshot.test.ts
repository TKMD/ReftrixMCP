// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GdprDeletionService + ScreenshotPersistenceService 統合テスト
 * GdprDeletionService + ScreenshotPersistenceService integration tests
 *
 * GDPR Art. 17（忘れられる権利）削除経路で、DB 行削除と合わせて
 * 永続化された screenshot ファイルも確実に消去されることを検証する。
 *
 * Verifies that GDPR Art. 17 (Right to Erasure) deletion paths remove
 * persisted screenshot files along with DB rows.
 *
 * @module tests/services/gdpr-deletion-screenshot.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  setGdprScreenshotPersistenceFactory,
  resetGdprScreenshotPersistenceFactory,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../src/services/gdpr-deletion.service";
import type { IPhase5ScreenshotPersistence } from "../../src/services/screenshot-persistence.types";

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import { logger } from "../../src/utils/logger";

// =====================================================
// テストデータ（UUID v7 形式） / Test data (UUID v7 format)
// =====================================================

const PAGE_ID_A = "01934567-89ab-7def-8123-456789abcdef";
const PAGE_ID_B = "01934567-89ab-7abc-9123-456789abcdef";

// =====================================================
// Mock factories
// =====================================================

function createExistingPrismaMock(existingPageIds: string[]): GdprPrismaClient {
  const existingSet = new Set(existingPageIds);
  const queryRawUnsafe = vi.fn().mockImplementation((query: string, ...values: unknown[]) => {
    if (query.includes("FROM web_pages WHERE id")) {
      const id = values[0] as string;
      return Promise.resolve(existingSet.has(id) ? [{ id }] : []);
    }
    return Promise.resolve([]);
  });
  const executeRawUnsafe = vi.fn().mockResolvedValue(1);
  return {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: GdprPrismaClient) => Promise<unknown>) => {
        const txClient: GdprPrismaClient = {
          $queryRawUnsafe: queryRawUnsafe,
          $executeRawUnsafe: executeRawUnsafe,
          $transaction: vi.fn(),
        };
        return fn(txClient);
      }),
  };
}

function createScreenshotServiceMock(): IPhase5ScreenshotPersistence & {
  deleteScreenshot: ReturnType<typeof vi.fn>;
} {
  return {
    deleteScreenshot: vi.fn().mockResolvedValue(undefined),
  };
}

// =====================================================
// Tests
// =====================================================

describe("GdprDeletionService + ScreenshotPersistence", () => {
  let service: GdprDeletionService;
  let mockScreenshot: ReturnType<typeof createScreenshotServiceMock>;

  beforeEach(() => {
    resetGdprDeletionService();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetGdprDeletionService();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
  });

  describe("deletePage: GDPR Art. 17 screenshot file deletion", () => {
    it("DB 削除成功後に screenshot ファイルを削除する / deletes screenshot after DB success", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A]));
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      const result = await service.deletePage(PAGE_ID_A, "user requested deletion");

      expect(result.deleted).toBe(true);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledTimes(1);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledWith(PAGE_ID_A);
    });

    it("screenshot service 未設定時は warn を出し graceful degrade する / graceful degrade when unset", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A]));
      // screenshotPersistenceFactory を設定しない
      service = new GdprDeletionService();

      const result = await service.deletePage(PAGE_ID_A, "user requested");
      expect(result.deleted).toBe(true);

      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const hasWarning = warnCalls.some((call) =>
        String(call[0]).includes("ScreenshotPersistenceService not wired")
      );
      expect(hasWarning).toBe(true);
    });

    it("screenshot 削除失敗でも DB 削除を rollback しない / file failure does not roll back DB", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A]));
      mockScreenshot = createScreenshotServiceMock();
      mockScreenshot.deleteScreenshot.mockRejectedValueOnce(new Error("EACCES"));
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      // throw せずに結果を返す / returns result instead of throwing
      const result = await service.deletePage(PAGE_ID_A, "user requested");
      expect(result.deleted).toBe(true);

      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const hasWarning = warnCalls.some((call) =>
        String(call[0]).includes("Screenshot file deletion failed")
      );
      expect(hasWarning).toBe(true);
    });

    it("ページが DB に存在しない場合は screenshot 削除も行わない / no screenshot delete on missing page", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([])); // empty
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      await expect(service.deletePage(PAGE_ID_A, "user requested")).rejects.toThrow(
        /Page not found/
      );
      expect(mockScreenshot.deleteScreenshot).not.toHaveBeenCalled();
    });
  });

  describe("deleteAllUserData: bulk screenshot deletion", () => {
    it("削除成功した全 page の screenshot を削除する / deletes screenshots for all successfully deleted pages", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A, PAGE_ID_B]));
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      const result = await service.deleteAllUserData(
        [PAGE_ID_A, PAGE_ID_B],
        undefined,
        "user requested all delete"
      );

      expect(result.pages_deleted).toBe(2);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledTimes(2);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledWith(PAGE_ID_A);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledWith(PAGE_ID_B);
    });

    it("存在しないページは screenshot 削除対象から除外する / skips nonexistent pages", async () => {
      // PAGE_ID_A のみ存在、PAGE_ID_B は存在しない
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A]));
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      const result = await service.deleteAllUserData(
        [PAGE_ID_A, PAGE_ID_B],
        undefined,
        "user requested"
      );

      expect(result.pages_deleted).toBe(1);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledTimes(1);
      expect(mockScreenshot.deleteScreenshot).toHaveBeenCalledWith(PAGE_ID_A);
    });

    it("空の pageIds 配列でも正常終了する / handles empty pageIds", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([]));
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      const result = await service.deleteAllUserData([], undefined, "user requested");

      expect(result.pages_deleted).toBe(0);
      expect(mockScreenshot.deleteScreenshot).not.toHaveBeenCalled();
    });
  });

  describe("PII truncation in logs", () => {
    it("logger.warn の出力に full pageId が含まれない / logger does not contain full pageId", async () => {
      setGdprPrismaClientFactory(() => createExistingPrismaMock([PAGE_ID_A]));
      mockScreenshot = createScreenshotServiceMock();
      setGdprScreenshotPersistenceFactory(() => mockScreenshot);

      service = new GdprDeletionService();
      await service.deletePage(PAGE_ID_A, "user requested");

      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      for (const [, meta] of warnCalls) {
        if (meta && typeof meta === "object" && "pageId" in meta) {
          expect(meta.pageId).not.toBe(PAGE_ID_A);
          // truncateId の結果は先頭8文字 + "..." のため full 形式ではない
          expect(String(meta.pageId).endsWith("...")).toBe(true);
        }
      }
    });
  });
});
