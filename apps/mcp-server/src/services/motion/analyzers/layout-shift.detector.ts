// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layout Shift Detector
 *
 * フレーム差分からレイアウトシフトを検出し、CLS (Cumulative Layout Shift) スコアを計算する
 *
 * CLS計算仕様:
 * - impact_fraction: ビューポートに対する変化領域の割合
 * - distance_fraction: ビューポートの最大次元に対する移動距離の割合
 * - layout_shift_score = impact_fraction * distance_fraction
 *
 * 分類閾値:
 * - good: < 0.1
 * - needs-improvement: >= 0.1 && < 0.25
 * - poor: >= 0.25
 *
 * @module @reftrix/mcp-server/services/motion/analyzers/layout-shift.detector
 */

// =============================================================================
// 型定義
// =============================================================================

/**
 * バウンディングボックス
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ビューポート情報
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * 差分領域情報
 * フレーム差分検出から得られる変化領域
 */
export interface DiffRegion {
  /** 左上X座標 */
  x: number;
  /** 左上Y座標 */
  y: number;
  /** 幅 */
  width: number;
  /** 高さ */
  height: number;
  /** 変化強度 (0-1) */
  changeIntensity: number;
  /** 変化ピクセル数 */
  pixelCount: number;
  /** 前フレームでの位置（移動情報がある場合） */
  previousPosition?: { x: number; y: number };
}

/**
 * 個別のレイアウトシフト情報
 */
export interface LayoutShift {
  /** シフト領域 */
  region: BoundingBox;
  /** 影響割合 (0-1) - ビューポートに対する変化領域の割合 */
  impactFraction: number;
  /** 移動距離割合 (0-1) - ビューポート最大次元に対する移動距離の割合 */
  distanceFraction: number;
  /** シフトスコア (impactFraction * distanceFraction) */
  score: number;
}

/**
 * レイアウトシフト分析結果
 */
export interface LayoutShiftResult {
  /** 累積レイアウトシフトスコア (0-1+) */
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

// =============================================================================
// 定数
// =============================================================================

/**
 * CLS分類閾値
 */
const CLS_THRESHOLDS = {
  GOOD: 0.1,
  NEEDS_IMPROVEMENT: 0.25,
} as const;

/**
 * 移動距離推定係数（previousPositionがない場合）
 */
const DISTANCE_ESTIMATION_FACTOR = 0.1;

// =============================================================================
// LayoutShiftDetector クラス
// =============================================================================

/**
 * レイアウトシフト検出器
 *
 * フレーム差分からレイアウトシフトを検出し、CLSスコアを計算する
 */
export class LayoutShiftDetector {
  /**
   * 差分領域からレイアウトシフトを検出
   *
   * @param diffRegions - 差分領域の配列
   * @param viewport - ビューポート情報
   * @returns 検出されたレイアウトシフトの配列
   * @throws Error - ビューポートが無効な場合
   */
  detectShifts(diffRegions: DiffRegion[], viewport: Viewport): LayoutShift[] {
    // ビューポートのバリデーション
    this.validateViewport(viewport);

    // 空の配列の場合は空を返す
    if (diffRegions.length === 0) {
      return [];
    }

    const viewportArea = viewport.width * viewport.height;
    const maxViewportDimension = Math.max(viewport.width, viewport.height);

    return diffRegions.map((region) => {
      // 領域のバウンディングボックス
      const boundingBox: BoundingBox = {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      };

      // ビューポート内の有効領域を計算
      const visibleArea = this.calculateVisibleArea(region, viewport);

      // impactFraction: ビューポートに対する変化領域の割合
      const impactFraction = viewportArea > 0 ? visibleArea / viewportArea : 0;

      // distanceFraction: 移動距離のビューポート最大次元に対する割合
      let distanceFraction: number;
      if (region.previousPosition) {
        // 移動距離を計算
        const dx = region.x - region.previousPosition.x;
        const dy = region.y - region.previousPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        distanceFraction = maxViewportDimension > 0 ? distance / maxViewportDimension : 0;
      } else {
        // previousPositionがない場合は changeIntensity に基づいて推定
        distanceFraction = region.changeIntensity * DISTANCE_ESTIMATION_FACTOR;
      }

      // 0-1の範囲にクランプ
      const clampedImpactFraction = Math.max(0, Math.min(1, impactFraction));
      const clampedDistanceFraction = Math.max(0, Math.min(1, distanceFraction));

      // スコア計算
      const score = clampedImpactFraction * clampedDistanceFraction;

      return {
        region: boundingBox,
        impactFraction: clampedImpactFraction,
        distanceFraction: clampedDistanceFraction,
        score,
      };
    });
  }

