// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLAnimationCategorizer
 *
 * ルールベースでWebGLアニメーションパターンを分類するサービス
 *
 * 分類カテゴリ:
 * - fade: 全体的に均一な変化、低changeRatio
 * - pulse: 周期的で高低差が大きい
 * - wave: 中程度の変化が連続、方向性あり
 * - particle: 散発的で高changeRatio
 * - rotation: 一定の周期で変化
 * - parallax: スクロール連動
 * - noise: ランダムな変化パターン
 * - complex: 上記に該当しない
 *
 * @module services/motion/webgl-animation-categorizer
 */

import { createLogger, isDevelopment } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * WebGLアニメーションカテゴリ
 */
export type WebGLAnimationCategory =
  | 'fade'
  | 'pulse'
  | 'wave'
  | 'particle'
  | 'rotation'
  | 'parallax'
  | 'noise'
  | 'complex';

/**
 * カテゴリ分類のための特徴データ
 */
export interface AnimationFeatures {
  /** 平均変化率 (0-1) */
  avgChangeRatio: number;
  /** 最大変化率 (0-1) */
  maxChangeRatio: number;
  /** 最小変化率 (0-1) */
  minChangeRatio: number;
  /** 変化率の標準偏差 */
  stdDeviation: number;
  /** 周期性スコア (0-1) */
  periodicityScore: number;
  /** 推定周期（フレーム数） */
  estimatedPeriod: number;
  /** 変化の方向性スコア (0-1) */
  directionalScore: number;
  /** 散発性スコア (0-1) */
  sporadicScore: number;
  /** ランダム性スコア (0-1) */
  randomnessScore: number;
}

/**
 * 分類結果
 */
export interface CategorizationResult {
  /** 分類されたカテゴリ */
  category: WebGLAnimationCategory;
  /** 信頼度 (0-1) */
  confidence: number;
  /** 分類の理由 */
  reasons: string[];
  /** 各カテゴリのスコア */
  scores: Record<WebGLAnimationCategory, number>;
}

/**
 * 分類オプション
 */
export interface CategorizationOptions {
  /** 最小信頼度 (デフォルト: 0.3) */
  minConfidence?: number;
  /** 周期検出の最大周期 (デフォルト: 60 フレーム) */
  maxPeriodFrames?: number;
}

// =====================================================
// 定数
// =====================================================

const logger = createLogger('WebGLAnimationCategorizer');

/** デフォルトオプション */
const DEFAULT_OPTIONS: Required<CategorizationOptions> = {
  minConfidence: 0.3,
  maxPeriodFrames: 60,
};

/** カテゴリ分類の閾値 */
const THRESHOLDS = {
  /** fadeの最大変化率 */
  FADE_MAX_CHANGE: 0.05,
  /** fadeの最大標準偏差 */
  FADE_MAX_STD: 0.02,

  /** pulseの最小標準偏差 */
  PULSE_MIN_STD: 0.03,
  /** pulseの最小周期スコア */
  PULSE_MIN_PERIODICITY: 0.6,

  /** waveの最小方向性スコア */
  WAVE_MIN_DIRECTIONAL: 0.5,
  /** waveの変化率範囲 */
  WAVE_CHANGE_MIN: 0.02,
  WAVE_CHANGE_MAX: 0.2,

  /** particleの最小散発性スコア */
  PARTICLE_MIN_SPORADIC: 0.6,
  /** particleの最小変化率 */
  PARTICLE_MIN_CHANGE: 0.1,

  /** rotationの最小周期スコア */
  ROTATION_MIN_PERIODICITY: 0.7,
  /** rotationの変化率範囲 */
  ROTATION_CHANGE_MIN: 0.03,
  ROTATION_CHANGE_MAX: 0.15,

  /** parallaxの最小方向性スコア */
  PARALLAX_MIN_DIRECTIONAL: 0.7,
  /** parallaxの変化率範囲 */
  PARALLAX_CHANGE_MIN: 0.01,
  PARALLAX_CHANGE_MAX: 0.1,

  /** noiseの最小ランダム性スコア */
  NOISE_MIN_RANDOMNESS: 0.7,

  /** complexと判定するための最小変化率 */
  COMPLEX_MIN_CHANGE: 0.15,
} as const;

