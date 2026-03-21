// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.evaluate MCPツールハンドラー（v0.1.0 Pattern-Driven Evaluation）
 *
 * MCPツールインターフェース: 入力バリデーション、DI管理、レスポンス構築。
 * 品質評価エンジンロジックは evaluate-engine.ts に分離。
 *
 * @module tools/quality/evaluate.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import {
  formatZodError,
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
} from "../../utils/error-messages";

import { generateImprovements, calculateSummary } from "./improvement-utils";

import { AxeAccessibilityService } from "../../services/quality/axe-accessibility.service";

import type { ViewportQualityResult } from "../../services/responsive/types";

import {
  qualityEvaluateInputSchema,
  scoreToGrade,
  calculateWeightedScore,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type QualityEvaluateData,
  type QualityEvaluateUnifiedOutput,
  type Weights,
  type AxisScore,
  type Grade,
  type ImprovementCategory,
  type RecommendationPriority,
  type PatternAnalysis,
  type ContextualRecommendation,
  type PatternComparison,
  QUALITY_MCP_ERROR_CODES,
} from "./schemas";

import type { IPatternMatcherService } from "../../services/quality/pattern-matcher.service";

import type { IQualityEvaluateService } from "../../services/quality/quality-evaluate.service.interface";
import type { IBenchmarkService } from "../../services/quality/benchmark.service";

import type { PlaywrightAxeService } from "../../services/quality/playwright-axe.service";
import {
  createPlaywrightAxeService,
  isPlaywrightAvailable,
} from "../../services/quality/playwright-axe.service";

// 品質評価エンジンからのインポート
import {
  detectCliches,
  evaluateOriginality,
  evaluateCraftsmanshipWithAxe,
  evaluateCraftsmanshipSync,
  evaluateContextuality,
  generateRecommendations,
  executePatternDrivenEvaluation,
  createFallbackPatternAnalysis,
  type CraftsmanshipOptions,
} from "./evaluate-engine";

// =====================================================
// 後方互換性のための再エクスポート
// =====================================================

export { detectCliches, evaluateOriginality, evaluateCraftsmanshipSync };

export type { QualityEvaluateInput, QualityEvaluateOutput, QualityEvaluateUnifiedOutput };

// 拡張版インターフェースを services/quality から再エクスポート
export type {
  IQualityEvaluateService,
  SimilarSection,
  SimilarMotion,
  PatternReferences,
  QualityBenchmark,
  FindSimilarSectionsOptions,
  FindSimilarMotionsOptions,
} from "../../services/quality/quality-evaluate.service.interface";

// =====================================================
// DI Factories
// =====================================================

let serviceFactory: (() => IQualityEvaluateService) | null = null;
let benchmarkServiceFactory: (() => IBenchmarkService) | null = null;
let patternMatcherServiceFactory: (() => IPatternMatcherService) | null = null;

/**
 * IQualityEvaluateService ファクトリを設定
 *
 * @param factory - サービスファクトリ関数
 */
export function setQualityEvaluateServiceFactory(factory: () => IQualityEvaluateService): void {
  serviceFactory = factory;
}

/**
 * IQualityEvaluateService ファクトリをリセット（テスト用）
 */
export function resetQualityEvaluateServiceFactory(): void {
  serviceFactory = null;
}

/**
 * IBenchmarkService ファクトリを設定
 *
 * @param factory - ベンチマークサービスファクトリ関数
 */
export function setBenchmarkServiceFactory(factory: () => IBenchmarkService): void {
  benchmarkServiceFactory = factory;
}

/**
 * IBenchmarkService ファクトリをリセット（テスト用）
 */
export function resetBenchmarkServiceFactory(): void {
  benchmarkServiceFactory = null;
}

/**
 * 現在のBenchmarkServiceファクトリを取得（内部用）
 */
export function getBenchmarkServiceFactory(): (() => IBenchmarkService) | null {
  return benchmarkServiceFactory;
}

