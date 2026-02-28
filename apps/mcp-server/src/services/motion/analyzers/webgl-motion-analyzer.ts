// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLMotionAnalyzer
 *
 * フレーム差分のchangeRatio時系列データから、アニメーション特性を分析するサービス
 *
 * 分析機能:
 * - 周期性検出（自己相関法）
 * - 平均/最大/最小changeRatio
 * - 標準偏差
 * - 支配的な動きの方向（オプション）
 * - 変化パターンの特徴抽出
 *
 * @module services/motion/analyzers/webgl-motion-analyzer
 */

import { createLogger, isDevelopment } from '../../../utils/logger';
import type { FrameDiffResult, BoundingBox } from '../types';

// =====================================================
// 型定義
// =====================================================

/**
 * WebGLモーション分析オプション
 */
export interface WebGLMotionAnalysisOptions {
  /** 周期検出の最大ラグ（フレーム数）。デフォルト: 60 */
  maxPeriodLag?: number;
  /** 変化検出の最小閾値（0-1）。デフォルト: 0.001 */
  changeThreshold?: number;
  /** 方向分析を有効にするか。デフォルト: true */
  analyzeDirection?: boolean;
  /** スムージングウィンドウサイズ。デフォルト: 5 */
  smoothingWindow?: number;
}

/**
 * 周期分析結果
 */
export interface PeriodicityAnalysis {
  /** 周期性スコア (0-1) */
  score: number;
  /** 推定周期（フレーム数）*/
  estimatedPeriodFrames: number;
  /** 推定周期（ミリ秒、30fps想定）*/
  estimatedPeriodMs: number;
  /** 周期の信頼度 (0-1) */
  confidence: number;
  /** 自己相関値の配列 */
  autocorrelations: number[];
}

/**
 * 方向分析結果
 */
export interface DirectionAnalysis {
  /** 主要な動きの方向（度、0-360）*/
  dominantDirection: number;
  /** 方向の一貫性スコア (0-1) */
  directionConsistency: number;
  /** 上方向への動きの割合 (0-1) */
  upwardRatio: number;
  /** 下方向への動きの割合 (0-1) */
  downwardRatio: number;
  /** 左方向への動きの割合 (0-1) */
  leftwardRatio: number;
  /** 右方向への動きの割合 (0-1) */
  rightwardRatio: number;
}

/**
 * 変化パターン特性
 */
export interface ChangePatternCharacteristics {
  /** 変化のスパイク数 */
  spikeCount: number;
  /** 平均スパイク間隔（フレーム数）*/
  avgSpikePeriod: number;
  /** 変化の持続時間（フレーム数）*/
  avgChangeDuration: number;
  /** 静止フレームの割合 (0-1) */
  staticFrameRatio: number;
  /** 動的フレームの割合 (0-1) */
  dynamicFrameRatio: number;
}

/**
 * WebGLモーション分析結果
 */
export interface WebGLMotionAnalysisResult {
  /** 成功フラグ */
  success: boolean;

  /** 基本統計 */
  statistics: {
    /** 平均変化率 (0-1) */
    avgChangeRatio: number;
    /** 最大変化率 (0-1) */
    maxChangeRatio: number;
    /** 最小変化率 (0-1) */
    minChangeRatio: number;
    /** 標準偏差 */
    stdDeviation: number;
    /** 分析フレーム数 */
    frameCount: number;
    /** 変化があったフレーム数 */
    changeFrameCount: number;
  };

  /** 周期性分析 */
  periodicity: PeriodicityAnalysis;

  /** 方向分析（オプション）*/
  direction?: DirectionAnalysis;

  /** 変化パターン特性 */
  changePattern: ChangePatternCharacteristics;

  /** 処理時間（ミリ秒）*/
  processingTimeMs: number;

