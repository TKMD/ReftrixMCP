// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Category Classifier
 *
 * フレーム差分解析結果から視覚的な動きのカテゴリを分類するサービス
 *
 * カテゴリ:
 * - fade: フェードイン/アウト（opacity変化が主、位置変化なし）
 * - slide: スライド（一方向の移動が主、水平or垂直）
 * - scale: スケール（サイズ変化が主、中心からの拡大/縮小）
 * - rotate: 回転（回転変化が主）
 * - parallax: パララックス（複数レイヤーの異なる速度移動）
 * - reveal: 出現/消滅（要素の出現/消滅、クリッピング）
 * - morph: モーフィング（形状の変形）
 * - complex: 複合（複数カテゴリの組み合わせ）
 * - static: 静的（変化なし）
 * - unknown: 不明（分類不能）
 *
 * @module @reftrix/mcp-server/services/motion/visual-category-classifier
 */

import { logger } from '../../utils/logger';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 動きカテゴリ
 */
export type VisualMotionCategory =
  | 'fade'
  | 'slide'
  | 'scale'
  | 'rotate'
  | 'parallax'
  | 'reveal'
  | 'morph'
  | 'complex'
  | 'static'
  | 'unknown';

/**
 * スライド方向
 */
export type SlideDirection = 'horizontal' | 'vertical' | 'diagonal';

/**
 * スケールタイプ
 */
export type ScaleType = 'expand' | 'shrink';

/**
 * フェードタイプ
 */
export type FadeType = 'in' | 'out';

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
 * モーションベクトル
 */
export interface MotionVector {
  dx: number;
  dy: number;
  magnitude: number;
}

/**
 * フレーム差分結果（入力データ）
 */
export interface FrameDiffResult {
  frameIndex: number;
  diffPercentage: number;
  changedPixels: number;
  totalPixels: number;
  boundingBox?: BoundingBox;
  motionVectors?: MotionVector[];
}

/**
 * フレーム分析結果（入力データ）
 */
export interface FrameAnalysisResult {
  frames: FrameDiffResult[];
  summary: {
    avgDiffPercentage: number;
    maxDiffPercentage: number;
    totalFrames: number;
  };
}

/**
 * カテゴリ分類メトリクス
 */
export interface CategoryMetrics {
  /** 主要な動きの方向（度、0-360） */
  dominant_direction?: number;
  /** 移動強度（正規化 0-1） */
  movement_intensity: number;
  /** 影響領域比率（0-1） */
  affected_area_ratio: number;
  /** 速度変化（正規化） */
  velocity_variance?: number;
  /** 中心からの距離変化（スケール用） */
  center_distance_change?: number;
  /** レイヤー情報（パララックス用） */
  layers?: Array<{
    speed_ratio: number;
    region: BoundingBox;
  }>;
}

/**
 * カテゴリ詳細情報
 */
export interface CategoryDetails {
  /** フェード詳細 */
  fade?: {
    type: FadeType;
    start_opacity: number;
    end_opacity: number;
    duration_frames: number;
  };
  /** スライド詳細 */
  slide?: {
    direction: SlideDirection;
    distance_px: number;
    angle_degrees: number;
  };
  /** スケール詳細 */
  scale?: {
    type: ScaleType;
    start_scale: number;
    end_scale: number;
    aspect_ratio_maintained: boolean;
  };
  /** パララックス詳細 */
  parallax?: {
    layer_count: number;
    speed_ratios: number[];
    depth_order: number[];
  };
}

/**
 * カテゴリ分類結果
 */
export interface CategoryClassificationResult {
  /** 主要カテゴリ */
  primary_category: VisualMotionCategory;
  /** 信頼度（0-1） */
  confidence: number;
  /** 副カテゴリ（複合の場合） */
  secondary_categories?: Array<{
    category: VisualMotionCategory;
    weight: number;
  }>;
  /** メトリクス */
  metrics: CategoryMetrics;
  /** カテゴリ詳細 */
  details?: CategoryDetails;
  /** 処理時間（ミリ秒） */
  processing_time_ms?: number;
}

/**
 * Visual Category Classifier 設定
 */
export interface VisualCategoryClassifierConfig {
  /** フェード検出閾値（opacity変化量） */
  fade_threshold?: number;
  /** スライド検出閾値（方向一貫性） */
  slide_consistency_threshold?: number;
  /** スケール検出閾値（サイズ変化率） */
  scale_threshold?: number;
  /** パララックス検出閾値（速度差） */
  parallax_speed_diff_threshold?: number;
  /** 複合カテゴリ判定閾値 */
  complex_category_threshold?: number;
  /** 最小信頼度閾値 */
  min_confidence_threshold?: number;
}

// =============================================================================
// 定数
// =============================================================================

const DEFAULT_CONFIG: Required<VisualCategoryClassifierConfig> = {
  fade_threshold: 0.1,
  slide_consistency_threshold: 0.85,
  scale_threshold: 0.15,
  parallax_speed_diff_threshold: 0.3,
  complex_category_threshold: 0.4,
  min_confidence_threshold: 0.3,
};

// セキュリティ制限
const MAX_FRAMES = 1000;

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 角度を度からラジアンに変換
 */
function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * ラジアンから角度に変換
 */
