// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CLS Calculator Service
 *
 * Cumulative Layout Shift (CLS) 計算サービス
 * Core Web Vitals準拠のCLS計算を提供
 *
 * CLS計算仕様:
 * - impact_fraction: ビューポートに対する変化領域の割合
 * - distance_fraction: ビューポートの最大次元に対する移動距離の割合
 * - layout_shift_score = impact_fraction * distance_fraction
 *
 * 分類閾値（Core Web Vitals）:
 * - good: < 0.1
 * - needs-improvement: >= 0.1 && < 0.25
 * - poor: >= 0.25
 *
 * @module @reftrix/mcp-server/services/motion/cls-calculator
 */

import type { FrameDiffResult, BoundingBox, ViewportSize } from './types';

// =============================================================================
// 定数
// =============================================================================

/**
 * CLS分類閾値（Core Web Vitals準拠）
 */
export const CLS_THRESHOLDS = {
  /** Good threshold */
  GOOD: 0.1,
  /** Needs improvement threshold */
  NEEDS_IMPROVEMENT: 0.25,
} as const;

/**
 * 移動距離推定係数（previousRegionがない場合）
 */
const DISTANCE_ESTIMATION_FACTOR = 0.1;

/**
 * デフォルト設定
 */
const DEFAULTS = {
  /** セッションウィンドウの最大持続時間（ms） */
  SESSION_WINDOW_DURATION_MS: 5000,
  /** セッション間のギャップ閾値（ms） */
  GAP_THRESHOLD_MS: 1000,
  /** デフォルトFPS */
  FPS: 30,
} as const;

// =============================================================================
// 型定義
// =============================================================================

/**
 * CLSCalculator設定
 */
export interface CLSCalculatorConfig {
  /** セッションウィンドウの最大持続時間（ms）デフォルト: 5000 */
  sessionWindowDurationMs?: number;
  /** セッション間のギャップ閾値（ms）デフォルト: 1000 */
  gapThresholdMs?: number;
  /** フレームレート デフォルト: 30 */
  fps?: number;
}

/**
 * 個別のレイアウトシフト情報
 */
export interface LayoutShift {
  /** シフト領域 */
  region: BoundingBox;
  /** 影響割合 (0-1) */
  impactFraction: number;
  /** 移動距離割合 (0-1) */
  distanceFraction: number;
  /** シフトスコア (impactFraction * distanceFraction) */
  score: number;
}

/**
 * フレームペアのCLS結果
 */
export interface FramePairCLSResult {
  /** フレームインデックス */
  frameIndex: number;
  /** CLSスコア */
  cls: number;
  /** 分類 */
  classification: 'good' | 'needs-improvement' | 'poor';
  /** 検出されたシフト一覧 */
  shifts: LayoutShift[];
  /** 全体の影響割合 */
  impactFraction: number;
  /** 全体の移動距離割合 */
  distanceFraction: number;
}

/**
 * セッションウィンドウ
 * Core Web Vitalsでは、1秒以上のギャップで区切られた5秒以内のウィンドウでCLSを計算
 */
export interface CLSSessionWindow {
  /** 開始フレームインデックス */
  startFrame: number;
  /** 終了フレームインデックス */
  endFrame: number;
  /** 開始時間（ms） */
  startTimeMs: number;
  /** 終了時間（ms） */
  endTimeMs: number;
  /** このウィンドウのCLS */
  cls: number;
  /** シフト回数 */
  shiftCount: number;
}

/**
 * フレームシーケンスのCLS結果
 */
export interface FrameSequenceCLSResult {
  /** 累積CLS（全シフトの合計） */
  totalCLS: number;
  /** 最大セッションウィンドウのCLS（Core Web Vitals準拠） */
  maxSessionCLS: number;
  /** 分類（maxSessionCLSに基づく） */
  classification: 'good' | 'needs-improvement' | 'poor';
  /** シフト回数 */
  shiftCount: number;
  /** セッションウィンドウ */
  sessionWindows: CLSSessionWindow[];
  /** フレームごとの結果 */
  frameResults: FramePairCLSResult[];
  /** 処理時間（ms） */
  processingTimeMs: number;
}

