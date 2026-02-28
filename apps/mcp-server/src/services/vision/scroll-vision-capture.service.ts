// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScrollVisionCaptureService - スクロール位置ベースのビューポートキャプチャ
 *
 * Playwrightを使用してページを実際にスクロールし、各セクション境界での
 * ビューポートスクリーンショットをキャプチャする。
 *
 * 機能:
 * - セクション境界に基づくスクロール位置の算出
 * - 重複位置のマージ（50px以内）
 * - maxCaptures制限によるサンプリング
 * - スクロール後のアニメーション待機
 * - SSRF対策（validateExternalUrl）
 * - Graceful degradation（ブラウザエラー対応）
 *
 * @module services/vision/scroll-vision-capture.service
 */

/* eslint-disable no-undef -- page.evaluate() runs in browser context where window/document exist */
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { validateExternalUrl } from '../../utils/url-validator.js';
import { createLogger } from '../../utils/logger.js';

// =============================================================================
// 定数
// =============================================================================

const LOG_PREFIX = 'ScrollVisionCapture';

/**
 * デフォルト最大キャプチャ数
 */
const DEFAULT_MAX_CAPTURES = 10;

/**
 * スクロール後のアニメーション待機時間（ミリ秒）
 */
const DEFAULT_WAIT_AFTER_SCROLL_MS = 800;

/**
 * デフォルトビューポートサイズ
 */
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * デフォルトタイムアウト（ミリ秒）
 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * スクロール位置マージ閾値（ピクセル）
 * この距離以内のスクロール位置は1つにマージされる
 */
const MERGE_THRESHOLD_PX = 50;

/**
 * ナビゲーション完了後の追加待機時間（ミリ秒）
 */
const POST_NAVIGATION_WAIT_MS = 1000;

// =============================================================================
// 型定義
// =============================================================================

/**
 * セクション境界情報
 */
export interface SectionBoundary {
  /** セクションインデックス（0始まり） */
  sectionIndex: number;
  /** セクション開始Y座標（ピクセル） */
  startY: number;
  /** セクション終了Y座標（ピクセル） */
  endY: number;
  /** セクションタイプ（オプション） */
  sectionType?: string | undefined;
}

/**
 * 個別キャプチャ結果
 */
export interface ScrollCapture {
  /** スクロールY座標 */
  scrollY: number;
  /** 対応するセクションインデックス */
  sectionIndex: number;
  /** スクリーンショットデータ（PNG Buffer） */
  screenshot: Buffer;
  /** ビューポート高さ */
  viewportHeight: number;
  /** キャプチャ時刻（Unix ms） */
  timestamp: number;
}

/**
 * キャプチャオプション
 */
export interface ScrollCaptureOptions {
  /** 最大キャプチャ数（デフォルト: 10） */
  maxCaptures?: number | undefined;
  /** スクロール後の待機時間（デフォルト: 800ms） */
  waitAfterScrollMs?: number | undefined;
  /** ビューポートサイズ（デフォルト: 1440x900） */
  viewport?: { width: number; height: number } | undefined;
  /** 全体タイムアウト（デフォルト: 60000ms） */
  timeout?: number | undefined;
  /** 共有ブラウザインスタンス（Worker pipeline用、指定時はchromium.launch()をスキップ） */
  sharedBrowser?: Browser | undefined;
}

/**
 * キャプチャ結果
 */
export interface ScrollCaptureResult {
  /** キャプチャ一覧 */
  captures: ScrollCapture[];
  /** ページ全体のスクロール高さ */
  totalScrollHeight: number;
  /** キャプチャ処理時間（ミリ秒） */
  captureTimeMs: number;
  /** 対象URL */
  url: string;
}

/**
 * 内部用: マージ済みスクロール位置
 */
interface MergedScrollPosition {
  scrollY: number;
  sectionIndex: number;
}

// =============================================================================
// Logger
// =============================================================================

const logger = createLogger(LOG_PREFIX);

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * セクション境界からスクロール位置を算出し、重複をマージ
 *
 * @param boundaries - セクション境界配列
 * @param totalScrollHeight - ページ全体のスクロール高さ
 * @param viewportHeight - ビューポートの高さ
 * @returns マージ済みスクロール位置配列（ソート済み）
 */
export function computeScrollPositions(
  boundaries: SectionBoundary[],
  totalScrollHeight: number,
  viewportHeight: number
): MergedScrollPosition[] {
  const maxScrollY = Math.max(0, totalScrollHeight - viewportHeight);

  // ページトップを追加
  const positions: MergedScrollPosition[] = [
    { scrollY: 0, sectionIndex: -1 },
  ];

  // 各セクション境界のstartYを追加
  for (const boundary of boundaries) {
    const clampedY = Math.min(Math.max(0, boundary.startY), maxScrollY);
    positions.push({
      scrollY: clampedY,
      sectionIndex: boundary.sectionIndex,
    });
  }

  // ページ最下部を追加（既に含まれていない場合）
  if (maxScrollY > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    positions.push({
      scrollY: maxScrollY,
      sectionIndex: lastBoundary !== undefined
        ? lastBoundary.sectionIndex + 1
        : 0,
    });
  }

  // scrollYでソート
  positions.sort((a, b) => a.scrollY - b.scrollY);

  // MERGE_THRESHOLD_PX以内のスクロール位置をマージ
  const merged: MergedScrollPosition[] = [];
  for (const pos of positions) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Math.abs(pos.scrollY - last.scrollY) <= MERGE_THRESHOLD_PX) {
      // 近い位置はスキップ（先に追加された方を残す）
      continue;
    }
    merged.push(pos);
  }

  return merged;
}