/**
 * IPatternMatcherService ファクトリを設定
 *
 * @param factory - パターンマッチャーサービスファクトリ関数
 */
export function setPatternMatcherServiceFactory(factory: () => IPatternMatcherService): void {
  patternMatcherServiceFactory = factory;
}

/**
 * IPatternMatcherService ファクトリをリセット（テスト用）
 */
export function resetPatternMatcherServiceFactory(): void {
  patternMatcherServiceFactory = null;
}

/**
 * 現在のPatternMatcherServiceファクトリを取得（内部用）
 */
export function getPatternMatcherServiceFactory(): (() => IPatternMatcherService) | null {
  return patternMatcherServiceFactory;
}

// =====================================================
// aXe Accessibility Service DI (JSDOM版)
// =====================================================

let axeServiceFactory: (() => AxeAccessibilityService) | null = null;

/**
 * AxeAccessibilityService ファクトリを設定
 *
 * @param factory - サービスファクトリ関数
 */
export function setAxeAccessibilityServiceFactory(factory: () => AxeAccessibilityService): void {
  axeServiceFactory = factory;
}

/**
 * AxeAccessibilityService ファクトリをリセット（テスト用）
 */
export function resetAxeAccessibilityServiceFactory(): void {
  axeServiceFactory = null;
}

/**
 * 現在のAxeAccessibilityServiceファクトリを取得（内部用）
 */
export function getAxeAccessibilityServiceFactory(): (() => AxeAccessibilityService) | null {
  return axeServiceFactory;
}

// デフォルトaXeサービスインスタンス（ファクトリが未設定の場合）
let defaultAxeService: AxeAccessibilityService | null = null;

/**
 * aXeサービスインスタンスを取得
 */
function getAxeService(): AxeAccessibilityService {
  if (axeServiceFactory) {
    return axeServiceFactory();
  }
  // デフォルトインスタンスを作成（シングルトン）
  if (!defaultAxeService) {
    defaultAxeService = new AxeAccessibilityService();
  }
  return defaultAxeService;
}

// =====================================================
// Playwright aXe Service DI (v0.1.0新規)
// =====================================================

let playwrightAxeServiceFactory: (() => PlaywrightAxeService) | null = null;
let defaultPlaywrightAxeService: PlaywrightAxeService | null = null;
let playwrightAvailabilityChecked = false;
let playwrightIsAvailable = false;

/**
 * PlaywrightAxeService ファクトリを設定
 *
 * @param factory - サービスファクトリ関数
 */
export function setPlaywrightAxeServiceFactory(factory: () => PlaywrightAxeService): void {
  playwrightAxeServiceFactory = factory;
}

/**
 * PlaywrightAxeService ファクトリをリセット（テスト用）
 */
export function resetPlaywrightAxeServiceFactory(): void {
  playwrightAxeServiceFactory = null;
  defaultPlaywrightAxeService = null;
}

/**
 * 現在のPlaywrightAxeServiceファクトリを取得（内部用）
 */
export function getPlaywrightAxeServiceFactory(): (() => PlaywrightAxeService) | null {
  return playwrightAxeServiceFactory;
}

/**
 * Playwright aXeサービスインスタンスを取得
 * Playwrightが利用不可の場合はnullを返す（Graceful Degradation）
 */
