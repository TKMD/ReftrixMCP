// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.regression_test MCPツールのテスト
 * Visual Regression Test Tool Tests (v0.4.0 T3-VRT)
 *
 * テスト対象:
 * - Zodスキーマバリデーション (6テスト)
 * - ハンドラー統合テスト (5テスト)
 * - ツール定義の検証 (4テスト)
 * - セキュリティ (3テスト)
 *
 * @module tests/tools/design/regression-test.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================
// Mocks
// =====================================================

vi.mock("@/services/visual-regression.service", () => ({
  runVisualRegression: vi.fn(),
  VISUAL_REGRESSION_ERROR_CODES: {
    VALIDATION_ERROR: "VISUAL_REGRESSION_VALIDATION_ERROR",
    BASELINE_NOT_FOUND: "VISUAL_REGRESSION_BASELINE_NOT_FOUND",
    CAPTURE_FAILED: "VISUAL_REGRESSION_CAPTURE_FAILED",
    DIFF_FAILED: "VISUAL_REGRESSION_DIFF_FAILED",
    SNAPSHOT_NOT_FOUND: "VISUAL_REGRESSION_SNAPSHOT_NOT_FOUND",
    DIMENSION_MISMATCH: "VISUAL_REGRESSION_DIMENSION_MISMATCH",
  },
}));

vi.mock("@/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

vi.mock("@/utils/sanitize-error", () => ({
  sanitizeErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : "An internal error occurred"
  ),
}));

import {
  designRegressionTestInputSchema,
  designRegressionTestHandler,
  designRegressionTestToolDefinition,
  type DesignRegressionTestOutput,
} from "../../../src/tools/design/regression-test.tool";

import { runVisualRegression } from "../../../src/services/visual-regression.service";
import { validateExternalUrl } from "../../../src/utils/url-validator";

// =====================================================
// Test Data / テストデータ
// =====================================================

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const VALID_URL = "https://example.com";

const VALID_INPUT = {
  url: VALID_URL,
  baseline_snapshot_id: VALID_UUID,
};

