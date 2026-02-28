// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaywrightCrawlerService
 * Playwrightを使用したWebクローリングサービス
 *
 * 機能:
 * - Webページのクロール（HTML取得）
 * - スクリーンショット撮影
 * - メタデータ抽出（title, description）
 * - SSRF対策（プライベートIP、メタデータサービスをブロック）
 * - タイムアウト処理
 * - viewport設定
 *
 * @module services/page/playwright-crawler.service
 */

import type { Browser, Page, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { validateExternalUrl } from '../../utils/url-validator';
import { logger, isDevelopment } from '../../utils/logger';
import { withTimeout } from '../../tools/page/handlers/timeout-utils';
import { isUrlAllowedByRobotsTxt, ROBOTS_TXT } from '@reftrix/core';

// =====================================================
// 型定義
// =====================================================

/**
 * クロールオプション
 */
export interface CrawlOptions {
  /** タイムアウト（ミリ秒） デフォルト: 30000 */
  timeout?: number | undefined;
  /** ページ読み込み完了の判定方法 デフォルト: 'load' */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
  /** ビューポートサイズ デフォルト: { width: 1440, height: 900 } */
  viewport?: { width: number; height: number } | undefined;
  /** robots.txtを尊重するかどうか（RFC 9309） */
  respectRobotsTxt?: boolean | undefined;
}

/**
 * クロール結果
 */
export interface CrawlResult {
  /** 取得したHTML */
  html: string;
  /** ページタイトル */
  title?: string | undefined;
  /** メタdescription */
  description?: string | undefined;
  /** スクリーンショット（base64エンコード） */
  screenshot?: string | undefined;
}

/**
 * デフォルトのクロールオプション
 */
export const DEFAULT_CRAWL_OPTIONS: Required<Omit<CrawlOptions, 'respectRobotsTxt'>> & Pick<CrawlOptions, 'respectRobotsTxt'> = {
  timeout: 30000,
  // WebGL/3Dサイト対応: domcontentloadedをデフォルトに（loadは3Dサイトで非常に時間がかかる）
  waitUntil: 'domcontentloaded',
  viewport: { width: 1440, height: 900 },
};

// =====================================================
// エラークラス
// =====================================================

/**
 * SSRFブロックエラー
 */
export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

/**
 * プロトコルエラー
 */
export class InvalidProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProtocolError';
  }
}

/**
 * クロールエラー
 */
export class CrawlError extends Error {
  public readonly statusCode?: number | undefined;

  constructor(message: string, statusCode?: number | undefined) {
    super(message);
    this.name = 'CrawlError';
    this.statusCode = statusCode;
  }
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * URLのプロトコルを検証
 */
function validateProtocol(url: string): void {
  const allowedProtocols = ['http:', 'https:'];

  try {
    const urlObj = new URL(url);
    if (!allowedProtocols.includes(urlObj.protocol)) {
      throw new InvalidProtocolError(
        `Invalid protocol: only http and https are allowed, got ${urlObj.protocol}`
      );
    }
  } catch (error) {
    if (error instanceof InvalidProtocolError) {
      throw error;
    }
    throw new CrawlError(`Invalid URL format: ${url}`);
  }
}

/**
 * URLのSSRF検証
 */
function validateUrlForSSRF(url: string): void {
  const result = validateExternalUrl(url);
  if (!result.valid) {
    throw new SSRFBlockedError(result.error ?? 'URL is blocked for security reasons');
  }
}

/**
 * HTMLからメタデータを抽出
 */
function extractMetadataFromHtml(html: string): { description?: string } {
  const result: { description?: string } = {};

  // description
  const descMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i
  );
  if (!descMatch) {
    // content が先に来るパターン
    const descMatchAlt = html.match(
      /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i
    );
    if (descMatchAlt && descMatchAlt[1]) {
      result.description = descMatchAlt[1].trim();
    }
  } else if (descMatch[1]) {
    result.description = descMatch[1].trim();
  }

  return result;
}

// =====================================================
// PlaywrightCrawlerService クラス
// =====================================================

/**
 * Playwrightを使用したWebクローラーサービス
 */