async function getPlaywrightAxeService(): Promise<PlaywrightAxeService | null> {
  // Playwright可用性をチェック（初回のみ）
  if (!playwrightAvailabilityChecked) {
    playwrightIsAvailable = await isPlaywrightAvailable();
    playwrightAvailabilityChecked = true;

    if (isDevelopment()) {
      logger.info("[PlaywrightAxe] Availability check", {
        available: playwrightIsAvailable,
      });
    }
  }

  // Playwright利用不可の場合はnull
  if (!playwrightIsAvailable) {
    return null;
  }

  // ファクトリが設定されている場合はそれを使用
  if (playwrightAxeServiceFactory) {
    return playwrightAxeServiceFactory();
  }

  // デフォルトインスタンスを作成（シングルトン）
  if (!defaultPlaywrightAxeService) {
    defaultPlaywrightAxeService = createPlaywrightAxeService();
  }

  return defaultPlaywrightAxeService;
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * quality.evaluate ツールハンドラー
 *
 * action パラメータにより動作を切り替え:
 * - "evaluate" (デフォルト): 品質評価を実行
 * - "suggest_improvements": 改善提案を生成
 */
export async function qualityEvaluateHandler(
  input: unknown
): Promise<QualityEvaluateUnifiedOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] quality.evaluate called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: QualityEvaluateInput;
  try {
    validated = qualityEvaluateInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorWithHints = createValidationErrorWithHints(error, "quality.evaluate");
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);
      const formattedErrors = formatZodError(error);

      if (isDevelopment()) {
        logger.error("[MCP Tool] quality.evaluate validation error", {
          errors: errorWithHints.errors,
        });
      }

      return {
        success: false,
        error: {
          code: QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error:\n${detailedMessage}`,
          details: {
            errors: formattedErrors,
            detailedErrors: errorWithHints.errors,
          },
        },
      };
    }
    throw error;
  }

  // action パラメータに基づいて処理を分岐
  const action = validated.action ?? "evaluate";

  if (isDevelopment()) {
    logger.info("[MCP Tool] quality.evaluate action", { action });
  }

  let html = validated.html;
  let pageId: string | undefined;

  // pageIdが指定されている場合はDBから取得
  if (validated.pageId && !html) {
    try {
      const service = serviceFactory?.();
      if (!service?.getPageById) {
        return {
          success: false,
          error: {
            code: QUALITY_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
            message: "Page service is not available",
          },
        };
      }

      const page = await service.getPageById(validated.pageId);
      if (!page) {
        return {
          success: false,
          error: {
            code: QUALITY_MCP_ERROR_CODES.PAGE_NOT_FOUND,
            message: `Page not found: ${validated.pageId}`,
          },
        };
      }

      html = page.htmlContent;
      pageId = page.id;
    } catch (error) {
      if (isDevelopment()) {
        logger.error("[MCP Tool] quality.evaluate DB error", { error });
      }
      return {
        success: false,
        error: {
          code: QUALITY_MCP_ERROR_CODES.DB_ERROR,
          message: error instanceof Error ? error.message : "Database error",
        },
      };
    }
  }

  if (!html) {
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: "No HTML content provided",
      },
    };
  }

  try {
    // デフォルト重み
    const weights: Weights = validated.weights ?? {
      originality: 0.35,
      craftsmanship: 0.4,
      contextuality: 0.25,
    };

    // AIクリシェ検出
    const clicheDetection = detectCliches(html, validated.strict);

    // 3軸評価（aXe統合版を使用）
    const originality = evaluateOriginality(html, clicheDetection, validated.strict);
    const craftsmanshipOpts: CraftsmanshipOptions = {
      use_playwright: validated.use_playwright,
    };
    if (validated.responsive_evaluation) {
      craftsmanshipOpts.responsive_evaluation = validated.responsive_evaluation;
    }

    // DI解決: aXeサービスインスタンスを取得
    const axeService = getAxeService();
    const playwrightAxeService = craftsmanshipOpts.use_playwright
      ? await getPlaywrightAxeService()
      : null;

    const craftsmanshipResult = await evaluateCraftsmanshipWithAxe(html, craftsmanshipOpts, {
      axeService,
      playwrightAxeService,
    });
    const craftsmanship: AxisScore = {
      score: craftsmanshipResult.score,
      grade: craftsmanshipResult.grade,
      details: craftsmanshipResult.details,
    };
    const contextuality = evaluateContextuality(
      html,
      validated.targetIndustry,
      validated.targetAudience
    );

    // aXeアクセシビリティ結果を保存（後でレスポンスに含める）
    const axeAccessibilityResult = craftsmanshipResult.axeResult;

    // 総合スコア計算
    const overall = calculateWeightedScore(
      originality.score,
      craftsmanship.score,
      contextuality.score,
      weights
    );
    const grade: Grade = scoreToGrade(overall);

    // ============================================
    // action: "suggest_improvements" ブランチ
    // ============================================
    if (action === "suggest_improvements") {
      // 評価データを構築
      const evaluation: QualityEvaluateData = {
        overall,
        grade,
        originality,
        craftsmanship,
        contextuality,
        clicheDetection,
        evaluatedAt: new Date().toISOString(),
      };

      // 改善提案を生成
      const improvements = generateImprovements(evaluation, html, {
        categories: validated.categories as ImprovementCategory[] | undefined,
        minPriority: validated.minPriority as RecommendationPriority | undefined,
        maxSuggestions: validated.maxSuggestions ?? 10,
      });

      // サマリーを計算
      const summary = calculateSummary(improvements);

      if (isDevelopment()) {
        logger.info("[MCP Tool] quality.evaluate action=suggest_improvements completed", {
          improvementCount: improvements.length,
          estimatedScoreGain: summary.estimatedScoreGain,
        });
      }

      return {
        success: true,
        action: "suggest_improvements" as const,
        data: {
          improvements,
          summary,
          generatedAt: new Date().toISOString(),
        },
      };
    }

    // ============================================
    // action: "evaluate" (デフォルト) ブランチ
    // ============================================

    // 推奨事項生成（基礎推奨事項）
    const baseRecommendations = validated.includeRecommendations
      ? generateRecommendations(originality, craftsmanship, contextuality, clicheDetection)
      : [];

    // 基礎スコア
    const baseScores = {
      originality: originality.score,
      craftsmanship: craftsmanship.score,
      contextuality: contextuality.score,
    };

    // ============================================
    // パターン駆動評価（v0.1.0新機能）
    // ============================================
    let patternAnalysis: PatternAnalysis | undefined;
    let contextualRecommendations: ContextualRecommendation[] | undefined;
    let finalOriginality = originality;
    let finalCraftsmanship = craftsmanship;
    let finalContextuality = contextuality;
    let finalOverall = overall;
    let finalGrade: Grade = grade;

    // パターン比較オプションのデフォルト値
    const patternComparisonOptions: PatternComparison = {
      enabled: validated.patternComparison?.enabled ?? true,
      minSimilarity: validated.patternComparison?.minSimilarity ?? 0.7,
      maxPatterns: validated.patternComparison?.maxPatterns ?? 5,
    };

    // パターン駆動評価が有効かつDIサービスが利用可能な場合
    if (patternComparisonOptions.enabled && patternMatcherServiceFactory && serviceFactory) {
      const patternResult = await executePatternDrivenEvaluation(
        html,
        baseScores,
        baseRecommendations,
        patternComparisonOptions,
        {
          patternMatcher: patternMatcherServiceFactory(),
          qualityService: serviceFactory(),
        }
      );

      if (patternResult) {
        // パターン駆動評価が成功
        patternAnalysis = patternResult.patternAnalysis;
        contextualRecommendations = patternResult.contextualRecommendations;

        // スコアを調整後の値で上書き
        finalOriginality = {
          ...originality,
          score: patternResult.adjustedScores.originality,
          grade: scoreToGrade(patternResult.adjustedScores.originality),
        };
        finalCraftsmanship = {
          ...craftsmanship,
          score: patternResult.adjustedScores.craftsmanship,
          grade: scoreToGrade(patternResult.adjustedScores.craftsmanship),
        };
        finalContextuality = {
          ...contextuality,
          score: patternResult.adjustedScores.contextuality,
          grade: scoreToGrade(patternResult.adjustedScores.contextuality),
        };

        // 総合スコア再計算
        finalOverall = calculateWeightedScore(
          patternResult.adjustedScores.originality,
          patternResult.adjustedScores.craftsmanship,
          patternResult.adjustedScores.contextuality,
          weights
        );
        finalGrade = scoreToGrade(finalOverall);

        if (isDevelopment()) {
          logger.info("[MCP Tool] Pattern-driven evaluation applied", {
            baseOverall: overall,
            finalOverall,
            patternSimilarityAvg: patternAnalysis.patternSimilarityAvg,
            uniquenessScore: patternAnalysis.uniquenessScore,
          });
        }
      } else {
        // パターン駆動評価が失敗（フォールバック）
        patternAnalysis = createFallbackPatternAnalysis("Pattern services unavailable");

        if (isDevelopment()) {
          logger.info("[MCP Tool] Pattern-driven evaluation fallback used");
        }
      }
    } else if (patternComparisonOptions.enabled) {
      // DIサービスが未登録の場合もフォールバック
      patternAnalysis = createFallbackPatternAnalysis("Pattern services unavailable");

      if (isDevelopment()) {
        logger.warn("[MCP Tool] Pattern services not registered, using fallback");
      }
    }

    // ============================================
    // レスポンス軽量化（v0.1.0 MCP-RESP-01）
    // ============================================
    const isSummaryMode = validated.summary === true;

    // summaryモード時の制限適用
    let truncatedRecommendations = baseRecommendations;
    let truncatedContextualRecommendations = contextualRecommendations;
    let truncatedPatternAnalysis = patternAnalysis;
    let truncatedClicheDetection = clicheDetection;
    let truncatedAxeResult = axeAccessibilityResult;

    if (isSummaryMode) {
      // 推奨事項: 最大3件（高優先度のみ）
      truncatedRecommendations = baseRecommendations
        .filter((r) => r.priority === "high")
        .slice(0, 3);

      // コンテキスト付き推奨事項: 最大3件
      if (contextualRecommendations) {
        truncatedContextualRecommendations = contextualRecommendations.slice(0, 3);
      }

      // パターン分析: 各配列を最大3件に制限
      if (patternAnalysis) {
        truncatedPatternAnalysis = {
          ...patternAnalysis,
          similarSections: patternAnalysis.similarSections.slice(0, 3),
          similarMotions: patternAnalysis.similarMotions.slice(0, 3),
          benchmarksUsed: patternAnalysis.benchmarksUsed.slice(0, 3),
        };
      }

      // クリシェ検出: 最大3件
      truncatedClicheDetection = {
        ...clicheDetection,
        patterns: clicheDetection.patterns.slice(0, 3),
      };

      // aXe違反: 最大5件
      if (axeAccessibilityResult) {
        truncatedAxeResult = {
          ...axeAccessibilityResult,
          violations: axeAccessibilityResult.violations.slice(0, 5),
        };
      }

      if (isDevelopment()) {
        logger.info("[MCP Tool] quality.evaluate summary mode applied", {
          originalRecommendations: baseRecommendations.length,
          truncatedRecommendations: truncatedRecommendations.length,
          originalPatternSections: patternAnalysis?.similarSections.length ?? 0,
          truncatedPatternSections: truncatedPatternAnalysis?.similarSections.length ?? 0,
        });
      }
    }

    // レスポンスデータ構築
    const data: QualityEvaluateData = {
      overall: finalOverall,
      grade: finalGrade,
      originality: finalOriginality,
      craftsmanship: finalCraftsmanship,
      contextuality: finalContextuality,
      clicheDetection: truncatedClicheDetection,
      evaluatedAt: new Date().toISOString(),
    };

    if (pageId) {
      data.pageId = pageId;
    }

    // 推奨事項（後方互換性のため baseRecommendations も含める）
    if (truncatedRecommendations.length > 0) {
      data.recommendations = truncatedRecommendations;
    }

    // コンテキスト付き推奨事項（v0.1.0新規）
    if (truncatedContextualRecommendations && truncatedContextualRecommendations.length > 0) {
      data.contextualRecommendations = truncatedContextualRecommendations;
    }

    // パターン分析結果（v0.1.0新規）
    if (truncatedPatternAnalysis) {
      data.patternAnalysis = truncatedPatternAnalysis;
    }

    // aXeアクセシビリティ結果（v0.1.0新規）
    if (truncatedAxeResult) {
      data.axeAccessibility = truncatedAxeResult;
    }

    // レスポンシブデザイン品質評価結果（v0.1.0新規）
    if (craftsmanshipResult.responsiveResult) {
      data.responsiveDesign = {
        overallScore: craftsmanshipResult.responsiveResult.overallScore,
        evaluationTimeMs: craftsmanshipResult.responsiveResult.evaluationTimeMs,
        viewportSummaries: craftsmanshipResult.responsiveResult.viewportResults.map(
          (vr: ViewportQualityResult) => {
            const totalTargets = vr.touchTargets.passed + vr.touchTargets.failed;
            const touchTargetScore =
              totalTargets > 0 ? Math.round((vr.touchTargets.passed / totalTargets) * 100) : 100;
            const readabilityScore =
              (vr.readability.fontSizeOk ? 33 : 0) +
              (vr.readability.lineLengthOk ? 33 : 0) +
              (vr.readability.lineHeightOk ? 34 : 0);
            const totalImages = vr.images.srcsetCount + vr.images.missingResponsive;
            const responsiveImageScore =
              totalImages > 0
                ? Math.round(
                    Math.min(
                      ((vr.images.srcsetCount + vr.images.pictureCount) / totalImages) * 100,
                      100
                    )
                  )
                : 100;

            return {
              viewport: vr.viewport.name,
              touchTargetScore,
              readabilityScore,
              overflowOk:
                !vr.overflow.horizontalScroll && vr.overflow.overflowElements.length === 0,
              responsiveImageScore,
            };
          }
        ),
      };
    }

    if (validated.weights) {
      data.weights = weights;
    }

    if (validated.targetIndustry) {
      data.targetIndustry = validated.targetIndustry;
    }

    if (validated.targetAudience) {
      data.targetAudience = validated.targetAudience;
    }

    // 評価コンテキストを追加（v0.1.0新規）
    if (validated.context) {
      data.evaluationContext = validated.context;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] quality.evaluate completed", {
        action,
        overall: finalOverall,
        grade: finalGrade,
        originality: finalOriginality.score,
        craftsmanship: finalCraftsmanship.score,
        contextuality: finalContextuality.score,
        clicheCount: clicheDetection.count,
        patternDrivenEnabled: patternAnalysis?.patternDrivenEnabled ?? false,
        fallbackUsed: patternAnalysis?.fallbackUsed ?? true,
        axeViolations: axeAccessibilityResult?.violations.length ?? 0,
        axeWcagLevel: axeAccessibilityResult?.wcagLevel ?? "N/A",
      });
    }

    // DB永続化処理（v0.1.0 MCP-QUALITY-02）
    // save_to_db: true かつ pageId が指定されている場合のみ保存
    if (validated.save_to_db && validated.pageId && serviceFactory) {
      try {
        const service = serviceFactory();
        // PatternReferences を構築
        const patternRefs = {
          similarSections: patternAnalysis?.similarSections?.map((s) => s.id) ?? [],
          similarMotions: patternAnalysis?.similarMotions?.map((m) => m.id) ?? [],
          benchmarksUsed: patternAnalysis?.benchmarksUsed?.map((b) => b.id) ?? [],
        };
        const evaluationId = await service.saveEvaluationWithPatterns(data, patternRefs);
        if (isDevelopment()) {
          logger.info("[MCP Tool] quality.evaluate saved to DB", {
            evaluationId,
            pageId: validated.pageId,
          });
        }
      } catch (saveError) {
        // Graceful degradation: 保存失敗時は警告ログを出力するが、評価結果は正常に返却
        logger.warn("[MCP Tool] quality.evaluate DB save failed (graceful degradation)", {
          pageId: validated.pageId,
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    }

    return {
      success: true,
      data,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error("[MCP Tool] quality.evaluate error", { error });
    }
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : "Evaluation failed",
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

export const qualityEvaluateToolDefinition = {
  name: "quality.evaluate",
  description:
    "Evaluate web design quality on 3 axes (originality, craftsmanship, contextuality) with AI cliche detection",
  annotations: {
    title: "Quality Evaluate",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      pageId: {
        type: "string",
        format: "uuid",
        description: "WebPage ID (UUID, from DB)",
      },
      html: {
        type: "string",
        minLength: 1,
        maxLength: 10000000,
        description: "HTML content (direct, max 10MB)",
      },
      weights: {
        type: "object",
        description: "Axis weights (sum 1.0)",
        properties: {
          originality: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.35,
            description: "Originality weight (default: 0.35)",
          },
          craftsmanship: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: "Craftsmanship weight (default: 0.4)",
          },
          contextuality: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.25,
            description: "Contextuality weight (default: 0.25)",
          },
        },
      },
      targetIndustry: {
        type: "string",
        maxLength: 100,
        description: "Target industry (e.g. healthcare, finance, technology)",
      },
      targetAudience: {
        type: "string",
        maxLength: 100,
        description: "Target audience (e.g. enterprise, consumer, professionals)",
      },
      includeRecommendations: {
        type: "boolean",
        default: true,
        description: "Include recommendations (default: true)",
      },
      strict: {
        type: "boolean",
        default: false,
        description: "Strict mode: stricter AI cliche detection (default: false)",
      },
      patternComparison: {
        type: "object",
        description: "Pattern comparison options for pattern-driven evaluation (v0.1.0)",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            description: "Enable pattern comparison (default: true)",
          },
          minSimilarity: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.7,
            description: "Minimum similarity threshold (default: 0.7)",
          },
          maxPatterns: {
            type: "number",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Maximum patterns to compare (default: 5)",
          },
        },
      },
      context: {
        type: "object",
        description: "Evaluation context (v0.1.0)",
        properties: {
          projectId: {
            type: "string",
            format: "uuid",
            description: "Project ID (UUID)",
          },
          brandPaletteId: {
            type: "string",
            format: "uuid",
            description: "Brand palette ID (UUID)",
          },
          targetIndustry: {
            type: "string",
            maxLength: 100,
            description: "Target industry",
          },
          targetAudience: {
            type: "string",
            maxLength: 100,
            description: "Target audience",
          },
        },
      },
      use_playwright: {
        type: "boolean",
        default: false,
        description:
          "Use Playwright for runtime aXe accessibility testing (default: false, uses JSDOM)",
      },
      responsive_evaluation: {
        type: "object",
        description:
          "Responsive quality evaluation using Playwright (v0.1.0). " +
          "Measures touch targets, readability, overflow, and responsive images across viewports.",
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            description: "Enable responsive evaluation (default: false)",
          },
          url: {
            type: "string",
            format: "uri",
            description: "URL to evaluate (required when enabled)",
          },
          viewports: {
            type: "array",
            description: "Viewports to evaluate (default: desktop/tablet/mobile)",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                width: { type: "number", minimum: 320, maximum: 3840 },
                height: { type: "number", minimum: 480, maximum: 2160 },
              },
            },
          },
          checks: {
            type: "object",
            description: "Quality checks to run",
            properties: {
              touchTargets: { type: "boolean", default: true },
              readability: { type: "boolean", default: true },
              overflow: { type: "boolean", default: true },
              images: { type: "boolean", default: true },
            },
          },
          timeout: {
            type: "number",
            minimum: 5000,
            maximum: 120000,
            default: 30000,
            description: "Timeout in ms (default: 30000)",
          },
        },
      },
      summary: {
        type: "boolean",
        default: true,
        description:
          "Lightweight mode: exclude detailed info and return summary only (v0.1.0 MCP-RESP-01, v0.1.0 default true). " +
          "When true (default): recommendations max 3, contextualRecommendations max 3, patternAnalysis arrays max 3, " +
          "axeAccessibility.violations max 5, clicheDetection.patterns max 3. Set to false for full details.",
      },
    },
  },
};
