// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VideoRecorderService
 * Playwrightを使用したWebページ動画録画サービス
 *
 * 機能:
 * - Webページの動画録画（webm形式）
 * - ページスクロール・マウス移動によるインタラクション録画
 * - SSRF対策（プライベートIP、メタデータサービスをブロック）
 * - リソースクリーンアップ（一時ファイル削除）
 * - タイムアウト処理
 *
 * Phase1: 動画キャプチャ - Playwright録画 + フレーム解析
 *
 * @module services/page/video-recorder.service
 */

import type { Browser, Page, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateExternalUrl } from '../../utils/url-validator';
import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * 録画オプション
 */
export interface RecordOptions {
  /** タイムアウト（ミリ秒） デフォルト: 30000 */
  timeout?: number;
  /** ビューポートサイズ デフォルト: { width: 1280, height: 720 } */
  viewport?: { width: number; height: number };
  /** 録画解像度 デフォルト: viewportと同じ */
  recordSize?: { width: number; height: number };
  /** ページ読み込み完了の判定方法 デフォルト: 'load' */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** 録画時間（ミリ秒） デフォルト: 5000 */
  recordDuration?: number;
  /** スクロール操作を行うか デフォルト: true */
  scrollPage?: boolean;
  /** マウス移動操作を行うか デフォルト: true */
  moveMouseRandomly?: boolean;
}

/**
 * 録画結果
 */
export interface RecordResult {
  /** 録画した動画ファイルのパス（webm形式） */
  videoPath: string;
  /** 動画の長さ（ミリ秒） */
  durationMs: number;
  /** 録画サイズ（バイト） */
  sizeBytes: number;
  /** ページタイトル */
  title?: string | undefined;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * デフォルトの録画オプション
 */
export const DEFAULT_RECORD_OPTIONS: Required<RecordOptions> = {
  timeout: 30000,
  viewport: { width: 1280, height: 720 },
  recordSize: { width: 1280, height: 720 },
  // WebGL/3Dサイト対応: domcontentloadedをデフォルトに（loadは3Dサイトで非常に時間がかかる）
  waitUntil: 'domcontentloaded',
  recordDuration: 5000,
  scrollPage: true,
  moveMouseRandomly: true,
};

// =====================================================
// エラークラス
// =====================================================

/**
 * 録画エラー
 */
export class RecordError extends Error {
  public readonly statusCode?: number | undefined;

  constructor(message: string, statusCode?: number | undefined) {
    super(message);
    this.name = 'RecordError';
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
      throw new RecordError(
        `Invalid protocol: only http and https are allowed, got ${urlObj.protocol}`
      );
    }
  } catch (error) {
    if (error instanceof RecordError) {
      throw error;
    }
    throw new RecordError(`Invalid URL format: ${url}`);
  }
}

/**
 * URLのSSRF検証
 */
function validateUrlForSSRF(url: string): void {
  const result = validateExternalUrl(url);
  if (!result.valid) {
    throw new RecordError(result.error ?? 'URL is blocked for security reasons');
  }
}

/**
 * 一時ディレクトリを作成
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'video-recorder-'));
}

/**
 * ランダムな遅延を生成（ミリ秒）
 */
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * スリープ関数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// VideoRecorderService クラス
// =====================================================

/**
 * Playwrightを使用したWebページ動画録画サービス
 */
export class VideoRecorderService {
  private browser: Browser | null = null;
  private tempDirs: string[] = [];

  /**
   * ブラウザを初期化
   */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      if (isDevelopment()) {
        logger.debug('[VideoRecorderService] Launching browser');
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
   * ページでスクロールとマウス移動を実行
   */
  private async performInteractions(
    page: Page,
    opts: Required<RecordOptions>,
    durationMs: number
  ): Promise<void> {
    const startTime = Date.now();
    const { viewport, scrollPage, moveMouseRandomly } = opts;

    while (Date.now() - startTime < durationMs) {
      // スクロール操作
      if (scrollPage) {
        const scrollY = randomDelay(100, 300);
        // eslint-disable-next-line no-undef -- window is browser context
        await page.evaluate((y) => window.scrollBy(0, y), scrollY);
        await sleep(randomDelay(200, 500));
      }

      // マウス移動
      if (moveMouseRandomly) {
        const x = randomDelay(0, viewport.width);
        const y = randomDelay(0, viewport.height);
        await page.mouse.move(x, y);
        await sleep(randomDelay(100, 300));
      }

      // インタラクションなしの場合は単純に待機
      if (!scrollPage && !moveMouseRandomly) {
        await sleep(500);
      }
    }
  }

  /**
   * Webページを録画
   *
   * @param url - 録画するURL
   * @param options - 録画オプション
   * @returns 録画結果
   * @throws RecordError - 録画中のエラー
   */
  async record(url: string, options: RecordOptions = {}): Promise<RecordResult> {
    const startTime = Date.now();
    const opts = {
      ...DEFAULT_RECORD_OPTIONS,
      ...options,
      recordSize: options.recordSize ?? options.viewport ?? DEFAULT_RECORD_OPTIONS.recordSize,
    };

    if (isDevelopment()) {
      logger.debug('[VideoRecorderService] record called', {
        url,
        timeout: opts.timeout,
        viewport: opts.viewport,
        recordSize: opts.recordSize,
        recordDuration: opts.recordDuration,
      });
    }

    // プロトコル検証
    validateProtocol(url);

    // SSRF検証
    validateUrlForSSRF(url);

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let tempDir: string | null = null;

    try {
      const browser = await this.ensureBrowser();

      // 一時ディレクトリを作成
      tempDir = createTempDir();
      this.tempDirs.push(tempDir);

      // 録画設定付きでコンテキストを作成
      context = await browser.newContext({
        viewport: opts.viewport ?? null,
        recordVideo: {
          dir: tempDir,
          size: opts.recordSize,
        },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.1.0',
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
            throw new RecordError(`Page not found: 404 error for ${url}`, 404);
          } else if (status >= 500) {
            throw new RecordError(`Server error: ${status} for ${url}`, status);
          } else {
            throw new RecordError(`HTTP error: ${status} for ${url}`, status);
          }
        }
      }

      // ページタイトル取得
      const title = await page.title();

      // インタラクション実行（録画中）
      await this.performInteractions(page, opts, opts.recordDuration);

      // ページを閉じる前に動画を取得する準備
      const video = page.video();
      if (!video) {
        throw new RecordError('Failed to start video recording');
      }

      // ページとコンテキストを閉じて動画ファイルを確定
      await page.close();
      page = null;
      await context.close();
      context = null;

      // 動画ファイルのパスを取得
      const videoPath = await video.path();
      if (!videoPath) {
        throw new RecordError('Failed to get video path');
      }

      // 動画ファイルのサイズを取得
      const stats = fs.statSync(videoPath);
      const sizeBytes = stats.size;

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.debug('[VideoRecorderService] record completed', {
          url,
          videoPath,
          sizeBytes,
          durationMs: opts.recordDuration,
          processingTimeMs,
        });
      }

      return {
        videoPath,
        durationMs: opts.recordDuration,
        sizeBytes,
        title: title || undefined,
        processingTimeMs,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VideoRecorderService] record error', { url, error });
      }

