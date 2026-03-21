// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section Screenshot Fallback Service
 *
 * screenshotBase64の高さ制約（WebGL: fullPage=false、Lazy Rendering: DOM下部未レンダリング）
 * により、screenshotBase64からcropできないセクションに対し、Playwrightで個別スクリーンショットを取得する。
 *
 * Provides individual section screenshots via Playwright when sections fall outside
 * the screenshotBase64 height range (WebGL: fullPage=false, lazy rendering: bottom DOM not rendered).
 *
 * パターン: part-bbox-playwright.service.ts の sharedBrowser パターンに準拠。
 * Pattern: Follows sharedBrowser pattern from part-bbox-playwright.service.ts.
 *
 * robots.txt: このサービスは page-analyze-worker (Phase 5) 内からのみ呼ばれることを前提とする。
 * robots.txt の検証は Phase 0 (PageIngestAdapter.ingest) で実施済みであり、
 * ここでは重複検証しない。同一URLへの再訪問のため、別途のrobots.txt確認は不要。
 *
 * robots.txt: This service is designed to be called only from page-analyze-worker (Phase 5).
 * robots.txt validation is already performed in Phase 0 (PageIngestAdapter.ingest),
 * so it is not duplicated here. Since this is a re-visit to the same URL, no additional
 * robots.txt check is required.
 *
 * @module services/part/section-screenshot-fallback.service
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import sharp from "sharp";
import { validateExternalUrl } from "../../utils/url-validator";
import { logger, isDevelopment } from "../../utils/logger";

// ============================================================================
// Constants / 定数
// ============================================================================

const LOG_PREFIX = "[SectionScreenshotFallback]";

/**
 * デフォルトビューポートサイズ（ingest viewport と統一: 1920x1080）
 * Default viewport size (unified with ingest viewport: 1920x1080)
 */
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;

/**
 * ナビゲーションタイムアウト（ミリ秒） / Navigation timeout (milliseconds)
 */
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * scrollTo後の待機時間（ミリ秒）/ Wait time after scrollTo (milliseconds)
 */
const POST_SCROLL_WAIT_MS = 1_000;

/**
 * networkidle追加待機の最大時間（ミリ秒） / Max wait for networkidle after scroll (milliseconds)
 */
const NETWORK_IDLE_WAIT_MS = 3_000;

/**
 * デフォルト最大セクション数 / Default max sections per call
 */
const DEFAULT_MAX_SECTIONS = 50;

/**
 * デフォルト累積タイムアウト（ミリ秒） / Default cumulative timeout (milliseconds)
 */
const DEFAULT_CUMULATIVE_TIMEOUT_MS = 300_000;

/**
 * セクション高さ下限（ピクセル） / Minimum section height (pixels)
 * 10px未満のセクションはvisual featureを持たないためスキップ
 * Sections under 10px are skipped as they lack meaningful visual features
 */
const MIN_SECTION_HEIGHT_PX = 10;

/**
 * 1セクションあたりのデフォルト最大タイル数（マルチタイルキャプチャ安全装置）
 * Default maximum tiles per section (multi-tile capture safety limit)
 * section.height > viewportHeight の場合、複数タイルに分割してキャプチャし垂直結合する
 * When section.height > viewportHeight, capture in multiple tiles and stitch vertically
 *
 * v0.1.10: 固定5 → 動的計算（デフォルト上限20）に変更。
 * 既存の cumulative timeout (300s) と per-tile checkMemoryPressure が実質的な上限として機能する。
 * 環境変数 MAX_TILES_PER_SECTION で上限をオーバーライド可能。
 *
 * v0.1.10: Changed from fixed 5 to dynamic calculation (default cap 20).
 * Existing cumulative timeout (300s) and per-tile checkMemoryPressure serve as effective caps.
 * Override via MAX_TILES_PER_SECTION env var.
 */
const DEFAULT_MAX_TILES_PER_SECTION = 20;

/**
 * 環境変数から MAX_TILES_PER_SECTION を取得する（NaN/負数/0 防御付き）
 * Read MAX_TILES_PER_SECTION from env var (with NaN/negative/0 defense)
 */
/**
 * 環境変数 MAX_TILES_PER_SECTION の絶対上限（防御的プログラミング: SEC-TILES-01）
 * Absolute upper bound for MAX_TILES_PER_SECTION env var (defensive: SEC-TILES-01)
 */
const ABSOLUTE_MAX_TILES_LIMIT = 100;

