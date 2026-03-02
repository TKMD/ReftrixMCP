// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Quality Evaluator Service
 * 各ビューポートでのレスポンシブ品質メトリクスを実測定するサービス
 *
 * @module services/responsive/responsive-quality-evaluator.service
 */

import { type Browser, type BrowserContext, type Page } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';
import { SharedBrowserManager } from './shared-browser-manager';
import type {
  ResponsiveViewport,
  ResponsiveQualityResult,
  ResponsiveQualityEvaluationOptions,
  ViewportQualityResult,
  TouchTargetResult,
  ReadabilityResult,
  OverflowResult,
  ResponsiveImageResult,
} from './types';

/**
 * タッチターゲット最小サイズ (WCAG 2.5.5)
 */
const TOUCH_TARGET_MIN_SIZE = 44;

/**
 * 読みやすさ基準値
 */
const READABILITY_MIN_FONT_SIZE = 16;
const READABILITY_MAX_LINE_LENGTH = 80;
const READABILITY_MIN_LINE_HEIGHT = 1.5;

/**
 * デフォルト品質評価ビューポート
 */
const QUALITY_VIEWPORTS: ResponsiveViewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

/**
 * Responsive Quality Evaluator Service
 */
export class ResponsiveQualityEvaluatorService {
  private readonly browserManager = new SharedBrowserManager('ResponsiveQualityEvaluator');

