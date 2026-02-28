// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * aXe Accessibility Service
 *
 * aXe-coreを使用したアクセシビリティ検証サービス
 * JSDOMでHTMLを解析し、WCAG 2.1 AA準拠チェックを実行
 *
 * 主な機能:
 * - WCAG 2.1 AA準拠チェック
 * - 違反検出（critical, serious, moderate, minor）
 * - アクセシビリティスコア計算
 * - Craftsmanshipスコア調整用のペナルティ計算
 *
 * @module services/quality/axe-accessibility.service
 */

import axe, { type RuleObject, type AxeResults } from 'axe-core';
import { JSDOM } from 'jsdom';
import { logger, isDevelopment } from '../../utils/logger';

// 共通モジュールからインポート
import {
  type ViolationImpact,
  type WcagLevel,
  type AxeViolation,
  type AxeAccessibilityResult,
  WCAG_LEVEL_TAGS,
  calculateScorePenalty as sharedCalculateScorePenalty,
  calculateAccessibilityScore,
  determineWcagLevel,
  createEmptyResult,
  convertAxeViolation,
} from './axe-core-shared';

// 型の再エクスポート（後方互換性のため）
export type { ViolationImpact, WcagLevel, AxeViolation, AxeAccessibilityResult };

/**
 * サービスオプション
 */
export interface AxeServiceOptions {
  /** 対象WCAGレベル (デフォルト: 'AA') */
  wcagLevel?: WcagLevel | undefined;
  /** カスタムルール設定 */
  rules?: Record<string, { enabled: boolean }> | undefined;
  /** タイムアウト（ms） */
  timeout?: number | undefined;
}

// =====================================================
// サービス実装
// =====================================================

/**
 * aXe Accessibility Service
 *
 * JSDOM上でaXe-coreを実行し、アクセシビリティ検証を行う
 *
 * @example
 * ```typescript
 * const service = new AxeAccessibilityService();
 * const result = await service.analyze('<html>...</html>');
 * console.log(result.score); // 0-100
 * console.log(result.violations); // 違反リスト
 * ```
 */
export class AxeAccessibilityService {
  private readonly options: AxeServiceOptions;

  /**
   * コンストラクタ
   *
   * @param options - サービスオプション
   */
  constructor(options: AxeServiceOptions = {}) {
    this.options = {
      wcagLevel: options.wcagLevel ?? 'AA',
      rules: options.rules,
      timeout: options.timeout ?? 30000,
    };

    if (isDevelopment()) {
      logger.info('[AxeAccessibilityService] Initialized', {
        wcagLevel: this.options.wcagLevel,
        hasCustomRules: !!options.rules,
      });
    }
  }

  /**
   * HTMLのアクセシビリティを分析
   *
   * @param html - 分析対象のHTML文字列
   * @returns アクセシビリティ評価結果
   */
  async analyze(html: string): Promise<AxeAccessibilityResult> {
    // 空またはホワイトスペースのみの場合
    if (!html || html.trim() === '') {
      return this.createEmptyResult();
    }

    try {
      // JSDOMでHTMLをパース
      const dom = new JSDOM(html, {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
      });

      const document = dom.window.document;

      // aXe設定を構築
      const axeConfig = this.buildAxeConfig();

      if (isDevelopment()) {
        logger.info('[AxeAccessibilityService] Running aXe analysis', {
          htmlLength: html.length,
          wcagLevel: this.options.wcagLevel,
        });
      }

      // aXe-coreを実行
      const results = await axe.run(document.documentElement, axeConfig);

      // 結果を変換
      const processedResult = this.processResults(results);

      if (isDevelopment()) {
        logger.info('[AxeAccessibilityService] Analysis completed', {
          violationCount: processedResult.violations.length,
          passes: processedResult.passes,
          score: processedResult.score,
          wcagLevel: processedResult.wcagLevel,
        });
      }

      // DOMをクリーンアップ
      dom.window.close();

      return processedResult;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[AxeAccessibilityService] Analysis error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // エラー時はデフォルト結果を返す
      return this.createEmptyResult();
    }
  }

  /**
   * 違反からCraftsmanshipスコア調整用のペナルティを計算
   *
   * @param result - aXe評価結果
   * @returns ペナルティ値（0以下の数値）
   */
  calculateScorePenalty(result: AxeAccessibilityResult): number {
    return sharedCalculateScorePenalty(result);
  }

  // =====================================================
  // プライベートメソッド
  // =====================================================

  /**
   * aXe設定を構築
   */
  private buildAxeConfig(): {
    runOnly?: { type: 'tag'; values: string[] };
    rules?: Record<string, { enabled: boolean }>;
  } {
    const config: {
      runOnly?: { type: 'tag'; values: string[] };
      rules?: Record<string, { enabled: boolean }>;
    } = {};

    // WCAGレベルに基づくルールフィルタリング
    const wcagLevel = this.options.wcagLevel ?? 'AA';
    const tags = WCAG_LEVEL_TAGS[wcagLevel];

    if (tags) {
      config.runOnly = {
        type: 'tag',
        values: tags,
      };
    }

    // カスタムルール設定
    if (this.options.rules) {
      config.rules = this.options.rules;
    }

    return config;
  }

  /**
   * aXe結果を処理してAxeAccessibilityResultに変換
   */
  private processResults(results: AxeResults): AxeAccessibilityResult {
    // 違反を変換（共通関数使用）
    const violations: AxeViolation[] = results.violations.map((violation) =>
      convertAxeViolation(violation)
    );

    // 合格数
    const passes = results.passes.length;

    // スコア計算（共通関数使用）
    const score = calculateAccessibilityScore(results);

    // WCAGレベル決定（共通関数使用）
    const wcagLevel = determineWcagLevel(score, violations);

    return {
      violations,
      passes,
      score,
      wcagLevel,
    };
  }

  /**
   * 空の結果を作成
   */
  private createEmptyResult(): AxeAccessibilityResult {
    return createEmptyResult(this.options.wcagLevel ?? 'AA');
  }
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * AxeAccessibilityServiceのファクトリ関数
 *
 * @param options - サービスオプション
 * @returns AxeAccessibilityServiceインスタンス
 */
export function createAxeAccessibilityService(
  options?: AxeServiceOptions
): AxeAccessibilityService {
  return new AxeAccessibilityService(options);
}

// =====================================================
// 型エクスポート（再エクスポート用）
// =====================================================

export type { RuleObject as AxeRuleObject };