  /** エラー情報 */
  error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// 定数
// =====================================================

const logger = createLogger('WebGLMotionAnalyzer');

/** デフォルトオプション */
const DEFAULT_OPTIONS: Required<WebGLMotionAnalysisOptions> = {
  maxPeriodLag: 60,
  changeThreshold: 0.001,
  analyzeDirection: true,
  smoothingWindow: 5,
};

/** FPS（フレーム周期計算用）*/
const DEFAULT_FPS = 30;

// =====================================================
// WebGLMotionAnalyzer クラス
// =====================================================

/**
 * WebGLアニメーションのモーション特性を分析するクラス
 *
 * フレーム差分結果から時系列データを抽出し、
 * 周期性、方向性、変化パターンを分析します。
 */
export class WebGLMotionAnalyzer {
  private readonly options: Required<WebGLMotionAnalysisOptions>;

  constructor(options?: WebGLMotionAnalysisOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    if (isDevelopment()) {
      logger.debug('[WebGLMotionAnalyzer] Initialized', {
        options: this.options,
      });
    }
  }

  /**
   * フレーム差分結果からモーション特性を分析
   *
   * @param frameDiffs - フレーム差分結果の配列
   * @param fps - フレームレート（デフォルト: 30）
   * @returns 分析結果
   */
  analyze(frameDiffs: FrameDiffResult[], fps: number = DEFAULT_FPS): WebGLMotionAnalysisResult {
    const startTime = Date.now();

    try {
      // バリデーション
      if (frameDiffs.length < 2) {
        return this.createErrorResult('INSUFFICIENT_DATA', 'At least 2 frame diffs required');
      }

      // changeRatio配列を抽出
      const changeRatios = frameDiffs.map((d) => d.changeRatio);

      // 基本統計を計算
      const statistics = this.calculateStatistics(changeRatios);

      // 周期性を分析
      const periodicity = this.analyzePeriodicity(changeRatios, fps);

      // 変化パターンを分析
      const changePattern = this.analyzeChangePattern(changeRatios);

      // 方向分析（オプション）
      let direction: DirectionAnalysis | undefined;
      if (this.options.analyzeDirection && frameDiffs.some((d) => d.regions.length > 0)) {
        direction = this.analyzeDirection(frameDiffs);
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.debug('[WebGLMotionAnalyzer] Analysis complete', {
          frameCount: frameDiffs.length,
          avgChangeRatio: statistics.avgChangeRatio,
          periodicityScore: periodicity.score,
          processingTimeMs,
        });
      }

      const result: WebGLMotionAnalysisResult = {
        success: true,
        statistics,
        periodicity,
        changePattern,
        processingTimeMs,
      };

      // 方向分析結果がある場合のみ追加
      if (direction !== undefined) {
        result.direction = direction;
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (isDevelopment()) {
        logger.error('[WebGLMotionAnalyzer] Analysis failed', { error: message });
      }
      return this.createErrorResult('ANALYSIS_FAILED', message);
    }
  }

  /**
   * changeRatio配列のみから分析（軽量版）
   *
   * @param changeRatios - 変化率の配列 (0-1)
   * @param fps - フレームレート（デフォルト: 30）
   * @returns 分析結果
   */
  analyzeFromRatios(
    changeRatios: number[],
    fps: number = DEFAULT_FPS
  ): WebGLMotionAnalysisResult {
    const startTime = Date.now();

    try {
      if (changeRatios.length < 2) {
        return this.createErrorResult('INSUFFICIENT_DATA', 'At least 2 values required');
      }

      const statistics = this.calculateStatistics(changeRatios);
      const periodicity = this.analyzePeriodicity(changeRatios, fps);
      const changePattern = this.analyzeChangePattern(changeRatios);

      const processingTimeMs = Date.now() - startTime;

      return {
        success: true,
        statistics,
        periodicity,
        changePattern,
        processingTimeMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResult('ANALYSIS_FAILED', message);
    }
  }

  // =====================================================
  // プライベートメソッド: 統計計算
  // =====================================================

  /**
   * 基本統計を計算
   */
  private calculateStatistics(changeRatios: number[]): WebGLMotionAnalysisResult['statistics'] {
    const n = changeRatios.length;
    const sum = changeRatios.reduce((a, b) => a + b, 0);
    const avgChangeRatio = sum / n;

    const maxChangeRatio = Math.max(...changeRatios);
    const minChangeRatio = Math.min(...changeRatios);

    // 標準偏差
    const squaredDiffs = changeRatios.map((v) => (v - avgChangeRatio) ** 2);
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;
    const stdDeviation = Math.sqrt(variance);

    // 変化があったフレーム数
    const changeFrameCount = changeRatios.filter(
      (r) => r > this.options.changeThreshold
    ).length;

    return {
      avgChangeRatio,
      maxChangeRatio,
      minChangeRatio,
      stdDeviation,
      frameCount: n,
      changeFrameCount,
    };
  }

  // =====================================================
  // プライベートメソッド: 周期性分析
  // =====================================================

  /**
   * 周期性を分析（自己相関法）
   */
  private analyzePeriodicity(changeRatios: number[], fps: number): PeriodicityAnalysis {
    const n = changeRatios.length;
    const maxLag = Math.min(this.options.maxPeriodLag, Math.floor(n / 2));

    if (maxLag < 2) {
      return this.createEmptyPeriodicityResult();
    }

    // 平均と分散を計算
    const mean = changeRatios.reduce((a, b) => a + b, 0) / n;
    const variance = changeRatios.reduce((a, b) => a + (b - mean) ** 2, 0) / n;

    if (variance === 0) {
      return this.createEmptyPeriodicityResult();
    }

    // 自己相関を計算
    const autocorrelations: number[] = [];
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        const val1 = changeRatios[i];
        const val2 = changeRatios[i + lag];
        if (val1 !== undefined && val2 !== undefined) {
          sum += (val1 - mean) * (val2 - mean);
        }
      }
      const autocorr = sum / ((n - lag) * variance);
      autocorrelations.push(autocorr);
    }

    // ピークを検出（最初の有意なピーク）
    let maxScore = 0;
    let estimatedPeriodFrames = 0;
    let foundFirstMin = false;

    for (let i = 1; i < autocorrelations.length - 1; i++) {
      const prev = autocorrelations[i - 1] ?? 0;
      const curr = autocorrelations[i] ?? 0;
      const next = autocorrelations[i + 1] ?? 0;

      // 最初の極小値を検出
      if (!foundFirstMin && curr < prev && curr < next) {
        foundFirstMin = true;
      }

      // 極小値を過ぎた後の最初のピーク
      if (foundFirstMin && curr > prev && curr > next && curr > maxScore) {
        maxScore = curr;
        estimatedPeriodFrames = i;
      }
    }

    // スコアを正規化
    const score = Math.max(0, Math.min(1, maxScore));

    // 周期をミリ秒に変換
    const estimatedPeriodMs =
      estimatedPeriodFrames > 0 ? Math.round((estimatedPeriodFrames / fps) * 1000) : 0;

    // 信頼度計算（ピークの明確さ）
    const confidence = this.calculatePeriodicityConfidence(autocorrelations, estimatedPeriodFrames);

    return {
      score,
      estimatedPeriodFrames,
      estimatedPeriodMs,
      confidence,
      autocorrelations,
    };
  }