function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * 数値がNaNやInfinityでないことを確認
 */
function isValidNumber(value: number): boolean {
  return typeof value === 'number' && !Number.isNaN(value) && Number.isFinite(value);
}

/**
 * 数値を安全にクランプ
 */
function clamp(value: number, min: number, max: number): number {
  if (!isValidNumber(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 配列の平均を計算
 */
function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + (isValidNumber(v) ? v : 0), 0);
  return sum / values.length;
}

/**
 * 配列の分散を計算
 */
function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = average(values);
  const squareDiffs = values.map((v) => {
    const val = isValidNumber(v) ? v : 0;
    return Math.pow(val - avg, 2);
  });
  return average(squareDiffs);
}

/**
 * dx, dy から角度（度）を計算
 */
function calculateAngle(dx: number, dy: number): number {
  if (!isValidNumber(dx) || !isValidNumber(dy)) return 0;
  const radians = Math.atan2(dy, dx);
  let degrees = radToDeg(radians);
  if (degrees < 0) degrees += 360;
  return degrees;
}

// =============================================================================
// Visual Category Classifier クラス
// =============================================================================

/**
 * Visual Category Classifier
 *
 * フレーム差分解析結果から視覚的な動きのカテゴリを分類するクラス
 */
export class VisualCategoryClassifier {
  private readonly config: Required<VisualCategoryClassifierConfig>;

  constructor(config?: VisualCategoryClassifierConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    logger.debug('[VisualCategoryClassifier] Initialized with config:', this.config);
  }

  /**
   * フレーム分析結果から動きカテゴリを分類
   */
  classify(input: FrameAnalysisResult): CategoryClassificationResult {
    const startTime = performance.now();

    // 入力検証
    const frames = this.validateAndLimitFrames(input.frames);

    // 空またはほぼ空のフレーム配列の場合は static を返す
    if (frames.length === 0) {
      return this.createStaticResult(startTime);
    }

    // 単一フレームの場合
    if (frames.length === 1) {
      return this.createStaticResult(startTime);
    }

    // メトリクスを計算
    const metrics = this.calculateMetrics(frames);

    // 各カテゴリのスコアを計算
    const scores = this.calculateCategoryScores(frames, metrics);

    // 最適なカテゴリを選択
    const result = this.selectBestCategory(scores, metrics, frames, startTime);

    logger.debug('[VisualCategoryClassifier] Classification result:', {
      category: result.primary_category,
      confidence: result.confidence,
      processing_time_ms: result.processing_time_ms,
    });

    return result;
  }

  /**
   * フレーム配列を直接受け取って分類
   */
  classifyFrameSequence(frames: FrameDiffResult[]): CategoryClassificationResult {
    const input: FrameAnalysisResult = {
      frames,
      summary: {
        avgDiffPercentage: average(frames.map((f) => f.diffPercentage)),
        maxDiffPercentage: Math.max(...frames.map((f) => f.diffPercentage), 0),
        totalFrames: frames.length,
      },
    };
    return this.classify(input);
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * フレーム配列を検証し、制限内に収める
   */
  private validateAndLimitFrames(frames: FrameDiffResult[]): FrameDiffResult[] {
    if (!Array.isArray(frames)) {
      return [];
    }

    // 最大フレーム数制限
    const limitedFrames = frames.slice(0, MAX_FRAMES);

    // 数値検証
    return limitedFrames.map((frame) => ({
      ...frame,
      diffPercentage: isValidNumber(frame.diffPercentage) ? frame.diffPercentage : 0,
      changedPixels: isValidNumber(frame.changedPixels) ? frame.changedPixels : 0,
      totalPixels: isValidNumber(frame.totalPixels) ? Math.max(frame.totalPixels, 1) : 1,
      motionVectors: (frame.motionVectors ?? []).filter(
        (v) => isValidNumber(v.dx) && isValidNumber(v.dy) && isValidNumber(v.magnitude)
      ),
    }));
  }

  /**
   * static結果を生成
   */
  private createStaticResult(startTime: number): CategoryClassificationResult {
    return {
      primary_category: 'static',
      confidence: 0.95,
      metrics: {
        movement_intensity: 0,
        affected_area_ratio: 0,
      },
      processing_time_ms: performance.now() - startTime,
    };
  }

  /**
   * メトリクスを計算
   */
  private calculateMetrics(frames: FrameDiffResult[]): CategoryMetrics {
    // 影響領域比率を計算
    const affected_area_ratio = this.calculateAffectedAreaRatio(frames);

    // 移動強度を計算
    const movement_intensity = this.calculateMovementIntensity(frames);

    // 主要な方向を計算（モーションベクトルがある場合）
    const dominant_direction = this.calculateDominantDirection(frames);

    // 速度分散を計算
    const velocity_variance = this.calculateVelocityVariance(frames);

    // exactOptionalPropertyTypesに対応するため、undefinedのプロパティは省略
    const metrics: CategoryMetrics = {
      movement_intensity,
      affected_area_ratio,
    };
    if (dominant_direction !== undefined) {
      metrics.dominant_direction = dominant_direction;
    }
    if (velocity_variance !== undefined) {
      metrics.velocity_variance = velocity_variance;
    }
    return metrics;
  }

  /**
   * 影響領域比率を計算
   *
   * 標準的なWeb画面サイズ（1000x1000 = 1,000,000ピクセル）を基準として
   * 影響領域の比率を計算する。
   */
  private calculateAffectedAreaRatio(frames: FrameDiffResult[]): number {
    // 標準画面サイズ（1000x1000）
    const STANDARD_AREA = 1000000;

    const ratios: number[] = [];

    for (const frame of frames) {
      if (frame.boundingBox) {
        const boxArea = frame.boundingBox.width * frame.boundingBox.height;

        // 標準サイズに対する比率を計算
        // 浮動小数点精度の問題を避けるため、小数点6桁で丸める
        const ratio = Math.round((boxArea / STANDARD_AREA) * 1000000) / 1000000;
        ratios.push(clamp(ratio, 0, 1));
      } else if (frame.diffPercentage > 0) {
        // boundingBoxがない場合はdiffPercentageから推定
        ratios.push(clamp(frame.diffPercentage, 0, 1));
      }
    }

    if (ratios.length === 0) return 0;
    // 平均値も同様に丸める
    const avg = average(ratios);
    return Math.round(avg * 1000000) / 1000000;
  }

  /**
   * 移動強度を計算
   */
  private calculateMovementIntensity(frames: FrameDiffResult[]): number {
    const magnitudes: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length > 0) {
        const avgMag = average(frame.motionVectors.map((v) => v.magnitude));
        magnitudes.push(avgMag);
      }
    }

