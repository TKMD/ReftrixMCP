// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 品質評価エンジン — quality.evaluate のコア評価ロジック
 *
 * evaluate.tool.ts からMCPツールハンドラーと分離された、
 * 品質評価の計算・パターン分析・推奨事項生成を担当するモジュール。
 *
 * 機能:
 * - AIクリシェ検出（静的パターンマッチング）
 * - 3軸評価（originality, craftsmanship, contextuality）
 * - パターン駆動評価（DB類似度ベースのスコア調整）
 * - コンテキスト付き推奨事項生成
 *
 * Quality evaluation engine — core evaluation logic separated from evaluate.tool.ts.
 * Handles quality scoring, pattern analysis, and recommendation generation.
 *
 * @module tools/quality/evaluate-engine
 */

import { logger, isDevelopment } from "../../utils/logger";
import { validateExternalUrl } from "../../utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";

import type {
  AxeAccessibilityService,
  AxeAccessibilityResult,
} from "../../services/quality/axe-accessibility.service";

import { ResponsiveQualityEvaluatorService } from "../../services/responsive/responsive-quality-evaluator.service";
import type {
  ResponsiveQualityResult,
  ResponsiveQualityEvaluationOptions,
} from "../../services/responsive/types";

import {
  scoreToGrade,
  type AxisScore,
  type ClicheDetection,
  type Recommendation,
  type PatternAnalysis,
  type ContextualRecommendation,
  type PatternComparison,
  type ResponsiveEvaluation,
} from "./schemas";

import type {
  IPatternMatcherService,
  SectionPatternMatch,
  MotionPatternMatch,
} from "../../services/quality/pattern-matcher.service";

import type { IQualityEvaluateService } from "../../services/quality/quality-evaluate.service.interface";

import type { PlaywrightAxeService } from "../../services/quality/playwright-axe.service";

// =====================================================
// 型定義
// =====================================================

/**
 * レスポンシブ評価オプション出力型
 * Zodスキーマのdefault値適用後の型
 */
type ResponsiveEvaluationOutput = ResponsiveEvaluation;

interface ClichePattern {
  type: string;
  description: string;
  severity: "high" | "medium" | "low";
  pattern: RegExp;
  location?: string;
}

/**
 * Craftsmanship評価結果（aXe統合版）
 */
export interface CraftsmanshipResult extends AxisScore {
  /** aXeアクセシビリティ評価結果（オプション） */
  axeResult: AxeAccessibilityResult | undefined;
  /** Playwrightを使用したか */
  usedPlaywright?: boolean;
  /** レスポンシブ品質評価結果（responsive_evaluation有効時） */
  responsiveResult?: ResponsiveQualityResult;
}

/**
 * Craftsmanship評価オプション
 */
export interface CraftsmanshipOptions {
  /** Playwrightを使用したランタイム検証を有効化 */
  use_playwright?: boolean;
  /** レスポンシブ評価オプション（Zodスキーマ出力型と一致） */
  responsive_evaluation?: ResponsiveEvaluationOutput;
}

/**
 * Craftsmanship評価に使用するサービス群
 */
export interface CraftsmanshipServices {
  /** JSDOM版 aXeサービス */
  axeService: AxeAccessibilityService;
  /** Playwright版 aXeサービス（利用不可の場合null） */
  playwrightAxeService: PlaywrightAxeService | null;
}

/**
 * パターン駆動評価の結果
 */
export interface PatternDrivenEvaluationResult {
  /** パターン分析結果 */
  patternAnalysis: PatternAnalysis;
  /** 調整後のスコア */
  adjustedScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  /** コンテキスト付き推奨事項 */
  contextualRecommendations: ContextualRecommendation[];
}

/**
 * パターン駆動評価に使用するサービス群
 */
export interface PatternEvaluationServices {
  /** パターンマッチャーサービス */
  patternMatcher: IPatternMatcherService;
  /** 品質評価サービス（Embedding生成用） */
  qualityService: IQualityEvaluateService;
}

// =====================================================
// AIクリシェパターン定義
// =====================================================

const GRADIENT_CLICHES: ClichePattern[] = [
  {
    type: "gradient",
    description: "AI典型のパープル-ピンクグラデーション（#667eea, #764ba2）",
    severity: "high",
    pattern: /#667eea|#764ba2|667eea|764ba2/i,
  },
  {
    type: "gradient",
    description: "AI典型のピンク-オレンジグラデーション（#f857a6, #ff5858）",
    severity: "high",
    pattern: /#f857a6|#ff5858|f857a6|ff5858/i,
  },
  {
    type: "gradient",
    description: "AI典型の青-紫グラデーション",
    severity: "medium",
    pattern: /linear-gradient\s*\([^)]*(?:#6366f1|#8b5cf6|#a855f7)[^)]*\)/i,
  },
];

const TEXT_CLICHES: ClichePattern[] = [
  {
    type: "text",
    description: 'AI典型フレーズ: "Transform Your Business"',
    severity: "high",
    pattern: /transform\s+your\s+business/i,
  },
  {
    type: "text",
    description: 'AI典型フレーズ: "Unlock the power"',
    severity: "high",
    pattern: /unlock\s+the\s+power/i,
  },
  {
    type: "text",
    description: 'AI典型フレーズ: "cutting-edge solutions"',
    severity: "medium",
    pattern: /cutting-edge\s+solutions?/i,
  },
  {
    type: "text",
    description: 'AI典型フレーズ: "seamless integration"',
    severity: "medium",
    pattern: /seamless(?:ly)?\s+integrat/i,
  },
  {
    type: "text",
    description: 'AI典型フレーズ: "Get Started Today"',
    severity: "medium",
    pattern: /get\s+started\s+today/i,
  },
  {
    type: "text",
    description: 'AI典型フレーズ: "Scale effortlessly"',
    severity: "low",
    pattern: /scale\s+effortlessly/i,
  },
];

const STYLE_CLICHES: ClichePattern[] = [
  {
    type: "button",
    description: "AI典型のピル型ボタン（border-radius: 9999px）",
    severity: "medium",
    pattern: /border-radius:\s*9999px/i,
  },
  {
    type: "shadow",
    description: "AI典型のシャドウパターン",
    severity: "low",
    pattern: /box-shadow:\s*0\s+4px\s+6px\s+rgba\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.1\s*\)/i,
  },
];

