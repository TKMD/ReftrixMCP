// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * performance.evaluate MCPツール
 * Core Web Vitals + パフォーマンス評価
 *
 * Playwright PerformanceObserver APIでLCP/FID/CLS/INP/TTFB取得し、
 * Google基準に基づくパフォーマンススコアリング + 改善提案生成。
 *
 * セキュリティ:
 * - SSRF防止（validateExternalUrl使用）
 * - Zodバリデーション
 * - sanitizeErrorMessage使用
 * - NaN/Infinity防御
 *
 * @module tools/performance/evaluate.tool
 */

import { z } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl } from "../../utils/url-validator";
import {
  type ICoreWebVitalsService,
  type CwvScoreResult,
  CoreWebVitalsService,
} from "../../services/performance/core-web-vitals.service";
import {
  type IPerformanceEvaluationService,
  type PerformanceBudget,
  type PerformanceEvaluationResult,
  PerformanceEvaluationService,
  DEFAULT_PERFORMANCE_BUDGET,
} from "../../services/performance/performance-evaluation.service";

// =====================================================
// Error Codes / エラーコード
// =====================================================

export const PERFORMANCE_MCP_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  MEASUREMENT_FAILED: "MEASUREMENT_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  BROWSER_UNAVAILABLE: "BROWSER_UNAVAILABLE",
} as const;

export type PerformanceMcpErrorCode =
  (typeof PERFORMANCE_MCP_ERROR_CODES)[keyof typeof PERFORMANCE_MCP_ERROR_CODES];

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

const MAX_URL_LENGTH = 2048;

export const performanceEvaluateInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(MAX_URL_LENGTH)
    .describe(
      "評価対象のURL（SSRF検証済み）。" +
        " / Target URL for performance evaluation (SSRF validated)."
    ),
  include_details: z
    .boolean()
    .default(false)
    .describe(
      "詳細情報（Budget比較・改善提案）を含めるか（デフォルト: false）" +
        " / Include details (budget comparisons, recommendations) (default: false)"
    ),
  budget: z
    .object({
      lcp_ms: z.number().min(0).max(60000).optional().describe("LCP budget in ms (default: 2500)"),
      cls: z.number().min(0).max(10).optional().describe("CLS budget (default: 0.1)"),
      fid_ms: z.number().min(0).max(10000).optional().describe("FID budget in ms (default: 100)"),
      ttfb_ms: z.number().min(0).max(30000).optional().describe("TTFB budget in ms (default: 800)"),
      inp_ms: z.number().min(0).max(30000).optional().describe("INP budget in ms (default: 200)"),
    })
    .optional()
    .describe(
      "カスタムパフォーマンスBudget（省略時Google推奨値）" +
        " / Custom performance budget (defaults to Google recommended values)"
    ),
});