  /**
   * 周期性の信頼度を計算
   */
  private calculatePeriodicityConfidence(
    autocorrelations: number[],
    peakIndex: number
  ): number {
    if (peakIndex === 0 || autocorrelations.length < 3) {
      return 0;
    }

    const peakValue = autocorrelations[peakIndex] ?? 0;
    if (peakValue <= 0) {
      return 0;
    }

    // ピーク周辺の値との差を計算
    const neighbors: number[] = [];
    for (let i = Math.max(0, peakIndex - 2); i <= Math.min(autocorrelations.length - 1, peakIndex + 2); i++) {
      if (i !== peakIndex) {
        const val = autocorrelations[i];
        if (val !== undefined) {
          neighbors.push(val);
        }
      }
    }

    if (neighbors.length === 0) {
      return 0;
    }

    const avgNeighbor = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
    const prominence = peakValue - avgNeighbor;

    // 信頼度を正規化 (0-1)
    return Math.max(0, Math.min(1, prominence * 2));
  }

  /**
   * 空の周期性結果を作成
   */
  private createEmptyPeriodicityResult(): PeriodicityAnalysis {
    return {
      score: 0,
      estimatedPeriodFrames: 0,
      estimatedPeriodMs: 0,
      confidence: 0,
      autocorrelations: [],
    };
  }

