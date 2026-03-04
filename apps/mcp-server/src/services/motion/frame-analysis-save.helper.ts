// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Analysis DB Save Helper
 *
 * MotionServiceResultのframe_analysis結果をFrameImageAnalysisOutput形式に変換し、
 * MotionDbServiceでDB保存するヘルパー関数。
 * 同期モード（analyze.tool.ts）と非同期モード（page-analyze-worker.ts）の両方から呼ばれる。
 *
 * @module @reftrix/mcp-server/services/motion/frame-analysis-save.helper
 */

import { logger, isDevelopment } from '../../utils/logger';
import { getMotionDbService, type BatchSaveResult } from './motion-db.service';
import type { FrameAnalysisResult, FrameCaptureResult } from '../../tools/page/handlers/types';
import type { AnimationType, MotionDirection } from './frame-image-analyzer.adapter';

// =====================================================
// Types
// =====================================================

/**
 * Frame analysis DB保存に必要な入力データ
 */
export interface FrameAnalysisSaveInput {
  /** MotionServiceResult.frame_analysis */
  frameAnalysis: FrameAnalysisResult;
  /** MotionServiceResult.frame_capture（metadata用、optional） */
  frameCapture?: FrameCaptureResult | undefined;
  /** 保存先 web_page ID */
  webPageId: string;
  /** 元URL */
  sourceUrl: string;
}

/**
 * Frame analysis DB保存結果
 */
export interface FrameAnalysisSaveResult {
  /** 保存が成功したか */
  saved: boolean;
  /** BatchSaveResult（成功時） */
  batchResult?: BatchSaveResult;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** スキップ理由（MotionDbService利用不可時等） */
  skipped?: string;
}

// =====================================================
// Constants
// =====================================================

/** Reftrix default scroll pixels per frame */
const SCROLL_PX_PER_FRAME = 15;

/** Layout shift score threshold (Core Web Vitals) */
const LAYOUT_SHIFT_THRESHOLD = 0.05;

/** Minimum magnitude to determine motion vector direction */
const MOTION_VECTOR_MIN_MAGNITUDE = 5;

/** Max frames gap to consider as continuous zone */
const CONTINUOUS_ZONE_GAP = 5;

// =====================================================
// Internal helpers
// =====================================================

/**
 * Classify animation type based on scroll duration (px)
 */
function classifyAnimationType(duration: number): AnimationType {
  if (duration < 500) return 'micro-interaction';
  if (duration < 1500) return 'fade/slide transition';
  if (duration < 3000) return 'scroll-linked animation';
  return 'long-form reveal';
}

/**
 * Determine motion direction from angle
 */
function determineDirection(angle: number, magnitude: number): MotionDirection {
  if (magnitude < MOTION_VECTOR_MIN_MAGNITUDE) return 'stationary';
  if (angle >= -45 && angle < 45) return 'right';
  if (angle >= 45 && angle < 135) return 'down';
  if (angle >= -135 && angle < -45) return 'up';
  return 'left';
}

/**
 * Format frame index as zero-padded filename
 */
function frameFileName(index: number): string {
  return `frame-${String(index).padStart(4, '0')}.png`;
}

// =====================================================
// Build FrameImageAnalysisOutput from MotionServiceResult data
// =====================================================

interface AnimationZoneData {
  frameStart: string;
  frameEnd: string;
  scrollStart: number;
  scrollEnd: number;
  duration: number;
  avgDiff: string;
  peakDiff: string;
  animationType: AnimationType;
}

