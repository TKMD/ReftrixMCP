// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.capture MCPツール テスト
 * 3ビューポート同時キャプチャ+レスポンシブ差分分析ツールのテスト
 *
 * @module tests/tools/responsive-capture.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

// Mock url-validator
vi.mock("../../src/utils/url-validator", () => ({
  validateExternalUrl: vi
    .fn()
    .mockReturnValue({ valid: true, normalizedUrl: "https://example.com" }),
}));

// Mock checkMemoryPressure
vi.mock("../../src/workers/phases/types", () => ({
  checkMemoryPressure: vi.fn().mockReturnValue({
    shouldDegrade: false,
    shouldAbort: false,
    rssMb: 500,
  }),
}));

// Mock SharedBrowserManager
vi.mock("../../src/services/responsive/shared-browser-manager", () => ({
  SharedBrowserManager: vi.fn().mockImplementation(() => ({
    resolveOrLaunch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          setDefaultTimeout: vi.fn(),
          goto: vi.fn().mockResolvedValue(undefined),
          content: vi.fn().mockResolvedValue("<html></html>"),
          evaluate: vi.fn().mockResolvedValue({
            sections: [],
            documentHeight: 1000,
            viewportWidth: 1920,
            viewportHeight: 1080,
          }),
          screenshot: vi.fn().mockResolvedValue(Buffer.alloc(100)),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      isConnected: vi.fn().mockReturnValue(true),
    }),
    close: vi.fn().mockResolvedValue(undefined),
    isUsingSharedBrowser: false,
  })),
  USER_AGENTS: {
    MOBILE: "Mozilla/5.0 (iPhone)",
    DESKTOP: "Mozilla/5.0 (Windows NT 10.0)",
  },
}));

import {
  responsiveCaptureHandler,
  responsiveCaptureToolDefinition,
  setResponsiveCaptureServiceFactory,
  resetResponsiveCaptureServiceFactory,
  RESPONSIVE_CAPTURE_ERROR_CODES,
  type ResponsiveCaptureOutput,
} from "../../src/tools/responsive/capture.tool";

// ============================================================================
// Tests
// ============================================================================

describe("responsive.capture MCPツール", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetResponsiveCaptureServiceFactory();
  });

  afterEach(() => {
    resetResponsiveCaptureServiceFactory();
  });

  // ============================================================================
  // ツール定義の検証
  // ============================================================================
  describe("ツール定義", () => {
    it("ツール名が 'responsive.capture' である", () => {
      expect(responsiveCaptureToolDefinition.name).toBe("responsive.capture");
    });

    it("descriptionが定義されている", () => {
      expect(responsiveCaptureToolDefinition.description).toBeDefined();
      expect(responsiveCaptureToolDefinition.description.length).toBeGreaterThan(0);
    });

    it("inputSchemaがobject型である", () => {
      expect(responsiveCaptureToolDefinition.inputSchema.type).toBe("object");
    });

    it("urlが必須パラメータである", () => {
      expect(responsiveCaptureToolDefinition.inputSchema.required).toContain("url");
    });

    it("annotationsが定義されている", () => {
      expect(responsiveCaptureToolDefinition.annotations).toBeDefined();
    });
  });

  // ============================================================================
  // 入力バリデーションの検証
  // ============================================================================
  describe("入力バリデーション", () => {
    it("urlが未指定の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({})) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_CAPTURE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("urlが空文字の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({ url: "" })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_CAPTURE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("urlが不正な形式の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({
        url: "not-a-url",
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_CAPTURE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("viewportsが4つ以上の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
        viewports: [
          { name: "a", width: 100, height: 100 },
          { name: "b", width: 200, height: 200 },
          { name: "c", width: 300, height: 300 },
          { name: "d", width: 400, height: 400 },
          { name: "e", width: 500, height: 500 },
        ],
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_CAPTURE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("viewport width が 0 以下の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
        viewports: [{ name: "invalid", width: 0, height: 100 }],
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
    });

    it("viewport height が 0 以下の場合はバリデーションエラー", async () => {
      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
        viewports: [{ name: "invalid", width: 100, height: 0 }],
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // サービスファクトリーの検証
  // ============================================================================
  describe("サービスファクトリー", () => {
    it("サービスファクトリー未設定時はエラーを返す", async () => {
      resetResponsiveCaptureServiceFactory();

      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_CAPTURE_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it("サービスファクトリー設定後は正常に実行できる", async () => {
      const mockService = {
        captureAllDevices: vi.fn().mockResolvedValue({
          url: "https://example.com",
          captures: [
            {
              viewport: { name: "desktop", width: 1920, height: 1080 },
              sections: [],
              documentHeight: 1000,
              viewportWidth: 1920,
              viewportHeight: 1080,
              screenshotSize: 0,
            },
            {
              viewport: { name: "tablet", width: 768, height: 1024 },
              sections: [],
              documentHeight: 1200,
              viewportWidth: 768,
              viewportHeight: 1024,
              screenshotSize: 0,
            },
            {
              viewport: { name: "mobile", width: 375, height: 812 },
              sections: [],
              documentHeight: 1500,
              viewportWidth: 375,
              viewportHeight: 812,
              screenshotSize: 0,
            },
          ],
          captureTimeMs: 3000,
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDiffService = {
        computeDiff: vi.fn().mockReturnValue({
          score: 75,
          changes: [
            {
              element: "aside",
              type: "visibility",
              description: "Hidden on mobile",
              details: { desktop: "visible", mobile: "hidden" },
            },
          ],
        }),
      };

      setResponsiveCaptureServiceFactory(
        () => mockService as never,
        () => mockDiffService as never
      );

      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe("https://example.com");
        expect(result.data.captures).toHaveLength(3);
        expect(result.data.diff.score).toBe(75);
        expect(result.data.diff.changes).toHaveLength(1);
      }
    });
  });

  // ============================================================================
  // エラーメッセージサニタイズの検証
  // ============================================================================
  describe("エラーメッセージサニタイズ", () => {
    it("内部エラーはサニタイズされる", async () => {
      const mockService = {
        captureAllDevices: vi
          .fn()
          .mockRejectedValue(
            new Error("Prisma query failed: P2002 on section_patterns.unique_constraint")
          ),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDiffService = {
        computeDiff: vi.fn(),
      };

      setResponsiveCaptureServiceFactory(
        () => mockService as never,
        () => mockDiffService as never
      );

      const result = (await responsiveCaptureHandler({
        url: "https://example.com",
      })) as ResponsiveCaptureOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        // 内部構造が漏洩していないことを確認
        expect(result.error.message).not.toContain("Prisma");
        expect(result.error.message).not.toContain("section_patterns");
      }
    });
  });
});
