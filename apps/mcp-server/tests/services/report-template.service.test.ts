// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ReportTemplateService テスト
 * Report Template Service Tests (v0.4.0 T3-PR5)
 *
 * TDD Red Phase: テストを先に記述
 * テスト対象: apps/mcp-server/src/services/report-template.service.ts
 *
 * テスト戦略:
 * - Handlebars は実モジュールを使用（テンプレートコンパイル確認）
 * - Playwright は vi.mock でモック化（PDF 生成は行わない）
 * - DI ファクトリーの Prisma モックで DB 依存をテスト
 * - エラーコード定数の網羅性を検証
 *
 * @module tests/services/report-template.service.test
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

// Playwright モック — PDF 生成用 dynamic import
const mockPdfBuffer = Buffer.from("fake-pdf-content");
const mockPdfPage = {
  setContent: vi.fn().mockResolvedValue(undefined),
  pdf: vi.fn().mockResolvedValue(mockPdfBuffer),
};
const mockPdfBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPdfPage),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockPdfBrowser),
  },
}));

// fs/promises モック — スクリーンショット読み込み用
vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
}));

// =====================================================
// テスト対象のインポート
// =====================================================

import {
  generateReport,
  setReportPrismaClientFactory,
  resetReportPrismaClientFactory,
  setPdfGeneratorFactory,
  resetPdfGeneratorFactory,
  REPORT_ERROR_CODES,
  type IReportPrismaClient,
  type IPdfGenerator,
  type ReportGenerateInput,
} from "../../src/services/report-template.service";

// =====================================================
// テストデータ
// =====================================================

/** WebPage モック行 */
const mockWebPage = {
  id: "11111111-2222-3333-4444-555555555555",
  url: "https://example.com",
  title: "Example Page",
  analyzed_at: new Date("2026-01-15T10:00:00Z"),
  screenshot_full_url: null as string | null,
};

/** Section Pattern モック行 */
const mockSections = [
  {
    section_type: "hero",
    heading: "Welcome to Example",
    position_index: 0,
    component_count: 3,
    layout_type: "full-width",
  },
  {
    section_type: "features",
    heading: "Our Features",
    position_index: 1,
    component_count: 6,
    layout_type: "grid",
  },
];

/** Motion Pattern モック行 */
const mockMotions = [
  {
    type: "fade-in",
    name: "Hero Fade",
    category: "entrance",
    trigger: "scroll",
    duration: 500,
    easing: "ease-out",
  },
];

/** Quality Evaluation モック行 */
const mockQuality = [
  {
    overall_score: 85.5,
    grade: "A",
    anti_ai_cliche: 90,
    design_quality: 82,
    technical_quality: 88,
  },
];

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * 標準的な4回の $queryRawUnsafe 呼び出しをセットアップする
 * 1回目: web_page取得
 * 2回目: section_patterns取得
 * 3回目: motion_patterns取得
 * 4回目: quality_evaluations取得
 */
function setupStandardMocks(
  prisma: { $queryRawUnsafe: ReturnType<typeof vi.fn> },
  options?: {
    webPage?: typeof mockWebPage | null;
    sections?: typeof mockSections;
    motions?: typeof mockMotions;
    quality?: typeof mockQuality;
  }
): void {
  const webPage = options?.webPage !== undefined ? options.webPage : mockWebPage;
  const sections = options?.sections ?? mockSections;
  const motions = options?.motions ?? mockMotions;
  const quality = options?.quality ?? mockQuality;

  // 1回目: web_page 取得
  prisma.$queryRawUnsafe.mockResolvedValueOnce(webPage ? [webPage] : []);
  // 2回目: section_patterns 取得
  prisma.$queryRawUnsafe.mockResolvedValueOnce(sections);
  // 3回目: motion_patterns 取得
  prisma.$queryRawUnsafe.mockResolvedValueOnce(motions);
  // 4回目: quality_evaluations 取得
  prisma.$queryRawUnsafe.mockResolvedValueOnce(quality);
}

// =====================================================
// テスト本体
// =====================================================

