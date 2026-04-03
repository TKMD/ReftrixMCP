// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * accessibility.audit MCP Tool Tests
 *
 * axe-coreベースWCAG監査 + OKLCHコントラストチェック統合ツールのテスト
 * Tests for axe-core WCAG audit + OKLCH contrast check integrated MCP tool
 *
 * @module tests/tools/accessibility/audit.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  accessibilityAuditHandler,
  accessibilityAuditToolDefinition,
  setAccessibilityAuditServiceFactory,
  resetAccessibilityAuditServiceFactory,
  setContrastCheckServiceFactory,
  resetContrastCheckServiceFactory,
  ACCESSIBILITY_AUDIT_ERROR_CODES,
  type AccessibilityAuditInput,
  type AccessibilityAuditOutput,
} from "../../../src/tools/accessibility/audit.tool";

// =====================================================
// モックサービス
// =====================================================

function createMockAuditService() {
  return {
    audit: vi.fn().mockResolvedValue({
      score: 85,
      level: "AA",
      violations: [
        {
          id: "image-alt",
          impact: "serious",
          description: "Images must have alternate text",
          help: "Ensures <img> elements have alternate text",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.0/image-alt",
          nodes: 2,
          fixSuggestion: "Add alt attribute to <img> elements",
        },
      ],
      passes: [],
      summary: {
        totalViolations: 1,
        totalPasses: 10,
        critical: 0,
        serious: 1,
        moderate: 0,
        minor: 0,
      },
    }),
    calculateScore: vi.fn().mockReturnValue(85),
    generateFixSuggestion: vi.fn().mockReturnValue("Add alt attribute"),
  };
}

function createMockContrastService() {
  return {
    checkHtmlContrast: vi.fn().mockResolvedValue({
      issues: [
        {
          element: "p",
          fgColor: "#cccccc",
          bgColor: "#ffffff",
          ratio: 1.6,
          meetsAA: false,
          isLargeText: false,
          suggestedColor: "#767676",
        },
      ],
      totalElements: 5,
    }),
    calculateContrastRatio: vi.fn().mockReturnValue(1.6),
    meetsWcagAA: vi.fn().mockReturnValue(false),
    suggestAlternativeColor: vi.fn().mockReturnValue("#767676"),
    parseColor: vi.fn().mockReturnValue({ r: 204, g: 204, b: 204 }),
    getRelativeLuminance: vi.fn().mockReturnValue(0.6),
  };
}

// =====================================================
// テスト
// =====================================================

