// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionEmbedding - モーションパターンをベクトル化し類似検索を可能にするモジュール
 *
 * モーションパターンの特徴量を抽出し、64次元のEmbeddingベクトルに変換します。
 * 生成されたEmbeddingはL2正規化され、コサイン類似度による類似検索が可能です。
 *
 * @module @reftrix/webdesign-core/motion-detector/motion-embedding
 */

import type { MotionPattern, KeyframeStep } from './types';

// =========================================
// Constants
// =========================================

/** Embedding次元数 */
export const MOTION_EMBEDDING_DIM = 64;

/** プロパティ特徴量の次元数 */
const PROPERTY_FEATURES_DIM = 16;

/** タイミング特徴量の次元数 */
const TIMING_FEATURES_DIM = 16;

/** イージング特徴量の次元数 */
const EASING_FEATURES_DIM = 16;

/** キーフレーム特徴量の次元数 */
const KEYFRAME_FEATURES_DIM = 16;

/** GPUアクセラレーション対応プロパティ */
const GPU_ACCELERATED_PROPERTIES = ['transform', 'opacity', 'filter'] as const;

/** レイアウトトリガープロパティ */
const LAYOUT_TRIGGERING_PROPERTIES = [
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'padding',
  'border-width',
  'font-size',
  'line-height',
] as const;

/** ペイントトリガープロパティ */
const PAINT_TRIGGERING_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'box-shadow',
  'text-shadow',
  'border-radius',
  'outline',
] as const;

/** イージングキーワードとcubic-bezier値のマップ */
const EASING_KEYWORDS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** モーションタイプのインデックスマップ */
const MOTION_TYPE_INDEX: Record<MotionPattern['type'], number> = {
  animation: 0,
  transition: 1,
  transform: 2,
  scroll: 3,
  hover: 4,
  keyframe: 5,
};

/** トリガータイプのインデックスマップ */
const TRIGGER_TYPE_INDEX: Record<MotionPattern['trigger'], number> = {
  load: 0,
  hover: 1,
  scroll: 2,
  click: 3,
  focus: 4,
  custom: 5,
};

/** 方向タイプのインデックスマップ */
const DIRECTION_INDEX: Record<MotionPattern['direction'], number> = {
  normal: 0,
  reverse: 1,
  alternate: 2,
  'alternate-reverse': 3,
};

/** フィルモードのインデックスマップ */
const FILL_MODE_INDEX: Record<MotionPattern['fillMode'], number> = {
  none: 0,
  forwards: 1,
  backwards: 2,
  both: 3,
};

// =========================================
// Types
// =========================================

/**
 * 類似度計算結果
 */
export interface SimilarityResult {
  /** 候補リスト内のインデックス */
  index: number;
  /** 類似度スコア (-1 to 1) */
  similarity: number;
}

// =========================================
// MotionFeatureExtractor Class
// =========================================

/**
 * MotionFeatureExtractor - モーションパターンから特徴量を抽出
 *
 * @example
 * ```typescript
 * const extractor = new MotionFeatureExtractor();
 * const propertyFeatures = extractor.extractPropertyFeatures(pattern);
 * const timingFeatures = extractor.extractTimingFeatures(pattern);
 * ```
 */
