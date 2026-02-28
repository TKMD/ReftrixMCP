// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-env browser */
/* eslint-disable no-undef */
/**
 * FrameCaptureService
 *
 * Playwrightを使用してWebページをスクロールしながらフレームをキャプチャ
 *
 * 仕様:
 * - scroll_px_per_frame デフォルト: 15px（Reftrix仕様）
 * - frame_interval_ms デフォルト: 33ms（30fps等価）
 * - output_format デフォルト: 'png'
 *
 * 15px/frame の根拠:
 * - 60fps等価スクロール（216px/秒 / 60 ≈ 3.6px）と50px/frameの中間
 * - IntersectionObserver閾値（0.1〜0.3）を確実に検出
 * - cubic-bezier easing曲線の解析に十分なサンプル数
 * - parallax微動（係数0.02〜0.05）の検出可能
 *
 * @module @reftrix/mcp-server/services/motion/frame-capture.service
 */

import type { Page, PageScreenshotOptions } from 'playwright';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// ============================================================================
// 型定義
// ============================================================================

/**
 * フレームキャプチャオプション
 */
export interface FrameCaptureServiceOptions {
  /** スクロール量/フレーム (px)。デフォルト: 15 */
  scroll_px_per_frame?: number;

  /** フレーム間隔 (ms)。デフォルト: 33 (30fps等価) */
  frame_interval_ms?: number;

  /** 出力ディレクトリ。必須 */
  output_dir: string;

  /** 出力形式。デフォルト: 'png' */
  output_format?: 'png' | 'jpeg';

  /** ファイル名パターン。デフォルト: 'frame-{0000}.png' */
  filename_pattern?: string;

  /** ページ高さを手動指定 (px)。省略時は自動取得 */
  page_height_px?: number;

  /** 実際にスクリーンショットを保存するか。デフォルト: true */
  save_screenshots?: boolean;

  /**
   * 最大フレーム数制限。デフォルト: 1000
   * 大きなページでのタイムアウト対策。この数を超えるフレームはスキップされる。
   */
  max_frames?: number;

  /**
   * 最大ページ高さ制限 (px)。デフォルト: 50000
   * 無限スクロールサイト対策。この高さを超える部分はスキップされる。
   */
  max_page_height?: number;

  /**
   * タイムアウト (ms)。デフォルト: 90000 (90秒)
   * フレームキャプチャ全体のタイムアウト。超過時は取得済みフレームで結果を返す。
   */
  timeout_ms?: number;
}

/**
 * フレームファイル情報
 */
export interface FrameFileInfo {
  frame_number: number;
  scroll_position_px: number;
  timestamp_ms: number;
  file_path: string;
}

/**
 * キャプチャ設定
 */
export interface FrameCaptureConfig {
  scroll_px_per_frame: number;
  frame_interval_ms: number;
  output_format: 'png' | 'jpeg';
  output_dir: string;
  filename_pattern: string;
}

/**
 * フレームキャプチャ結果
 */
export interface FrameCaptureServiceResult {
  total_frames: number;
  output_dir: string;
  config: FrameCaptureConfig;
  files: FrameFileInfo[];
  duration_ms: number;

  /**
   * キャプチャが制限により早期終了したか
   * - max_frames に達した場合
   * - max_page_height を超えた場合
   * - タイムアウトした場合
   */
  truncated?: boolean;

  /** 制限理由 */
  truncation_reason?: 'max_frames' | 'max_page_height' | 'timeout';

  /** 元のページ高さ（制限適用前） */
  original_page_height?: number;
}

// ============================================================================
// 定数
// ============================================================================

/** デフォルト: スクロール量/フレーム (px) */
const DEFAULT_SCROLL_PX_PER_FRAME = 15;

/** デフォルト: フレーム間隔 (ms) */
const DEFAULT_FRAME_INTERVAL_MS = 33;

/** デフォルト: 出力形式 */
const DEFAULT_OUTPUT_FORMAT: 'png' | 'jpeg' = 'png';

/** デフォルト: ファイル名パターン */
const DEFAULT_FILENAME_PATTERN = 'frame-{0000}.png';

/** デフォルト: 最大フレーム数 - 大きなページでのタイムアウト対策 */
const DEFAULT_MAX_FRAMES = 1000;

/** デフォルト: 最大ページ高さ (px) - 無限スクロールサイト対策 */
const DEFAULT_MAX_PAGE_HEIGHT = 50000;

/** デフォルト: タイムアウト (ms) - フレームキャプチャ全体 */
const DEFAULT_TIMEOUT_MS = 90000;