export type PerformanceEvaluateInput = z.infer<typeof performanceEvaluateInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface PerformanceEvaluateOutput {
  success: boolean;
  data?: {
    url: string;
    score: number;
    grade: string;
    metrics: {
      lcp: { value: number; rating: string; unit: string };
      fid: { value: number; rating: string; unit: string };
      cls: { value: number; rating: string; unit: string };
      inp: { value: number; rating: string; unit: string };
      ttfb: { value: number; rating: string; unit: string };
    };
    budgetComparisons?: Array<{
      metric: string;
      actual: number;
      budget: number;
      withinBudget: boolean;
      overagePercent: number;
    }>;
    recommendations?: Array<{
      metric: string;
      priority: string;
      suggestion: string;
      estimatedImpact: string;
    }>;
    measuredAt: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// DI Factories / DI ファクトリー
// =====================================================

const cwvServiceDI = createDIFactory<ICoreWebVitalsService>("CoreWebVitalsService");
export const setCoreWebVitalsServiceFactory = cwvServiceDI.set;
export const resetCoreWebVitalsServiceFactory = cwvServiceDI.reset;

const perfEvalServiceDI = createDIFactory<IPerformanceEvaluationService>(
  "PerformanceEvaluationService"
);
export const setPerformanceEvaluationServiceFactory = perfEvalServiceDI.set;
export const resetPerformanceEvaluationServiceFactory = perfEvalServiceDI.reset;

// デフォルトサービスインスタンス
let defaultCwvService: CoreWebVitalsService | null = null;
let defaultPerfEvalService: PerformanceEvaluationService | null = null;

function getCwvService(): ICoreWebVitalsService {
  if (cwvServiceDI.get()) {
    return cwvServiceDI.get()!();
  }
  if (!defaultCwvService) {
    defaultCwvService = new CoreWebVitalsService();
  }
  return defaultCwvService;
}

function getPerfEvalService(): IPerformanceEvaluationService {
  if (perfEvalServiceDI.get()) {
    return perfEvalServiceDI.get()!();
  }
  if (!defaultPerfEvalService) {
    defaultPerfEvalService = new PerformanceEvaluationService();
  }
  return defaultPerfEvalService;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * performance.evaluate ツールハンドラー
 */
export async function performanceEvaluateHandler(
  input: unknown
): Promise<PerformanceEvaluateOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] performance.evaluate called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: PerformanceEvaluateInput;
  try {
    validated = performanceEvaluateInputSchema.parse(input);
  } catch (error) {
    logger.warn("[MCP Tool] performance.evaluate validation error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: {
        code: PERFORMANCE_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }

  // SSRF検証
  const urlValidation = validateExternalUrl(validated.url);
  if (!urlValidation.valid) {
    logger.warn("[MCP Tool] performance.evaluate SSRF blocked", {
      url: validated.url.slice(0, 100),
    });
    return {
      success: false,
      error: {
        code: PERFORMANCE_MCP_ERROR_CODES.SSRF_BLOCKED,
        message: `URL validation failed: ${urlValidation.error ?? "blocked by SSRF policy"}`,
      },
    };
  }

  try {
    // CWV計測
    const cwvService = getCwvService();
    const cwvResult: CwvScoreResult = await cwvService.measure(validated.url);

    // パフォーマンス評価
    const perfEvalService = getPerfEvalService();
    const budget = validated.budget ? buildBudgetFromInput(validated.budget) : undefined;
    const evaluation: PerformanceEvaluationResult = perfEvalService.evaluate(cwvResult, budget);

    // レスポンス構築
    const data: PerformanceEvaluateOutput["data"] = {
      url: validated.url,
      score: evaluation.score,
      grade: evaluation.grade,
      metrics: {
        lcp: {
          value: evaluation.metrics.lcp.value,
          rating: evaluation.metrics.lcp.rating,
          unit: evaluation.metrics.lcp.unit,
        },
        fid: {
          value: evaluation.metrics.fid.value,
          rating: evaluation.metrics.fid.rating,
          unit: evaluation.metrics.fid.unit,
        },
        cls: {
          value: evaluation.metrics.cls.value,
          rating: evaluation.metrics.cls.rating,
          unit: evaluation.metrics.cls.unit,
        },
        inp: {
          value: evaluation.metrics.inp.value,
          rating: evaluation.metrics.inp.rating,
          unit: evaluation.metrics.inp.unit,
        },
        ttfb: {
          value: evaluation.metrics.ttfb.value,
          rating: evaluation.metrics.ttfb.rating,
          unit: evaluation.metrics.ttfb.unit,
        },
      },
      measuredAt: evaluation.measuredAt,
    };

    // 詳細情報
    if (validated.include_details) {
      data.budgetComparisons = evaluation.budgetComparisons;
      data.recommendations = evaluation.recommendations;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] performance.evaluate completed", {
        url: validated.url.slice(0, 80),
        score: evaluation.score,
        grade: evaluation.grade,
        lcpRating: evaluation.metrics.lcp.rating,
        clsRating: evaluation.metrics.cls.rating,
      });
    }

    return { success: true, data };
  } catch (error) {
    logger.warn("[MCP Tool] performance.evaluate error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: {
        code: PERFORMANCE_MCP_ERROR_CODES.MEASUREMENT_FAILED,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// Helper / ヘルパー
// =====================================================

/**
 * 入力BudgetオブジェクトからPerformanceBudgetを構築
 */
function buildBudgetFromInput(
  input: NonNullable<PerformanceEvaluateInput["budget"]>
): PerformanceBudget {
  return {
    lcpMs: Number.isFinite(input.lcp_ms) ? input.lcp_ms! : DEFAULT_PERFORMANCE_BUDGET.lcpMs,
    cls: Number.isFinite(input.cls) ? input.cls! : DEFAULT_PERFORMANCE_BUDGET.cls,
    fidMs: Number.isFinite(input.fid_ms) ? input.fid_ms! : DEFAULT_PERFORMANCE_BUDGET.fidMs,
    ttfbMs: Number.isFinite(input.ttfb_ms) ? input.ttfb_ms! : DEFAULT_PERFORMANCE_BUDGET.ttfbMs,
    inpMs: Number.isFinite(input.inp_ms) ? input.inp_ms! : DEFAULT_PERFORMANCE_BUDGET.inpMs,
  };
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const performanceEvaluateToolDefinition = {
  name: "performance.evaluate",
  description:
    "Evaluate web page performance using Core Web Vitals (LCP, FID, CLS, INP, TTFB) via Playwright PerformanceObserver API. " +
    "Returns a score (0-100), grade, and optional improvement recommendations.",
  annotations: {
    title: "Performance Evaluate",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        minLength: 1,
        maxLength: MAX_URL_LENGTH,
        description:
          "Target URL for performance evaluation (SSRF validated). " +
          "Must be an external URL (private IPs blocked).",
      },
      include_details: {
        type: "boolean",
        default: false,
        description:
          "Include budget comparisons and improvement recommendations (default: false). " +
          "Set to true for detailed performance analysis.",
      },
      budget: {
        type: "object",
        description:
          "Custom performance budget. Defaults to Google recommended values: " +
          "LCP < 2.5s, CLS < 0.1, FID < 100ms, TTFB < 800ms, INP < 200ms.",
        properties: {
          lcp_ms: {
            type: "number",
            minimum: 0,
            maximum: 60000,
            description: "LCP budget in ms (default: 2500)",
          },
          cls: {
            type: "number",
            minimum: 0,
            maximum: 10,
            description: "CLS budget (default: 0.1)",
          },
          fid_ms: {
            type: "number",
            minimum: 0,
            maximum: 10000,
            description: "FID budget in ms (default: 100)",
          },
          ttfb_ms: {
            type: "number",
            minimum: 0,
            maximum: 30000,
            description: "TTFB budget in ms (default: 800)",
          },
          inp_ms: {
            type: "number",
            minimum: 0,
            maximum: 30000,
            description: "INP budget in ms (default: 200)",
          },
        },
      },
    },
  },
};