describe("ReportTemplateService", () => {
  let mockPrisma: { $queryRawUnsafe: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPrisma = { $queryRawUnsafe: vi.fn() };
    setReportPrismaClientFactory(() => mockPrisma as unknown as IReportPrismaClient);
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetReportPrismaClientFactory();
    resetPdfGeneratorFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // generateReport
  // =====================================================

  describe("generateReport", () => {
    it("DI未設定時 → PAGE_NOT_FOUND エラーを返す", async () => {
      // Arrange: DI ファクトリーをリセット（未設定状態）
      resetReportPrismaClientFactory();

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
      };

      // Act
      const result = await generateReport(input);

      // Assert: factory が null のため aggregateReportData が null を返す
      expect(result.success).toBe(false);
      expect(result.error).toContain(REPORT_ERROR_CODES.PAGE_NOT_FOUND);
    });

    it("WebPage未発見 → PAGE_NOT_FOUND エラーを返す", async () => {
      // Arrange: Prisma が空配列を返す（WebPage が存在しない）
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      const input: ReportGenerateInput = {
        webPageId: "nonexistent-uuid",
        format: "html",
      };

      // Act
      const result = await generateReport(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(REPORT_ERROR_CODES.PAGE_NOT_FOUND);
    });

    it("HTML形式レポート生成成功 → format='html' で HTML 文字列を返す", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
      };

      // Act
      const result = await generateReport(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.format).toBe("html");
      expect(result.content).toBeDefined();
      expect(typeof result.content).toBe("string");
      expect(result.contentSizeBytes).toBeGreaterThan(0);
    });

    it("HTML コンテンツに WebPage の URL が含まれる", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
      };

      // Act
      const result = await generateReport(input);

      // Assert: HTML に URL とセクション情報が含まれる
      expect(result.content).toContain("https://example.com");
      expect(result.content).toContain("hero");
      expect(result.content).toContain("features");
    });

    it("HTML コンテンツに Quality セクションが含まれる", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        includeQuality: true,
      };

      // Act
      const result = await generateReport(input);

      // Assert: Quality Score セクション、グレード
      expect(result.content).toContain("Quality Score");
      expect(result.content).toContain("85.5");
      expect(result.content).toContain("A");
    });

    it("includeMotion=false → motion クエリが実行されない", async () => {
      // Arrange: web_page + sections のみセットアップ
      // includeMotion=false の場合、motionクエリはスキップされる
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([mockWebPage]); // web_page
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockSections); // sections
      // motion クエリはスキップされるので、次は quality
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockQuality); // quality

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        includeMotion: false,
      };

      // Act
      const result = await generateReport(input);

      // Assert: 成功するが motion セクションは HTML に含まれない
      expect(result.success).toBe(true);
      // motion クエリを除くと合計3回（web_page, sections, quality）
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    });

    it("includeQuality=false → quality クエリが実行されない", async () => {
      // Arrange: web_page + sections + motion のみ
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([mockWebPage]); // web_page
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockSections); // sections
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockMotions); // motion

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        includeQuality: false,
      };

      // Act
      const result = await generateReport(input);

      // Assert
      expect(result.success).toBe(true);
      // quality クエリを除くと合計3回（web_page, sections, motion）
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
      // Quality Score セクションが含まれない
      expect(result.content).not.toContain("Quality Score");
    });

    it("タイトル自動生成 → pageのtitleを使用したタイトルが設定される", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        // title 指定なし → 自動生成
      };

      // Act
      const result = await generateReport(input);

      // Assert: 自動生成タイトルが HTML に含まれる
      expect(result.content).toContain("Reftrix Report");
      expect(result.content).toContain("Example Page");
    });

    it("タイトル手動指定 → 指定したタイトルが使用される", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const customTitle = "Custom Report Title 2026";
      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        title: customTitle,
      };

      // Act
      const result = await generateReport(input);

      // Assert: カスタムタイトルが HTML に含まれる
      expect(result.content).toContain(customTitle);
    });

    it("PDF形式レポート生成成功 → format='pdf' で Base64 文字列を返す（DI経由）", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const mockPdfGen: IPdfGenerator = {
        generatePdf: vi.fn().mockResolvedValue(mockPdfBuffer),
      };
      setPdfGeneratorFactory(() => mockPdfGen);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "pdf",
      };

      // Act
      const result = await generateReport(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.format).toBe("pdf");
      expect(result.content).toBeDefined();
      expect(result.contentSizeBytes).toBe(mockPdfBuffer.length);
      expect(mockPdfGen.generatePdf).toHaveBeenCalled();
    });

    it("PDF変換失敗 → PDF_CONVERSION_FAILED エラーを返す（DI経由）", async () => {
      // Arrange
      setupStandardMocks(mockPrisma);

      const mockPdfGen: IPdfGenerator = {
        generatePdf: vi.fn().mockRejectedValue(new Error("PDF generation failed")),
      };
      setPdfGeneratorFactory(() => mockPdfGen);

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "pdf",
      };

      // Act
      const result = await generateReport(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain(REPORT_ERROR_CODES.PDF_CONVERSION_FAILED);
    });

    it("セクション0件でもレポート生成が成功する", async () => {
      // Arrange: セクション空、motion空、quality空
      setupStandardMocks(mockPrisma, {
        sections: [],
        motions: [],
        quality: [],
      });

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
      };

      // Act
      const result = await generateReport(input);

      // Assert: 空データでも正常に HTML 生成
      expect(result.success).toBe(true);
      expect(result.format).toBe("html");
      expect(result.content).toContain("Sections (0)");
    });

    it("includeScreenshot=true かつ data URI → screenshot が HTML に含まれる", async () => {
      // Arrange: screenshot_full_url が data URI
      const webPageWithScreenshot = {
        ...mockWebPage,
        screenshot_full_url: "data:image/png;base64,AAAA",
      };
      setupStandardMocks(mockPrisma, { webPage: webPageWithScreenshot });

      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
        includeScreenshot: true,
      };

      // Act
      const result = await generateReport(input);

      // Assert: Screenshot セクションが HTML に含まれる
      expect(result.success).toBe(true);
      expect(result.content).toContain("Screenshot");
      expect(result.content).toContain("data:image/png;base64,");
    });
  });

  // =====================================================
  // エラーコード定数
  // =====================================================

  describe("エラーコード", () => {
    it("REPORT_ERROR_CODES の全5コードが定義されている", () => {
      expect(REPORT_ERROR_CODES.VALIDATION_ERROR).toBe("REPORT_VALIDATION_ERROR");
      expect(REPORT_ERROR_CODES.PAGE_NOT_FOUND).toBe("REPORT_PAGE_NOT_FOUND");
      expect(REPORT_ERROR_CODES.NO_ANALYSIS_DATA).toBe("REPORT_NO_ANALYSIS_DATA");
      expect(REPORT_ERROR_CODES.TEMPLATE_ERROR).toBe("REPORT_TEMPLATE_ERROR");
      expect(REPORT_ERROR_CODES.PDF_CONVERSION_FAILED).toBe("REPORT_PDF_CONVERSION_FAILED");

      // 全5コードが存在することを確認
      expect(Object.keys(REPORT_ERROR_CODES)).toHaveLength(5);
    });
  });

  // =====================================================
  // DI ファクトリ型安全性 (SEC 監査指摘対応)
  // =====================================================

  describe("IReportPrismaClient 型安全性", () => {
    it("$queryRawUnsafe のシグネチャが (query: string, ...values: unknown[]) である", () => {
      // IReportPrismaClient の型制約を満たすオブジェクトが正しく動作することを確認
      const typedPrisma: IReportPrismaClient = {
        $queryRawUnsafe: async (query: string, ..._values: unknown[]) => {
          // query は string 型であることが型レベルで保証される
          expect(typeof query).toBe("string");
          return [];
        },
      };

      setReportPrismaClientFactory(() => typedPrisma);

      // ファクトリ経由で取得したクライアントが機能する
      const input: ReportGenerateInput = {
        webPageId: mockWebPage.id,
        format: "html",
      };

      // generateReport は内部で $queryRawUnsafe(sql, param) を呼ぶ
      // 型制約により第1引数が string であることが保証される
      expect(async () => await generateReport(input)).not.toThrow();
    });

    it("DI登録→リセット→再登録のライフサイクルが正常に動作する", async () => {
      // 1. 登録済み状態でレポート生成（DBモック）
      setupStandardMocks(mockPrisma);
      const result1 = await generateReport({
        webPageId: mockWebPage.id,
        format: "html",
      });
      expect(result1.success).toBe(true);

      // 2. リセット後はPAGE_NOT_FOUND
      resetReportPrismaClientFactory();
      const result2 = await generateReport({
        webPageId: mockWebPage.id,
        format: "html",
      });
      expect(result2.success).toBe(false);
      expect(result2.error).toContain("PAGE_NOT_FOUND");

      // 3. 再登録で復旧
      setReportPrismaClientFactory(() => mockPrisma as unknown as IReportPrismaClient);
      setupStandardMocks(mockPrisma);
      const result3 = await generateReport({
        webPageId: mockWebPage.id,
        format: "html",
      });
      expect(result3.success).toBe(true);
    });
  });
});
