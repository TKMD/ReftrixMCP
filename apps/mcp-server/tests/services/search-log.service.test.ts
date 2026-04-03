// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Log Service Unit Tests
 * 検索ログサービス ユニットテスト
 *
 * TDD: Red phase — テスト先行で作成
 * Tests: logSearch, getSearchStats, getFacetCounts
 *
 * @module tests/services/search-log.service.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =====================================================
// Mock Prisma
// =====================================================

const { mockPrismaSearchLog } = vi.hoisted(() => ({
  mockPrismaSearchLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    aggregate: vi.fn(),
  },
}));

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    searchLog: mockPrismaSearchLog,
    $queryRawUnsafe: vi.fn(),
  },
  Prisma: {
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
  },
}));

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// =====================================================
// Import after mocks
// =====================================================

import {
  logSearch,
  getSearchStats,
  type SearchLogEntry,
  type SearchStats,
} from "../../src/services/search-log.service";

// =====================================================
// Test Suites
// =====================================================

describe("SearchLogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================
  // logSearch
  // =====================================================

  describe("logSearch", () => {
    it("検索ログを正しく記録する / Records search log correctly", async () => {
      const entry: SearchLogEntry = {
        query: "hero section with dark theme",
        queryType: "visual",
        services: ["layout", "part"],
        resultCount: 5,
        topResultId: "550e8400-e29b-41d4-a716-446655440000",
        latencyMs: 150,
        cacheHit: false,
      };

      mockPrismaSearchLog.create.mockResolvedValue({
        id: "test-uuid",
        ...entry,
      });

      await logSearch(entry);

      expect(mockPrismaSearchLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrismaSearchLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          query: "hero section with dark theme",
          queryType: "visual",
          services: ["layout", "part"],
          resultCount: 5,
          latencyMs: 150,
          cacheHit: false,
        }),
      });
    });

    it("クエリを200文字にtruncateする / Truncates query to 200 chars", async () => {
      const longQuery = "a".repeat(300);

      mockPrismaSearchLog.create.mockResolvedValue({ id: "test-uuid" });

      await logSearch({
        query: longQuery,
        services: ["layout"],
        resultCount: 0,
        latencyMs: 100,
        cacheHit: false,
      });

      const call = mockPrismaSearchLog.create.mock.calls[0]?.[0];
      expect(call?.data?.query).toHaveLength(200);
    });

    it("profileIdをtruncateして保存する / Truncates profileId for PII", async () => {
      const entry: SearchLogEntry = {
        query: "test",
        services: ["layout"],
        resultCount: 0,
        latencyMs: 50,
        cacheHit: false,
        profileId: "550e8400-e29b-41d4-a716-446655440000",
      };

      mockPrismaSearchLog.create.mockResolvedValue({ id: "test-uuid" });

      await logSearch(entry);

      const call = mockPrismaSearchLog.create.mock.calls[0]?.[0];
      // profileId should be truncated (not full UUID)
      expect(call?.data?.profileId).toBe("550e8400...");
    });

    it("topResultIdをtruncateして保存する / Truncates topResultId", async () => {
      const entry: SearchLogEntry = {
        query: "test",
        services: ["layout"],
        resultCount: 1,
        topResultId: "550e8400-e29b-41d4-a716-446655440000",
        latencyMs: 50,
        cacheHit: false,
      };

      mockPrismaSearchLog.create.mockResolvedValue({ id: "test-uuid" });

      await logSearch(entry);

      const call = mockPrismaSearchLog.create.mock.calls[0]?.[0];
      expect(call?.data?.topResultId).toBe("550e8400...");
    });

    it("DB書き込み失敗時に例外を投げずにログ出力する / Graceful on DB write failure", async () => {
      mockPrismaSearchLog.create.mockRejectedValue(new Error("DB connection failed"));

      await expect(
        logSearch({
          query: "test",
          services: ["layout"],
          resultCount: 0,
          latencyMs: 50,
          cacheHit: false,
        })
      ).resolves.not.toThrow();
    });

    it("filtersをJSON形式で保存する / Saves filters as JSON", async () => {
      const entry: SearchLogEntry = {
        query: "SaaS hero section",
        services: ["layout"],
        resultCount: 3,
        latencyMs: 100,
        cacheHit: false,
        filters: { industry: "SaaS", audience: "Developer" },
      };

      mockPrismaSearchLog.create.mockResolvedValue({ id: "test-uuid" });

      await logSearch(entry);

      const call = mockPrismaSearchLog.create.mock.calls[0]?.[0];
      expect(call?.data?.filters).toEqual({ industry: "SaaS", audience: "Developer" });
    });
  });

  // =====================================================
  // getSearchStats
  // =====================================================

  describe("getSearchStats", () => {
    it("検索統計を正しく取得する / Gets search stats correctly", async () => {
      mockPrismaSearchLog.count.mockResolvedValue(100);
      mockPrismaSearchLog.aggregate.mockResolvedValue({
        _avg: { latencyMs: 250 },
      });
      mockPrismaSearchLog.groupBy.mockResolvedValue([
        { query: "hero section", _count: { query: 15 } },
        { query: "dark theme", _count: { query: 10 } },
      ]);

      // Cache hit rate query
      const mockCacheCount = 30;
      const cacheCountMock = vi.fn().mockResolvedValue(mockCacheCount);
      mockPrismaSearchLog.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(mockCacheCount); // cache hits

      const stats: SearchStats = await getSearchStats();

      expect(stats).toHaveProperty("totalSearches");
      expect(stats).toHaveProperty("averageLatencyMs");
      expect(stats).toHaveProperty("cacheHitRate");
      expect(stats).toHaveProperty("topQueries");
    });

    it("検索ログが0件の場合のデフォルト値 / Default values when no logs", async () => {
      mockPrismaSearchLog.count.mockResolvedValue(0);
      mockPrismaSearchLog.aggregate.mockResolvedValue({
        _avg: { latencyMs: null },
      });
      mockPrismaSearchLog.groupBy.mockResolvedValue([]);

      const stats = await getSearchStats();

      expect(stats.totalSearches).toBe(0);
      expect(stats.averageLatencyMs).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.topQueries).toEqual([]);
    });

    it("期間フィルターを適用できる / Applies time range filter", async () => {
      const since = new Date("2026-01-01");
      const until = new Date("2026-03-27");

      mockPrismaSearchLog.count.mockResolvedValue(50);
      mockPrismaSearchLog.aggregate.mockResolvedValue({
        _avg: { latencyMs: 200 },
      });
      mockPrismaSearchLog.groupBy.mockResolvedValue([]);

      await getSearchStats({ since, until });

      // Verify filters are passed to count and aggregate
      expect(mockPrismaSearchLog.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            timestamp: expect.objectContaining({
              gte: since,
              lte: until,
            }),
          }),
        })
      );
    });
  });
});