/** 許可されたベースディレクトリ */
const ALLOWED_BASE_DIRS = [
  process.cwd(),
  '/tmp',
  os.tmpdir(),
];

/** セキュリティ: Path Traversal パターン */
const PATH_TRAVERSAL_PATTERN = /\.\./;

// ============================================================================
// FrameCaptureService クラス
// ============================================================================

/**
 * FrameCaptureService
 *
 * Playwrightを使用してWebページのスクロールフレームをキャプチャ
 */
export class FrameCaptureService {
  private readonly isDevelopment: boolean;

  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Initialized');
    }
  }

  /**
   * フレームキャプチャを実行
   *
   * v0.1.0改善: 制限とタイムアウトを追加
   * - max_frames: 最大フレーム数制限（デフォルト1000）
   * - max_page_height: 最大ページ高さ制限（デフォルト50000px）
   * - timeout_ms: タイムアウト（デフォルト90秒）
   *
   * @param page - Playwright Page インスタンス
   * @param options - キャプチャオプション
   * @returns キャプチャ結果
   */
  async capture(
    page: Page,
    options: FrameCaptureServiceOptions
  ): Promise<FrameCaptureServiceResult> {
    const startTime = Date.now();

    // オプションのデフォルト適用
    const scrollPxPerFrame = options.scroll_px_per_frame ?? DEFAULT_SCROLL_PX_PER_FRAME;
    const frameIntervalMs = options.frame_interval_ms ?? DEFAULT_FRAME_INTERVAL_MS;
    const outputFormat = options.output_format ?? DEFAULT_OUTPUT_FORMAT;
    const outputDir = this.validateAndNormalizeOutputDir(options.output_dir);
    const filenamePattern = options.filename_pattern ?? DEFAULT_FILENAME_PATTERN;
    const saveScreenshots = options.save_screenshots ?? true;

    // v0.1.0: 新しい制限オプション
    const maxFrames = options.max_frames ?? DEFAULT_MAX_FRAMES;
    const maxPageHeight = options.max_page_height ?? DEFAULT_MAX_PAGE_HEIGHT;
    const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Starting capture:', {
        scrollPxPerFrame,
        frameIntervalMs,
        outputFormat,
        outputDir,
        filenamePattern,
        maxFrames,
        maxPageHeight,
        timeoutMs,
      });
    }

    // 出力ディレクトリを作成（存在しない場合）
    await this.ensureDirectoryExists(outputDir);

    // 古いフレームをクリア（前回のキャプチャと混在を防ぐ）
    await this.clearFrameDirectory(outputDir);

    // ページ寸法を取得
    const originalPageHeight = options.page_height_px ?? await this.getPageHeight(page);
    const viewportHeight = await this.getViewportHeight(page);

    // v0.1.0: ページ高さ制限を適用
    let pageHeight = originalPageHeight;
    let truncated = false;
    let truncationReason: 'max_frames' | 'max_page_height' | 'timeout' | undefined;

    if (pageHeight > maxPageHeight) {
      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] Page height exceeds limit, truncating:', {
          originalPageHeight,
          maxPageHeight,
        });
      }
      pageHeight = maxPageHeight;
      truncated = true;
      truncationReason = 'max_page_height';
    }

    const maxScroll = Math.max(0, pageHeight - viewportHeight);

    // total_frames 計算
    let totalFrames = maxScroll > 0
      ? Math.ceil(maxScroll / scrollPxPerFrame) + 1
      : 1;

    // v0.1.0: フレーム数制限を適用
    if (totalFrames > maxFrames) {
      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] Frame count exceeds limit, truncating:', {
          originalFrameCount: totalFrames,
          maxFrames,
        });
      }
      totalFrames = maxFrames;
      truncated = true;
      truncationReason = 'max_frames';
    }

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Page dimensions:', {
        originalPageHeight,
        pageHeight,
        viewportHeight,
        maxScroll,
        totalFrames,
        truncated,
        truncationReason,
      });
    }

    const files: FrameFileInfo[] = [];
    const config: FrameCaptureConfig = {
      scroll_px_per_frame: scrollPxPerFrame,
      frame_interval_ms: frameIntervalMs,
      output_format: outputFormat,
      output_dir: outputDir,
      filename_pattern: filenamePattern,
    };

    // フレームをキャプチャ
    for (let i = 0; i < totalFrames; i++) {
      // v0.1.0: タイムアウトチェック
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        if (this.isDevelopment) {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log('[FrameCaptureService] Timeout reached, stopping capture:', {
            capturedFrames: i,
            totalFrames,
            elapsedMs: elapsed,
            timeoutMs,
          });
        }
        truncated = true;
        truncationReason = 'timeout';
        break;
      }

      const scrollY = Math.min(i * scrollPxPerFrame, maxScroll);

      // スクロール（ブラウザコンテキストで実行）
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);

      // アニメーション安定待機
      await page.waitForTimeout(frameIntervalMs);

      // ファイルパス生成
      const filePath = this.generateFilePath(
        outputDir,
        filenamePattern,
        i,
        outputFormat
      );

      // スクリーンショット
      if (saveScreenshots) {
        const screenshotOptions: PageScreenshotOptions = {
          path: filePath,
          type: outputFormat,
        };

        await page.screenshot(screenshotOptions);
      }

      // フレーム情報を記録
      files.push({
        frame_number: i,
        scroll_position_px: scrollY,
        timestamp_ms: i * frameIntervalMs,
        file_path: filePath,
      });

      // 進捗ログ
      if (this.isDevelopment && i > 0 && i % 100 === 0) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log(`[FrameCaptureService] Captured frame ${i}/${totalFrames}`);
      }
    }

    const durationMs = Date.now() - startTime;

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Capture complete:', {
        capturedFrames: files.length,
        totalFrames,
        durationMs: `${durationMs}ms`,
        truncated,
        truncationReason,
      });
    }

    // 結果を構築
    const result: FrameCaptureServiceResult = {
      total_frames: files.length,
      output_dir: outputDir,
      config,
      files,
      duration_ms: durationMs,
    };

    // 制限情報を追加（truncatedの場合のみ）
    // exactOptionalPropertyTypes対応: truncationReasonがundefinedでない場合のみ設定
    if (truncated && truncationReason !== undefined) {
      result.truncated = true;
      result.truncation_reason = truncationReason;
      result.original_page_height = originalPageHeight;
    }

    return result;
  }

  // ============================================================================
  // プライベートメソッド
  // ============================================================================

  /**
   * ページの総高さを取得
   *
   * 動的コンテンツ（SPA、lazy load）に対応するため、
   * 複数の方法で高さを取得し、最大値を使用
   *
   * @param page - Playwright Page インスタンス
   * @returns ページの総高さ (px)
   */
  private async getPageHeight(page: Page): Promise<number> {
    // Step 1: 初期の全高さ情報を取得（複数ソース）
    const initialMetrics = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body?.scrollHeight ?? 0,
      offsetHeight: document.documentElement.offsetHeight,
      bodyOffsetHeight: document.body?.offsetHeight ?? 0,
      innerHeight: window.innerHeight,
    }));

    // 複数ソースから最大値を取得
    let currentHeight = Math.max(
      initialMetrics.scrollHeight,
      initialMetrics.bodyScrollHeight,
      initialMetrics.offsetHeight,
      initialMetrics.bodyOffsetHeight
    );

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Initial page metrics:', {
        ...initialMetrics,
        maxHeight: currentHeight,
      });
    }

    // Step 2: ページ高さが viewport と同じ場合、JSレンダリング待機
    const viewportHeight = initialMetrics.innerHeight;
    if (currentHeight <= viewportHeight) {
      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] Page height equals viewport, waiting for JS render...');
      }

      // JavaScript レンダリング完了を待つ
      await page.waitForTimeout(2000);

      // 再度高さを取得
      const afterWaitMetrics = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollHeight: document.body?.scrollHeight ?? 0,
      }));

      currentHeight = Math.max(
        afterWaitMetrics.scrollHeight,
        afterWaitMetrics.bodyScrollHeight,
        currentHeight
      );

      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] After JS wait:', {
          ...afterWaitMetrics,
          maxHeight: currentHeight,
        });
      }
    }

    // Step 3: 最下部までスクロールして遅延コンテンツを読み込む
    const maxAttempts = 10; // 無限ループ防止
    let attempts = 0;

    while (attempts < maxAttempts) {

      // 最下部へスクロール
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

      // 遅延読み込みを待つ（画像やセクションのロード）
      await page.waitForTimeout(500);

      // 新しい高さを取得（複数ソース）
      const newMetrics = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollHeight: document.body?.scrollHeight ?? 0,
      }));

      const newHeight = Math.max(newMetrics.scrollHeight, newMetrics.bodyScrollHeight);
      attempts++;

      if (newHeight > currentHeight) {
        if (this.isDevelopment) {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log('[FrameCaptureService] Page height increased:', {
            from: currentHeight,
            to: newHeight,
            attempt: attempts,
          });
        }
        currentHeight = newHeight;
      } else {
        // 高さが変わらなくなったら終了
        if (this.isDevelopment) {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log('[FrameCaptureService] Page height stabilized at attempt:', attempts);
        }
        break;
      }
    }

    // Step 4: ページ先頭に戻す（フレームキャプチャ開始位置）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200); // スクロール完了を待つ

    if (this.isDevelopment) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameCaptureService] Final page height:', {
        finalHeight: currentHeight,
        viewportHeight,
        scrollableHeight: currentHeight - viewportHeight,
        estimatedFrames: Math.ceil((currentHeight - viewportHeight) / 15) + 1,
      });
    }

    return currentHeight;
  }

  /**
   * ビューポートの高さを取得
   */
  private async getViewportHeight(page: Page): Promise<number> {
    return page.evaluate(() => window.innerHeight);
  }

  /**
   * ディレクトリが存在しない場合は作成する
   *
   * @param dir - 作成するディレクトリパス
   * @throws Error ディレクトリ作成に失敗した場合
   */
  private async ensureDirectoryExists(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] Ensured directory exists:', dir);
      }
    } catch (err) {
      const error = err as { code?: string; message?: string };
      // EEXIST以外のエラーは再スロー（既存ディレクトリはOK）
      if (error.code !== 'EEXIST') {
        throw new Error(`Failed to create output directory: ${dir} - ${error.message ?? 'Unknown error'}`);
      }
    }
  }

  /**
   * ディレクトリ内の古いフレーム画像をクリアする
   *
   * 新しいキャプチャ開始前に前回のフレームを削除して
   * 異なるサイトのフレームが混在することを防ぐ
   *
   * @param dir - クリアするディレクトリパス
   */
  private async clearFrameDirectory(dir: string): Promise<void> {
    try {
      const files = await fs.readdir(dir);
      const frameFiles = files.filter((f) => f.startsWith('frame-') && f.endsWith('.png'));

      if (frameFiles.length > 0) {
        if (this.isDevelopment) {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log(`[FrameCaptureService] Clearing ${frameFiles.length} old frame files from ${dir}`);
        }

        await Promise.all(
          frameFiles.map((file) => fs.unlink(`${dir}/${file}`).catch(() => {
            // ファイル削除エラーは無視（既に削除されている可能性）
          }))
        );
      }
    } catch {
      // ディレクトリ読み取りエラーは無視（空のディレクトリなど）
      if (this.isDevelopment) {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameCaptureService] Could not clear directory (may be empty):', dir);
      }
    }
  }

  /**
   * 出力ディレクトリを検証・正規化
   *
   * セキュリティ対策:
   * - Path Traversal 検出 (..)
   * - 許可ディレクトリリストとの照合
   * - 絶対パスへの正規化
   *
   * @throws Error Path Traversal検出時またはディレクトリが許可リスト外の場合
   */
  private validateAndNormalizeOutputDir(dir: string): string {
    // P1: Path Traversal 検出
    if (PATH_TRAVERSAL_PATTERN.test(dir)) {
      throw new Error('Security: Path traversal detected in output_dir');
    }

    // 絶対パスに解決
    const resolved = path.resolve(dir);

    // 許可ディレクトリリストとの照合
    const isAllowed = ALLOWED_BASE_DIRS.some((allowedDir) => {
      const resolvedAllowed = path.resolve(allowedDir);
      return resolved.startsWith(resolvedAllowed);
    });

    if (!isAllowed) {
      throw new Error(
        `Security: output_dir is outside allowed directories. ` +
        `Allowed: ${ALLOWED_BASE_DIRS.join(', ')}`
      );
    }

    // 末尾スラッシュを保証
    return resolved.endsWith('/') ? resolved : `${resolved}/`;
  }

  /**
   * ファイルパスを生成
   *
   * セキュリティ対策:
   * - path.basename() でディレクトリ成分を除去
   * - path.join() で安全なパス結合
   */
  private generateFilePath(
    outputDir: string,
    pattern: string,
    frameNumber: number,
    format: 'png' | 'jpeg'
  ): string {
    // パターン置換: {0000} -> 0001, {000} -> 001
    let filename = pattern.replace(/\{(\d+)\}/g, (_, digits) => {
      const padLength = digits.length;
      return String(frameNumber).padStart(padLength, '0');
    });

    // 拡張子の置換
    filename = filename.replace(/\.(png|jpeg)$/, `.${format}`);

    // P2: ディレクトリ成分を除去して安全なファイル名のみを抽出
    const safeFilename = path.basename(filename);

    // 安全なパス結合
    return path.join(outputDir, safeFilename);
  }
}

// ============================================================================
// ファクトリ関数
// ============================================================================

/**
 * FrameCaptureServiceインスタンスを作成
 */
export function createFrameCaptureService(): FrameCaptureService {
  return new FrameCaptureService();
}

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default FrameCaptureService;
