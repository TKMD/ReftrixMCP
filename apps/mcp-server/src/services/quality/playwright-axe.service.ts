// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playwright aXe Service
 *
 * @axe-core/playwrightを使用したランタイムアクセシビリティ検証サービス
 * 実際のブラウザ環境でHTMLをレンダリングし、aXeによるWCAG 2.1 AA準拠チェックを実行
 *
 * 主な機能:
 * - WCAG 2.1 AA準拠チェック（実ブラウザ環境）
 * - 違反検出（critical, serious, moderate, minor）
 * - アクセシビリティスコア計算
 * - Craftsmanshipスコア調整用のペナルティ計算
 *
 * JSDOMベースのAxeAccessibilityServiceとの違い:
 * - JavaScriptが実行された後のDOM状態を検証
 * - CSSレンダリング後のコントラストチェックが可能
 * - より正確なランタイム検証
 *
 * @module services/quality/playwright-axe.service
 */

import { logger, isDevelopment } from '../../utils/logger';
import type { AxeResults } from 'axe-core';

// 共通モジュールからインポート
import {
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

// Playwright types (for runtime dynamic import)
// Note: playwright is dynamically imported at runtime, so we use import() type annotations
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PlaywrightBrowser = import('playwright').Browser;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PlaywrightBrowserContext = import('playwright').BrowserContext;

// =====================================================
// 型定義
// =====================================================

/**
 * Playwright aXe Service オプション
 */
export interface PlaywrightAxeOptions {
  /** 対象WCAGレベル (デフォルト: 'AA') */
  wcagLevel?: WcagLevel;
  /** タイムアウト（ms、デフォルト: 30000） */
  timeout?: number;
  /** ページ読み込み待機用セレクタ */
  waitForSelector?: string;
  /** ヘッドレスモード（デフォルト: true） */
  headless?: boolean;
}

// =====================================================
// Playwright可用性チェック
// =====================================================

/**
 * Playwrightが利用可能かチェック
 *
 * @returns Playwrightが利用可能な場合true
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    // 動的インポートでPlaywrightの存在を確認
    await import('playwright');
    await import('@axe-core/playwright');
    return true;
  } catch {
    if (isDevelopment()) {
      logger.warn('[PlaywrightAxeService] Playwright or @axe-core/playwright not available');
    }
    return false;
  }
}

// =====================================================
// サービス実装
// =====================================================

/**
 * Playwright aXe Service
 *
 * 実際のブラウザ環境でaXe-coreを実行し、アクセシビリティ検証を行う
 *
 * @example
 * ```typescript
 * const service = new PlaywrightAxeService();
 * const result = await service.analyzeHtml('<html>...</html>');
 * console.log(result.score); // 0-100
 * console.log(result.violations); // 違反リスト
 * await service.cleanup(); // ブラウザリソース解放
 * ```
 */
export class PlaywrightAxeService {
  private readonly options: Required<PlaywrightAxeOptions>;
  private browser: PlaywrightBrowser | null = null;
  private browserContext: PlaywrightBrowserContext | null = null;

  /**
   * コンストラクタ
   *
   * @param options - サービスオプション
   */
  constructor(options: PlaywrightAxeOptions = {}) {
    this.options = {
      wcagLevel: options.wcagLevel ?? 'AA',
      timeout: options.timeout ?? 30000,
      waitForSelector: options.waitForSelector ?? 'body',
      headless: options.headless ?? true,
    };

    if (isDevelopment()) {
      logger.info('[PlaywrightAxeService] Initialized', {
        wcagLevel: this.options.wcagLevel,
        timeout: this.options.timeout,
        headless: this.options.headless,
      });
    }
  }

  /**
   * ブラウザを初期化
   */
  private async initBrowser(): Promise<void> {
    if (this.browser) {
      return;
    }

    const playwright = await import('playwright');
    this.browser = await playwright.chromium.launch({
      headless: this.options.headless,
    });
    this.browserContext = await this.browser.newContext();

    if (isDevelopment()) {
      logger.info('[PlaywrightAxeService] Browser initialized');
    }
  }

  /**
   * HTMLコンテンツのアクセシビリティを分析
   *
   * @param html - 分析対象のHTML文字列
   * @returns アクセシビリティ評価結果
   */
  async analyzeHtml(html: string): Promise<AxeAccessibilityResult> {
    // 空またはホワイトスペースのみの場合
    if (!html || html.trim() === '') {
      return this.createEmptyResult();
    }

    try {
      // ブラウザを初期化
      await this.initBrowser();

      if (!this.browserContext) {
        throw new Error('Browser context not initialized');
      }

      // 新しいページを作成
      const page = await this.browserContext.newPage();

      try {
        if (isDevelopment()) {
          logger.info('[PlaywrightAxeService] Loading HTML', {
            htmlLength: html.length,
          });
        }

        // setContent を使用してHTMLを設定（data: URLだとサイズ制限や
        // ブラウザによる<html>要素の再構築で lang/title が失われる問題を回避）
        await page.setContent(html, {
          timeout: this.options.timeout,
          waitUntil: 'domcontentloaded',
        });

        // 指定されたセレクタを待機
        if (this.options.waitForSelector) {
          try {
            await page.waitForSelector(this.options.waitForSelector, {
              timeout: 5000,
            });
          } catch {
            // セレクタが見つからない場合は続行
            if (isDevelopment()) {
              logger.warn('[PlaywrightAxeService] Selector not found, continuing', {
                selector: this.options.waitForSelector,
              });
            }
          }
        }

        // @axe-core/playwrightをインポートして実行
        const { AxeBuilder } = await import('@axe-core/playwright');

        // aXeビルダーを設定
        let axeBuilder = new AxeBuilder({ page });

        // WCAGレベルに基づくルールフィルタリング
        const tags = WCAG_LEVEL_TAGS[this.options.wcagLevel];
        if (tags) {
          axeBuilder = axeBuilder.withTags(tags);
        }

        // aXe分析を実行
        const axeResults = await axeBuilder.analyze();

        if (isDevelopment()) {
          logger.info('[PlaywrightAxeService] aXe analysis completed', {
            violations: axeResults.violations.length,
            passes: axeResults.passes.length,
          });
        }

        // 結果を変換
        return this.processResults(axeResults);
      } finally {
        // ページをクローズ
        await page.close();
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[PlaywrightAxeService] Analysis error', {
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

  /**
   * ブラウザリソースをクリーンアップ
   */
  async cleanup(): Promise<void> {
    try {
      if (this.browserContext) {
        await this.browserContext.close();
        this.browserContext = null;
      }

      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }

      if (isDevelopment()) {
        logger.info('[PlaywrightAxeService] Browser resources cleaned up');
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[PlaywrightAxeService] Cleanup error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // =====================================================
  // プライベートメソッド
  // =====================================================

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
    return createEmptyResult(this.options.wcagLevel);
  }
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * PlaywrightAxeServiceのファクトリ関数
 *
 * @param options - サービスオプション
 * @returns PlaywrightAxeServiceインスタンス
 */
export function createPlaywrightAxeService(
  options?: PlaywrightAxeOptions
): PlaywrightAxeService {
  return new PlaywrightAxeService(options);
}

// =====================================================
// 型エクスポート（再エクスポート用）
// =====================================================

export type {
  AxeAccessibilityResult,
  AxeViolation,
  ViolationImpact,
  WcagLevel,
} from './axe-core-shared';