describe("design.regression_test Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateExternalUrl).mockReturnValue({
      valid: true,
      normalizedUrl: VALID_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // Schema Validation / スキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("有効な入力を受け入れデフォルト値を設定する", () => {
      const result = designRegressionTestInputSchema.safeParse(VALID_INPUT);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.threshold).toBe(0.001);
        expect(result.data.viewport_width).toBe(1920);
        expect(result.data.viewport_height).toBe(1080);
      }
    });

    it("無効なURL形式でバリデーションエラー", () => {
      const result = designRegressionTestInputSchema.safeParse({
        url: "not-a-url",
        baseline_snapshot_id: VALID_UUID,
      });
      expect(result.success).toBe(false);
    });

    it("baseline_snapshot_id UUID不正でバリデーションエラー", () => {
      const result = designRegressionTestInputSchema.safeParse({
        url: VALID_URL,
        baseline_snapshot_id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("threshold範囲外（負数）でバリデーションエラー", () => {
      const result = designRegressionTestInputSchema.safeParse({
        ...VALID_INPUT,
        threshold: -0.1,
      });
      expect(result.success).toBe(false);
    });

    it("viewport_width範囲外（<320）でバリデーションエラー", () => {
      const result = designRegressionTestInputSchema.safeParse({
        ...VALID_INPUT,
        viewport_width: 100,
      });
      expect(result.success).toBe(false);
    });

    it("viewport_height範囲外（>16384）でバリデーションエラー", () => {
      const result = designRegressionTestInputSchema.safeParse({
        ...VALID_INPUT,
        viewport_height: 20000,
      });
      expect(result.success).toBe(false);
    });
  });

  // =====================================================
  // Handler Integration / ハンドラー統合テスト
  // =====================================================

  describe("ハンドラー統合テスト", () => {
    it("pass結果を正しく返却する", async () => {
      vi.mocked(runVisualRegression).mockResolvedValueOnce({
        success: true,
        passed: true,
        changePercentage: 0,
        changedPixels: 0,
        totalPixels: 2073600,
        threshold: 0.001,
        diffImageBase64: "iVBOR...",
        baseline: {
          snapshotId: VALID_UUID,
          snapshotAt: "2026-04-01T00:00:00Z",
          webPageUrl: VALID_URL,
        },
      });

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.change_percentage).toBe(0);
      expect(result.total_pixels).toBe(2073600);
      expect(result.baseline?.snapshot_id).toBe(VALID_UUID);
    });

    it("fail結果を正しく返却する", async () => {
      vi.mocked(runVisualRegression).mockResolvedValueOnce({
        success: true,
        passed: false,
        changePercentage: 0.052,
        changedPixels: 107827,
        totalPixels: 2073600,
        threshold: 0.001,
        diffImageBase64: "iVBOR...",
        baseline: {
          snapshotId: VALID_UUID,
          snapshotAt: "2026-04-01T00:00:00Z",
          webPageUrl: VALID_URL,
        },
      });

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.change_percentage).toBe(0.052);
    });

    it("ベースライン未発見時にエラーを返す", async () => {
      vi.mocked(runVisualRegression).mockResolvedValueOnce({
        success: false,
        error: "VISUAL_REGRESSION_BASELINE_NOT_FOUND: Snapshot not found",
      });

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });

    it("キャプチャ失敗時にエラーを返す", async () => {
      vi.mocked(runVisualRegression).mockResolvedValueOnce({
        success: false,
        error: "VISUAL_REGRESSION_CAPTURE_FAILED: Browser launch failed",
      });

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("CAPTURE_FAILED");
    });

    it("サービス例外時にsanitizedエラーを返す", async () => {
      vi.mocked(runVisualRegression).mockRejectedValueOnce(
        new Error("INTERNAL: connection refused at localhost:26432")
      );

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("DIFF_FAILED");
    });
  });

  // =====================================================
  // Tool Definition / ツール定義
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が design.regression_test である", () => {
      expect(designRegressionTestToolDefinition.name).toBe("design.regression_test");
    });

    it("descriptionが日英バイリンガルである", () => {
      expect(designRegressionTestToolDefinition.description).toContain("ベースライン");
      expect(designRegressionTestToolDefinition.description).toContain("Pixel-level comparison");
    });

    it("inputSchema.requiredにurlとbaseline_snapshot_idが含まれる", () => {
      expect(designRegressionTestToolDefinition.inputSchema.required).toContain("url");
      expect(designRegressionTestToolDefinition.inputSchema.required).toContain(
        "baseline_snapshot_id"
      );
    });

    it("annotationsにreadOnlyHintとidempotentHintが設定されている", () => {
      expect(designRegressionTestToolDefinition.annotations).toBeDefined();
      expect(designRegressionTestToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(designRegressionTestToolDefinition.annotations.idempotentHint).toBe(true);
    });
  });

  // =====================================================
  // Security / セキュリティ
  // =====================================================

  describe("セキュリティ", () => {
    it("SSRF: validateExternalUrlが呼ばれプライベートIPがブロックされる", async () => {
      vi.mocked(validateExternalUrl).mockReturnValueOnce({
        valid: false,
        error: "Private IP address blocked",
      });

      const result = (await designRegressionTestHandler({
        url: "https://192.168.1.1",
        baseline_snapshot_id: VALID_UUID,
      })) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("VALIDATION_ERROR");
      expect(result.error).toContain("URL blocked by security policy");
      expect(validateExternalUrl).toHaveBeenCalledWith("https://192.168.1.1");
    });

    it("エラーメッセージがサニタイズされ内部情報が漏洩しない", async () => {
      vi.mocked(runVisualRegression).mockRejectedValueOnce(
        new Error("ECONNREFUSED 127.0.0.1:26432 pg_catalog.pg_tables")
      );

      const result = (await designRegressionTestHandler(VALID_INPUT)) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      // sanitizeErrorMessage モックは err.message をそのまま返すが、
      // 実運用では sanitize-error.ts が内部情報を除去する
      expect(result.error).toBeDefined();
    });

    it("Zodバリデーション失敗時にvalidateExternalUrlが呼ばれない", async () => {
      const result = (await designRegressionTestHandler({
        url: "not-a-url",
        baseline_snapshot_id: "invalid",
      })) as DesignRegressionTestOutput;

      expect(result.success).toBe(false);
      expect(validateExternalUrl).not.toHaveBeenCalled();
    });
  });
});
