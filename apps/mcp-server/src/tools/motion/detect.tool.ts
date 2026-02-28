// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect MCPツール
 * Webページからモーション/アニメーションパターンを検出・分類します
 *
 * 機能:
 * - CSS Animation (@keyframes) 検出
 * - CSS Transition 検出
 * - パターン分類（scroll_trigger, hover_effect, loading_state等）
 * - パフォーマンス分析
 * - アクセシビリティ警告
 *
 * このファイルはオーケストレーターとして機能し、
 * 各サブモジュールに処理を委譲します。
 *
 * @module tools/motion/detect.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
  formatZodError,
} from '../../utils/error-messages';
import {
  motionDetectInputSchema,
  calculateComplexityScore,
  calculateAverageDuration,
  countByType,
  countByTrigger,
  countByCategory,
  type MotionDetectInput,
  type MotionDetectOutput,
  type MotionPattern,
  type MotionSummary,
  type MotionMetadata,
  type MotionWarning,
  type FrameImageAnalysisInputOptions,
  type LighthouseOptions,
  type AnalyzeMetricsOptions,
  type AnimationMetricsResult,
  type JSAnimationOptions,
  MOTION_MCP_ERROR_CODES,
  MOTION_WARNING_CODES,
  type MotionMcpErrorCode,
} from './schemas';

// DI factories
import {
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  setRuntimeAnimationDetectorFactory,
  resetRuntimeAnimationDetectorFactory,
  setFrameCaptureServiceFactory,
  resetFrameCaptureServiceFactory,
  setLighthouseDetectorServiceFactory,
  resetLighthouseDetectorServiceFactory,
  setAnimationMetricsCollectorFactory,
  resetAnimationMetricsCollectorFactory,
  setFrameImageAnalysisServiceFactory,
  resetFrameImageAnalysisServiceFactory,
  setJSAnimationDetectorFactory,
  resetJSAnimationDetectorFactory,
  setWebPageServiceFactory,
  resetWebPageServiceFactory,
  getMotionDetectServiceFactory,
  getFrameCaptureServiceInstance,
  getLighthouseDetectorService,
  getAnimationMetricsCollector,
  getFrameImageAnalysisService,
  getFrameEmbeddingServiceInstance,
  getJSAnimationDetectorService,
  getWebPageService,
  type IMotionDetectService,
  type IVideoRecorderService,
  type IFrameAnalyzerService,
  type IRuntimeAnimationDetectorService,
  type IFrameCaptureService,
  type ILighthouseDetectorService,
  type IAnimationMetricsCollector,
  type IFrameImageAnalysisService,
  type IJSAnimationDetectorService,
  type IWebPageService,
  type LighthouseDetailedResult,
  type FrameImageAnalysisOutput,
  type JSAnimationResult,
  type FindOrCreateResult,
} from './di-factories';

// Detection modes
import {
  SSRFBlockedError,
  VideoRecordError,
  FrameAnalysisError,
  executeVideoDetection,
  executeFrameCapture,
  executeRuntimeDetection,
  defaultDetect,
} from './detection-modes';

// CSS mode handler
import { handleCssMode, savePatternsToDb, generateWebglDetectionWarning, type SaveResultWithDebug } from './css-mode-handler';

// JS Animation DB保存（page.analyze と共有）
import {
  mapJSAnimationResultToPatterns,
  saveJSAnimationPatternsWithEmbeddings,
} from '../page/handlers/js-animation-handler';
import type { JSAnimationFullResult } from '../page/handlers/types';
import { getJSAnimationPersistencePrismaClient } from './di-factories';

// =====================================================
// タイムアウト設定定数 (v0.1.0)
// =====================================================

/** デフォルトタイムアウト: 3分 (180秒) */
export const DEFAULT_MOTION_TIMEOUT = 180000;

/** 最小タイムアウト: 30秒 */
export const MIN_MOTION_TIMEOUT = 30000;

/**
 * タイムアウト警告コード
 * Graceful degradation 時に警告に含めるコード
 */
export const TimeoutWarningCode = {
  /** motion.detect 全体のタイムアウト */
  MOTION_DETECTION_TIMEOUT: 'MOTION_DETECTION_TIMEOUT',
  /** JSアニメーション検出のタイムアウト */
  JS_ANIMATION_TIMEOUT: 'JS_ANIMATION_TIMEOUT',
  /** フレームキャプチャのタイムアウト */
  FRAME_CAPTURE_TIMEOUT: 'FRAME_CAPTURE_TIMEOUT',
  /** 部分的な結果（一部処理がタイムアウト） */
  PARTIAL_RESULT: 'PARTIAL_RESULT',
} as const;

export type TimeoutWarningCodeType = (typeof TimeoutWarningCode)[keyof typeof TimeoutWarningCode];

// =====================================================
// タイムアウトヘルパー (v0.1.0)
// =====================================================

/**
 * タイムアウトエラークラス
 * Promise.raceでタイムアウトした場合にスローされる
 */
export class MotionTimeoutError extends Error {
  public readonly phase: string;
  public readonly elapsedMs: number;

  constructor(phase: string, elapsedMs: number) {
    super(`Motion detection timeout in ${phase} phase after ${elapsedMs}ms`);
    this.name = 'MotionTimeoutError';
    this.phase = phase;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * タイムアウト付きでPromiseを実行
 * タイムアウト時は MotionTimeoutError をスロー
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: string,
  startTime: number
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const elapsedMs = Date.now() - startTime;
      reject(new MotionTimeoutError(phase, elapsedMs));
    }, timeoutMs);
    // Node.js特有: タイマーがプロセス終了を阻止しないようにする
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * タイムアウト時のgraceful degradation用レスポンスを生成
 */
export function createTimeoutResponse(
  phase: string,
  elapsedMs: number,
  partialPatterns: MotionPattern[] = []
): MotionDetectOutput {
  const warnings: MotionWarning[] = [
    {
      code: TimeoutWarningCode.MOTION_DETECTION_TIMEOUT,
      severity: 'warning',
      message: `Motion detection timed out in ${phase} phase after ${elapsedMs}ms`,
      context: { elapsedMs, phase },
    },
  ];

  if (partialPatterns.length > 0) {
    warnings.push({
      code: TimeoutWarningCode.PARTIAL_RESULT,
      severity: 'info',
      message: `Partial results available: ${partialPatterns.length} patterns detected before timeout`,
    });
  }

  // 無限アニメーションがあるかチェック（iterationsはanimationオブジェクト内）
  const hasInfiniteAnimations = partialPatterns.some(
    (p) => p.animation?.iterations === -1 || p.animation?.iterations === Infinity
  );

  return {
    success: true,
    data: {
      patterns: partialPatterns,
      summary: {
        totalPatterns: partialPatterns.length,
        byType: countByType(partialPatterns),
        byTrigger: countByTrigger(partialPatterns),
        byCategory: countByCategory(partialPatterns),
        complexityScore: calculateComplexityScore(partialPatterns),
        averageDuration: calculateAverageDuration(partialPatterns),
        hasInfiniteAnimations,
      },
      warnings,
      metadata: {
        had_timeout: true,
        timeout_phase: phase,
        timeout_elapsed_ms: elapsedMs,
        processingTimeMs: elapsedMs,
        detection_mode: 'css',
        detectedAt: new Date().toISOString(),
        schemaVersion: '0.1.0',
      },
    },
  };
}

