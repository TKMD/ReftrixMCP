// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionScreenshotFallbackService Unit Tests (TDD Green Phase)
 *
 * Section Visual Embedding の screenshotBase64 高さ制約を解消するための
 * フォールバックスクリーンショットキャプチャサービスのユニットテスト。
 *
 * Unit tests for the fallback screenshot capture service that resolves
 * screenshotBase64 height limitations for Section Visual Embedding.
 *
 * テストケース:
 *   1. sharedBrowser接続済み: コンテキスト作成->ナビゲーション->scrollTo->clip screenshot->Buffer返却
 *   2. sharedBrowser切断済み: 独自Chromium起動->同上->browser.close()
 *   3. SSRF拒否: プライベートIP URL で emptyResult 返却
 *   4. メモリ圧迫時停止: shouldDegrade true でスキップ
 *   5. ナビゲーションタイムアウト: 30秒超でGraceful Degradation (emptyResult返却)
 *   6. セクション上限超過: maxSectionsで制限（slice）
 *   7. 累積タイムアウト: timeoutMs超で残セクションスキップ
 *   8. 空セクション配列: 空結果を返却
 *   9. セクション高さ < MIN_SECTION_HEIGHT_PX(10px): スキップ
 *  10. 正常系（複数セクション）: 複数セクションの個別キャプチャが正しく返却される
 *
 * @module tests/services/part/section-screenshot-fallback.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Browser, BrowserContext, Page } from "playwright";

// ============================================================================
// Mocks / モック設定
// ============================================================================

// logger モック / Logger mock
vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import { logger } from "../../../src/utils/logger";

// url-validator モック / URL validator mock
vi.mock("../../../src/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
}));

import { validateExternalUrl } from "../../../src/utils/url-validator";
const mockValidateExternalUrl = vi.mocked(validateExternalUrl);

// sharp モック / Sharp mock
// vi.mock のファクトリは hoisted されるため、内部で完結する必要がある
// vi.mock factory is hoisted so it must be self-contained
vi.mock("sharp", () => {
  const composite = vi.fn().mockReturnThis();
  const png = vi.fn().mockReturnThis();
  const toBuffer = vi.fn().mockResolvedValue(Buffer.from("stitched-png", "utf-8"));
  const metadata = vi.fn().mockResolvedValue({ width: 1920, height: 500 });
  const instance = { composite, png, toBuffer, metadata };
  const sharpFn = vi.fn().mockReturnValue(instance);
  return { default: sharpFn };
});

import sharp from "sharp";
const mockSharp = vi.mocked(sharp);

// テストから sharp mock の内部メソッドにアクセスするヘルパー
// Helper to access sharp mock internals from tests
function getSharpMockInstance(): {
  composite: ReturnType<typeof vi.fn>;
  png: ReturnType<typeof vi.fn>;
  toBuffer: ReturnType<typeof vi.fn>;
  metadata: ReturnType<typeof vi.fn>;
} {
  // mockSharp() は常に同一の mockInstance を返す
  // mockSharp() always returns the same mock instance
  return mockSharp() as unknown as {
    composite: ReturnType<typeof vi.fn>;
    png: ReturnType<typeof vi.fn>;
    toBuffer: ReturnType<typeof vi.fn>;
    metadata: ReturnType<typeof vi.fn>;
  };
}

// playwright モック / Playwright mock
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

import { chromium } from "playwright";
const mockChromiumLaunch = vi.mocked(chromium.launch);

// @reftrixmcp/core モック (robots.txt 再評価分岐 LCC-IMPL-B-L-01 検証用)
// 他の core export (ROBOTS_TXT.USER_AGENT 等) は importActual で保持。
// @reftrixmcp/core mock (for the LCC-IMPL-B-L-01 robots.txt re-evaluation branch).
// Other core exports (e.g. ROBOTS_TXT.USER_AGENT) are preserved via importActual.
vi.mock("@reftrixmcp/core", async (importActual) => {
  const actual = await importActual<typeof import("@reftrixmcp/core")>();
  return {
    ...actual,
    isUrlAllowedByRobotsTxt: vi.fn(),
  };
});

import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
const mockIsUrlAllowedByRobotsTxt = vi.mocked(isUrlAllowedByRobotsTxt);

// ============================================================================
// Import module under test (after mock setup)
// テスト対象のインポート（モック設定後）
// ============================================================================

import { captureSectionScreenshots } from "../../../src/services/part/section-screenshot-fallback.service";

