// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Handler for page.analyze
 * Video Mode（Frame Capture + Frame Analysis）ロジックを分離
 *
 * analyze.tool.tsから抽出した単一責任モジュール
 * - Frame Capture実行（executeFrameCapture呼び出し）
 * - Frame Image Analysis実行（frameAnalysisService.analyze呼び出し）
 * - 結果のMotionServiceResult形式への変換
 *
 * @module tools/page/handlers/video-handler
 */

import { logger, isDevelopment } from '../../../utils/logger';
import {
  executeFrameCapture,
  getFrameImageAnalysisService,
} from '../../motion/detect.tool';
import type {
  FrameCaptureOptions,
  FrameAnalysisOptions,
  VideoModeOptions,
  FrameCaptureResult,
  FrameAnalysisResult,
  VideoModeResult,
} from './types';

// Re-export types for backward compatibility
export type {
  FrameCaptureOptions,
  FrameAnalysisOptions,
  VideoModeOptions,
  FrameCaptureResult,
  FrameAnalysisResult,
  VideoModeResult,
};

// =====================================================
// デフォルト値
// =====================================================

/** Frame Captureデフォルト設定 */
const FRAME_CAPTURE_DEFAULTS = {
  SCROLL_PX_PER_FRAME: 15, // Reftrix standard
  FRAME_INTERVAL_MS: 33, // 30fps equivalent
  OUTPUT_DIR: '/tmp/reftrix-frames/',
  OUTPUT_FORMAT: 'png' as const,
  FILENAME_PATTERN: 'frame-{0000}.png',
} as const;

/** Frame Analysisデフォルト設定 */
const FRAME_ANALYSIS_DEFAULTS = {
  SAMPLE_INTERVAL: 1, // 全フレーム分析
  DIFF_THRESHOLD: 0.01, // 1%差分検出
  CLS_THRESHOLD: 0.1, // WCAG推奨値
  MOTION_THRESHOLD: 5, // 敏感な検出
  OUTPUT_DIFF_IMAGES: false,
  PARALLEL: true,
  SCROLL_PX_PER_FRAME: 15, // Reftrix default
} as const;

// =====================================================
// メイン処理関数
// =====================================================

/**
 * Video Mode（Frame Capture + Frame Analysis）を実行
 *
 * @param url - 対象URL
 * @param options - Video Modeオプション
 * @returns Video Mode実行結果
 */
export async function executeVideoMode(
  url: string,
  options?: VideoModeOptions
): Promise<VideoModeResult> {
  const result: VideoModeResult = {};

  // enable_frame_capture がundefinedの場合はfalseとして扱う（CSS静的解析優先）
  // Video Modeはタイムアウトしやすいため、明示的に有効化した場合のみ実行
  const enableFrameCapture = options?.enable_frame_capture ?? false;

  if (!enableFrameCapture) {
    if (isDevelopment()) {
      logger.info('[video-handler] Frame capture disabled, skipping video mode');
    }
    return result;
  }

  if (isDevelopment()) {
    logger.info('[video-handler] Starting frame capture (video mode)', {
      url,
      options: options?.frame_capture_options,
    });
  }

  try {
    // Frame Capture実行
    const captureResult = await executeFrameCaptureWithDefaults(url, options?.frame_capture_options);
    result.frame_capture = captureResult;

    if (isDevelopment()) {
      logger.info('[video-handler] Frame capture completed', {
        total_frames: captureResult.total_frames,
        duration_ms: captureResult.duration_ms,
        output_dir: captureResult.output_dir,
      });
    }

    // Frame Image Analysis実行（analyze_frames がundefinedの場合はtrueとして扱う）
    const analyzeFrames = options?.analyze_frames ?? true;
    if (analyzeFrames) {
      const analysisResult = await executeFrameAnalysis(
        captureResult.output_dir,
        options?.frame_analysis_options,
        captureResult.total_frames // キャプチャされたフレーム数を渡す
      );

      if (analysisResult.frame_analysis) {
        result.frame_analysis = analysisResult.frame_analysis;
      }
      if (analysisResult.frame_analysis_error) {
        result.frame_analysis_error = analysisResult.frame_analysis_error;
      }
    }
  } catch (frameCaptureErr) {
    if (isDevelopment()) {
      logger.error('[video-handler] Frame capture failed', { error: frameCaptureErr });
    }
    result.frame_capture_error = {
      code: 'FRAME_CAPTURE_ERROR',
      message: frameCaptureErr instanceof Error ? frameCaptureErr.message : 'Frame capture failed',
    };
  }

  return result;
}

// =====================================================
// 内部ヘルパー関数
// =====================================================

/**
 * Frame Captureをデフォルト値で実行
 */
async function executeFrameCaptureWithDefaults(
  url: string,
  options?: FrameCaptureOptions
): Promise<FrameCaptureResult> {
  const captureResult = await executeFrameCapture(url, {
    scroll_px_per_frame: options?.scroll_px_per_frame ?? FRAME_CAPTURE_DEFAULTS.SCROLL_PX_PER_FRAME,
    frame_interval_ms: options?.frame_interval_ms ?? FRAME_CAPTURE_DEFAULTS.FRAME_INTERVAL_MS,
    output_dir: options?.output_dir ?? FRAME_CAPTURE_DEFAULTS.OUTPUT_DIR,
    output_format: options?.output_format ?? FRAME_CAPTURE_DEFAULTS.OUTPUT_FORMAT,
    filename_pattern: options?.filename_pattern ?? FRAME_CAPTURE_DEFAULTS.FILENAME_PATTERN,
  });

  // FrameCaptureServiceResultをFrameCaptureResult形式に変換
  return {
    total_frames: captureResult.total_frames,
    output_dir: captureResult.output_dir,
    config: {
      scroll_px_per_frame: captureResult.config.scroll_px_per_frame,
      frame_interval_ms: captureResult.config.frame_interval_ms,
      output_format: captureResult.config.output_format,
      output_dir: captureResult.config.output_dir,
      filename_pattern: captureResult.config.filename_pattern,
    },
    files: captureResult.files.map((f) => ({
      frame_number: f.frame_number,
      scroll_position_px: f.scroll_position_px,
      timestamp_ms: f.timestamp_ms,
      file_path: f.file_path,
    })),
    duration_ms: captureResult.duration_ms,
  };
}

