// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze WebGLアニメーション検出ハンドラー
 * WebGLAnimationDetectorService を使用してCanvas/WebGLベースのアニメーションを検出
 *
 * @module tools/page/handlers/webgl-animation-handler
 */

import { chromium, type Browser, type Page } from 'playwright';
import { logger, isDevelopment } from '../../../utils/logger';
import { WEBGL_BROWSER_ARGS } from '../../../utils/gpu-browser-args';
import {
  WebGLAnimationDetectorService,
  type WebGLAnimationDetectionOptions,
  type WebGLAnimationDetectionResult,
} from '../../../services/motion/webgl-animation-detector.service';
import {
  WebGLAnimationEmbeddingService,
} from '../../../services/motion/webgl-animation-embedding.service';
import type {
  WebGLAnimationSummaryResult,
  WebGLAnimationFullResult,
  WebGLAnimationPatternData,
  WebGLAnimationCategory,
  IPageAnalyzePrismaClient,
} from './types';

// =====================================================
// 型定義
// =====================================================

/**
 * WebGLアニメーション検出オプション (page.analyze用)
 */
export interface WebGLAnimationOptionsInput {
  sample_frames?: number;
  sample_interval_ms?: number;
  change_threshold?: number;
  timeout_ms?: number;
}

/**
 * WebGLアニメーション検出コンテキスト
 */
export interface WebGLAnimationContext {
  prisma?: IPageAnalyzePrismaClient;
  webPageId?: string;
  sourceUrl: string;
  saveToDb?: boolean;
}

/**
 * WebGLアニメーション検出結果
 */
export interface WebGLAnimationModeResult {
  webgl_animation_summary?: WebGLAnimationSummaryResult;
  webgl_animations?: WebGLAnimationFullResult;
  webgl_animation_error?: { code: string; message: string };
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * WebGLAnimationDetectorServiceの結果をpage.analyze用の型に変換
 */
function convertDetectionResult(
  result: WebGLAnimationDetectionResult
): WebGLAnimationFullResult {
  const patterns: WebGLAnimationPatternData[] = result.patterns.map((p, index) => ({
    id: `webgl-pattern-${index}`,
    name: p.name,
    category: p.category as WebGLAnimationCategory,
    detectedLibrary: p.detectedLibraries.length > 0 ? p.detectedLibraries[0] : undefined,
    canvasSelector: p.canvasSelector,
    animationCharacteristics: {
      averageChangeRate: p.visualFeatures.avgChangeRatio,
      peakChangeRate: p.visualFeatures.maxChangeRatio,
      changePattern: p.visualFeatures.periodicityScore > 0.7 ? 'pulsed' as const :
        p.visualFeatures.stdDeviation < 0.1 ? 'continuous' as const : 'irregular' as const,
      dominantColors: undefined, // 現在の実装では色情報は未取得
    },
    duration: p.visualFeatures.estimatedPeriodMs > 0 ? p.visualFeatures.estimatedPeriodMs : undefined,
    confidence: p.confidence,
  }));

  // 全パターンから検出されたライブラリを集約
  const detectedLibraries = [...new Set(
    result.patterns.flatMap(p => p.detectedLibraries)
  )];

  return {
    patterns,
    summary: {
      totalCanvasElements: result.patterns.length,
      animatedCanvasCount: result.patterns.filter(p => p.visualFeatures.avgChangeRatio > 0.001).length,
      detectedLibraries,
      totalPatterns: result.summary.totalPatterns,
    },
    detectionTimeMs: result.summary.detectionTimeMs,
  };
}

/**
 * サマリーを生成
 */
function createSummary(fullResult: WebGLAnimationFullResult): WebGLAnimationSummaryResult {
  return {
    totalCanvasElements: fullResult.summary.totalCanvasElements,
    animatedCanvasCount: fullResult.summary.animatedCanvasCount,
    detectedLibraries: fullResult.summary.detectedLibraries,
    totalPatterns: fullResult.summary.totalPatterns,
    detectionTimeMs: fullResult.detectionTimeMs,
  };
}

// =====================================================
// メインエクスポート関数
// =====================================================

/**
 * WebGLアニメーション検出を実行
 *
 * @param url - 検出対象のURL
 * @param enabled - 検出を有効にするか（デフォルト: true）
 * @param options - 検出オプション
 * @param context - DB保存コンテキスト
 * @returns WebGLアニメーション検出結果
 */
export async function executeWebGLAnimationDetection(
  url: string,
  enabled?: boolean,
  options?: WebGLAnimationOptionsInput,
  context?: WebGLAnimationContext,
  _sharedBrowser?: Browser
): Promise<WebGLAnimationModeResult> {
  // 無効化されている場合は空の結果を返す
  if (enabled === false) {
    if (isDevelopment()) {
      logger.info('[webgl-animation-handler] WebGL animation detection disabled', { url });
    }
    return {};
  }

  const startTime = Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;
  // WebGL検出には常にGPU有効化専用ブラウザを起動するため、shared browserは使わない
  // shared browserは --disable-gpu で起動されるため canvas.getContext('webgl') が null を返す
  const usingSharedBrowser = false;

  try {
    if (isDevelopment()) {
      logger.info('[webgl-animation-handler] Starting WebGL animation detection', {
        url,
        options,
        hasDbContext: !!context?.prisma,
        usingSharedBrowser,
      });
    }

    // WebGL検出には常にGPU有効化ブラウザを使用
    // 共有ブラウザは --disable-gpu で起動されるため、WebGLコンテキストが取得できない
    browser = await chromium.launch({
      headless: true,
      args: [...WEBGL_BROWSER_ARGS],
    });

    const browserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // v0.1.0: 本番環境ではHTTPS証明書エラーを無視しない
      ignoreHTTPSErrors: process.env.NODE_ENV === 'development',
    });