function getMaxTilesPerSection(): number {
  const envVal = process.env.MAX_TILES_PER_SECTION;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // SEC-TILES-01: 硬い上限キャップ（誤設定・悪意ある操作の最終防衛線）
      // SEC-TILES-01: Hard upper cap (last line of defense against misconfiguration)
      return Math.min(parsed, ABSOLUTE_MAX_TILES_LIMIT);
    }
    logger.warn(`${LOG_PREFIX} Invalid MAX_TILES_PER_SECTION env var, using default`, {
      envValue: envVal,
      default: DEFAULT_MAX_TILES_PER_SECTION,
    });
  }
  return DEFAULT_MAX_TILES_PER_SECTION;
}

// ============================================================================
// Type Definitions / 型定義
// ============================================================================

/**
 * 個別セクションスクリーンショットの結果
 * Result for an individual section screenshot
 */
export interface SectionScreenshotResult {
  /** セクション識別子 / Section identifier */
  sectionId: string;
  /** スクリーンショットバッファ（失敗時null） / Screenshot buffer (null on failure) */
  screenshotBuffer: Buffer | null;
  /** キャプチャされた幅 / Captured width */
  width: number;
  /** キャプチャされた高さ / Captured height */
  height: number;
  /** スキップされたか / Whether skipped */
  skipped: boolean;
  /** スキップ理由（スキップ時のみ） / Skip reason (only when skipped) */
  skipReason?: string | undefined;
}

/**
 * captureSectionScreenshots のオプション
 * Options for captureSectionScreenshots
 */
export interface SectionScreenshotOptions {
  /** ソースURL / Source URL */
  url: string;
  /** キャプチャ対象セクション一覧 / Sections to capture */
  sections: ReadonlyArray<{
    id: string;
    startY: number;
    height: number;
  }>;
  /** ビューポート幅（デフォルト1920） / Viewport width (default 1920) */
  viewportWidth?: number | undefined;
  /** ビューポート高さ（デフォルト1080） / Viewport height (default 1080) */
  viewportHeight?: number | undefined;
  /** 最大セクション数（デフォルト50） / Max sections (default 50) */
  maxSections?: number | undefined;
  /** 累積タイムアウト（ミリ秒、デフォルト300000） / Cumulative timeout in ms (default 300000) */
  timeoutMs?: number | undefined;
  /** 共有ブラウザインスタンス（省略時は独自起動） / Shared browser instance (launches own if omitted) */
  sharedBrowser?: Browser | undefined;
  /** メモリ圧力チェック関数（省略時はスキップ） / Memory pressure check function (skip if omitted) */
  checkMemoryPressure?:
    | (() => { shouldDegrade: boolean; shouldAbort: boolean; rssMb: number })
    | undefined;
}

/**
 * captureSectionScreenshots の集約結果
 * Aggregate result of captureSectionScreenshots
 */
export interface SectionScreenshotAggregateResult {
  /** 各セクションの結果 / Per-section results */
  results: SectionScreenshotResult[];
  /** キャプチャ成功数 / Number of successful captures */
  capturedCount: number;
  /** スキップ数 / Number of skipped sections */
  skippedCount: number;
}

// ============================================================================
// Main Function / メイン関数
// ============================================================================

/**
 * Playwright で各セクションを個別にスクリーンショットキャプチャする
 * Capture individual section screenshots via Playwright
 *
 * 1. SSRF検証
 * 2. ブラウザ起動（sharedBrowser or 独自）
 * 3. ページナビゲーション
 * 4. セクションごとにscrollTo → clip screenshot
 * 5. リソースクリーンアップ
 *
 * Graceful Degradation: 全体失敗時は空結果を返す（ジョブを中断しない）
 *
 * @param options - キャプチャオプション / Capture options
 * @returns 集約結果 / Aggregate result
 */
