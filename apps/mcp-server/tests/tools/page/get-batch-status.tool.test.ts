// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.getBatchStatus MCPツールのテスト
 * Batch Status Tool Tests (v0.4.0 T3-BATCH)
 *
 * テスト対象:
 * - Zodスキーマバリデーション (3テスト)
 * - ハンドラー統合テスト (6テスト)
 * - ツール定義の検証 (3テスト)
 * - セキュリティ (3テスト)
 *
 * @module tests/tools/page/get-batch-status.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// =====================================================
// Mocks（インポート前に定義）
// =====================================================

vi.mock("../../../src/config/redis", () => ({
  isRedisAvailable: vi.fn(),
  getRedisClient: vi.fn(),
}));

vi.mock("../../../src/queues/page-analyze-queue", () => ({
  createPageAnalyzeQueue: vi.fn(),
  getJobStatus: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock("../../../src/utils/mcp-response", () => ({
  generateRequestId: vi.fn(() => "test-request-id-batch-status-001"),
  createSuccessResponseWithRequestId: vi.fn(
    (data: unknown, requestId: string, metadata?: Record<string, unknown>) => ({
      success: true,
      data,
      metadata: { request_id: requestId, ...metadata },
    })
  ),
  createErrorResponseWithRequestId: vi.fn((code: string, message: string, requestId: string) => ({
    success: false,
    error: { code, message },
    metadata: { request_id: requestId },
  })),
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn(() => false),
}));

// =====================================================
// Imports（モック定義後）
// =====================================================

import { isRedisAvailable, getRedisClient } from "../../../src/config/redis";
import {
  createPageAnalyzeQueue,
  getJobStatus,
  closeQueue,
} from "../../../src/queues/page-analyze-queue";

import {
  getBatchStatusInputSchema,
  GET_BATCH_STATUS_ERROR_CODES,
} from "../../../src/tools/page/batch-analyze.schemas";

import {
  pageGetBatchStatusHandler,
  pageGetBatchStatusToolDefinition,
} from "../../../src/tools/page/get-batch-status.tool";

// =====================================================
// Test Data
// =====================================================

const VALID_BATCH_ID = "01930a00-0000-7000-8000-000000000001";

function createBatchMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobIds: ["job-001", "job-002"],
    urls: ["https://example.com", "https://example.org"],
    skippedUrls: [],
    concurrency: 3,
    timeout: 1800000,
    onError: "skip",
    startedAt: new Date().toISOString(),
    state: "active",
    webPageIds: ["wp-001", "wp-002"],
    ...overrides,
  });
}

// =====================================================
// Test Suite
// =====================================================