const ALL_CLICHE_PATTERNS = [...GRADIENT_CLICHES, ...TEXT_CLICHES, ...STYLE_CLICHES];

// =====================================================
// 評価ユーティリティ
// =====================================================

/**
 * AIクリシェを検出する
 * @internal テスト用にエクスポート
 */
export function detectCliches(html: string, strict: boolean): ClicheDetection {
  const detectedPatterns: ClicheDetection["patterns"] = [];

  for (const cliche of ALL_CLICHE_PATTERNS) {
    // strictモードでない場合、lowレベルのクリシェはスキップ
    if (!strict && cliche.severity === "low") {
      continue;
    }

    if (cliche.pattern.test(html)) {
      detectedPatterns.push({
        type: cliche.type,
        description: cliche.description,
        severity: cliche.severity,
        location: cliche.location,
      });
    }
  }

  return {
    detected: detectedPatterns.length > 0,
    count: detectedPatterns.length,
    patterns: detectedPatterns,
  };
}

/**
 * Originality（独自性）スコアを計算する
 * @internal テスト用にエクスポート
 */
export function evaluateOriginality(
  html: string,
  clicheDetection: ClicheDetection,
  strict: boolean
): AxisScore {
  // 基準スコア80からスタート（改善: v0.1.0）
  // - 100スタートだと「特徴なし=満点」となり不適切
  // - 80は「標準的なデザイン」の中央値として設定
  let score = 80;
  const details: string[] = [];

  // 基準スコアの説明を必ず追加（詳細が空にならないようにする）
  details.push("基準スコア80からの評価");

  // クリシェ検出によるペナルティ
  for (const pattern of clicheDetection.patterns) {
    switch (pattern.severity) {
      case "high":
        score -= strict ? 20 : 15;
        details.push(`高クリシェ検出: ${pattern.description}`);
        break;
      case "medium":
        score -= strict ? 12 : 8;
        details.push(`中クリシェ検出: ${pattern.description}`);
        break;
      case "low":
        score -= strict ? 5 : 3;
        details.push(`低クリシェ検出: ${pattern.description}`);
        break;
    }
  }

  // カスタムカラーパレット検出（ボーナス）
  const customColorVars = html.match(/--[a-z-]+-color:\s*#[0-9a-fA-F]{6}/gi);
  if (customColorVars && customColorVars.length >= 3) {
    score += 5;
    details.push("独自のカラーパレット使用");
  }

  // カスタムアニメーション検出（ボーナス）
  if (/@keyframes\s+[a-z]/i.test(html)) {
    score += 3;
    details.push("カスタムアニメーション使用");
  }

  // CSS変数使用（ボーナス）
  const cssVars = html.match(/var\(--[a-z-]+\)/gi);
  if (cssVars && cssVars.length >= 5) {
    score += 2;
    details.push("CSS変数を活用");
  }

  // スコアの範囲を0-100に制限
  score = Math.max(0, Math.min(100, score));

  // 改善: details は必ず定義する（空配列ではなく、最低1つの評価根拠を含む）
  return {
    score,
    grade: scoreToGrade(score),
    details, // 基準スコア説明が必ず含まれるため、常に1件以上
  };
}

/**
 * Craftsmanship（技巧）スコアを計算する（aXe-core統合版）
 *
 * aXe-coreによるWCAG 2.1 AA準拠チェックを実行し、
 * 違反に応じてスコアを調整する。
 *
 * ペナルティ:
 * - Critical違反: -20点
 * - Serious違反: -10点
 * - Moderate違反: -5点
 * - Minor違反: -2点
 *
 * @param html - 評価対象のHTML
 * @param options - 評価オプション（use_playwright等）
 * @param services - aXeサービスインスタンス（DI解決済み）
 */
export async function evaluateCraftsmanshipWithAxe(
  html: string,
  options: CraftsmanshipOptions = {},
  services: CraftsmanshipServices
): Promise<CraftsmanshipResult> {
  let score = 50; // 基本スコア
  const details: string[] = [];
  let axeResult: AxeAccessibilityResult | undefined;
  let usedPlaywright = false;

  // =====================================================
  // aXe アクセシビリティ検証（Playwright / JSDOM選択）
  // =====================================================
  try {
    // use_playwrightが指定されている場合、Playwright版を試行
    if (options.use_playwright) {
      if (services.playwrightAxeService) {
        // Playwright版で検証
        if (isDevelopment()) {
          logger.info("[Craftsmanship] Using Playwright aXe for runtime analysis");
        }

        axeResult = await services.playwrightAxeService.analyzeHtml(html);
        usedPlaywright = true;

        // aXe違反によるペナルティを適用
        const axePenalty = services.playwrightAxeService.calculateScorePenalty(axeResult);
        score += axePenalty;
        details.push("Playwright aXe: ランタイム検証");
      } else {
        // Playwrightが利用不可の場合、JSDOM版にフォールバック
        if (isDevelopment()) {
          logger.warn("[Craftsmanship] Playwright not available, falling back to JSDOM aXe");
        }
        details.push("Playwright利用不可: JSDOM版にフォールバック");
      }
    }

    // Playwrightを使用しなかった場合、JSDOM版を使用
    if (!usedPlaywright) {
      axeResult = await services.axeService.analyze(html);

      // aXe違反によるペナルティを適用
      const axePenalty = services.axeService.calculateScorePenalty(axeResult);
      score += axePenalty; // ペナルティは負の値
    }

    // 違反をdetailsに追加
    if (axeResult && axeResult.violations.length > 0) {
      for (const violation of axeResult.violations.slice(0, 5)) {
        const impactLabel = {
          critical: "CRITICAL",
          serious: "SERIOUS",
          moderate: "MODERATE",
          minor: "MINOR",
        }[violation.impact];
        details.push(`[${impactLabel}] ${violation.help} (${violation.nodes}箇所)`);
      }
      if (axeResult.violations.length > 5) {
        details.push(`... 他${axeResult.violations.length - 5}件の違反`);
      }
    }

    // aXeのパス数をボーナスとして加算
    if (axeResult && axeResult.passes > 20) {
      score += 5;
      details.push(`aXe: ${axeResult.passes}ルールパス`);
    }

    // WCAGレベルに応じたボーナス
    if (axeResult?.wcagLevel === "AAA") {
      score += 10;
      details.push("WCAG 2.1 AAA準拠");
    } else if (axeResult?.wcagLevel === "AA") {
      score += 5;
      details.push("WCAG 2.1 AA準拠");
    }

    if (isDevelopment()) {
      logger.info("[Craftsmanship] aXe analysis completed", {
        violations: axeResult?.violations.length ?? 0,
        passes: axeResult?.passes ?? 0,
        axeScore: axeResult?.score ?? 0,
        wcagLevel: axeResult?.wcagLevel ?? "N/A",
        usedPlaywright,
      });
    }
  } catch (error) {
    logger.warn("[Craftsmanship] aXe analysis failed, using static analysis only", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // aXeが失敗した場合は静的分析のみ
    details.push("aXe分析スキップ（エラー）");
  }

  // =====================================================
  // 静的分析（補助的な評価）
  // =====================================================

  // セマンティックHTML
  if (/<header[^>]*role="banner"/i.test(html) || /<header/i.test(html)) {
    score += 3;
    details.push("セマンティックなheader使用");
  }
  if (/<main[^>]*role="main"/i.test(html) || /<main/i.test(html)) {
    score += 3;
    details.push("セマンティックなmain使用");
  }
  if (/<nav[^>]*role="navigation"/i.test(html) || /<nav/i.test(html)) {
    score += 3;
    details.push("セマンティックなnav使用");
  }
  if (/<footer[^>]*role="contentinfo"/i.test(html) || /<footer/i.test(html)) {
    score += 2;
    details.push("セマンティックなfooter使用");
  }

  // レスポンシブデザイン
  if (/@media\s*\([^)]*(?:max|min)-width/i.test(html)) {
    score += 5;
    details.push("レスポンシブデザイン対応");
  }

  // モーション軽減対応
  if (/prefers-reduced-motion/i.test(html)) {
    score += 5;
    details.push("モーション軽減対応");
  }

  // モダンCSS機能
  if (/clamp\s*\(/i.test(html)) {
    score += 3;
    details.push("clamp関数使用");
  }
  if (/grid-template-columns/i.test(html)) {
    score += 3;
    details.push("CSS Grid使用");
  }
  if (/display:\s*flex/i.test(html)) {
    score += 2;
    details.push("Flexbox使用");
  }

  // モダンCSS機能（v0.1.0追加）
  // Container Queries
  if (/@container/i.test(html)) {
    score += 4;
    details.push("Container Queries使用（+4）");
  }

  // aspect-ratio
  if (/aspect-ratio\s*:/i.test(html)) {
    score += 3;
    details.push("aspect-ratio使用（+3）");
  }

  // CSS gap
  if (/gap\s*:\s*\d/i.test(html)) {
    score += 2;
    details.push("CSS gap使用（+2）");
  }

  // アクセシビリティ強化（v0.1.0追加）
  // スキップリンク
  if (
    /skip\s*to\s*main/i.test(html) ||
    /メインコンテンツへスキップ/i.test(html) ||
    /コンテンツへスキップ/i.test(html) ||
    (/class=["'][^"']*skip[^"']*link[^"']*["']/i.test(html) && /href=["']#/i.test(html))
  ) {
    score += 4;
    details.push("スキップリンク使用（+4）");
  }

  // :focus-visible
  if (/:focus-visible/i.test(html)) {
    score += 3;
    details.push(":focus-visible使用（+3）");
  }

  // prefers-color-scheme（ダークモード対応）
  if (/prefers-color-scheme/i.test(html)) {
    score += 3;
    details.push("prefers-color-scheme対応（+3）");
  }

  // パフォーマンス最適化（v0.1.0追加）
  // loading="lazy"
  if (/loading=["']?lazy["']?/i.test(html)) {
    score += 3;
    details.push('loading="lazy"使用（+3）');
  }

  // preload, prefetch, dns-prefetch
  if (/rel=["']?(?:preload|prefetch|dns-prefetch)["']?/i.test(html)) {
    score += 3;
    details.push("preload/prefetch使用（+3）");
  }

  // font-display
  if (/font-display\s*:\s*(?:swap|optional|fallback|block|auto)/i.test(html)) {
    score += 3;
    details.push("font-display使用（+3）");
  }

  // 画像のwidth/height属性（CLS対策）
  if (
    /<img[^>]+width=["']?\d+["']?[^>]+height=["']?\d+["']?/i.test(html) ||
    /<img[^>]+height=["']?\d+["']?[^>]+width=["']?\d+["']?/i.test(html)
  ) {
    score += 3;
    details.push("画像サイズ属性使用（+3）");
  }

  // ネガティブ評価
  // onclick属性（非推奨）
  const onclickCount = (html.match(/onclick=/gi) || []).length;
  if (onclickCount > 0) {
    score -= onclickCount * 3;
    details.push("インラインonclick使用（非推奨）");
  }

  // div多用
  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  const semanticCount = (
    html.match(/<(header|main|nav|footer|section|article|aside)[^>]*>/gi) || []
  ).length;
  if (divCount > 10 && semanticCount < 3) {
    score -= 5;
    details.push("divの過剰使用");
  }

  // =====================================================
  // レスポンシブ品質評価（Playwright実測定）
  // =====================================================
  let responsiveResult: ResponsiveQualityResult | undefined;

  if (options.responsive_evaluation?.enabled && options.responsive_evaluation.url) {
    const urlValidation = validateExternalUrl(options.responsive_evaluation.url);
    if (!urlValidation.valid) {
      details.push(`レスポンシブ評価スキップ: ${urlValidation.error}`);
      if (isDevelopment()) {
        logger.warn("[Craftsmanship] Responsive evaluation skipped (SSRF)", {
          url: options.responsive_evaluation.url,
          error: urlValidation.error,
        });
      }
    } else {
      // robots.txt チェック（RFC 9309準拠）
      const robotsResult = await isUrlAllowedByRobotsTxt(options.responsive_evaluation.url);
      if (!robotsResult.allowed) {
        details.push(`レスポンシブ評価スキップ: robots.txtによりブロック (${robotsResult.reason})`);
        if (isDevelopment()) {
          logger.warn("[Craftsmanship] Responsive evaluation blocked by robots.txt", {
            url: options.responsive_evaluation.url,
            domain: robotsResult.domain,
            reason: robotsResult.reason,
          });
        }
      } else {
        try {
          const evaluator = new ResponsiveQualityEvaluatorService();
          try {
            const responsiveOpts: ResponsiveQualityEvaluationOptions = {};
            if (options.responsive_evaluation.viewports) {
              responsiveOpts.viewports = options.responsive_evaluation.viewports;
            }
            if (options.responsive_evaluation.checks) {
              responsiveOpts.checks = options.responsive_evaluation.checks;
            }
            if (options.responsive_evaluation.timeout !== undefined) {
              responsiveOpts.timeout = options.responsive_evaluation.timeout;
            }
            responsiveResult = await evaluator.evaluate(
              options.responsive_evaluation.url,
              responsiveOpts
            );

            // レスポンシブスコアをcraftsmanshipに反映
            // 静的分析の「レスポンシブデザイン対応」ボーナスを実測値で置換
            // responsiveScore (0-100) を -10 ~ +15 の範囲でスコアに反映
            const responsiveBonus = Math.round((responsiveResult.overallScore - 50) * 0.3);
            score += responsiveBonus;
            details.push(
              `レスポンシブ品質実測: ${responsiveResult.overallScore}点（${responsiveBonus >= 0 ? "+" : ""}${responsiveBonus}）`
            );

            if (isDevelopment()) {
              logger.info("[Craftsmanship] Responsive evaluation completed", {
                url: options.responsive_evaluation.url,
                overallScore: responsiveResult.overallScore,
                responsiveBonus,
                evaluationTimeMs: responsiveResult.evaluationTimeMs,
              });
            }
          } finally {
            await evaluator.close();
          }
        } catch (error) {
          logger.warn("[Craftsmanship] Responsive evaluation failed", {
            url: options.responsive_evaluation.url,
            error: error instanceof Error ? error.message : String(error),
          });
          details.push("レスポンシブ品質評価スキップ（エラー）");
        }
      }
    }
  }

  // スコアの範囲を0-100に制限
  score = Math.max(0, Math.min(100, score));

  const result: CraftsmanshipResult = {
    score,
    grade: scoreToGrade(score),
    details: details.length > 0 ? details : undefined,
    axeResult,
    usedPlaywright,
  };

  if (responsiveResult) {
    result.responsiveResult = responsiveResult;
  }

  return result;
}

/**
 * Craftsmanship（技巧）スコアを計算する（同期版 - 後方互換性）
 *
 * aXe-coreを使用しない静的分析のみのバージョン
 * 軽量評価が必要な場合やaXeが利用できない環境で使用
 *
 * @internal エクスポートは内部使用のみ
 */
export function evaluateCraftsmanshipSync(html: string): AxisScore {
  let score = 50; // 基本スコア
  const details: string[] = [];

  // アクセシビリティ評価
  // セマンティックHTML
  if (/<header[^>]*role="banner"/i.test(html)) {
    score += 5;
    details.push("セマンティックなheader使用");
  }
  if (/<main[^>]*role="main"/i.test(html)) {
    score += 5;
    details.push("セマンティックなmain使用");
  }
  if (/<nav[^>]*role="navigation"/i.test(html)) {
    score += 5;
    details.push("セマンティックなnav使用");
  }
  if (/<footer[^>]*role="contentinfo"/i.test(html)) {
    score += 3;
    details.push("セマンティックなfooter使用");
  }

  // aria属性
  if (/aria-label(ledby)?=/i.test(html)) {
    score += 5;
    details.push("ARIA属性使用");
  }
  if (/aria-describedby=/i.test(html)) {
    score += 3;
    details.push("ARIA説明属性使用");
  }

  // 画像のalt属性
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  const imgsWithAlt = imgTags.filter((img) => /alt=/i.test(img));
  if (imgTags.length > 0 && imgsWithAlt.length === imgTags.length) {
    score += 5;
    details.push("全ての画像にalt属性");
  } else if (imgTags.length > 0 && imgsWithAlt.length < imgTags.length) {
    score -= 5;
    details.push("一部の画像にalt属性がない");
  }

  // レスポンシブデザイン
  if (/@media\s*\([^)]*(?:max|min)-width/i.test(html)) {
    score += 5;
    details.push("レスポンシブデザイン対応");
  }

  // モーション軽減対応
  if (/prefers-reduced-motion/i.test(html)) {
    score += 5;
    details.push("モーション軽減対応");
  }

  // viewport meta
  if (/<meta[^>]*name="viewport"/i.test(html)) {
    score += 3;
    details.push("viewport meta設定");
  }

  // lang属性
  if (/<html[^>]*lang=/i.test(html)) {
    score += 3;
    details.push("言語属性設定");
  }

  // モダンCSS機能
  if (/clamp\s*\(/i.test(html)) {
    score += 3;
    details.push("clamp関数使用");
  }
  if (/grid-template-columns/i.test(html)) {
    score += 3;
    details.push("CSS Grid使用");
  }
  if (/display:\s*flex/i.test(html)) {
    score += 2;
    details.push("Flexbox使用");
  }

  // ネガティブ評価
  // onclick属性（非推奨）
  const onclickCount = (html.match(/onclick=/gi) || []).length;
  if (onclickCount > 0) {
    score -= onclickCount * 3;
    details.push("インラインonclick使用（非推奨）");
  }

  // div多用
  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  const semanticCount = (
    html.match(/<(header|main|nav|footer|section|article|aside)[^>]*>/gi) || []
  ).length;
  if (divCount > 10 && semanticCount < 3) {
    score -= 5;
    details.push("divの過剰使用");
  }

  // スコアの範囲を0-100に制限
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    grade: scoreToGrade(score),
    details: details.length > 0 ? details : undefined,
  };
}

/**
 * Contextuality（文脈適合性）スコアを計算する
 */
export function evaluateContextuality(
  html: string,
  targetIndustry?: string,
  targetAudience?: string
): AxisScore {
  let score = 70; // 基本スコア
  const details: string[] = [];

  // 業界固有の評価
  if (targetIndustry) {
    const industryLower = targetIndustry.toLowerCase();

    // ヘルスケア
    if (industryLower === "healthcare" || industryLower === "health") {
      // 信頼性を示す要素
      if (/certification|certified|licensed|trust|secure/i.test(html)) {
        score += 10;
        details.push("ヘルスケア業界の信頼性要素");
      }
      // 落ち着いた色調
      if (/#[0-9a-f]{6}/gi.test(html)) {
        score += 5;
        details.push("業界適切なカラー使用");
      }
    }

    // 金融
    if (industryLower === "finance" || industryLower === "financial") {
      if (/security|secure|encrypt|protect|compliance/i.test(html)) {
        score += 10;
        details.push("金融業界のセキュリティ要素");
      }
    }

    // テクノロジー
    if (industryLower === "technology" || industryLower === "tech") {
      if (/api|integration|developer|documentation/i.test(html)) {
        score += 5;
        details.push("テック業界の技術要素");
      }
      // モダンなデザイン要素
      if (/linear-gradient|grid|flex/i.test(html)) {
        score += 5;
        details.push("モダンなデザイン");
      }
    }
  }

  // オーディエンス固有の評価
  if (targetAudience) {
    const audienceLower = targetAudience.toLowerCase();

    // エンタープライズ
    if (audienceLower === "enterprise" || audienceLower === "business") {
      if (/professional|enterprise|business|solutions/i.test(html)) {
        score += 5;
        details.push("エンタープライズ向けコンテンツ");
      }
      // CTAの明確さ
      if (/<button[^>]*>/i.test(html) && /contact|demo|trial/i.test(html)) {
        score += 5;
        details.push("ビジネス向けCTA");
      }
    }

    // 一般消費者
    if (audienceLower === "consumer" || audienceLower === "general") {
      if (/simple|easy|free|try/i.test(html)) {
        score += 5;
        details.push("消費者向けメッセージ");
      }
    }

    // プロフェッショナル
    if (audienceLower === "professionals" || audienceLower === "expert") {
      if (/advanced|professional|expert|technical/i.test(html)) {
        score += 5;
        details.push("専門家向けコンテンツ");
      }
    }
  }

  // 一般的な品質評価
  // 明確な構造
  if (/<header/i.test(html) && /<main/i.test(html) && /<footer/i.test(html)) {
    score += 5;
    details.push("明確なページ構造");
  }

  // CTA存在
  if (/<button/i.test(html) || /<a[^>]*class="[^"]*(?:cta|btn|button)/i.test(html)) {
    score += 3;
    details.push("明確なCTA");
  }

  // スコアの範囲を0-100に制限
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    grade: scoreToGrade(score),
    details: details.length > 0 ? details : undefined,
  };
}

/**
 * 推奨事項を生成する
 */
export function generateRecommendations(
  originality: AxisScore,
  craftsmanship: AxisScore,
  contextuality: AxisScore,
  clicheDetection: ClicheDetection
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  let recId = 1;

  // Originalityに関する推奨
  if (clicheDetection.detected) {
    for (const pattern of clicheDetection.patterns.slice(0, 3)) {
      recommendations.push({
        id: `rec-${recId++}`,
        category: "originality",
        priority: pattern.severity,
        title: `AIクリシェを回避: ${pattern.type}`,
        description: pattern.description,
        impact: pattern.severity === "high" ? 15 : pattern.severity === "medium" ? 10 : 5,
      });
    }
  }

  if (originality.score < 70) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: "originality",
      priority: "high",
      title: "独自のカラーパレットを使用する",
      description: "ブランド固有のカラーを定義し、CSS変数として管理してください",
      impact: 10,
    });
  }

  // Craftsmanshipに関する推奨
  if (craftsmanship.score < 80) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: "craftsmanship",
      priority: "high",
      title: "アクセシビリティを改善する",
      description: "ARIA属性、セマンティックHTML、画像のalt属性を追加してください",
      impact: 15,
    });
  }

  if (craftsmanship.details?.some((d) => d.includes("onclick"))) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: "craftsmanship",
      priority: "medium",
      title: "インラインイベントハンドラを削除する",
      description: "onclick属性の代わりにaddEventListenerを使用してください",
      impact: 8,
    });
  }

  // Contextualityに関する推奨
  if (contextuality.score < 75) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: "contextuality",
      priority: "medium",
      title: "ターゲット層に合わせたコンテンツ",
      description: "業界やオーディエンスに適したメッセージングを検討してください",
      impact: 10,
    });
  }

  // 優先度順にソート
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // 最大10件に制限
  return recommendations.slice(0, 10);
}

