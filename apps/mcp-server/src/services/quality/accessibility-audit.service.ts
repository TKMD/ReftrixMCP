// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accessibility Audit Service
 *
 * axe-coreを使用したWCAG 2.1準拠監査サービス。
 * JSDOM上でaxe-coreを実行し、構造化された監査結果を生成する。
 *
 * 主な機能:
 * - WCAG 2.1 A/AA/AAA レベルフィルタリング
 * - violation重大度分類: critical/serious/moderate/minor
 * - スコア計算: 100 - (critical*20 + serious*10 + moderate*5 + minor*1), 最低0
 * - issue別の修正提案テキスト生成
 *
 * Accessibility audit service using axe-core.
 * Runs axe-core on JSDOM to generate structured audit results.
 *
 * @module services/quality/accessibility-audit.service
 */

import axe, { type AxeResults } from "axe-core";
import { JSDOM } from "jsdom";
import { logger, isDevelopment } from "../../utils/logger";
import { type ViolationImpact, type WcagLevel, WCAG_LEVEL_TAGS } from "./axe-core-shared";

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * 監査オプション / Audit options
 */
export interface AccessibilityAuditOptions {
  /** 対象WCAGレベル (デフォルト: 'AA') */
  wcagLevel?: WcagLevel;
  /** タイムアウト（ms） */
  timeout?: number;
}

/**
 * 監査実行時オプション / Audit run options
 */
export interface AuditRunOptions {
  /** passes詳細を含めるか / Include pass details */
  includePasses?: boolean;
}

/**
 * 監査違反情報（修正提案付き）/ Audit violation with fix suggestion
 */
export interface AuditViolation {
  /** ルールID (e.g., 'image-alt', 'button-name') */
  id: string;
  /** インパクトレベル / Impact level */
  impact: ViolationImpact;
  /** 違反の説明 / Violation description */
  description: string;
  /** 修正方法のヘルプテキスト / Help text for fix */
  help: string;
  /** 詳細なヘルプURL (deque.com) */
  helpUrl: string;
  /** 影響を受けるノード数 / Affected node count */
  nodes: number;
  /** 修正提案テキスト / Fix suggestion text */
  fixSuggestion: string;
}

/**
 * passルール情報 / Pass rule info
 */
export interface AuditPass {
  /** ルールID */
  id: string;
  /** 説明 / Description */
  description: string;
}

/**
 * サマリー情報 / Summary info
 */
export interface AuditSummary {
  /** 違反総数 / Total violations */
  totalViolations: number;
  /** 合格総数 / Total passes */
  totalPasses: number;
  /** critical件数 */
  critical: number;
  /** serious件数 */
  serious: number;
  /** moderate件数 */
  moderate: number;
  /** minor件数 */
  minor: number;
}

/**
 * 重大度ごとの件数 / Severity counts
 */
export interface SeverityCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/**
 * 監査結果 / Audit result
 */
export interface AccessibilityAuditResult {
  /** スコア (0-100) */
  score: number;
  /** 監査対象WCAGレベル / Target WCAG level */
  level: WcagLevel;
  /** 違反リスト / Violations */
  violations: AuditViolation[];
  /** 合格ルールリスト（include_passes=true時のみ） / Passes (when includePasses=true) */
  passes: AuditPass[];
  /** サマリー / Summary */
  summary: AuditSummary;
}

// =====================================================
// 修正提案マッピング / Fix Suggestion Mapping
// =====================================================

/**
 * 一般的なaxe-coreルールIDに対する修正提案テキスト
 * Common fix suggestions for axe-core rule IDs
 */
const FIX_SUGGESTIONS: Record<string, string> = {
  "image-alt":
    'Add an alt attribute to <img> elements that describes the image content. Use alt="" for decorative images.',
  "button-name":
    "Add visible text, aria-label, or aria-labelledby to <button> elements to provide an accessible name.",
  "link-name":
    "Add visible text or aria-label to <a> elements so screen readers can describe the link purpose.",
  label:
    "Associate each <input> with a <label> element using the for attribute, or use aria-label/aria-labelledby.",
  "color-contrast":
    "Increase the contrast ratio between text and background colors to meet WCAG AA requirements (4.5:1 for normal text, 3:1 for large text).",
  "html-has-lang": 'Add a lang attribute to the <html> element (e.g., <html lang="en">).',
  "document-title": "Add a <title> element inside the <head> section of the HTML document.",
  "landmark-one-main": "Add a <main> landmark element to contain the primary content of the page.",
  region:
    "Wrap page content within appropriate landmark elements (<header>, <nav>, <main>, <footer>).",
  "heading-order":
    "Ensure headings follow a logical order (h1 followed by h2, h2 followed by h3, etc.) without skipping levels.",
  list: "Ensure <li> elements are contained within <ul>, <ol>, or <menu> parent elements.",
  tabindex:
    'Avoid using tabindex values greater than 0. Use tabindex="0" to add elements to the natural tab order.',
  "meta-viewport":
    "Do not disable user scaling in the viewport meta tag. Remove maximum-scale=1 or user-scalable=no.",
  "duplicate-id":
    "Ensure all id attributes on the page are unique. Duplicate IDs cause unpredictable behavior for assistive technologies.",
  "aria-roles":
    "Use valid ARIA roles. Check the WAI-ARIA specification for the list of allowed role values.",
  "aria-required-attr": "Add all required ARIA attributes for the specified role.",
  "aria-valid-attr-value": "Ensure ARIA attribute values are valid according to the specification.",
  "input-image-alt": 'Add an alt attribute to <input type="image"> elements.',
  "frame-title": "Add a title attribute to <iframe> and <frame> elements.",
  "td-headers-attr":
    "Ensure <td> headers attributes reference valid <th> elements within the same table.",
};