// ============================================================================
// Test Data / テストデータ
// ============================================================================

const MOCK_URL = "https://example.com/design";
const MOCK_SECTION_ID_1 = "aaaa1111-1111-7111-1111-111111111111";
const MOCK_SECTION_ID_2 = "bbbb2222-2222-7222-2222-222222222222";
const MOCK_SECTION_ID_3 = "cccc3333-3333-7333-3333-333333333333";

// ============================================================================
// Mock Factories / モックファクトリー
// ============================================================================

/** テスト用のscreenshotバッファを生成 / Generate a test screenshot buffer */
function createMockScreenshotBuffer(): Buffer {
  return Buffer.from("mock-screenshot-png-data", "utf-8");
}

function createMockPage(overrides?: {
  goto?: ReturnType<typeof vi.fn>;
  evaluate?: ReturnType<typeof vi.fn>;
  screenshot?: ReturnType<typeof vi.fn>;
  waitForTimeout?: ReturnType<typeof vi.fn>;
  waitForLoadState?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}): Page {
  // デフォルト evaluate: scrollTo(void)→undefined, scrollY→最後のscrollTo値 を返す
  // Default evaluate: returns undefined for scrollTo(void), last scrollTo value for scrollY
  let lastScrollY = 0;
  const defaultEvaluate = vi
    .fn()
    .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      // scrollTo は引数あり（第2引数=scrollY値）、window.scrollY は引数なし
      // scrollTo has args (2nd arg = scrollY value), window.scrollY has no args
      if (args.length > 0) {
        // scrollTo: 記録して void を返す / Record scroll position and return void
        lastScrollY = typeof args[0] === "number" ? args[0] : 0;
        return Promise.resolve(undefined);
      }
      // window.scrollY: 最後の scrollTo 値を返す / Return last scrollTo value
      return Promise.resolve(lastScrollY);
    });
  return {
    goto: overrides?.goto ?? vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: overrides?.evaluate ?? defaultEvaluate,
    screenshot: overrides?.screenshot ?? vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
    waitForTimeout: overrides?.waitForTimeout ?? vi.fn().mockResolvedValue(undefined),
    waitForLoadState: overrides?.waitForLoadState ?? vi.fn().mockResolvedValue(undefined),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function createMockContext(
  page: Page,
  overrides?: {
    close?: ReturnType<typeof vi.fn>;
  }
): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

function createMockBrowser(
  context: BrowserContext,
  overrides?: {
    close?: ReturnType<typeof vi.fn>;
    isConnected?: ReturnType<typeof vi.fn>;
  }
): Browser {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
    isConnected: overrides?.isConnected ?? vi.fn().mockReturnValue(true),
  } as unknown as Browser;
}

// ============================================================================
// Tests
// ============================================================================