/**
 * calculateFramePairCLSのオプション
 */
export interface FramePairCLSOptions {
  /** 前フレームの領域（移動距離計算用） */
  previousRegions?: BoundingBox[];
  /** 変化強度（previousRegionsがない場合の距離推定用） */
  changeIntensity?: number;
}

// =============================================================================
// CLSCalculator クラス
// =============================================================================

/**
 * CLS計算サービス
 *
 * フレーム差分結果からCore Web Vitals準拠のCLSを計算
 */
export class CLSCalculator {
  private readonly config: Required<CLSCalculatorConfig>;

  constructor(config: CLSCalculatorConfig = {}) {
    this.config = {
      sessionWindowDurationMs: config.sessionWindowDurationMs ?? DEFAULTS.SESSION_WINDOW_DURATION_MS,
      gapThresholdMs: config.gapThresholdMs ?? DEFAULTS.GAP_THRESHOLD_MS,
      fps: config.fps ?? DEFAULTS.FPS,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CLSCalculator] Initialized:', this.config);
    }
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * 単一フレームペアのCLSを計算
   *
   * @param diffResult - フレーム差分結果
   * @param viewport - ビューポートサイズ
   * @param options - オプション
   * @returns フレームペアのCLS結果
   */
  calculateFramePairCLS(
    diffResult: FrameDiffResult,
    viewport: ViewportSize,
    options: FramePairCLSOptions = {}
  ): FramePairCLSResult {
    // ビューポートバリデーション
    this.validateViewport(viewport);

    const shifts: LayoutShift[] = [];
    let totalCLS = 0;

    // 各領域のシフトを計算
    for (let i = 0; i < diffResult.regions.length; i++) {
      const region = diffResult.regions[i];
      if (!region) continue;

      const previousRegion = options.previousRegions?.[i];
      const changeIntensity = options.changeIntensity ?? diffResult.changeRatio;

      // impact fraction: ビューポートに対する変化領域の割合
      const impactFraction = this.calculateImpactFraction(region, viewport);

      // distance fraction: 移動距離のビューポート最大次元に対する割合
      const distanceFraction = this.calculateDistanceFraction(
        region,
        previousRegion,
        viewport,
        changeIntensity
      );

      // 0-1の範囲にクランプ
      const clampedImpact = Math.max(0, Math.min(1, impactFraction));
      const clampedDistance = Math.max(0, Math.min(1, distanceFraction));

      // スコア計算
      const score = clampedImpact * clampedDistance;

      shifts.push({
        region,
        impactFraction: clampedImpact,
        distanceFraction: clampedDistance,
        score,
      });

      totalCLS += score;
    }

    // 全体のimpactFractionとdistanceFractionを計算
    let totalImpactFraction = 0;
    let totalDistanceFraction = 0;

    if (shifts.length > 0) {
      totalImpactFraction = shifts.reduce((sum, s) => sum + s.impactFraction, 0) / shifts.length;
      totalDistanceFraction = shifts.reduce((sum, s) => sum + s.distanceFraction, 0) / shifts.length;
    }

    return {
      frameIndex: diffResult.frameIndex,
      cls: totalCLS,
      classification: this.classifyCLS(totalCLS),
      shifts,
      impactFraction: Math.max(0, Math.min(1, totalImpactFraction)),
      distanceFraction: Math.max(0, Math.min(1, totalDistanceFraction)),
    };
  }

