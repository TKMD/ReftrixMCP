// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.evaluate MCPツール（v0.1.0 Pattern-Driven Evaluation）
 *
 * Webデザインの品質を3軸（独自性・技巧・文脈適合性）で評価し、
 * データベース内のパターンとの比較によりスコアを調整します。
 *
 * 機能:
 * - 3軸評価（originality, craftsmanship, contextuality）
 * - AIクリシェ検出（静的分析）
 * - パターン駆動評価（DBパターンとの類似度比較）
 * - コンテキスト付き推奨事項生成（パターン参照付き）
 * - 重み付けスコア計算
 * - 業界・オーディエンス適合評価
 *
 * パターン駆動評価フロー:
 * 1. HTMLからテキスト表現を抽出
 * 2. Embedding生成（768次元）
 * 3. 類似セクションパターン検索
 * 4. 類似モーションパターン検索
 * 5. 高品質ベンチマーク取得
 * 6. 静的分析で基礎スコア計算
 * 7. パターン類似度によるスコア調整
 * 8. ユニークネススコア計算
 * 9. コンテキスト付き推奨事項生成
 *
 * @module tools/quality/evaluate.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  formatZodError,
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
} from '../../utils/error-messages';

import { generateImprovements, calculateSummary } from './improvement-utils';

import {
  AxeAccessibilityService,
  type AxeAccessibilityResult,
} from '../../services/quality/axe-accessibility.service';

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
  type ClicheDetection,
  type Recommendation,
  type Grade,
  type ImprovementCategory,
  type RecommendationPriority,
  type PatternAnalysis,
  type ContextualRecommendation,
  type PatternComparison,
  QUALITY_MCP_ERROR_CODES,
} from './schemas';

import type {
  IPatternMatcherService,
  SectionPatternMatch,
  MotionPatternMatch,
} from '../../services/quality/pattern-matcher.service';

// =====================================================
// 型定義
// =====================================================

export type { QualityEvaluateInput, QualityEvaluateOutput, QualityEvaluateUnifiedOutput };

// =====================================================
// サービスインターフェース（DI用）
// =====================================================

// 拡張版インターフェースを services/quality から再エクスポート
export type {
  IQualityEvaluateService,
  SimilarSection,
  SimilarMotion,
  PatternReferences,
  QualityBenchmark,
  FindSimilarSectionsOptions,
  FindSimilarMotionsOptions,
} from '../../services/quality/quality-evaluate.service.interface';

