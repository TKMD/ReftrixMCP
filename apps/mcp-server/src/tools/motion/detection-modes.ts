// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect 検出モード実行モジュール
 *
 * Video Mode, Runtime Mode, Hybrid Modeの検出実行ロジックを集約。
 * 各モードはPlaywrightを使用してブラウザを起動し、検出を実行する。
 *
 * @module tools/motion/detection-modes
 */

import type { Browser, Page } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';
import { validateExternalUrl } from '../../utils/url-validator';
import type {
  MotionPattern,
  MotionWarning,
  VideoInfo,
  MotionDetectInput,
} from './schemas';
import { MOTION_WARNING_CODES } from './schemas';
import type {
  FrameCaptureServiceOptions,
  FrameCaptureServiceResult,
} from '../../services/motion/frame-capture.service';
import type {
  RecordOptions,
  RecordResult,
} from '../../services/page/video-recorder.service';
import type {
  ExtractOptions,
  AnalyzeOptions,
  ExtractResult,
  AnalyzeResult,
} from '../../services/page/frame-analyzer.service';
import type { RuntimeAnimationOptions } from '../../services/page/runtime-animation-detector.service';
import {
  getVideoRecorderService,
  getFrameAnalyzerService,
  getRuntimeAnimationDetectorService,
  getFrameCaptureServiceInstance,
} from './di-factories';
import type { RuntimeInfo, DetectOptions } from './di-factories';
import {
  convertMotionSegmentToPattern,
  convertRuntimeResultToDetectionResult,
  adaptServiceResult,
} from './pattern-converter';
import { getMotionDetectorService } from '../../services/page/motion-detector.service';

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
 * 動画録画エラー
 */
export class VideoRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoRecordError';
  }
}

/**
 * フレーム解析エラー
 */
export class FrameAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameAnalysisError';
  }
}

// =====================================================
// Video Mode Detection
// =====================================================

/**
 * Video録画とフレーム解析を実行
 */