// =====================================================
// パターン駆動評価ユーティリティ (v0.1.0)
// =====================================================

/**
 * パターン類似度に基づいてスコアを調整する
 *
 * 調整ロジック:
 * - 高品質パターン(score>=85)との類似度が高い → スコアを上方修正
 * - 高品質パターンとの類似度が低い → 独自性ボーナス
 * - ユニークネススコアが高い → 独自性にボーナス
 *
 * @param baseScores - 静的分析による基礎スコア
 * @param similarSections - 類似セクションパターン
 * @param similarMotions - 類似モーションパターン
 * @param uniquenessScore - ユニークネススコア (0-100)
 * @returns 調整後のスコア
 */
export function adjustScoresWithPatterns(
  baseScores: { originality: number; craftsmanship: number; contextuality: number },
  similarSections: SectionPatternMatch[],
  similarMotions: MotionPatternMatch[],
  uniquenessScore: number
): { originality: number; craftsmanship: number; contextuality: number } {
  let { originality, craftsmanship, contextuality } = baseScores;

  // 高品質パターン(qualityScore >= 85)との類似度を計算
  const highQualitySections = similarSections.filter(
    (s) => s.qualityScore !== undefined && s.qualityScore >= 85
  );

  if (highQualitySections.length > 0) {
    // 高品質パターンとの平均類似度
    const avgSimilarity =
      highQualitySections.reduce((sum, s) => sum + s.similarity, 0) / highQualitySections.length;

    // craftsmanship: 高品質パターンとの類似度が高い場合、技巧スコアを上方修正
    // 理由: 高品質パターンに似ている = 良い実装パターンを踏襲している
    const craftsmanshipBonus = Math.round(avgSimilarity * 10); // 最大+10
    craftsmanship = Math.min(100, craftsmanship + craftsmanshipBonus);

    if (isDevelopment()) {
      logger.info("[PatternEval] High quality pattern similarity bonus", {
        avgSimilarity,
        craftsmanshipBonus,
      });
    }
  }

  // ユニークネススコアに基づく独自性調整
  // uniquenessScore: 0-100 (100 = 完全にユニーク)
  if (uniquenessScore >= 70) {
    // 高いユニークネス = 独自性ボーナス
    const originalityBonus = Math.round((uniquenessScore - 50) * 0.2); // 最大+10
    originality = Math.min(100, originality + originalityBonus);

    if (isDevelopment()) {
      logger.info("[PatternEval] High uniqueness bonus", {
        uniquenessScore,
        originalityBonus,
      });
    }
  } else if (uniquenessScore < 30) {
    // 低いユニークネス = 既存パターンとの重複が多い
    const originalityPenalty = Math.round((30 - uniquenessScore) * 0.3); // 最大-9
    originality = Math.max(0, originality - originalityPenalty);

    if (isDevelopment()) {
      logger.info("[PatternEval] Low uniqueness penalty", {
        uniquenessScore,
        originalityPenalty,
      });
    }
  }

  // モーションパターンの考慮
  if (similarMotions.length > 0) {
    // 良いモーションパターンとの類似は技巧にボーナス
    const motionSimilarityAvg =
      similarMotions.reduce((sum, m) => sum + m.similarity, 0) / similarMotions.length;

    if (motionSimilarityAvg >= 0.8) {
      // 高い類似度 = 良いアニメーションパターンを使用
      const motionBonus = Math.round((motionSimilarityAvg - 0.7) * 20); // 最大+6
      craftsmanship = Math.min(100, craftsmanship + motionBonus);
    }
  }

  return {
    originality: Math.round(originality),
    craftsmanship: Math.round(craftsmanship),
    contextuality: Math.round(contextuality),
  };
}