describe("accessibility.audit MCP Tool", () => {
  let mockAuditService: ReturnType<typeof createMockAuditService>;
  let mockContrastService: ReturnType<typeof createMockContrastService>;

  beforeEach(() => {
    mockAuditService = createMockAuditService();
    mockContrastService = createMockContrastService();
    setAccessibilityAuditServiceFactory(() => mockAuditService as never);
    setContrastCheckServiceFactory(() => mockContrastService as never);
  });

  afterEach(() => {
    resetAccessibilityAuditServiceFactory();
    resetContrastCheckServiceFactory();
  });

  describe("ツール定義", () => {
    it("ツール名が accessibility.audit である", () => {
      expect(accessibilityAuditToolDefinition.name).toBe("accessibility.audit");
    });

    it("ツール説明が定義されている", () => {
      expect(accessibilityAuditToolDefinition.description).toBeDefined();
      expect(typeof accessibilityAuditToolDefinition.description).toBe("string");
    });

    it("inputSchemaが定義されている", () => {
      expect(accessibilityAuditToolDefinition.inputSchema).toBeDefined();
      expect(accessibilityAuditToolDefinition.inputSchema.type).toBe("object");
    });

    it("inputSchemaにurl/html/levelプロパティがある", () => {
      const props = accessibilityAuditToolDefinition.inputSchema.properties;
      expect(props).toBeDefined();
      expect(props.url).toBeDefined();
      expect(props.html).toBeDefined();
      expect(props.level).toBeDefined();
      expect(props.include_contrast).toBeDefined();
      expect(props.include_passes).toBeDefined();
    });

    it("annotations が定義されている", () => {
      expect(accessibilityAuditToolDefinition.annotations).toBeDefined();
      expect(accessibilityAuditToolDefinition.annotations?.readOnlyHint).toBe(true);
    });
  });

  describe("バリデーション", () => {
    it("URLもHTMLも未指定でバリデーションエラー", async () => {
      const result = (await accessibilityAuditHandler({})) as AccessibilityAuditOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ACCESSIBILITY_AUDIT_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("不正なlevel値でバリデーションエラー", async () => {
      const result = (await accessibilityAuditHandler({
        html: "<html></html>",
        level: "AAAA",
      })) as AccessibilityAuditOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ACCESSIBILITY_AUDIT_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("URLに対するSSRF検証（プライベートIP）", async () => {
      const result = (await accessibilityAuditHandler({
        url: "http://127.0.0.1/admin",
      })) as AccessibilityAuditOutput;
      expect(result.success).toBe(false);
    });

    it("URLに対するSSRF検証（メタデータサービス）", async () => {
      const result = (await accessibilityAuditHandler({
        url: "http://169.254.169.254/latest/meta-data/",
      })) as AccessibilityAuditOutput;
      expect(result.success).toBe(false);
    });
  });

  describe("正常系: HTML入力", () => {
    it("HTML入力でWCAG監査結果を返す", async () => {
      const result = (await accessibilityAuditHandler({
        html: "<html><body><h1>Test</h1></body></html>",
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.score).toBeDefined();
        expect(result.data.level).toBeDefined();
        expect(result.data.violations).toBeInstanceOf(Array);
        expect(result.data.summary).toBeDefined();
      }
    });

    it("include_contrast=true でコントラスト結果も含む", async () => {
      const result = (await accessibilityAuditHandler({
        html: "<html><body><p>Test</p></body></html>",
        include_contrast: true,
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contrast_issues).toBeDefined();
        expect(result.data.contrast_issues).toBeInstanceOf(Array);
      }
      expect(mockContrastService.checkHtmlContrast).toHaveBeenCalled();
    });

    it("include_contrast=false でコントラスト結果を含まない", async () => {
      const result = (await accessibilityAuditHandler({
        html: "<html><body><p>Test</p></body></html>",
        include_contrast: false,
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contrast_issues).toBeUndefined();
      }
      expect(mockContrastService.checkHtmlContrast).not.toHaveBeenCalled();
    });

    it("include_passes=true でpass情報を含む", async () => {
      const result = (await accessibilityAuditHandler({
        html: "<html><body><p>Test</p></body></html>",
        include_passes: true,
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(true);
      expect(mockAuditService.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ includePasses: true })
      );
    });

    it("level='AAA' でAAAレベル監査を実行", async () => {
      const aaaAuditService = createMockAuditService();
      aaaAuditService.audit.mockResolvedValue({
        score: 70,
        level: "AAA",
        violations: [],
        passes: [],
        summary: {
          totalViolations: 0,
          totalPasses: 5,
          critical: 0,
          serious: 0,
          moderate: 0,
          minor: 0,
        },
      });
      setAccessibilityAuditServiceFactory(() => aaaAuditService as never);

      const result = (await accessibilityAuditHandler({
        html: "<html><body><p>Test</p></body></html>",
        level: "AAA",
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(true);
    });
  });

  describe("エラーハンドリング", () => {
    it("サービスエラー時にINTERNAL_ERRORを返す", async () => {
      mockAuditService.audit.mockRejectedValue(new Error("Service failed"));
      const result = (await accessibilityAuditHandler({
        html: "<html></html>",
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ACCESSIBILITY_AUDIT_ERROR_CODES.INTERNAL_ERROR);
        // sanitizeErrorMessage が適用されている（内部構造が漏洩しない）
        expect(result.error.message).not.toContain("Service failed");
      }
    });

    it("コントラストサービスエラー時もaudit結果は返す (graceful degradation)", async () => {
      mockContrastService.checkHtmlContrast.mockRejectedValue(new Error("Contrast check failed"));
      const result = (await accessibilityAuditHandler({
        html: "<html><body><p>Test</p></body></html>",
        include_contrast: true,
      })) as AccessibilityAuditOutput;

      // audit自体は成功すべき
      expect(result.success).toBe(true);
      if (result.success) {
        // コントラスト結果は空配列（graceful degradation）
        expect(result.data.contrast_issues).toEqual([]);
      }
    });

    it("DIファクトリ未登録時にSERVICE_UNAVAILABLEを返す", async () => {
      resetAccessibilityAuditServiceFactory();
      resetContrastCheckServiceFactory();

      const result = (await accessibilityAuditHandler({
        html: "<html></html>",
      })) as AccessibilityAuditOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ACCESSIBILITY_AUDIT_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });
  });

  describe("エラーコード定数", () => {
    it("全エラーコードが定義されている", () => {
      expect(ACCESSIBILITY_AUDIT_ERROR_CODES.VALIDATION_ERROR).toBeDefined();
      expect(ACCESSIBILITY_AUDIT_ERROR_CODES.INTERNAL_ERROR).toBeDefined();
      expect(ACCESSIBILITY_AUDIT_ERROR_CODES.SERVICE_UNAVAILABLE).toBeDefined();
      expect(ACCESSIBILITY_AUDIT_ERROR_CODES.SSRF_BLOCKED).toBeDefined();
      expect(ACCESSIBILITY_AUDIT_ERROR_CODES.FETCH_FAILED).toBeDefined();
    });
  });
});