describe("SectionScreenshotFallbackService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトでURL検証を通過 / Default: pass URL validation
    mockValidateExternalUrl.mockReturnValue({ valid: true, normalizedUrl: MOCK_URL });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. sharedBrowser接続済み: コンテキスト作成->ナビゲーション->clip screenshot
  // ==========================================================================
  describe("sharedBrowser接続済み / Connected shared browser", () => {
    it("sharedBrowserが接続済みの場合、新しいブラウザを起動せずにスクリーンショットを取得する", async () => {
      // Arrange
      const mockScreenshotBuf = createMockScreenshotBuffer();
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(mockScreenshotBuf),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext, {
        isConnected: vi.fn().mockReturnValue(true),
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        sharedBrowser: mockBrowser,
      });

      // Assert
      expect(result.results).toHaveLength(1);
      expect(result.results[0].sectionId).toBe(MOCK_SECTION_ID_1);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      expect(result.results[0].skipped).toBe(false);
      expect(result.capturedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
    });

    it("sharedBrowser経由でpage.screenshotをclipオプション付きで呼び出す", async () => {
      // Arrange
      const mockScreenshotFn = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      const mockPage = createMockPage({ screenshot: mockScreenshotFn });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext, {
        isConnected: vi.fn().mockReturnValue(true),
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 1500, height: 400 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        sharedBrowser: mockBrowser,
      });

      // Assert
      expect(mockScreenshotFn).toHaveBeenCalledWith(
        expect.objectContaining({
          fullPage: false,
          type: "png",
          clip: expect.objectContaining({
            x: 0,
            width: 1920, // DEFAULT_VIEWPORT_WIDTH (unified with ingest)
          }),
        })
      );
    });
  });

  // ==========================================================================
  // 2. sharedBrowser切断済み: 独自Chromium起動
  // ==========================================================================
  describe("sharedBrowser切断済み / Disconnected shared browser", () => {
    it("sharedBrowserが切断済みの場合、独自Chromiumを起動する", async () => {
      // Arrange
      const disconnectedBrowser = createMockBrowser(createMockContext(createMockPage()), {
        isConnected: vi.fn().mockReturnValue(false),
      });

      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newContext = createMockContext(newPage);
      const browserClose = vi.fn().mockResolvedValue(undefined);
      const newBrowser = createMockBrowser(newContext, { close: browserClose });
      mockChromiumLaunch.mockResolvedValue(newBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 3000, height: 500 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        sharedBrowser: disconnectedBrowser,
      });

      // Assert
      expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      expect(browserClose).toHaveBeenCalledTimes(1); // 独自起動ブラウザは閉じる
    });

    it("sharedBrowserが未指定の場合も独自Chromiumを起動する", async () => {
      // Arrange
      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newContext = createMockContext(newPage);
      const newBrowser = createMockBrowser(newContext);
      mockChromiumLaunch.mockResolvedValue(newBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        // sharedBrowser 未指定
      });

      // Assert
      expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
    });
  });

  // ==========================================================================
  // 3. SSRF拒否: プライベートIP URL
  // ==========================================================================
  describe("SSRF拒否 / SSRF rejection", () => {
    it("プライベートIP URLでemptyResult返却（全セクションなし）", async () => {
      // Arrange
      mockValidateExternalUrl.mockReturnValue({
        valid: false,
        error: "Private IP address blocked",
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: "http://192.168.1.1/admin",
        sections,
      });

      // Assert - 実装はSSRF失敗時に emptyResult を返す
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("SSRF"),
        expect.objectContaining({ error: "Private IP address blocked" })
      );
    });

    it("メタデータサービスURL (169.254.169.254) でemptyResult返却", async () => {
      // Arrange
      mockValidateExternalUrl.mockReturnValue({
        valid: false,
        error: "Metadata service blocked",
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 800 }];

      // Act
      const result = await captureSectionScreenshots({
        url: "http://169.254.169.254/latest/meta-data/",
        sections,
      });

      // Assert
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 3b. robots.txt 再評価分岐 (LCC-IMPL-B-L-01)
  //     genuine Disallow (reason==="disallowed") のみ terminal、
  //     transient fetch_error は capture 続行 (非 terminal)。
  //     LCC-IMPL-B-L-01: only genuine Disallow terminalizes; a transient
  //     fetch_error proceeds with the capture (non-terminal).
  // ==========================================================================
  describe("robots.txt 再評価分岐 / robots.txt re-evaluation branch (LCC-IMPL-B-L-01)", () => {
    it('genuine Disallow (reason="disallowed") の場合のみ robotsDisallowed:true で terminal 化し capture を起動しない', async () => {
      // Arrange: robots が genuine Disallow を value で返す
      mockIsUrlAllowedByRobotsTxt.mockResolvedValue({
        allowed: false,
        domain: "https://example.com",
        cached: false,
        reason: "disallowed",
      });
      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        recheckRobotsTxt: true,
      });

      // Assert: terminal (robotsDisallowed:true)、capture 未起動
      expect(result.robotsDisallowed).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
      expect(mockIsUrlAllowedByRobotsTxt).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Disallow"),
        expect.objectContaining({ reason: "disallowed" })
      );
    });

    it('transient fetch_error (reason="fetch_error", value-return) の場合は terminal 化せず capture を続行する', async () => {
      // Arrange: robots が fetch_error を **値** で返す (throw ではない)
      // = isUrlAllowedByRobotsTxt の実契約 (robots-txt.service.ts:438-444)。
      mockIsUrlAllowedByRobotsTxt.mockResolvedValue({
        allowed: false,
        domain: "https://example.com",
        cached: false,
        reason: "fetch_error",
      });
      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newContext = createMockContext(newPage);
      const newBrowser = createMockBrowser(newContext);
      mockChromiumLaunch.mockResolvedValue(newBrowser);
      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        recheckRobotsTxt: true,
      });

      // Assert: NON-terminal (robotsDisallowed:false)、capture 続行 (browser launch + 1件捕捉)
      expect(result.robotsDisallowed).toBe(false);
      expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      expect(result.capturedCount).toBe(1);
      // fetch_error は proceed ログを出す (terminal Disallow ログではない)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("fetch_error"),
        expect.objectContaining({ reason: "fetch_error" })
      );
    });

    it('robots が allowed (reason="allowed") の場合は capture を続行する', async () => {
      // Arrange
      mockIsUrlAllowedByRobotsTxt.mockResolvedValue({
        allowed: true,
        domain: "https://example.com",
        cached: false,
        reason: "allowed",
      });
      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newBrowser = createMockBrowser(createMockContext(newPage));
      mockChromiumLaunch.mockResolvedValue(newBrowser);
      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        recheckRobotsTxt: true,
      });

      // Assert: 続行 (非 terminal)
      expect(result.robotsDisallowed).toBe(false);
      expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
      expect(result.capturedCount).toBe(1);
    });

    it("recheckRobotsTxt 未指定 (既定 false) の場合は robots 再評価をスキップする", async () => {
      // Arrange
      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newBrowser = createMockBrowser(createMockContext(newPage));
      mockChromiumLaunch.mockResolvedValue(newBrowser);
      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        // recheckRobotsTxt 未指定
      });

      // Assert: robots 未評価、capture 続行
      expect(mockIsUrlAllowedByRobotsTxt).not.toHaveBeenCalled();
      expect(result.robotsDisallowed).toBe(false);
      expect(result.capturedCount).toBe(1);
    });

    it("isUrlAllowedByRobotsTxt が genuine exception を throw した場合は capture を続行する (catch fallback)", async () => {
      // Arrange: 値 return ではなく **例外** (programming error / URL parse 失敗等)
      mockIsUrlAllowedByRobotsTxt.mockRejectedValue(new Error("unexpected robots failure"));
      const newPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const newBrowser = createMockBrowser(createMockContext(newPage));
      mockChromiumLaunch.mockResolvedValue(newBrowser);
      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        recheckRobotsTxt: true,
      });

      // Assert: catch fallback で続行 (非 terminal)
      expect(result.robotsDisallowed).toBe(false);
      expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
      expect(result.capturedCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("threw"),
        expect.objectContaining({ error: expect.stringContaining("unexpected robots failure") })
      );
    });
  });

  // ==========================================================================
  // 4. メモリ圧迫時停止
  // ==========================================================================
  describe("メモリ圧迫時停止 / Memory pressure abort", () => {
    it("shouldDegrade=trueの場合、セクションをスキップする", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const checkMemoryPressure = vi.fn().mockReturnValue({
        shouldDegrade: true,
        shouldAbort: false,
        rssMb: 4096,
      });

      const sections = [
        { id: MOCK_SECTION_ID_1, startY: 2000, height: 600 },
        { id: MOCK_SECTION_ID_2, startY: 3000, height: 400 },
      ];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        checkMemoryPressure,
      });

      // Assert
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.skipped)).toBe(true);
      expect(result.results.every((r) => r.screenshotBuffer === null)).toBe(true);
      expect(result.results[0].skipReason).toContain("memory");
    });

    it("shouldAbort=trueの場合も全セクションをスキップする", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const checkMemoryPressure = vi.fn().mockReturnValue({
        shouldDegrade: false,
        shouldAbort: true,
        rssMb: 6144,
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        checkMemoryPressure,
      });

      // Assert
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toContain("memory");
    });
  });

  // ==========================================================================
  // 5. ナビゲーションタイムアウト
  // ==========================================================================
  describe("ナビゲーションタイムアウト / Navigation timeout", () => {
    it("page.goto()がタイムアウトした場合、emptyResult返却 + Graceful Degradation", async () => {
      // Arrange
      const mockPage = createMockPage({
        goto: vi.fn().mockRejectedValue(new Error("Navigation timeout exceeded 30000ms")),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert - 全体がcatchされてemptyResultが返る
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      // logger.warn がGraceful Degradationメッセージで呼ばれること
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("failed (non-fatal)"),
        expect.objectContaining({
          error: expect.stringContaining("timeout"),
        })
      );
    });

    it("HTTP 4xx/5xxステータスの場合もemptyResult返却", async () => {
      // Arrange
      const mockPage = createMockPage({
        goto: vi.fn().mockResolvedValue({ status: () => 503 }),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert - HTTP error -> emptyResult
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("HTTP error"),
        expect.objectContaining({ status: 503 })
      );
    });
  });

  // ==========================================================================
  // 6. セクション上限超過: maxSections
  // ==========================================================================
  describe("セクション上限超過 / Section limit exceeded", () => {
    it("maxSectionsを超えるセクションはsliceで切り捨てられる", async () => {
      // Arrange
      const sections = Array.from({ length: 55 }, (_, i) => ({
        id: `sect-${String(i).padStart(4, "0")}-0000-7000-0000-000000000000`,
        startY: i * 300,
        height: 200,
      }));

      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      // Act - 実装は sections.slice(0, maxSections) で処理する
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        maxSections: 50,
      });

      // Assert - 結果は最大50件（超過分は結果に含まれない）
      expect(result.results.length).toBeLessThanOrEqual(50);
      // 処理されたセクション = capturedCount + skippedCount
      expect(result.capturedCount + result.skippedCount).toBeLessThanOrEqual(50);
    });
  });

  // ==========================================================================
  // 7. 累積タイムアウト: timeoutMs超で残セクションスキップ
  // ==========================================================================
  describe("累積タイムアウト / Cumulative timeout", () => {
    it("累積処理時間がtimeoutMsを超えると残りのセクションをスキップする", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [
        { id: MOCK_SECTION_ID_1, startY: 2000, height: 600 },
        { id: MOCK_SECTION_ID_2, startY: 5000, height: 400 },
        { id: MOCK_SECTION_ID_3, startY: 8000, height: 500 },
      ];

      // Act - Date.now() をモックして累積タイムアウトを強制発火
      // Mock Date.now() to force cumulative timeout
      const originalDateNow = Date.now;
      let callCount = 0;
      vi.spyOn(Date, "now").mockImplementation(() => {
        callCount++;
        // 最初の呼び出し(cumulativeStart)は0、以降は十分大きい値を返す
        // First call (cumulativeStart) returns 0, subsequent calls return large value
        return callCount <= 1 ? 0 : 500_000;
      });

      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        timeoutMs: 100,
      });

      vi.spyOn(Date, "now").mockRestore();

      // Assert
      expect(result.results).toHaveLength(3);
      // タイムアウト後のセクションはスキップされる
      const skippedResults = result.results.filter(
        (r) => r.skipped && r.skipReason?.includes("timeout")
      );
      expect(skippedResults.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 8. 空セクション配列: 空結果を返却
  // ==========================================================================
  describe("空セクション配列 / Empty sections array", () => {
    it("空のセクション配列が渡された場合、空の結果を返却する", async () => {
      // Arrange
      const sections: Array<{ id: string; startY: number; height: number }> = [];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results).toHaveLength(0);
      expect(result.capturedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      // ブラウザは起動されないこと
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 9. セクション高さ < MIN_SECTION_HEIGHT_PX (10px): スキップ
  // ==========================================================================
  describe("セクション高さ < 10px / Section height below minimum", () => {
    it("height=0のセクションはスキップされる", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 0 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results).toHaveLength(1);
      expect(result.results[0].screenshotBuffer).toBeNull();
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toContain("height");
    });

    it("heightが負数のセクションはスキップされる", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: -100 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toContain("height");
    });

    it("height=9px (MIN_SECTION_HEIGHT_PX未満) のセクションはスキップされる", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 9 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toContain("height");
    });
  });

  // ==========================================================================
  // 10. 正常系（複数セクション）
  // ==========================================================================
  describe("正常系: 複数セクション / Normal: multiple sections", () => {
    it("複数セクションの個別キャプチャが正しく返却される", async () => {
      // Arrange
      const screenshotBuf1 = Buffer.from("screenshot-section-1", "utf-8");
      const screenshotBuf2 = Buffer.from("screenshot-section-2", "utf-8");
      const screenshotBuf3 = Buffer.from("screenshot-section-3", "utf-8");

      let callCount = 0;
      const mockScreenshot = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return screenshotBuf1;
        if (callCount === 2) return screenshotBuf2;
        return screenshotBuf3;
      });

      const mockPage = createMockPage({
        screenshot: mockScreenshot,
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [
        { id: MOCK_SECTION_ID_1, startY: 0, height: 600 },
        { id: MOCK_SECTION_ID_2, startY: 0, height: 400 },
        { id: MOCK_SECTION_ID_3, startY: 0, height: 500 },
      ];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results).toHaveLength(3);
      expect(result.results[0].sectionId).toBe(MOCK_SECTION_ID_1);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      expect(result.results[0].width).toBe(1920); // DEFAULT_VIEWPORT_WIDTH (unified with ingest)
      expect(result.results[0].skipped).toBe(false);

      expect(result.results[1].sectionId).toBe(MOCK_SECTION_ID_2);
      expect(result.results[1].screenshotBuffer).not.toBeNull();

      expect(result.results[2].sectionId).toBe(MOCK_SECTION_ID_3);
      expect(result.results[2].screenshotBuffer).not.toBeNull();

      // 各セクションで page.screenshot が呼ばれる
      expect(mockScreenshot).toHaveBeenCalledTimes(3);
      expect(result.capturedCount).toBe(3);
      expect(result.skippedCount).toBe(0);
    });

    it("デフォルトのビューポートサイズ (1920x1080) が使用される", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        // viewportWidth/viewportHeight 未指定
      });

      // Assert
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1920, height: 1080 },
        })
      );
    });

    it("カスタムビューポートサイズが設定される", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 600 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1920, height: 1080 },
        })
      );
    });
  });

  // ==========================================================================
  // NaN/Infinity防御 / NaN/Infinity defense
  // ==========================================================================
  describe("NaN/Infinity防御 / Invalid coordinates", () => {
    it("NaN座標のセクションはinvalid_coordinatesでスキップされる", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: NaN, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toBe("invalid_coordinates");
    });

    it("Infinity高さのセクションはinvalid_coordinatesでスキップされる", async () => {
      // Arrange
      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: Infinity }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toBe("invalid_coordinates");
    });
  });

  // ==========================================================================
  // マルチタイルキャプチャ / Multi-tile capture
  // ==========================================================================
  describe("マルチタイルキャプチャ / Multi-tile capture", () => {
    it("height > viewportHeight の場合、複数タイルに分割してキャプチャする", async () => {
      // Arrange: section height = 2500px, viewport height = 1080px → 3 tiles
      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      let multiLastScrollY = 0;
      const mockEvaluate = vi
        .fn()
        .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (args.length > 0) {
            multiLastScrollY = typeof args[0] === "number" ? args[0] : 0;
            return Promise.resolve(undefined);
          }
          return Promise.resolve(multiLastScrollY);
        });
      const mockPage = createMockPage({
        screenshot: mockScreenshot,
        evaluate: mockEvaluate,
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      // Sharp mock: metadata returns per-tile dimensions, composite returns stitched buffer
      getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 500 });
      getSharpMockInstance().toBuffer.mockResolvedValue(
        Buffer.from("stitched-multi-tile", "utf-8")
      );

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 2500 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      expect(result.capturedCount).toBe(1);

      // 3 tiles: ceil(2500 / 1080) = 3
      expect(mockScreenshot).toHaveBeenCalledTimes(3);
    });

    it("height <= viewportHeight の場合、1タイルで既存動作を維持する", async () => {
      // Arrange: section height = 800px, viewport height = 1080px → 1 tile
      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      const mockPage = createMockPage({ screenshot: mockScreenshot });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 800 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(result.capturedCount).toBe(1);
      expect(mockScreenshot).toHaveBeenCalledTimes(1);
      // Sharp composite は呼ばれない（1タイルなのでstitchしない）
      // Sharp composite should NOT be called (single tile, no stitching)
      expect(getSharpMockInstance().composite).not.toHaveBeenCalled();
    });

    it("DEFAULT_MAX_TILES_PER_SECTION (20) を超えるセクションはタイル上限でキャップされる", async () => {
      // Arrange: section height = 30000px, viewport height = 1080px
      // ceil(30000 / 1080) = 28, but capped at DEFAULT_MAX_TILES_PER_SECTION = 20
      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      let scrollY = 0;
      const mockEvaluate = vi
        .fn()
        .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (args.length > 0) {
            scrollY = typeof args[0] === "number" ? args[0] : 0;
            return Promise.resolve(undefined);
          }
          return Promise.resolve(scrollY);
        });
      const mockPage = createMockPage({ screenshot: mockScreenshot, evaluate: mockEvaluate });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 1080 });
      getSharpMockInstance().toBuffer.mockResolvedValue(Buffer.from("stitched-capped", "utf-8"));

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 30000 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert: capped at 20 tiles
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(mockScreenshot).toHaveBeenCalledTimes(20);
    });

    it("MAX_TILES_PER_SECTION 環境変数でタイル上限をオーバーライドできる", async () => {
      // Arrange: section height = 10000px, env MAX_TILES_PER_SECTION = 5
      const originalEnv = process.env.MAX_TILES_PER_SECTION;
      process.env.MAX_TILES_PER_SECTION = "5";

      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      let scrollY = 0;
      const mockEvaluate = vi
        .fn()
        .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (args.length > 0) {
            scrollY = typeof args[0] === "number" ? args[0] : 0;
            return Promise.resolve(undefined);
          }
          return Promise.resolve(scrollY);
        });
      const mockPage = createMockPage({ screenshot: mockScreenshot, evaluate: mockEvaluate });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 1080 });
      getSharpMockInstance().toBuffer.mockResolvedValue(
        Buffer.from("stitched-env-override", "utf-8")
      );

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 10000 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert: capped at 5 tiles (env override)
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(mockScreenshot).toHaveBeenCalledTimes(5);

      // Cleanup
      if (originalEnv === undefined) {
        delete process.env.MAX_TILES_PER_SECTION;
      } else {
        process.env.MAX_TILES_PER_SECTION = originalEnv;
      }
    });

    it("不正な MAX_TILES_PER_SECTION 環境変数はデフォルト値にフォールバックする", async () => {
      // Arrange: env MAX_TILES_PER_SECTION = "abc" (invalid)
      const originalEnv = process.env.MAX_TILES_PER_SECTION;
      process.env.MAX_TILES_PER_SECTION = "abc";

      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      let scrollY = 0;
      const mockEvaluate = vi
        .fn()
        .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (args.length > 0) {
            scrollY = typeof args[0] === "number" ? args[0] : 0;
            return Promise.resolve(undefined);
          }
          return Promise.resolve(scrollY);
        });
      const mockPage = createMockPage({ screenshot: mockScreenshot, evaluate: mockEvaluate });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 1080 });
      getSharpMockInstance().toBuffer.mockResolvedValue(
        Buffer.from("stitched-default-fallback", "utf-8")
      );

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 30000 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert: falls back to DEFAULT_MAX_TILES_PER_SECTION = 20
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(mockScreenshot).toHaveBeenCalledTimes(20);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid MAX_TILES_PER_SECTION"),
        expect.objectContaining({ envValue: "abc" })
      );

      // Cleanup
      if (originalEnv === undefined) {
        delete process.env.MAX_TILES_PER_SECTION;
      } else {
        process.env.MAX_TILES_PER_SECTION = originalEnv;
      }
    });

    it.each([
      { envValue: "-3", label: "負数 / negative" },
      { envValue: "0", label: "ゼロ / zero" },
      { envValue: "", label: "空文字列 / empty string" },
    ])(
      "MAX_TILES_PER_SECTION=$envValue ($label) はデフォルト値にフォールバックする",
      async ({ envValue }) => {
        // Arrange
        const originalEnv = process.env.MAX_TILES_PER_SECTION;
        process.env.MAX_TILES_PER_SECTION = envValue;

        const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
        let scrollY = 0;
        const mockEvaluate = vi
          .fn()
          .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
            if (args.length > 0) {
              scrollY = typeof args[0] === "number" ? args[0] : 0;
              return Promise.resolve(undefined);
            }
            return Promise.resolve(scrollY);
          });
        const mockPage = createMockPage({ screenshot: mockScreenshot, evaluate: mockEvaluate });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);
        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 1080 });
        getSharpMockInstance().toBuffer.mockResolvedValue(
          Buffer.from("stitched-fallback", "utf-8")
        );

        const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 30000 }];

        // Act
        const result = await captureSectionScreenshots({
          url: MOCK_URL,
          sections,
          viewportWidth: 1920,
          viewportHeight: 1080,
        });

        // Assert: falls back to DEFAULT_MAX_TILES_PER_SECTION = 20
        expect(result.results).toHaveLength(1);
        expect(result.results[0].skipped).toBe(false);
        expect(mockScreenshot).toHaveBeenCalledTimes(20);

        // Cleanup
        if (originalEnv === undefined) {
          delete process.env.MAX_TILES_PER_SECTION;
        } else {
          process.env.MAX_TILES_PER_SECTION = originalEnv;
        }
      }
    );

    it("マルチタイル中にメモリ圧力が発生すると部分結果を返す", async () => {
      // Arrange: section height = 3000px → 3 tiles, but memory pressure after 1st tile
      let tileCallCount = 0;
      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      const mockPage = createMockPage({ screenshot: mockScreenshot });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const checkMemoryPressure = vi.fn().mockImplementation(() => {
        tileCallCount++;
        if (tileCallCount >= 2) {
          // 2回目以降のタイルでメモリ圧力 / Memory pressure on 2nd+ tile check
          return { shouldDegrade: true, shouldAbort: false, rssMb: 5000 };
        }
        return { shouldDegrade: false, shouldAbort: false, rssMb: 2000 };
      });

      getSharpMockInstance().metadata.mockResolvedValue({ width: 1920, height: 1080 });
      getSharpMockInstance().toBuffer.mockResolvedValue(Buffer.from("stitched-partial", "utf-8"));

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 3000 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
        checkMemoryPressure,
      });

      // Assert: partial result returned (at least 1 tile captured before abort)
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(false);
      expect(result.results[0].screenshotBuffer).not.toBeNull();
      // Fewer than 3 tiles captured due to memory pressure
      expect(mockScreenshot.mock.calls.length).toBeLessThan(3);
    });

    it("scrollTo後のactual scrollYでclipYが補正される", async () => {
      // Arrange: scrollTo(2000) but actual scroll settles at 1950 (sticky header)
      const mockScreenshot = vi.fn().mockResolvedValue(createMockScreenshotBuffer());
      const mockEvaluate = vi
        .fn()
        .mockImplementation((_fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (args.length > 0) return Promise.resolve(undefined); // scrollTo
          return Promise.resolve(1950); // window.scrollY: 50px short (sticky header)
        });
      const mockPage = createMockPage({
        screenshot: mockScreenshot,
        evaluate: mockEvaluate,
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 2000, height: 400 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Assert: clipY should be 2000 - 1950 = 50
      expect(mockScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          clip: expect.objectContaining({
            y: 50,
          }),
        })
      );
    });
  });

  // ==========================================================================
  // リソースクリーンアップ / Resource cleanup
  // ==========================================================================
  describe("リソースクリーンアップ / Resource cleanup", () => {
    it("独自起動ブラウザは処理完了後にclose()が呼ばれる", async () => {
      // Arrange
      const browserClose = vi.fn().mockResolvedValue(undefined);
      const contextClose = vi.fn().mockResolvedValue(undefined);
      const pageClose = vi.fn().mockResolvedValue(undefined);

      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
        close: pageClose,
      });
      const mockContext = createMockContext(mockPage, { close: contextClose });
      const mockBrowser = createMockBrowser(mockContext, { close: browserClose });
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 600 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(pageClose).toHaveBeenCalledTimes(1);
      expect(contextClose).toHaveBeenCalledTimes(1);
      expect(browserClose).toHaveBeenCalledTimes(1);
    });

    it("sharedBrowser使用時はbrowser.close()を呼ばない", async () => {
      // Arrange
      const browserClose = vi.fn().mockResolvedValue(undefined);
      const contextClose = vi.fn().mockResolvedValue(undefined);
      const pageClose = vi.fn().mockResolvedValue(undefined);

      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
        close: pageClose,
      });
      const mockContext = createMockContext(mockPage, { close: contextClose });
      const sharedBrowser = createMockBrowser(mockContext, {
        close: browserClose,
        isConnected: vi.fn().mockReturnValue(true),
      });

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 600 }];

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        sharedBrowser,
      });

      // Assert
      expect(browserClose).not.toHaveBeenCalled();
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
      // page/contextはクリーンアップされる
      expect(pageClose).toHaveBeenCalledTimes(1);
      expect(contextClose).toHaveBeenCalledTimes(1);
    });

    it("エラー発生時もリソースクリーンアップが実行される", async () => {
      // Arrange
      const browserClose = vi.fn().mockResolvedValue(undefined);
      const contextClose = vi.fn().mockResolvedValue(undefined);
      const pageClose = vi.fn().mockResolvedValue(undefined);

      const mockPage = createMockPage({
        screenshot: vi.fn().mockRejectedValue(new Error("Screenshot failed")),
        close: pageClose,
      });
      const mockContext = createMockContext(mockPage, { close: contextClose });
      const mockBrowser = createMockBrowser(mockContext, { close: browserClose });
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = [{ id: MOCK_SECTION_ID_1, startY: 0, height: 600 }];

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
      });

      // Assert
      expect(pageClose).toHaveBeenCalledTimes(1);
      expect(contextClose).toHaveBeenCalledTimes(1);
      expect(browserClose).toHaveBeenCalledTimes(1);
      // エラーはスローされず、skipped=trueで返る
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toBe("capture_failed");
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