    if (magnitudes.length === 0) {
      // モーションベクトルがない場合はdiffPercentageから推定
      const avgDiff = average(frames.map((f) => f.diffPercentage));
      return clamp(avgDiff * 2, 0, 1);
    }

    // 正規化（最大速度30px/frameを基準）
    const avgMag = average(magnitudes);
    return clamp(avgMag / 30, 0, 1);
  }

  /**
   * 主要な方向を計算
   */
  private calculateDominantDirection(frames: FrameDiffResult[]): number | undefined {
    const angles: number[] = [];
    const weights: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length > 0) {
        for (const vector of frame.motionVectors) {
          if (vector.magnitude > 0.1) {
            const angle = calculateAngle(vector.dx, vector.dy);
            angles.push(angle);
            weights.push(vector.magnitude);
          }
        }
      }
    }

    if (angles.length === 0) return undefined;

    // 重み付き平均を計算（角度の循環性を考慮）
    let sinSum = 0;
    let cosSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < angles.length; i++) {
      const angle = angles[i];
      const w = weights[i];
      if (angle === undefined || w === undefined) continue;
      const rad = degToRad(angle);
      sinSum += Math.sin(rad) * w;
      cosSum += Math.cos(rad) * w;
      totalWeight += w;
    }

    if (totalWeight === 0) return undefined;

    const avgRad = Math.atan2(sinSum / totalWeight, cosSum / totalWeight);
    let avgDeg = radToDeg(avgRad);
    if (avgDeg < 0) avgDeg += 360;

    return avgDeg;
  }

  /**
   * 速度分散を計算
   */
  private calculateVelocityVariance(frames: FrameDiffResult[]): number {
    const speeds: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length > 0) {
        const avgSpeed = average(frame.motionVectors.map((v) => v.magnitude));
        speeds.push(avgSpeed);
      }
    }

    if (speeds.length <= 1) return 0;

    // 正規化された分散を計算
    const v = variance(speeds);
    const maxSpeed = Math.max(...speeds);
    if (maxSpeed === 0) return 0;

    return clamp(v / (maxSpeed * maxSpeed), 0, 1);
  }

  /**
   * 各カテゴリのスコアを計算
   */
  private calculateCategoryScores(
    frames: FrameDiffResult[],
    metrics: CategoryMetrics
  ): Map<VisualMotionCategory, number> {
    const scores = new Map<VisualMotionCategory, number>();

    // static検出
    scores.set('static', this.calculateStaticScore(frames));

    // fade検出
    scores.set('fade', this.calculateFadeScore(frames, metrics));

    // slide検出
    scores.set('slide', this.calculateSlideScore(frames, metrics));

    // scale検出
    scores.set('scale', this.calculateScaleScore(frames));

    // parallax検出
    scores.set('parallax', this.calculateParallaxScore(frames));

    // complex検出（後で調整）
    scores.set('complex', 0);

    // rotate, reveal, morph は高度な検出が必要なため基本スコア0
    scores.set('rotate', 0);
    scores.set('reveal', 0);
    scores.set('morph', 0);

    return scores;
  }

  /**
   * static スコアを計算
   */
  private calculateStaticScore(frames: FrameDiffResult[]): number {
    const avgDiff = average(frames.map((f) => f.diffPercentage));

    // 変化がほとんどない場合は static
    if (avgDiff < 0.01) {
      return 0.95;
    } else if (avgDiff < 0.02) {
      return 0.7;
    } else if (avgDiff < 0.03) {
      return 0.4;
    }
    return 0;
  }

  /**
   * fade スコアを計算
   */
  private calculateFadeScore(frames: FrameDiffResult[], _metrics: CategoryMetrics): number {
    // フェードの特徴:
    // 1. モーションベクトルがないか、非常に小さい
    // 2. diffPercentageが徐々に変化（単調増加/減少）
    // 3. 変化率が閾値以上

    // モーションベクトルのチェック（存在・強度）
    let totalMotionMagnitude = 0;
    let motionVectorCount = 0;
    for (const frame of frames) {
      if (frame.motionVectors) {
        for (const v of frame.motionVectors) {
          totalMotionMagnitude += v.magnitude;
          motionVectorCount++;
        }
      }
    }

    const avgMotionMagnitude = motionVectorCount > 0 ? totalMotionMagnitude / motionVectorCount : 0;

    // モーションベクトルがある場合はfade可能性を下げる
    // ただし、複合パターン判定のためにペナルティを調整
    let motionPenalty = 0;
    if (avgMotionMagnitude > 8) {
      motionPenalty = 0.4; // 非常に大きなモーションはfadeではない
    } else if (avgMotionMagnitude > 5) {
      motionPenalty = 0.25; // 大きなモーション
    } else if (avgMotionMagnitude > 2) {
      motionPenalty = 0.15; // 中程度のモーション
    } else if (motionVectorCount > 0 && avgMotionMagnitude > 0.5) {
      motionPenalty = 0.1; // 小さなモーション
    }

    // diffPercentageの変化パターンをチェック
    const diffs = frames.map((f) => f.diffPercentage);
    const isMonotonic = this.isMonotonicSequence(diffs);

    // 変化の幅を計算（フェードは最初と最後で大きな差がある）
    const diffRange = Math.max(...diffs) - Math.min(...diffs);
    const hasSignificantChange = diffRange > 0.1; // 10%以上の変化が必要

    // scaleパターンとの区別: サイズ変化がある場合はfadeの可能性を下げる
    const hasSizeChange = this.detectSizeChange(frames);
    if (hasSizeChange) {
      // サイズ変化がある場合、diffPercentageの変化はスケールの結果である可能性が高い
      return 0.25;
    }

    // 平均変化率を計算
    const avgDiff = average(diffs);

    // 閾値との比率によってスコアを微調整
    const thresholdRatio = avgDiff / this.config.fade_threshold;

    // 基本スコア
    let baseScore = 0.3;

    // フェードには変化の幅が必要（一定値ならフェードではない）
    if (!hasSignificantChange) {
      return 0.2;
    }

    // fade_thresholdは平均変化率の閾値として使用
    // avgDiff < threshold の場合、fadeスコアを大幅に下げる
    if (thresholdRatio < 0.5) {
      // 閾値の半分未満: フェードの可能性が非常に低い
      return 0.25;
    }

    if (isMonotonic && thresholdRatio > 1.0) {
      // 単調変化かつ閾値以上：典型的なフェード
      baseScore = 0.9;
    } else if (isMonotonic && thresholdRatio > 0.5) {
      // 単調変化だが閾値の50%以上：弱いフェード
      baseScore = 0.6 + (thresholdRatio * 0.2);
    } else if (thresholdRatio > 1.5) {
      // 閾値の1.5倍以上の変化率（単調でない場合）
      baseScore = 0.7;
    } else if (thresholdRatio > 1.0) {
      // 閾値以上だが単調ではない
      baseScore = 0.55;
    } else {
      // 閾値未満
      baseScore = 0.35;
    }

    return clamp(baseScore - motionPenalty, 0, 1);
  }

  /**
   * slide スコアを計算
   */
  private calculateSlideScore(frames: FrameDiffResult[], _metrics: CategoryMetrics): number {
    // スライドの特徴:
    // 1. 一貫した方向のモーションベクトル
    // 2. boundingBoxが一方向に移動

    const hasVectors = frames.some((f) => f.motionVectors && f.motionVectors.length > 0);

    if (!hasVectors) {
      // boundingBoxの移動をチェック
      return this.calculateSlideScoreFromBoundingBox(frames);
    }

    // モーションベクトルの一貫性をチェック
    const consistency = this.calculateDirectionConsistency(frames);

    if (consistency > this.config.slide_consistency_threshold) {
      return 0.9;
    } else if (consistency > 0.7) {
      return 0.75;
    } else if (consistency > 0.5) {
      return 0.5;
    }

    return 0.2;
  }

  /**
   * boundingBoxからスライドスコアを計算
   */
  private calculateSlideScoreFromBoundingBox(frames: FrameDiffResult[]): number {
    const positions: Array<{ x: number; y: number }> = [];

    for (const frame of frames) {
      if (frame.boundingBox) {
        positions.push({
          x: frame.boundingBox.x + frame.boundingBox.width / 2,
          y: frame.boundingBox.y + frame.boundingBox.height / 2,
        });
      }
    }

    if (positions.length < 2) return 0;

    // 位置の変化を計算
    const deltas: Array<{ dx: number; dy: number }> = [];
    for (let i = 1; i < positions.length; i++) {
      const current = positions[i];
      const prev = positions[i - 1];
      if (!current || !prev) continue;
      deltas.push({
        dx: current.x - prev.x,
        dy: current.y - prev.y,
      });
    }

    // 移動距離の合計を計算
    const totalDistance = deltas.reduce(
      (sum, d) => sum + Math.sqrt(d.dx * d.dx + d.dy * d.dy),
      0
    );

    // 移動がほとんどない場合はスライドではない
    if (totalDistance < 5) {
      return 0.1;
    }

    // 方向の一貫性をチェック
    const angles = deltas.map((d) => calculateAngle(d.dx, d.dy));
    const angleVariance = variance(angles);

    // 角度の分散が小さければスライドの可能性が高い
    if (angleVariance < 100) {
      return 0.8;
    } else if (angleVariance < 500) {
      return 0.5;
    }

    return 0.2;
  }

  /**
   * 方向の一貫性を計算
   */
  private calculateDirectionConsistency(frames: FrameDiffResult[]): number {
    const angles: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length > 0) {
        // 最も大きいベクトルの角度を使用
        const mainVector = frame.motionVectors.reduce((max, v) =>
          v.magnitude > max.magnitude ? v : max
        );
        if (mainVector.magnitude > 0.1) {
          angles.push(calculateAngle(mainVector.dx, mainVector.dy));
        }
      }
    }

    if (angles.length < 2) return 0;

    // 角度の標準偏差を計算（循環性を考慮）
    const sinSum = angles.reduce((sum, a) => sum + Math.sin(degToRad(a)), 0);
    const cosSum = angles.reduce((sum, a) => sum + Math.cos(degToRad(a)), 0);
    const meanSin = sinSum / angles.length;
    const meanCos = cosSum / angles.length;
    const r = Math.sqrt(meanSin * meanSin + meanCos * meanCos);

    return r; // r=1 で完全に一貫、r=0 でランダム
  }

  /**
   * scale スコアを計算
   */
  private calculateScaleScore(frames: FrameDiffResult[]): number {
    // スケールの特徴:
    // 1. boundingBoxのサイズが一貫して変化
    // 2. 中心位置は大きく変わらない
    // 3. モーションベクトルが放射状パターン

    const sizes: number[] = [];
    const centers: Array<{ x: number; y: number }> = [];

    for (const frame of frames) {
      if (frame.boundingBox) {
        const size = frame.boundingBox.width * frame.boundingBox.height;
        sizes.push(size);
        centers.push({
          x: frame.boundingBox.x + frame.boundingBox.width / 2,
          y: frame.boundingBox.y + frame.boundingBox.height / 2,
        });
      }
    }

    if (sizes.length < 2) return 0;

    // サイズ変化率を計算
    const firstSize = sizes[0] ?? 1;
    const lastSize = sizes[sizes.length - 1] ?? 1;
    const sizeRatio = lastSize / firstSize;

    // サイズ変化がほぼない場合はscaleではない
    if (sizeRatio > 0.95 && sizeRatio < 1.05) {
      return 0.1;
    }

    // サイズの変化を確認（単調増加/減少）
    const isMonotonic = this.isMonotonicSequence(sizes);
    if (!isMonotonic) {
      return 0.2;
    }

    // サイズ変化が顕著かチェック（1.5倍以上または0.67倍以下）
    const significantSizeChange = sizeRatio > 1.5 || sizeRatio < 0.67;

    // 中心位置の変化を確認
    const centerVarianceX = variance(centers.map((c) => c.x));
    const centerVarianceY = variance(centers.map((c) => c.y));
    const centerStable = centerVarianceX < 100 && centerVarianceY < 100;
    // アスペクト比変更の場合、一方向のみ変化することを許容
    const centerSemiStable =
      (centerVarianceX < 500 && centerVarianceY < 100) ||
      (centerVarianceX < 100 && centerVarianceY < 500);

    // 放射状モーションベクトルをチェック
    const hasRadialMotion = this.hasRadialMotionPattern(frames);

    if (significantSizeChange && centerStable) {
      return 0.92; // 高いスコア
    }

    // アスペクト比変更の場合（一方向のみ中心移動）
    if (significantSizeChange && centerSemiStable) {
      return 0.88;
    }

    if (hasRadialMotion && centerStable) {
      return 0.85;
    }

    // サイズ変化がある程度あるがcenterStable
    if (centerStable && (sizeRatio > 1.1 || sizeRatio < 0.9)) {
      return 0.75;
    }

    // サイズ変化が非常に大きい場合（4倍以上または0.25倍以下）は確実にスケール
    // slideの最大スコア0.9より高くする
    if (sizeRatio > 4 || sizeRatio < 0.25) {
      return 0.95;
    }

    // サイズ変化が大きい場合（2.5倍以上または0.4倍以下）は中心移動があってもscaleの可能性
    if (sizeRatio > 2.5 || sizeRatio < 0.4) {
      return 0.85;
    }

    return 0.4;
  }

  /**
   * 放射状のモーションパターンをチェック
   */
  private hasRadialMotionPattern(frames: FrameDiffResult[]): boolean {
    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length >= 2) {
        // 複数のベクトルの角度を取得
        const angles = frame.motionVectors
          .filter((v) => v.magnitude > 0.1)
          .map((v) => calculateAngle(v.dx, v.dy));

        if (angles.length >= 2) {
          // 角度が異なる方向を向いている（放射状）かチェック
          const angleSet = new Set(angles.map((a) => Math.round(a / 45) * 45));
          if (angleSet.size >= 2) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * parallax スコアを計算
   */
  private calculateParallaxScore(frames: FrameDiffResult[]): number {
    // パララックスの特徴:
    // 1. 複数のモーションベクトルが異なる速度を持つ
    // 2. 同じ方向だが異なるmagnitude
    // 3. 複数フレームで一貫してこのパターンが見られる

    let parallaxFrameCount = 0;
    let sameDirectionCount = 0;

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length >= 2) {
        const validVectors = frame.motionVectors.filter((v) => v.magnitude > 0.5);
        if (validVectors.length < 2) continue;

        const magnitudes = validVectors.map((v) => v.magnitude).sort((a, b) => a - b);
        const angles = validVectors.map((v) => calculateAngle(v.dx, v.dy));

        // 速度差を確認
        const minMag = magnitudes[0] ?? 0;
        const maxMag = magnitudes[magnitudes.length - 1] ?? 0;

        if (maxMag > 0 && minMag > 0) {
          const ratio = minMag / maxMag;
          if (ratio < 0.7 && ratio > 0.1) {
            parallaxFrameCount++;

            // 方向の一貫性をチェック
            const avgAngle = average(angles);
            const angleDeviation = angles.map((a) => Math.abs(a - avgAngle)).reduce((a, b) => a + b, 0) / angles.length;
            if (angleDeviation < 30) {
              sameDirectionCount++;
            }
          }
        }
      }
    }

    // 複数フレームでパララックスパターンが検出されたら高スコア
    if (parallaxFrameCount >= frames.length * 0.5 && sameDirectionCount >= frames.length * 0.3) {
      return 0.92;
    }

    if (parallaxFrameCount >= frames.length * 0.3) {
      return 0.85;
    }

    if (parallaxFrameCount > 0) {
      return 0.6;
    }

    return 0.1;
  }

  /**
   * 単調増加/減少シーケンスかチェック
   */
  private isMonotonicSequence(values: number[]): boolean {
    if (values.length < 2) return true;

    let increasing = true;
    let decreasing = true;

    for (let i = 1; i < values.length; i++) {
      const current = values[i];
      const prev = values[i - 1];
      if (current === undefined || prev === undefined) continue;
      if (current < prev - 0.001) {
        increasing = false;
      }
      if (current > prev + 0.001) {
        decreasing = false;
      }
    }

    return increasing || decreasing;
  }

  /**
   * サイズ変化を検出（scaleパターンの特徴）
   */
  private detectSizeChange(frames: FrameDiffResult[]): boolean {
    const sizes: number[] = [];
    const centers: Array<{ x: number; y: number }> = [];

    for (const frame of frames) {
      if (frame.boundingBox) {
        const size = frame.boundingBox.width * frame.boundingBox.height;
        sizes.push(size);
        centers.push({
          x: frame.boundingBox.x + frame.boundingBox.width / 2,
          y: frame.boundingBox.y + frame.boundingBox.height / 2,
        });
      }
    }

    if (sizes.length < 2) return false;

    // サイズ変化率を計算
    const firstSize = sizes[0] ?? 1;
    const lastSize = sizes[sizes.length - 1] ?? 1;
    const sizeRatio = lastSize / firstSize;

    // 中心位置の安定性をチェック（アスペクト比変更時も許容）
    const centerVarianceX = variance(centers.map((c) => c.x));
    const centerVarianceY = variance(centers.map((c) => c.y));
    // 中心変動が大きい場合でも、サイズ変化が顕著なら許容
    const centerStable = centerVarianceX < 500 && centerVarianceY < 500;

    // サイズが1.3倍以上または0.77倍以下で、中心がある程度安定している場合はscaleの特徴
    const significantSizeChange = sizeRatio > 1.3 || sizeRatio < 0.77;

    return significantSizeChange && centerStable;
  }

  /**
   * 最適なカテゴリを選択
   */
  private selectBestCategory(
    scores: Map<VisualMotionCategory, number>,
    metrics: CategoryMetrics,
    frames: FrameDiffResult[],
    startTime: number
  ): CategoryClassificationResult {
    // スコアをソート
    const sortedScores = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);

    const first = sortedScores[0] ?? (['unknown', 0] as const);
    const [bestCategory, bestScore] = first;
    const second = sortedScores.length > 1 ? (sortedScores[1] ?? (['unknown', 0] as const)) : (['unknown', 0] as const);
    const [secondCategory, secondScore] = second;

    // 有効なカテゴリの数をカウント（static, unknown以外で閾値を超えているもの）
    const significantScores = sortedScores.filter(
      ([cat, score]) =>
        score > this.config.complex_category_threshold && cat !== 'static' && cat !== 'unknown'
    );

    // 複合カテゴリの判定
    // fade + slide の特別なケースをチェック
    const fadeScore = scores.get('fade') ?? 0;
    const slideScore = scores.get('slide') ?? 0;

    // fade + slide の複合パターンの条件:
    // - fadeとslide両方が0.5以上
    // - diffPercentageが単調変化している（fade特性）
    // - モーションベクトルが一貫している（slide特性）
    const diffs = frames.map(f => f.diffPercentage);
    const isMonotonicDiff = this.isMonotonicSequence(diffs);

    // scaleスコアが非常に高い場合はfade+slideの複合とは判定しない
    const scaleScore = scores.get('scale') ?? 0;
    const isFadeSlideComplex =
      fadeScore >= 0.5 &&
      slideScore >= 0.5 &&
      isMonotonicDiff &&
      fadeScore + slideScore > 1.3 &&
      scaleScore < 0.9; // scaleが明確に高い場合は除外

    // 一般的な複合パターンの条件:
    // - 2つ以上の有効なカテゴリがあり、両方が0.6以上
    // - スコア差が0.15未満（非常に競合）
    // - 最高スコアが0.9未満（0.9以上なら明確な勝者がいる）
    const isGeneralComplex =
      significantScores.length >= 2 &&
      secondScore >= 0.6 &&
      bestScore - secondScore < 0.15 &&
      bestScore < 0.9 &&
      bestCategory !== 'static' &&
      secondCategory !== 'static';

    const isComplex = isFadeSlideComplex || isGeneralComplex;

    if (isComplex) {
      return this.createComplexResult(sortedScores, metrics, frames, startTime);
    }

    // ノイズ/不一貫性によるペナルティを計算
    const noisePenalty = this.calculateNoisePenalty(frames);
    const adjustedConfidence = clamp(bestScore - noisePenalty, 0, 1);

    // 調整後の信頼度が閾値未満の場合は unknown
    if (adjustedConfidence < this.config.min_confidence_threshold) {
      return {
        primary_category: 'unknown',
        confidence: adjustedConfidence,
        metrics,
        processing_time_ms: performance.now() - startTime,
      };
    }

    // 詳細を生成
    const details = this.generateDetails(bestCategory, frames, metrics);

    const result: CategoryClassificationResult = {
      primary_category: bestCategory,
      confidence: adjustedConfidence,
      metrics,
      processing_time_ms: performance.now() - startTime,
    };
    if (details) {
      result.details = details;
    }
    return result;
  }

  /**
   * ノイズ/不一貫性によるペナルティを計算
   */
  private calculateNoisePenalty(frames: FrameDiffResult[]): number {
    // モーションベクトルの方向の分散をチェック
    const angles: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors) {
        for (const v of frame.motionVectors) {
          if (v.magnitude > 0.5) {
            angles.push(calculateAngle(v.dx, v.dy));
          }
        }
      }
    }

    if (angles.length < 3) return 0;

    // 角度の循環分散を計算
    const sinSum = angles.reduce((sum, a) => sum + Math.sin(degToRad(a)), 0);
    const cosSum = angles.reduce((sum, a) => sum + Math.cos(degToRad(a)), 0);
    const r = Math.sqrt(
      Math.pow(sinSum / angles.length, 2) + Math.pow(cosSum / angles.length, 2)
    );

    // r=1 で完全に一貫、r=0 でランダム
    // 一貫性が低い（r < 0.5）場合にペナルティを適用
    if (r < 0.3) {
      return 0.5; // 大きなペナルティ（ランダムノイズに近い）
    } else if (r < 0.5) {
      return 0.3; // 中程度のペナルティ
    } else if (r < 0.7) {
      return 0.1; // 小さなペナルティ
    }

    return 0;
  }

  /**
   * complex結果を生成
   */
  private createComplexResult(
    sortedScores: Array<[VisualMotionCategory, number]>,
    metrics: CategoryMetrics,
    _frames: FrameDiffResult[],
    startTime: number
  ): CategoryClassificationResult {
    const significantCategories = sortedScores.filter(
      ([cat, score]) => score > this.config.complex_category_threshold && cat !== 'static' && cat !== 'unknown'
    );

    // 重みを正規化
    const totalWeight = significantCategories.reduce((sum, [, score]) => sum + score, 0);
    const secondary_categories = significantCategories.map(([category, score]) => ({
      category,
      weight: totalWeight > 0 ? score / totalWeight : 0,
    }));

    // 平均信頼度
    const avgConfidence = average(significantCategories.map(([, score]) => score));

    return {
      primary_category: 'complex',
      confidence: clamp(avgConfidence, 0, 1),
      secondary_categories,
      metrics,
      processing_time_ms: performance.now() - startTime,
    };
  }

  /**
   * カテゴリ詳細を生成
   */
  private generateDetails(
    category: VisualMotionCategory,
    frames: FrameDiffResult[],
    metrics: CategoryMetrics
  ): CategoryDetails | undefined {
    switch (category) {
      case 'fade':
        return this.generateFadeDetails(frames);
      case 'slide':
        return this.generateSlideDetails(frames, metrics);
      case 'scale':
        return this.generateScaleDetails(frames);
      case 'parallax':
        return this.generateParallaxDetails(frames);
      default:
        return undefined;
    }
  }

  /**
   * フェード詳細を生成
   */
  private generateFadeDetails(frames: FrameDiffResult[]): CategoryDetails {
    const diffs = frames.map((f) => f.diffPercentage);
    const firstDiff = diffs[0] || 0;
    const lastDiff = diffs[diffs.length - 1] || 0;

    // フェードイン: 変化が減少（最初が大きい）
    // フェードアウト: 変化が増加（最後が大きい）
    const type: FadeType = firstDiff > lastDiff ? 'in' : 'out';

    // opacity推定（diffPercentageから）
    const start_opacity = type === 'in' ? 0 : 1;
    const end_opacity = type === 'in' ? 1 : 0;

    return {
      fade: {
        type,
        start_opacity,
        end_opacity,
        duration_frames: frames.length,
      },
    };
  }

  /**
   * スライド詳細を生成
   */
  private generateSlideDetails(
    frames: FrameDiffResult[],
    metrics: CategoryMetrics
  ): CategoryDetails {
    // 方向を判定
    let angle = metrics.dominant_direction ?? 0;
    let direction: SlideDirection;

    // 角度から方向を決定
    const normalizedAngle = angle % 360;
    if (
      (normalizedAngle >= 0 && normalizedAngle < 22.5) ||
      (normalizedAngle >= 337.5 && normalizedAngle < 360) ||
      (normalizedAngle >= 157.5 && normalizedAngle < 202.5)
    ) {
      direction = 'horizontal';
      // 正確な角度を設定
      angle = normalizedAngle < 90 || normalizedAngle > 270 ? 0 : 180;
    } else if (
      (normalizedAngle >= 67.5 && normalizedAngle < 112.5) ||
      (normalizedAngle >= 247.5 && normalizedAngle < 292.5)
    ) {
      direction = 'vertical';
      // 正確な角度を設定
      angle = normalizedAngle < 180 ? 90 : 270;
    } else {
      direction = 'diagonal';
    }

    // 移動距離を計算
    const distance = this.calculateTotalDistance(frames);

    return {
      slide: {
        direction,
        distance_px: distance,
        angle_degrees: Math.round(angle),
      },
    };
  }

  /**
   * 総移動距離を計算
   */
  private calculateTotalDistance(frames: FrameDiffResult[]): number {
    let totalDistance = 0;

    // モーションベクトルから計算
    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length > 0) {
        const mainVector = frame.motionVectors.reduce((max, v) =>
          v.magnitude > max.magnitude ? v : max
        );
        totalDistance += mainVector.magnitude;
      }
    }

    if (totalDistance > 0) {
      return Math.round(totalDistance);
    }

    // boundingBoxから計算
    const positions: Array<{ x: number; y: number }> = [];
    for (const frame of frames) {
      if (frame.boundingBox) {
        positions.push({
          x: frame.boundingBox.x,
          y: frame.boundingBox.y,
        });
      }
    }

    if (positions.length >= 2) {
      const first = positions[0];
      const last = positions[positions.length - 1];
      if (first !== undefined && last !== undefined) {
        return Math.round(Math.sqrt(Math.pow(last.x - first.x, 2) + Math.pow(last.y - first.y, 2)));
      }
    }

    return 0;
  }

  /**
   * スケール詳細を生成
   */
  private generateScaleDetails(frames: FrameDiffResult[]): CategoryDetails {
    const sizes: Array<{ width: number; height: number }> = [];

    for (const frame of frames) {
      if (frame.boundingBox) {
        sizes.push({
          width: frame.boundingBox.width,
          height: frame.boundingBox.height,
        });
      }
    }

    if (sizes.length < 2) {
      return {
        scale: {
          type: 'expand',
          start_scale: 1,
          end_scale: 1,
          aspect_ratio_maintained: true,
        },
      };
    }

    const firstSize = sizes[0];
    const lastSize = sizes[sizes.length - 1];

    // Early return if sizes are undefined (TypeScript safety)
    if (firstSize === undefined || lastSize === undefined) {
      return {
        scale: {
          type: 'expand' as const,
          start_scale: 1,
          end_scale: 1,
          aspect_ratio_maintained: true,
        },
      };
    }

    const firstArea = firstSize.width * firstSize.height;
    const lastArea = lastSize.width * lastSize.height;

    const type: ScaleType = lastArea > firstArea ? 'expand' : 'shrink';

    // 基準を100として、スケール比率を計算
    const startScale = 1;
    const endScale = lastArea > 0 ? Math.sqrt(lastArea / firstArea) : 1;

    // アスペクト比の維持をチェック
    const firstRatio = firstSize.width / firstSize.height;
    const lastRatio = lastSize.width / lastSize.height;
    const aspect_ratio_maintained = Math.abs(firstRatio - lastRatio) < 0.1;

    return {
      scale: {
        type,
        start_scale: startScale,
        end_scale: endScale,
        aspect_ratio_maintained,
      },
    };
  }

  /**
   * パララックス詳細を生成
   */
  private generateParallaxDetails(frames: FrameDiffResult[]): CategoryDetails {
    const layerSpeeds: number[] = [];

    for (const frame of frames) {
      if (frame.motionVectors && frame.motionVectors.length >= 2) {
        for (const vector of frame.motionVectors) {
          if (!layerSpeeds.includes(vector.magnitude)) {
            layerSpeeds.push(vector.magnitude);
          }
        }
      }
    }

    // 重複を除去してソート
    const uniqueSpeeds = [...new Set(layerSpeeds)].sort((a, b) => a - b);
    const maxSpeed = Math.max(...uniqueSpeeds, 1);

    const speed_ratios = uniqueSpeeds.map((s) => s / maxSpeed);
    const layer_count = speed_ratios.length;
    const depth_order = Array.from({ length: layer_count }, (_, i) => i);

    return {
      parallax: {
        layer_count,
        speed_ratios,
        depth_order,
      },
    };
  }
}

export default VisualCategoryClassifier;