  /**
   * シフト配列からCLSを計算
   *
   * @param shifts - レイアウトシフトの配列
   * @returns 累積レイアウトシフトスコア
   */
  calculateCLS(shifts: LayoutShift[]): number {
    if (shifts.length === 0) {
      return 0;
    }

    // 各シフトのスコアを累積
    return shifts.reduce((total, shift) => total + shift.score, 0);
  }

  /**
   * CLSスコアを分類
   *
   * @param cls - CLSスコア
   * @returns 分類結果 ('good' | 'needs-improvement' | 'poor')
   */
  classifyShift(cls: number): 'good' | 'needs-improvement' | 'poor' {
    // 負の値は 'good' として扱う
    if (cls < CLS_THRESHOLDS.GOOD) {
      return 'good';
    }
    if (cls < CLS_THRESHOLDS.NEEDS_IMPROVEMENT) {
      return 'needs-improvement';
    }
    return 'poor';
  }

  /**
   * フレームペアを解析してレイアウトシフト結果を返す
   *
   * @param diffRegions - 差分領域の配列
   * @param viewport - ビューポート情報
   * @returns レイアウトシフト分析結果
   */
  analyzeFramePair(diffRegions: DiffRegion[], viewport: Viewport): LayoutShiftResult {
    // シフトを検出
    const shifts = this.detectShifts(diffRegions, viewport);

    // CLSを計算
    const cls = this.calculateCLS(shifts);

    // 分類
    const classification = this.classifyShift(cls);

    // 全体のimpactFractionとdistanceFractionを計算
    let totalImpactFraction = 0;
    let totalDistanceFraction = 0;

    if (shifts.length > 0) {
      totalImpactFraction = shifts.reduce((sum, s) => sum + s.impactFraction, 0);
      totalDistanceFraction = shifts.reduce((sum, s) => sum + s.distanceFraction, 0);

      // 平均化
      totalImpactFraction /= shifts.length;
      totalDistanceFraction /= shifts.length;
    }

    // 0-1の範囲にクランプ
    totalImpactFraction = Math.max(0, Math.min(1, totalImpactFraction));
    totalDistanceFraction = Math.max(0, Math.min(1, totalDistanceFraction));

    return {
      cls,
      classification,
      shifts,
      impactFraction: totalImpactFraction,
      distanceFraction: totalDistanceFraction,
    };
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * ビューポートのバリデーション
   */
  private validateViewport(viewport: Viewport): void {
    if (viewport.width <= 0 || viewport.height <= 0) {
      throw new Error('Invalid viewport: width and height must be positive');
    }
  }

  /**
   * ビューポート内の有効領域面積を計算
   */
  private calculateVisibleArea(region: DiffRegion, viewport: Viewport): number {
    // 領域の右端と下端
    const regionRight = region.x + region.width;
    const regionBottom = region.y + region.height;

    // ビューポート内の有効範囲を計算
    const visibleLeft = Math.max(0, region.x);
    const visibleTop = Math.max(0, region.y);
    const visibleRight = Math.min(viewport.width, regionRight);
    const visibleBottom = Math.min(viewport.height, regionBottom);

    // 有効幅と高さ（負の場合は0）
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);

    return visibleWidth * visibleHeight;
  }
}

export default LayoutShiftDetector;