describe("page.getBatchStatus Tool", () => {
  const mockQueue = {
    getJob: vi.fn(),
    close: vi.fn(),
  };

  const mockRedisClient = {
    get: vi.fn(),
    setex: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルト: Redis利用可能
    (isRedisAvailable as Mock).mockResolvedValue(true);
    (getRedisClient as Mock).mockReturnValue(mockRedisClient);
    (createPageAnalyzeQueue as Mock).mockReturnValue(mockQueue);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // Schema Validation / スキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("有効なbatch_idで受け入れる", () => {
      // Arrange
      const input = { batch_id: VALID_BATCH_ID };

      // Act
      const result = getBatchStatusInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.batch_id).toBe(VALID_BATCH_ID);
      }
    });

    it("空文字列のbatch_idでバリデーションエラー", () => {
      // Arrange
      const input = { batch_id: "" };

      // Act
      const result = getBatchStatusInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });

    it("batch_idが欠落しているとバリデーションエラー", () => {
      // Arrange
      const input = {};

      // Act
      const result = getBatchStatusInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  // =====================================================
  // Handler / ハンドラー統合テスト
  // =====================================================

  describe("ハンドラー統合テスト", () => {
    it("Redis不可時にREDIS_UNAVAILABLEエラーを返す", async () => {
      // Arrange
      (isRedisAvailable as Mock).mockResolvedValue(false);

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.REDIS_UNAVAILABLE);
        expect(result.error.message).toContain("Redis");
      }
    });

    it("バッチ未発見時にBATCH_NOT_FOUNDエラーを返す", async () => {
      // Arrange — Redisにメタデータなし
      mockRedisClient.get.mockResolvedValue(null);

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.BATCH_NOT_FOUND);
        expect(result.error.message).toContain("not found");
      }
    });

    it("完了バッチ: state='completed', progress=100 を返す", async () => {
      // Arrange — 全ジョブ完了
      mockRedisClient.get.mockResolvedValue(createBatchMetadata());
      mockRedisClient.setex.mockResolvedValue("OK");

      (getJobStatus as Mock)
        .mockResolvedValueOnce({
          state: "completed",
          result: { processingTimeMs: 5000 },
        })
        .mockResolvedValueOnce({
          state: "completed",
          result: { processingTimeMs: 3000 },
        });

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe("completed");
        expect(result.data.progress).toBe(100);
        expect(result.data.summary.completed).toBe(2);
        expect(result.data.summary.failed).toBe(0);
        expect(result.data.jobs).toHaveLength(2);
      }
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it("進行中バッチ: state='active', progress計算が正しい", async () => {
      // Arrange — 1ジョブ完了、1ジョブアクティブ
      mockRedisClient.get.mockResolvedValue(createBatchMetadata());

      (getJobStatus as Mock)
        .mockResolvedValueOnce({
          state: "completed",
          result: { processingTimeMs: 5000 },
        })
        .mockResolvedValueOnce({
          state: "active",
        });

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe("active");
        // 2ジョブ中1完了 → 50%
        expect(result.data.progress).toBe(50);
        expect(result.data.summary.completed).toBe(1);
        expect(result.data.summary.active).toBe(1);
      }
    });

    it("部分完了バッチ: state='partial'（一部成功+一部失敗）", async () => {
      // Arrange — 1ジョブ完了、1ジョブ失敗
      mockRedisClient.get.mockResolvedValue(createBatchMetadata());
      mockRedisClient.setex.mockResolvedValue("OK");

      (getJobStatus as Mock)
        .mockResolvedValueOnce({
          state: "completed",
          result: { processingTimeMs: 5000 },
        })
        .mockResolvedValueOnce({
          state: "failed",
          error: "Timeout exceeded",
        });

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe("partial");
        expect(result.data.progress).toBe(100);
        expect(result.data.summary.completed).toBe(1);
        expect(result.data.summary.failed).toBe(1);
      }
    });

    it("全失敗バッチ: state='failed'", async () => {
      // Arrange — 全ジョブ失敗
      mockRedisClient.get.mockResolvedValue(createBatchMetadata());
      mockRedisClient.setex.mockResolvedValue("OK");

      (getJobStatus as Mock)
        .mockResolvedValueOnce({
          state: "failed",
          error: "Network error",
        })
        .mockResolvedValueOnce({
          state: "failed",
          error: "Timeout",
        });

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe("failed");
        expect(result.data.progress).toBe(100);
        expect(result.data.summary.completed).toBe(0);
        expect(result.data.summary.failed).toBe(2);
      }
    });
  });

  // =====================================================
  // Tool Definition / ツール定義
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が page.getBatchStatus である", () => {
      expect(pageGetBatchStatusToolDefinition.name).toBe("page.getBatchStatus");
    });

    it("annotationsにreadOnlyHint=true, idempotentHint=trueが設定されている", () => {
      expect(pageGetBatchStatusToolDefinition.annotations).toBeDefined();
      expect(pageGetBatchStatusToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(pageGetBatchStatusToolDefinition.annotations.idempotentHint).toBe(true);
    });

    it("inputSchemaのrequiredにbatch_idが含まれる", () => {
      expect(pageGetBatchStatusToolDefinition.inputSchema.required).toContain("batch_id");
    });
  });

  // =====================================================
  // Security / セキュリティ
  // =====================================================

  describe("セキュリティ", () => {
    it("エラーメッセージがサニタイズされる（内部エラー漏洩なし）", async () => {
      // Arrange — Redis接続内部エラー
      mockRedisClient.get.mockResolvedValue(createBatchMetadata());
      (getJobStatus as Mock).mockRejectedValue(
        new Error("INTERNAL: Redis at 127.0.0.1:27379 connection refused")
      );

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.INTERNAL_ERROR);
        // 内部IPアドレスやポート番号が漏洩しないこと
        expect(result.error.message).not.toContain("127.0.0.1");
        expect(result.error.message).not.toContain("27379");
      }
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it("不正JSONメタデータの処理でINTERNAL_ERRORを返す", async () => {
      // Arrange — 壊れたJSONをRedisから返却
      mockRedisClient.get.mockResolvedValue("{ invalid json !!!");

      // Act
      const result = await pageGetBatchStatusHandler({ batch_id: VALID_BATCH_ID });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.INTERNAL_ERROR);
        // パースエラーの詳細が漏洩しないこと
        expect(result.error.message).not.toContain("Unexpected token");
      }
    });

    it("入力がnullの場合VALIDATION_ERRORを返す", async () => {
      // Act
      const result = await pageGetBatchStatusHandler(null);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });
});
