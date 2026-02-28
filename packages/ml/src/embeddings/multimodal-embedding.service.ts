// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Multimodal Embedding Service
 *
 * VisionAnalyzerの特徴抽出結果とテキストEmbeddingを組み合わせて
 * マルチモーダルEmbeddingを生成します。
 *
 * text_embedding + vision_embedding の統合サービス
 * - searchMode: 'text_only' | 'vision_only' | 'combined'
 * - Graceful Degradation: visionFeaturesがない場合はtext_onlyにフォールバック
 * - L2正規化: すべてのEmbeddingは正規化される
 *
 * @module embeddings/multimodal-embedding.service
 */

import { z } from 'zod';
import pLimit from 'p-limit';
import type { VisionFeatures } from './vision-embedding.types.js';
import { visionFeaturesToText } from './vision-embedding.service.js';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 検索モード
 */
export type SearchMode = 'text_only' | 'vision_only' | 'combined';

/**
 * マルチモーダルEmbedding設定
 */
export interface MultimodalEmbeddingConfig {
  /** テキストEmbeddingの重み (0-1) */
  textWeight?: number;
  /** Vision Embeddingの重み (0-1) */
  visionWeight?: number;
  /** Embeddingの次元数 */
  embeddingDimension?: number;
  /** 検索モード */
  searchMode?: SearchMode;
  /** 出力のL2正規化 */
  normalizeOutput?: boolean;
}

/**
 * デフォルト設定
 */
export const DEFAULT_MULTIMODAL_CONFIG: Required<MultimodalEmbeddingConfig> = {
  textWeight: 0.6,
  visionWeight: 0.4,
  embeddingDimension: 768,
  searchMode: 'combined',
  normalizeOutput: true,
};

/**
 * 設定スキーマ
 */
export const multimodalEmbeddingConfigSchema = z.object({
  textWeight: z.number().min(0).max(1).optional(),
  visionWeight: z.number().min(0).max(1).optional(),
  embeddingDimension: z.number().int().positive().optional(),
  searchMode: z.enum(['text_only', 'vision_only', 'combined']).optional(),
  normalizeOutput: z.boolean().optional(),
});

/**
 * マルチモーダルEmbedding入力
 */
export interface MultimodalEmbeddingInput {
  /** テキスト表現（VisionAnalyzer.generateTextRepresentationの出力） */
  textRepresentation: string;
  /** Vision特徴からのテキスト（カラーパレット、レイアウト等） */
  visionFeatureText?: string;
  /** 元のテキスト（名前、説明等） */
  originalText?: string;
}

/**
 * 入力スキーマ
 */
export const multimodalEmbeddingInputSchema = z.object({
  textRepresentation: z.string().min(1),
  visionFeatureText: z.string().optional(),
  originalText: z.string().optional(),
});

/**
 * マルチモーダルEmbedding結果
 */
