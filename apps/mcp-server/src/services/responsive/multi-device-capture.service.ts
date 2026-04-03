// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multi-Device Capture Service
 * 3ビューポート（desktop/tablet/mobile）同時キャプチャサービス
 *
 * Promise.allで並列実行し、各ビューポートでスクリーンショット+DOM構造を取得する。
 * メモリ圧力チェック、SSRF検証を各キャプチャ前に実施。
 *
 * @module services/responsive/multi-device-capture.service
 */

import { type Browser, type BrowserContext, type Page } from "playwright";
import { logger, isDevelopment } from "../../utils/logger";
import { SharedBrowserManager } from "./shared-browser-manager";
import { validateExternalUrl } from "../../utils/url-validator";
import { checkMemoryPressure } from "../../workers/phases/types";
import type { ResponsiveViewport } from "./types";

// ============================================================================
// 定数定義 / Constants
// ============================================================================

/**
 * デフォルトデバイスビューポート
 * Default device viewports for multi-device capture
 */
export const DEVICE_VIEWPORTS: ResponsiveViewport[] = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];

/** キャプチャタイムアウト上限 (ms) / Capture timeout upper limit */
const MAX_CAPTURE_TIMEOUT_MS = 60_000;

/** フルページスクリーンショット高さ上限 (px) / Full page screenshot height limit */
const MAX_SCREENSHOT_HEIGHT = 30_000;

// ============================================================================
// 型定義 / Types
// ============================================================================

/**
 * DOM要素情報（セクション構造）
 * DOM element info (section structure) extracted from page
 */
export interface DeviceSectionInfo {
  selector: string;
  tagName: string;
  display: string;
  visibility: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  gridColumns?: number;
  flexDirection?: string;
  fontSize?: number;
}

/**
 * デバイスキャプチャ結果
 * Capture result for a single device viewport
 */
export interface DeviceCaptureItem {
  viewport: ResponsiveViewport;
  sections: DeviceSectionInfo[];
  documentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  screenshotSize: number;
  error?: string;
}

/**
 * マルチデバイスキャプチャ結果
 * Multi-device capture result
 */
export interface MultiDeviceCaptureResult {
  url: string;
  captures: DeviceCaptureItem[];
  captureTimeMs: number;
}

/**
 * キャプチャオプション
 * Capture options
 */
export interface MultiDeviceCaptureOptions {
  timeout: number;
  includeScreenshots?: boolean;
  viewports?: ResponsiveViewport[];
}

// ============================================================================
// Service
// ============================================================================

/**
 * Multi-Device Capture Service
 * 3ビューポートを並列キャプチャし、DOM構造情報を返す
 */
export class MultiDeviceCaptureService {
  private readonly browserManager = new SharedBrowserManager("MultiDeviceCapture");

  /**
   * 全デバイスビューポートでキャプチャ実行
   *
   * @param url - キャプチャ対象URL
   * @param options - キャプチャオプション
   * @param sharedBrowser - 共有ブラウザインスタンス（任意）
   * @returns キャプチャ結果
   */
  async captureAllDevices(
    url: string,
    options: MultiDeviceCaptureOptions,
    sharedBrowser?: Browser
  ): Promise<MultiDeviceCaptureResult> {
    const startTime = Date.now();
    const viewports = options.viewports ?? DEVICE_VIEWPORTS;
    const safeTimeout = Math.min(
      Math.max(1, Number.isFinite(options.timeout) ? options.timeout : 30_000),
      MAX_CAPTURE_TIMEOUT_MS
    );

    // SSRF検証 / SSRF validation
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      throw new Error(`SSRF validation failed: ${urlValidation.error ?? "URL is blocked"}`);
    }