export class MotionFeatureExtractor {
  /**
   * プロパティ特徴量を抽出
   *
   * @param pattern - モーションパターン
   * @returns プロパティ特徴量ベクトル
   */
  public extractPropertyFeatures(pattern: MotionPattern): number[] {
    const features = new Array(PROPERTY_FEATURES_DIM).fill(0);

    if (pattern.properties.length === 0) {
      return features;
    }

    // プロパティ数の正規化 (0-1)
    features[0] = Math.min(pattern.properties.length / 10, 1);

    // GPUアクセラレーション対応プロパティのカウント
    let gpuCount = 0;
    let layoutCount = 0;
    let paintCount = 0;

    for (const prop of pattern.properties) {
      const propName = prop.name.toLowerCase();

      // GPUプロパティチェック
      if (GPU_ACCELERATED_PROPERTIES.some((p) => propName.includes(p))) {
        gpuCount++;
      }

      // レイアウトトリガープロパティチェック
      if (LAYOUT_TRIGGERING_PROPERTIES.some((p) => propName.includes(p))) {
        layoutCount++;
      }

      // ペイントトリガープロパティチェック
      if (PAINT_TRIGGERING_PROPERTIES.some((p) => propName.includes(p))) {
        paintCount++;
      }

      // 特定プロパティタイプのフラグ
      if (propName === 'opacity') features[4] = 1;
      if (propName === 'transform') features[5] = 1;
      if (propName === 'filter') features[6] = 1;
      if (propName.includes('color')) features[7] = 1;
      if (propName.includes('shadow')) features[8] = 1;
      if (propName.includes('width') || propName.includes('height'))
        features[9] = 1;
      if (propName.includes('margin') || propName.includes('padding'))
        features[10] = 1;
      if (propName.includes('border')) features[11] = 1;
    }

    // カウントの正規化
    features[1] = gpuCount > 0 ? Math.min(gpuCount / pattern.properties.length, 1) : 0;
    features[2] = layoutCount > 0 ? Math.min(layoutCount / pattern.properties.length, 1) : 0;
    features[3] = paintCount > 0 ? Math.min(paintCount / pattern.properties.length, 1) : 0;

    // キーフレームを持つプロパティの割合
    const keyframePropCount = pattern.properties.filter(
      (p) => p.keyframes && p.keyframes.length > 0
    ).length;
    features[12] = keyframePropCount / Math.max(pattern.properties.length, 1);

    // 値の変化量の推定（from/toの文字列長差分で近似）
    let totalValueChange = 0;
    for (const prop of pattern.properties) {
      const fromLen = prop.from?.length || 0;
      const toLen = prop.to?.length || 0;
      totalValueChange += Math.abs(toLen - fromLen);
    }
    features[13] = Math.min(totalValueChange / 100, 1);

    // モーションタイプのエンコード
    features[14] = MOTION_TYPE_INDEX[pattern.type] / 5;

    // トリガータイプのエンコード
    features[15] = TRIGGER_TYPE_INDEX[pattern.trigger] / 5;

    return features;
  }

  /**
   * タイミング特徴量を抽出
   *
   * @param pattern - モーションパターン
   * @returns タイミング特徴量ベクトル
   */
  public extractTimingFeatures(pattern: MotionPattern): number[] {
    const features = new Array(TIMING_FEATURES_DIM).fill(0);

    // Duration（対数スケールで正規化、0-10秒を0-1にマップ）
    const durationMs = pattern.duration;
    features[0] = Math.min(Math.log10(durationMs + 1) / 4, 1); // log10(10001) ~ 4

    // Delay（対数スケールで正規化）
    const delayMs = pattern.delay;
    features[1] = Math.min(Math.log10(delayMs + 1) / 4, 1);

    // Duration カテゴリ (instant, short, medium, long)
    if (durationMs === 0) {
      features[2] = 0; // instant
    } else if (durationMs < 300) {
      features[2] = 0.25; // short
    } else if (durationMs < 1000) {
      features[2] = 0.5; // medium
    } else if (durationMs < 3000) {
      features[2] = 0.75; // long
    } else {
      features[2] = 1; // very long
    }

    // Iterations
    if (pattern.iterations === 'infinite') {
      features[3] = 1;
      features[4] = 1; // infinite flag
    } else {
      features[3] = Math.min(pattern.iterations / 10, 1);
      features[4] = 0;
    }

    // Direction encoding
    features[5] = DIRECTION_INDEX[pattern.direction] / 3;

    // Fill mode encoding
    features[6] = FILL_MODE_INDEX[pattern.fillMode] / 3;

    // Play state
    features[7] = pattern.playState === 'running' ? 1 : 0;

    // Trigger type encoding
    features[8] = TRIGGER_TYPE_INDEX[pattern.trigger] / 5;

    // Confidence
    features[9] = pattern.confidence;

    // Duration/Delay ratio
    const totalTime = durationMs + delayMs;
    features[10] = totalTime > 0 ? durationMs / totalTime : 1;

    // Is looping (infinite or iterations > 1)
    features[11] =
      pattern.iterations === 'infinite' || pattern.iterations > 1 ? 1 : 0;

    // Is delayed
    features[12] = delayMs > 0 ? 1 : 0;

    // Has alternate direction
    features[13] =
      pattern.direction === 'alternate' ||
      pattern.direction === 'alternate-reverse'
        ? 1
        : 0;

    // Has fill mode
    features[14] = pattern.fillMode !== 'none' ? 1 : 0;

    // Speed category (fast < 300ms, normal 300-1000ms, slow > 1000ms)
    features[15] = durationMs < 300 ? 0 : durationMs < 1000 ? 0.5 : 1;

    return features;
  }