/**
 * Frame Image Analysisを実行
 */
async function executeFrameAnalysis(
  frameDir: string,
  options?: FrameAnalysisOptions,
  capturedTotalFrames?: number // キャプチャされたフレーム数（古いフレームとの混在防止）
): Promise<{ frame_analysis?: FrameAnalysisResult; frame_analysis_error?: { code: string; message: string } }> {
  const frameAnalysisStartTime = Date.now();
  const frameAnalysisService = getFrameImageAnalysisService();

  if (!frameAnalysisService) {
    if (isDevelopment()) {
      logger.warn('[video-handler] Frame image analysis service not configured');
    }
    return {
      frame_analysis_error: {
        code: 'FRAME_ANALYSIS_UNAVAILABLE',
        message: 'Frame image analysis service factory not configured',
      },
    };
  }

  try {
    if (!frameAnalysisService.isAvailable()) {
      if (isDevelopment()) {
        logger.warn('[video-handler] Frame image analysis service not available');
      }
      return {
        frame_analysis_error: {
          code: 'FRAME_ANALYSIS_UNAVAILABLE',
          message: 'Frame image analysis service is not available',
        },
      };
    }

    // フレーム分析オプションを構築
    const analysisResult = await frameAnalysisService.analyze(frameDir, {
      sampleInterval: options?.sample_interval ?? FRAME_ANALYSIS_DEFAULTS.SAMPLE_INTERVAL,
      diffThreshold: options?.diff_threshold ?? FRAME_ANALYSIS_DEFAULTS.DIFF_THRESHOLD,
      clsThreshold: options?.cls_threshold ?? FRAME_ANALYSIS_DEFAULTS.CLS_THRESHOLD,
      motionThreshold: options?.motion_threshold ?? FRAME_ANALYSIS_DEFAULTS.MOTION_THRESHOLD,
      outputDiffImages: options?.output_diff_images ?? FRAME_ANALYSIS_DEFAULTS.OUTPUT_DIFF_IMAGES,
      parallel: options?.parallel ?? FRAME_ANALYSIS_DEFAULTS.PARALLEL,
      scrollPxPerFrame: FRAME_ANALYSIS_DEFAULTS.SCROLL_PX_PER_FRAME,
      // キャプチャされたフレーム数のみを分析対象にする（exactOptionalPropertyTypes対応）
      ...(capturedTotalFrames !== undefined ? { maxFrames: capturedTotalFrames } : {}),
    });

    // FrameImageAnalysisOutputをFrameAnalysisResult形式に変換
    const avgDiffValue = parseFloat(analysisResult.statistics.averageDiffPercentage.replace('%', '')) / 100;
    const totalLayoutShiftScore = analysisResult.layoutShifts.reduce((sum, ls) => {
      return sum + parseFloat(ls.impactFraction);
    }, 0);

    const frameAnalysis: FrameAnalysisResult = {
      timeline: analysisResult.animationZones.map((zone, index) => {
        const motionVectors = analysisResult.motionVectors
          .filter((mv) => mv.frameRange.includes(zone.frameStart))
          .map((mv) => ({
            x: mv.dx,
            y: mv.dy,
            magnitude: parseFloat(mv.magnitude),
          }));
        return {
          frame_index: parseInt(zone.frameStart.replace('frame-', '').replace('.png', ''), 10) || index,
          diff_percentage: parseFloat(zone.avgDiff.replace('%', '')) / 100,
          // motion_vectors は存在する場合のみ含める
          ...(motionVectors.length > 0 ? { motion_vectors: motionVectors } : {}),
        };
      }),
      summary: {
        max_diff:
          parseFloat(
            analysisResult.animationZones
              .reduce((max, z) => {
                const peakVal = parseFloat(z.peakDiff.replace('%', ''));
                return peakVal > parseFloat(max) ? z.peakDiff : max;
              }, '0%')
              .replace('%', '')
          ) / 100,
        avg_diff: avgDiffValue,
        total_layout_shifts: analysisResult.statistics.layoutShiftCount,
        cls_score: totalLayoutShiftScore,
        significant_change_frames: analysisResult.animationZones.map(
          (z) => parseInt(z.frameStart.replace('frame-', '').replace('.png', ''), 10) || 0
        ),
        processing_time_ms: Date.now() - frameAnalysisStartTime,
      },
    };

    if (isDevelopment()) {
      logger.info('[video-handler] Frame image analysis completed', {
        totalFrames: analysisResult.metadata.totalFrames,
        analyzedPairs: analysisResult.metadata.analyzedPairs,
        layoutShiftCount: analysisResult.statistics.layoutShiftCount,
        animationZones: analysisResult.animationZones.length,
      });
    }

    return { frame_analysis: frameAnalysis };
  } catch (frameAnalysisErr) {
    if (isDevelopment()) {
      logger.error('[video-handler] Frame image analysis failed', { error: frameAnalysisErr });
    }
    return {
      frame_analysis_error: {
        code: 'FRAME_ANALYSIS_ERROR',
        message: frameAnalysisErr instanceof Error ? frameAnalysisErr.message : 'Frame analysis failed',
      },
    };
  }
}