export interface MultimodalEmbeddingResult {
  /** 統合Embedding (768次元) */
  combinedEmbedding: number[];
  /** テキストEmbedding (768次元) */
  textEmbedding: number[];
  /** Vision特徴Embedding (768次元) */
  visionEmbedding: number[];
  /** 使用した重み */
  weights: {
    text: number;
    vision: number;
  };
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * 結果スキーマ
 */
export const multimodalEmbeddingResultSchema = z.object({
  combinedEmbedding: z.array(z.number()).length(768),
  textEmbedding: z.array(z.number()).length(768),
  visionEmbedding: z.array(z.number()).length(768),
  weights: z.object({
    text: z.number().min(0).max(1),
    vision: z.number().min(0).max(1),
  }),
  processingTimeMs: z.number().min(0),
});

// =============================================================================
// 新しい型定義
// =============================================================================

/**
 * 新しいマルチモーダルEmbedding結果
 */
export interface MultimodalEmbeddingResultV2 {
  /** テキストEmbedding (768次元、L2正規化済み) */
  textEmbedding: number[] | null;
  /** Vision Embedding (768次元、L2正規化済み) */
  visionEmbedding: number[] | null;
  /** 統合Embedding (768次元、L2正規化済み) */
  combinedEmbedding: number[] | null;
  /** 使用した検索モード */
  searchMode: SearchMode;
  /** 使用した重み */
  weights: {
    text: number;
    vision: number;
  };
  /** メタデータ */
  metadata: {
    /** テキスト表現 */
    textRepresentation: string;
    /** VisionFeatures (combinedモード時のみ) */
    visionFeatures?: VisionFeatures;
    /** 処理時間（ミリ秒） */
    processingTimeMs: number;
  };
}

/**
 * バッチ処理入力アイテム
 */
export interface MultimodalBatchItem {
  /** テキストコンテンツ */
  content: string;
  /** VisionFeatures（オプション） */
  visionFeatures?: VisionFeatures;
}

/**
 * バッチ処理結果
 */
export interface MultimodalBatchResult {
  /** 成功した結果 */
  results: MultimodalEmbeddingResultV2[];
  /** 処理統計 */
  stats: {
    /** 処理件数 */
    total: number;
    /** 成功件数 */
    success: number;
    /** 失敗件数 */
    failed: number;
    /** 合計処理時間（ミリ秒） */
    totalProcessingTimeMs: number;
  };
}

// =============================================================================
// バッチ処理最適化（並列化 + メトリクス）
// =============================================================================

/**
 * バッチ処理パフォーマンスメトリクス
 */
export interface MultimodalBatchMetrics {
  /** 総アイテム数 */
  totalItems: number;
  /** 成功件数 */
  successCount: number;
  /** 失敗件数 */
  failedCount: number;
  /** キャッシュヒット件数 */
  cacheHitCount: number;
  /** キャッシュヒット率 (0-1) */
  cacheHitRate: number;
  /** 平均処理時間（ミリ秒） */
  avgProcessingTimeMs: number;
  /** 合計処理時間（ミリ秒） */
  totalProcessingTimeMs: number;
  /** スループット（件/分） */
  throughputPerMinute: number;
}

/**
 * 最適化バッチ処理の進捗情報
 */
export interface OptimizedBatchProgress {
  /** 完了件数 */
  completed: number;
  /** 総件数 */
  total: number;
  /** 進捗率 (0-1) */
  progress: number;
  /** 現在のアイテムインデックス */
  currentIndex: number;
}

/**
 * 最適化バッチ処理オプション
 */
export interface OptimizedBatchOptions {
  /** 並列処理の同時実行数 (デフォルト: 5) */
  concurrency?: number;
  /** 個別アイテムのタイムアウト（ミリ秒）(デフォルト: 30000) */
  itemTimeoutMs?: number;
  /** バッチ全体のタイムアウト（ミリ秒）(デフォルト: 300000 = 5分) */
  totalTimeoutMs?: number;
  /** 進捗コールバック */
  onProgress?: (progress: OptimizedBatchProgress) => void;
  /** Embedding設定のオーバーライド */
  embeddingConfig?: MultimodalEmbeddingConfig;
}

/**
 * 最適化バッチ処理結果
 */
export interface OptimizedBatchResult {
  /** 成功した結果 */
  results: MultimodalEmbeddingResultV2[];
  /** パフォーマンスメトリクス */
  metrics: MultimodalBatchMetrics;
  /** エラー情報（失敗したアイテム） */
  errors: Array<{
    index: number;
    error: string;
  }>;
}

// =============================================================================
// サービスインターフェース
// =============================================================================

/**
 * Embeddingサービスインターフェース（DI用）
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
}

// =============================================================================
// MultimodalEmbeddingService
// =============================================================================

/**
 * マルチモーダルEmbeddingサービス
 *
 * VisionAnalyzerの特徴抽出結果とテキストEmbeddingを組み合わせて
 * 統合Embeddingを生成します。
 *
 * @example
 * ```typescript
 * const service = new MultimodalEmbeddingService(embeddingService);
 *
 * const result = await service.generateMultimodalEmbedding({
 *   textRepresentation: "Layout: two-column grid...",
 *   visionFeatureText: "Colors: blue, white. Whitespace: generous.",
 *   originalText: "Hero section design",
 * });
 *
 * console.log(result.combinedEmbedding.length); // 768
 * ```
 */
export class MultimodalEmbeddingService {
  private config: Required<MultimodalEmbeddingConfig>;
  private embeddingService: IEmbeddingService;

