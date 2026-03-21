// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Bounding Box Playwright Service Tests
 *
 * JSDOMの getBoundingClientRect() が常に {0,0,0,0} を返す問題を解決する
 * Playwright後付けbounding box取得サービスのユニットテスト。
 *
 * Unit tests for the Playwright bounding box resolution service
 * that resolves JSDOM's always-{0,0,0,0} getBoundingClientRect() limitation.
 *
 * テストカテゴリ:
 * 1. resolvePartBoundingBoxes: 正常系、早期リターン、PII除外、Graceful Degradation
 * 2. buildSelectorsForPart: タグ+クラス、タグのみ、クラスのみ
 * 3. CSSエスケープ: 特殊文字エスケープ（buildSelectorsForPart経由）
 * 4. セキュリティ: CSSインジェクション防止、SSRF対策
 * 5. リソースクリーンアップ: page/context/browser のclose検証
 *
 * @module tests/services/part/part-bbox-playwright.service.test
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

// playwright モック / Playwright mock
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

import { chromium } from "playwright";
const mockChromiumLaunch = vi.mocked(chromium.launch);

// ============================================================================
// Test Data / テストデータ
// ============================================================================

const MOCK_WEB_PAGE_ID = "01934567-89ab-7def-0123-456789abcdef";
const MOCK_URL = "https://example.com/design";
const MOCK_PART_ID_1 = "11111111-1111-7111-1111-111111111111";
const MOCK_PART_ID_2 = "22222222-2222-7222-2222-222222222222";
const MOCK_PART_ID_3 = "33333333-3333-7333-3333-333333333333";
const MOCK_SECTION_ID_1 = "aaaa1111-1111-7111-1111-111111111111";
const MOCK_SECTION_ID_2 = "bbbb2222-2222-7222-2222-222222222222";

// ============================================================================
// Mock Factories / モックファクトリー
// ============================================================================