  // =====================================================
  // プライベートメソッド: 方向分析
  // =====================================================

  /**
   * 変化領域から動きの方向を分析
   */
  private analyzeDirection(frameDiffs: FrameDiffResult[]): DirectionAnalysis {
    let upCount = 0;
    let downCount = 0;
    let leftCount = 0;
    let rightCount = 0;
    let totalMoves = 0;

    const directions: number[] = [];

    // 連続フレーム間の領域移動を追跡
    for (let i = 1; i < frameDiffs.length; i++) {
      const prevFrame = frameDiffs[i - 1];
      const currFrame = frameDiffs[i];

      if (!prevFrame || !currFrame) continue;
      if (prevFrame.regions.length === 0 || currFrame.regions.length === 0) continue;

      // 最初の領域のみ比較（簡略化）
      const prevRegion = prevFrame.regions[0];
      const currRegion = currFrame.regions[0];

      if (!prevRegion || !currRegion) continue;

      const { dx, dy, direction } = this.calculateMovement(prevRegion, currRegion);

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        directions.push(direction);
        totalMoves++;

        if (dy < -5) upCount++;
        if (dy > 5) downCount++;
        if (dx < -5) leftCount++;
        if (dx > 5) rightCount++;
      }
    }

    if (totalMoves === 0) {
      return {
        dominantDirection: 0,
        directionConsistency: 0,
        upwardRatio: 0,
        downwardRatio: 0,
        leftwardRatio: 0,
        rightwardRatio: 0,
      };
    }

    // 主要方向を計算（円形平均）
    const dominantDirection = this.calculateCircularMean(directions);

    // 方向一貫性スコア
    const directionConsistency = this.calculateDirectionConsistency(directions);

    return {
      dominantDirection,
      directionConsistency,
      upwardRatio: upCount / totalMoves,
      downwardRatio: downCount / totalMoves,
      leftwardRatio: leftCount / totalMoves,
      rightwardRatio: rightCount / totalMoves,
    };
  }

  /**
   * 2つの領域間の移動を計算
   */
  private calculateMovement(
    prev: BoundingBox,
    curr: BoundingBox
  ): { dx: number; dy: number; direction: number } {
    // 中心点を計算
    const prevCenterX = prev.x + prev.width / 2;
    const prevCenterY = prev.y + prev.height / 2;
    const currCenterX = curr.x + curr.width / 2;
    const currCenterY = curr.y + curr.height / 2;

    const dx = currCenterX - prevCenterX;
    const dy = currCenterY - prevCenterY;

    // 方向を度で計算（0-360、北が0度）
    const direction = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const normalizedDirection = direction < 0 ? direction + 360 : direction;

    return { dx, dy, direction: normalizedDirection };
  }

  /**
   * 円形平均を計算
   */
  private calculateCircularMean(angles: number[]): number {
    if (angles.length === 0) return 0;

    let sinSum = 0;
    let cosSum = 0;

    for (const angle of angles) {
      const rad = (angle * Math.PI) / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
    }

    const avgRad = Math.atan2(sinSum / angles.length, cosSum / angles.length);
    let avgDeg = (avgRad * 180) / Math.PI;
    if (avgDeg < 0) avgDeg += 360;

    return avgDeg;
  }

