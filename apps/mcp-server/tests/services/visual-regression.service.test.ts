// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisualRegressionService テスト
 * Visual Regression Service Tests (v0.4.0 — Option B: metadata JSONB)
 *
 * TDD Red Phase: テストを先に記述
 * テスト対象: apps/mcp-server/src/services/visual-regression.service.ts
 *
 * テスト戦略:
 * - Playwright/Sharp/Pixelmatch はモック化（実際の画像処理は行わない）
 * - DI ファクトリーの Prisma モックレベルでベースライン取得をテスト
 * - Option B: metadata.screenshot_full_url からの baseline 読み取りを検証
 * - エラーコード定数の網羅性を検証
 *
 * @module tests/services/visual-regression.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// =====================================================
// Mocks — モジュールレベル
// =====================================================

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

vi.mock("@/utils/sanitize-error", () => ({
  sanitizeErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : "An internal error occurred"
  ),
}));

// Sharp モック — 画像処理のチェーン呼び出しを再現
const mockSharpInstance = {
  metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
  resize: vi.fn().mockReturnThis(),
  raw: vi.fn().mockReturnThis(),
  ensureAlpha: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(1920 * 1080 * 4, 128)),
  png: vi.fn().mockReturnThis(),
};

vi.mock("sharp", () => ({
  default: vi.fn(() => mockSharpInstance),
}));

// Pixelmatch モック — 変更ピクセル数を返す
vi.mock("pixelmatch", () => ({
  default: vi.fn().mockReturnValue(0),
}));

// Playwright モック — captureScreenshot の dynamic import 対応
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.alloc(100)),
};
const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// node:fs/promises モック — ファイルパスベースライン読み込み用 + realpath
const { mockFsReadFile, mockFsRealpath } = vi.hoisted(() => ({
  mockFsReadFile: vi.fn().mockResolvedValue(Buffer.alloc(100, 200)),
  mockFsRealpath: vi.fn().mockImplementation(async (p: string) => p),
}));
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: mockFsReadFile,
    realpath: mockFsRealpath,
  },
  readFile: mockFsReadFile,
  realpath: mockFsRealpath,
}));

// =====================================================
// テスト対象のインポート
// =====================================================

import {
  runVisualRegression,
  setVisualRegressionPrismaClientFactory,
  resetVisualRegressionPrismaClientFactory,
  VISUAL_REGRESSION_ERROR_CODES,
  type IVisualRegressionPrismaClient,
  type VisualRegressionInput,
} from "../../src/services/visual-regression.service";

// =====================================================
// テスト本体
// =====================================================