      // 既知のエラータイプは再スロー
      if (error instanceof RecordError) {
        throw error;
      }

      // Playwrightのタイムアウトエラー
      if (error instanceof Error) {
        if (error.message.includes('Timeout') || error.message.includes('timeout')) {
          throw new RecordError(`Timeout: page load exceeded ${opts.timeout}ms`);
        }

        // DNS/ネットワークエラー
        if (
          error.message.includes('net::ERR_NAME_NOT_RESOLVED') ||
          error.message.includes('DNS') ||
          error.message.includes('ENOTFOUND')
        ) {
          throw new RecordError(`Network error: unable to resolve DNS for ${url}`);
        }

        // その他のネットワークエラー
        if (
          error.message.includes('net::') ||
          error.message.includes('Network') ||
          error.message.includes('ECONNREFUSED')
        ) {
          throw new RecordError(`Network error: ${error.message}`);
        }
      }

      // 不明なエラー
      throw new RecordError(
        `Record failed: ${error instanceof Error ? error.message : 'Unknown error'}`
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
   * 指定した動画ファイルを削除
   *
   * @param videoPath - 削除する動画ファイルのパス
   */
  async cleanup(videoPath: string): Promise<void> {
    try {
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        if (isDevelopment()) {
          logger.debug('[VideoRecorderService] cleanup: deleted video', { videoPath });
        }
      }

      // 親ディレクトリが空なら削除
      const dir = path.dirname(videoPath);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        if (files.length === 0) {
          fs.rmdirSync(dir);
          // tempDirsから削除
          const index = this.tempDirs.indexOf(dir);
          if (index > -1) {
            this.tempDirs.splice(index, 1);
          }
          if (isDevelopment()) {
            logger.debug('[VideoRecorderService] cleanup: deleted temp dir', { dir });
          }
        }
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VideoRecorderService] cleanup error', { videoPath, error });
      }
      // クリーンアップエラーは無視（ベストエフォート）
    }
  }

  /**
   * ブラウザと一時ファイルをすべてクリーンアップ
   */
  async close(): Promise<void> {
    // 一時ディレクトリをすべて削除
    for (const dir of this.tempDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // クリーンアップエラーは無視
      }
    }
    this.tempDirs = [];

    // ブラウザを閉じる
    if (this.browser) {
      if (isDevelopment()) {
        logger.debug('[VideoRecorderService] Closing browser');
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
let sharedService: VideoRecorderService | null = null;

/**
 * 共有サービスインスタンスを取得
 */
function getSharedService(): VideoRecorderService {
  if (!sharedService) {
    sharedService = new VideoRecorderService();
  }
  return sharedService;
}

/**
 * Webページを録画（スタンドアロン関数）
 *
 * @param url - 録画するURL
 * @param options - 録画オプション
 * @returns 録画結果
 *
 * @example
 * ```typescript
 * const result = await recordPage('https://example.com', {
 *   timeout: 10000,
 *   recordDuration: 5000,
 *   viewport: { width: 1920, height: 1080 },
 * });
 * console.log(result.videoPath); // /tmp/video-recorder-xxx/video.webm
 * console.log(result.durationMs);
 * console.log(result.sizeBytes);
 * ```
 */
export async function recordPage(
  url: string,
  options: RecordOptions = {}
): Promise<RecordResult> {
  const service = getSharedService();
  return service.record(url, options);
}

/**
 * 共有サービスを閉じる
 */
export async function closeSharedRecorder(): Promise<void> {
  if (sharedService) {
    await sharedService.close();
    sharedService = null;
  }
}
