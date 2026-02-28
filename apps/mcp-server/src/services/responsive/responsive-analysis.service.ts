// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Service
 * レスポンシブ解析の統合サービス
 *
 * @module services/responsive/responsive-analysis.service
 */

import { logger, isDevelopment } from '../../utils/logger';
import {
  multiViewportCaptureService,
  DEFAULT_VIEWPORTS,
} from './multi-viewport-capture.service';
import { differenceDetectorService } from './difference-detector.service';
import type {
  ResponsiveViewport,
  ResponsiveAnalysisResult,
  ResponsiveAnalysisOptions,
} from './types';

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
   * @returns レスポンシブ解析結果
   */
  async analyze(url: string, options: ResponsiveAnalysisOptions): Promise<ResponsiveAnalysisResult> {
    const startTime = Date.now();

    if (!options.enabled) {
      return {
        viewportsAnalyzed: [],
        differences: [],
        breakpoints: [],
        analysisTimeMs: 0,
      };
    }

    const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
    const includeScreenshots = options.include_screenshots ?? true;

    if (isDevelopment()) {
      logger.info('[ResponsiveAnalysis] Starting responsive analysis', {
        url,
        viewports: viewports.map((v) => v.name),
        includeScreenshots,
        detectNavigation: options.detect_navigation,
        detectVisibility: options.detect_visibility,
        detectLayout: options.detect_layout,
      });
    }

    try {
      // Step 1: 複数ビューポートでキャプチャ
      const captureResults = await multiViewportCaptureService.captureAllViewports(url, {
        viewports,
        includeScreenshots,
        timeout: 30000,
        fullPage: true,
        waitUntil: 'load',
        waitForDomStable: true,
        domStableTimeout: 500,
      });

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
          viewportsAnalyzed: successfulCaptures.map((r) => r.viewport.name),
          differences: [],
          breakpoints: [],
          analysisTimeMs: Date.now() - startTime,
        };
      }

      // Step 2: 差異検出
      const detectionResult = differenceDetectorService.detectDifferences(successfulCaptures);

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

      // Step 4: スクリーンショット収集
      const analysisTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[ResponsiveAnalysis] Responsive analysis completed', {
          url,
          viewportsAnalyzed: successfulCaptures.length,
          differencesFound: filteredDifferences.length,
          breakpointsDetected: detectionResult.breakpoints.length,
          analysisTimeMs,
        });
      }

      // exactOptionalPropertyTypes対応: undefinedを含めず条件付きで返す
      if (includeScreenshots) {
        const screenshots = successfulCaptures
          .filter((r) => r.screenshot)
          .map((r) => r.screenshot!);

        return {
          viewportsAnalyzed: successfulCaptures.map((r) => r.viewport.name),
          differences: filteredDifferences,
          breakpoints: detectionResult.breakpoints,
          screenshots,
          analysisTimeMs,
        };
      }

      return {
        viewportsAnalyzed: successfulCaptures.map((r) => r.viewport.name),
        differences: filteredDifferences,
        breakpoints: detectionResult.breakpoints,
        analysisTimeMs,
      };
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