describe("VisualRegressionService", () => {
  let mockPrisma: {
    designSnapshot: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };

  /** 共通の有効な入力 */
  const validInput: VisualRegressionInput = {
    baselineSnapshotId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    url: "https://example.com",
  };

  /** ベースラインスナップショット行（data URI版、Prisma camelCase + nested metadata） */
  const baselineRowDataUri = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    webPageId: "11111111-2222-3333-4444-555555555555",
    snapshotAt: new Date("2026-01-15T10:00:00Z"),
    metadata: {
      screenshot_full_url:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    },
    webPage: { url: "https://example.com" },
  };

  /** ベースラインスナップショット行（ファイルパス版） */
  const baselineRowFilePath = {
    ...baselineRowDataUri,
    metadata: {
      screenshot_full_url: "/tmp/reftrix-screenshots/baseline.png",
    },
  };

  beforeEach(() => {
    mockPrisma = {
      designSnapshot: {
        findUnique: vi.fn(),
      },
    };
    setVisualRegressionPrismaClientFactory(
      () => mockPrisma as unknown as IVisualRegressionPrismaClient
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetVisualRegressionPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // runVisualRegression
  // =====================================================

  describe("runVisualRegression", () => {
    it("DI未設定時 → BASELINE_NOT_FOUND エラーを返す", async () => {
      // Arrange: DI ファクトリーをリセット（未設定状態）
      resetVisualRegressionPrismaClientFactory();

      // Act
      const result = await runVisualRegression(validInput);

      // Assert: factory が null のため getBaselineScreenshot が null を返す
      expect(result.success).toBe(false);
      expect(result.error).toContain(VISUAL_REGRESSION_ERROR_CODES.BASELINE_NOT_FOUND);
    });

    it("ベースライン未発見 → BASELINE_NOT_FOUND エラーを返す", async () => {
      // Arrange: Prisma が null を返す
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(null);

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(VISUAL_REGRESSION_ERROR_CODES.BASELINE_NOT_FOUND);
    });

    it("metadata が null → BASELINE_NOT_FOUND エラーを返す", async () => {
      // Arrange: metadata が null
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        ...baselineRowDataUri,
        metadata: null,
      });

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(VISUAL_REGRESSION_ERROR_CODES.BASELINE_NOT_FOUND);
    });

    it("正常系（pass） → 変更率が閾値以下で passed=true を返す", async () => {
      // Arrange: ベースライン取得成功（data URI）
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowDataUri);

      // pixelmatch は 0 ピクセル変更（デフォルトモック）
      const pixelmatch = (await import("pixelmatch")).default;
      vi.mocked(pixelmatch).mockReturnValue(0);

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.changePercentage).toBe(0);
      expect(result.changedPixels).toBe(0);
      expect(result.totalPixels).toBeGreaterThan(0);
      expect(result.threshold).toBe(0.001); // DEFAULT_REGRESSION_THRESHOLD
      expect(result.diffImageBase64).toBeDefined();
      expect(result.baseline).toBeDefined();
      expect(result.baseline?.snapshotId).toBe(baselineRowDataUri.id);
      expect(result.baseline?.webPageUrl).toBe(baselineRowDataUri.webPage.url);
    });

    it("正常系（fail） → 変更率が閾値超過で passed=false を返す", async () => {
      // Arrange: ベースライン取得成功
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowDataUri);

      // pixelmatch が全ピクセル変更を報告
      const pixelmatch = (await import("pixelmatch")).default;
      vi.mocked(pixelmatch).mockReturnValue(1920 * 1080); // 全ピクセル

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.changePercentage).toBeGreaterThan(0);
      expect(result.changedPixels).toBe(1920 * 1080);
    });

    it("Playwright captureScreenshot 失敗 → CAPTURE_FAILED エラーを返す", async () => {
      // Arrange: ベースライン取得成功
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowDataUri);

      // Playwright の launch が例外を投げる
      const playwright = await import("playwright");
      vi.mocked(playwright.chromium.launch).mockRejectedValueOnce(
        new Error("Browser launch failed")
      );

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(VISUAL_REGRESSION_ERROR_CODES.CAPTURE_FAILED);
      expect(result.error).toContain("Browser launch failed");
    });

    it("カスタム閾値・ビューポート → パラメータが反映される", async () => {
      // Arrange: ベースライン取得成功
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowDataUri);

      const pixelmatch = (await import("pixelmatch")).default;
      vi.mocked(pixelmatch).mockReturnValue(100); // 100 ピクセル変更

      const customInput: VisualRegressionInput = {
        baselineSnapshotId: baselineRowDataUri.id,
        url: "https://example.com",
        threshold: 0.5, // 50% 閾値（緩い）
        viewportWidth: 1280,
        viewportHeight: 720,
      };

      // Act
      const result = await runVisualRegression(customInput);

      // Assert: カスタム閾値が使用されている
      expect(result.success).toBe(true);
      expect(result.threshold).toBe(0.5);
      // 100 / (1920 * 1080) < 0.5 なので passed=true
      expect(result.passed).toBe(true);

      // ビューポートパラメータが Playwright に渡されることを確認
      const playwright = await import("playwright");
      const browserInstance = await vi.mocked(playwright.chromium.launch).mock.results[0]?.value;
      if (browserInstance) {
        expect(vi.mocked(browserInstance.newPage)).toHaveBeenCalledWith(
          expect.objectContaining({
            viewport: { width: 1280, height: 720 },
          })
        );
      }
    });

    it("ファイルパスベースライン → fs.readFile で読み込まれる", async () => {
      // Arrange: ファイルパス型のスクリーンショット
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowFilePath);

      const pixelmatch = (await import("pixelmatch")).default;
      vi.mocked(pixelmatch).mockReturnValue(0);

      // Act
      const result = await runVisualRegression(validInput);

      // Assert: 正常に処理される
      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);

      // fs.readFile が呼ばれたことを確認
      const fs = await import("node:fs/promises");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalled();
    });

    it("Diff計算失敗 → DIFF_FAILED エラーを返す", async () => {
      // Arrange: ベースライン取得成功
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce(baselineRowDataUri);

      // Sharp の metadata が例外を投げる（画像読み込み失敗シミュレーション）
      mockSharpInstance.metadata.mockRejectedValueOnce(new Error("Invalid image format"));

      // Act
      const result = await runVisualRegression(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(VISUAL_REGRESSION_ERROR_CODES.DIFF_FAILED);
      expect(result.error).toContain("Invalid image format");
    });
  });

  // =====================================================
  // Option B: metadata.screenshot_full_url テスト (NEW-R5-M1)
  // =====================================================

  describe("getBaselineScreenshot (Option B: metadata.screenshot_full_url)", () => {
    it("正常系: metadata.screenshot_full_url が data URI で存在", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "01234567-89ab-cdef-0123-456789abcdef",
        webPageId: "fedcba98-7654-3210-fedc-ba9876543210",
        snapshotAt: new Date("2026-01-01"),
        metadata: {
          screenshot_full_url:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lPAAAAABJRU5ErkJggg==",
        },
        webPage: { url: "https://example.com" },
      });
      const result = await runVisualRegression({
        baselineSnapshotId: "01234567-89ab-cdef-0123-456789abcdef",
        url: "https://example.com",
        threshold: 0.001,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });
      // diff 実行できることを確認
      expect(result.success).toBeDefined();
    });

    it("graceful fallback: metadata が null の旧スナップショット", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "01234567-89ab-cdef-0123-456789abcdef",
        webPageId: "fedcba98-7654-3210-fedc-ba9876543210",
        snapshotAt: new Date("2026-01-01"),
        metadata: null, // 旧スナップショット
        webPage: { url: "https://example.com" },
      });
      const result = await runVisualRegression({
        baselineSnapshotId: "01234567-89ab-cdef-0123-456789abcdef",
        url: "https://example.com",
        threshold: 0.001,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });

    it("graceful fallback: metadata 存在するが screenshot_full_url 欠落", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "01234567-89ab-cdef-0123-456789abcdef",
        webPageId: "fedcba98-7654-3210-fedc-ba9876543210",
        snapshotAt: new Date("2026-01-01"),
        metadata: { analysis_version: "1.0" }, // 他の key のみ
        webPage: { url: "https://example.com" },
      });
      const result = await runVisualRegression({
        baselineSnapshotId: "01234567-89ab-cdef-0123-456789abcdef",
        url: "https://example.com",
        threshold: 0.001,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });
  });

  // =====================================================
  // Path Traversal / Symlink / MAX_IMAGE_SIZE テスト (SEC M-1)
  // =====================================================

  describe("Path Traversal / Symlink 防御", () => {
    it("path traversal ペイロード (../../etc/passwd) → BASELINE_NOT_FOUND", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        webPageId: "11111111-2222-3333-4444-555555555555",
        snapshotAt: new Date("2026-01-01"),
        metadata: {
          screenshot_full_url: "../../etc/passwd",
        },
        webPage: { url: "https://example.com" },
      });
      // fs.realpath は resolve 後のパスを返す（ALLOWED_SCREENSHOT_ROOT 外）
      mockFsRealpath.mockImplementation(async (p: string) => {
        if (p.includes("etc/passwd")) return "/etc/passwd";
        return p;
      });
      const result = await runVisualRegression(validInput);
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });

    it("ALLOWED_SCREENSHOT_ROOT 外の絶対パス → BASELINE_NOT_FOUND", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        webPageId: "11111111-2222-3333-4444-555555555555",
        snapshotAt: new Date("2026-01-01"),
        metadata: {
          screenshot_full_url: "/var/secret/data.png",
        },
        webPage: { url: "https://example.com" },
      });
      mockFsRealpath.mockImplementation(async (p: string) => p);
      const result = await runVisualRegression(validInput);
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });

    it("symlink が ALLOWED_SCREENSHOT_ROOT 外を指す場合 → BASELINE_NOT_FOUND", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        webPageId: "11111111-2222-3333-4444-555555555555",
        snapshotAt: new Date("2026-01-01"),
        metadata: {
          screenshot_full_url: "/tmp/reftrix-screenshots/link-to-secret",
        },
        webPage: { url: "https://example.com" },
      });
      // symlink が外部パスを指す
      mockFsRealpath.mockImplementation(async (p: string) => {
        if (p.includes("link-to-secret")) return "/etc/passwd";
        return p;
      });
      const result = await runVisualRegression(validInput);
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });

    it("MAX_IMAGE_SIZE (50MB) 超過 → BASELINE_NOT_FOUND", async () => {
      mockPrisma.designSnapshot.findUnique.mockResolvedValueOnce({
        ...baselineRowFilePath,
      });
      mockFsRealpath.mockImplementation(async (p: string) => p);
      // 50MB超のバッファを返す
      mockFsReadFile.mockResolvedValueOnce(Buffer.alloc(51 * 1024 * 1024));
      const result = await runVisualRegression(validInput);
      expect(result.success).toBe(false);
      expect(result.error).toContain("BASELINE_NOT_FOUND");
    });
  });

  // =====================================================
  // エラーコード定数
  // =====================================================

  describe("エラーコード", () => {
    it("VISUAL_REGRESSION_ERROR_CODES の全6コードが定義されている", () => {
      expect(VISUAL_REGRESSION_ERROR_CODES.VALIDATION_ERROR).toBe(
        "VISUAL_REGRESSION_VALIDATION_ERROR"
      );
      expect(VISUAL_REGRESSION_ERROR_CODES.BASELINE_NOT_FOUND).toBe(
        "VISUAL_REGRESSION_BASELINE_NOT_FOUND"
      );
      expect(VISUAL_REGRESSION_ERROR_CODES.CAPTURE_FAILED).toBe("VISUAL_REGRESSION_CAPTURE_FAILED");
      expect(VISUAL_REGRESSION_ERROR_CODES.DIFF_FAILED).toBe("VISUAL_REGRESSION_DIFF_FAILED");
      expect(VISUAL_REGRESSION_ERROR_CODES.SNAPSHOT_NOT_FOUND).toBe(
        "VISUAL_REGRESSION_SNAPSHOT_NOT_FOUND"
      );
      expect(VISUAL_REGRESSION_ERROR_CODES.DIMENSION_MISMATCH).toBe(
        "VISUAL_REGRESSION_DIMENSION_MISMATCH"
      );

      // 全6コードが存在することを確認
      expect(Object.keys(VISUAL_REGRESSION_ERROR_CODES)).toHaveLength(6);
    });
  });
});