  constructor(
    embeddingService: IEmbeddingService,
    config: MultimodalEmbeddingConfig = {}
  ) {
    // 設定をマージ
    this.config = { ...DEFAULT_MULTIMODAL_CONFIG, ...config };

    // 重みの合計が1になるように正規化
    this.normalizeWeights();

    this.embeddingService = embeddingService;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] MultimodalEmbeddingService created with config:', {
        textWeight: this.config.textWeight,
        visionWeight: this.config.visionWeight,
        embeddingDimension: this.config.embeddingDimension,
        searchMode: this.config.searchMode,
        normalizeOutput: this.config.normalizeOutput,
      });
    }
  }

  /**
   * 重みを正規化（合計が1になるように）
   */
  private normalizeWeights(): void {
    const totalWeight = this.config.textWeight + this.config.visionWeight;
    if (totalWeight !== 1 && totalWeight > 0) {
      this.config.textWeight = this.config.textWeight / totalWeight;
      this.config.visionWeight = this.config.visionWeight / totalWeight;
    }
  }

  /**
   * マルチモーダルEmbeddingを生成
   *
   * @param input - 入力データ
   * @returns マルチモーダルEmbedding結果
   */
  async generateMultimodalEmbedding(
    input: MultimodalEmbeddingInput
  ): Promise<MultimodalEmbeddingResult> {
    const startTime = Date.now();

    // 入力バリデーション
    multimodalEmbeddingInputSchema.parse(input);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Generating multimodal embedding for:', {
        textRepLength: input.textRepresentation.length,
        hasVisionFeatureText: !!input.visionFeatureText,
        hasOriginalText: !!input.originalText,
      });
    }

    // テキスト表現からEmbeddingを生成
    const textForEmbedding = this.buildTextForEmbedding(input);
    const textEmbedding = await this.embeddingService.generateEmbedding(
      textForEmbedding,
      'passage'
    );

    // Vision特徴テキストからEmbeddingを生成
    const visionText = this.buildVisionText(input);
    const visionEmbedding = await this.embeddingService.generateEmbedding(
      visionText,
      'passage'
    );

    // 重み付き結合
    const combinedEmbedding = this.combineEmbeddings(
      textEmbedding,
      visionEmbedding
    );

    const processingTimeMs = Date.now() - startTime;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Multimodal embedding generated in', processingTimeMs, 'ms');
    }

    return {
      combinedEmbedding,
      textEmbedding,
      visionEmbedding,
      weights: {
        text: this.config.textWeight,
        vision: this.config.visionWeight,
      },
      processingTimeMs,
    };
  }

  /**
   * テキストEmbedding用の文字列を構築
   */
  private buildTextForEmbedding(input: MultimodalEmbeddingInput): string {
    const parts: string[] = [];

    if (input.originalText) {
      parts.push(input.originalText);
    }

    parts.push(input.textRepresentation);

    return parts.join(' ');
  }

  /**
   * Vision特徴テキストを構築
   */
  private buildVisionText(input: MultimodalEmbeddingInput): string {
    if (input.visionFeatureText) {
      return input.visionFeatureText;
    }

    // visionFeatureTextがない場合はtextRepresentationを使用
    return input.textRepresentation;
  }

  /**
   * 2つのEmbeddingを重み付き結合
   */
  private combineEmbeddings(
    textEmbedding: number[],
    visionEmbedding: number[]
  ): number[] {
    if (textEmbedding.length !== visionEmbedding.length) {
      throw new Error(
        `Embedding dimensions mismatch: text=${textEmbedding.length}, vision=${visionEmbedding.length}`
      );
    }

    // 片方の重みが1（もう一方が0）の場合は、そのままそのEmbeddingを返す
    if (this.config.textWeight === 1) {
      return [...textEmbedding];
    }
    if (this.config.visionWeight === 1) {
      return [...visionEmbedding];
    }

    const combined: number[] = new Array(textEmbedding.length);

    for (let i = 0; i < textEmbedding.length; i++) {
      const textVal = textEmbedding[i] ?? 0;
      const visionVal = visionEmbedding[i] ?? 0;
      combined[i] =
        textVal * this.config.textWeight + visionVal * this.config.visionWeight;
    }

    // L2正規化
    return this.normalizeVector(combined);
  }

  /**
   * ベクトルをL2正規化
   */
  private normalizeVector(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map((val) => val / norm);
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): Readonly<Required<MultimodalEmbeddingConfig>> {
    return { ...this.config };
  }

  // ===========================================================================
  // 新しいメソッド
  // ===========================================================================

  /**
   * マルチモーダルEmbeddingを生成
   *
   * searchModeに応じて適切なEmbeddingを生成します。
   * - text_only: テキストEmbeddingのみ
   * - vision_only: VisionEmbeddingのみ（visionFeatures必須）
   * - combined: テキスト + Vision の重み付き結合
   *
   * Graceful Degradation:
   * - visionFeaturesがない場合、combinedモードはtext_onlyにフォールバック
   *
   * @param content - テキストコンテンツ
   * @param visionFeatures - VisionFeatures（オプション）
   * @param config - オーバーライド設定（オプション）
   * @returns MultimodalEmbeddingResultV2
   */
  async createMultimodalEmbedding(
    content: string,
    visionFeatures?: VisionFeatures,
    config?: MultimodalEmbeddingConfig
  ): Promise<MultimodalEmbeddingResultV2> {
    const startTime = Date.now();

    // 設定をマージ（インスタンス設定 < 呼び出し時設定）
    const mergedConfig = this.mergeConfig(config);

    // 検索モードを決定（Graceful Degradation対応）
    let effectiveSearchMode = mergedConfig.searchMode;

    // Graceful Degradation: visionFeaturesがない場合、combinedはtext_onlyにフォールバック
    if (
      effectiveSearchMode === 'combined' &&
      !visionFeatures
    ) {
      effectiveSearchMode = 'text_only';
    }

    // vision_onlyモードでvisionFeaturesがない場合はエラー
    if (effectiveSearchMode === 'vision_only' && !visionFeatures) {
      throw new Error(
        'visionFeatures is required for vision_only mode'
      );
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createMultimodalEmbedding:', {
        contentLength: content.length,
        hasVisionFeatures: !!visionFeatures,
        requestedMode: mergedConfig.searchMode,
        effectiveMode: effectiveSearchMode,
      });
    }

    // Embedding生成
    let textEmbedding: number[] | null = null;
    let visionEmbedding: number[] | null = null;
    let combinedEmbedding: number[] | null = null;

    // text_only または combined: テキストEmbeddingを生成
    if (effectiveSearchMode === 'text_only' || effectiveSearchMode === 'combined') {
      textEmbedding = await this.embeddingService.generateEmbedding(
        content,
        'passage'
      );
      if (mergedConfig.normalizeOutput) {
        textEmbedding = this.normalizeVector(textEmbedding);
      }
    }

    // vision_only または combined: VisionEmbeddingを生成
    if (
      (effectiveSearchMode === 'vision_only' || effectiveSearchMode === 'combined') &&
      visionFeatures
    ) {
      const visionText = visionFeaturesToText(visionFeatures);
      visionEmbedding = await this.embeddingService.generateEmbedding(
        visionText,
        'passage'
      );
      if (mergedConfig.normalizeOutput) {
        visionEmbedding = this.normalizeVector(visionEmbedding);
      }
    }

    // combinedEmbeddingを計算
    if (effectiveSearchMode === 'text_only' && textEmbedding) {
      // text_only: combinedはtextEmbeddingと同等
      combinedEmbedding = [...textEmbedding];
    } else if (effectiveSearchMode === 'vision_only' && visionEmbedding) {
      // vision_only: combinedはvisionEmbeddingと同等
      combinedEmbedding = [...visionEmbedding];
    } else if (
      effectiveSearchMode === 'combined' &&
      textEmbedding &&
      visionEmbedding
    ) {
      // combined: 重み付き結合
      combinedEmbedding = this.combineEmbeddingsWithConfig(
        textEmbedding,
        visionEmbedding,
        mergedConfig
      );
    }

    const processingTimeMs = Date.now() - startTime;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createMultimodalEmbedding completed in', processingTimeMs, 'ms');
    }

    return {
      textEmbedding,
      visionEmbedding,
      combinedEmbedding,
      searchMode: effectiveSearchMode,
      weights: {
        text: mergedConfig.textWeight,
        vision: mergedConfig.visionWeight,
      },
      metadata: {
        textRepresentation: content,
        ...(visionFeatures !== undefined && { visionFeatures }),
        processingTimeMs,
      },
    };
  }

  /**
   * バッチでマルチモーダルEmbeddingを生成
   *
   * @param items - バッチ処理入力アイテムの配列
   * @param config - オーバーライド設定（オプション）
   * @returns MultimodalBatchResult
   */
  async createBatchMultimodalEmbeddings(
    items: MultimodalBatchItem[],
    config?: MultimodalEmbeddingConfig
  ): Promise<MultimodalBatchResult> {
    const startTime = Date.now();

    if (items.length === 0) {
      return {
        results: [],
        stats: {
          total: 0,
          success: 0,
          failed: 0,
          totalProcessingTimeMs: 0,
        },
      };
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createBatchMultimodalEmbeddings:', {
        count: items.length,
      });
    }

    const results: MultimodalEmbeddingResultV2[] = [];
    let successCount = 0;
    let failedCount = 0;

    // 各アイテムを処理（partial failure対応）
    for (const item of items) {
      try {
        const result = await this.createMultimodalEmbedding(
          item.content,
          item.visionFeatures,
          config
        );
        results.push(result);
        successCount++;
      } catch (error) {
        // partial failure: エラーを記録し、処理を続行
        failedCount++;
        if (process.env.NODE_ENV === 'development') {
           
          console.warn('[ML] Batch item failed:', error);
        }
      }
    }

    const totalProcessingTimeMs = Date.now() - startTime;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createBatchMultimodalEmbeddings completed:', {
        total: items.length,
        success: successCount,
        failed: failedCount,
        timeMs: totalProcessingTimeMs,
      });
    }

    return {
      results,
      stats: {
        total: items.length,
        success: successCount,
        failed: failedCount,
        totalProcessingTimeMs,
      },
    };
  }

  /**
   * 設定をマージ
   */
  private mergeConfig(
    override?: MultimodalEmbeddingConfig
  ): Required<MultimodalEmbeddingConfig> {
    if (!override) {
      return { ...this.config };
    }

    const merged = { ...this.config, ...override };

    // 重みの正規化
    const totalWeight = merged.textWeight + merged.visionWeight;
    if (totalWeight !== 1 && totalWeight > 0) {
      merged.textWeight = merged.textWeight / totalWeight;
      merged.visionWeight = merged.visionWeight / totalWeight;
    }

    return merged;
  }

  /**
   * 設定を使用して2つのEmbeddingを重み付き結合
   */
  private combineEmbeddingsWithConfig(
    textEmbedding: number[],
    visionEmbedding: number[],
    config: Required<MultimodalEmbeddingConfig>
  ): number[] {
    if (textEmbedding.length !== visionEmbedding.length) {
      throw new Error(
        `Embedding dimensions mismatch: text=${textEmbedding.length}, vision=${visionEmbedding.length}`
      );
    }

    const combined: number[] = new Array(textEmbedding.length);

    for (let i = 0; i < textEmbedding.length; i++) {
      const textVal = textEmbedding[i] ?? 0;
      const visionVal = visionEmbedding[i] ?? 0;
      combined[i] = textVal * config.textWeight + visionVal * config.visionWeight;
    }

    // L2正規化（normalizeOutput=trueの場合）
    if (config.normalizeOutput) {
      return this.normalizeVector(combined);
    }

    return combined;
  }

  // ===========================================================================
  // バッチ処理最適化（並列化 + メトリクス）
  // ===========================================================================

  /** キャッシュ（コンテンツハッシュ -> 結果） */
  private embeddingCache: Map<string, MultimodalEmbeddingResultV2> = new Map();

  /** 最大キャッシュサイズ */
  private readonly maxCacheSize = 5000;

  /**
   * キャッシュキーを生成
   */
  private generateCacheKey(
    content: string,
    visionFeatures?: VisionFeatures,
    searchMode?: SearchMode
  ): string {
    const visionPart = visionFeatures
      ? JSON.stringify({
          r: visionFeatures.rhythm,
          w: visionFeatures.whitespaceRatio,
          d: visionFeatures.density,
          g: visionFeatures.gravity,
          t: visionFeatures.theme,
          m: visionFeatures.mood,
          b: visionFeatures.brandTone,
        })
      : 'null';
    return `${searchMode ?? this.config.searchMode}:${content}:${visionPart}`;
  }

  /**
   * キャッシュから取得（LRU更新）
   */
  private getCacheEntry(key: string): MultimodalEmbeddingResultV2 | undefined {
    const value = this.embeddingCache.get(key);
    if (value !== undefined) {
      // LRU: 最近使用したエントリを末尾に移動
      this.embeddingCache.delete(key);
      this.embeddingCache.set(key, value);
    }
    return value;
  }

  /**
   * キャッシュに保存（LRU eviction）
   */
  private setCacheEntry(key: string, value: MultimodalEmbeddingResultV2): void {
    // キャッシュがいっぱいの場合、最も古いエントリを削除
    while (this.embeddingCache.size >= this.maxCacheSize) {
      const oldestKey = this.embeddingCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.embeddingCache.delete(oldestKey);
      } else {
        break;
      }
    }
    this.embeddingCache.set(key, value);
  }

  /**
   * 最適化バッチでマルチモーダルEmbeddingを生成
   *
   * p-limitを使用した並列処理により、高スループットを実現します。
   *
   * 特徴:
   * - 並列処理（デフォルト同時実行数: 5）
   * - キャッシュによる重複処理の回避
   * - 個別アイテムタイムアウト
   * - バッチ全体タイムアウト
   * - 進捗コールバック
   * - Graceful Degradation（部分失敗許容）
   * - 詳細なパフォーマンスメトリクス
   *
   * @param items - バッチ処理入力アイテムの配列
   * @param options - 最適化オプション
   * @returns OptimizedBatchResult
   */
  async createOptimizedBatchMultimodalEmbeddings(
    items: MultimodalBatchItem[],
    options: OptimizedBatchOptions = {}
  ): Promise<OptimizedBatchResult> {
    const startTime = Date.now();

    // デフォルトオプション
    const concurrency = options.concurrency ?? 5;
    const itemTimeoutMs = options.itemTimeoutMs ?? 30000;
    const totalTimeoutMs = options.totalTimeoutMs ?? 300000; // 5分
    const onProgress = options.onProgress;
    const embeddingConfig = options.embeddingConfig;

    // 空の入力の場合
    if (items.length === 0) {
      return {
        results: [],
        metrics: {
          totalItems: 0,
          successCount: 0,
          failedCount: 0,
          cacheHitCount: 0,
          cacheHitRate: 0,
          avgProcessingTimeMs: 0,
          totalProcessingTimeMs: 0,
          throughputPerMinute: 0,
        },
        errors: [],
      };
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createOptimizedBatchMultimodalEmbeddings:', {
        count: items.length,
        concurrency,
        itemTimeoutMs,
        totalTimeoutMs,
      });
    }

    // p-limitでの並列制御
    const limit = pLimit(concurrency);

    // 結果とメトリクス追跡
    const results: Array<{ index: number; result: MultimodalEmbeddingResultV2 }> = [];
    const errors: Array<{ index: number; error: string }> = [];
    let cacheHitCount = 0;
    let completedCount = 0;
    const processingTimes: number[] = [];

    // タイムアウトフラグ
    let isTimedOut = false;

    // 全体タイムアウト設定
    const totalTimeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        isTimedOut = true;
        resolve('timeout');
      }, totalTimeoutMs);
    });

    // 各アイテムの処理関数
    const processItem = async (item: MultimodalBatchItem, index: number): Promise<void> => {
      // 全体タイムアウトチェック
      if (isTimedOut) {
        errors.push({ index, error: 'Batch timeout exceeded' });
        return;
      }

      const itemStartTime = Date.now();

      // キャッシュキーを生成
      const cacheKey = this.generateCacheKey(
        item.content,
        item.visionFeatures,
        embeddingConfig?.searchMode
      );

      // キャッシュチェック
      const cached = this.getCacheEntry(cacheKey);
      if (cached) {
        cacheHitCount++;
        results.push({ index, result: cached });
        completedCount++;

        // 進捗コールバック
        if (onProgress) {
          onProgress({
            completed: completedCount,
            total: items.length,
            progress: completedCount / items.length,
            currentIndex: index,
          });
        }

        processingTimes.push(Date.now() - itemStartTime);
        return;
      }

      // タイムアウト付きでEmbedding生成
      try {
        const result = await Promise.race([
          this.createMultimodalEmbedding(
            item.content,
            item.visionFeatures,
            embeddingConfig
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Item timeout')), itemTimeoutMs)
          ),
        ]);

        // キャッシュに保存
        this.setCacheEntry(cacheKey, result);
        results.push({ index, result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ index, error: errorMessage });
      }

      completedCount++;
      processingTimes.push(Date.now() - itemStartTime);

      // 進捗コールバック
      if (onProgress) {
        onProgress({
          completed: completedCount,
          total: items.length,
          progress: completedCount / items.length,
          currentIndex: index,
        });
      }
    };

    // 並列処理を実行
    const processingPromise = Promise.all(
      items.map((item, index) => limit(() => processItem(item, index)))
    );

    // 全体タイムアウトとの競合
    await Promise.race([processingPromise, totalTimeoutPromise]);

    // 残りの未処理アイテムをエラーとして追加
    if (isTimedOut) {
      for (let i = 0; i < items.length; i++) {
        const hasResult = results.some((r) => r.index === i);
        const hasError = errors.some((e) => e.index === i);
        if (!hasResult && !hasError) {
          errors.push({ index: i, error: 'Batch timeout exceeded' });
        }
      }
    }

    // 結果をインデックス順にソート
    results.sort((a, b) => a.index - b.index);
    errors.sort((a, b) => a.index - b.index);

    const totalProcessingTimeMs = Date.now() - startTime;

    // メトリクス計算
    const successCount = results.length;
    const failedCount = errors.length;
    const avgProcessingTimeMs =
      processingTimes.length > 0
        ? processingTimes.reduce((sum, t) => sum + t, 0) / processingTimes.length
        : 0;
    const throughputPerMinute =
      totalProcessingTimeMs > 0
        ? (successCount / totalProcessingTimeMs) * 60000
        : 0;

    const metrics: MultimodalBatchMetrics = {
      totalItems: items.length,
      successCount,
      failedCount,
      cacheHitCount,
      cacheHitRate: items.length > 0 ? cacheHitCount / items.length : 0,
      avgProcessingTimeMs,
      totalProcessingTimeMs,
      throughputPerMinute,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] createOptimizedBatchMultimodalEmbeddings completed:', {
        ...metrics,
      });
    }

    return {
      results: results.map((r) => r.result),
      metrics,
      errors,
    };
  }

  /**
   * Embeddingキャッシュをクリア
   */
  clearEmbeddingCache(): void {
    this.embeddingCache.clear();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[ML] Embedding cache cleared');
    }
  }

  /**
   * キャッシュ統計を取得
   */
  getEmbeddingCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.embeddingCache.size,
      maxSize: this.maxCacheSize,
    };
  }
}
