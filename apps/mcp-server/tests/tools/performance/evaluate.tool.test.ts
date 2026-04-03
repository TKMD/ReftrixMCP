// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * performance.evaluate MCPツールのテスト
 * TDD Red Phase: テスト先行
 *
 * テスト対象:
 * - Zodバリデーション
 * - SSRF検証
 * - CWVサービスDI
 * - パフォーマンス評価サービスDI
 * - ハンドラーのレスポンス構造
 * - エラーハンドリング
 * - ツール定義の構造
 *
 * @module tests/tools/performance/evaluate.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  performanceEvaluateHandler,
  performanceEvaluateToolDefinition,
  performanceEvaluateInputSchema,
  setCoreWebVitalsServiceFactory,
  resetCoreWebVitalsServiceFactory,
  setPerformanceEvaluationServiceFactory,
  resetPerformanceEvaluationServiceFactory,
  PERFORMANCE_MCP_ERROR_CODES,
  type PerformanceEvaluateOutput,
} from "../../../src/tools/performance/evaluate.tool";
import type {
  ICoreWebVitalsService,
  CwvScoreResult,
} from "../../../src/services/performance/core-web-vitals.service";
import type {
  IPerformanceEvaluationService,
  PerformanceEvaluationResult,
} from "../../../src/services/performance/performance-evaluation.service";

// =====================================================
// モックサービス
// =====================================================

const MOCK_CWV_RESULT: CwvScoreResult = {
  score: 85,
  metrics: {
    lcp: { value: 2000, rating: "good", unit: "ms" },
    fid: { value: 80, rating: "good", unit: "ms" },
    cls: { value: 0.05, rating: "good", unit: "score" },
    inp: { value: 150, rating: "good", unit: "ms" },
    ttfb: { value: 600, rating: "good", unit: "ms" },
  },
  grade: "B",
  measuredAt: "2026-03-27T00:00:00.000Z",
};

const MOCK_EVALUATION_RESULT: PerformanceEvaluationResult = {
  score: 85,
  grade: "B",
  metrics: MOCK_CWV_RESULT.metrics,
  budgetComparisons: [
    { metric: "LCP", actual: 2000, budget: 2500, withinBudget: true, overagePercent: 0 },
    { metric: "FID", actual: 80, budget: 100, withinBudget: true, overagePercent: 0 },
    { metric: "CLS", actual: 0.05, budget: 0.1, withinBudget: true, overagePercent: 0 },
    { metric: "TTFB", actual: 600, budget: 800, withinBudget: true, overagePercent: 0 },
    { metric: "INP", actual: 150, budget: 200, withinBudget: true, overagePercent: 0 },
  ],
  recommendations: [],
  measuredAt: "2026-03-27T00:00:00.000Z",
};

function createMockCwvService(): ICoreWebVitalsService {
  return {
    measure: vi.fn().mockResolvedValue(MOCK_CWV_RESULT),
  };
}

function createMockPerfEvalService(): IPerformanceEvaluationService {
  return {
    evaluate: vi.fn().mockReturnValue(MOCK_EVALUATION_RESULT),
  };
}

// =====================================================
// テストセットアップ
// =====================================================