interface LayoutShiftData {
  frameRange: string;
  scrollRange: string;
  impactFraction: string;
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface MotionVectorData {
  frameRange: string;
  dx: number;
  dy: number;
  magnitude: string;
  direction: MotionDirection;
  angle: string;
}

/**
 * timeline の significant_change_frames から AnimationZones を構築
 */
function buildAnimationZones(
  frameAnalysis: FrameAnalysisResult
): AnimationZoneData[] {
  const zones: AnimationZoneData[] = [];
  const significantFrames = frameAnalysis.summary?.significant_change_frames ?? [];

  if (significantFrames.length === 0) return zones;

  let zoneStart = significantFrames[0] ?? 0;
  let zoneEnd = zoneStart;
  const diffs: number[] = [];

  for (let i = 0; i < significantFrames.length; i++) {
    const currentFrame = significantFrames[i] ?? 0;
    const nextFrame = significantFrames[i + 1];

    const timelineEntry = frameAnalysis.timeline.find(t => t.frame_index === currentFrame);
    if (timelineEntry) {
      diffs.push(timelineEntry.diff_percentage * 100);
    }

    if (nextFrame !== undefined && nextFrame - currentFrame <= CONTINUOUS_ZONE_GAP) {
      zoneEnd = nextFrame;
    } else {
      if (diffs.length > 0) {
        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const peakDiff = Math.max(...diffs);
        const duration = (zoneEnd - zoneStart) * SCROLL_PX_PER_FRAME;

        zones.push({
          frameStart: frameFileName(zoneStart),
          frameEnd: frameFileName(zoneEnd),
          scrollStart: zoneStart * SCROLL_PX_PER_FRAME,
          scrollEnd: zoneEnd * SCROLL_PX_PER_FRAME,
          duration,
          avgDiff: avgDiff.toFixed(2),
          peakDiff: peakDiff.toFixed(2),
          animationType: classifyAnimationType(duration),
        });
      }

      if (nextFrame !== undefined) {
        zoneStart = nextFrame;
        zoneEnd = nextFrame;
        diffs.length = 0;
      }
    }
  }

  return zones;
}

/**
 * timeline から layoutShifts を構築（layout_shift_score > threshold）
 */
function buildLayoutShifts(
  frameAnalysis: FrameAnalysisResult
): LayoutShiftData[] {
  const shifts: LayoutShiftData[] = [];

  for (const entry of frameAnalysis.timeline) {
    const shiftScore = entry.layout_shift_score;
    if (shiftScore !== undefined && shiftScore > LAYOUT_SHIFT_THRESHOLD) {
      shifts.push({
        frameRange: frameFileName(entry.frame_index),
        scrollRange: `${entry.frame_index * SCROLL_PX_PER_FRAME}px`,
        impactFraction: shiftScore.toFixed(4),
        boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      });
    }
  }

  return shifts;
}

/**
 * timeline の motion_vectors から MotionVectors を構築
 */
function buildMotionVectors(
  frameAnalysis: FrameAnalysisResult
): MotionVectorData[] {
  const vectors: MotionVectorData[] = [];

  for (const entry of frameAnalysis.timeline) {
    const entryVectors = entry.motion_vectors;
    if (entryVectors && entryVectors.length > 0) {
      for (const vector of entryVectors) {
        const angle = Math.atan2(vector.y, vector.x) * (180 / Math.PI);

        vectors.push({
          frameRange: frameFileName(entry.frame_index),
          dx: vector.x,
          dy: vector.y,
          magnitude: vector.magnitude.toFixed(2),
          direction: determineDirection(angle, vector.magnitude),
          angle: angle.toFixed(2),
        });
      }
    }
  }

  return vectors;
}

// =====================================================
// Main helper function
// =====================================================

/**
 * Frame analysis結果をDB保存する共有ヘルパー
 *
 * MotionServiceResult.frame_analysis から FrameImageAnalysisOutput 形式を構築し、
 * MotionDbService.saveFrameAnalysis() でDB保存する。
 *
 * 同期モード（analyze.tool.ts）と非同期モード（page-analyze-worker.ts）の両方から呼ばれる。
 *
 * @param input - Frame analysis保存入力データ
 * @returns 保存結果
 */
export async function saveFrameAnalysisToDb(
  input: FrameAnalysisSaveInput
): Promise<FrameAnalysisSaveResult> {
  const { frameAnalysis, frameCapture, webPageId, sourceUrl } = input;

  if (isDevelopment()) {
    logger.info('[FrameAnalysisSaveHelper] Starting frame analysis DB save', {
      webPageId,
      timelineLength: frameAnalysis.timeline?.length ?? 0,
      totalLayoutShifts: frameAnalysis.summary?.total_layout_shifts ?? 0,
    });
  }

  try {
    const motionDbService = getMotionDbService();

    if (!motionDbService.isAvailable()) {
      if (isDevelopment()) {
        logger.warn('[FrameAnalysisSaveHelper] MotionDbService not available, skipping frame analysis DB save');
      }
      return { saved: false, skipped: 'MotionDbService not available' };
    }

    // Build sub-structures
    const animationZones = buildAnimationZones(frameAnalysis);
    const layoutShifts = buildLayoutShifts(frameAnalysis);
    const motionVectors = buildMotionVectors(frameAnalysis);
    const significantFrames = frameAnalysis.summary?.significant_change_frames ?? [];

    // Build FrameImageAnalysisOutput
    const frameAnalysisOutput = {
      metadata: {
        framesDir: frameCapture?.output_dir ?? '/tmp/reftrix-frames/',
        totalFrames: frameCapture?.total_frames ?? 0,
        analyzedPairs: frameAnalysis.timeline.length,
        sampleInterval: 1,
        scrollPxPerFrame: SCROLL_PX_PER_FRAME,
        analysisTime: `${(frameAnalysis.summary?.processing_time_ms ?? 0) / 1000}s`,
        analyzedAt: new Date().toISOString(),
      },
      statistics: {
        averageDiffPercentage: ((frameAnalysis.summary?.avg_diff ?? 0) * 100).toFixed(2),
        significantChangeCount: significantFrames.length,
        significantChangePercentage: frameAnalysis.timeline.length > 0
          ? ((significantFrames.length / frameAnalysis.timeline.length) * 100).toFixed(2)
          : '0.00',
        layoutShiftCount: frameAnalysis.summary?.total_layout_shifts ?? 0,
        motionVectorCount: motionVectors.length,
      },
      animationZones,
      layoutShifts,
      motionVectors,
    };

    // Save via MotionDbService
    const batchResult = await motionDbService.saveFrameAnalysis(
      frameAnalysisOutput,
      {
        webPageId,
        sourceUrl,
        continueOnError: true,
      }
    );

    if (isDevelopment()) {
      logger.info('[FrameAnalysisSaveHelper] Frame analysis DB save completed', {
        saved: batchResult.saved,
        savedCount: batchResult.savedCount,
        byCategory: batchResult.byCategory,
        reason: batchResult.reason,
      });
    }

    return { saved: batchResult.saved, batchResult };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isDevelopment()) {
      logger.warn('[FrameAnalysisSaveHelper] Frame analysis DB save failed (graceful degradation)', {
        error: errorMessage,
      });
    }

    return { saved: false, error: errorMessage };
  }
}