  /**
   * イージング特徴量を抽出
   *
   * @param easing - イージング関数文字列
   * @returns イージング特徴量ベクトル
   */
  public extractEasingFeatures(easing: string): number[] {
    const features = new Array(EASING_FEATURES_DIM).fill(0);
    const easingLower = easing.toLowerCase().trim();

    // キーワードイージングのチェック
    if (Object.prototype.hasOwnProperty.call(EASING_KEYWORDS, easingLower)) {
      const bezier = EASING_KEYWORDS[easingLower]!;
      features[0] = bezier[0]; // x1
      features[1] = bezier[1]; // y1
      features[2] = bezier[2]; // x2
      features[3] = bezier[3]; // y2

      // キーワードタイプのone-hotエンコード
      const keywords = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
      const idx = keywords.indexOf(easingLower);
      if (idx >= 0 && idx < 5) {
        features[4 + idx] = 1;
      }
    } else if (easingLower.startsWith('cubic-bezier')) {
      // cubic-bezier(x1, y1, x2, y2)をパース
      const match = easingLower.match(
        /cubic-bezier\s*\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/
      );
      if (match && match[1] && match[2] && match[3] && match[4]) {
        features[0] = parseFloat(match[1]);
        features[1] = parseFloat(match[2]);
        features[2] = parseFloat(match[3]);
        features[3] = parseFloat(match[4]);
        features[9] = 1; // cubic-bezier flag
      }
    } else if (easingLower.startsWith('steps')) {
      // steps(n, direction)をパース
      const match = easingLower.match(/steps\s*\(\s*(\d+)/);
      if (match && match[1]) {
        features[10] = 1; // steps flag
        features[11] = Math.min(parseInt(match[1], 10) / 20, 1); // step count normalized
      }

      // step direction
      if (easingLower.includes('start') || easingLower.includes('jump-start')) {
        features[12] = 0;
      } else if (easingLower.includes('end') || easingLower.includes('jump-end')) {
        features[12] = 1;
      } else {
        features[12] = 0.5; // both or none
      }
    }

    // イージング特性の推定
    // 開始時の加速度（y1の値が小さいほど緩やか）
    features[13] = features[1];
    // 終了時の減速度（y2-x2、正なら減速）
    features[14] = features[3] - features[2];
    // 全体の非線形度（linear: 0, その他: 非0）
    features[15] = easingLower === 'linear' ? 0 : 1;

    return features;
  }

  /**
   * キーフレーム特徴量を抽出
   *
   * @param keyframes - キーフレームステップ配列
   * @returns キーフレーム特徴量ベクトル
   */
  public extractKeyframeFeatures(keyframes: KeyframeStep[]): number[] {
    const features = new Array(KEYFRAME_FEATURES_DIM).fill(0);

    if (!keyframes || keyframes.length === 0) {
      return features;
    }

    // キーフレーム数（正規化）
    features[0] = Math.min(keyframes.length / 10, 1);

    // 開始・終了キーフレームの有無
    features[1] = keyframes.some((k) => k.offset === 0) ? 1 : 0;
    features[2] = keyframes.some((k) => k.offset === 1) ? 1 : 0;

    // 中間キーフレームの数（0と1以外）
    const middleKeyframes = keyframes.filter(
      (k) => k.offset > 0 && k.offset < 1
    );
    features[3] = Math.min(middleKeyframes.length / 8, 1);

    // オフセットの分布
    const offsets = keyframes.map((k) => k.offset).sort((a, b) => a - b);

    // オフセットの分散
    if (offsets.length > 1) {
      const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      const variance =
        offsets.reduce((sum, o) => sum + Math.pow(o - mean, 2), 0) /
        offsets.length;
      features[4] = Math.min(variance * 4, 1); // 分散を0-1に正規化
    }

    // オフセットの間隔の均一性
    if (offsets.length > 1) {
      const gaps: number[] = [];
      for (let i = 1; i < offsets.length; i++) {
        const current = offsets[i];
        const previous = offsets[i - 1];
        if (current !== undefined && previous !== undefined) {
          gaps.push(current - previous);
        }
      }
      if (gaps.length > 0) {
        const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const gapVariance =
          gaps.reduce((sum, g) => sum + Math.pow(g - meanGap, 2), 0) / gaps.length;
        features[5] = 1 - Math.min(gapVariance * 10, 1); // 均一なら1に近い
      }
    }

    // 各キーフレームのプロパティ数の平均
    const propCounts = keyframes.map((k) => (k.properties ? k.properties.length : 0));
    const avgPropCount =
      propCounts.reduce((a, b) => a + b, 0) / Math.max(propCounts.length, 1);
    features[6] = Math.min(avgPropCount / 5, 1);

    // タイミング関数を持つキーフレームの割合
    const withTiming = keyframes.filter((k) => k.timingFunction).length;
    features[7] = withTiming / Math.max(keyframes.length, 1);

    // 特定のオフセットパターン検出
    // 50%キーフレームの有無（バウンス/パルス系）
    features[8] = keyframes.some((k) => Math.abs(k.offset - 0.5) < 0.01) ? 1 : 0;

    // 25%/75%キーフレームの有無（複雑なアニメーション）
    features[9] =
      keyframes.some((k) => Math.abs(k.offset - 0.25) < 0.01) ||
      keyframes.some((k) => Math.abs(k.offset - 0.75) < 0.01)
        ? 1
        : 0;

    // キーフレームの密度（前半 vs 後半）
    const firstHalf = keyframes.filter((k) => k.offset < 0.5).length;
    const secondHalf = keyframes.filter((k) => k.offset > 0.5).length;
    features[10] =
      (firstHalf - secondHalf) / Math.max(keyframes.length, 1) / 2 + 0.5;

    // プロパティの一貫性（全キーフレームで同じプロパティが定義されているか）
    const firstKeyframe = keyframes[0];
    if (keyframes.length > 1 && firstKeyframe && firstKeyframe.properties) {
      const firstProps = new Set(
        (firstKeyframe.properties as { name: string; value: string }[]).map((p) => p.name)
      );
      let consistent = true;
      for (let i = 1; i < keyframes.length && consistent; i++) {
        const kf = keyframes[i];
        if (kf) {
          const props = kf.properties as { name: string; value: string }[];
          if (props) {
            const propNames = new Set(props.map((p) => p.name));
            if (propNames.size !== firstProps.size) {
              consistent = false;
            }
          }
        }
      }
      features[11] = consistent ? 1 : 0;
    }

    // 残りの特徴量（予備）
    features[12] = keyframes.length > 2 ? 1 : 0; // 3つ以上のキーフレーム
    features[13] = keyframes.length > 5 ? 1 : 0; // 6つ以上のキーフレーム（複雑）
    features[14] = keyframes.length === 2 ? 1 : 0; // シンプルなfrom/toアニメーション
    features[15] = middleKeyframes.length > 0 ? 1 : 0; // 中間キーフレームあり

    return features;
  }
}

// =========================================
// MotionEmbedding Class
// =========================================

/**
 * MotionEmbedding - モーションパターンのEmbedding生成と類似検索
 *
 * @example
 * ```typescript
 * const embedding = new MotionEmbedding();
 * const vec = embedding.embed(pattern);
 * const similar = embedding.findSimilar(vec, candidates, 5);
 * ```
 */
export class MotionEmbedding {
  private readonly extractor: MotionFeatureExtractor;