export async function captureSectionScreenshots(
  options: SectionScreenshotOptions
): Promise<SectionScreenshotAggregateResult> {
  const {
    url,
    sections,
    viewportWidth = DEFAULT_VIEWPORT_WIDTH,
    viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
    maxSections = DEFAULT_MAX_SECTIONS,
    timeoutMs = DEFAULT_CUMULATIVE_TIMEOUT_MS,
    checkMemoryPressure,
  } = options;

  const emptyResult: SectionScreenshotAggregateResult = {
    results: [],
    capturedCount: 0,
    skippedCount: 0,
  };

  // 0. 入力バリデーション / Input validation
  if (sections.length === 0) {
    return emptyResult;
  }

  // マルチタイル上限をループ外で1回だけ取得（TDA L-1: 全セクション同一値）
  // Read max tiles once before loop (TDA L-1: same value for all sections)
  const maxTilesPerSection = getMaxTilesPerSection();

  // SEC-MULTI-01: viewportWidth/viewportHeight の数値有効性検証
  // SEC-MULTI-01: Validate viewport dimensions are finite positive numbers
  // SEC-MULTI-03: viewport上限 (4096px) で巨大ビューポートによるメモリ消費を防御
  // SEC-MULTI-03: Cap viewport at 4096px to prevent excessive memory from oversized viewports
  let safeViewportWidth = viewportWidth;
  let safeViewportHeight = viewportHeight;
  if (!Number.isFinite(safeViewportWidth) || safeViewportWidth <= 0) {
    logger.warn(`${LOG_PREFIX} Invalid viewportWidth, using default`, { viewportWidth });
    safeViewportWidth = DEFAULT_VIEWPORT_WIDTH;
  }
  if (!Number.isFinite(safeViewportHeight) || safeViewportHeight <= 0) {
    logger.warn(`${LOG_PREFIX} Invalid viewportHeight, using default`, { viewportHeight });
    safeViewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  }
  safeViewportWidth = Math.min(safeViewportWidth, 4096);
  safeViewportHeight = Math.min(safeViewportHeight, 4096);

  // SEC-MULTI-04: timeoutMs の NaN/Infinity 防御
  // SEC-MULTI-04: Defend against NaN/Infinity in timeoutMs
  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CUMULATIVE_TIMEOUT_MS;

  // 1. SSRF検証 / SSRF validation
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`${LOG_PREFIX} URL blocked by SSRF validation`, {
      error: urlValidation.error,
    });
    return emptyResult;
  }

  // 2. maxSectionsで制限 / Limit by maxSections
  const targetSections = sections.slice(0, maxSections);

  // 3. ブラウザ取得（接続済み共有 or 新規起動）
  //    Get browser (connected shared or launch new)
  const sharedBrowserConnected = options.sharedBrowser?.isConnected() === true;
  const usingSharedBrowser = sharedBrowserConnected;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const results: SectionScreenshotResult[] = [];
  let capturedCount = 0;
  let skippedCount = 0;
  const cumulativeStart = Date.now();

  try {
    if (usingSharedBrowser) {
      browser = options.sharedBrowser!;
    } else {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }

    const viewport = { width: safeViewportWidth, height: safeViewportHeight };

    context = await browser.newContext({
      viewport,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.1.0",
      javaScriptEnabled: true,
      bypassCSP: false,
    });

    page = await context.newPage();

    // 4. ナビゲーション / Navigate
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    if (response) {
      const status = response.status();
      if (status >= 400) {
        logger.warn(`${LOG_PREFIX} HTTP error during navigation`, { url, status });
        return emptyResult;
      }
    }

    // ページ読み込み後の初期待機 / Initial post-navigation wait
    await page.waitForTimeout(POST_SCROLL_WAIT_MS);

    // 5. セクションごとにscrollTo → screenshot(clip)
    //    For each section: scrollTo → screenshot with clip
    for (const section of targetSections) {
      // 累積タイムアウトチェック / Cumulative timeout check
      const elapsed = Date.now() - cumulativeStart;
      if (elapsed >= safeTimeoutMs) {
        logger.warn(`${LOG_PREFIX} Cumulative timeout reached, skipping remaining sections`, {
          elapsedMs: elapsed,
          timeoutMs: safeTimeoutMs,
          remaining: targetSections.length - results.length,
        });
        // 残セクションをスキップとして記録 / Record remaining as skipped
        const remaining = targetSections.slice(results.length);
        for (const s of remaining) {
          results.push({
            sectionId: s.id,
            screenshotBuffer: null,
            width: 0,
            height: 0,
            skipped: true,
            skipReason: "cumulative_timeout",
          });
          skippedCount++;
        }
        break;
      }

      // メモリ圧力チェック / Memory pressure check
      if (checkMemoryPressure) {
        const memCheck = checkMemoryPressure();
        if (memCheck.shouldAbort) {
          logger.warn(`${LOG_PREFIX} Critical memory pressure, aborting`, {
            rssMb: memCheck.rssMb,
          });
          const remaining = targetSections.slice(results.length);
          for (const s of remaining) {
            results.push({
              sectionId: s.id,
              screenshotBuffer: null,
              width: 0,
              height: 0,
              skipped: true,
              skipReason: "memory_critical",
            });
            skippedCount++;
          }
          break;
        }
        if (memCheck.shouldDegrade) {
          results.push({
            sectionId: section.id,
            screenshotBuffer: null,
            width: 0,
            height: 0,
            skipped: true,
            skipReason: "memory_pressure",
          });
          skippedCount++;
          continue;
        }
      }

      // 座標の数値有効性検証 / Coordinate numeric validity check
      if (!Number.isFinite(section.startY) || !Number.isFinite(section.height)) {
        results.push({
          sectionId: section.id,
          screenshotBuffer: null,
          width: 0,
          height: 0,
          skipped: true,
          skipReason: "invalid_coordinates",
        });
        skippedCount++;
        continue;
      }

      // 高さ検証 / Height validation
      if (section.height < MIN_SECTION_HEIGHT_PX) {
        results.push({
          sectionId: section.id,
          screenshotBuffer: null,
          width: 0,
          height: 0,
          skipped: true,
          skipReason: "height_too_small",
        });
        skippedCount++;
        continue;
      }

      try {
        const sectionHeight = Math.round(section.height);

        // マルチタイルキャプチャ判定: section.height > viewportHeight の場合は複数タイルに分割
        // Multi-tile capture: split into multiple tiles when section.height > viewportHeight
        const needsMultiTile = sectionHeight > safeViewportHeight;
        const tileCount = needsMultiTile
          ? Math.min(Math.ceil(sectionHeight / safeViewportHeight), maxTilesPerSection)
          : 1;

        const tileBuffers: Buffer[] = [];
        let totalCapturedHeight = 0;
        let tileAborted = false;

        for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
          // タイルごとのメモリ圧力チェック（マルチタイル時のみ）
          // Per-tile memory pressure check (multi-tile only)
          if (needsMultiTile && tileIndex > 0 && checkMemoryPressure) {
            const tileMem = checkMemoryPressure();
            if (tileMem.shouldAbort || tileMem.shouldDegrade) {
              logger.warn(
                `${LOG_PREFIX} Memory pressure during multi-tile capture, using partial result`,
                {
                  sectionId: section.id.slice(0, 8) + "...",
                  tileIndex,
                  tileCount,
                  rssMb: tileMem.rssMb,
                }
              );
              tileAborted = true;
              break;
            }
          }

          // タイルのスクロール先を計算 / Calculate tile scroll target
          const tileOffsetY = tileIndex * safeViewportHeight;
          const scrollY = Math.max(0, Math.round(section.startY + tileOffsetY));

          await page.evaluate((y: number) => window.scrollTo(0, y), scrollY);

          // スクロール後の待機（レンダリング + lazy load） / Wait after scroll (rendering + lazy load)
          await page.waitForTimeout(POST_SCROLL_WAIT_MS);

          // requestAnimationFrame完了待ち（2フレーム分、2秒タイムアウト付き）
          // Wait for requestAnimationFrame completion (2 frames, with 2s timeout)
          // Lazy Rendering のレイアウト確定とペイント完了を保証する
          // Ensures layout commit and paint completion for Lazy Rendering
          try {
            await Promise.race([
              page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  })
              ),
              page.waitForTimeout(2000),
            ]);
          } catch {
            // rAF待ちの失敗は非致命的 / rAF wait failure is non-fatal
          }

          // networkidle 追加待機（最大3秒、失敗しても続行）
          // Additional networkidle wait (max 3s, continue on failure)
          try {
            await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_WAIT_MS });
          } catch {
            // networkidle タイムアウトは非致命的 / networkidle timeout is non-fatal
          }

          // scrollTo後の実測値を取得してclipYを計算（sticky header対策）
          // Get actual scroll position after scrollTo to calculate clipY (sticky header workaround)
          // v0.1.10: actualScrollY が期待値から大きくズレた場合は旧方式（期待値ベース）にフォールバック
          // v0.1.10: Fall back to expected scrollY when actualScrollY deviates significantly
          const actualScrollY = await page.evaluate(() => window.scrollY);
          const expectedClipY = Math.max(0, section.startY + tileOffsetY - scrollY);
          const actualClipY = Math.max(0, section.startY + tileOffsetY - actualScrollY);
          // 実測値が期待値から viewportHeight の半分以上ズレている場合は旧方式を使用
          // Use expected value when actual deviates by more than half the viewport height
          const clipY =
            Math.abs(actualScrollY - scrollY) > safeViewportHeight / 2
              ? expectedClipY
              : actualClipY;

          // タイルの残り高さを計算 / Calculate remaining height for this tile
          const remainingSectionHeight = sectionHeight - tileOffsetY;
          const clipHeight = Math.min(
            Math.round(remainingSectionHeight),
            safeViewportHeight - Math.round(clipY)
          );

          if (clipHeight <= 0) {
            break;
          }

          const tileBuffer = await page.screenshot({
            fullPage: false,
            type: "png",
            clip: {
              x: 0,
              y: Math.round(clipY),
              width: safeViewportWidth,
              height: Math.round(clipHeight),
            },
          });

          tileBuffers.push(Buffer.from(tileBuffer));
          totalCapturedHeight += clipHeight;
        }

        // タイル結合またはスキップ / Stitch tiles or skip
        if (tileBuffers.length === 0) {
          results.push({
            sectionId: section.id,
            screenshotBuffer: null,
            width: 0,
            height: 0,
            skipped: true,
            skipReason: "clip_height_zero",
          });
          skippedCount++;
          continue;
        }

        let finalBuffer: Buffer;
        if (tileBuffers.length === 1) {
          // 1タイル: 既存動作と同一 / Single tile: same as existing behavior
          finalBuffer = tileBuffers[0]!;
        } else {
          // マルチタイル: Sharp で垂直結合 / Multi-tile: stitch vertically with Sharp
          const tileMetadata = await Promise.all(tileBuffers.map((buf) => sharp(buf).metadata()));
          const stitchedHeight = tileMetadata.reduce((sum, meta) => sum + (meta.height ?? 0), 0);
          const compositeInputs = [];
          let yOffset = 0;
          for (let i = 0; i < tileBuffers.length; i++) {
            compositeInputs.push({
              input: tileBuffers[i]!,
              top: yOffset,
              left: 0,
            });
            yOffset += tileMetadata[i]?.height ?? 0;
          }

          finalBuffer = await sharp({
            create: {
              width: safeViewportWidth,
              height: stitchedHeight,
              channels: 4 as const,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
            },
          })
            .composite(compositeInputs)
            .png()
            .toBuffer();

          // タイルバッファ即時解放 / Immediately release tile buffers
          tileBuffers.length = 0;

          if (isDevelopment()) {
            logger.info(`${LOG_PREFIX} Multi-tile stitch completed`, {
              sectionId: section.id.slice(0, 8) + "...",
              tiles: compositeInputs.length,
              stitchedHeight,
              aborted: tileAborted,
            });
          }
        }

        results.push({
          sectionId: section.id,
          screenshotBuffer: finalBuffer,
          width: safeViewportWidth,
          height: totalCapturedHeight,
          skipped: false,
        });
        capturedCount++;
      } catch (sectionError) {
        // 個別セクション失敗: Graceful Degradation / Per-section failure: Graceful Degradation
        logger.warn(`${LOG_PREFIX} Failed to capture section screenshot (non-fatal)`, {
          sectionId: section.id.slice(0, 8) + "...",
          error: sectionError instanceof Error ? sectionError.message : String(sectionError),
        });
        results.push({
          sectionId: section.id,
          screenshotBuffer: null,
          width: 0,
          height: 0,
          skipped: true,
          skipReason: "capture_failed",
        });
        skippedCount++;
      }
    }

    if (isDevelopment()) {
      logger.info(`${LOG_PREFIX} Section screenshot capture completed`, {
        totalSections: targetSections.length,
        capturedCount,
        skippedCount,
        elapsedMs: Date.now() - cumulativeStart,
      });
    }

    return { results, capturedCount, skippedCount };
  } catch (error) {
    // 全体失敗: Graceful Degradation / Overall failure: Graceful Degradation
    logger.warn(`${LOG_PREFIX} Section screenshot capture failed (non-fatal)`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyResult;
  } finally {
    // リソースクリーンアップ / Resource cleanup
    if (page) {
      await page.close().catch(() => {
        /* ignore */
      });
    }
    if (context) {
      await context.close().catch(() => {
        /* ignore */
      });
    }
    // 共有ブラウザの場合はブラウザを閉じない（呼び出し元が管理）
    // Don't close shared browser (managed by caller)
    if (browser && !usingSharedBrowser) {
      await browser.close().catch(() => {
        /* ignore */
      });
    }
  }
}