// =====================================================
// WebGLAnimationCategorizer クラス
// =====================================================

/**
 * WebGLアニメーションパターン分類クラス
 *
 * changeRatio時系列データから特徴を抽出し、
 * ルールベースでカテゴリを分類します。
 */
export class WebGLAnimationCategorizer {
  private readonly options: Required<CategorizationOptions>;

  constructor(options?: CategorizationOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    if (isDevelopment()) {
      logger.debug('[WebGLAnimationCategorizer] Initialized', {
        options: this.options,
      });
    }
  }

  /**
   * changeRatio時系列データからカテゴリを分類
   *
   * @param changeRatios - 各フレームペアの変化率配列 (0-1)
   * @returns 分類結果
   */
  categorize(changeRatios: number[]): CategorizationResult {
    const startTime = Date.now();

    if (changeRatios.length < 2) {
      return this.createDefaultResult('complex', 0, ['Insufficient data for categorization']);
    }

    // 特徴抽出
    const features = this.extractFeatures(changeRatios);

    // 各カテゴリのスコアを計算
    const scores = this.calculateScores(features);

    // 最高スコアのカテゴリを選択
    const result = this.selectCategory(scores, features);

    if (isDevelopment()) {
      logger.debug('[WebGLAnimationCategorizer] Categorization complete', {
        category: result.category,
        confidence: result.confidence,
        processingTimeMs: Date.now() - startTime,
      });
    }

    return result;
  }

  /**
   * 特徴を抽出
   */
  extractFeatures(changeRatios: number[]): AnimationFeatures {
    // 基本統計量
    const avgChangeRatio = this.calculateMean(changeRatios);
    const maxChangeRatio = Math.max(...changeRatios);
    const minChangeRatio = Math.min(...changeRatios);
    const stdDeviation = this.calculateStdDev(changeRatios, avgChangeRatio);

    // 周期性検出（自己相関法）
    const { periodicityScore, estimatedPeriod } = this.detectPeriodicity(changeRatios);

    // 方向性スコア（連続的な変化の傾向）
    const directionalScore = this.calculateDirectionalScore(changeRatios);

    // 散発性スコア（急激な変化の頻度）
    const sporadicScore = this.calculateSporadicScore(changeRatios, avgChangeRatio);

    // ランダム性スコア
    const randomnessScore = this.calculateRandomnessScore(changeRatios);

    return {
      avgChangeRatio,
      maxChangeRatio,
      minChangeRatio,
      stdDeviation,
      periodicityScore,
      estimatedPeriod,
      directionalScore,
      sporadicScore,
      randomnessScore,
    };
  }

  // =====================================================
  // プライベートメソッド: 統計計算
  // =====================================================