    // メモリ圧力チェック / Memory pressure check (pre-flight)
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      throw new Error(
        `Memory pressure critical (RSS: ${memCheck.rssMb}MB). Aborting multi-device capture.`
      );
    }

    if (isDevelopment()) {
      logger.info("[MultiDeviceCapture] Starting multi-device capture", {
        url,
        viewports: viewports.map((v) => v.name),
        includeScreenshots: options.includeScreenshots ?? false,
        usingSharedBrowser: !!sharedBrowser,
      });
    }

    const browser = await this.browserManager.resolveOrLaunch(sharedBrowser);

    // 並列キャプチャ (Promise.all)
    const capturePromises = viewports.map((viewport) =>
      this.captureAtDevice(browser, url, viewport, safeTimeout, options.includeScreenshots ?? false)
    );

    const captures = await Promise.all(capturePromises);

    const captureTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[MultiDeviceCapture] Multi-device capture completed", {
        url,
        viewportCount: captures.length,
        successCount: captures.filter((c) => !c.error).length,
        captureTimeMs,
      });
    }

    return {
      url,
      captures,
      captureTimeMs,
    };
  }

  /**
   * 単一デバイスビューポートでキャプチャ
   */
  private async captureAtDevice(
    browser: Browser,
    url: string,
    viewport: ResponsiveViewport,
    timeout: number,
    includeScreenshots: boolean
  ): Promise<DeviceCaptureItem> {
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // キャプチャ前メモリチェック / Pre-capture memory check
      const memCheck = checkMemoryPressure();
      if (memCheck.shouldAbort) {
        return this.createErrorCapture(
          viewport,
          `Memory pressure critical (RSS: ${memCheck.rssMb}MB)`
        );
      }

      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        userAgent: SharedBrowserManager.getUserAgent(viewport.name),
      });

      page = await context.newPage();
      page.setDefaultTimeout(timeout);

      await page.goto(url, {
        timeout,
        waitUntil: "load",
      });

      // DOM構造抽出 / Extract DOM structure
      const domInfo = await this.extractDomStructure(page);

      // スクリーンショット取得 / Screenshot capture
      let screenshotSize = 0;
      if (includeScreenshots) {
        const scrollHeight: number = await page.evaluate(() => document.body.scrollHeight);
        const clipped = scrollHeight > MAX_SCREENSHOT_HEIGHT;
        let buffer: Buffer;

        if (clipped) {
          buffer = await page.screenshot({
            fullPage: false,
            type: "png",
            clip: {
              x: 0,
              y: 0,
              width: viewport.width,
              height: MAX_SCREENSHOT_HEIGHT,
            },
          });
        } else {
          buffer = await page.screenshot({
            fullPage: true,
            type: "png",
          });
        }
        screenshotSize = buffer.length;
      }

      return {
        viewport,
        sections: domInfo.sections,
        documentHeight: domInfo.documentHeight,
        viewportWidth: domInfo.viewportWidth,
        viewportHeight: domInfo.viewportHeight,
        screenshotSize,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn("[MultiDeviceCapture] Capture failed for device", {
        viewport: viewport.name,
        error: errorMessage,
      });
      return this.createErrorCapture(viewport, errorMessage);
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
   * ページからDOM構造情報を抽出
   */
  private async extractDomStructure(page: Page): Promise<{
    sections: DeviceSectionInfo[];
    documentHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  }> {
    const info = await page.evaluate(`
      (function() {
        var SEMANTIC_SELECTOR = 'header, nav, main, section, aside, footer, article, h1, h2, h3';
        var MAX_ELEMENTS = 200;
        var elements = document.querySelectorAll(SEMANTIC_SELECTOR);
        var sections = [];

        for (var i = 0; i < elements.length && i < MAX_ELEMENTS; i++) {
          var el = elements[i];
          var cs = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();

          var tagName = el.tagName.toLowerCase();
          var selector = tagName;
          if (el.id) {
            selector = '#' + el.id;
          } else if (el.className && typeof el.className === 'string') {
            var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
            if (cls) { selector = tagName + '.' + cls; }
          }

          var info = {
            selector: selector,
            tagName: tagName,
            display: cs.display,
            visibility: cs.visibility,
            boundingRect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };

          // grid columns
          if (cs.display === 'grid' || cs.display === 'inline-grid') {
            var tc = cs.gridTemplateColumns;
            if (tc && tc !== 'none') {
              info.gridColumns = tc.split(' ').filter(function(c) { return c && c !== 'none'; }).length;
            }
          }

          // flex direction
          if (cs.display === 'flex' || cs.display === 'inline-flex') {
            info.flexDirection = cs.flexDirection;
          }

          // font size (for headings)
          if (tagName.match(/^h[1-6]$/)) {
            info.fontSize = parseFloat(cs.fontSize) || 0;
          }

          sections.push(info);
        }

        return {
          sections: sections,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      })()
    `);

    return info as {
      sections: DeviceSectionInfo[];
      documentHeight: number;
      viewportWidth: number;
      viewportHeight: number;
    };
  }

  /**
   * エラーキャプチャ結果を作成
   */
  private createErrorCapture(viewport: ResponsiveViewport, error: string): DeviceCaptureItem {
    return {
      viewport,
      sections: [],
      documentHeight: 0,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      screenshotSize: 0,
      error,
    };
  }

  /**
   * ブラウザを終了
   */
  async close(): Promise<void> {
    await this.browserManager.close();
  }
}
