// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Service
 * レスポンシブ解析の統合サービス
 *
 * @module services/responsive/responsive-analysis.service
 */

import type { Browser } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';
import {
  multiViewportCaptureService,
  DEFAULT_VIEWPORTS,
} from './multi-viewport-capture.service';
import { differenceDetectorService } from './difference-detector.service';
import { viewportDiffService } from './viewport-diff.service';
import sharp from 'sharp';
import type {
  ResponsiveViewport,
  ResponsiveAnalysisResult,
  ResponsiveAnalysisOptions,
  MultiViewportCaptureOptions,
  ViewportDiffResult,
} from './types';

/**
 * 差分計算用スクリーンショットの高さ上限（px）
 * above-the-fold 領域のみを比較し、メモリ消費を抑制する
 */
const DIFF_MAX_HEIGHT = 2000;

/**
 * Responsive Analysis Service
 * レスポンシブ解析の統合サービス
 */
export class ResponsiveAnalysisService {
  /**
   * URLに対してレスポンシブ解析を実行
   *
   * @param url - 解析対象URL
   * @param options - 解析オプション
   * @param sharedBrowser - 共有ブラウザインスタンス（Worker pipeline用）
   * @returns レスポンシブ解析結果
   */
  async analyze(
    url: string,
    options: ResponsiveAnalysisOptions,
    sharedBrowser?: Browser
  ): Promise<ResponsiveAnalysisResult> {
    const startTime = Date.now();

    if (!options.enabled) {
      return {
        viewportsAnalyzed: [] as ResponsiveViewport[],
        differences: [],
        breakpoints: [],
        analysisTimeMs: 0,
      };
    }

    const viewports = options.viewports ?? DEFAULT_VIEWPORTS;

    if (isDevelopment()) {
      logger.info('[ResponsiveAnalysis] Starting responsive analysis', {
        url,
        viewports: viewports.map((v) => v.name),
        includeScreenshotsInResponse: options.include_screenshots,
        detectNavigation: options.detect_navigation,
        detectVisibility: options.detect_visibility,
        detectLayout: options.detect_layout,
      });
    }

    try {
      // Step 1: 複数ビューポートでキャプチャ
      // 常にスクリーンショットをキャプチャ（差分計算用）
      // include_screenshots オプションはレスポンスに base64 画像を含めるかどうかの制御のみ
      const captureOpts: MultiViewportCaptureOptions = {
        viewports,
        includeScreenshots: true,
        timeout: 30000,
        fullPage: true,
        waitUntil: 'load',
        waitForDomStable: true,
        domStableTimeout: 500,
      };
      if (options.crawlDelayMs !== undefined) {
        captureOpts.crawlDelayMs = options.crawlDelayMs;
      }

      const captureResults = await multiViewportCaptureService.captureAllViewports(
        url,
        captureOpts,
        sharedBrowser
      );

      // エラーがあった場合はログ出力
      const errors = captureResults.filter((r) => r.error);
      if (errors.length > 0 && isDevelopment()) {
        logger.warn('[ResponsiveAnalysis] Some viewports failed to capture', {
          errors: errors.map((e) => ({ viewport: e.viewport.name, error: e.error })),
        });
      }

      // 成功したキャプチャ結果のみ使用
      const successfulCaptures = captureResults.filter((r) => !r.error);

      if (successfulCaptures.length < 2) {
        if (isDevelopment()) {
          logger.warn('[ResponsiveAnalysis] Not enough successful captures for comparison', {
            successCount: successfulCaptures.length,
          });
        }
        return {
          viewportsAnalyzed: successfulCaptures.map((r) => r.viewport),
          differences: [],
          breakpoints: [],
          analysisTimeMs: Date.now() - startTime,
        };
      }

      // Step 1.5: 外部CSSからブレークポイント抽出（range/preciseモード）
      const breakpointResolution = options.breakpoint_resolution ?? 'range';
      let externalBreakpoints: string[] = [];

      if (breakpointResolution === 'range' || breakpointResolution === 'precise') {
        // 最初のキャプチャ結果のHTMLを使用してCSS URLを抽出
        const firstCapture = successfulCaptures[0];
        if (firstCapture?.html) {
          externalBreakpoints = await multiViewportCaptureService.extractBreakpointsFromExternalCss(
            firstCapture.html,
            url
          );

          // 各キャプチャのlayoutInfoに外部CSSのブレークポイントを追加
          for (const capture of successfulCaptures) {
            const existing = new Set(capture.layoutInfo.breakpoints);
            for (const bp of externalBreakpoints) {
              existing.add(bp);
            }
            capture.layoutInfo.breakpoints = Array.from(existing);
          }

          if (isDevelopment()) {
            logger.debug('[ResponsiveAnalysis] External breakpoints merged', {
              externalCount: externalBreakpoints.length,
            });
          }
        }
      }

      // Step 2: 差異検出
      const detectionResult = differenceDetectorService.detectDifferences(successfulCaptures);

      // Step 2.1: preciseモードのブレークポイント二分探索
      if (breakpointResolution === 'precise' && detectionResult.breakpoints.length > 0) {
        const candidateValues = detectionResult.breakpoints
          .map((bp) => parseInt(bp.replace('px', ''), 10))
          .filter((v) => !isNaN(v))
          .sort((a, b) => a - b);

        if (candidateValues.length > 0) {
          try {
            const browser = await this.getBrowserForPrecise(sharedBrowser);
            const preciseResults = await multiViewportCaptureService.detectPreciseBreakpoints(
              browser,
              url,
              candidateValues,
              15000
            );

            // 検証済みブレークポイントで上書き
            const verifiedBps = preciseResults
              .filter((r) => r.verified)
              .map((r) => `${r.value}px`);

            if (verifiedBps.length > 0) {
              const allBps = new Set([...detectionResult.breakpoints, ...verifiedBps]);
              detectionResult.breakpoints.length = 0;
              detectionResult.breakpoints.push(
                ...Array.from(allBps).sort((a, b) => {
                  const numA = parseInt(a.replace('px', ''), 10);
                  const numB = parseInt(b.replace('px', ''), 10);
                  return numA - numB;
                })
              );
            }

            if (isDevelopment()) {
              logger.info('[ResponsiveAnalysis] Precise breakpoints detected', {
                candidates: candidateValues.length,
                verified: preciseResults.filter((r) => r.verified).length,
              });
            }
          } catch (error) {
            if (isDevelopment()) {
              logger.warn('[ResponsiveAnalysis] Precise breakpoint detection failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

      // Step 2.5: ビューポート間の視覚的差分（常に実行 — 差分率はDB保存用）
      // above-the-fold（高さ2000px）に制限してメモリ節約
      let viewportDiffs: ViewportDiffResult[] | undefined;
      const screenshotMap = new Map<string, Buffer>();
      for (const capture of successfulCaptures) {
        if (capture.screenshot?.screenshot?.base64) {
          const fullBuffer = Buffer.from(capture.screenshot.screenshot.base64, 'base64');
          const metadata = await sharp(fullBuffer).metadata();
          const imgHeight = metadata.height ?? 0;

          if (imgHeight > DIFF_MAX_HEIGHT && metadata.width) {
            // above-the-fold のみ切り出し（差分計算のメモリ削減）
            const clipped = await sharp(fullBuffer)
              .extract({ left: 0, top: 0, width: metadata.width, height: DIFF_MAX_HEIGHT })
              .png()
              .toBuffer();
            screenshotMap.set(capture.viewport.name, clipped);
          } else {
            screenshotMap.set(capture.viewport.name, fullBuffer);
          }
        }
      }

      if (screenshotMap.size >= 2) {
        viewportDiffs = await viewportDiffService.compareAll(screenshotMap, {
          threshold: options.diff_threshold ?? 0.1,
          includeDiffImage: options.include_diff_images ?? false,
        });

        if (isDevelopment()) {
          logger.debug('[ResponsiveAnalysis] Viewport diff completed', {
            pairCount: viewportDiffs.length,
          });
        }
      }

      // Step 3: 検出オプションに基づいてフィルタリング
      let filteredDifferences = detectionResult.differences;

      if (options.detect_navigation === false) {
        filteredDifferences = filteredDifferences.filter((d) => d.category !== 'navigation');
      }
      if (options.detect_visibility === false) {
        filteredDifferences = filteredDifferences.filter((d) => d.category !== 'visibility');
      }
      if (options.detect_layout === false) {
        filteredDifferences = filteredDifferences.filter((d) => d.category !== 'layout');
      }

      // Step 4: 結果構築
      const analysisTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[ResponsiveAnalysis] Responsive analysis completed', {
          url,
          viewportsAnalyzed: successfulCaptures.length,
          differencesFound: filteredDifferences.length,
          breakpointsDetected: detectionResult.breakpoints.length,
          viewportDiffPairs: viewportDiffs?.length ?? 0,
          analysisTimeMs,
        });
      }

      // exactOptionalPropertyTypes対応: undefinedを含めず条件付きで返す
      const result: ResponsiveAnalysisResult = {
        viewportsAnalyzed: successfulCaptures.map((r) => r.viewport),
        differences: filteredDifferences,
        breakpoints: detectionResult.breakpoints,
        analysisTimeMs,
      };

      // include_screenshots: true の場合のみ、base64画像をレスポンスに含める
      if (options.include_screenshots) {
        result.screenshots = successfulCaptures
          .filter((r) => r.screenshot)
          .map((r) => r.screenshot!);
      }

      if (viewportDiffs && viewportDiffs.length > 0) {
        result.viewportDiffs = viewportDiffs;
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.error('[ResponsiveAnalysis] Responsive analysis failed', {
          url,
          error: errorMessage,
        });
      }

      throw new Error(`Responsive analysis failed: ${errorMessage}`);
    }
  }

  /**
   * preciseモード用のブラウザを取得
   * 共有ブラウザがある場合はそれを使用、なければcaptureServiceのブラウザを使用
   */
  private async getBrowserForPrecise(sharedBrowser?: Browser): Promise<Browser> {
    if (sharedBrowser) {
      return sharedBrowser;
    }
    // chromium.launchを直接呼ぶ代わりに一時キャプチャでブラウザを取得
    const { chromium } = await import('playwright');
    return chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }

  /**
   * サービスを終了（リソースクリーンアップ）
   */
  async close(): Promise<void> {
    await multiViewportCaptureService.close();
  }
}

// シングルトンインスタンス
export const responsiveAnalysisService = new ResponsiveAnalysisService();

// Re-export types and constants
export { DEFAULT_VIEWPORTS };
export type { ResponsiveViewport, ResponsiveAnalysisResult, ResponsiveAnalysisOptions };