export class PlaywrightCrawlerService {
  private browser: Browser | null = null;

  /**
   * ブラウザを初期化（健全性チェック付き）
   *
   * Note: BullMQ Worker環境でシングルトンブラウザを使用する際、
   * ブラウザがクローズ済みの場合にレースコンディションが発生するため、
   * 健全性チェックを実施してクローズ済みの場合はリセットする。
   */
  private async ensureBrowser(): Promise<Browser> {
    // 健全性チェック: 既存ブラウザがクローズ済みかどうか確認
    if (this.browser) {
      try {
        // ブラウザが生きているか確認（contexts()がエラーを投げたらクローズ済み）
        await this.browser.contexts();
      } catch (error) {
        // ブラウザがクローズ済みの場合はリセット
        if (isDevelopment()) {
          logger.warn('[PlaywrightCrawlerService] Browser was closed unexpectedly, resetting instance', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.browser = null;
      }
    }

    if (!this.browser) {
      if (isDevelopment()) {
        logger.debug('[PlaywrightCrawlerService] Launching browser');
      }
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
    }
    return this.browser;
  }

  /**
   * Webページをクロール
   *
   * @param url - クロールするURL
   * @param options - クロールオプション
   * @returns クロール結果
   * @throws SSRFBlockedError - SSRF攻撃の可能性がある場合
   * @throws InvalidProtocolError - 無効なプロトコルの場合
   * @throws CrawlError - クロール中のエラー
   */
  async crawl(url: string, options: CrawlOptions = {}): Promise<CrawlResult> {
    const opts = { ...DEFAULT_CRAWL_OPTIONS, ...options };

    if (isDevelopment()) {
      logger.debug('[PlaywrightCrawlerService] crawl called', {
        url,
        timeout: opts.timeout,
        waitUntil: opts.waitUntil,
        viewport: opts.viewport,
      });
    }

    // プロトコル検証
    validateProtocol(url);

    // SSRF検証
    validateUrlForSSRF(url);

    // robots.txt チェック（RFC 9309準拠）
    const robotsResult = await isUrlAllowedByRobotsTxt(url, opts.respectRobotsTxt);
    if (!robotsResult.allowed) {
      throw new CrawlError(
        `Blocked by robots.txt: ${url} (domain: ${robotsResult.domain}, reason: ${robotsResult.reason}). ` +
        `Use respect_robots_txt: false to override. ` +
          `Note: Overriding robots.txt may have legal implications depending on jurisdiction (e.g., EU DSM Directive Article 4).`,
      );
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      const browser = await this.ensureBrowser();

      // 新しいコンテキストを作成（分離のため）
      context = await browser.newContext({
        viewport: opts.viewport ?? null,
        userAgent: ROBOTS_TXT.USER_AGENT,
        // セキュリティ設定
        javaScriptEnabled: true,
        bypassCSP: false,
      });

      page = await context.newPage();

      // ナビゲーション（WebGL/3Dサイト対応: domcontentloadedをデフォルトに）
      const response = await page.goto(url, {
        waitUntil: opts.waitUntil ?? 'domcontentloaded',
        timeout: opts.timeout ?? 30000,
      });

      // レスポンスステータスのチェック
      if (response) {
        const status = response.status();
        if (status >= 400) {
          if (status === 404) {
            throw new CrawlError(`Page not found: 404 error for ${url}`, 404);
          } else if (status >= 500) {
            throw new CrawlError(`Server error: ${status} for ${url}`, status);
          } else {
            throw new CrawlError(`HTTP error: ${status} for ${url}`, status);
          }
        }
      }

      // HTML取得（タイムアウト付き: 重いJSサイトでpage.content()が無限ハングする対策）
      const operationTimeout = opts.timeout ?? 30000;
      const html = await withTimeout(
        page.content(),
        operationTimeout,
        'page.content()'
      );

      // タイトル取得
      const title = await page.title();

      // メタデータ抽出
      const metadata = extractMetadataFromHtml(html);

      // スクリーンショット取得（タイムアウト付き）
      const screenshotBuffer = await withTimeout(
        page.screenshot({
          type: 'png',
          fullPage: false, // viewportサイズのみ
        }),
        operationTimeout,
        'page.screenshot()'
      );
      const screenshot = screenshotBuffer.toString('base64');

      if (isDevelopment()) {
        logger.debug('[PlaywrightCrawlerService] crawl completed', {
          url,
          htmlLength: html.length,
          hasTitle: !!title,
          hasDescription: !!metadata.description,
          screenshotSize: screenshot.length,
        });
      }

      return {
        html,
        title: title || undefined,
        description: metadata.description,
        screenshot,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[PlaywrightCrawlerService] crawl error', { url, error });
      }

      // ブラウザがクローズされたエラーの場合はインスタンスをリセット
      // "Target page, context or browser has been closed" エラーに対応
      if (error instanceof Error) {
        const isBrowserClosedError =
          error.message.includes('has been closed') ||
          error.message.includes('Target closed') ||
          error.message.includes('browser has been closed') ||
          error.message.includes('context has been closed');

        if (isBrowserClosedError) {
          if (isDevelopment()) {
            logger.warn('[PlaywrightCrawlerService] Browser closed error detected, resetting instance', {
              url,
              error: error.message,
            });
          }
          // ブラウザインスタンスをリセット（次回呼び出し時に再起動）
          this.browser = null;
          throw new CrawlError(`Browser was closed unexpectedly. Please retry: ${error.message}`);
        }
      }

      // 既知のエラータイプは再スロー
      if (
        error instanceof SSRFBlockedError ||
        error instanceof InvalidProtocolError ||
        error instanceof CrawlError
      ) {
        throw error;
      }

      // Playwrightのタイムアウトエラー
      if (error instanceof Error) {
        if (error.message.includes('Timeout') || error.message.includes('timeout')) {
          throw new CrawlError(`Timeout: page load exceeded ${opts.timeout}ms`);
        }

        // DNS/ネットワークエラー
        if (
          error.message.includes('net::ERR_NAME_NOT_RESOLVED') ||
          error.message.includes('DNS') ||
          error.message.includes('ENOTFOUND')
        ) {
          throw new CrawlError(`Network error: unable to resolve DNS for ${url}`);
        }

        // その他のネットワークエラー
        if (
          error.message.includes('net::') ||
          error.message.includes('Network') ||
          error.message.includes('ECONNREFUSED')
        ) {
          throw new CrawlError(`Network error: ${error.message}`);
        }
      }

      // 不明なエラー
      throw new CrawlError(
        `Crawl failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // リソースクリーンアップ
      if (page) {
        await page.close().catch(() => {
          // ページクローズエラーは無視
        });
      }
      if (context) {
        await context.close().catch(() => {
          // コンテキストクローズエラーは無視
        });
      }
    }
  }

  /**
   * ブラウザを閉じる
   */
  async close(): Promise<void> {
    if (this.browser) {
      if (isDevelopment()) {
        logger.debug('[PlaywrightCrawlerService] Closing browser');
      }
      await this.browser.close();
      this.browser = null;
    }
  }
}

// =====================================================
// スタンドアロン関数
// =====================================================

/**
 * シングルトンインスタンス
 */
let sharedService: PlaywrightCrawlerService | null = null;

/**
 * 共有サービスインスタンスを取得
 */
function getSharedService(): PlaywrightCrawlerService {
  if (!sharedService) {
    sharedService = new PlaywrightCrawlerService();
  }
  return sharedService;
}

/**
 * Webページをクロール（スタンドアロン関数）
 *
 * @param url - クロールするURL
 * @param options - クロールオプション
 * @returns クロール結果
 *
 * @example
 * ```typescript
 * const result = await crawlPage('https://example.com', {
 *   timeout: 10000,
 *   waitUntil: 'networkidle',
 *   viewport: { width: 1920, height: 1080 },
 * });
 * console.log(result.html);
 * console.log(result.title);
 * console.log(result.screenshot); // base64
 * ```
 */
export async function crawlPage(
  url: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const service = getSharedService();
  return service.crawl(url, options);
}

/**
 * 共有サービスを閉じる
 */
export async function closeSharedService(): Promise<void> {
  if (sharedService) {
    await sharedService.close();
    sharedService = null;
  }
}
