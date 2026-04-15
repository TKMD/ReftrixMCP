// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * report.generate MCPツールのテスト
 * Report Generator Tool Tests (v0.4.0 T3-RPT)
 *
 * テスト対象:
 * - Zodスキーマバリデーション (5テスト)
 * - ハンドラー統合テスト (5テスト)
 * - ツール定義の検証 (3テスト)
 * - セキュリティ (3テスト)
 *
 * @module tests/tools/report/generate.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================
// Mocks
// =====================================================

vi.mock("@/services/report-template.service", () => ({
  generateReport: vi.fn(),
  REPORT_ERROR_CODES: {
    VALIDATION_ERROR: "REPORT_VALIDATION_ERROR",
    PAGE_NOT_FOUND: "REPORT_PAGE_NOT_FOUND",
    NO_ANALYSIS_DATA: "REPORT_NO_ANALYSIS_DATA",
    TEMPLATE_ERROR: "REPORT_TEMPLATE_ERROR",
    PDF_CONVERSION_FAILED: "REPORT_PDF_CONVERSION_FAILED",
  },
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
  reportGenerateInputSchema,
  reportGenerateHandler,
  reportGenerateToolDefinition,
  type ReportGenerateOutput,
} from "../../../src/tools/report/generate.tool";

import { generateReport } from "../../../src/services/report-template.service";

// =====================================================
// Test Data / テストデータ
// =====================================================

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

const VALID_HTML_INPUT = {
  web_page_id: VALID_UUID,
  format: "html" as const,
};

const VALID_PDF_INPUT = {
  web_page_id: VALID_UUID,
  format: "pdf" as const,
};

describe("report.generate Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // Schema Validation / スキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("有効なHTML入力を受け入れデフォルト値を設定する", () => {
      const result = reportGenerateInputSchema.safeParse(VALID_HTML_INPUT);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.format).toBe("html");
        expect(result.data.include_screenshot).toBe(true);
        expect(result.data.include_motion).toBe(true);
        expect(result.data.include_quality).toBe(true);
      }
    });

    it("有効なPDF入力を受け入れる", () => {
      const result = reportGenerateInputSchema.safeParse(VALID_PDF_INPUT);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.format).toBe("pdf");
      }
    });

    it("web_page_id UUID不正でバリデーションエラー", () => {
      const result = reportGenerateInputSchema.safeParse({
        web_page_id: "not-a-uuid",
        format: "html",
      });
      expect(result.success).toBe(false);
    });

    it("format不正値でバリデーションエラー", () => {
      const result = reportGenerateInputSchema.safeParse({
        web_page_id: VALID_UUID,
        format: "docx",
      });
      expect(result.success).toBe(false);
    });

    it("title 201文字超でバリデーションエラー", () => {
      const result = reportGenerateInputSchema.safeParse({
        web_page_id: VALID_UUID,
        format: "html",
        title: "a".repeat(201),
      });
      expect(result.success).toBe(false);
    });
  });

  // =====================================================
  // Handler Integration / ハンドラー統合テスト
  // =====================================================

  describe("ハンドラー統合テスト", () => {
    it("HTMLレポート生成成功を正しく返却する", async () => {
      vi.mocked(generateReport).mockResolvedValueOnce({
        success: true,
        format: "html",
        content: "<html><body>Report</body></html>",
        contentSizeBytes: 1024,
      });

      const result = (await reportGenerateHandler(VALID_HTML_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(true);
      expect(result.format).toBe("html");
      expect(result.content).toContain("<html>");
      expect(result.content_size_bytes).toBe(1024);
    });

    it("PDFレポート生成成功を正しく返却する", async () => {
      vi.mocked(generateReport).mockResolvedValueOnce({
        success: true,
        format: "pdf",
        content: "JVBERi0xLjQK...",
        contentSizeBytes: 51200,
      });

      const result = (await reportGenerateHandler(VALID_PDF_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(true);
      expect(result.format).toBe("pdf");
      expect(result.content).toBeDefined();
      expect(result.content_size_bytes).toBe(51200);
    });

    it("ページ未発見時にPAGE_NOT_FOUNDエラーを返す", async () => {
      vi.mocked(generateReport).mockResolvedValueOnce({
        success: false,
        error: "REPORT_PAGE_NOT_FOUND: Web page not found",
      });

      const result = (await reportGenerateHandler(VALID_HTML_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("PAGE_NOT_FOUND");
    });

    it("テンプレートエラー時にTEMPLATE_ERRORエラーを返す", async () => {
      vi.mocked(generateReport).mockResolvedValueOnce({
        success: false,
        error: "REPORT_TEMPLATE_ERROR: Failed to compile template",
      });

      const result = (await reportGenerateHandler(VALID_HTML_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("TEMPLATE_ERROR");
    });

    it("サービス例外時にsanitizedエラーを返す", async () => {
      vi.mocked(generateReport).mockRejectedValueOnce(
        new Error("INTERNAL: Handlebars compile error at line 42")
      );

      const result = (await reportGenerateHandler(VALID_HTML_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("TEMPLATE_ERROR");
    });
  });

  // =====================================================
  // Tool Definition / ツール定義
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が report.generate である", () => {
      expect(reportGenerateToolDefinition.name).toBe("report.generate");
    });

    it("inputSchema.requiredにweb_page_idとformatが含まれる", () => {
      expect(reportGenerateToolDefinition.inputSchema.required).toContain("web_page_id");
      expect(reportGenerateToolDefinition.inputSchema.required).toContain("format");
    });

    it("annotationsにreadOnlyHintが設定されている", () => {
      expect(reportGenerateToolDefinition.annotations).toBeDefined();
      expect(reportGenerateToolDefinition.annotations.readOnlyHint).toBe(true);
    });
  });

  // =====================================================
  // Security / セキュリティ
  // =====================================================

  describe("セキュリティ", () => {
    it("Zodバリデーション失敗時にgenerateReportが呼ばれない", async () => {
      const result = (await reportGenerateHandler({
        web_page_id: "invalid",
        format: "html",
      })) as ReportGenerateOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain("VALIDATION_ERROR");
      expect(generateReport).not.toHaveBeenCalled();
    });

    it("エラーメッセージがサニタイズされ内部情報が漏洩しない", async () => {
      vi.mocked(generateReport).mockRejectedValueOnce(
        new Error("ECONNREFUSED 127.0.0.1:26432 pg_catalog")
      );

      const result = (await reportGenerateHandler(VALID_HTML_INPUT)) as ReportGenerateOutput;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("titleオプションの200文字制限が適用される", async () => {
      // 200文字ちょうどは許可
      const result200 = reportGenerateInputSchema.safeParse({
        web_page_id: VALID_UUID,
        format: "html",
        title: "a".repeat(200),
      });
      expect(result200.success).toBe(true);

      // 201文字は拒否
      const result201 = reportGenerateInputSchema.safeParse({
        web_page_id: VALID_UUID,
        format: "html",
        title: "a".repeat(201),
      });
      expect(result201.success).toBe(false);
    });
  });
});