  /**
   * フレームシーケンス全体のCLSを計算
   *
   * Core Web Vitals準拠:
   * - 1秒以上のギャップで区切られたセッションウィンドウを検出
   * - 最大5秒のウィンドウ内でCLSを累積
   * - 最大のセッションウィンドウCLSを最終スコアとする
   *
   * @param diffResults - フレーム差分結果の配列
   * @param viewport - ビューポートサイズ
   * @returns フレームシーケンスのCLS結果
   */
  calculateSequenceCLS(
    diffResults: FrameDiffResult[],
    viewport: ViewportSize
  ): FrameSequenceCLSResult {
    const startTime = performance.now();

    if (diffResults.length === 0) {
      return {
        totalCLS: 0,
        maxSessionCLS: 0,
        classification: 'good',
        shiftCount: 0,
        sessionWindows: [],
        frameResults: [],
        processingTimeMs: Math.round(performance.now() - startTime),
      };
    }

    // 各フレームペアのCLSを計算
    const frameResults: FramePairCLSResult[] = [];
    let previousRegions: BoundingBox[] | undefined;

    for (const diffResult of diffResults) {
      const options: FramePairCLSOptions = {
        changeIntensity: diffResult.changeRatio,
      };
      if (previousRegions !== undefined) {
        options.previousRegions = previousRegions;
      }
      const result = this.calculateFramePairCLS(diffResult, viewport, options);
      frameResults.push(result);

      // 次のフレームのために現在の領域を保存
      previousRegions = diffResult.regions;
    }

    // セッションウィンドウを検出
    const sessionWindows = this.detectSessionWindows(frameResults);

    // 累積CLSと最大セッションCLSを計算
    const totalCLS = frameResults.reduce((sum, r) => sum + r.cls, 0);
    const maxSessionCLS = sessionWindows.length > 0
      ? Math.max(...sessionWindows.map((w) => w.cls))
      : totalCLS;

    const shiftCount = frameResults.reduce((sum, r) => sum + r.shifts.length, 0);

    const processingTimeMs = Math.round(performance.now() - startTime);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CLSCalculator] Sequence CLS calculated:', {
        totalCLS: totalCLS.toFixed(4),
        maxSessionCLS: maxSessionCLS.toFixed(4),
        shiftCount,
        sessionWindows: sessionWindows.length,
        processingTimeMs,
      });
    }

    return {
      totalCLS,
      maxSessionCLS,
      classification: this.classifyCLS(maxSessionCLS),
      shiftCount,
      sessionWindows,
      frameResults,
      processingTimeMs,
    };
  }

  /**
   * 影響割合を計算
   *
   * @param region - 変化領域
   * @param viewport - ビューポートサイズ
   * @returns 影響割合 (0-1)
   */
  calculateImpactFraction(region: BoundingBox, viewport: ViewportSize): number {
    const viewportArea = viewport.width * viewport.height;
    if (viewportArea === 0) return 0;

    // ビューポート内の有効領域を計算
    const visibleArea = this.calculateVisibleArea(region, viewport);

    return visibleArea / viewportArea;
  }

  /**
   * 移動距離割合を計算
   *
   * @param currentRegion - 現在の領域
   * @param previousRegion - 前の領域（オプション）
   * @param viewport - ビューポートサイズ
   * @param changeIntensity - 変化強度（previousRegionがない場合の推定用）
   * @returns 移動距離割合 (0-1)
   */
  calculateDistanceFraction(
    currentRegion: BoundingBox,
    previousRegion: BoundingBox | undefined,
    viewport: ViewportSize,
    changeIntensity: number = 0
  ): number {
    const maxViewportDimension = Math.max(viewport.width, viewport.height);
    if (maxViewportDimension === 0) return 0;

    if (previousRegion) {
      // 実際の移動距離を計算
      const dx = currentRegion.x - previousRegion.x;
      const dy = currentRegion.y - previousRegion.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return distance / maxViewportDimension;
    }

    // previousRegionがない場合は変化強度に基づいて推定
    return changeIntensity * DISTANCE_ESTIMATION_FACTOR;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * ビューポートのバリデーション
   */
  private validateViewport(viewport: ViewportSize): void {
    if (viewport.width <= 0 || viewport.height <= 0) {
      throw new Error('Invalid viewport: width and height must be positive');
    }
  }

  /**
   * CLSスコアを分類
   */
  private classifyCLS(cls: number): 'good' | 'needs-improvement' | 'poor' {
    if (cls < CLS_THRESHOLDS.GOOD) {
      return 'good';
    }
    if (cls < CLS_THRESHOLDS.NEEDS_IMPROVEMENT) {
      return 'needs-improvement';
    }
    return 'poor';
  }

  /**
   * ビューポート内の有効領域面積を計算
   */
  private calculateVisibleArea(region: BoundingBox, viewport: ViewportSize): number {
    const regionRight = region.x + region.width;
    const regionBottom = region.y + region.height;

    const visibleLeft = Math.max(0, region.x);
    const visibleTop = Math.max(0, region.y);
    const visibleRight = Math.min(viewport.width, regionRight);
    const visibleBottom = Math.min(viewport.height, regionBottom);

    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);

    return visibleWidth * visibleHeight;
  }

  /**
   * セッションウィンドウを検出
   *
   * Core Web Vitals仕様:
   * - シフト間に1秒以上のギャップがあればウィンドウを分割
   * - 各ウィンドウは最大5秒
   */
  private detectSessionWindows(frameResults: FramePairCLSResult[]): CLSSessionWindow[] {
    const windows: CLSSessionWindow[] = [];

    if (frameResults.length === 0) {
      return windows;
    }

    const fps = this.config.fps;
    const gapFrames = Math.round((this.config.gapThresholdMs / 1000) * fps);
    const maxWindowFrames = Math.round((this.config.sessionWindowDurationMs / 1000) * fps);

    let windowStart: number | null = null;
    let windowCLS = 0;
    let windowShiftCount = 0;
    let lastShiftFrame = -Infinity;

    for (const result of frameResults) {
      const hasShift = result.shifts.length > 0 && result.cls > 0;

      if (hasShift) {
        const frameSinceLastShift = result.frameIndex - lastShiftFrame;

        // ギャップが閾値を超えた場合、現在のウィンドウを閉じて新しいウィンドウを開始
        if (windowStart !== null && frameSinceLastShift > gapFrames) {
          windows.push({
            startFrame: windowStart,
            endFrame: lastShiftFrame,
            startTimeMs: Math.round((windowStart / fps) * 1000),
            endTimeMs: Math.round((lastShiftFrame / fps) * 1000),
            cls: windowCLS,
            shiftCount: windowShiftCount,
          });

          windowStart = null;
          windowCLS = 0;
          windowShiftCount = 0;
        }

        // ウィンドウ開始
        if (windowStart === null) {
          windowStart = result.frameIndex;
        }

        // ウィンドウが最大持続時間を超えた場合、閉じて新しいウィンドウを開始
        if (result.frameIndex - windowStart > maxWindowFrames) {
          windows.push({
            startFrame: windowStart,
            endFrame: lastShiftFrame,
            startTimeMs: Math.round((windowStart / fps) * 1000),
            endTimeMs: Math.round((lastShiftFrame / fps) * 1000),
            cls: windowCLS,
            shiftCount: windowShiftCount,
          });

          windowStart = result.frameIndex;
          windowCLS = 0;
          windowShiftCount = 0;
        }

        windowCLS += result.cls;
        windowShiftCount += result.shifts.length;
        lastShiftFrame = result.frameIndex;
      }
    }

    // 最後のウィンドウを閉じる
    if (windowStart !== null && windowShiftCount > 0) {
      windows.push({
        startFrame: windowStart,
        endFrame: lastShiftFrame,
        startTimeMs: Math.round((windowStart / fps) * 1000),
        endTimeMs: Math.round((lastShiftFrame / fps) * 1000),
        cls: windowCLS,
        shiftCount: windowShiftCount,
      });
    }

    return windows;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * CLSCalculatorインスタンスを作成
 */
export function createCLSCalculator(config?: CLSCalculatorConfig): CLSCalculator {
  return new CLSCalculator(config);
}

export default CLSCalculator;
