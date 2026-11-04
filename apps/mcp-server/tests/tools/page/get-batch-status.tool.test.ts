// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.getJobStatus の batch_id 経路のテスト（旧 page.getBatchStatus、2026-11-04 統合）
 * Tests for the batch_id path of page.getJobStatus (former page.getBatchStatus, merged 2026-11-04)
 *
 * テスト対象:
 * - Zodスキーマバリデーション
 * - ハンドラー統合テスト
 * - page.getJobStatus への統合（定義・入力・振り分け）
 * - セキュリティ
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

import { pageGetBatchStatusHandler } from "../../../src/tools/page/get-batch-status.tool";
import {
  INVALID_TARGET_MESSAGE,
  pageGetJobStatusHandler,
  pageGetJobStatusToolDefinition,
} from "../../../src/tools/page/get-job-status.tool";
import { pageGetJobStatusInputSchema } from "../../../src/tools/page/output.schemas";

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

describe("page.getJobStatus(batch_id) — former page.getBatchStatus", () => {
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

  describe("page.getJobStatus への統合 / merged into page.getJobStatus", () => {
    it("page.getJobStatus の inputSchema が job_id と batch_id を持ち、どちらも必須にしない", () => {
      const schema = pageGetJobStatusToolDefinition.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties).sort()).toEqual(["batch_id", "job_id"]);
      expect(schema.required ?? []).toEqual([]);
    });

    it("annotations は readOnlyHint=true, idempotentHint=true のまま", () => {
      expect(pageGetJobStatusToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(pageGetJobStatusToolDefinition.annotations.idempotentHint).toBe(true);
    });

    it("job_id と batch_id のちょうど一方だけを受理する", () => {
      const jobId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      expect(pageGetJobStatusInputSchema.safeParse({ job_id: jobId }).success).toBe(true);
      expect(pageGetJobStatusInputSchema.safeParse({ batch_id: VALID_BATCH_ID }).success).toBe(
        true
      );
      expect(pageGetJobStatusInputSchema.safeParse({}).success).toBe(false);
      expect(
        pageGetJobStatusInputSchema.safeParse({ job_id: jobId, batch_id: VALID_BATCH_ID }).success
      ).toBe(false);
    });

    it("UUID でない batch_id を拒否する（batch_id は常に uuidv7 で発行される）", () => {
      expect(pageGetJobStatusInputSchema.safeParse({ batch_id: "not-a-uuid" }).success).toBe(false);
      expect(getBatchStatusInputSchema.safeParse({ batch_id: "x".repeat(1000) }).success).toBe(
        false
      );
    });

    it.each([
      ["どちらも無い", {}],
      ["両方ある", { job_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", batch_id: VALID_BATCH_ID }],
    ])("%s入力には「どちらか一方」を示す固定文言を返す", async (_label, input) => {
      const result = await pageGetJobStatusHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toBe(INVALID_TARGET_MESSAGE);
        expect(result.error.message).toContain("job_id");
        expect(result.error.message).toContain("batch_id");
      }
    });

    it("形式が不正なときは UUID を求める固定文言を返す", async () => {
      const result = await pageGetJobStatusHandler({ batch_id: "not-a-uuid" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe(
          "Invalid input parameters: job_id and batch_id must be UUIDs"
        );
      }
    });

    it("router が注入した _request_id をバッチ経路の応答に引き継ぐ", async () => {
      (isRedisAvailable as Mock).mockResolvedValue(false);

      const result = (await pageGetJobStatusHandler({
        batch_id: VALID_BATCH_ID,
        _request_id: "router-request-id-001",
      })) as { metadata: { request_id: string } };

      expect(result.metadata.request_id).toBe("router-request-id-001");
    });

    it("batch_id を渡すとバッチ経路の結果を返す", async () => {
      (isRedisAvailable as Mock).mockResolvedValue(false);

      const result = await pageGetJobStatusHandler({ batch_id: VALID_BATCH_ID });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_BATCH_STATUS_ERROR_CODES.REDIS_UNAVAILABLE);
        expect(result.error.message).toContain("batch status");
      }
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