// =====================================================
// スコアペナルティ定数 / Score Penalty Constants
// =====================================================

/** critical違反のペナルティ / Penalty for critical violations */
const PENALTY_CRITICAL = 20;
/** serious違反のペナルティ / Penalty for serious violations */
const PENALTY_SERIOUS = 10;
/** moderate違反のペナルティ / Penalty for moderate violations */
const PENALTY_MODERATE = 5;
/** minor違反のペナルティ / Penalty for minor violations */
const PENALTY_MINOR = 1;

// =====================================================
// サービス実装 / Service Implementation
// =====================================================

/**
 * Accessibility Audit Service
 *
 * JSDOM上でaxe-coreを実行し、構造化されたWCAG監査結果を返す
 * Runs axe-core on JSDOM and returns structured WCAG audit results
 */
export class AccessibilityAuditService {
  private readonly wcagLevel: WcagLevel;
  private readonly timeout: number;

  constructor(options: AccessibilityAuditOptions = {}) {
    this.wcagLevel = options.wcagLevel ?? "AA";
    this.timeout = options.timeout ?? 30000;

    if (isDevelopment()) {
      logger.info("[AccessibilityAuditService] Initialized", {
        wcagLevel: this.wcagLevel,
        timeout: this.timeout,
      });
    }
  }

  /**
   * HTMLのWCAGアクセシビリティ監査を実行
   * Execute WCAG accessibility audit on HTML
   *
   * @param html - 監査対象のHTML / HTML to audit
   * @param runOptions - 実行オプション / Run options
   * @returns 監査結果 / Audit result
   */
  async audit(html: string, runOptions: AuditRunOptions = {}): Promise<AccessibilityAuditResult> {
    // 空またはホワイトスペースのみ
    if (!html || html.trim() === "") {
      return this.createEmptyResult();
    }

    try {
      // JSDOMでHTMLをパース
      const dom = new JSDOM(html, {
        runScripts: "outside-only",
        pretendToBeVisual: true,
      });
      const document = dom.window.document;

      // aXe設定を構築
      const tags = WCAG_LEVEL_TAGS[this.wcagLevel];
      const axeConfig: {
        runOnly?: { type: "tag"; values: string[] };
      } = {};
      if (tags) {
        axeConfig.runOnly = { type: "tag", values: tags };
      }

      if (isDevelopment()) {
        logger.info("[AccessibilityAuditService] Running audit", {
          htmlLength: html.length,
          wcagLevel: this.wcagLevel,
        });
      }

      // aXe-coreを実行
      const results = await axe.run(document.documentElement, axeConfig);

      // 結果を変換
      const processedResult = this.processResults(results, runOptions);

      // クリーンアップ
      dom.window.close();

      return processedResult;
    } catch (error) {
      logger.warn("[AccessibilityAuditService] Audit error", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return this.createEmptyResult();
    }
  }

  /**
   * 重大度ごとの件数からスコアを計算
   * Calculate score from severity counts
   *
   * @param counts - 重大度ごとの件数 / Severity counts
   * @returns スコア (0-100) / Score (0-100)
   */
  calculateScore(counts: SeverityCounts): number {
    const penalty =
      counts.critical * PENALTY_CRITICAL +
      counts.serious * PENALTY_SERIOUS +
      counts.moderate * PENALTY_MODERATE +
      counts.minor * PENALTY_MINOR;
    return Math.max(0, 100 - penalty);
  }

  /**
   * 違反ルールIDに対する修正提案テキストを生成
   * Generate fix suggestion text for a violation rule ID
   *
   * @param ruleId - axe-coreルールID / axe-core rule ID
   * @param helpText - axeのhelpテキスト（フォールバック用） / axe help text (fallback)
   * @returns 修正提案テキスト / Fix suggestion text
   */
  generateFixSuggestion(ruleId: string, helpText: string): string {
    return FIX_SUGGESTIONS[ruleId] ?? `Fix: ${helpText}`;
  }

  // =====================================================
  // プライベートメソッド / Private Methods
  // =====================================================

  /**
   * aXe結果を変換
   */
  private processResults(
    results: AxeResults,
    runOptions: AuditRunOptions
  ): AccessibilityAuditResult {
    // 違反を変換
    const violations: AuditViolation[] = results.violations.map((v) => ({
      id: v.id,
      impact: (v.impact as ViolationImpact) ?? "moderate",
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      fixSuggestion: this.generateFixSuggestion(v.id, v.help),
    }));

    // 重大度カウント
    const counts: SeverityCounts = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };
    for (const v of violations) {
      counts[v.impact]++;
    }

    // スコア計算
    const score = this.calculateScore(counts);

    // passes
    const passes: AuditPass[] = runOptions.includePasses
      ? results.passes.map((p) => ({
          id: p.id,
          description: p.description,
        }))
      : [];

    // サマリー
    const summary: AuditSummary = {
      totalViolations: violations.length,
      totalPasses: results.passes.length,
      ...counts,
    };

    return {
      score,
      level: this.wcagLevel,
      violations,
      passes,
      summary,
    };
  }

  /**
   * 空の結果を作成
   */
  private createEmptyResult(): AccessibilityAuditResult {
    return {
      score: 100,
      level: this.wcagLevel,
      violations: [],
      passes: [],
      summary: {
        totalViolations: 0,
        totalPasses: 0,
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
      },
    };
  }
}

// =====================================================
// ファクトリ関数 / Factory Function
// =====================================================

/**
 * AccessibilityAuditServiceのファクトリ関数
 */
export function createAccessibilityAuditService(
  options?: AccessibilityAuditOptions
): AccessibilityAuditService {
  return new AccessibilityAuditService(options);
}