    page = await browserContext.newPage();

    // ページ読み込み
    // v0.1.0: デフォルトタイムアウトを90秒に増加（重いWebGLサイト対応）
    const timeoutMs = options?.timeout_ms ?? 90000;
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: timeoutMs,
    });

    // WebGLアニメーション検出を実行
    const detector = new WebGLAnimationDetectorService();
    const detectionOptions: WebGLAnimationDetectionOptions = {
      sampleFrames: options?.sample_frames ?? 20,
      sampleIntervalMs: options?.sample_interval_ms ?? 100,
      changeThreshold: options?.change_threshold ?? 0.01,
      timeoutMs: timeoutMs,
      saveToDb: context?.saveToDb ?? true,
    };

    const detectionResult = await detector.detect(page, detectionOptions);

    // 結果を変換
    const fullResult = convertDetectionResult(detectionResult);
    const summary = createSummary(fullResult);

    // DB保存が有効な場合、Embeddingを生成して保存
    if (context?.prisma && context?.saveToDb !== false && fullResult.patterns.length > 0) {
      try {
        const embeddingService = new WebGLAnimationEmbeddingService();

        for (const pattern of detectionResult.patterns) {
          // Detector結果をEmbeddingService用の型に変換
          const embeddingInput = {
            id: `webgl-pattern-${pattern.canvasSelector}`,
            category: pattern.category,
            libraries: pattern.detectedLibraries,
            description: pattern.description,
            periodicity: pattern.visualFeatures.periodicityScore > 0.7 ? {
              isPeriodic: true,
              cycleSeconds: pattern.visualFeatures.estimatedPeriodMs > 0
                ? pattern.visualFeatures.estimatedPeriodMs / 1000
                : null,
              confidence: pattern.visualFeatures.periodicityScore,
            } : null,
            avgChangeRatio: pattern.visualFeatures.avgChangeRatio,
            peakChangeRatio: pattern.visualFeatures.maxChangeRatio,
            visualFeatures: null,
            canvasDimensions: {
              width: pattern.canvasWidth,
              height: pattern.canvasHeight,
            },
            webglVersion: (pattern.webglVersion === 2 ? 2 : 1) as 1 | 2,
            framesAnalyzed: pattern.frameAnalysis.frameCount,
            durationMs: null,
            webPageId: context.webPageId ?? null,
            sourceUrl: context.sourceUrl ?? null,
          };

          // Embeddingを生成（パターンIDは一時的に生成）
          await embeddingService.generateAndSave(embeddingInput, embeddingInput.id);
        }

        if (isDevelopment()) {
          logger.info('[webgl-animation-handler] WebGL animation embeddings saved', {
            patternCount: fullResult.patterns.length,
          });
        }
      } catch (dbError) {
        // DB保存エラーは警告のみ、検出結果は返す
        if (isDevelopment()) {
          logger.warn('[webgl-animation-handler] Failed to save WebGL animation embeddings', {
            error: dbError instanceof Error ? dbError.message : 'Unknown error',
          });
        }
      }
    }

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[webgl-animation-handler] WebGL animation detection completed', {
        patternCount: fullResult.patterns.length,
        detectedLibraries: fullResult.summary.detectedLibraries,
        processingTimeMs,
      });
    }

    return {
      webgl_animation_summary: summary,
      webgl_animations: fullResult,
    };
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.error('[webgl-animation-handler] WebGL animation detection failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        url,
        processingTimeMs,
      });
    }

    return {
      webgl_animation_error: {
        code: 'WEBGL_DETECTION_FAILED',
        message: error instanceof Error ? error.message : 'WebGL animation detection failed',
      },
    };
  } finally {
    // リソースのクリーンアップ
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore cleanup errors
      }
    }
    // WebGL検出用ブラウザは常に自前で管理するため必ず閉じる
    if (browser && !usingSharedBrowser) {
      try {
        await browser.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