// Re-exports for backward compatibility
export type { MotionDetectInput, MotionDetectOutput };
export { motionDetectInputSchema };
export {
  SSRFBlockedError,
  VideoRecordError,
  FrameAnalysisError,
  executeFrameCapture,
};
export {
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  setRuntimeAnimationDetectorFactory,
  resetRuntimeAnimationDetectorFactory,
  setFrameCaptureServiceFactory,
  resetFrameCaptureServiceFactory,
  setLighthouseDetectorServiceFactory,
  resetLighthouseDetectorServiceFactory,
  setAnimationMetricsCollectorFactory,
  resetAnimationMetricsCollectorFactory,
  setFrameImageAnalysisServiceFactory,
  resetFrameImageAnalysisServiceFactory,
  setJSAnimationDetectorFactory,
  resetJSAnimationDetectorFactory,
  setWebPageServiceFactory,
  resetWebPageServiceFactory,
  getFrameCaptureServiceInstance as getFrameCaptureService,
  getFrameImageAnalysisService,
  getJSAnimationDetectorService,
  getWebPageService,
  type IMotionDetectService,
  type IVideoRecorderService,
  type IFrameAnalyzerService,
  type IRuntimeAnimationDetectorService,
  type IFrameCaptureService,
  type ILighthouseDetectorService,
  type IAnimationMetricsCollector,
  type IFrameImageAnalysisService,
  type IJSAnimationDetectorService,
  type IWebPageService,
  type LighthouseDetailedResult,
  type FrameImageAnalysisOutput,
  type JSAnimationResult,
  type FindOrCreateResult,
};

// =====================================================
// メインハンドラー（オーケストレーター）
// =====================================================

/**
 * motion.detect ツールハンドラー
 *
 * 検出モードに応じて適切なサブモジュールに処理を委譲します。
 * - video: executeVideoDetection
 * - runtime: executeRuntimeDetection
 * - hybrid: runtime + CSS
 * - css (default): handleCssMode
 */
