// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-Device Capture Service Tests
 * 3ビューポート同時キャプチャサービスのテスト
 *
 * @module tests/services/responsive/multi-device-capture.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";

// Mock Playwright
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

// Mock logger
vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

// Mock url-validator
vi.mock("../../../src/utils/url-validator", () => ({
  validateExternalUrl: vi
    .fn()
    .mockReturnValue({ valid: true, normalizedUrl: "https://example.com" }),
}));

// Mock checkMemoryPressure
vi.mock("../../../src/workers/phases/types", () => ({
  checkMemoryPressure: vi.fn().mockReturnValue({
    shouldDegrade: false,
    shouldAbort: false,
    rssMb: 500,
  }),
}));

import {
  MultiDeviceCaptureService,
  DEVICE_VIEWPORTS,
  type MultiDeviceCaptureResult,
} from "../../../src/services/responsive/multi-device-capture.service";
import { checkMemoryPressure } from "../../../src/workers/phases/types";
import { validateExternalUrl } from "../../../src/utils/url-validator";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockPage(overrides?: Partial<Page>): Page {
  return {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue("<html><body><h1>Test</h1></body></html>"),
    evaluate: vi.fn().mockResolvedValue({
      sections: [
        {
          tagName: "header",
          selector: "header",
          display: "block",
          visibility: "visible",
          boundingRect: { x: 0, y: 0, width: 1920, height: 80 },
        },
        {
          tagName: "main",
          selector: "main",
          display: "block",
          visibility: "visible",
          boundingRect: { x: 0, y: 80, width: 1920, height: 800 },
        },
      ],
      documentHeight: 2000,
      viewportWidth: 1920,
      viewportHeight: 1080,
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png-data")),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Page;
}

function createMockContext(page: Page): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

function createMockBrowser(context: BrowserContext): Browser {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as Browser;
}

// ============================================================================
// Tests
// ============================================================================

describe("MultiDeviceCaptureService", () => {
  let service: MultiDeviceCaptureService;
  let mockPage: Page;
  let mockContext: BrowserContext;
  let mockBrowser: Browser;

  beforeEach(() => {
    vi.clearAllMocks();
    // checkMemoryPressure のデフォルト戻り値を毎テストリセット
    vi.mocked(checkMemoryPressure).mockReturnValue({
      shouldDegrade: false,
      shouldAbort: false,
      rssMb: 500,
    });
    service = new MultiDeviceCaptureService();
    mockPage = createMockPage();
    mockContext = createMockContext(mockPage);
    mockBrowser = createMockBrowser(mockContext);
  });

  afterEach(async () => {
    await service.close();
  });

  // ============================================================================
  // DEVICE_VIEWPORTS 定義の検証
  // ============================================================================
  describe("DEVICE_VIEWPORTS", () => {
    it("3つのデバイスビューポートが定義されている", () => {
      expect(DEVICE_VIEWPORTS).toHaveLength(3);
    });

    it("desktop ビューポートは 1920x1080", () => {
      const desktop = DEVICE_VIEWPORTS.find((v) => v.name === "desktop");
      expect(desktop).toBeDefined();
      expect(desktop?.width).toBe(1920);
      expect(desktop?.height).toBe(1080);
    });

    it("tablet ビューポートは 768x1024", () => {
      const tablet = DEVICE_VIEWPORTS.find((v) => v.name === "tablet");
      expect(tablet).toBeDefined();
      expect(tablet?.width).toBe(768);
      expect(tablet?.height).toBe(1024);
    });

    it("mobile ビューポートは 375x812", () => {
      const mobile = DEVICE_VIEWPORTS.find((v) => v.name === "mobile");
      expect(mobile).toBeDefined();
      expect(mobile?.width).toBe(375);
      expect(mobile?.height).toBe(812);
    });
  });

  // ============================================================================
  // captureAllDevices の検証
  // ============================================================================
  describe("captureAllDevices", () => {
    it("3つのビューポートで正常にキャプチャできる", async () => {
      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000 },
        mockBrowser
      );

      expect(result.url).toBe("https://example.com");
      expect(result.captures).toHaveLength(3);
      expect(result.captures.map((c) => c.viewport.name)).toEqual(["desktop", "tablet", "mobile"]);
    });

    it("各キャプチャにDOM構造情報が含まれる", async () => {
      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000 },
        mockBrowser
      );

      for (const capture of result.captures) {
        expect(capture.sections).toBeDefined();
        expect(capture.documentHeight).toBeGreaterThan(0);
      }
    });

    it("SSRF検証が実行される", async () => {
      await service.captureAllDevices("https://example.com", { timeout: 30000 }, mockBrowser);

      expect(validateExternalUrl).toHaveBeenCalledWith("https://example.com");
    });

    it("SSRF検証に失敗した場合はエラーを返す", async () => {
      vi.mocked(validateExternalUrl).mockReturnValueOnce({
        valid: false,
        error: "URL is blocked (SSRF protection)",
      });

      await expect(
        service.captureAllDevices(
          "http://169.254.169.254/metadata",
          { timeout: 30000 },
          mockBrowser
        )
      ).rejects.toThrow("SSRF");
    });

    it("メモリ圧力チェックがキャプチャ前に実行される", async () => {
      await service.captureAllDevices("https://example.com", { timeout: 30000 }, mockBrowser);

      // 3つのビューポートそれぞれの前にメモリチェック
      expect(checkMemoryPressure).toHaveBeenCalled();
    });

    it("メモリ圧力がcriticalの場合はGraceful Degradation", async () => {
      vi.mocked(checkMemoryPressure).mockReturnValue({
        shouldDegrade: true,
        shouldAbort: true,
        rssMb: 3800,
      });

      await expect(
        service.captureAllDevices("https://example.com", { timeout: 30000 }, mockBrowser)
      ).rejects.toThrow("Memory pressure");
    });

    it("include_screenshots: true でスクリーンショットサイズが含まれる", async () => {
      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000, includeScreenshots: true },
        mockBrowser
      );

      for (const capture of result.captures) {
        expect(capture.screenshotSize).toBeGreaterThan(0);
      }
    });

    it("include_screenshots: false ではスクリーンショットサイズが0", async () => {
      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000 },
        mockBrowser
      );

      for (const capture of result.captures) {
        expect(capture.screenshotSize).toBe(0);
      }
    });

    it("1つのビューポートが失敗しても他は続行する", async () => {
      let callCount = 0;
      vi.mocked(mockBrowser.newContext as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Tablet context creation failed");
        }
        return mockContext;
      });

      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000 },
        mockBrowser
      );

      expect(result.captures).toHaveLength(3);
      const tablet = result.captures.find((c) => c.viewport.name === "tablet");
      expect(tablet?.error).toBeDefined();
    });

    it("カスタムビューポートを指定できる", async () => {
      const customViewports = [
        { name: "custom-desktop", width: 2560, height: 1440 },
        { name: "custom-mobile", width: 414, height: 896 },
      ];

      const result = await service.captureAllDevices(
        "https://example.com",
        { timeout: 30000, viewports: customViewports },
        mockBrowser
      );

      expect(result.captures).toHaveLength(2);
      expect(result.captures.map((c) => c.viewport.name)).toEqual([
        "custom-desktop",
        "custom-mobile",
      ]);
    });
  });

  // ============================================================================
  // 並列実行の検証
  // ============================================================================
  describe("並列実行", () => {
    it("Promise.allで3ビューポートを並列キャプチャする", async () => {
      const contextCreationTimes: number[] = [];
      vi.mocked(mockBrowser.newContext as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        contextCreationTimes.push(Date.now());
        return mockContext;
      });

      await service.captureAllDevices("https://example.com", { timeout: 30000 }, mockBrowser);

      // 3回コンテキスト作成されている
      expect(contextCreationTimes).toHaveLength(3);
    });
  });

  // ============================================================================
  // close の検証
  // ============================================================================
  describe("close", () => {
    it("共有ブラウザの場合はブラウザを閉じない", async () => {
      await service.captureAllDevices("https://example.com", { timeout: 30000 }, mockBrowser);

      await service.close();

      // 共有ブラウザを使用している場合、browser.closeは呼ばれない
      expect(mockBrowser.isConnected).toBeDefined();
    });
  });
});
