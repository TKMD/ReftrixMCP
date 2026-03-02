// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-Viewport Capture Service
 * 複数ビューポートでのページキャプチャを実行するサービス
 *
 * @module services/responsive/multi-viewport-capture.service
 */

import { type Browser, type Page, type BrowserContext } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';
import { SharedBrowserManager } from './shared-browser-manager';
import type {
  ResponsiveViewport,
  ViewportCaptureResult,
  ViewportScreenshot,
  ViewportLayoutInfo,
  NavigationInfo,
  MultiViewportCaptureOptions,
  SemanticElementInfo,
} from './types';
import { extractCssUrls, fetchAllCss } from '../external-css-fetcher';

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
 * フルページスクリーンショットの高さ上限（px）
 * 極端に長いページでのメモリ消費増大を防止する
 */
export const MAX_SCREENSHOT_HEIGHT = 30_000;

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
  private readonly browserManager = new SharedBrowserManager('MultiViewportCapture');

  /**
   * 複数ビューポートでページをキャプチャ
   *
   * @param url - キャプチャ対象URL
   * @param options - キャプチャオプション
   * @param sharedBrowser - 共有ブラウザインスタンス（Worker pipeline用、指定時はchromium.launch()をスキップ）
   * @returns ビューポートごとのキャプチャ結果配列
   */
  async captureAllViewports(
    url: string,
    options: MultiViewportCaptureOptions,
    sharedBrowser?: Browser
  ): Promise<ViewportCaptureResult[]> {
    const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[MultiViewportCapture] Starting multi-viewport capture', {
        url,
        viewports: viewports.map((v) => v.name),
        usingSharedBrowser: !!sharedBrowser,
      });
    }

    const browser = await this.browserManager.resolveOrLaunch(sharedBrowser);
    const results: ViewportCaptureResult[] = [];

    // 順次キャプチャ（並列だとリソース消費が大きいため）
    let viewportIndex = 0;
    for (const viewport of viewports) {
      try {
        // crawl-delay 適用: 2回目以降のキャプチャ前に遅延を挿入
        const crawlDelay = options.crawlDelayMs;
        if (viewportIndex > 0 && crawlDelay !== undefined && crawlDelay > 0) {
          if (isDevelopment()) {
            logger.info('[MultiViewportCapture] Applying crawl-delay before capture', {
              viewport: viewport.name,
              crawlDelayMs: crawlDelay,
            });
          }
          await new Promise<void>(resolve => setTimeout(resolve, crawlDelay));
        }

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
      viewportIndex++;
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
        userAgent: SharedBrowserManager.getUserAgent(viewport.name),
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
   * Phase 2: セマンティック要素のcomputedStyleベース検出 + 既存セレクタベースのフォールバック
   * Phase 4: 拡張タイポグラフィ（h1-h6, p:first-of-type）、セクション間スペーシング
   */
  private async extractLayoutInfo(page: Page, _viewport: ResponsiveViewport): Promise<ViewportLayoutInfo> {
    const info = await page.evaluate(`
      (function() {
        // ブレークポイント抽出（同一オリジンのスタイルシートのみ）
        var breakpoints = [];
        for (var si = 0; si < document.styleSheets.length; si++) {
          try {
            var sheet = document.styleSheets[si];
            for (var ri = 0; ri < sheet.cssRules.length; ri++) {
              var rule = sheet.cssRules[ri];
              if (rule.type === CSSRule.MEDIA_RULE) {
                var media = rule.media.mediaText;
                var match = media.match(/(\\d+)px/g);
                if (match) {
                  breakpoints.push.apply(breakpoints, match);
                }
              }
            }
          } catch (e) {
            // CORS制限のあるスタイルシートはスキップ
          }
        }

        // Phase 2: セマンティック要素のcomputedStyle走査（200要素上限）
        var SEMANTIC_SELECTOR = 'header, nav, main, section, aside, footer, article, table, figure';
        var MAX_ELEMENTS = 200;
        var semanticElements = [];
        var gridColumns;
        var flexDirection;
        var firstGridFound = false;
        var firstFlexFound = false;

        // セマンティック要素 + main直接子要素を収集（重複除去）
        var semanticEls = document.querySelectorAll(SEMANTIC_SELECTOR);
        var mainEl = document.querySelector('main');
        var mainChildren = mainEl ? Array.from(mainEl.children) : [];
        var seen = new Set();
        var allEls = [];
        for (var i = 0; i < semanticEls.length; i++) {
          if (!seen.has(semanticEls[i])) {
            seen.add(semanticEls[i]);
            allEls.push(semanticEls[i]);
          }
        }
        for (var j = 0; j < mainChildren.length; j++) {
          if (!seen.has(mainChildren[j])) {
            seen.add(mainChildren[j]);
            allEls.push(mainChildren[j]);
          }
        }

        for (var k = 0; k < allEls.length && k < MAX_ELEMENTS; k++) {
          var el = allEls[k];
          var cs = window.getComputedStyle(el);
          var display = cs.display;
          var visibility = cs.visibility;
          var opacity = parseFloat(cs.opacity);
          var rect = el.getBoundingClientRect();

          var tagName = el.tagName.toLowerCase();
          var selector = tagName;
          if (el.id) {
            selector = '#' + el.id;
          } else if (el.className && typeof el.className === 'string') {
            var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
            if (cls) { selector = tagName + '.' + cls; }
          }

          var elemInfo = {
            selector: selector,
            tagName: tagName,
            display: display,
            visibility: visibility,
            opacity: opacity,
            boundingRect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };

          // grid検出
          if (display === 'grid' || display === 'inline-grid') {
            var templateColumns = cs.gridTemplateColumns;
            if (templateColumns && templateColumns !== 'none') {
              elemInfo.gridColumns = templateColumns.split(' ').filter(function(c) { return c && c !== 'none'; }).length;
              if (!firstGridFound) {
                gridColumns = elemInfo.gridColumns;
                firstGridFound = true;
              }
            }
          }

          // flex検出
          if (display === 'flex' || display === 'inline-flex') {
            elemInfo.flexDirection = cs.flexDirection;
            if (!firstFlexFound) {
              flexDirection = cs.flexDirection;
              firstFlexFound = true;
            }
          }

          semanticElements.push(elemInfo);
        }

        // フォールバック: セレクタベースのgrid/flex検出
        if (!firstGridFound) {
          var gridContainer = document.querySelector('[style*="grid"], .grid, [class*="grid"]');
          if (gridContainer) {
            var gs = window.getComputedStyle(gridContainer);
            var tc = gs.gridTemplateColumns;
            if (tc && tc !== 'none') {
              gridColumns = tc.split(' ').filter(function(c) { return c && c !== 'none'; }).length;
            }
          }
        }
        if (!firstFlexFound) {
          var flexContainer = document.querySelector('[style*="flex"], .flex, [class*="flex"]');
          if (flexContainer) {
            var fs = window.getComputedStyle(flexContainer);
            flexDirection = fs.flexDirection;
          }
        }

        // タイポグラフィ情報（既存: 後方互換）
        var typography;
        var h1El = document.querySelector('h1');
        var bodyEl = document.body;
        if (bodyEl) {
          var bodyStyle = window.getComputedStyle(bodyEl);
          var bodyFontSize = parseFloat(bodyStyle.fontSize) || 16;
          var bodyLineHeight = bodyStyle.lineHeight === 'normal'
            ? 1.2
            : parseFloat(bodyStyle.lineHeight) / bodyFontSize;
          var h1FontSize = bodyFontSize;
          if (h1El) {
            h1FontSize = parseFloat(window.getComputedStyle(h1El).fontSize) || bodyFontSize;
          }
          typography = { h1FontSize: h1FontSize, bodyFontSize: bodyFontSize, bodyLineHeight: bodyLineHeight };
        }

        // Phase 4: 拡張タイポグラフィ（h1-h6 + p:first-of-type）
        var headings = [];
        for (var hi = 1; hi <= 6; hi++) {
          var heading = document.querySelector('h' + hi);
          if (heading) {
            var hfs = parseFloat(window.getComputedStyle(heading).fontSize) || 0;
            if (hfs > 0) {
              headings.push({ tag: 'h' + hi, fontSize: hfs });
            }
          }
        }
        var pFirstOfType;
        var pFirst = document.querySelector('p:first-of-type');
        if (pFirst) {
          var pfs = parseFloat(window.getComputedStyle(pFirst).fontSize);
          if (pfs > 0) { pFirstOfType = pfs; }
        }
        var extendedTypography = (headings.length > 0 || pFirstOfType !== undefined)
          ? { headings: headings, pFirstOfType: pFirstOfType }
          : undefined;

        // スペーシング情報（既存: 後方互換）
        var spacing;
        if (bodyEl) {
          var bStyle = window.getComputedStyle(bodyEl);
          var bodyPadding = {
            top: parseFloat(bStyle.paddingTop) || 0,
            right: parseFloat(bStyle.paddingRight) || 0,
            bottom: parseFloat(bStyle.paddingBottom) || 0,
            left: parseFloat(bStyle.paddingLeft) || 0,
          };
          spacing = { bodyPadding: bodyPadding };
          var mainContainer = document.querySelector('main, [role="main"], .container, .wrapper, #main');
          if (mainContainer) {
            var cStyle = window.getComputedStyle(mainContainer);
            spacing.mainContainerPadding = {
              top: parseFloat(cStyle.paddingTop) || 0,
              right: parseFloat(cStyle.paddingRight) || 0,
              bottom: parseFloat(cStyle.paddingBottom) || 0,
              left: parseFloat(cStyle.paddingLeft) || 0,
            };
          }
        }

        // Phase 4: セクション間スペーシング
        var sectionSpacing = [];
        var sectionEls = document.querySelectorAll('section, main > *');
        var maxSections = 50;
        for (var si2 = 0; si2 < sectionEls.length && si2 < maxSections; si2++) {
          var sEl = sectionEls[si2];
          var sStyle = window.getComputedStyle(sEl);
          var mTop = parseFloat(sStyle.marginTop) || 0;
          var mBot = parseFloat(sStyle.marginBottom) || 0;
          if (mTop > 0 || mBot > 0) {
            var sTag = sEl.tagName.toLowerCase();
            var sSel = sTag;
            if (sEl.id) { sSel = '#' + sEl.id; }
            sectionSpacing.push({ selector: sSel, marginTop: mTop, marginBottom: mBot });
          }
        }

        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollHeight: document.body ? document.body.scrollHeight : 0,
          breakpoints: breakpoints.filter(function(v, i, a) { return a.indexOf(v) === i; }),
          gridColumns: gridColumns,
          flexDirection: flexDirection,
          typography: typography,
          spacing: spacing,
          semanticElements: semanticElements,
          extendedTypography: extendedTypography,
          sectionSpacing: sectionSpacing.length > 0 ? sectionSpacing : undefined,
        };
      })()
    `);

    return info as ViewportLayoutInfo;
  }

  /**
   * ナビゲーション情報を検出
   * Phase 3: BoundingRectベースの検出 + 既存セレクタベースのフォールバック
   */
  private async detectNavigation(page: Page): Promise<NavigationInfo> {
    const info = await page.evaluate(
      `
      (function() {
        var navSelectors = ${JSON.stringify(DEFAULT_NAV_SELECTORS)};
        var hamburgerSelectors = ${JSON.stringify(DEFAULT_HAMBURGER_SELECTORS)};
        var hasHorizontalMenu = false;
        var hasHamburgerMenu = false;
        var hasBottomNav = false;
        var navSelector = null;

        // Step 1: ヘッダー領域走査（上部200px以内の全a/button要素）
        var allClickable = document.querySelectorAll('a, button');
        var headerLinks = [];
        for (var i = 0; i < allClickable.length; i++) {
          var el = allClickable[i];
          var rect = el.getBoundingClientRect();
          if (rect.top < 200 && rect.height > 0 && rect.width > 0) {
            var cs = window.getComputedStyle(el);
            if (cs.display !== 'none' && cs.visibility !== 'hidden') {
              headerLinks.push({ rect: rect });
            }
          }
        }

        // Step 2: 水平メニュー判定（Y座標差 < 20pxの要素が3つ以上）
        if (headerLinks.length >= 3) {
          var yGroups = {};
          for (var hi = 0; hi < headerLinks.length; hi++) {
            var yKey = Math.round(headerLinks[hi].rect.top / 20) * 20;
            if (!yGroups[yKey]) { yGroups[yKey] = 0; }
            yGroups[yKey]++;
          }
          var yKeys = Object.keys(yGroups);
          for (var yi = 0; yi < yKeys.length; yi++) {
            if (yGroups[yKeys[yi]] >= 3) {
              hasHorizontalMenu = true;
              break;
            }
          }
        }

        // Step 3: ハンバーガー判定（非表示nav要素の近傍にボタンが存在）
        var headerNavs = document.querySelectorAll('nav, [role="navigation"]');
        for (var ni = 0; ni < headerNavs.length; ni++) {
          var nav = headerNavs[ni];
          var navRect = nav.getBoundingClientRect();
          if (navRect.top < 200) {
            var navStyle = window.getComputedStyle(nav);
            if (navStyle.display === 'none' || navStyle.visibility === 'hidden') {
              var parent = nav.parentElement;
              if (parent) {
                var buttons = parent.querySelectorAll('button, [role="button"], [aria-expanded]');
                for (var bi = 0; bi < buttons.length; bi++) {
                  var btnStyle = window.getComputedStyle(buttons[bi]);
                  if (btnStyle.display !== 'none' && btnStyle.visibility !== 'hidden') {
                    hasHamburgerMenu = true;
                    break;
                  }
                }
              }
            }
          }
          if (hasHamburgerMenu) break;
        }

        // フォールバック: 既存セレクタベースのハンバーガー検出
        if (!hasHamburgerMenu) {
          for (var hsi = 0; hsi < hamburgerSelectors.length; hsi++) {
            var hel = document.querySelector(hamburgerSelectors[hsi]);
            if (hel) {
              var hs = window.getComputedStyle(hel);
              if (hs.display !== 'none' && hs.visibility !== 'hidden') {
                hasHamburgerMenu = true;
                break;
              }
            }
          }
        }

        // Step 4: ボトムナビ判定（position:fixed + ページ下部60px以内）
        var fixedCandidates = document.querySelectorAll('nav, div, footer');
        var vpHeight = window.innerHeight;
        for (var fi = 0; fi < fixedCandidates.length; fi++) {
          var fStyle = window.getComputedStyle(fixedCandidates[fi]);
          if (fStyle.position === 'fixed') {
            var fRect = fixedCandidates[fi].getBoundingClientRect();
            if (fRect.bottom >= vpHeight - 60 && fRect.height > 0 && fRect.height < 100) {
              hasBottomNav = true;
              break;
            }
          }
        }

        // フォールバック: セレクタベースのボトムナビ検出
        if (!hasBottomNav) {
          var bottomNavSelectors = ['.bottom-nav', '.bottom-navigation', '[class*="bottom-nav"]', '.tab-bar'];
          for (var bni = 0; bni < bottomNavSelectors.length; bni++) {
            var bel = document.querySelector(bottomNavSelectors[bni]);
            if (bel) {
              var bs = window.getComputedStyle(bel);
              if (bs.display !== 'none') {
                hasBottomNav = true;
                break;
              }
            }
          }
        }

        // ナビゲーション要素検出（セレクタ取得用）
        for (var nsi = 0; nsi < navSelectors.length; nsi++) {
          var nEl = document.querySelector(navSelectors[nsi]);
          if (nEl) {
            navSelector = navSelectors[nsi];
            break;
          }
        }

        // ナビゲーションタイプ判定
        var type = 'other';
        if (hasHamburgerMenu && !hasHorizontalMenu) {
          type = 'hamburger-menu';
        } else if (hasHorizontalMenu && !hasHamburgerMenu) {
          type = 'horizontal-menu';
        } else if (hasBottomNav) {
          type = 'bottom-nav';
        } else if (navSelector && !hasHamburgerMenu && !hasHorizontalMenu) {
          type = 'hidden';
        }

        return {
          type: type,
          hasHamburgerMenu: hasHamburgerMenu,
          hasHorizontalMenu: hasHorizontalMenu,
          hasBottomNav: hasBottomNav,
          selector: navSelector,
        };
      })()
    `
    );

    return info as NavigationInfo;
  }

  /**
   * スクリーンショットをキャプチャ
   * フルページ指定時、ページ高さが MAX_SCREENSHOT_HEIGHT を超える場合はクリップする
   */
  private async captureScreenshot(
    page: Page,
    viewport: ResponsiveViewport,
    fullPage: boolean
  ): Promise<ViewportScreenshot> {
    let buffer: Buffer;
    let capturedHeight: number;

    if (fullPage) {
      const scrollHeight: number = await page.evaluate(() => document.body.scrollHeight);
      const clipped = scrollHeight > MAX_SCREENSHOT_HEIGHT;

      if (clipped) {
        if (isDevelopment()) {
          logger.warn('[MultiViewportCapture] Page height exceeds MAX_SCREENSHOT_HEIGHT, clipping screenshot', {
            viewport: viewport.name,
            scrollHeight,
            maxHeight: MAX_SCREENSHOT_HEIGHT,
          });
        }
        // clip を指定して上限までキャプチャ（fullPage: false で clip 指定）
        buffer = await page.screenshot({
          fullPage: false,
          type: 'png',
          clip: {
            x: 0,
            y: 0,
            width: viewport.width,
            height: MAX_SCREENSHOT_HEIGHT,
          },
        });
        capturedHeight = MAX_SCREENSHOT_HEIGHT;
      } else {
        buffer = await page.screenshot({
          fullPage: true,
          type: 'png',
        });
        capturedHeight = scrollHeight;
      }
    } else {
      buffer = await page.screenshot({
        fullPage: false,
        type: 'png',
      });
      capturedHeight = viewport.height;
    }

    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      screenshot: {
        base64: buffer.toString('base64'),
        format: 'png',
        width: viewport.width,
        height: capturedHeight,
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
   * 外部CSSからブレークポイントを抽出
   * SSRF保護は external-css-fetcher に組み込み済み
   *
   * @param html - ページHTML
   * @param pageUrl - ページURL（相対URL解決用）
   * @returns ブレークポイント値の配列（例: ['768px', '1024px']）
   */
  async extractBreakpointsFromExternalCss(html: string, pageUrl: string): Promise<string[]> {
    try {
      const cssUrls = extractCssUrls(html, pageUrl);
      if (cssUrls.length === 0) {
        return [];
      }

      const results = await fetchAllCss(
        cssUrls.map((u) => u.url),
        { timeout: 5000 }
      );

      const breakpoints = new Set<string>();
      const mediaQueryPattern = /@media[^{]*\{/g;
      const pxValuePattern = /(\d+)px/g;

      for (const result of results) {
        if (!result.content) continue;
        let mediaMatch: RegExpExecArray | null;
        while ((mediaMatch = mediaQueryPattern.exec(result.content)) !== null) {
          const mediaRule = mediaMatch[0];
          let pxMatch: RegExpExecArray | null;
          while ((pxMatch = pxValuePattern.exec(mediaRule)) !== null) {
            if (pxMatch[1]) {
              breakpoints.add(`${pxMatch[1]}px`);
            }
          }
        }
        // reset lastIndex for reuse
        mediaQueryPattern.lastIndex = 0;
      }

      if (isDevelopment()) {
        logger.info('[MultiViewportCapture] External CSS breakpoints extracted', {
          cssUrlCount: cssUrls.length,
          breakpointCount: breakpoints.size,
        });
      }

      return Array.from(breakpoints);
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[MultiViewportCapture] Failed to extract breakpoints from external CSS', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }

  /**
   * 指定幅でセマンティック要素のcomputedStyleを取得
   * precise ブレークポイント検出用
   */
  async captureSemanticStylesAtWidth(
    browser: Browser,
    url: string,
    width: number,
    timeout: number
  ): Promise<SemanticElementInfo[]> {
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      page = await context.newPage();
      page.setDefaultTimeout(timeout);

      await page.goto(url, { timeout, waitUntil: 'load' });
      await this.waitForDomStable(page, 300);

      const layoutInfo = await this.extractLayoutInfo(page, { name: `probe-${width}`, width, height: 800 });
      return layoutInfo.semanticElements ?? [];
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  }

  /**
   * preciseモード: 二分探索でブレークポイントを±8px精度で特定
   * 最大3ブレークポイントまで探索
   *
   * @param browser - ブラウザインスタンス
   * @param url - 対象URL
   * @param candidateBreakpoints - 候補ブレークポイント（px値の数値配列）
   * @param timeout - タイムアウト
   * @returns 検証済みブレークポイント
   */
  async detectPreciseBreakpoints(
    browser: Browser,
    url: string,
    candidateBreakpoints: number[],
    timeout: number
  ): Promise<Array<{ value: number; verified: boolean }>> {
    // 最大3ブレークポイントに制限
    const candidates = candidateBreakpoints.slice(0, 3);
    const results: Array<{ value: number; verified: boolean }> = [];

    for (const candidate of candidates) {
      try {
        // 候補±50pxの範囲でスタイル比較
        const lowWidth = Math.max(320, candidate - 50);
        const highWidth = Math.min(4096, candidate + 50);

        const stylesLow = await this.captureSemanticStylesAtWidth(browser, url, lowWidth, timeout);
        const stylesHigh = await this.captureSemanticStylesAtWidth(browser, url, highWidth, timeout);

        if (!this.semanticStylesDiffer(stylesLow, stylesHigh)) {
          // スタイルが同じ → このブレークポイントでは変化なし
          results.push({ value: candidate, verified: false });
          continue;
        }

        // 二分探索（±8px精度まで）
        let lo = lowWidth;
        let hi = highWidth;

        while (hi - lo > 8) {
          const mid = Math.floor((lo + hi) / 2);
          const stylesMid = await this.captureSemanticStylesAtWidth(browser, url, mid, timeout);

          if (this.semanticStylesDiffer(stylesMid, stylesHigh)) {
            // midとhighが異なる → ブレークポイントはmid〜hiの間
            lo = mid;
          } else {
            // midとhighが同じ → ブレークポイントはlo〜midの間
            hi = mid;
          }
        }

        results.push({ value: hi, verified: true });
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MultiViewportCapture] Precise breakpoint detection failed', {
            candidate,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        results.push({ value: candidate, verified: false });
      }
    }

    return results;
  }

  /**
   * 2つのセマンティックスタイル配列に有意な差異があるか判定
   */
  private semanticStylesDiffer(a: SemanticElementInfo[], b: SemanticElementInfo[]): boolean {
    // タグ名ベースでマッチングして比較
    const bBySelector = new Map<string, SemanticElementInfo>();
    for (const elem of b) {
      bBySelector.set(elem.selector, elem);
    }

    for (const elemA of a) {
      const elemB = bBySelector.get(elemA.selector);
      if (!elemB) continue;

      // display/visibility/opacity/gridColumns/flexDirectionの差異をチェック
      if (
        elemA.display !== elemB.display ||
        elemA.visibility !== elemB.visibility ||
        Math.abs(elemA.opacity - elemB.opacity) > 0.01 ||
        elemA.gridColumns !== elemB.gridColumns ||
        elemA.flexDirection !== elemB.flexDirection
      ) {
        return true;
      }
    }

    return false;
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
export const multiViewportCaptureService = new MultiViewportCaptureService();