  /**
   * 平均を計算
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * 標準偏差を計算
   */
  private calculateStdDev(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length);
  }

  /**
   * 自己相関を使って周期性を検出
   */
  private detectPeriodicity(
    changeRatios: number[]
  ): { periodicityScore: number; estimatedPeriod: number } {
    const n = changeRatios.length;
    const maxLag = Math.min(this.options.maxPeriodFrames, Math.floor(n / 2));

    if (maxLag < 2) {
      return { periodicityScore: 0, estimatedPeriod: 0 };
    }

    const mean = this.calculateMean(changeRatios);
    const variance = this.calculateVariance(changeRatios, mean);

    if (variance === 0) {
      return { periodicityScore: 0, estimatedPeriod: 0 };
    }

    // 各ラグで自己相関を計算
    const autocorrelations: number[] = [];
    for (let lag = 1; lag <= maxLag; lag++) {
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

    // ピークを検出（最初の正のピーク）
    let maxAutocorr = 0;
    let estimatedPeriod = 0;
    let foundFirstMin = false;

    for (let i = 1; i < autocorrelations.length - 1; i++) {
      const prev = autocorrelations[i - 1] ?? 0;
      const curr = autocorrelations[i] ?? 0;
      const next = autocorrelations[i + 1] ?? 0;

      // 最初の極小値を通過したかチェック
      if (!foundFirstMin && curr < prev && curr < next) {
        foundFirstMin = true;
      }

      // 最初の極小値を過ぎた後のピークを探す
      if (foundFirstMin && curr > prev && curr > next && curr > maxAutocorr) {
        maxAutocorr = curr;
        estimatedPeriod = i + 1; // lagは1から始まる
      }
    }

    // 周期スコアを正規化（0-1）
    const periodicityScore = Math.max(0, Math.min(1, maxAutocorr));

    return { periodicityScore, estimatedPeriod };
  }

  /**
   * 分散を計算
   */
  private calculateVariance(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    return squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * 方向性スコアを計算（連続的に同じ方向に変化する傾向）
   */
  private calculateDirectionalScore(changeRatios: number[]): number {
    if (changeRatios.length < 3) return 0;

    let sameDirectionCount = 0;
    let totalComparisons = 0;

    for (let i = 1; i < changeRatios.length - 1; i++) {
      const prev = changeRatios[i - 1];
      const curr = changeRatios[i];
      const next = changeRatios[i + 1];

      if (prev === undefined || curr === undefined || next === undefined) continue;

      const diff1 = curr - prev;
      const diff2 = next - curr;

      // 同じ方向に変化しているかチェック（符号が同じ）
      if ((diff1 >= 0 && diff2 >= 0) || (diff1 <= 0 && diff2 <= 0)) {
        sameDirectionCount++;
      }
      totalComparisons++;
    }

    return totalComparisons > 0 ? sameDirectionCount / totalComparisons : 0;
  }

  /**
   * 散発性スコアを計算（急激な変化の頻度）
   */
  private calculateSporadicScore(changeRatios: number[], mean: number): number {
    if (changeRatios.length < 2) return 0;

    const threshold = mean * 2; // 平均の2倍以上を「急激」とする
    let sporadicCount = 0;

    for (let i = 1; i < changeRatios.length; i++) {
      const prev = changeRatios[i - 1];
      const curr = changeRatios[i];

      if (prev === undefined || curr === undefined) continue;

      const diff = Math.abs(curr - prev);
      if (diff > threshold) {
        sporadicCount++;
      }
    }

    return sporadicCount / (changeRatios.length - 1);
  }

  /**
   * ランダム性スコアを計算（予測不可能性）
   */
  private calculateRandomnessScore(changeRatios: number[]): number {
    if (changeRatios.length < 3) return 0;

    // 連の数をカウント（同じ方向への連続変化）
    let runs = 1;
    for (let i = 2; i < changeRatios.length; i++) {
      const prev2 = changeRatios[i - 2];
      const prev1 = changeRatios[i - 1];
      const curr = changeRatios[i];

      if (prev2 === undefined || prev1 === undefined || curr === undefined) continue;

      const direction1 = prev1 - prev2;
      const direction2 = curr - prev1;

      // 方向が変わったら新しい連
      if ((direction1 >= 0 && direction2 < 0) || (direction1 < 0 && direction2 >= 0)) {
        runs++;
      }
    }

    // ランダムシーケンスでは連の数は約 (n-1)/2
    const n = changeRatios.length;
    const expectedRuns = (n - 1) / 2;

    // 実際の連の数が期待値に近いほどランダム性が高い
    const deviation = Math.abs(runs - expectedRuns) / expectedRuns;
    return Math.max(0, 1 - deviation);
  }

  // =====================================================
  // プライベートメソッド: スコア計算
  // =====================================================

  /**
   * 各カテゴリのスコアを計算
   */
  private calculateScores(features: AnimationFeatures): Record<WebGLAnimationCategory, number> {
    return {
      fade: this.calculateFadeScore(features),
      pulse: this.calculatePulseScore(features),
      wave: this.calculateWaveScore(features),
      particle: this.calculateParticleScore(features),
      rotation: this.calculateRotationScore(features),
      parallax: this.calculateParallaxScore(features),
      noise: this.calculateNoiseScore(features),
      complex: this.calculateComplexScore(features),
    };
  }

  /**
   * fadeスコア: 全体的に均一な変化、低changeRatio
   */
  private calculateFadeScore(features: AnimationFeatures): number {
    let score = 0;

    // 低い変化率
    if (features.avgChangeRatio < THRESHOLDS.FADE_MAX_CHANGE) {
      score += 0.4;
    }

    // 低い標準偏差（均一性）
    if (features.stdDeviation < THRESHOLDS.FADE_MAX_STD) {
      score += 0.4;
    }

    // 高い方向性（一定方向への変化）
    if (features.directionalScore > 0.6) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * pulseスコア: 周期的で高低差が大きい
   */
  private calculatePulseScore(features: AnimationFeatures): number {
    let score = 0;

    // 高い周期性
    if (features.periodicityScore > THRESHOLDS.PULSE_MIN_PERIODICITY) {
      score += 0.5;
    }

    // 高い標準偏差（高低差）
    if (features.stdDeviation > THRESHOLDS.PULSE_MIN_STD) {
      score += 0.3;
    }

    // 適度な変化率
    if (features.avgChangeRatio > 0.02 && features.avgChangeRatio < 0.2) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * waveスコア: 中程度の変化が連続、方向性あり
   */
  private calculateWaveScore(features: AnimationFeatures): number {
    let score = 0;

    // 高い方向性
    if (features.directionalScore > THRESHOLDS.WAVE_MIN_DIRECTIONAL) {
      score += 0.4;
    }

    // 中程度の変化率
    if (
      features.avgChangeRatio >= THRESHOLDS.WAVE_CHANGE_MIN &&
      features.avgChangeRatio <= THRESHOLDS.WAVE_CHANGE_MAX
    ) {
      score += 0.3;
    }

    // 適度な周期性
    if (features.periodicityScore > 0.3 && features.periodicityScore < 0.8) {
      score += 0.3;
    }

    return Math.min(1, score);
  }

  /**
   * particleスコア: 散発的で高changeRatio
   */
  private calculateParticleScore(features: AnimationFeatures): number {
    let score = 0;

    // 高い散発性
    if (features.sporadicScore > THRESHOLDS.PARTICLE_MIN_SPORADIC) {
      score += 0.4;
    }

    // 高い変化率
    if (features.avgChangeRatio > THRESHOLDS.PARTICLE_MIN_CHANGE) {
      score += 0.3;
    }

    // 低い周期性
    if (features.periodicityScore < 0.3) {
      score += 0.3;
    }

    return Math.min(1, score);
  }

  /**
   * rotationスコア: 一定の周期で変化
   */
  private calculateRotationScore(features: AnimationFeatures): number {
    let score = 0;

    // 高い周期性
    if (features.periodicityScore > THRESHOLDS.ROTATION_MIN_PERIODICITY) {
      score += 0.5;
    }

    // 適度な変化率
    if (
      features.avgChangeRatio >= THRESHOLDS.ROTATION_CHANGE_MIN &&
      features.avgChangeRatio <= THRESHOLDS.ROTATION_CHANGE_MAX
    ) {
      score += 0.3;
    }

    // 低い散発性
    if (features.sporadicScore < 0.3) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * parallaxスコア: スクロール連動（高い方向性、低い変化率）
   */
  private calculateParallaxScore(features: AnimationFeatures): number {
    let score = 0;

    // 高い方向性
    if (features.directionalScore > THRESHOLDS.PARALLAX_MIN_DIRECTIONAL) {
      score += 0.4;
    }

    // 低い変化率
    if (
      features.avgChangeRatio >= THRESHOLDS.PARALLAX_CHANGE_MIN &&
      features.avgChangeRatio <= THRESHOLDS.PARALLAX_CHANGE_MAX
    ) {
      score += 0.4;
    }

    // 低い散発性
    if (features.sporadicScore < 0.2) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * noiseスコア: ランダムな変化パターン
   */
  private calculateNoiseScore(features: AnimationFeatures): number {
    let score = 0;

    // 高いランダム性
    if (features.randomnessScore > THRESHOLDS.NOISE_MIN_RANDOMNESS) {
      score += 0.5;
    }

    // 低い周期性
    if (features.periodicityScore < 0.3) {
      score += 0.3;
    }

    // 低い方向性
    if (features.directionalScore < 0.3) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * complexスコア: 上記に該当しない複雑なパターン
   */
  private calculateComplexScore(features: AnimationFeatures): number {
    // 高い変化率で他のカテゴリの条件を満たさない場合
    if (features.avgChangeRatio > THRESHOLDS.COMPLEX_MIN_CHANGE) {
      return 0.3;
    }

    // 標準偏差が高く、明確なパターンがない場合
    if (features.stdDeviation > 0.05 && features.periodicityScore < 0.5) {
      return 0.3;
    }

    return 0.1; // デフォルトは低スコア
  }

  // =====================================================
  // プライベートメソッド: カテゴリ選択
  // =====================================================

  /**
   * スコアから最適なカテゴリを選択
   */
  private selectCategory(
    scores: Record<WebGLAnimationCategory, number>,
    features: AnimationFeatures
  ): CategorizationResult {
    const categories = Object.keys(scores) as WebGLAnimationCategory[];
    let maxScore = 0;
    let selectedCategory: WebGLAnimationCategory = 'complex';

    for (const category of categories) {
      const score = scores[category] ?? 0;
      if (score > maxScore) {
        maxScore = score;
        selectedCategory = category;
      }
    }

    // 最低信頼度を下回る場合はcomplexに
    if (maxScore < this.options.minConfidence) {
      selectedCategory = 'complex';
      maxScore = scores.complex ?? 0.1;
    }

    // 理由を生成
    const reasons = this.generateReasons(selectedCategory, features);

    return {
      category: selectedCategory,
      confidence: maxScore,
      reasons,
      scores,
    };
  }

  /**
   * 分類理由を生成
   */
  private generateReasons(category: WebGLAnimationCategory, features: AnimationFeatures): string[] {
    const reasons: string[] = [];

    switch (category) {
      case 'fade':
        reasons.push(`Low average change ratio (${(features.avgChangeRatio * 100).toFixed(2)}%)`);
        reasons.push(`Uniform change pattern (std: ${features.stdDeviation.toFixed(4)})`);
        break;

      case 'pulse':
        reasons.push(`High periodicity score (${features.periodicityScore.toFixed(2)})`);
        reasons.push(`Estimated period: ${features.estimatedPeriod} frames`);
        break;

      case 'wave':
        reasons.push(`High directional score (${features.directionalScore.toFixed(2)})`);
        reasons.push(
          `Moderate change ratio (${(features.avgChangeRatio * 100).toFixed(2)}%)`
        );
        break;

      case 'particle':
        reasons.push(`High sporadic score (${features.sporadicScore.toFixed(2)})`);
        reasons.push(`High change ratio (${(features.avgChangeRatio * 100).toFixed(2)}%)`);
        break;

      case 'rotation':
        reasons.push(`High periodicity (${features.periodicityScore.toFixed(2)})`);
        reasons.push(`Consistent cycle at ${features.estimatedPeriod} frames`);
        break;

      case 'parallax':
        reasons.push(`High directional consistency (${features.directionalScore.toFixed(2)})`);
        reasons.push(`Low change ratio (${(features.avgChangeRatio * 100).toFixed(2)}%)`);
        break;

      case 'noise':
        reasons.push(`High randomness score (${features.randomnessScore.toFixed(2)})`);
        reasons.push(`Low periodicity (${features.periodicityScore.toFixed(2)})`);
        break;

      case 'complex':
        reasons.push('Does not match simple pattern categories');
        reasons.push(`Change ratio: ${(features.avgChangeRatio * 100).toFixed(2)}%`);
        break;
    }

    return reasons;
  }

  /**
   * デフォルト結果を作成
   */
  private createDefaultResult(
    category: WebGLAnimationCategory,
    confidence: number,
    reasons: string[]
  ): CategorizationResult {
    const emptyScores: Record<WebGLAnimationCategory, number> = {
      fade: 0,
      pulse: 0,
      wave: 0,
      particle: 0,
      rotation: 0,
      parallax: 0,
      noise: 0,
      complex: confidence,
    };

    return {
      category,
      confidence,
      reasons,
      scores: emptyScores,
    };
  }
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * WebGLAnimationCategorizerインスタンスを作成
 */
export function createWebGLAnimationCategorizer(
  options?: CategorizationOptions
): WebGLAnimationCategorizer {
  return new WebGLAnimationCategorizer(options);
}