  constructor() {
    this.extractor = new MotionFeatureExtractor();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[MotionEmbedding] Initialized with dimension:', MOTION_EMBEDDING_DIM);
    }
  }

  /**
   * モーションパターンからEmbeddingを生成
   *
   * @param pattern - モーションパターン
   * @returns L2正規化された64次元Embeddingベクトル
   */
  public embed(pattern: MotionPattern): number[] {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[MotionEmbedding] Embedding pattern:', pattern.name);
    }

    // 各特徴量を抽出
    const propertyFeatures = this.extractor.extractPropertyFeatures(pattern);
    const timingFeatures = this.extractor.extractTimingFeatures(pattern);
    const easingFeatures = this.extractor.extractEasingFeatures(pattern.easing);

    // キーフレーム特徴量（プロパティからキーフレームを集約）
    const allKeyframes: KeyframeStep[] = [];
    for (const prop of pattern.properties) {
      if (prop.keyframes) {
        for (const kf of prop.keyframes) {
          allKeyframes.push({
            offset: kf.offset,
            properties: [{ name: prop.name, value: kf.value }],
          });
        }
      }
    }
    const keyframeFeatures = this.extractor.extractKeyframeFeatures(allKeyframes);

    // 特徴量を結合
    const embedding = [
      ...propertyFeatures,
      ...timingFeatures,
      ...easingFeatures,
      ...keyframeFeatures,
    ];