/**
 * パターン参照付きのコンテキスト推奨事項を生成する
 *
 * @param baseRecommendations - 静的分析による推奨事項
 * @param similarSections - 類似セクションパターン
 * @param similarMotions - 類似モーションパターン
 * @param scores - 現在のスコア
 * @returns コンテキスト付き推奨事項
 */
export function generateContextualRecommendations(
  baseRecommendations: Recommendation[],
  similarSections: SectionPatternMatch[],
  similarMotions: MotionPatternMatch[],
  scores: { originality: number; craftsmanship: number; contextuality: number }
): ContextualRecommendation[] {
  const contextualRecs: ContextualRecommendation[] = [];

  // 基本推奨事項をコンテキスト推奨に変換
  for (const rec of baseRecommendations) {
    const contextualRec: ContextualRecommendation = {
      id: rec.id,
      category: rec.category,
      priority: rec.priority,
      title: rec.title,
      description: rec.description,
      impact: rec.impact,
    };

    // 類似セクションから参照を追加
    const matchingSection = similarSections.find((s) => {
      // カテゴリに基づいてマッチするセクションを探す
      if (rec.category === "originality" && s.sectionType === "hero") {
        return s.qualityScore !== undefined && s.qualityScore >= 85;
      }
      if (
        rec.category === "craftsmanship" &&
        s.qualityScore !== undefined &&
        s.qualityScore >= 85
      ) {
        return true;
      }
      return false;
    });

    if (matchingSection) {
      contextualRec.referencePatternId = matchingSection.id;
      if (matchingSection.sourceUrl) {
        contextualRec.referenceUrl = matchingSection.sourceUrl;
      }
      contextualRec.patternInsight = `高品質パターン(スコア: ${matchingSection.qualityScore ?? 0})を参照`;
    }

    contextualRecs.push(contextualRec);
  }

  // 高品質セクションパターンからの追加推奨
  const highQualitySections = similarSections
    .filter((s) => s.qualityScore !== undefined && s.qualityScore >= 90)
    .slice(0, 3);

  for (const section of highQualitySections) {
    // 既に同じパターンIDの推奨がないか確認
    if (contextualRecs.some((r) => r.referencePatternId === section.id)) {
      continue;
    }

    contextualRecs.push({
      id: `pattern-rec-${section.id.substring(0, 8)}`,
      category: "general",
      priority: "medium",
      title: `高品質${section.sectionType}セクションパターンを参照`,
      description: `類似度${Math.round(section.similarity * 100)}%の高品質パターン（スコア: ${section.qualityScore ?? 0}）を参考にしてください`,
      impact: 8,
      referencePatternId: section.id,
      referenceUrl: section.sourceUrl,
      patternInsight: `セクションタイプ: ${section.sectionType}`,
    });
  }

  // モーションパターンからの追加推奨
  if (similarMotions.length > 0 && scores.craftsmanship < 80) {
    const topMotion = similarMotions[0];
    if (topMotion && topMotion.similarity >= 0.8) {
      contextualRecs.push({
        id: `motion-rec-${topMotion.id.substring(0, 8)}`,
        category: "craftsmanship",
        priority: "medium",
        title: "効果的なモーションパターンを検討",
        description: `類似度${Math.round(topMotion.similarity * 100)}%のモーションパターン（${topMotion.type}）を参考にアニメーションを改善できます`,
        impact: 6,
        referencePatternId: topMotion.id,
        patternInsight: `モーションタイプ: ${topMotion.type}, トリガー: ${topMotion.trigger}`,
      });
    }
  }

  // 優先度順にソート
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  contextualRecs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return contextualRecs.slice(0, 10);
}