  /**
   * URLに対してレスポンシブ品質評価を実行
   *
   * @param url - 評価対象URL
   * @param options - 評価オプション
   * @param sharedBrowser - 共有ブラウザインスタンス（Worker pipeline用）
   * @returns 品質評価結果
   */
  async evaluate(
    url: string,
    options?: ResponsiveQualityEvaluationOptions,
    sharedBrowser?: Browser
  ): Promise<ResponsiveQualityResult> {
    const startTime = Date.now();
    const viewports = options?.viewports ?? QUALITY_VIEWPORTS;
    const timeout = options?.timeout ?? 30000;
    const checks = {
      touchTargets: options?.checks?.touchTargets ?? true,
      readability: options?.checks?.readability ?? true,
      overflow: options?.checks?.overflow ?? true,
      images: options?.checks?.images ?? true,
    };

    if (isDevelopment()) {
      logger.info('[ResponsiveQualityEvaluator] Starting evaluation', {
        url,
        viewports: viewports.map((v) => v.name),
        checks,
        usingSharedBrowser: !!sharedBrowser,
      });
    }

    const browser = await this.browserManager.resolveOrLaunch(sharedBrowser);

    const viewportResults: ViewportQualityResult[] = [];

    // 順次評価（並列だとリソース消費が大きいため）
    for (const viewport of viewports) {
      try {
        const result = await this.evaluateAtViewport(
          browser,
          url,
          viewport,
          timeout,
          checks
        );
        viewportResults.push(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isDevelopment()) {
          logger.error('[ResponsiveQualityEvaluator] Evaluation failed for viewport', {
            viewport: viewport.name,
            error: errorMessage,
          });
        }
        // エラー時はデフォルト値で埋める
        viewportResults.push(this.createDefaultResult(viewport));
      }
    }

    const overallScore = this.calculateOverallScore(viewportResults);
    const evaluationTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[ResponsiveQualityEvaluator] Evaluation completed', {
        url,
        viewportCount: viewportResults.length,
        overallScore,
        evaluationTimeMs,
      });
    }

    return {
      viewportResults,
      overallScore,
      evaluationTimeMs,
    };
  }

  /**
   * 指定ビューポートで品質メトリクスを計測
   */
  private async evaluateAtViewport(
    browser: Browser,
    url: string,
    viewport: ResponsiveViewport,
    timeout: number,
    checks: { touchTargets: boolean; readability: boolean; overflow: boolean; images: boolean }
  ): Promise<ViewportQualityResult> {
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        userAgent: SharedBrowserManager.getUserAgent(viewport.name),
      });

      page = await context.newPage();
      page.setDefaultTimeout(timeout);

      await page.goto(url, {
        timeout,
        waitUntil: 'load',
      });

      // DOM安定化を待つ
      await page.waitForTimeout(500);

      // 各チェックを実行
      const [touchTargets, readability, overflow, images] = await Promise.all([
        checks.touchTargets
          ? this.checkTouchTargets(page)
          : this.defaultTouchTargetResult(),
        checks.readability
          ? this.checkReadability(page)
          : this.defaultReadabilityResult(),
        checks.overflow
          ? this.checkOverflow(page)
          : this.defaultOverflowResult(),
        checks.images
          ? this.checkResponsiveImages(page)
          : this.defaultImageResult(),
      ]);

      return {
        viewport,
        touchTargets,
        readability,
        overflow,
        images,
      };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * タッチターゲットサイズ検出（WCAG 2.5.5: 44x44px）
   */
  private async checkTouchTargets(page: Page): Promise<TouchTargetResult> {
    const result = await page.evaluate(
      `(function() {
        var minSize = ${TOUCH_TARGET_MIN_SIZE};
        var selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]';
        var elements = document.querySelectorAll(selectors);
        var passed = 0;
        var failed = 0;
        var failedElements = [];

        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
          }

          var rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            continue;
          }

          if (rect.width >= minSize && rect.height >= minSize) {
            passed++;
          } else {
            failed++;
            if (failedElements.length < 20) {
              var tag = el.tagName.toLowerCase();
              var id = el.id ? '#' + el.id : '';
              var cls = el.className && typeof el.className === 'string'
                ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
                : '';
              failedElements.push({
                selector: tag + id + cls,
                width: Math.round(rect.width * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
              });
            }
          }
        }

        return { passed: passed, failed: failed, failedElements: failedElements };
      })()`
    );

    return result as TouchTargetResult;
  }

  /**
   * モバイル読みやすさ評価
   */
  private async checkReadability(page: Page): Promise<ReadabilityResult> {
    const result = await page.evaluate(
      `(function() {
        var minFontSize = ${READABILITY_MIN_FONT_SIZE};
        var maxLineLength = ${READABILITY_MAX_LINE_LENGTH};
        var minLineHeight = ${READABILITY_MIN_LINE_HEIGHT};

        var textSelectors = 'p, li, td, th, span, div, article, section, main, blockquote';
        var elements = document.querySelectorAll(textSelectors);

        var fontSizes = [];
        var lineLengths = [];
        var lineHeights = [];
        var sampleCount = 0;

        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          var style = window.getComputedStyle(el);

          if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
          }

          var textContent = el.textContent || '';
          var directText = '';
          for (var j = 0; j < el.childNodes.length; j++) {
            if (el.childNodes[j].nodeType === 3) {
              directText += el.childNodes[j].textContent || '';
            }
          }
          directText = directText.trim();

          if (directText.length < 10) {
            continue;
          }

          sampleCount++;

          var fontSize = parseFloat(style.fontSize) || 16;
          fontSizes.push(fontSize);

          var lineHeightValue = style.lineHeight;
          var lh = lineHeightValue === 'normal' ? 1.2 : parseFloat(lineHeightValue) / fontSize;
          lineHeights.push(lh);

          var rect = el.getBoundingClientRect();
          if (rect.width > 0 && fontSize > 0) {
            var charsPerLine = Math.floor(rect.width / (fontSize * 0.6));
            lineLengths.push(charsPerLine);
          }
        }

        if (sampleCount === 0) {
          return {
            fontSizeOk: true,
            lineLengthOk: true,
            lineHeightOk: true,
            details: { minFontSize: 16, avgLineLength: 0, avgLineHeight: 1.5, sampleCount: 0 },
          };
        }

        var minFS = Math.min.apply(null, fontSizes);
        var avgLL = lineLengths.length > 0
          ? lineLengths.reduce(function(a, b) { return a + b; }, 0) / lineLengths.length
          : 0;
        var avgLH = lineHeights.reduce(function(a, b) { return a + b; }, 0) / lineHeights.length;

        return {
          fontSizeOk: minFS >= minFontSize,
          lineLengthOk: avgLL <= maxLineLength || avgLL === 0,
          lineHeightOk: avgLH >= minLineHeight,
          details: {
            minFontSize: Math.round(minFS * 10) / 10,
            avgLineLength: Math.round(avgLL * 10) / 10,
            avgLineHeight: Math.round(avgLH * 100) / 100,
            sampleCount: sampleCount,
          },
        };
      })()`
    );

    return result as ReadabilityResult;
  }

  /**
   * コンテンツオーバーフロー検出
   */
  private async checkOverflow(page: Page): Promise<OverflowResult> {
    const result = await page.evaluate(
      `(function() {
        var horizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
        var overflowElements = [];

        var allElements = document.querySelectorAll('*');
        for (var i = 0; i < allElements.length; i++) {
          var el = allElements[i];
          if (el.scrollWidth > el.clientWidth + 1) {
            var style = window.getComputedStyle(el);
            var overflowX = style.overflowX;
            if (overflowX !== 'hidden' && overflowX !== 'clip') {
              if (overflowElements.length < 10) {
                var tag = el.tagName.toLowerCase();
                var id = el.id ? '#' + el.id : '';
                var cls = el.className && typeof el.className === 'string'
                  ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
                  : '';
                overflowElements.push(tag + id + cls);
              }
            }
          }
        }

        return {
          horizontalScroll: horizontalScroll,
          overflowElements: overflowElements,
        };
      })()`
    );

    return result as OverflowResult;
  }

  /**
   * レスポンシブ画像チェック
   */
  private async checkResponsiveImages(page: Page): Promise<ResponsiveImageResult> {
    const result = await page.evaluate(
      `(function() {
        var images = document.querySelectorAll('img');
        var pictureElements = document.querySelectorAll('picture');
        var srcsetCount = 0;
        var missingResponsive = 0;

        var pictureImgs = new Set();
        for (var j = 0; j < pictureElements.length; j++) {
          var imgs = pictureElements[j].querySelectorAll('img');
          for (var k = 0; k < imgs.length; k++) {
            pictureImgs.add(imgs[k]);
          }
        }

        for (var i = 0; i < images.length; i++) {
          var img = images[i];
          var style = window.getComputedStyle(img);
          if (style.display === 'none') {
            continue;
          }

          var hasSrcset = img.hasAttribute('srcset') && img.getAttribute('srcset') !== '';
          var inPicture = pictureImgs.has(img);

          if (hasSrcset) {
            srcsetCount++;
          } else if (!inPicture) {
            var rect = img.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) {
              missingResponsive++;
            }
          }
        }

        return {
          srcsetCount: srcsetCount,
          pictureCount: pictureElements.length,
          missingResponsive: missingResponsive,
        };
      })()`
    );

    return result as ResponsiveImageResult;
  }

  /**
   * 総合スコア算出 (0-100)
   *
   * 配点:
   * - タッチターゲット: 30点（failed率で減点）
   * - 読みやすさ: 30点（3項目 x 10点）
   * - オーバーフロー: 20点（水平スクロールで0点）
   * - 画像: 20点（レスポンシブ対応率）
   */
  private calculateOverallScore(results: ViewportQualityResult[]): number {
    if (results.length === 0) return 0;

    let totalScore = 0;

    for (const result of results) {
      let viewportScore = 0;

      // タッチターゲット (30点)
      const totalTargets = result.touchTargets.passed + result.touchTargets.failed;
      if (totalTargets > 0) {
        viewportScore += 30 * (result.touchTargets.passed / totalTargets);
      } else {
        viewportScore += 30;
      }

      // 読みやすさ (30点: 3項目 x 10点)
      if (result.readability.fontSizeOk) viewportScore += 10;
      if (result.readability.lineLengthOk) viewportScore += 10;
      if (result.readability.lineHeightOk) viewportScore += 10;

      // オーバーフロー (20点)
      if (!result.overflow.horizontalScroll && result.overflow.overflowElements.length === 0) {
        viewportScore += 20;
      } else if (!result.overflow.horizontalScroll) {
        viewportScore += 10;
      }

      // 画像 (20点)
      const totalImages = result.images.srcsetCount + result.images.missingResponsive;
      if (totalImages > 0) {
        const responsiveRatio = (result.images.srcsetCount + result.images.pictureCount) / totalImages;
        viewportScore += 20 * Math.min(responsiveRatio, 1);
      } else {
        viewportScore += 20;
      }

      totalScore += viewportScore;
    }

    return Math.round(totalScore / results.length);
  }

  /**
   * デフォルトのタッチターゲット結果
   */
  private defaultTouchTargetResult(): TouchTargetResult {
    return { passed: 0, failed: 0, failedElements: [] };
  }

  /**
   * デフォルトの読みやすさ結果
   */
  private defaultReadabilityResult(): ReadabilityResult {
    return {
      fontSizeOk: true,
      lineLengthOk: true,
      lineHeightOk: true,
      details: { minFontSize: 16, avgLineLength: 0, avgLineHeight: 1.5, sampleCount: 0 },
    };
  }

  /**
   * デフォルトのオーバーフロー結果
   */
  private defaultOverflowResult(): OverflowResult {
    return { horizontalScroll: false, overflowElements: [] };
  }

  /**
   * デフォルトの画像結果
   */
  private defaultImageResult(): ResponsiveImageResult {
    return { srcsetCount: 0, pictureCount: 0, missingResponsive: 0 };
  }

  /**
   * エラー時のデフォルト結果
   */
  private createDefaultResult(viewport: ResponsiveViewport): ViewportQualityResult {
    return {
      viewport,
      touchTargets: this.defaultTouchTargetResult(),
      readability: this.defaultReadabilityResult(),
      overflow: this.defaultOverflowResult(),
      images: this.defaultImageResult(),
    };
  }

  /**
   * ブラウザを終了
   * 共有ブラウザの場合はブラウザを閉じない（所有者が管理）
   */
  async close(): Promise<void> {
    await this.browserManager.close();
  }
}

// シングルトンインスタンス
export const responsiveQualityEvaluatorService = new ResponsiveQualityEvaluatorService();
