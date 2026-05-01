// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.batch_analyze MCPツールのテスト
 * Batch Analyze Tool Tests (v0.4.0 T3-BATCH)
 *
 * テスト対象:
 * - Zodスキーマバリデーション (7テスト)
 * - ハンドラー統合テスト (5テスト)
 * - ツール定義の検証 (4テスト)
 * - セキュリティ (4テスト)
 *
 * SEC監査指摘: SSRF防止テスト（validateExternalUrl、プライベートIP拒否）を含む
 *
 * @module tests/tools/page/batch-analyze.tool.test
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
  // PR-D-6 Phase 2: migrate legacy `addPageAnalyzeJob` → with-guard SSOT.
  // The batch-analyze tool now imports `addPageAnalyzeJobWithGuard`.
  addPageAnalyzeJobWithGuard: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock("../../../src/services/worker-supervisor.service", () => ({
  getWorkerSupervisor: vi.fn(),
}));

vi.mock("../../../src/services/queue-cleanup.service", () => ({
  cleanupQueue: vi.fn(),
  createQueueAdapter: vi.fn(),
}));

vi.mock("../../../src/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
  normalizeUrlForValidation: vi.fn((url: string) => url),
}));

vi.mock("@reftrixmcp/core", () => ({
  isUrlAllowedByRobotsTxt: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../src/utils/mcp-response", () => ({
  generateRequestId: vi.fn(() => "test-request-id-batch-001"),
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
  addPageAnalyzeJobWithGuard,
  closeQueue,
} from "../../../src/queues/page-analyze-queue";
import { getWorkerSupervisor } from "../../../src/services/worker-supervisor.service";
import { cleanupQueue, createQueueAdapter } from "../../../src/services/queue-cleanup.service";
import { validateExternalUrl } from "../../../src/utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";

import {
  batchAnalyzeInputSchema,
  BATCH_ANALYZE_ERROR_CODES,
} from "../../../src/tools/page/batch-analyze.schemas";

import {
  pageBatchAnalyzeHandler,
  pageBatchAnalyzeToolDefinition,
} from "../../../src/tools/page/batch-analyze.tool";

// =====================================================
// Test Data
// =====================================================

const VALID_URL_1 = "https://example.com";
const VALID_URL_2 = "https://example.org";
const PRIVATE_IP_URL = "http://192.168.1.1/admin";
const METADATA_URL = "http://169.254.169.254/latest/meta-data/";
const INTERNAL_IP_URL = "http://10.0.0.1/internal";

// =====================================================
// Test Suite
// =====================================================

describe("page.batch_analyze Tool", () => {
  const mockQueue = {
    getJob: vi.fn(),
    close: vi.fn(),
  };

  const mockRedisClient = {
    get: vi.fn(),
    setex: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  };

  const mockWorkerSupervisor = {
    ensureWorkerRunning: vi.fn(),
    // PR-D-9 Wave 1 (C-11): bootstrapWorkersForPageAnalyze defaults to
    // staggered spawn; add mock to satisfy the new helper's call surface.
    // PR-D-9 Wave 1 (C-11): bootstrapWorkersForPageAnalyze はデフォルトで
    // staggered spawn を呼ぶため新 helper の call surface に合わせ mock 追加。
    ensureAllWorkersRunningStaggered: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルト: Redis利用可能、Worker稼働中
    (isRedisAvailable as Mock).mockResolvedValue(true);
    (getRedisClient as Mock).mockReturnValue(mockRedisClient);
    (createPageAnalyzeQueue as Mock).mockReturnValue(mockQueue);
    (getWorkerSupervisor as Mock).mockReturnValue(mockWorkerSupervisor);
    (cleanupQueue as Mock).mockResolvedValue({ strategy: "skipped", totalCleaned: 0 });
    (createQueueAdapter as Mock).mockReturnValue(mockQueue);

    // デフォルト: URL検証成功
    (validateExternalUrl as Mock).mockReturnValue({
      valid: true,
      normalizedUrl: VALID_URL_1,
    });

    // デフォルト: robots.txt許可
    (isUrlAllowedByRobotsTxt as Mock).mockResolvedValue({ allowed: true });

    // デフォルト: ジョブ投入成功
    // PR-D-6 Phase 2: with-guard SSOT returns `EnqueueResult` discriminated
    // union (`enqueued_new` variant for happy path). Tool reads `.jobId` and
    // `.outcome`; legacy `{ id }` shape from `Job<T>` no longer applies.
    (addPageAnalyzeJobWithGuard as Mock).mockResolvedValue({
      outcome: "enqueued_new",
      jobId: "job-001",
      collision: null,
    });

    // Redis: アクティブバッチなし
    mockRedisClient.keys.mockResolvedValue([]);
    mockRedisClient.setex.mockResolvedValue("OK");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // Schema Validation / スキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("有効な入力（urls 1件）で受け入れる", () => {
      // Arrange
      const input = { urls: [VALID_URL_1] };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.urls).toHaveLength(1);
      }
    });

    it("有効な入力（urls 50件）で受け入れる", () => {
      // Arrange
      const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/page-${i}`);
      const input = { urls };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.urls).toHaveLength(50);
      }
    });

    it("urls空配列でバリデーションエラー", () => {
      // Arrange
      const input = { urls: [] };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });

    it("urls 51件でバリデーションエラー", () => {
      // Arrange
      const urls = Array.from({ length: 51 }, (_, i) => `https://example.com/page-${i}`);
      const input = { urls };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });

    it("concurrency 0でバリデーションエラー", () => {
      // Arrange
      const input = { urls: [VALID_URL_1], concurrency: 0 };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });

    it("concurrency 6でバリデーションエラー", () => {
      // Arrange
      const input = { urls: [VALID_URL_1], concurrency: 6 };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });

    it("デフォルト値が正しく設定される（concurrency=3, on_error='skip'）", () => {
      // Arrange
      const input = { urls: [VALID_URL_1] };

      // Act
      const result = batchAnalyzeInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.concurrency).toBe(3);
        expect(result.data.on_error).toBe("skip");
        expect(result.data.respect_robots_txt).toBe(true);
      }
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
      const result = await pageBatchAnalyzeHandler({ urls: [VALID_URL_1] });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BATCH_ANALYZE_ERROR_CODES.REDIS_UNAVAILABLE);
        expect(result.error.message).toContain("Redis");
      }
    });

    it("SSRFブロック: プライベートIPを含むURLは拒否される", async () => {
      // Arrange — 全URLがSSRFブロック
      (validateExternalUrl as Mock).mockReturnValue({
        valid: false,
        error: "SSRF blocked: private IP",
      });

      // Act
      const result = await pageBatchAnalyzeHandler({ urls: [PRIVATE_IP_URL] });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BATCH_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
        expect(result.error.message).toContain("blocked");
      }
    });

    it("正常投入成功: batch_id, jobIds を含むレスポンスを返す", async () => {
      // Arrange
      // PR-D-6 Phase 2: `EnqueueResult` `enqueued_new` variant per URL.
      (addPageAnalyzeJobWithGuard as Mock)
        .mockResolvedValueOnce({ outcome: "enqueued_new", jobId: "job-001", collision: null })
        .mockResolvedValueOnce({ outcome: "enqueued_new", jobId: "job-002", collision: null });

      (validateExternalUrl as Mock)
        .mockReturnValueOnce({ valid: true, normalizedUrl: VALID_URL_1 })
        .mockReturnValueOnce({ valid: true, normalizedUrl: VALID_URL_2 });

      // Act
      const result = await pageBatchAnalyzeHandler({
        urls: [VALID_URL_1, VALID_URL_2],
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.batchId).toBeDefined();
        expect(result.data.totalUrls).toBe(2);
        expect(result.data.skippedUrls).toBe(0);
        expect(result.data.jobIds).toHaveLength(2);
        expect(result.data.message).toContain("queued");
      }

      // Worker起動が確認されたこと (PR-D-9 Wave 1: bootstrapWorkersForPageAnalyze
      // が default `ENABLE_BACKFILL_AUTOSPAWN` 未設定 → staggered spawn を呼ぶため、
      // 旧 `ensureWorkerRunning` ではなく `ensureAllWorkersRunningStaggered` が呼ばれる)
      // PR-D-9 Wave 1: bootstrap helper invokes staggered spawn by default
      // (ENABLE_BACKFILL_AUTOSPAWN unset).
      expect(mockWorkerSupervisor.ensureAllWorkersRunningStaggered).toHaveBeenCalled();
      // キューがクローズされたこと
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it("同時バッチ制限超過時にBATCH_ALREADY_RUNNINGエラーを返す", async () => {
      // Arrange — Redisに既存のアクティブバッチが存在
      mockRedisClient.keys.mockResolvedValue(["reftrix:batch:existing-batch-id"]);
      mockRedisClient.get.mockResolvedValue(
        JSON.stringify({ state: "active", jobIds: [], urls: [], skippedUrls: [] })
      );

      // Act
      const result = await pageBatchAnalyzeHandler({ urls: [VALID_URL_1] });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BATCH_ANALYZE_ERROR_CODES.BATCH_ALREADY_RUNNING);
        expect(result.error.message).toContain("concurrent");
      }
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it("ジョブ投入エラー時にINTERNAL_ERRORを返す", async () => {
      // Arrange
      (addPageAnalyzeJobWithGuard as Mock).mockRejectedValue(
        new Error("BullMQ connection timeout")
      );

      // Act
      const result = await pageBatchAnalyzeHandler({ urls: [VALID_URL_1] });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BATCH_ANALYZE_ERROR_CODES.INTERNAL_ERROR);
      }
      // エラー時もキューがクローズされること
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });
  });

  // =====================================================
  // Tool Definition / ツール定義
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が page.batch_analyze である", () => {
      expect(pageBatchAnalyzeToolDefinition.name).toBe("page.batch_analyze");
    });

    it("descriptionにBatch analyze情報が含まれる", () => {
      expect(pageBatchAnalyzeToolDefinition.description).toContain("Batch analyze");
      expect(pageBatchAnalyzeToolDefinition.description).toContain("50 URLs");
    });

    it("inputSchemaのrequiredにurlsが含まれる", () => {
      expect(pageBatchAnalyzeToolDefinition.inputSchema.required).toContain("urls");
    });

    it("annotationsが設定されている（readOnlyHint=false, openWorldHint=true）", () => {
      expect(pageBatchAnalyzeToolDefinition.annotations).toBeDefined();
      expect(pageBatchAnalyzeToolDefinition.annotations.readOnlyHint).toBe(false);
      expect(pageBatchAnalyzeToolDefinition.annotations.openWorldHint).toBe(true);
    });
  });

  // =====================================================
  // Security / セキュリティ
  // =====================================================

  describe("セキュリティ", () => {
    it("プライベートIP（192.168.x.x, 10.x.x.x, 169.254.169.254）が拒否される", async () => {
      // Arrange — 3つのプライベートIPをテスト
      const privateUrls = [PRIVATE_IP_URL, INTERNAL_IP_URL, METADATA_URL];
      (validateExternalUrl as Mock).mockReturnValue({
        valid: false,
        error: "SSRF blocked: private IP range",
      });

      // Act
      const result = await pageBatchAnalyzeHandler({ urls: privateUrls });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BATCH_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }

      // validateExternalUrlが全URLに対して呼ばれていること
      expect(validateExternalUrl).toHaveBeenCalledTimes(3);
      expect(validateExternalUrl).toHaveBeenCalledWith(PRIVATE_IP_URL);
      expect(validateExternalUrl).toHaveBeenCalledWith(INTERNAL_IP_URL);
      expect(validateExternalUrl).toHaveBeenCalledWith(METADATA_URL);
    });

    it("エラーメッセージがサニタイズされる（内部エラー漏洩なし）", async () => {
      // Arrange — BullMQ内部エラーを発生
      (addPageAnalyzeJobWithGuard as Mock).mockRejectedValue(
        new Error("INTERNAL: Redis connection at 127.0.0.1:27379 refused, AUTH failed")
      );

      // Act
      const result = await pageBatchAnalyzeHandler({ urls: [VALID_URL_1] });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        // 内部IPアドレスやポート番号が漏洩しないこと
        expect(result.error.message).not.toContain("127.0.0.1");
        expect(result.error.message).not.toContain("27379");
        expect(result.error.message).not.toContain("AUTH");
      }
    });

    it("robots.txt尊重時に拒否されたURLがskippedUrlsに含まれる", async () => {
      // Arrange
      (validateExternalUrl as Mock)
        .mockReturnValueOnce({ valid: true, normalizedUrl: VALID_URL_1 })
        .mockReturnValueOnce({ valid: true, normalizedUrl: VALID_URL_2 });

      (isUrlAllowedByRobotsTxt as Mock)
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, reason: "Disallow: /" });

      (addPageAnalyzeJobWithGuard as Mock).mockResolvedValueOnce({
        outcome: "enqueued_new",
        jobId: "job-001",
        collision: null,
      });

      // Act
      const result = await pageBatchAnalyzeHandler({
        urls: [VALID_URL_1, VALID_URL_2],
        respect_robots_txt: true,
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalUrls).toBe(1);
        expect(result.data.skippedUrls).toBe(1);
        expect(result.data.message).toContain("skipped");
      }
    });

    it("混合URL（有効+SSRF）で有効URLのみ処理される", async () => {
      // Arrange — 1つ目は有効、2つ目はSSRFブロック
      (validateExternalUrl as Mock)
        .mockReturnValueOnce({ valid: true, normalizedUrl: VALID_URL_1 })
        .mockReturnValueOnce({ valid: false, error: "SSRF blocked" });

      (addPageAnalyzeJobWithGuard as Mock).mockResolvedValueOnce({
        outcome: "enqueued_new",
        jobId: "job-001",
        collision: null,
      });

      // Act
      const result = await pageBatchAnalyzeHandler({
        urls: [VALID_URL_1, PRIVATE_IP_URL],
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalUrls).toBe(1);
        expect(result.data.skippedUrls).toBe(1);
        expect(result.data.jobIds).toHaveLength(1);
      }
    });
  });
});