    // L2正規化
    return this.normalize(embedding);
  }

  /**
   * 複数のモーションパターンからEmbeddingをバッチ生成
   *
   * @param patterns - モーションパターン配列
   * @returns L2正規化された64次元Embeddingベクトルの配列
   */
  public embedBatch(patterns: MotionPattern[]): number[][] {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[MotionEmbedding] Batch embedding:', patterns.length, 'patterns');
    }

    return patterns.map((pattern) => this.embed(pattern));
  }

  /**
   * 2つのEmbedding間のコサイン類似度を計算
   *
   * @param embedding1 - 1つ目のEmbeddingベクトル
   * @param embedding2 - 2つ目のEmbeddingベクトル
   * @returns コサイン類似度 (-1 to 1)
   */
  public similarity(embedding1: number[], embedding2: number[]): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embedding dimensions do not match');
    }

    // ゼロベクトルのチェック
    const norm1 = Math.sqrt(embedding1.reduce((sum, v) => sum + v * v, 0));
    const norm2 = Math.sqrt(embedding2.reduce((sum, v) => sum + v * v, 0));

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    // コサイン類似度（L2正規化済みなので内積のみ）
    let dotProduct = 0;
    for (let i = 0; i < embedding1.length; i++) {
      const v1 = embedding1[i];
      const v2 = embedding2[i];
      if (v1 !== undefined && v2 !== undefined) {
        dotProduct += v1 * v2;
      }
    }

    // 浮動小数点の丸め誤差をクランプ
    return Math.max(-1, Math.min(1, dotProduct));
  }

  /**
   * ターゲットEmbeddingに類似した候補を検索
   *
   * @param target - ターゲットEmbeddingベクトル
   * @param candidates - 候補Embeddingベクトルの配列
   * @param topK - 返却する上位K件（省略時は全件）
   * @returns 類似度順にソートされたSimilarityResult配列
   */
  public findSimilar(
    target: number[],
    candidates: number[][],
    topK?: number
  ): SimilarityResult[] {
    if (candidates.length === 0 || (topK !== undefined && topK <= 0)) {
      return [];
    }

    // 全候補との類似度を計算
    const results: SimilarityResult[] = candidates.map((candidate, index) => ({
      index,
      similarity: this.similarity(target, candidate),
    }));

    // 類似度で降順ソート
    results.sort((a, b) => b.similarity - a.similarity);

    // topKで制限
    if (topK !== undefined) {
      return results.slice(0, Math.min(topK, candidates.length));
    }

    return results;
  }

  /**
   * ベクトルをL2正規化
   *
   * @param vector - 正規化前のベクトル
   * @returns L2正規化されたベクトル
   */
  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));

    if (norm === 0) {
      return vector;
    }

    return vector.map((v) => v / norm);
  }
}
