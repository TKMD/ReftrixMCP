// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-Viewport Capture Service
 * 複数ビューポートでのページキャプチャを実行するサービス
 *
 * @module services/responsive/multi-viewport-capture.service
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';
import type {
  ResponsiveViewport,
  ViewportCaptureResult,
  ViewportScreenshot,
  ViewportLayoutInfo,
  NavigationInfo,
  MultiViewportCaptureOptions,
} from './types';

/**
 * デフォルトビューポートプリセット
 */
export const DEFAULT_VIEWPORTS: ResponsiveViewport[] = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

/**
 * デフォルトナビゲーションセレクタ
 */
const DEFAULT_NAV_SELECTORS = [
  'nav',
  'header nav',
  '[role="navigation"]',
  '.navigation',
  '.nav',
  '#nav',
  '#navigation',
];

/**
 * デフォルトハンバーガーメニューセレクタ
 */
const DEFAULT_HAMBURGER_SELECTORS = [
  '.hamburger',
  '.hamburger-menu',
  '.burger',
  '.burger-menu',
  '[aria-label*="menu"]',
  '[aria-label*="Menu"]',
  '.mobile-menu-toggle',
  '.menu-toggle',
  'button[aria-expanded]',
  '.nav-toggle',
];

/**
 * Multi-Viewport Capture Service
 */
export class MultiViewportCaptureService {
  private browser: Browser | null = null;