import type { IQualityEvaluateService } from '../../services/quality/quality-evaluate.service.interface';
import type { IBenchmarkService } from '../../services/quality/benchmark.service';

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
export function setQualityEvaluateServiceFactory(
  factory: () => IQualityEvaluateService
): void {
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
export function setBenchmarkServiceFactory(
  factory: () => IBenchmarkService
): void {
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
export function setPatternMatcherServiceFactory(
  factory: () => IPatternMatcherService
): void {
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
export function setAxeAccessibilityServiceFactory(
  factory: () => AxeAccessibilityService
): void {
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

import type {
  PlaywrightAxeService} from '../../services/quality/playwright-axe.service';
import {
  createPlaywrightAxeService,
  isPlaywrightAvailable,
} from '../../services/quality/playwright-axe.service';

let playwrightAxeServiceFactory: (() => PlaywrightAxeService) | null = null;
let defaultPlaywrightAxeService: PlaywrightAxeService | null = null;
let playwrightAvailabilityChecked = false;
let playwrightIsAvailable = false;

/**
 * PlaywrightAxeService ファクトリを設定
 *
 * @param factory - サービスファクトリ関数
 */
export function setPlaywrightAxeServiceFactory(
  factory: () => PlaywrightAxeService
): void {
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
      logger.info('[PlaywrightAxe] Availability check', {
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
// AIクリシェパターン定義
// =====================================================

interface ClichePattern {
  type: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  pattern: RegExp;
  location?: string;
}

const GRADIENT_CLICHES: ClichePattern[] = [
  {
    type: 'gradient',
    description: 'AI典型のパープル-ピンクグラデーション（#667eea, #764ba2）',
    severity: 'high',
    pattern: /#667eea|#764ba2|667eea|764ba2/i,
  },
  {
    type: 'gradient',
    description: 'AI典型のピンク-オレンジグラデーション（#f857a6, #ff5858）',
    severity: 'high',
    pattern: /#f857a6|#ff5858|f857a6|ff5858/i,
  },
  {
    type: 'gradient',
    description: 'AI典型の青-紫グラデーション',
    severity: 'medium',
    pattern: /linear-gradient\s*\([^)]*(?:#6366f1|#8b5cf6|#a855f7)[^)]*\)/i,
  },
];

const TEXT_CLICHES: ClichePattern[] = [
  {
    type: 'text',
    description: 'AI典型フレーズ: "Transform Your Business"',
    severity: 'high',
    pattern: /transform\s+your\s+business/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Unlock the power"',
    severity: 'high',
    pattern: /unlock\s+the\s+power/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "cutting-edge solutions"',
    severity: 'medium',
    pattern: /cutting-edge\s+solutions?/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "seamless integration"',
    severity: 'medium',
    pattern: /seamless(?:ly)?\s+integrat/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Get Started Today"',
    severity: 'medium',
    pattern: /get\s+started\s+today/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Scale effortlessly"',
    severity: 'low',
    pattern: /scale\s+effortlessly/i,
  },
];

const STYLE_CLICHES: ClichePattern[] = [
  {
    type: 'button',
    description: 'AI典型のピル型ボタン（border-radius: 9999px）',
    severity: 'medium',
    pattern: /border-radius:\s*9999px/i,
  },
  {
    type: 'shadow',
    description: 'AI典型のシャドウパターン',
    severity: 'low',
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
  const detectedPatterns: ClicheDetection['patterns'] = [];

  for (const cliche of ALL_CLICHE_PATTERNS) {
    // strictモードでない場合、lowレベルのクリシェはスキップ
    if (!strict && cliche.severity === 'low') {
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
export function evaluateOriginality(html: string, clicheDetection: ClicheDetection, strict: boolean): AxisScore {
  // 基準スコア80からスタート（改善: v0.1.0）
  // - 100スタートだと「特徴なし=満点」となり不適切
  // - 80は「標準的なデザイン」の中央値として設定
  let score = 80;
  const details: string[] = [];

  // 基準スコアの説明を必ず追加（詳細が空にならないようにする）
  details.push('基準スコア80からの評価');

  // クリシェ検出によるペナルティ
  for (const pattern of clicheDetection.patterns) {
    switch (pattern.severity) {
      case 'high':
        score -= strict ? 20 : 15;
        details.push(`高クリシェ検出: ${pattern.description}`);
        break;
      case 'medium':
        score -= strict ? 12 : 8;
        details.push(`中クリシェ検出: ${pattern.description}`);
        break;
      case 'low':
        score -= strict ? 5 : 3;
        details.push(`低クリシェ検出: ${pattern.description}`);
        break;
    }
  }

  // カスタムカラーパレット検出（ボーナス）
  const customColorVars = html.match(/--[a-z-]+-color:\s*#[0-9a-fA-F]{6}/gi);
  if (customColorVars && customColorVars.length >= 3) {
    score += 5;
    details.push('独自のカラーパレット使用');
  }

  // カスタムアニメーション検出（ボーナス）
  if (/@keyframes\s+[a-z]/i.test(html)) {
    score += 3;
    details.push('カスタムアニメーション使用');
  }

  // CSS変数使用（ボーナス）
  const cssVars = html.match(/var\(--[a-z-]+\)/gi);
  if (cssVars && cssVars.length >= 5) {
    score += 2;
    details.push('CSS変数を活用');
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
 * Craftsmanship評価結果（aXe統合版）
 */
interface CraftsmanshipResult extends AxisScore {
  /** aXeアクセシビリティ評価結果（オプション） */
  axeResult: AxeAccessibilityResult | undefined;
  /** Playwrightを使用したか */
  usedPlaywright?: boolean;
}

/**
 * Craftsmanship評価オプション
 */
interface CraftsmanshipOptions {
  /** Playwrightを使用したランタイム検証を有効化 */
  use_playwright?: boolean;
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
 */
async function evaluateCraftsmanshipWithAxe(
  html: string,
  options: CraftsmanshipOptions = {}
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
      const playwrightService = await getPlaywrightAxeService();

      if (playwrightService) {
        // Playwright版で検証
        if (isDevelopment()) {
          logger.info('[Craftsmanship] Using Playwright aXe for runtime analysis');
        }

        axeResult = await playwrightService.analyzeHtml(html);
        usedPlaywright = true;

        // aXe違反によるペナルティを適用
        const axePenalty = playwrightService.calculateScorePenalty(axeResult);
        score += axePenalty;
        details.push('Playwright aXe: ランタイム検証');
      } else {
        // Playwrightが利用不可の場合、JSDOM版にフォールバック
        if (isDevelopment()) {
          logger.warn('[Craftsmanship] Playwright not available, falling back to JSDOM aXe');
        }
        details.push('Playwright利用不可: JSDOM版にフォールバック');
      }
    }

    // Playwrightを使用しなかった場合、JSDOM版を使用
    if (!usedPlaywright) {
      const axeService = getAxeService();
      axeResult = await axeService.analyze(html);

      // aXe違反によるペナルティを適用
      const axePenalty = axeService.calculateScorePenalty(axeResult);
      score += axePenalty; // ペナルティは負の値
    }

    // 違反をdetailsに追加
    if (axeResult && axeResult.violations.length > 0) {
      for (const violation of axeResult.violations.slice(0, 5)) {
        const impactLabel = {
          critical: 'CRITICAL',
          serious: 'SERIOUS',
          moderate: 'MODERATE',
          minor: 'MINOR',
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
    if (axeResult?.wcagLevel === 'AAA') {
      score += 10;
      details.push('WCAG 2.1 AAA準拠');
    } else if (axeResult?.wcagLevel === 'AA') {
      score += 5;
      details.push('WCAG 2.1 AA準拠');
    }

    if (isDevelopment()) {
      logger.info('[Craftsmanship] aXe analysis completed', {
        violations: axeResult?.violations.length ?? 0,
        passes: axeResult?.passes ?? 0,
        axeScore: axeResult?.score ?? 0,
        wcagLevel: axeResult?.wcagLevel ?? 'N/A',
        usedPlaywright,
      });
    }
  } catch (error) {
    if (isDevelopment()) {
      logger.warn('[Craftsmanship] aXe analysis failed, using static analysis only', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    // aXeが失敗した場合は静的分析のみ
    details.push('aXe分析スキップ（エラー）');
  }

  // =====================================================
  // 静的分析（補助的な評価）
  // =====================================================

  // セマンティックHTML
  if (/<header[^>]*role="banner"/i.test(html) || /<header/i.test(html)) {
    score += 3;
    details.push('セマンティックなheader使用');
  }
  if (/<main[^>]*role="main"/i.test(html) || /<main/i.test(html)) {
    score += 3;
    details.push('セマンティックなmain使用');
  }
  if (/<nav[^>]*role="navigation"/i.test(html) || /<nav/i.test(html)) {
    score += 3;
    details.push('セマンティックなnav使用');
  }
  if (/<footer[^>]*role="contentinfo"/i.test(html) || /<footer/i.test(html)) {
    score += 2;
    details.push('セマンティックなfooter使用');
  }

  // レスポンシブデザイン
  if (/@media\s*\([^)]*(?:max|min)-width/i.test(html)) {
    score += 5;
    details.push('レスポンシブデザイン対応');
  }

  // モーション軽減対応
  if (/prefers-reduced-motion/i.test(html)) {
    score += 5;
    details.push('モーション軽減対応');
  }

  // モダンCSS機能
  if (/clamp\s*\(/i.test(html)) {
    score += 3;
    details.push('clamp関数使用');
  }
  if (/grid-template-columns/i.test(html)) {
    score += 3;
    details.push('CSS Grid使用');
  }
  if (/display:\s*flex/i.test(html)) {
    score += 2;
    details.push('Flexbox使用');
  }

  // モダンCSS機能（v0.1.0追加）
  // Container Queries
  if (/@container/i.test(html)) {
    score += 4;
    details.push('Container Queries使用（+4）');
  }

  // aspect-ratio
  if (/aspect-ratio\s*:/i.test(html)) {
    score += 3;
    details.push('aspect-ratio使用（+3）');
  }

  // CSS gap
  if (/gap\s*:\s*\d/i.test(html)) {
    score += 2;
    details.push('CSS gap使用（+2）');
  }

  // アクセシビリティ強化（v0.1.0追加）
  // スキップリンク
  if (
    /skip\s*to\s*main/i.test(html) ||
    /メインコンテンツへスキップ/i.test(html) ||
    /コンテンツへスキップ/i.test(html) ||
    (/class=["'][^"']*skip[^"']*link[^"']*["']/i.test(html) &&
      /href=["']#/i.test(html))
  ) {
    score += 4;
    details.push('スキップリンク使用（+4）');
  }

  // :focus-visible
  if (/:focus-visible/i.test(html)) {
    score += 3;
    details.push(':focus-visible使用（+3）');
  }

  // prefers-color-scheme（ダークモード対応）
  if (/prefers-color-scheme/i.test(html)) {
    score += 3;
    details.push('prefers-color-scheme対応（+3）');
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
    details.push('preload/prefetch使用（+3）');
  }

  // font-display
  if (/font-display\s*:\s*(?:swap|optional|fallback|block|auto)/i.test(html)) {
    score += 3;
    details.push('font-display使用（+3）');
  }

  // 画像のwidth/height属性（CLS対策）
  if (
    /<img[^>]+width=["']?\d+["']?[^>]+height=["']?\d+["']?/i.test(html) ||
    /<img[^>]+height=["']?\d+["']?[^>]+width=["']?\d+["']?/i.test(html)
  ) {
    score += 3;
    details.push('画像サイズ属性使用（+3）');
  }

  // ネガティブ評価
  // onclick属性（非推奨）
  const onclickCount = (html.match(/onclick=/gi) || []).length;
  if (onclickCount > 0) {
    score -= onclickCount * 3;
    details.push('インラインonclick使用（非推奨）');
  }

  // div多用
  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  const semanticCount = (html.match(/<(header|main|nav|footer|section|article|aside)[^>]*>/gi) || []).length;
  if (divCount > 10 && semanticCount < 3) {
    score -= 5;
    details.push('divの過剰使用');
  }

  // スコアの範囲を0-100に制限
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    grade: scoreToGrade(score),
    details: details.length > 0 ? details : undefined,
    axeResult,
    usedPlaywright,
  };
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
    details.push('セマンティックなheader使用');
  }
  if (/<main[^>]*role="main"/i.test(html)) {
    score += 5;
    details.push('セマンティックなmain使用');
  }
  if (/<nav[^>]*role="navigation"/i.test(html)) {
    score += 5;
    details.push('セマンティックなnav使用');
  }
  if (/<footer[^>]*role="contentinfo"/i.test(html)) {
    score += 3;
    details.push('セマンティックなfooter使用');
  }

  // aria属性
  if (/aria-label(ledby)?=/i.test(html)) {
    score += 5;
    details.push('ARIA属性使用');
  }
  if (/aria-describedby=/i.test(html)) {
    score += 3;
    details.push('ARIA説明属性使用');
  }

  // 画像のalt属性
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  const imgsWithAlt = imgTags.filter((img) => /alt=/i.test(img));
  if (imgTags.length > 0 && imgsWithAlt.length === imgTags.length) {
    score += 5;
    details.push('全ての画像にalt属性');
  } else if (imgTags.length > 0 && imgsWithAlt.length < imgTags.length) {
    score -= 5;
    details.push('一部の画像にalt属性がない');
  }

  // レスポンシブデザイン
  if (/@media\s*\([^)]*(?:max|min)-width/i.test(html)) {
    score += 5;
    details.push('レスポンシブデザイン対応');
  }

  // モーション軽減対応
  if (/prefers-reduced-motion/i.test(html)) {
    score += 5;
    details.push('モーション軽減対応');
  }

  // viewport meta
  if (/<meta[^>]*name="viewport"/i.test(html)) {
    score += 3;
    details.push('viewport meta設定');
  }

  // lang属性
  if (/<html[^>]*lang=/i.test(html)) {
    score += 3;
    details.push('言語属性設定');
  }

  // モダンCSS機能
  if (/clamp\s*\(/i.test(html)) {
    score += 3;
    details.push('clamp関数使用');
  }
  if (/grid-template-columns/i.test(html)) {
    score += 3;
    details.push('CSS Grid使用');
  }
  if (/display:\s*flex/i.test(html)) {
    score += 2;
    details.push('Flexbox使用');
  }

  // ネガティブ評価
  // onclick属性（非推奨）
  const onclickCount = (html.match(/onclick=/gi) || []).length;
  if (onclickCount > 0) {
    score -= onclickCount * 3;
    details.push('インラインonclick使用（非推奨）');
  }

  // div多用
  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  const semanticCount = (html.match(/<(header|main|nav|footer|section|article|aside)[^>]*>/gi) || []).length;
  if (divCount > 10 && semanticCount < 3) {
    score -= 5;
    details.push('divの過剰使用');
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
function evaluateContextuality(
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
    if (industryLower === 'healthcare' || industryLower === 'health') {
      // 信頼性を示す要素
      if (/certification|certified|licensed|trust|secure/i.test(html)) {
        score += 10;
        details.push('ヘルスケア業界の信頼性要素');
      }
      // 落ち着いた色調
      if (/#[0-9a-f]{6}/gi.test(html)) {
        score += 5;
        details.push('業界適切なカラー使用');
      }
    }

    // 金融
    if (industryLower === 'finance' || industryLower === 'financial') {
      if (/security|secure|encrypt|protect|compliance/i.test(html)) {
        score += 10;
        details.push('金融業界のセキュリティ要素');
      }
    }

    // テクノロジー
    if (industryLower === 'technology' || industryLower === 'tech') {
      if (/api|integration|developer|documentation/i.test(html)) {
        score += 5;
        details.push('テック業界の技術要素');
      }
      // モダンなデザイン要素
      if (/linear-gradient|grid|flex/i.test(html)) {
        score += 5;
        details.push('モダンなデザイン');
      }
    }
  }

  // オーディエンス固有の評価
  if (targetAudience) {
    const audienceLower = targetAudience.toLowerCase();

    // エンタープライズ
    if (audienceLower === 'enterprise' || audienceLower === 'business') {
      if (/professional|enterprise|business|solutions/i.test(html)) {
        score += 5;
        details.push('エンタープライズ向けコンテンツ');
      }
      // CTAの明確さ
      if (/<button[^>]*>/i.test(html) && /contact|demo|trial/i.test(html)) {
        score += 5;
        details.push('ビジネス向けCTA');
      }
    }

    // 一般消費者
    if (audienceLower === 'consumer' || audienceLower === 'general') {
      if (/simple|easy|free|try/i.test(html)) {
        score += 5;
        details.push('消費者向けメッセージ');
      }
    }

    // プロフェッショナル
    if (audienceLower === 'professionals' || audienceLower === 'expert') {
      if (/advanced|professional|expert|technical/i.test(html)) {
        score += 5;
        details.push('専門家向けコンテンツ');
      }
    }
  }

  // 一般的な品質評価
  // 明確な構造
  if (/<header/i.test(html) && /<main/i.test(html) && /<footer/i.test(html)) {
    score += 5;
    details.push('明確なページ構造');
  }

  // CTA存在
  if (/<button/i.test(html) || /<a[^>]*class="[^"]*(?:cta|btn|button)/i.test(html)) {
    score += 3;
    details.push('明確なCTA');
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
function generateRecommendations(
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
        category: 'originality',
        priority: pattern.severity,
        title: `AIクリシェを回避: ${pattern.type}`,
        description: pattern.description,
        impact: pattern.severity === 'high' ? 15 : pattern.severity === 'medium' ? 10 : 5,
      });
    }
  }

  if (originality.score < 70) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'originality',
      priority: 'high',
      title: '独自のカラーパレットを使用する',
      description: 'ブランド固有のカラーを定義し、CSS変数として管理してください',
      impact: 10,
    });
  }

  // Craftsmanshipに関する推奨
  if (craftsmanship.score < 80) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'craftsmanship',
      priority: 'high',
      title: 'アクセシビリティを改善する',
      description: 'ARIA属性、セマンティックHTML、画像のalt属性を追加してください',
      impact: 15,
    });
  }

  if (craftsmanship.details?.some((d) => d.includes('onclick'))) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'craftsmanship',
      priority: 'medium',
      title: 'インラインイベントハンドラを削除する',
      description: 'onclick属性の代わりにaddEventListenerを使用してください',
      impact: 8,
    });
  }

  // Contextualityに関する推奨
  if (contextuality.score < 75) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'contextuality',
      priority: 'medium',
      title: 'ターゲット層に合わせたコンテンツ',
      description: '業界やオーディエンスに適したメッセージングを検討してください',
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
 * パターン駆動評価の結果
 */
interface PatternDrivenEvaluationResult {
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
function adjustScoresWithPatterns(
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
      highQualitySections.reduce((sum, s) => sum + s.similarity, 0) /
      highQualitySections.length;

    // craftsmanship: 高品質パターンとの類似度が高い場合、技巧スコアを上方修正
    // 理由: 高品質パターンに似ている = 良い実装パターンを踏襲している
    const craftsmanshipBonus = Math.round(avgSimilarity * 10); // 最大+10
    craftsmanship = Math.min(100, craftsmanship + craftsmanshipBonus);

    if (isDevelopment()) {
      logger.info('[PatternEval] High quality pattern similarity bonus', {
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
      logger.info('[PatternEval] High uniqueness bonus', {
        uniquenessScore,
        originalityBonus,
      });
    }
  } else if (uniquenessScore < 30) {
    // 低いユニークネス = 既存パターンとの重複が多い
    const originalityPenalty = Math.round((30 - uniquenessScore) * 0.3); // 最大-9
    originality = Math.max(0, originality - originalityPenalty);

    if (isDevelopment()) {
      logger.info('[PatternEval] Low uniqueness penalty', {
        uniquenessScore,
        originalityPenalty,
      });
    }
  }

  // モーションパターンの考慮
  if (similarMotions.length > 0) {
    // 良いモーションパターンとの類似は技巧にボーナス
    const motionSimilarityAvg =
      similarMotions.reduce((sum, m) => sum + m.similarity, 0) /
      similarMotions.length;

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
function generateContextualRecommendations(
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
      if (rec.category === 'originality' && s.sectionType === 'hero') {
        return s.qualityScore !== undefined && s.qualityScore >= 85;
      }
      if (rec.category === 'craftsmanship' && s.qualityScore !== undefined && s.qualityScore >= 85) {
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
      category: 'general',
      priority: 'medium',
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
        category: 'craftsmanship',
        priority: 'medium',
        title: '効果的なモーションパターンを検討',
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
 * @returns パターン駆動評価結果（またはnull = フォールバック使用）
 */
async function executePatternDrivenEvaluation(
  html: string,
  baseScores: { originality: number; craftsmanship: number; contextuality: number },
  baseRecommendations: Recommendation[],
  options: PatternComparison
): Promise<PatternDrivenEvaluationResult | null> {
  // パターンマッチャーサービスが利用可能か確認
  if (!patternMatcherServiceFactory) {
    if (isDevelopment()) {
      logger.warn('[PatternEval] PatternMatcherService not available, using fallback');
    }
    return null;
  }

  // QualityEvaluateServiceが利用可能か確認
  if (!serviceFactory) {
    if (isDevelopment()) {
      logger.warn('[PatternEval] QualityEvaluateService not available, using fallback');
    }
    return null;
  }

  try {
    const patternMatcher = patternMatcherServiceFactory();
    const qualityService = serviceFactory();

    // 1. HTMLからテキスト表現を抽出
    const textRepresentation = patternMatcher.extractTextRepresentation(html);

    if (isDevelopment()) {
      logger.info('[PatternEval] Text representation extracted', {
        textLength: textRepresentation.length,
      });
    }

    // 2. Embedding生成
    let embedding: number[];
    try {
      embedding = await qualityService.generateEmbedding(textRepresentation);
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[PatternEval] Embedding generation failed, using fallback', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
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
      if (isDevelopment()) {
        logger.warn('[PatternEval] Section pattern search failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
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
      if (isDevelopment()) {
        logger.warn('[PatternEval] Motion pattern search failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // モーション検索失敗は致命的ではないので続行
    }

    // 5. ユニークネススコア計算
    let uniquenessScore = 50; // デフォルト
    try {
      uniquenessScore = await patternMatcher.calculateUniquenessScore(embedding);
      // 0-1 → 0-100 に変換
      uniquenessScore = Math.round(uniquenessScore * 100);
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[PatternEval] Uniqueness calculation failed, using default', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
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
      logger.info('[PatternEval] Pattern-driven evaluation completed', {
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
    if (isDevelopment()) {
      logger.error('[PatternEval] Pattern-driven evaluation failed, using fallback', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return null;
  }
}

/**
 * フォールバック用のパターン分析結果を生成
 */
function createFallbackPatternAnalysis(reason: string): PatternAnalysis {
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
    logger.info('[MCP Tool] quality.evaluate called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: QualityEvaluateInput;
  try {
    validated = qualityEvaluateInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorWithHints = createValidationErrorWithHints(error, 'quality.evaluate');
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);
      const formattedErrors = formatZodError(error);

      if (isDevelopment()) {
        logger.error('[MCP Tool] quality.evaluate validation error', {
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
  const action = validated.action ?? 'evaluate';

  if (isDevelopment()) {
    logger.info('[MCP Tool] quality.evaluate action', { action });
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
            message: 'Page service is not available',
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
        logger.error('[MCP Tool] quality.evaluate DB error', { error });
      }
      return {
        success: false,
        error: {
          code: QUALITY_MCP_ERROR_CODES.DB_ERROR,
          message: error instanceof Error ? error.message : 'Database error',
        },
      };
    }
  }

  if (!html) {
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: 'No HTML content provided',
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
    const craftsmanshipResult = await evaluateCraftsmanshipWithAxe(html, {
      use_playwright: validated.use_playwright,
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
    if (action === 'suggest_improvements') {
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
        logger.info('[MCP Tool] quality.evaluate action=suggest_improvements completed', {
          improvementCount: improvements.length,
          estimatedScoreGain: summary.estimatedScoreGain,
        });
      }

      return {
        success: true,
        action: 'suggest_improvements' as const,
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

    // パターン駆動評価が有効な場合
    if (patternComparisonOptions.enabled) {
      const patternResult = await executePatternDrivenEvaluation(
        html,
        baseScores,
        baseRecommendations,
        patternComparisonOptions
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
          logger.info('[MCP Tool] Pattern-driven evaluation applied', {
            baseOverall: overall,
            finalOverall,
            patternSimilarityAvg: patternAnalysis.patternSimilarityAvg,
            uniquenessScore: patternAnalysis.uniquenessScore,
          });
        }
      } else {
        // パターン駆動評価が失敗（フォールバック）
        patternAnalysis = createFallbackPatternAnalysis('Pattern services unavailable');

        if (isDevelopment()) {
          logger.info('[MCP Tool] Pattern-driven evaluation fallback used');
        }
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
        .filter((r) => r.priority === 'high')
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
        logger.info('[MCP Tool] quality.evaluate summary mode applied', {
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
      logger.info('[MCP Tool] quality.evaluate completed', {
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
        axeWcagLevel: axeAccessibilityResult?.wcagLevel ?? 'N/A',
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
          logger.info('[MCP Tool] quality.evaluate saved to DB', { evaluationId, pageId: validated.pageId });
        }
      } catch (saveError) {
        // Graceful degradation: 保存失敗時は警告ログを出力するが、評価結果は正常に返却
        logger.warn('[MCP Tool] quality.evaluate DB save failed (graceful degradation)', {
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
      logger.error('[MCP Tool] quality.evaluate error', { error });
    }
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Evaluation failed',
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

export const qualityEvaluateToolDefinition = {
  name: 'quality.evaluate',
  description:
    'Evaluate web design quality on 3 axes (originality, craftsmanship, contextuality) with AI cliche detection',
  annotations: {
    title: 'Quality Evaluate',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      pageId: {
        type: 'string',
        format: 'uuid',
        description: 'WebPage ID (UUID, from DB)',
      },
      html: {
        type: 'string',
        minLength: 1,
        maxLength: 10000000,
        description: 'HTML content (direct, max 10MB)',
      },
      weights: {
        type: 'object',
        description: 'Axis weights (sum 1.0)',
        properties: {
          originality: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.35,
            description: 'Originality weight (default: 0.35)',
          },
          craftsmanship: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: 'Craftsmanship weight (default: 0.4)',
          },
          contextuality: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.25,
            description: 'Contextuality weight (default: 0.25)',
          },
        },
      },
      targetIndustry: {
        type: 'string',
        maxLength: 100,
        description: 'Target industry (e.g. healthcare, finance, technology)',
      },
      targetAudience: {
        type: 'string',
        maxLength: 100,
        description: 'Target audience (e.g. enterprise, consumer, professionals)',
      },
      includeRecommendations: {
        type: 'boolean',
        default: true,
        description: 'Include recommendations (default: true)',
      },
      strict: {
        type: 'boolean',
        default: false,
        description: 'Strict mode: stricter AI cliche detection (default: false)',
      },
      patternComparison: {
        type: 'object',
        description: 'Pattern comparison options for pattern-driven evaluation (v0.1.0)',
        properties: {
          enabled: {
            type: 'boolean',
            default: true,
            description: 'Enable pattern comparison (default: true)',
          },
          minSimilarity: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.7,
            description: 'Minimum similarity threshold (default: 0.7)',
          },
          maxPatterns: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            default: 5,
            description: 'Maximum patterns to compare (default: 5)',
          },
        },
      },
      context: {
        type: 'object',
        description: 'Evaluation context (v0.1.0)',
        properties: {
          projectId: {
            type: 'string',
            format: 'uuid',
            description: 'Project ID (UUID)',
          },
          brandPaletteId: {
            type: 'string',
            format: 'uuid',
            description: 'Brand palette ID (UUID)',
          },
          targetIndustry: {
            type: 'string',
            maxLength: 100,
            description: 'Target industry',
          },
          targetAudience: {
            type: 'string',
            maxLength: 100,
            description: 'Target audience',
          },
        },
      },
      use_playwright: {
        type: 'boolean',
        default: false,
        description: 'Use Playwright for runtime aXe accessibility testing (default: false, uses JSDOM)',
      },
      summary: {
        type: 'boolean',
        default: true,
        description:
          'Lightweight mode: exclude detailed info and return summary only (v0.1.0 MCP-RESP-01, v0.1.0 default true). ' +
          'When true (default): recommendations max 3, contextualRecommendations max 3, patternAnalysis arrays max 3, ' +
          'axeAccessibility.violations max 5, clicheDetection.patterns max 3. Set to false for full details.',
      },
    },
  },
};