export async function motionDetectHandler(
  input: unknown
): Promise<MotionDetectOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.detect called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: MotionDetectInput;
  try {
    validated = motionDetectInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorWithHints = createValidationErrorWithHints(error, 'motion.detect');
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);
      const formattedErrors = formatZodError(error);

      if (isDevelopment()) {
        logger.error('[MCP Tool] motion.detect validation error', {
          errors: errorWithHints.errors,
        });
      }

      return {
        success: false,
        error: {
          code: MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error:\n${detailedMessage}`,
          details: {
            errors: formattedErrors,
            detailedErrors: errorWithHints.errors,
          },
        },
      };
    }

    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.detect validation error', { error });
    }
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  // =====================================================
  // タイムアウトチェック (v0.1.0)
  // バリデーション完了後、既にタイムアウトしている場合は即座にgraceful degradation
  // =====================================================
  const timeout = validated.timeout ?? DEFAULT_MOTION_TIMEOUT;
  const elapsedAfterValidation = Date.now() - startTime;

  if (elapsedAfterValidation >= timeout) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] motion.detect timeout before processing', {
        timeout,
        elapsed: elapsedAfterValidation,
      });
    }
    return createTimeoutResponse('validation', elapsedAfterValidation);
  }

  // 残りの時間でタイムアウト付き処理を実行
  const remainingTimeout = timeout - elapsedAfterValidation;

  // =====================================================
  // Video Mode Detection
  // =====================================================
  if (validated.detection_mode === 'video' && validated.url) {
    try {
      return await withTimeout(
        handleVideoMode(validated, startTime),
        remainingTimeout,
        'video',
        startTime
      );
    } catch (error) {
      if (error instanceof MotionTimeoutError) {
        return createTimeoutResponse(error.phase, error.elapsedMs);
      }
      throw error;
    }
  }

  // =====================================================
  // Runtime Mode Detection
  // =====================================================
  if (validated.detection_mode === 'runtime' && validated.url) {
    try {
      return await withTimeout(
        handleRuntimeMode(validated, startTime),
        remainingTimeout,
        'runtime',
        startTime
      );
    } catch (error) {
      if (error instanceof MotionTimeoutError) {
        return createTimeoutResponse(error.phase, error.elapsedMs);
      }
      throw error;
    }
  }

  // =====================================================
  // Hybrid Mode Detection (CSS + Runtime)
  // =====================================================
  if (validated.detection_mode === 'hybrid' && validated.url) {
    try {
      return await withTimeout(
        handleHybridMode(validated, startTime),
        remainingTimeout,
        'hybrid',
        startTime
      );
    } catch (error) {
      if (error instanceof MotionTimeoutError) {
        return createTimeoutResponse(error.phase, error.elapsedMs);
      }
      throw error;
    }
  }

  // =====================================================
  // Library Only Mode Detection (v0.1.0)
  // 注: library_only モードは layout_first モード経由で使用される
  // 直接呼び出しの場合はデフォルトモードにフォールバック
  // =====================================================
  if (validated.detection_mode === 'library_only') {
    if (isDevelopment()) {
      logger.info('[MCP Tool] library_only mode: falling back to css mode with JS animation detection', {
        url: validated.url,
      });
    }
    // デフォルトモードで処理（layout_first経由で呼び出される場合はJS animation optionsが設定済み）
  }

  // =====================================================
  // CSS Mode Detection (Default)
  // =====================================================
  try {
    return await withTimeout(
      handleDefaultMode(validated, startTime),
      remainingTimeout,
      'css',
      startTime
    );
  } catch (error) {
    if (error instanceof MotionTimeoutError) {
      return createTimeoutResponse(error.phase, error.elapsedMs);
    }
    throw error;
  }
}

// =====================================================
// WebPage Auto-Create Helper (v0.1.0)
// URL modeで自動的にWebPageレコードを作成・取得
// =====================================================

/**
 * URL modeでWebPageを自動作成または取得
 *
 * motion.detect URL modeで実行時に:
 * 1. 既存のWebPageをURLで検索（完全一致）
 * 2. 存在しなければ新規WebPageレコードを作成
 * 3. webPageIdを返す（savePatternsToDbに渡す）
 *
 * @param url - 対象URL
 * @returns webPageIdとcreatedフラグ、またはエラー時はnull
 */
async function findOrCreateWebPageForUrl(
  url: string
): Promise<{ webPageId: string; created: boolean } | null> {
  try {
    const webPageService = getWebPageService();
    const result = await webPageService.findOrCreateByUrl(url, {
      sourceType: 'user_provided',
      usageScope: 'inspiration_only',
    });

    if (isDevelopment()) {
      logger.info('[MCP Tool] motion.detect WebPage findOrCreate result', {
        url,
        webPageId: result.id,
        created: result.created,
      });
    }

    return {
      webPageId: result.id,
      created: result.created,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] motion.detect WebPage findOrCreate failed', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    // エラー時はnullを返す（graceful degradation: 保存は source_url のみで続行）
    return null;
  }
}

// =====================================================
// Video Mode Handler
// =====================================================

async function handleVideoMode(
  validated: MotionDetectInput,
  startTime: number
): Promise<MotionDetectOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.detect using video mode', {
      url: validated.url,
      videoOptions: validated.video_options,
    });
  }

  try {
    const { videoInfo, patterns, warnings } = await executeVideoDetection(
      validated.url!,
      validated.video_options
    );

    // Phase0: WebPage自動作成（v0.1.0）
    // URL modeではWebPageを自動作成し、web_page_idを取得
    let webPageId: string | undefined;
    let webPageCreated = false;
    if (validated.save_to_db) {
      const webPageResult = await findOrCreateWebPageForUrl(validated.url!);
      if (webPageResult) {
        webPageId = webPageResult.webPageId;
        webPageCreated = webPageResult.created;
      }
    }

    // Phase5: Frame Capture実行
    let frameCaptureResult = null;
    let frameCaptureError: { code: string; message: string } | undefined;
    let frameCaptureProcessingTimeMs = 0;

    if (validated.enable_frame_capture === true) {
      const frameCaptureStartTime = Date.now();

      try {
        const frameCaptureOpts = validated.frame_capture_options ?? {};
        const frameCaptureExecOpts: {
          scroll_px_per_frame?: number;
          frame_interval_ms?: number;
          output_dir?: string;
          output_format?: 'png' | 'jpeg';
          filename_pattern?: string;
          viewport?: { width: number; height: number };
        } = {
          scroll_px_per_frame: frameCaptureOpts.scroll_px_per_frame ?? 15,
          frame_interval_ms: frameCaptureOpts.frame_interval_ms ?? 33,
          output_dir: frameCaptureOpts.output_dir ?? '/tmp/reftrix-frames/',
          output_format: frameCaptureOpts.output_format ?? 'png',
          filename_pattern: frameCaptureOpts.filename_pattern ?? 'frame-{0000}.png',
        };
        if (validated.video_options?.viewport) {
          frameCaptureExecOpts.viewport = validated.video_options.viewport;
        }
        frameCaptureResult = await executeFrameCapture(validated.url!, frameCaptureExecOpts);
        frameCaptureProcessingTimeMs = Date.now() - frameCaptureStartTime;
      } catch (fcErr) {
        frameCaptureProcessingTimeMs = Date.now() - frameCaptureStartTime;
        const errorObj = fcErr as Error & { code?: string };
        frameCaptureError = {
          code: errorObj.name === 'SSRFBlockedError' ? 'FRAME_CAPTURE_SSRF_BLOCKED' : 'FRAME_CAPTURE_ERROR',
          message: fcErr instanceof Error ? fcErr.message : 'Frame capture failed',
        };
      }
    }

    // Phase3: Lighthouse実行
    const lighthouseOptions = validated.lighthouse_options as LighthouseOptions | undefined;
    const lighthouseResults = await executeLighthouseIfEnabled(validated.url!, lighthouseOptions);

    // Phase4: AnimationMetrics実行
    const animationMetricsResults = await executeAnimationMetricsIfEnabled(
      validated.analyze_metrics,
      patterns,
      lighthouseResults.metrics,
      validated.analyze_metrics_options as AnalyzeMetricsOptions | undefined
    );

    // Phase5: Frame Image Analysis実行
    const frameAnalysisResults = await executeFrameImageAnalysisIfEnabled(
      validated.analyze_frames,
      validated.frame_analysis_options as FrameImageAnalysisInputOptions | undefined,
      frameCaptureResult?.output_dir,
      validated.frame_capture_options?.output_dir,
      frameCaptureResult?.total_frames // キャプチャされたフレーム数を渡す
    );

    // Phase6 v0.1.0: JS Animation検出実行
    const jsAnimationResults = await executeJSAnimationDetectionWithUrl(
      validated.url!,
      validated.detect_js_animations,
      validated.js_animation_options as JSAnimationOptions | undefined
    );

    // Phase7: Frame Analysis DB保存（非同期、メインレスポンスをブロックしない）
    let frameAnalysisSaveResult: {
      saved: boolean;
      savedCount: number;
      patternIds: string[];
      embeddingIds: string[];
      reason?: string | undefined;
      byCategory?: {
        animationZones: number;
        layoutShifts: number;
        motionVectors: number;
      } | undefined;
    } | undefined;

    if (validated.save_to_db && frameAnalysisResults.result) {
      const frameAnalysisSaveResultPromise = executeFrameAnalysisSave(
        frameAnalysisResults.result,
        validated.url
      );

      // 非同期でDB保存を実行し、結果を待つ
      // エラー時は警告ログのみ出力し、メインレスポンスには影響しない
      try {
        frameAnalysisSaveResult = await frameAnalysisSaveResultPromise;

        if (isDevelopment()) {
          logger.info('[MCP Tool] motion.detect frame analysis DB save completed', {
            saved: frameAnalysisSaveResult.saved,
            savedCount: frameAnalysisSaveResult.savedCount,
            patternIds: frameAnalysisSaveResult.patternIds.length,
          });
        }
      } catch (saveError) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] motion.detect frame analysis DB save failed', {
            error: saveError instanceof Error ? saveError.message : 'Unknown error',
          });
        }
        // エラー時も結果を返す（saved: false）
        frameAnalysisSaveResult = {
          saved: false,
          savedCount: 0,
          patternIds: [],
          embeddingIds: [],
          reason: saveError instanceof Error ? saveError.message : 'DB save failed',
        };
      }
    }

    // Phase8: Motion Pattern DB保存（v0.1.0）
    // webPageId をセットしてパターンを保存（source_url は後方互換性のため両方セット）
    let patternSaveResult: SaveResultWithDebug | undefined;
    if (validated.save_to_db && patterns.length > 0) {
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect saving patterns to DB (video mode)', {
          patternsCount: patterns.length,
          webPageId,
          webPageCreated,
          url: validated.url,
        });
      }
      // webPageId（自動作成または既存）と source_url（後方互換性）の両方を渡す
      patternSaveResult = await savePatternsToDb(patterns, webPageId, validated.url);
    }

    // Phase9: JS Animation Pattern DB保存（v0.1.0）
    let jsAnimationSaveResult: JSAnimationSaveResultWrapper | undefined;
    if (validated.save_to_db && jsAnimationResults.result) {
      jsAnimationSaveResult = await saveJSAnimationsToDb(
        jsAnimationResults.result,
        webPageId,
        validated.url
      );
    }

    // 警告をマージ
    const allWarnings = [
      ...warnings,
      ...lighthouseResults.warnings,
      ...animationMetricsResults.warnings,
      ...frameAnalysisResults.warnings,
      ...jsAnimationResults.warnings,
    ];

    // WebGL/Canvas検出警告（patterns=0件 かつ detect_js_animations=false の場合）
    const webglWarning = generateWebglDetectionWarning(
      patterns.length,
      validated.detect_js_animations ?? false
    );
    if (webglWarning) {
      allWarnings.push(webglWarning);
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect WebGL detection warning added (video mode)', {
          patternCount: patterns.length,
          detectJsAnimations: validated.detect_js_animations ?? false,
        });
      }
    }

    const processingTimeMs = Date.now() - startTime;

    const summary: MotionSummary = {
      totalPatterns: patterns.length,
      byType: countByType(patterns),
      byTrigger: countByTrigger(patterns),
      byCategory: countByCategory(patterns),
      averageDuration: calculateAverageDuration(patterns),
      hasInfiniteAnimations: false,
      complexityScore: calculateComplexityScore(patterns),
    };

    const metadata: MotionMetadata = {
      detectedAt: new Date().toISOString(),
      processingTimeMs,
      schemaVersion: '0.1.0',
      detection_mode: 'video',
      lighthouse_processing_time_ms: lighthouseResults.processingTimeMs,
      analyze_metrics_processing_time_ms: animationMetricsResults.processingTimeMs,
      frame_analysis_processing_time_ms: frameAnalysisResults.processingTimeMs,
      frame_capture_processing_time_ms: validated.enable_frame_capture ? frameCaptureProcessingTimeMs : undefined,
      js_animation_processing_time_ms: jsAnimationResults.processingTimeMs,
    };

    return {
      success: true,
      data: {
        pageId: webPageId, // v0.1.0: 自動作成または既存のWebPage ID
        patterns,
        warnings: validated.includeWarnings !== false ? allWarnings : undefined,
        summary: validated.includeSummary !== false ? summary : undefined,
        metadata,
        saveResult: patternSaveResult?.saveResult, // v0.1.0: パターン保存結果
        video_info: videoInfo,
        lighthouse_metrics: lighthouseResults.metrics,
        lighthouse_error: lighthouseResults.error,
        lighthouse_save_result: lighthouseResults.saveResult,
        animation_metrics: animationMetricsResults.metrics,
        animation_metrics_error: animationMetricsResults.error,
        frame_analysis: frameAnalysisResults.result,
        frame_analysis_error: frameAnalysisResults.error,
        frame_analysis_save_result: frameAnalysisSaveResult,
        frame_capture: frameCaptureResult
          ? {
              total_frames: frameCaptureResult.total_frames,
              output_dir: frameCaptureResult.output_dir,
              config: frameCaptureResult.config,
              files: frameCaptureResult.files,
              duration_ms: frameCaptureResult.duration_ms,
            }
          : undefined,
        frame_capture_error: frameCaptureError,
        js_animations: jsAnimationResults.result,
        js_animations_error: jsAnimationResults.error,
        js_animation_save_result: jsAnimationSaveResult, // v0.1.0: JS Animation保存結果
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.detect video mode error', { error });
    }

    let errorCode: MotionMcpErrorCode = MOTION_MCP_ERROR_CODES.VIDEO_RECORD_ERROR;
    if (error instanceof SSRFBlockedError) {
      errorCode = MOTION_MCP_ERROR_CODES.SSRF_BLOCKED;
    } else if (error instanceof FrameAnalysisError) {
      errorCode = MOTION_MCP_ERROR_CODES.FRAME_ANALYSIS_ERROR;
    } else if (error instanceof VideoRecordError) {
      errorCode = error.message.includes('timeout') || error.message.includes('Timeout')
        ? MOTION_MCP_ERROR_CODES.VIDEO_TIMEOUT_ERROR
        : MOTION_MCP_ERROR_CODES.VIDEO_RECORD_ERROR;
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : 'Video detection failed',
      },
    };
  }
}

// =====================================================
// Runtime Mode Handler
// =====================================================

async function handleRuntimeMode(
  validated: MotionDetectInput,
  startTime: number
): Promise<MotionDetectOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.detect using runtime mode', {
      url: validated.url,
      runtimeOptions: validated.runtime_options,
    });
  }

  try {
    const { patterns, warnings, runtime_info } = await executeRuntimeDetection(
      validated.url!,
      validated.runtime_options
    );

    // Phase0: WebPage自動作成（v0.1.0）
    let webPageId: string | undefined;
    let webPageCreated = false;
    if (validated.save_to_db) {
      const webPageResult = await findOrCreateWebPageForUrl(validated.url!);
      if (webPageResult) {
        webPageId = webPageResult.webPageId;
        webPageCreated = webPageResult.created;
      }
    }

    // v0.1.0: JS Animation検出実行
    const jsAnimationResults = await executeJSAnimationDetectionWithUrl(
      validated.url!,
      validated.detect_js_animations,
      validated.js_animation_options as JSAnimationOptions | undefined
    );

    // Motion Pattern DB保存（v0.1.0）
    let patternSaveResult: SaveResultWithDebug | undefined;
    if (validated.save_to_db && patterns.length > 0) {
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect saving patterns to DB (runtime mode)', {
          patternsCount: patterns.length,
          webPageId,
          webPageCreated,
          url: validated.url,
        });
      }
      patternSaveResult = await savePatternsToDb(patterns, webPageId, validated.url);
    }

    // Phase: JS Animation Pattern DB保存（v0.1.0）
    let jsAnimationSaveResult: JSAnimationSaveResultWrapper | undefined;
    if (validated.save_to_db && jsAnimationResults.result) {
      jsAnimationSaveResult = await saveJSAnimationsToDb(
        jsAnimationResults.result,
        webPageId,
        validated.url
      );
    }

    // 警告をマージ
    const allWarnings = [...warnings, ...jsAnimationResults.warnings];

    // WebGL/Canvas検出警告（patterns=0件 かつ detect_js_animations=false の場合）
    const webglWarning = generateWebglDetectionWarning(
      patterns.length,
      validated.detect_js_animations ?? false
    );
    if (webglWarning) {
      allWarnings.push(webglWarning);
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect WebGL detection warning added (runtime mode)', {
          patternCount: patterns.length,
          detectJsAnimations: validated.detect_js_animations ?? false,
        });
      }
    }

    const processingTimeMs = Date.now() - startTime;

    const summary: MotionSummary = {
      totalPatterns: patterns.length,
      byType: countByType(patterns),
      byTrigger: countByTrigger(patterns),
      byCategory: countByCategory(patterns),
      averageDuration: calculateAverageDuration(patterns),
      hasInfiniteAnimations: patterns.some((p) => p.animation?.iterations === 'infinite'),
      complexityScore: calculateComplexityScore(patterns),
    };

    const metadata: MotionMetadata = {
      detectedAt: new Date().toISOString(),
      processingTimeMs,
      schemaVersion: '0.1.0',
      detection_mode: 'runtime',
      js_animation_processing_time_ms: jsAnimationResults.processingTimeMs,
    };

    return {
      success: true,
      data: {
        pageId: webPageId, // v0.1.0: 自動作成または既存のWebPage ID
        patterns,
        warnings: validated.includeWarnings !== false ? allWarnings : undefined,
        summary: validated.includeSummary !== false ? summary : undefined,
        metadata,
        saveResult: patternSaveResult?.saveResult, // v0.1.0: パターン保存結果
        runtime_info,
        js_animations: jsAnimationResults.result,
        js_animations_error: jsAnimationResults.error,
        js_animation_save_result: jsAnimationSaveResult, // v0.1.0: JS Animation保存結果
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.detect runtime mode error', { error });
    }

    return {
      success: false,
      error: {
        code: error instanceof SSRFBlockedError
          ? MOTION_MCP_ERROR_CODES.SSRF_BLOCKED
          : MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Runtime detection failed',
      },
    };
  }
}

// =====================================================
// Hybrid Mode Handler
// =====================================================

async function handleHybridMode(
  validated: MotionDetectInput,
  startTime: number
): Promise<MotionDetectOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.detect using hybrid mode', {
      url: validated.url,
      runtimeOptions: validated.runtime_options,
    });
  }

  try {
    // 1. Runtime検出を実行
    const runtimeResult = await executeRuntimeDetection(
      validated.url!,
      validated.runtime_options
    );

    // 2. CSS検出も実行
    const { chromium } = await import('playwright');
    let browser = null;
    let htmlContent = '';

    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      // WebGL/3Dサイト対応: domcontentloadedで待機（loadは3Dサイトで非常に時間がかかる）
      await page.goto(validated.url!, { waitUntil: 'domcontentloaded', timeout: 30000 });
      htmlContent = await page.content();
    } catch {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] motion.detect hybrid mode: failed to get HTML for CSS detection');
      }
    } finally {
      // ブラウザリソースを確実に解放
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    let cssPatterns: MotionPattern[] = [];
    let cssWarnings: MotionWarning[] = [];

    if (htmlContent) {
      const cssResult = defaultDetect(htmlContent, undefined, {
        includeInlineStyles: validated.includeInlineStyles,
        includeStyleSheets: validated.includeStyleSheets,
        minDuration: validated.minDuration,
        maxPatterns: validated.maxPatterns,
        verbose: validated.verbose,
      });
      cssPatterns = cssResult.patterns;
      cssWarnings = cssResult.warnings;
    }

    // 3. パターンをマージ
    const runtimePatternIds = new Set(runtimeResult.patterns.map((p) => p.id));
    const uniqueCssPatterns = cssPatterns.filter((p) => !runtimePatternIds.has(p.id));
    const mergedPatterns = [...runtimeResult.patterns, ...uniqueCssPatterns];
    const mergedWarnings = [...runtimeResult.warnings, ...cssWarnings];

    // 4. JS Animation検出実行（v0.1.0）
    const jsAnimationResults = await executeJSAnimationDetectionWithUrl(
      validated.url!,
      validated.detect_js_animations,
      validated.js_animation_options as JSAnimationOptions | undefined
    );
    mergedWarnings.push(...jsAnimationResults.warnings);

    // WebGL/Canvas検出警告（patterns=0件 かつ detect_js_animations=false の場合）
    const webglWarning = generateWebglDetectionWarning(
      mergedPatterns.length,
      validated.detect_js_animations ?? false
    );
    if (webglWarning) {
      mergedWarnings.push(webglWarning);
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect WebGL detection warning added (hybrid mode)', {
          patternCount: mergedPatterns.length,
          detectJsAnimations: validated.detect_js_animations ?? false,
        });
      }
    }

    // Phase0: WebPage自動作成（v0.1.0）
    let webPageId: string | undefined;
    let webPageCreated = false;
    if (validated.save_to_db) {
      const webPageResult = await findOrCreateWebPageForUrl(validated.url!);
      if (webPageResult) {
        webPageId = webPageResult.webPageId;
        webPageCreated = webPageResult.created;
      }
    }

    // Motion Pattern DB保存（v0.1.0）
    let patternSaveResult: SaveResultWithDebug | undefined;
    if (validated.save_to_db && mergedPatterns.length > 0) {
      if (isDevelopment()) {
        logger.info('[MCP Tool] motion.detect saving patterns to DB (hybrid mode)', {
          patternsCount: mergedPatterns.length,
          webPageId,
          webPageCreated,
          url: validated.url,
        });
      }
      patternSaveResult = await savePatternsToDb(mergedPatterns, webPageId, validated.url);
    }

    // Phase: JS Animation Pattern DB保存（v0.1.0）
    let jsAnimationSaveResult: JSAnimationSaveResultWrapper | undefined;
    if (validated.save_to_db && jsAnimationResults.result) {
      jsAnimationSaveResult = await saveJSAnimationsToDb(
        jsAnimationResults.result,
        webPageId,
        validated.url
      );
    }

    const processingTimeMs = Date.now() - startTime;

    const summary: MotionSummary = {
      totalPatterns: mergedPatterns.length,
      byType: countByType(mergedPatterns),
      byTrigger: countByTrigger(mergedPatterns),
      byCategory: countByCategory(mergedPatterns),
      averageDuration: calculateAverageDuration(mergedPatterns),
      hasInfiniteAnimations: mergedPatterns.some((p) => p.animation?.iterations === 'infinite'),
      complexityScore: calculateComplexityScore(mergedPatterns),
    };

    const metadata: MotionMetadata = {
      detectedAt: new Date().toISOString(),
      processingTimeMs,
      schemaVersion: '0.1.0',
      detection_mode: 'hybrid',
      js_animation_processing_time_ms: jsAnimationResults.processingTimeMs,
    };

    const hybridInfo = {
      runtime_patterns_count: runtimeResult.patterns.length,
      css_patterns_count: uniqueCssPatterns.length,
      total_merged_patterns: mergedPatterns.length,
    };

    return {
      success: true,
      data: {
        pageId: webPageId, // v0.1.0: 自動作成または既存のWebPage ID
        patterns: mergedPatterns,
        warnings: validated.includeWarnings !== false ? mergedWarnings : undefined,
        summary: validated.includeSummary !== false ? summary : undefined,
        metadata: {
          ...metadata,
          hybrid_info: hybridInfo,
        },
        saveResult: patternSaveResult?.saveResult, // v0.1.0: パターン保存結果
        runtime_info: runtimeResult.runtime_info,
        js_animations: jsAnimationResults.result, // v0.1.0: JS Animation検出結果
        js_animations_error: jsAnimationResults.error,
        js_animation_save_result: jsAnimationSaveResult, // v0.1.0: JS Animation保存結果
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.detect hybrid mode error', { error });
    }

    return {
      success: false,
      error: {
        code: error instanceof SSRFBlockedError
          ? MOTION_MCP_ERROR_CODES.SSRF_BLOCKED
          : MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Hybrid detection failed',
      },
    };
  }
}

// =====================================================
// Default (CSS) Mode Handler
// =====================================================

async function handleDefaultMode(
  validated: MotionDetectInput,
  startTime: number
): Promise<MotionDetectOutput> {
  let html = validated.html;
  let css = validated.css;
  let pageId: string | undefined;

  // pageIdが指定されている場合はDBから取得
  if (validated.pageId && !html) {
    try {
      const serviceFactory = getMotionDetectServiceFactory();
      const service = serviceFactory?.();
      if (!service?.getPageById) {
        return {
          success: false,
          error: {
            code: MOTION_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
            message: 'Page service is not available',
          },
        };
      }

      const page = await service.getPageById(validated.pageId);
      if (!page) {
        return {
          success: false,
          error: {
            code: MOTION_MCP_ERROR_CODES.PAGE_NOT_FOUND,
            message: `Page not found: ${validated.pageId}`,
          },
        };
      }

      html = page.htmlContent;
      css = page.cssContent;
      pageId = page.id;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[MCP Tool] motion.detect DB error', { error });
      }
      return {
        success: false,
        error: {
          code: MOTION_MCP_ERROR_CODES.DB_ERROR,
          message: error instanceof Error ? error.message : 'Database error',
        },
      };
    }
  }

  if (!html) {
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: 'No HTML content provided',
      },
    };
  }

  return handleCssMode(validated, html, css, pageId, startTime);
}

// =====================================================
// Lighthouse Helper
// =====================================================

interface LighthouseResult {
  metrics: ReturnType<typeof getLighthouseDetectorService> extends null ? null : LighthouseDetailedResult['metrics'] | null;
  error?: { code: string; message: string } | undefined;
  warnings: MotionWarning[];
  processingTimeMs?: number | undefined;
  saveResult?: { saved: boolean } | undefined;
}

async function executeLighthouseIfEnabled(
  url: string,
  options: LighthouseOptions | undefined
): Promise<LighthouseResult> {
  if (!options?.enabled) {
    return { metrics: null, warnings: [], processingTimeMs: undefined };
  }

  const warnings: MotionWarning[] = [];
  const startTime = Date.now();
  const lighthouseService = getLighthouseDetectorService();

  if (!lighthouseService) {
    warnings.push({
      code: MOTION_WARNING_CODES.LIGHTHOUSE_UNAVAILABLE,
      severity: 'warning',
      message: 'Lighthouse detector service factory not configured',
    });
    return { metrics: null, warnings, processingTimeMs: Date.now() - startTime };
  }

  try {
    const isAvailable = await lighthouseService.isAvailable();
    if (!isAvailable) {
      warnings.push({
        code: MOTION_WARNING_CODES.LIGHTHOUSE_UNAVAILABLE,
        severity: 'warning',
        message: 'Lighthouse service is not available',
      });
      return { metrics: null, warnings, processingTimeMs: Date.now() - startTime };
    }

    const analyzeOpts: {
      categories?: string[];
      throttling?: boolean;
      timeout?: number;
    } = {
      categories: options.categories || ['performance'],
      throttling: options.throttling ?? false,
    };
    if (options.timeout !== undefined) {
      analyzeOpts.timeout = options.timeout;
    }
    const result = await lighthouseService.analyze(url, analyzeOpts);

    const returnResult: LighthouseResult = {
      metrics: result.metrics,
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
    if (options.save_to_db) {
      returnResult.saveResult = { saved: true };
    }
    return returnResult;
  } catch (err) {
    const errorObj = err as Error & { code?: string };
    const isTimeout = errorObj.message?.toLowerCase().includes('timeout') ||
      errorObj.message?.toLowerCase().includes('timed out') ||
      errorObj.code === 'TIMEOUT';

    return {
      metrics: null,
      error: {
        code: isTimeout ? 'LIGHTHOUSE_TIMEOUT' : 'LIGHTHOUSE_ERROR',
        message: err instanceof Error ? err.message : 'Lighthouse analysis failed',
      },
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// =====================================================
// Animation Metrics Helper
// =====================================================

interface AnimationMetricsResultWrapper {
  metrics: AnimationMetricsResult | null;
  error?: { code: string; message: string } | undefined;
  warnings: MotionWarning[];
  processingTimeMs?: number | undefined;
}

async function executeAnimationMetricsIfEnabled(
  enabled: boolean | undefined,
  patterns: MotionPattern[],
  lighthouseMetrics: LighthouseDetailedResult['metrics'] | null | undefined,
  options: AnalyzeMetricsOptions | undefined
): Promise<AnimationMetricsResultWrapper> {
  if (!enabled) {
    return { metrics: null, warnings: [], processingTimeMs: undefined };
  }

  const warnings: MotionWarning[] = [];
  const startTime = Date.now();
  const collector = getAnimationMetricsCollector();

  if (!collector) {
    warnings.push({
      code: MOTION_WARNING_CODES.ANIMATION_METRICS_UNAVAILABLE,
      severity: 'warning',
      message: 'Animation metrics collector factory not configured',
    });
    return { metrics: null, warnings, processingTimeMs: Date.now() - startTime };
  }

  try {
    const result = await collector.analyze({
      patterns,
      lighthouseMetrics: lighthouseMetrics ?? null,
    });

    const metrics: AnimationMetricsResult = {
      patternImpacts: result.patternImpacts.map((impact) => ({
        patternId: impact.patternId,
        patternName: impact.patternName,
        impactScore: impact.score,
        layoutImpact: Math.min(100, impact.factors.filter((f) => f.includes('layout')).length * 25),
        renderImpact: Math.min(100, impact.factors.filter((f) => f.includes('paint') || f.includes('render')).length * 25),
        cpuImpact: Math.min(100, impact.factors.filter((f) => f.includes('cpu') || f.includes('duration')).length * 25),
        severity: impact.impactLevel === 'high' ? 'critical' : impact.impactLevel,
        details: { factors: impact.factors },
      })),
      overallScore: result.overallScore,
      clsContributors: options?.include_cls_contributors !== false
        ? result.clsContributors.map((c) => ({
            selector: c.patternName,
            contribution: c.estimatedContribution,
            relatedPatternId: c.patternId,
          }))
        : [],
      layoutTriggeringProperties: result.layoutTriggeringProperties,
      recommendations: options?.include_recommendations !== false
        ? result.recommendations.map((r) => ({
            id: `rec-${r.category}-${r.priority}`,
            priority: r.priority as 'high' | 'medium' | 'low',
            category: r.category.includes('transform') || r.category.includes('layout') ? 'layout'
              : r.category.includes('paint') ? 'rendering'
              : r.category.includes('animation') || r.category.includes('duration') ? 'animation'
              : 'accessibility',
            title: r.description.split('.')[0] || r.description,
            description: r.description,
            affectedPatterns: r.affectedPatternIds,
            estimatedImpact: r.estimatedImprovement ? 0.5 : 0.3,
            effort: r.priority === 'high' ? 'low' : r.priority === 'medium' ? 'medium' : 'high',
          }))
        : [],
      lighthouseAvailable: result.lighthouseAvailable,
      analyzedAt: result.analyzedAt,
    };

    return { metrics, warnings, processingTimeMs: Date.now() - startTime };
  } catch (err) {
    const errorObj = err as Error & { code?: string };
    const isTimeout = errorObj.message?.toLowerCase().includes('timeout') ||
      errorObj.code === 'TIMEOUT';

    return {
      metrics: null,
      error: {
        code: isTimeout ? 'ANIMATION_METRICS_TIMEOUT' : 'ANIMATION_METRICS_ERROR',
        message: err instanceof Error ? err.message : 'Animation metrics analysis failed',
      },
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// =====================================================
// Frame Image Analysis Helper
// =====================================================

interface FrameAnalysisResultWrapper {
  result: FrameImageAnalysisOutput | null;
  error?: { code: string; message: string } | undefined;
  warnings: MotionWarning[];
  processingTimeMs?: number | undefined;
}

async function executeFrameImageAnalysisIfEnabled(
  enabled: boolean | undefined,
  options: FrameImageAnalysisInputOptions | undefined,
  capturedOutputDir: string | undefined,
  configuredOutputDir: string | undefined,
  capturedTotalFrames: number | undefined // キャプチャされたフレーム数（古いフレームとの混在防止）
): Promise<FrameAnalysisResultWrapper> {
  if (!enabled) {
    return { result: null, warnings: [], processingTimeMs: undefined };
  }

  const warnings: MotionWarning[] = [];
  const startTime = Date.now();
  const service = getFrameImageAnalysisService();

  if (!service) {
    warnings.push({
      code: MOTION_WARNING_CODES.FRAME_ANALYSIS_UNAVAILABLE,
      severity: 'warning',
      message: 'Frame image analysis service factory not configured',
    });
    return { result: null, warnings, processingTimeMs: Date.now() - startTime };
  }

  if (!service.isAvailable()) {
    warnings.push({
      code: MOTION_WARNING_CODES.FRAME_ANALYSIS_UNAVAILABLE,
      severity: 'warning',
      message: 'Frame image analysis service is not available',
    });
    return { result: null, warnings, processingTimeMs: Date.now() - startTime };
  }

  const frameDir = options?.frame_dir ?? capturedOutputDir ?? configuredOutputDir ?? '/tmp/reftrix-frames/';

  try {
    const result = await service.analyze(frameDir, {
      sampleInterval: options?.sample_interval ?? 10,
      diffThreshold: options?.diff_threshold ?? 0.1,
      clsThreshold: options?.cls_threshold ?? 0.05,
      motionThreshold: options?.motion_threshold ?? 50,
      outputDiffImages: options?.output_diff_images ?? false,
      parallel: options?.parallel ?? true,
      scrollPxPerFrame: 15,
      // キャプチャされたフレーム数のみを分析対象にする（exactOptionalPropertyTypes対応）
      ...(capturedTotalFrames !== undefined ? { maxFrames: capturedTotalFrames } : {}),
    });

    return { result, warnings, processingTimeMs: Date.now() - startTime };
  } catch (err) {
    const errorObj = err as Error & { code?: string };
    const isTimeout = errorObj.message?.toLowerCase().includes('timeout') ||
      errorObj.code === 'TIMEOUT';

    return {
      result: null,
      error: {
        code: isTimeout ? 'FRAME_ANALYSIS_TIMEOUT' : 'FRAME_ANALYSIS_ERROR',
        message: err instanceof Error ? err.message : 'Frame image analysis failed',
      },
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// =====================================================
// Frame Analysis DB Save Helper
// =====================================================

interface FrameAnalysisSaveResult {
  saved: boolean;
  savedCount: number;
  patternIds: string[];
  embeddingIds: string[];
  reason?: string | undefined;
  byCategory?: {
    animationZones: number;
    layoutShifts: number;
    motionVectors: number;
  } | undefined;
}

/**
 * フレーム画像分析結果をDBに保存
 *
 * FrameEmbeddingService を使用して、AnimationZone/LayoutShift/MotionVector を
 * MotionPattern として保存し、Embedding を生成します。
 *
 * @param analysisResult - フレーム画像分析結果
 * @param sourceUrl - ソースURL（任意）
 * @returns 保存結果
 */
async function executeFrameAnalysisSave(
  analysisResult: FrameImageAnalysisOutput,
  sourceUrl: string | undefined
): Promise<FrameAnalysisSaveResult> {
  const service = getFrameEmbeddingServiceInstance();

  if (!service) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] motion.detect frame embedding service not available');
    }
    return {
      saved: false,
      savedCount: 0,
      patternIds: [],
      embeddingIds: [],
      reason: 'Frame embedding service not available',
    };
  }

  if (!service.isAvailable()) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] motion.detect frame embedding service not ready');
    }
    return {
      saved: false,
      savedCount: 0,
      patternIds: [],
      embeddingIds: [],
      reason: 'Frame embedding service is not ready (check PrismaClient/EmbeddingService factories)',
    };
  }

  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.detect saving frame analysis to DB', {
      animationZones: analysisResult.animationZones.length,
      layoutShifts: analysisResult.layoutShifts.length,
      motionVectors: analysisResult.motionVectors.length,
      sourceUrl,
    });
  }

  const result = await service.saveFrameAnalysis({
    analysisResult,
    sourceUrl,
  });

  return result;
}

// =====================================================
// JS Animation Detection Helper (v0.1.0)
// =====================================================

interface JSAnimationResultWrapper {
  result: JSAnimationResult | null;
  error?: { code: string; message: string } | undefined;
  warnings: MotionWarning[];
  processingTimeMs?: number | undefined;
}

/**
 * URLからPlaywrightページを作成してJS Animation検出を実行
 *
 * runtime/hybrid/video モードで使用
 *
 * @param url - 対象URL
 * @param enabled - detect_js_animations パラメータ
 * @param options - js_animation_options パラメータ
 * @returns 検出結果ラッパー
 */
async function executeJSAnimationDetectionWithUrl(
  url: string,
  enabled: boolean | undefined,
  options: JSAnimationOptions | undefined
): Promise<JSAnimationResultWrapper> {
  if (!enabled) {
    return { result: null, warnings: [], processingTimeMs: undefined };
  }

  const warnings: MotionWarning[] = [];
  const startTime = Date.now();

  // Playwrightを動的にインポートしてブラウザを起動
  const { chromium } = await import('playwright');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.1.0',
    });

    const page = await context.newPage();

    // WebGL/3Dサイト対応: domcontentloadedで待機（loadは3Dサイトで非常に時間がかかる）
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 少し待機してアニメーションが開始されるのを待つ
    await page.waitForTimeout(500);

    // JS Animation検出を実行
    const detector = getJSAnimationDetectorService();

    const result = await detector.detect(page, {
      enableCDP: options?.enable_cdp ?? true,
      enableWebAnimations: options?.enable_web_animations ?? true,
      enableLibraryDetection: options?.enable_library_detection ?? true,
      waitTime: options?.wait_time ?? 1000,
    });

    // クリーンアップ
    await detector.cleanup();

    return {
      result,
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorObj = err as Error & { code?: string };
    const isTimeout =
      errorObj.message?.toLowerCase().includes('timeout') || errorObj.code === 'TIMEOUT';

    if (isDevelopment()) {
      logger.warn('[MCP Tool] motion.detect JS animation detection with URL failed', {
        url,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }

    return {
      result: null,
      error: {
        code: isTimeout ? 'JS_ANIMATION_TIMEOUT' : 'JS_ANIMATION_ERROR',
        message: err instanceof Error ? err.message : 'JS animation detection failed',
      },
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  } finally {
    // ブラウザリソースを確実に解放
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// =====================================================
// JS Animation DB保存 (v0.1.0)
// =====================================================

/**
 * JSアニメーション保存結果
 */
interface JSAnimationSaveResultWrapper {
  savedPatternCount: number;
  embeddingCount: number;
  error?: string | undefined;
}

/**
 * JSアニメーション検出結果をDBに保存
 *
 * JSAnimationResultをJSAnimationPatternCreateDataに変換し、
 * js_animation_patterns テーブルと js_animation_embeddings テーブルに保存する。
 * page.analyze と同じ保存ロジック（mapJSAnimationResultToPatterns + saveJSAnimationPatternsWithEmbeddings）を使用。
 *
 * @param jsAnimationResult - JSAnimationDetectorService の検出結果
 * @param webPageId - WebPage ID（保存先のページID）
 * @param sourceUrl - ソースURL
 * @returns 保存結果
 */
async function saveJSAnimationsToDb(
  jsAnimationResult: JSAnimationResult,
  webPageId: string | undefined,
  sourceUrl: string | undefined
): Promise<JSAnimationSaveResultWrapper> {
  // PrismaClientを取得
  const prisma = getJSAnimationPersistencePrismaClient();
  if (!prisma) {
    if (isDevelopment()) {
      logger.warn('[motion.detect] JS animation persistence PrismaClient not available, skipping DB save');
    }
    return { savedPatternCount: 0, embeddingCount: 0, error: 'PrismaClient not available' };
  }

  try {
    // JSAnimationResult -> JSAnimationFullResult は構造的に互換
    // （CDPAnimation extends CDPAnimationData, WebAnimation extends WebAnimationData）
    const fullResult = jsAnimationResult as unknown as JSAnimationFullResult;

    // JSAnimationFullResult -> JSAnimationPatternCreateData[] に変換
    const patterns = mapJSAnimationResultToPatterns(fullResult, webPageId, sourceUrl);

    if (patterns.length === 0) {
      if (isDevelopment()) {
        logger.debug('[motion.detect] No JS animation patterns to save');
      }
      return { savedPatternCount: 0, embeddingCount: 0 };
    }

    if (isDevelopment()) {
      logger.info('[motion.detect] Saving JS animation patterns to DB', {
        patternsCount: patterns.length,
        webPageId,
        sourceUrl,
      });
    }

    // page.analyze と同じ保存ロジックを使用（IPageAnalyzePrismaClient互換のキャスト）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saveResult = await saveJSAnimationPatternsWithEmbeddings(prisma as any, patterns, webPageId, {
      generateEmbedding: true,
    });

    if (isDevelopment()) {
      logger.info('[motion.detect] JS animation DB save completed', {
        savedPatternCount: saveResult.savedPatternCount,
        embeddingCount: saveResult.embeddingCount,
      });
    }

    return saveResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (isDevelopment()) {
      logger.error('[motion.detect] JS animation DB save error', { error: errorMessage });
    }
    return { savedPatternCount: 0, embeddingCount: 0, error: errorMessage };
  }
}

// =====================================================
// ツール定義
// =====================================================

export const motionDetectToolDefinition = {
  name: 'motion.detect',
  description:
    'Detect/classify motion patterns from web page. Parses CSS animations, transitions, keyframes. Warns about performance/accessibility issues.',
  annotations: {
    title: 'Motion Detect',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      pageId: {
        type: 'string',
        format: 'uuid',
        description: 'WebPage ID (UUID, from DB)',
      },
      html: {
        type: 'string',
        minLength: 1,
        maxLength: 10000000,
        description: 'HTML content (direct, max 10MB)',
      },
      css: {
        type: 'string',
        maxLength: 5000000,
        description: 'Additional CSS content (max 5MB)',
      },
      includeInlineStyles: {
        type: 'boolean',
        default: true,
        description: 'Parse inline styles (default: true)',
      },
      includeStyleSheets: {
        type: 'boolean',
        default: true,
        description: 'Parse stylesheets (default: true)',
      },
      minDuration: {
        type: 'number',
        minimum: 0,
        maximum: 60000,
        default: 0,
        description: 'Minimum duration to detect (ms, default: 0)',
      },
      maxPatterns: {
        type: 'number',
        minimum: 1,
        maximum: 4000,
        default: 100,
        description: 'Max patterns to detect (default: 100)',
      },
      includeWarnings: {
        type: 'boolean',
        default: true,
        description: 'Include warnings (default: true)',
      },
      min_severity: {
        type: 'string',
        enum: ['info', 'warning', 'error'],
        default: 'info',
        description: 'Minimum severity level to include in warnings (default: info)',
      },
      includeSummary: {
        type: 'boolean',
        default: true,
        description: 'Include summary (default: true)',
      },
      verbose: {
        type: 'boolean',
        default: false,
        description: 'Verbose mode: include rawCss (default: false)',
      },
      fetchExternalCss: {
        type: 'boolean',
        default: true,
        description: 'Fetch external CSS from <link> tags (default: true)',
      },
      baseUrl: {
        type: 'string',
        format: 'uri',
        description: 'Base URL for resolving relative CSS paths (required if fetchExternalCss is true)',
      },
      externalCssOptions: {
        type: 'object',
        description: 'Options for external CSS fetching',
        properties: {
          timeout: {
            type: 'number',
            minimum: 1000,
            maximum: 30000,
            default: 5000,
            description: 'Fetch timeout in ms (default: 5000)',
          },
          maxConcurrent: {
            type: 'number',
            minimum: 1,
            maximum: 10,
            default: 5,
            description: 'Max concurrent fetches (default: 5)',
          },
        },
      },
      save_to_db: {
        type: 'boolean',
        default: true,
        description: 'Save detected patterns to motion_patterns table with embeddings (default: true)',
      },
      detection_mode: {
        type: 'string',
        enum: ['css', 'video', 'runtime', 'hybrid'],
        default: 'video',
        description:
          "Detection mode: 'css' (requires html/pageId) for static CSS parsing without browser, 'video' (default, requires url) for visual motion detection with frame capture, 'runtime' (requires url) for JS-driven animations, 'hybrid' (requires url) for CSS+runtime combined.",
      },
      url: {
        type: 'string',
        format: 'uri',
        description:
          "Target URL for video/runtime/hybrid modes. Required when detection_mode='video', 'runtime', or 'hybrid'.",
      },
      detect_js_animations: {
        type: 'boolean',
        default: false,
        description:
          'Enable JavaScript animation detection via CDP + Web Animations API. Requires Playwright. Default: false (disabled for performance).',
      },
      timeout: {
        type: 'integer',
        minimum: 30000,
        maximum: 600000,
        default: 180000,
        description:
          'Overall timeout in milliseconds (30000-600000, default: 180000 = 3 minutes). On timeout, returns partial results with warnings (graceful degradation).',
      },
    },
    required: ['html'],
  },
};

// =====================================================
// handleMotionDetect エイリアス (v0.1.0)
// テストとの互換性のため motionDetectHandler のエイリアスをエクスポート
// =====================================================

/**
 * motion.detect ツールハンドラーのエイリアス
 * テストとの互換性のために提供
 */
export const handleMotionDetect = motionDetectHandler;