  /**
   * ブラウザを取得（シングルトン）
   */
  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      if (isDevelopment()) {
        logger.debug('[MultiViewportCapture] Browser launched');
      }
    }
    return this.browser;
  }

  /**
   * 複数ビューポートでページをキャプチャ
   *
   * @param url - キャプチャ対象URL
   * @param options - キャプチャオプション
   * @returns ビューポートごとのキャプチャ結果配列
   */
  async captureAllViewports(
    url: string,
    options: MultiViewportCaptureOptions
  ): Promise<ViewportCaptureResult[]> {
    const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[MultiViewportCapture] Starting multi-viewport capture', {
        url,
        viewports: viewports.map((v) => v.name),
      });
    }

    const browser = await this.getBrowser();
    const results: ViewportCaptureResult[] = [];

    // 順次キャプチャ（並列だとリソース消費が大きいため）
    for (const viewport of viewports) {
      try {
        const result = await this.captureAtViewport(browser, url, viewport, options);
        results.push(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isDevelopment()) {
          logger.error('[MultiViewportCapture] Capture failed for viewport', {
            viewport: viewport.name,
            error: errorMessage,
          });
        }
        results.push({
          viewport,
          html: '',
          layoutInfo: this.createEmptyLayoutInfo(viewport),
          navigationInfo: this.createDefaultNavigationInfo(),
          error: errorMessage,
        });
      }
    }

    const elapsedMs = Date.now() - startTime;
    if (isDevelopment()) {
      logger.info('[MultiViewportCapture] Multi-viewport capture completed', {
        url,
        viewportsCount: results.length,
        successCount: results.filter((r) => !r.error).length,
        elapsedMs,
      });
    }

    return results;
  }

  /**
   * 指定ビューポートでページをキャプチャ
   */
  private async captureAtViewport(
    browser: Browser,
    url: string,
    viewport: ResponsiveViewport,
    options: MultiViewportCaptureOptions
  ): Promise<ViewportCaptureResult> {
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // コンテキストを作成（ビューポートサイズ設定）
      context = await browser.newContext({
        viewport: {
          width: viewport.width,
          height: viewport.height,
        },
        userAgent:
          viewport.name === 'mobile'
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      page = await context.newPage();
      page.setDefaultTimeout(options.timeout);

      // ページに移動
      await page.goto(url, {
        timeout: options.timeout,
        waitUntil: options.waitUntil ?? 'load',
      });

      // DOM安定化待機（オプション）
      if (options.waitForDomStable !== false) {
        await this.waitForDomStable(page, options.domStableTimeout ?? 500);
      }

      // HTML取得
      const html = await page.content();

      // レイアウト情報取得
      const layoutInfo = await this.extractLayoutInfo(page, viewport);

      // ナビゲーション情報取得
      const navigationInfo = await this.detectNavigation(page);

      // スクリーンショット取得（オプション）
      // exactOptionalPropertyTypes対応：undefinedを含めず条件付きで返す
      if (options.includeScreenshots) {
        const screenshot = await this.captureScreenshot(page, viewport, options.fullPage ?? true);
        return {
          viewport,
          html,
          screenshot,
          layoutInfo,
          navigationInfo,
        };
      }

      return {
        viewport,
        html,
        layoutInfo,
        navigationInfo,
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
   * DOM安定化待機
   */
  private async waitForDomStable(page: Page, stableTimeout: number = 500): Promise<void> {
    await page.evaluate(
      `(async function() {
        const stableTimeout = ${stableTimeout};
        const maxWait = 5000;
        const startTime = Date.now();
        let lastMutationTime = Date.now();

        return new Promise((resolve) => {
          const maxWaitTimer = setTimeout(() => {
            observer.disconnect();
            resolve({ stable: false });
          }, maxWait);

          const checkInterval = setInterval(() => {
            if (Date.now() - lastMutationTime >= stableTimeout) {
              clearInterval(checkInterval);
              clearTimeout(maxWaitTimer);
              observer.disconnect();
              resolve({ stable: true });
            }
          }, 100);

          const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
          });

          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
          });
        });
      })()`
    );
  }

  /**
   * レイアウト情報を抽出
   */
  private async extractLayoutInfo(page: Page, _viewport: ResponsiveViewport): Promise<ViewportLayoutInfo> {
    const info = await page.evaluate(`
      (function() {
        // ブレークポイント抽出
        const breakpoints = [];
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.type === CSSRule.MEDIA_RULE) {
                const media = rule.media.mediaText;
                const match = media.match(/(\\d+)px/g);
                if (match) {
                  breakpoints.push(...match);
                }
              }
            }
          } catch (e) {
            // CORS制限のあるスタイルシートはスキップ
          }
        }

        // グリッドカラム検出
        let gridColumns;
        const gridContainer = document.querySelector('[style*="grid"], .grid, [class*="grid"]');
        if (gridContainer) {
          const style = window.getComputedStyle(gridContainer);
          const templateColumns = style.gridTemplateColumns;
          if (templateColumns && templateColumns !== 'none') {
            gridColumns = templateColumns.split(' ').filter(c => c && c !== 'none').length;
          }
        }

        // フレックス方向検出
        let flexDirection;
        const flexContainer = document.querySelector('[style*="flex"], .flex, [class*="flex"]');
        if (flexContainer) {
          const style = window.getComputedStyle(flexContainer);
          flexDirection = style.flexDirection;
        }

        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollHeight: document.body.scrollHeight,
          breakpoints: [...new Set(breakpoints)],
          gridColumns,
          flexDirection,
        };
      })()
    `);

    return info as ViewportLayoutInfo;
  }

  /**
   * ナビゲーション情報を検出
   */
  private async detectNavigation(page: Page): Promise<NavigationInfo> {
    const info = await page.evaluate(
      `
      (function() {
        const navSelectors = ${JSON.stringify(DEFAULT_NAV_SELECTORS)};
        const hamburgerSelectors = ${JSON.stringify(DEFAULT_HAMBURGER_SELECTORS)};

        // ナビゲーション要素検出
        let navElement = null;
        let navSelector = null;
        for (const selector of navSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            navElement = el;
            navSelector = selector;
            break;
          }
        }

        // ハンバーガーメニュー検出
        let hasHamburgerMenu = false;
        for (const selector of hamburgerSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            const style = window.getComputedStyle(el);
            // 表示されているハンバーガーメニューのみカウント
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              hasHamburgerMenu = true;
              break;
            }
          }
        }

        // 水平メニュー検出
        let hasHorizontalMenu = false;
        if (navElement) {
          const links = navElement.querySelectorAll('a, button');
          if (links.length >= 3) {
            // 3つ以上のリンクが横並びか判定
            const firstLink = links[0];
            const secondLink = links[1];
            if (firstLink && secondLink) {
              const firstRect = firstLink.getBoundingClientRect();
              const secondRect = secondLink.getBoundingClientRect();
              // Y座標が近い（±20px）なら水平
              if (Math.abs(firstRect.top - secondRect.top) < 20) {
                hasHorizontalMenu = true;
              }
            }
          }
        }

        // ボトムナビゲーション検出
        let hasBottomNav = false;
        const bottomNavSelectors = ['.bottom-nav', '.bottom-navigation', '[class*="bottom-nav"]', '.tab-bar'];
        for (const selector of bottomNavSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none') {
              hasBottomNav = true;
              break;
            }
          }
        }

        // ナビゲーションタイプ判定
        let type = 'other';
        if (hasHamburgerMenu && !hasHorizontalMenu) {
          type = 'hamburger-menu';
        } else if (hasHorizontalMenu && !hasHamburgerMenu) {
          type = 'horizontal-menu';
        } else if (hasBottomNav) {
          type = 'bottom-nav';
        } else if (navElement && !hasHamburgerMenu && !hasHorizontalMenu) {
          type = 'hidden';
        }

        return {
          type,
          hasHamburgerMenu,
          hasHorizontalMenu,
          hasBottomNav,
          selector: navSelector,
        };
      })()
    `
    );

    return info as NavigationInfo;
  }

  /**
   * スクリーンショットをキャプチャ
   */
  private async captureScreenshot(
    page: Page,
    viewport: ResponsiveViewport,
    fullPage: boolean
  ): Promise<ViewportScreenshot> {
    const buffer = await page.screenshot({
      fullPage,
      type: 'png',
    });

    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      screenshot: {
        base64: buffer.toString('base64'),
        format: 'png',
        width: viewport.width,
        // eslint-disable-next-line no-undef -- document is available in browser context (page.evaluate)
        height: fullPage ? (await page.evaluate(() => document.body.scrollHeight)) : viewport.height,
      },
    };
  }

  /**
   * 空のレイアウト情報を作成
   */
  private createEmptyLayoutInfo(viewport: ResponsiveViewport): ViewportLayoutInfo {
    return {
      documentWidth: viewport.width,
      documentHeight: viewport.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      scrollHeight: viewport.height,
      breakpoints: [],
    };
  }

  /**
   * デフォルトのナビゲーション情報を作成
   */
  private createDefaultNavigationInfo(): NavigationInfo {
    return {
      type: 'other',
      hasHamburgerMenu: false,
      hasHorizontalMenu: false,
      hasBottomNav: false,
    };
  }

  /**
   * ブラウザを終了
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      if (isDevelopment()) {
        logger.debug('[MultiViewportCapture] Browser closed');
      }
    }
  }
}

// シングルトンインスタンス
export const multiViewportCaptureService = new MultiViewportCaptureService();