  /**
   * 方向の一貫性スコアを計算
   */
  private calculateDirectionConsistency(directions: number[]): number {
    if (directions.length < 2) return 0;

    const mean = this.calculateCircularMean(directions);

    // 平均からの角度差の平均を計算
    let totalDiff = 0;
    for (const dir of directions) {
      let diff = Math.abs(dir - mean);
      if (diff > 180) diff = 360 - diff;
      totalDiff += diff;
    }

    const avgDiff = totalDiff / directions.length;

    // 一貫性スコア（180度の差が0、0度の差が1）
    return 1 - avgDiff / 180;
  }

  // =====================================================
  // プライベートメソッド: 変化パターン分析
  // =====================================================

  /**
   * 変化パターンの特性を分析
   */
  private analyzeChangePattern(changeRatios: number[]): ChangePatternCharacteristics {
    const n = changeRatios.length;
    const threshold = this.options.changeThreshold;

    // スパイク検出（閾値の2倍以上の変化）
    const spikeThreshold = threshold * 2;
    const spikeIndices: number[] = [];
    const changeDurations: number[] = [];

    let inChange = false;
    let changeStart = 0;

    for (let i = 0; i < n; i++) {
      const ratio = changeRatios[i] ?? 0;

      // スパイク検出
      if (ratio > spikeThreshold) {
        spikeIndices.push(i);
      }

      // 変化区間の追跡
      if (!inChange && ratio > threshold) {
        inChange = true;
        changeStart = i;
      } else if (inChange && ratio <= threshold) {
        inChange = false;
        changeDurations.push(i - changeStart);
      }
    }

    // 最後の変化区間
    if (inChange) {
      changeDurations.push(n - changeStart);
    }

    // スパイク間隔の計算
    let avgSpikePeriod = 0;
    if (spikeIndices.length > 1) {
      let totalInterval = 0;
      for (let i = 1; i < spikeIndices.length; i++) {
        const prev = spikeIndices[i - 1];
        const curr = spikeIndices[i];
        if (prev !== undefined && curr !== undefined) {
          totalInterval += curr - prev;
        }
      }
      avgSpikePeriod = totalInterval / (spikeIndices.length - 1);
    }

    // 平均変化持続時間
    const avgChangeDuration =
      changeDurations.length > 0
        ? changeDurations.reduce((a, b) => a + b, 0) / changeDurations.length
        : 0;

    // 静的/動的フレームの割合
    const dynamicFrameCount = changeRatios.filter((r) => r > threshold).length;
    const dynamicFrameRatio = dynamicFrameCount / n;
    const staticFrameRatio = 1 - dynamicFrameRatio;

    return {
      spikeCount: spikeIndices.length,
      avgSpikePeriod,
      avgChangeDuration,
      staticFrameRatio,
      dynamicFrameRatio,
    };
  }

  // =====================================================
  // プライベートメソッド: エラーハンドリング
  // =====================================================

  /**
   * エラー結果を作成
   */
  private createErrorResult(code: string, message: string): WebGLMotionAnalysisResult {
    return {
      success: false,
      statistics: {
        avgChangeRatio: 0,
        maxChangeRatio: 0,
        minChangeRatio: 0,
        stdDeviation: 0,
        frameCount: 0,
        changeFrameCount: 0,
      },
      periodicity: this.createEmptyPeriodicityResult(),
      changePattern: {
        spikeCount: 0,
        avgSpikePeriod: 0,
        avgChangeDuration: 0,
        staticFrameRatio: 1,
        dynamicFrameRatio: 0,
      },
      processingTimeMs: 0,
      error: {
        code,
        message,
      },
    };
  }
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * WebGLMotionAnalyzerインスタンスを作成
 */
export function createWebGLMotionAnalyzer(
  options?: WebGLMotionAnalysisOptions
): WebGLMotionAnalyzer {
  return new WebGLMotionAnalyzer(options);
}