export async function executeVideoDetection(
  url: string,
  videoOptions: MotionDetectInput['video_options']
): Promise<{
  videoInfo: VideoInfo;
  patterns: MotionPattern[];
  warnings: MotionWarning[];
}> {
  const videoStartTime = Date.now();
  const warnings: MotionWarning[] = [];

  // SSRF検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    throw new SSRFBlockedError(urlValidation.error ?? 'URL is blocked for security reasons');
  }

  // サービスを取得
  const videoRecorder = getVideoRecorderService();
  const frameAnalyzer = getFrameAnalyzerService();

  // 録画オプションを構築
  const recordOptions: RecordOptions = {
    timeout: videoOptions?.timeout ?? 30000,
    viewport: videoOptions?.viewport ?? { width: 1280, height: 720 },
    recordDuration: videoOptions?.record_duration ?? 5000,
    scrollPage: videoOptions?.scroll_page ?? true,
    moveMouseRandomly: videoOptions?.move_mouse ?? true,
    // WebGL/3Dサイト対応: domcontentloadedをデフォルトに（loadは3Dサイトで非常に時間がかかる）
    waitUntil: videoOptions?.wait_until ?? 'domcontentloaded',
  };

  // 解析オプション
  const analyzeOptions: AnalyzeOptions = {
    changeThreshold: videoOptions?.frame_analysis?.change_threshold ?? 0.01,
    minMotionDurationMs: videoOptions?.frame_analysis?.min_motion_duration_ms ?? 100,
    gapToleranceMs: videoOptions?.frame_analysis?.gap_tolerance_ms ?? 50,
  };

  // フレーム抽出オプション
  const extractOptions: ExtractOptions = {
    fps: videoOptions?.frame_analysis?.fps ?? 10,
  };

  let recordResult: RecordResult;
  let extractResult: ExtractResult;
  let analyzeResult: AnalyzeResult;

  try {
    // 1. 動画を録画
    if (isDevelopment()) {
      logger.info('[motion.detect] Starting video recording', { url, options: recordOptions });
    }

    recordResult = await videoRecorder.record(url, recordOptions);

    if (isDevelopment()) {
      logger.info('[motion.detect] Video recording completed', {
        videoPath: recordResult.videoPath,
        sizeBytes: recordResult.sizeBytes,
        durationMs: recordResult.durationMs,
      });
    }
  } catch (error) {
    throw new VideoRecordError(
      `Video recording failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  try {
    // 2. フレーム抽出
    if (isDevelopment()) {
      logger.info('[motion.detect] Starting frame extraction', { options: extractOptions });
    }

    extractResult = await frameAnalyzer.extractFrames(recordResult.videoPath, extractOptions);

    if (isDevelopment()) {
      logger.info('[motion.detect] Frame extraction completed', {
        totalFrames: extractResult.totalFrames,
        fps: extractResult.fps,
      });
    }

    // 3. モーション解析
    if (isDevelopment()) {
      logger.info('[motion.detect] Starting motion analysis', { options: analyzeOptions });
    }

    analyzeResult = await frameAnalyzer.analyzeMotion(extractResult, analyzeOptions);

    if (isDevelopment()) {
      logger.info('[motion.detect] Motion analysis completed', {
        totalFrames: analyzeResult.totalFrames,
        motionSegments: analyzeResult.motionSegments.length,
        motionCoverage: analyzeResult.motionCoverage,
      });
    }

    // フレーム一時ファイルをクリーンアップ
    await frameAnalyzer.cleanup(extractResult).catch(() => {});
  } catch (error) {
    // フレーム解析エラーでも録画ファイルをクリーンアップ
    await videoRecorder.cleanup(recordResult.videoPath).catch(() => {});
    throw new FrameAnalysisError(
      `Frame analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // 4. MotionSegmentsをMotionPatternsに変換
  const patterns = analyzeResult.motionSegments.map((segment, index) =>
    convertMotionSegmentToPattern(segment, index)
  );

  // 5. 警告を生成
  if (patterns.length === 0) {
    warnings.push({
      code: MOTION_WARNING_CODES.A11Y_INFINITE_ANIMATION,
      severity: 'info',
      message: 'No motion detected in the recorded video. The page may be static or use JavaScript-only animations.',
      context: { url, durationMs: recordResult.durationMs },
    });
  }

  // 6. 一時ファイルをクリーンアップ
  await videoRecorder.cleanup(recordResult.videoPath).catch(() => {});

  const processingTimeMs = Date.now() - videoStartTime;

  const videoInfo: VideoInfo = {
    recorded_url: url,
    record_duration_ms: recordResult.durationMs,
    video_size_bytes: recordResult.sizeBytes,
    frames_analyzed: analyzeResult.totalFrames,
    motion_segments_detected: analyzeResult.motionSegments.length,
    processing_time_ms: processingTimeMs,
    viewport: recordOptions.viewport,
    page_title: recordResult.title,
    motion_coverage: analyzeResult.motionCoverage,
  };

  return { videoInfo, patterns, warnings };
}

// =====================================================
// Frame Capture Execution
// =====================================================

/**
 * フレームキャプチャを実行
 *
 * v0.1.0改善:
 * - networkidleが遅いサイト対策: loadにフォールバック
 * - ブラウザ起動タイムアウト: 30秒
 * - ページ遷移タイムアウト: 30秒（再試行あり）
 * - フレームキャプチャタイムアウト: 90秒（FrameCaptureService内で制御）
 * - 最大フレーム数: 1000
 * - 最大ページ高さ: 50000px
 */
export async function executeFrameCapture(
  url: string,
  options: {
    scroll_px_per_frame?: number;
    frame_interval_ms?: number;
    output_dir?: string;
    output_format?: 'png' | 'jpeg';
    filename_pattern?: string;
    viewport?: { width: number; height: number };
    max_frames?: number;
    max_page_height?: number;
    timeout_ms?: number;
  }
): Promise<FrameCaptureServiceResult> {
  // SSRF検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    throw new SSRFBlockedError(urlValidation.error ?? 'URL is blocked for security reasons');
  }

  const { chromium } = await import('playwright');

  let browser: Browser | null = null;

  try {
    // ブラウザ起動（タイムアウト30秒）
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 30000,
    });

    const viewport = options.viewport ?? { width: 1440, height: 900 };
    const context = await browser.newContext({
      viewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Reftrix/0.1.0',
    });

    const page = await context.newPage();

    // v0.1.0改善: domcontentloadedを先に試し、成功後に短時間でloadを試行
    // WebGL/3Dサイトではloadが非常に時間がかかるため、domcontentloadedをデフォルトに
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // loadが成功したら、追加で短時間networkidleを待つ（失敗しても続行）
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // networkidleタイムアウトは無視（遅いサイトでは発生しやすい）
        if (isDevelopment()) {
          logger.debug('[motion.detect] networkidle timeout, continuing with load state');
        }
      }
    } catch (loadError) {
      // loadも失敗した場合は再試行
      if (isDevelopment()) {
        logger.warn('[motion.detect] Initial page load failed, retrying with domcontentloaded', {
          error: loadError instanceof Error ? loadError.message : 'Unknown',
        });
      }
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    }

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    if (isDevelopment()) {
      logger.info('[motion.detect] Page loaded, starting frame capture');
    }

    const captureService = getFrameCaptureServiceInstance();

    const captureOptions: FrameCaptureServiceOptions = {
      scroll_px_per_frame: options.scroll_px_per_frame ?? 15,
      frame_interval_ms: options.frame_interval_ms ?? 33,
      output_dir: options.output_dir ?? '/tmp/reftrix-frames/',
      output_format: options.output_format ?? 'png',
      filename_pattern: options.filename_pattern ?? 'frame-{0000}.png',
      // v0.1.0: 制限オプションを追加
      max_frames: options.max_frames ?? 1000,
      max_page_height: options.max_page_height ?? 50000,
      timeout_ms: options.timeout_ms ?? 90000,
    };

    if (isDevelopment()) {
      logger.info('[motion.detect] Starting frame capture:', {
        url,
        scroll_px_per_frame: captureOptions.scroll_px_per_frame,
        output_dir: captureOptions.output_dir,
        max_frames: captureOptions.max_frames,
        max_page_height: captureOptions.max_page_height,
        timeout_ms: captureOptions.timeout_ms,
      });
    }

    const result = await captureService.capture(page, captureOptions);

    if (isDevelopment()) {
      logger.info('[motion.detect] Frame capture complete:', {
        total_frames: result.total_frames,
        duration_ms: result.duration_ms,
        truncated: result.truncated,
        truncation_reason: result.truncation_reason,
      });
    }

    return result;
  } finally {
    // ブラウザリソースを確実に解放（エラーを抑制）
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// =====================================================
// Runtime Mode Detection
// =====================================================

/**
 * Runtime検出を実行するためのPlaywrightセットアップと実行
 */
export async function executeRuntimeDetection(
  url: string,
  runtimeOptions: MotionDetectInput['runtime_options']
): Promise<{
  patterns: MotionPattern[];
  warnings: MotionWarning[];
  runtime_info: RuntimeInfo;
}> {
  // SSRF検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    throw new SSRFBlockedError(urlValidation.error ?? 'URL is blocked for security reasons');
  }

  const { chromium } = await import('playwright');

  let browser = null;
  let page: Page | null = null;

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

    page = await context.newPage();

    // WebGL/3Dサイト対応: domcontentloadedで待機（loadは3Dサイトで非常に時間がかかる）
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // RuntimeAnimationDetectorServiceを使用
    const detectorService = getRuntimeAnimationDetectorService();

    const detectOptions: RuntimeAnimationOptions = {
      wait_for_animations: runtimeOptions?.wait_for_animations ?? 3000,
      scroll_positions: runtimeOptions?.scroll_positions ?? [0, 50, 100],
    };

    const runtimeResult = await detectorService.detect(page, detectOptions);
    const converted = convertRuntimeResultToDetectionResult(runtimeResult);

    if (isDevelopment()) {
      logger.info('[motion.detect] Runtime detection completed', {
        animationsDetected: runtimeResult.animations.length,
        intersectionObservers: runtimeResult.intersectionObservers.length,
        rafCallbacks: runtimeResult.rafCallbacks.length,
        detectionTimeMs: runtimeResult.detectionTimeMs,
      });
    }

    return {
      patterns: converted.patterns,
      warnings: converted.warnings,
      runtime_info: converted.runtime_info as RuntimeInfo,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// =====================================================
// CSS Mode Detection (Default)
// =====================================================

/**
 * デフォルトのモーション検出実装
 */
export function defaultDetect(
  html: string,
  css: string | undefined,
  options: DetectOptions
): {
  patterns: MotionPattern[];
  warnings: MotionWarning[];
  summary?: Record<string, unknown>;
  runtime_info?: RuntimeInfo;
} {
  const service = getMotionDetectorService();
  const serviceResult = service.detect(
    html,
    {
      includeInlineStyles: options.includeInlineStyles,
      includeStyleSheets: options.includeStyleSheets,
      minDuration: options.minDuration,
      maxPatterns: options.maxPatterns,
      verbose: options.verbose,
    },
    css
  );

  return adaptServiceResult(serviceResult);
}