describe("performance.evaluate MCP Tool", () => {
  let mockCwvService: ICoreWebVitalsService;
  let mockPerfEvalService: IPerformanceEvaluationService;

  beforeEach(() => {
    mockCwvService = createMockCwvService();
    mockPerfEvalService = createMockPerfEvalService();
    setCoreWebVitalsServiceFactory(() => mockCwvService);
    setPerformanceEvaluationServiceFactory(() => mockPerfEvalService);
  });

  afterEach(() => {
    resetCoreWebVitalsServiceFactory();
    resetPerformanceEvaluationServiceFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // ツール定義テスト
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が正しい", () => {
      expect(performanceEvaluateToolDefinition.name).toBe("performance.evaluate");
    });

    it("descriptionが存在する", () => {
      expect(performanceEvaluateToolDefinition.description.length).toBeGreaterThan(0);
    });

    it("inputSchemaにurlプロパティがある", () => {
      expect(performanceEvaluateToolDefinition.inputSchema.properties.url).toBeDefined();
    });

    it("urlが必須パラメータ", () => {
      expect(performanceEvaluateToolDefinition.inputSchema.required).toContain("url");
    });

    it("annotationsが正しい", () => {
      expect(performanceEvaluateToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(performanceEvaluateToolDefinition.annotations.idempotentHint).toBe(true);
    });
  });

  // =====================================================
  // 入力バリデーションテスト
  // =====================================================

  describe("入力バリデーション", () => {
    it("有効なURLで成功", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("URL無しでバリデーションエラー", async () => {
      const result = (await performanceEvaluateHandler({})) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it("空文字URLでバリデーションエラー", async () => {
      const result = (await performanceEvaluateHandler({
        url: "",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it("超長URLでバリデーションエラー", async () => {
      const longUrl = "https://example.com/" + "a".repeat(3000);
      const result = (await performanceEvaluateHandler({
        url: longUrl,
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it("include_detailsはboolean", async () => {
      const parsed = performanceEvaluateInputSchema.parse({
        url: "https://example.com",
        include_details: true,
      });
      expect(parsed.include_details).toBe(true);
    });

    it("budgetパラメータが正しくパースされる", async () => {
      const parsed = performanceEvaluateInputSchema.parse({
        url: "https://example.com",
        budget: {
          lcp_ms: 3000,
          cls: 0.2,
        },
      });
      expect(parsed.budget?.lcp_ms).toBe(3000);
      expect(parsed.budget?.cls).toBe(0.2);
    });
  });

  // =====================================================
  // SSRF検証テスト
  // =====================================================

  describe("SSRF検証", () => {
    it("プライベートIP（127.0.0.1）をブロック", async () => {
      const result = (await performanceEvaluateHandler({
        url: "http://127.0.0.1",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED);
    });

    it("プライベートIP（10.0.0.1）をブロック", async () => {
      const result = (await performanceEvaluateHandler({
        url: "http://10.0.0.1",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED);
    });

    it("プライベートIP（192.168.1.1）をブロック", async () => {
      const result = (await performanceEvaluateHandler({
        url: "http://192.168.1.1",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED);
    });

    it("localhostをブロック", async () => {
      const result = (await performanceEvaluateHandler({
        url: "http://localhost:3000",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED);
    });

    it("外部URLを許可", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // レスポンス構造テスト
  // =====================================================

  describe("レスポンス構造", () => {
    it("成功時にscoreとgradeを返す", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(true);
      expect(result.data?.score).toBe(85);
      expect(result.data?.grade).toBe("B");
    });

    it("成功時にmetricsを返す", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.data?.metrics).toBeDefined();
      expect(result.data?.metrics.lcp).toBeDefined();
      expect(result.data?.metrics.fid).toBeDefined();
      expect(result.data?.metrics.cls).toBeDefined();
      expect(result.data?.metrics.inp).toBeDefined();
      expect(result.data?.metrics.ttfb).toBeDefined();
    });

    it("各メトリクスにvalue, rating, unitが含まれる", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      const lcp = result.data?.metrics.lcp;
      expect(lcp?.value).toBeDefined();
      expect(lcp?.rating).toBeDefined();
      expect(lcp?.unit).toBeDefined();
    });

    it("include_details=false → budgetComparisonsとrecommendationsが含まれない", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
        include_details: false,
      })) as PerformanceEvaluateOutput;

      expect(result.data?.budgetComparisons).toBeUndefined();
      expect(result.data?.recommendations).toBeUndefined();
    });

    it("include_details=true → budgetComparisonsとrecommendationsが含まれる", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
        include_details: true,
      })) as PerformanceEvaluateOutput;

      expect(result.data?.budgetComparisons).toBeDefined();
      expect(result.data?.recommendations).toBeDefined();
    });

    it("成功時にmeasuredAtを返す", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.data?.measuredAt).toBeDefined();
    });

    it("成功時にurlを返す", async () => {
      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.data?.url).toBe("https://example.com");
    });
  });

  // =====================================================
  // DIサービス統合テスト
  // =====================================================

  describe("DIサービス統合", () => {
    it("CWVサービスのmeasureが呼ばれる", async () => {
      await performanceEvaluateHandler({ url: "https://example.com" });
      expect(mockCwvService.measure).toHaveBeenCalledWith("https://example.com");
    });

    it("PerformanceEvaluationServiceのevaluateが呼ばれる", async () => {
      await performanceEvaluateHandler({ url: "https://example.com" });
      expect(mockPerfEvalService.evaluate).toHaveBeenCalledWith(MOCK_CWV_RESULT, undefined);
    });

    it("カスタムBudgetがevaluateに渡される", async () => {
      await performanceEvaluateHandler({
        url: "https://example.com",
        budget: { lcp_ms: 3000, cls: 0.2 },
      });
      expect(mockPerfEvalService.evaluate).toHaveBeenCalledWith(
        MOCK_CWV_RESULT,
        expect.objectContaining({ lcpMs: 3000, cls: 0.2 })
      );
    });
  });

  // =====================================================
  // エラーハンドリングテスト
  // =====================================================

  describe("エラーハンドリング", () => {
    it("CWV計測失敗時にエラーレスポンスを返す", async () => {
      const failingService: ICoreWebVitalsService = {
        measure: vi.fn().mockRejectedValue(new Error("Browser crashed")),
      };
      setCoreWebVitalsServiceFactory(() => failingService);

      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(PERFORMANCE_MCP_ERROR_CODES.MEASUREMENT_FAILED);
    });

    it("エラーメッセージがサニタイズされる（内部構造が漏洩しない）", async () => {
      const failingService: ICoreWebVitalsService = {
        measure: vi.fn().mockRejectedValue(new Error("Connection to /var/run/postgres failed")),
      };
      setCoreWebVitalsServiceFactory(() => failingService);

      const result = (await performanceEvaluateHandler({
        url: "https://example.com",
      })) as PerformanceEvaluateOutput;

      expect(result.success).toBe(false);
      // sanitizeErrorMessageにより内部パスが隠蔽される
      expect(result.error?.message).toBeDefined();
    });
  });

  // =====================================================
  // エラーコード定義テスト
  // =====================================================

  describe("エラーコード", () => {
    it("全エラーコードが定義されている", () => {
      expect(PERFORMANCE_MCP_ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
      expect(PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED).toBe("SSRF_BLOCKED");
      expect(PERFORMANCE_MCP_ERROR_CODES.MEASUREMENT_FAILED).toBe("MEASUREMENT_FAILED");
      expect(PERFORMANCE_MCP_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
      expect(PERFORMANCE_MCP_ERROR_CODES.BROWSER_UNAVAILABLE).toBe("BROWSER_UNAVAILABLE");
    });
  });
});