/**
 * パターン駆動評価を実行する
 *
 * @param html - 評価対象のHTML
 * @param baseScores - 静的分析による基礎スコア
 * @param baseRecommendations - 静的分析による推奨事項
 * @param options - パターン比較オプション
 * @param services - パターン評価サービス（DI解決済み）
 * @returns パターン駆動評価結果（またはnull = フォールバック使用）
 */
export async function executePatternDrivenEvaluation(
  html: string,
  baseScores: { originality: number; craftsmanship: number; contextuality: number },
  baseRecommendations: Recommendation[],
  options: PatternComparison,
  services: PatternEvaluationServices
): Promise<PatternDrivenEvaluationResult | null> {
  try {
    const { patternMatcher, qualityService } = services;

    // 1. HTMLからテキスト表現を抽出
    const textRepresentation = patternMatcher.extractTextRepresentation(html);

    if (isDevelopment()) {
      logger.info("[PatternEval] Text representation extracted", {
        textLength: textRepresentation.length,
      });
    }

    // 2. Embedding生成
    let embedding: number[];
    try {
      embedding = await qualityService.generateEmbedding(textRepresentation);
    } catch (error) {
      logger.warn("[PatternEval] Embedding generation failed, using fallback", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }

    // 3. 類似セクションパターン検索
    let similarSections: SectionPatternMatch[] = [];
    try {
      similarSections = await patternMatcher.findSimilarSectionPatterns(embedding, {
        limit: options.maxPatterns,
        minSimilarity: options.minSimilarity,
      });
    } catch (error) {
      logger.warn("[PatternEval] Section pattern search failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      // セクション検索失敗は致命的ではないので続行
    }

    // 4. 類似モーションパターン検索
    let similarMotions: MotionPatternMatch[] = [];
    try {
      similarMotions = await patternMatcher.findSimilarMotionPatterns(embedding, {
        limit: options.maxPatterns,
        minSimilarity: options.minSimilarity,
      });
    } catch (error) {
      logger.warn("[PatternEval] Motion pattern search failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      // モーション検索失敗は致命的ではないので続行
    }

    // 5. ユニークネススコア計算
    let uniquenessScore = 50; // デフォルト
    try {
      uniquenessScore = await patternMatcher.calculateUniquenessScore(embedding);
      // 0-1 → 0-100 に変換
      uniquenessScore = Math.round(uniquenessScore * 100);
    } catch (error) {
      logger.warn("[PatternEval] Uniqueness calculation failed, using default", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // 6. パターン類似度平均を計算
    const allSimilarities = [
      ...similarSections.map((s) => s.similarity),
      ...similarMotions.map((m) => m.similarity),
    ];
    const patternSimilarityAvg =
      allSimilarities.length > 0
        ? allSimilarities.reduce((sum, s) => sum + s, 0) / allSimilarities.length
        : 0;

    // 7. スコア調整
    const adjustedScores = adjustScoresWithPatterns(
      baseScores,
      similarSections,
      similarMotions,
      uniquenessScore
    );

    // 8. コンテキスト付き推奨事項生成
    const contextualRecommendations = generateContextualRecommendations(
      baseRecommendations,
      similarSections,
      similarMotions,
      adjustedScores
    );

    // 9. パターン分析結果を構築
    const patternAnalysis: PatternAnalysis = {
      similarSections: similarSections.map((s) => ({
        id: s.id,
        type: s.sectionType,
        similarity: s.similarity,
        sourceUrl: s.sourceUrl,
        webPageId: s.webPageId,
      })),
      similarMotions: similarMotions.map((m) => ({
        id: m.id,
        type: m.type,
        category: m.trigger,
        similarity: m.similarity,
        webPageId: m.webPageId ?? undefined,
      })),
      benchmarksUsed: [], // ベンチマーク取得は将来実装
      uniquenessScore,
      patternSimilarityAvg,
      patternDrivenEnabled: true,
      fallbackUsed: false,
    };

    if (isDevelopment()) {
      logger.info("[PatternEval] Pattern-driven evaluation completed", {
        similarSectionsCount: similarSections.length,
        similarMotionsCount: similarMotions.length,
        uniquenessScore,
        patternSimilarityAvg,
        adjustedScores,
      });
    }

    return {
      patternAnalysis,
      adjustedScores,
      contextualRecommendations,
    };
  } catch (error) {
    logger.warn("[PatternEval] Pattern-driven evaluation failed, using fallback", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * フォールバック用のパターン分析結果を生成
 */
export function createFallbackPatternAnalysis(reason: string): PatternAnalysis {
  return {
    similarSections: [],
    similarMotions: [],
    benchmarksUsed: [],
    uniquenessScore: 50, // デフォルト
    patternSimilarityAvg: 0,
    patternDrivenEnabled: false,
    fallbackUsed: true,
    fallbackReason: reason,
  };
}