function createMockPage(overrides?: {
  goto?: ReturnType<typeof vi.fn>;
  evaluate?: ReturnType<typeof vi.fn>;
  waitForTimeout?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}): Page {
  return {
    goto: overrides?.goto ?? vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: overrides?.evaluate ?? vi.fn().mockResolvedValue([]),
    waitForTimeout: overrides?.waitForTimeout ?? vi.fn().mockResolvedValue(undefined),
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

function createMockPrisma(overrides?: {
  componentPartFindMany?: ReturnType<typeof vi.fn>;
  sectionPatternFindMany?: ReturnType<typeof vi.fn>;
  $transaction?: ReturnType<typeof vi.fn>;
  componentPartUpdate?: ReturnType<typeof vi.fn>;
}): Record<string, unknown> {
  const prisma = {
    componentPart: {
      findMany: overrides?.componentPartFindMany ?? vi.fn().mockResolvedValue([]),
      update: overrides?.componentPartUpdate ?? vi.fn().mockResolvedValue({}),
    },
    sectionPattern: {
      findMany: overrides?.sectionPatternFindMany ?? vi.fn().mockResolvedValue([]),
    },
    $transaction: overrides?.$transaction ?? vi.fn().mockResolvedValue([]),
  };
  return prisma;
}

/** DB上のパーツデータを生成 / Generate DB part data */
function createMockDbPart(
  overrides?: Partial<{
    id: string;
    partType: string;
    cssClasses: string[];
    sectionPatternId: string;
    boundingBox: Record<string, number> | null;
    sampleIndex: number;
    piiRiskLevel: string;
  }>
): Record<string, unknown> {
  return {
    id: overrides?.id ?? MOCK_PART_ID_1,
    partType: overrides?.partType ?? "button",
    cssClasses: overrides?.cssClasses ?? ["btn", "primary"],
    sectionPatternId: overrides?.sectionPatternId ?? MOCK_SECTION_ID_1,
    boundingBox: overrides?.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
    sampleIndex: overrides?.sampleIndex ?? 0,
    piiRiskLevel: overrides?.piiRiskLevel ?? "none",
  };
}

// ============================================================================
// テスト対象のインポート（モック設定後）
// Import module under test (after mock setup)
// ============================================================================

import {
  resolvePartBoundingBoxes,
  buildSelectorsForPart,
  type ResolvePartBoundingBoxesParams,
} from "../../../src/services/part/part-bbox-playwright.service";

// ============================================================================
// Tests
// ============================================================================

describe("PartBboxPlaywrightService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトでURL検証を通過 / Default: pass URL validation
    mockValidateExternalUrl.mockReturnValue({ valid: true, normalizedUrl: MOCK_URL });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // resolvePartBoundingBoxes - 正常系 / Normal cases
  // ==========================================================================

  describe("resolvePartBoundingBoxes", () => {
    describe("正常系 / Normal cases", () => {
      it("bounding box が正しく解決され DB が更新される", async () => {
        // Arrange
        const mockParts = [
          createMockDbPart({
            id: MOCK_PART_ID_1,
            partType: "button",
            cssClasses: ["btn"],
            boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          }),
          createMockDbPart({
            id: MOCK_PART_ID_2,
            partType: "heading",
            cssClasses: ["title"],
            boundingBox: null,
          }),
        ];

        const evaluateResult = [
          { id: MOCK_PART_ID_1, x: 100, y: 50, width: 200, height: 40 },
          { id: MOCK_PART_ID_2, x: 0, y: 0, width: 800, height: 60 },
        ];

        const mockPage = createMockPage({
          evaluate: vi.fn().mockResolvedValue(evaluateResult),
        });
        const contextClose = vi.fn().mockResolvedValue(undefined);
        const pageClose = vi.fn().mockResolvedValue(undefined);
        (mockPage as unknown as Record<string, unknown>).close = pageClose;
        const mockContext = createMockContext(mockPage, { close: contextClose });
        const mockBrowser = createMockBrowser(mockContext);

        const mockTransaction = vi.fn().mockResolvedValue([]);
        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
          $transaction: mockTransaction,
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(2);
        expect(result.skippedCount).toBe(0);
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        // $transaction に渡されるのは Promise[] の配列
        const transactionArgs = mockTransaction.mock.calls[0][0] as unknown[];
        expect(transactionArgs).toHaveLength(2);
      });

      it("既に有効な bounding box を持つパーツはスキップされる", async () => {
        // Arrange: width, height > 0 なのでフィルタされる
        const mockParts = [
          createMockDbPart({
            id: MOCK_PART_ID_1,
            boundingBox: { x: 10, y: 20, width: 200, height: 40 },
          }),
        ];

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
        });

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        // Playwright は呼ばれないこと
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });

      it("page.evaluate() でマッチしないパーツは skippedCount に計上される", async () => {
        // Arrange
        const mockParts = [
          createMockDbPart({ id: MOCK_PART_ID_1 }),
          createMockDbPart({ id: MOCK_PART_ID_2, partType: "card", cssClasses: [] }),
        ];

        const evaluateResult = [
          { id: MOCK_PART_ID_1, x: 10, y: 20, width: 100, height: 50 },
          null, // 2番目はマッチしなかった
        ];

        const mockPage = createMockPage({
          evaluate: vi.fn().mockResolvedValue(evaluateResult),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
      });
    });

    // ========================================================================
    // 早期リターン / Early return
    // ========================================================================

    describe("早期リターン / Early return", () => {
      it("対象パーツが0件の場合、Playwright を呼ばずに早期リターンする", async () => {
        // Arrange: DB に該当パーツなし
        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue([]),
        });

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });

      it("すべてのパーツが piiRiskLevel=high の場合は0件となり早期リターンする", async () => {
        // Arrange: piiRiskLevel='high' のパーツはDB検索自体で除外される（WHERE句）
        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue([]),
        });

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
      });
    });

    // ========================================================================
    // PII高リスクパーツのフィルタリング
    // ========================================================================

    describe("PII高リスクパーツ除外 / PII high-risk filtering", () => {
      it('DB検索時に piiRiskLevel: { not: "high" } でフィルタされること', async () => {
        // Arrange
        const componentPartFindMany = vi.fn().mockResolvedValue([]);
        const mockPrisma = createMockPrisma({ componentPartFindMany });

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert: where条件を確認
        expect(componentPartFindMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              webPageId: MOCK_WEB_PAGE_ID,
              piiRiskLevel: { not: "high" },
            }),
          })
        );
      });
    });

    // ========================================================================
    // Graceful Degradation
    // ========================================================================

    describe("Graceful Degradation", () => {
      it("Playwright ナビゲーション失敗時に resolvedCount=0 で返す（例外はスローしない）", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const mockPage = createMockPage({
          goto: vi.fn().mockRejectedValue(new Error("Navigation timeout")),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act: 例外がスローされないこと
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Bounding box resolution failed"),
          expect.objectContaining({
            error: "Navigation timeout",
          })
        );
      });

      it("page.evaluate() エラー時に resolvedCount=0 で返す", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const mockPage = createMockPage({
          evaluate: vi.fn().mockRejectedValue(new Error("Evaluation failed")),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
      });

      it("HTTP 4xx/5xx ステータスの場合 skippedCount を返す", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const mockPage = createMockPage({
          goto: vi.fn().mockResolvedValue({ status: () => 404 }),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("HTTP error"),
          expect.objectContaining({ status: 404 })
        );
      });

      it("goto() が null を返した場合でも正常に続行する", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const evaluateResult = [{ id: MOCK_PART_ID_1, x: 10, y: 20, width: 100, height: 50 }];
        const mockPage = createMockPage({
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockResolvedValue(evaluateResult),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert: response が null でもエラーにならず続行
        expect(result.resolvedCount).toBe(1);
      });
    });

    // ========================================================================
    // リソースクリーンアップ / Resource cleanup
    // ========================================================================

    describe("リソースクリーンアップ / Resource cleanup", () => {
      it("成功時に page.close() と context.close() が呼ばれること", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const pageClose = vi.fn().mockResolvedValue(undefined);
        const contextClose = vi.fn().mockResolvedValue(undefined);
        const browserClose = vi.fn().mockResolvedValue(undefined);

        const mockPage = createMockPage({
          evaluate: vi
            .fn()
            .mockResolvedValue([{ id: MOCK_PART_ID_1, x: 10, y: 20, width: 100, height: 50 }]),
        });
        (mockPage as unknown as Record<string, unknown>).close = pageClose;

        const mockContext = createMockContext(mockPage, { close: contextClose });
        const mockBrowser = createMockBrowser(mockContext, { close: browserClose });

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(pageClose).toHaveBeenCalledTimes(1);
        expect(contextClose).toHaveBeenCalledTimes(1);
        // 独自起動ブラウザは閉じる
        expect(browserClose).toHaveBeenCalledTimes(1);
      });

      it("失敗時でも page.close() と context.close() が呼ばれること", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const pageClose = vi.fn().mockResolvedValue(undefined);
        const contextClose = vi.fn().mockResolvedValue(undefined);

        const mockPage = createMockPage({
          evaluate: vi.fn().mockRejectedValue(new Error("crash")),
        });
        (mockPage as unknown as Record<string, unknown>).close = pageClose;

        const mockContext = createMockContext(mockPage, { close: contextClose });
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(pageClose).toHaveBeenCalledTimes(1);
        expect(contextClose).toHaveBeenCalledTimes(1);
      });

      it("共有ブラウザ使用時は browser.close() を呼ばないこと", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const browserClose = vi.fn().mockResolvedValue(undefined);

        const mockPage = createMockPage({
          evaluate: vi
            .fn()
            .mockResolvedValue([{ id: MOCK_PART_ID_1, x: 10, y: 20, width: 100, height: 50 }]),
        });
        const mockContext = createMockContext(mockPage);
        const sharedBrowser = createMockBrowser(mockContext, { close: browserClose });

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
        });

        // Act: sharedBrowser を渡す
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
          sharedBrowser,
        });

        // Assert: 共有ブラウザは閉じない
        expect(browserClose).not.toHaveBeenCalled();
        // chromium.launch も呼ばれないこと
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });
    });

    // ========================================================================
    // セクション相対座標変換 / Section-relative coordinate conversion
    // ========================================================================

    describe("セクション相対座標変換 / Section-relative coordinate conversion", () => {
      it("sectionStartY を引いた y 座標が page.evaluate に渡されること", async () => {
        // Arrange
        const sectionStartY = 500;
        const mockParts = [
          createMockDbPart({
            id: MOCK_PART_ID_1,
            sectionPatternId: MOCK_SECTION_ID_1,
          }),
        ];

        const capturedEvaluateArg = vi
          .fn()
          .mockResolvedValue([{ id: MOCK_PART_ID_1, x: 10, y: 50, width: 100, height: 40 }]);

        const mockPage = createMockPage({ evaluate: capturedEvaluateArg });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: sectionStartY } } },
            ]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert: page.evaluate に渡される selectorData の sectionStartY が正しい
        expect(capturedEvaluateArg).toHaveBeenCalledTimes(1);
        const selectorDataArg = capturedEvaluateArg.mock.calls[0][1] as Array<{
          sectionStartY: number;
        }>;
        expect(selectorDataArg[0].sectionStartY).toBe(sectionStartY);
      });

      it("layoutInfo が null の場合 sectionStartY は 0 になること", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];

        const capturedEvaluateArg = vi.fn().mockResolvedValue([null]);
        const mockPage = createMockPage({ evaluate: capturedEvaluateArg });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([{ id: MOCK_SECTION_ID_1, layoutInfo: null }]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        const selectorDataArg = capturedEvaluateArg.mock.calls[0][1] as Array<{
          sectionStartY: number;
        }>;
        expect(selectorDataArg[0].sectionStartY).toBe(0);
      });
    });

    // ========================================================================
    // $transaction によるバッチ更新 / Batch update via $transaction
    // ========================================================================

    describe("$transaction バッチ更新 / Batch update", () => {
      it("複数パーツが1トランザクションで更新されること", async () => {
        // Arrange
        const mockParts = [
          createMockDbPart({ id: MOCK_PART_ID_1, sectionPatternId: MOCK_SECTION_ID_1 }),
          createMockDbPart({
            id: MOCK_PART_ID_2,
            partType: "heading",
            sectionPatternId: MOCK_SECTION_ID_1,
          }),
          createMockDbPart({
            id: MOCK_PART_ID_3,
            partType: "image",
            sectionPatternId: MOCK_SECTION_ID_2,
          }),
        ];

        const evaluateResult = [
          { id: MOCK_PART_ID_1, x: 10, y: 20, width: 200, height: 40 },
          { id: MOCK_PART_ID_2, x: 0, y: 0, width: 800, height: 60 },
          { id: MOCK_PART_ID_3, x: 50, y: 100, width: 300, height: 200 },
        ];

        const mockPage = createMockPage({
          evaluate: vi.fn().mockResolvedValue(evaluateResult),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockTransaction = vi.fn().mockResolvedValue([]);
        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi.fn().mockResolvedValue([
            { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            { id: MOCK_SECTION_ID_2, layoutInfo: { position: { startY: 1000 } } },
          ]),
          $transaction: mockTransaction,
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(3);
        expect(result.skippedCount).toBe(0);
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        const transactionArgs = mockTransaction.mock.calls[0][0] as unknown[];
        expect(transactionArgs).toHaveLength(3);
      });

      it("解決されたパーツが0件の場合は $transaction を呼ばないこと", async () => {
        // Arrange: page.evaluate が全て null を返す
        const mockParts = [createMockDbPart()];

        const mockPage = createMockPage({
          evaluate: vi.fn().mockResolvedValue([null]),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockTransaction = vi.fn();
        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([
              { id: MOCK_SECTION_ID_1, layoutInfo: { position: { startY: 0 } } },
            ]),
          $transaction: mockTransaction,
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(mockTransaction).not.toHaveBeenCalled();
      });
    });

    // ========================================================================
    // ビューポート設定 / Viewport configuration
    // ========================================================================

    describe("ビューポート設定 / Viewport configuration", () => {
      it("カスタムビューポートサイズが設定されること", async () => {
        // Arrange
        const mockParts = [createMockDbPart()];
        const mockPage = createMockPage({
          evaluate: vi.fn().mockResolvedValue([null]),
        });
        const mockContext = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockContext);

        const mockPrisma = createMockPrisma({
          componentPartFindMany: vi.fn().mockResolvedValue(mockParts),
          sectionPatternFindMany: vi
            .fn()
            .mockResolvedValue([{ id: MOCK_SECTION_ID_1, layoutInfo: null }]),
        });

        mockChromiumLaunch.mockResolvedValue(mockBrowser);

        // Act
        await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: MOCK_URL,
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
          viewportWidth: 1920,
          viewportHeight: 1080,
        });

        // Assert: newContext に viewport が渡されること
        expect(mockBrowser.newContext).toHaveBeenCalledWith(
          expect.objectContaining({
            viewport: { width: 1920, height: 1080 },
          })
        );
      });
    });

    // ========================================================================
    // セキュリティ: SSRF対策 / Security: SSRF prevention
    // ========================================================================

    describe("セキュリティ: SSRF対策 / Security: SSRF prevention", () => {
      it("SSRF検証でブロックされたURLは早期リターンする", async () => {
        // Arrange
        mockValidateExternalUrl.mockReturnValue({
          valid: false,
          error: "Private IP address blocked",
        });

        const mockPrisma = createMockPrisma();

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: "http://192.168.1.1/admin",
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("SSRF validation"),
          expect.objectContaining({ error: "Private IP address blocked" })
        );
        // DB検索もPlaywrightも呼ばれないこと
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });

      it("localhost URL がブロックされること", async () => {
        // Arrange
        mockValidateExternalUrl.mockReturnValue({
          valid: false,
          error: "Localhost not allowed",
        });

        const mockPrisma = createMockPrisma();

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: "http://localhost:3000",
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
      });

      it("メタデータサービスURL がブロックされること", async () => {
        // Arrange
        mockValidateExternalUrl.mockReturnValue({
          valid: false,
          error: "Metadata service blocked",
        });

        const mockPrisma = createMockPrisma();

        // Act
        const result = await resolvePartBoundingBoxes({
          webPageId: MOCK_WEB_PAGE_ID,
          url: "http://169.254.169.254/latest/meta-data/",
          prisma: mockPrisma as unknown as ResolvePartBoundingBoxesParams["prisma"],
        });

        // Assert
        expect(result.resolvedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
      });
    });
  });

  // ==========================================================================
  // buildSelectorsForPart - セレクタ構築
  // ==========================================================================

  describe("buildSelectorsForPart", () => {
    describe("タグ + クラス / Tag + class selectors", () => {
      it("button タイプで cssClasses がある場合、tag.class と tag の両方を返す", () => {
        // Arrange & Act
        const selectors = buildSelectorsForPart("button", ["btn", "primary"]);

        // Assert: button.btn.primary, button の順
        expect(selectors).toContain("button.btn.primary");
        expect(selectors).toContain("button");
        // tag+class が tag より先に来ること（優先度順）
        expect(selectors.indexOf("button.btn.primary")).toBeLessThan(selectors.indexOf("button"));
      });

      it("heading タイプは h1-h6 すべてのタグでセレクタを生成する", () => {
        const selectors = buildSelectorsForPart("heading", ["section-title"]);

        // h1-h6 すべてのタグ+クラスとタグのみが含まれること
        expect(selectors).toContain("h1.section-title");
        expect(selectors).toContain("h2.section-title");
        expect(selectors).toContain("h3.section-title");
        expect(selectors).toContain("h4.section-title");
        expect(selectors).toContain("h5.section-title");
        expect(selectors).toContain("h6.section-title");
        expect(selectors).toContain("h1");
        expect(selectors).toContain("h6");
      });

      it("input タイプは input, select, textarea のタグを返す", () => {
        const selectors = buildSelectorsForPart("input", ["form-control"]);

        expect(selectors).toContain("input.form-control");
        expect(selectors).toContain("select.form-control");
        expect(selectors).toContain("textarea.form-control");
        expect(selectors).toContain("input");
        expect(selectors).toContain("select");
        expect(selectors).toContain("textarea");
      });
    });

    describe("タグのみ / Tag-only selectors", () => {
      it("cssClasses が空の場合、タグのみのセレクタを返す", () => {
        const selectors = buildSelectorsForPart("button", []);

        expect(selectors).toEqual(["button"]);
      });

      it("cssClasses に空文字列のみの場合、タグのみのセレクタを返す", () => {
        const selectors = buildSelectorsForPart("button", ["", ""]);

        expect(selectors).toEqual(["button"]);
      });
    });

    describe("クラスのみ / Class-only selectors", () => {
      it("タグマッピングがないパーツタイプ(card)はクラスのみのセレクタを返す", () => {
        const selectors = buildSelectorsForPart("card", ["card", "feature-card"]);

        expect(selectors).toEqual([".card.feature-card"]);
      });

      it("タグマッピングがないパーツタイプ(badge)はクラスのみのセレクタを返す", () => {
        const selectors = buildSelectorsForPart("badge", ["badge-primary"]);

        expect(selectors).toEqual([".badge-primary"]);
      });

      it("hero_image タイプはクラスのみのセレクタを返す", () => {
        const selectors = buildSelectorsForPart("hero_image", ["hero", "banner-img"]);

        expect(selectors).toEqual([".hero.banner-img"]);
      });
    });

    describe("セレクタ生成なし / No selectors", () => {
      it("タグマッピングなし＋cssClassesが空の場合、空配列を返す", () => {
        const selectors = buildSelectorsForPart("card", []);

        expect(selectors).toEqual([]);
      });
    });
  });

  // ==========================================================================
  // CSS特殊文字エスケープ（buildSelectorsForPart経由） / CSS escaping
  // ==========================================================================

  describe("CSSエスケープ / CSS escaping (via buildSelectorsForPart)", () => {
    it("通常の文字列はエスケープされない", () => {
      const selectors = buildSelectorsForPart("card", ["simple-class"]);

      expect(selectors[0]).toBe(".simple-class");
    });

    it("ドット (.) がエスケープされること", () => {
      const selectors = buildSelectorsForPart("card", ["text.lg"]);

      expect(selectors[0]).toBe(".text\\.lg");
    });

    it("コロン (:) がエスケープされること", () => {
      // TailwindCSS v4の応答クラス例
      const selectors = buildSelectorsForPart("card", ["hover:bg-blue"]);

      expect(selectors[0]).toBe(".hover\\:bg-blue");
    });

    it("ブラケット ([]) がエスケープされること", () => {
      // TailwindCSS v4の任意値クラス例
      const selectors = buildSelectorsForPart("card", ["w-[100px]"]);

      expect(selectors[0]).toBe(".w-\\[100px\\]");
    });

    it("シャープ (#) がエスケープされること", () => {
      const selectors = buildSelectorsForPart("card", ["color-#fff"]);

      expect(selectors[0]).toBe(".color-\\#fff");
    });

    it("複合的な特殊文字がすべてエスケープされること", () => {
      const selectors = buildSelectorsForPart("card", ["md:text-[1.5rem]"]);

      expect(selectors[0]).toBe(".md\\:text-\\[1\\.5rem\\]");
    });

    it("スラッシュ (/) がエスケープされること", () => {
      const selectors = buildSelectorsForPart("card", ["w-1/2"]);

      expect(selectors[0]).toBe(".w-1\\/2");
    });
  });

  // ==========================================================================
  // セキュリティ: CSSインジェクション防止 / Security: CSS injection prevention
  // ==========================================================================

  describe("セキュリティ: CSSインジェクション防止 / CSS injection prevention", () => {
    it("悪意のある cssClasses がエスケープされること", () => {
      // 悪意のある入力: ); } body { display: none; } .x {
      const selectors = buildSelectorsForPart("card", ["evil); } body { display: none; } .x {"]);

      // 特殊文字がバックスラッシュでエスケープされていること
      expect(selectors[0]).toContain("\\)");
      expect(selectors[0]).toContain("\\{");
      expect(selectors[0]).toContain("\\}");
      expect(selectors[0]).toContain("\\;");
      // エスケープなしの ) や { が存在しないこと（バックスラッシュ付きのみ）
      // すべての ) は \) として、すべての { は \{ としてエスケープされる
      const unescapedBraces = selectors[0].replace(/\\[{}()]/g, "");
      expect(unescapedBraces).not.toContain("{");
      expect(unescapedBraces).not.toContain("}");
      expect(unescapedBraces).not.toContain(")");
    });

    it("セレクタに引用符インジェクションが含まれてもエスケープされること", () => {
      const selectors = buildSelectorsForPart("card", ['"onmouseover="alert(1)"']);

      expect(selectors[0]).toContain('\\"');
    });
  });
});