/**
 * 位置配列をmaxCaptures以下に均等サンプリング
 *
 * @param positions - マージ済みスクロール位置
 * @param maxCaptures - 最大キャプチャ数
 * @returns サンプリング済みスクロール位置配列
 */
export function samplePositions(
  positions: MergedScrollPosition[],
  maxCaptures: number
): MergedScrollPosition[] {
  if (positions.length <= maxCaptures) {
    return positions;
  }

  // maxCaptures=1の場合は先頭のみ
  if (maxCaptures <= 1) {
    const first = positions[0];
    return first !== undefined ? [first] : [];
  }

  // 均等にサンプリング（先頭と末尾は必ず含める）
  const sampled: MergedScrollPosition[] = [];
  const step = (positions.length - 1) / (maxCaptures - 1);

  for (let i = 0; i < maxCaptures; i++) {
    const index = Math.round(i * step);
    const pos = positions[index];
    if (pos !== undefined) {
      sampled.push(pos);
    }
  }

  return sampled;
}

// =============================================================================
// メイン関数
// =============================================================================

/**
 * スクロール位置ベースのビューポートキャプチャを実行
 *
 * 1. SSRF検証
 * 2. セクション境界からスクロール位置を算出
 * 3. ブラウザでページを開き、各位置でスクリーンショットを取得
 * 4. リソースをクリーンアップして結果を返す
 *
 * @param url - キャプチャ対象URL
 * @param boundaries - セクション境界配列
 * @param options - キャプチャオプション
 * @returns キャプチャ結果
 * @throws Error - SSRF検証失敗、ナビゲーション失敗等
 */
export async function captureScrollPositions(
  url: string,
  boundaries: SectionBoundary[],
  options?: ScrollCaptureOptions
): Promise<ScrollCaptureResult> {
  const startTime = Date.now();
  const maxCaptures = options?.maxCaptures ?? DEFAULT_MAX_CAPTURES;
  const waitAfterScrollMs = options?.waitAfterScrollMs ?? DEFAULT_WAIT_AFTER_SCROLL_MS;
  const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  logger.info('Starting scroll capture', { url, boundaryCount: boundaries.length, maxCaptures });

  // SSRF検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    throw new Error(`SSRF blocked: ${urlValidation.error ?? 'URL is blocked for security reasons'}`);
  }

  const usingSharedBrowser = !!options?.sharedBrowser;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // 共有ブラウザが提供されている場合はそれを使用、なければ新規起動
    if (usingSharedBrowser) {
      browser = options!.sharedBrowser!;
      logger.info('Using shared browser instance', { url });
    } else {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
    }

    // 新しいコンテキスト作成
    context = await browser.newContext({
      viewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.1.0',
      javaScriptEnabled: true,
      bypassCSP: false,
    });

    page = await context.newPage();

    // ナビゲーション
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    if (response) {
      const status = response.status();
      if (status >= 400) {
        throw new Error(`HTTP error ${status} for ${url}`);
      }
    }

    // ページ読み込み後の追加待機（lazy-loadやJSアニメーション初期化のため）
    await page.waitForTimeout(POST_NAVIGATION_WAIT_MS);

    // ページの全体スクロール高さを取得
    const totalScrollHeight = await page.evaluate((): number => {
      return document.documentElement.scrollHeight;
    });

    // スクロール位置を算出
    let scrollPositions = computeScrollPositions(
      boundaries,
      totalScrollHeight,
      viewport.height
    );

    // maxCaptures制限
    scrollPositions = samplePositions(scrollPositions, maxCaptures);

    logger.info('Scroll positions computed', {
      totalScrollHeight,
      positionCount: scrollPositions.length,
    });

    // 各スクロール位置でキャプチャ
    const captures: ScrollCapture[] = [];

    for (const pos of scrollPositions) {
      // スクロール実行
      await page.evaluate((y: number): void => {
        window.scrollTo({ top: y, behavior: 'instant' });
      }, pos.scrollY);

      // スクロール後のアニメーション待機
      await page.waitForTimeout(waitAfterScrollMs);

      // ビューポートスクリーンショット取得
      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false,
      });

      captures.push({
        scrollY: pos.scrollY,
        sectionIndex: pos.sectionIndex,
        screenshot,
        viewportHeight: viewport.height,
        timestamp: Date.now(),
      });

      logger.debug('Captured scroll position', {
        scrollY: pos.scrollY,
        sectionIndex: pos.sectionIndex,
        screenshotSize: screenshot.length,
      });
    }

    const captureTimeMs = Date.now() - startTime;

    logger.info('Scroll capture completed', {
      url,
      captureCount: captures.length,
      captureTimeMs,
      totalScrollHeight,
    });

    return {
      captures,
      totalScrollHeight,
      captureTimeMs,
      url,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Scroll capture failed', { url, error: errorMessage });
    throw error;
  } finally {
    // リソースクリーンアップ
    if (page) {
      await page.close().catch(() => { /* ignore */ });
    }
    if (context) {
      await context.close().catch(() => { /* ignore */ });
    }
    // 共有ブラウザの場合はブラウザを閉じない（呼び出し元が管理）
    if (browser && !usingSharedBrowser) {
      await browser.close().catch(() => { /* ignore */ });
    }
  }
}
