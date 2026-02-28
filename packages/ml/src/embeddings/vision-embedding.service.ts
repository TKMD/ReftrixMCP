// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Embedding Service
 *
 * Vision Embedding生成ロジック
 *
 * 視覚特徴量（VisionFeatures）からテキスト表現を生成し、
 * multilingual-e5-baseモデルで768次元の埋め込みベクトルを生成するサービス
 */

import type {
  VisionFeatures,
  VisionEmbeddingServiceConfig,
  VisionCacheStats,
} from './vision-embedding.types.js';
import { EmbeddingService } from './service.js';

/**
 * デフォルトのキャッシュサイズ
 */
const DEFAULT_MAX_CACHE_SIZE = 5000;

/**
 * VisionFeaturesをテキスト表現に変換する
 *
 * @param features - 視覚特徴量
 * @returns テキスト表現
 */
export function visionFeaturesToText(features: VisionFeatures): string {
  const parts: string[] = [
    `visual_rhythm: ${features.rhythm}`,
    `whitespace_ratio: ${features.whitespaceRatio}`,
    `content_density: ${features.density}`,
    `visual_gravity: ${features.gravity}`,
    `color_theme: ${features.theme}`,
  ];

  // オプショナルフィールドを追加（存在する場合のみ）
  if (features.mood !== undefined && features.mood !== null) {
    parts.push(`mood: ${features.mood}`);
  }

  if (features.brandTone !== undefined && features.brandTone !== null) {
    parts.push(`brandTone: ${features.brandTone}`);
  }

  return parts.join(', ');
}

/**
 * VisionFeaturesからキャッシュキーを生成
 */
function getCacheKey(features: VisionFeatures): string {
  return JSON.stringify({
    r: features.rhythm,
    w: features.whitespaceRatio,
    d: features.density,
    g: features.gravity,
    t: features.theme,
    m: features.mood,
    b: features.brandTone,
  });
}

/**
 * VisionEmbeddingService
 *
 * 視覚特徴量から768次元の埋め込みベクトルを生成するサービス
 */
export class VisionEmbeddingService {
  private embeddingService: EmbeddingService;
  private cache: Map<string, number[]> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private maxCacheSize: number;

  constructor(config: VisionEmbeddingServiceConfig = {}) {
    this.maxCacheSize = config.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.embeddingService = new EmbeddingService();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[VisionEmbedding] Service created with maxCacheSize:', this.maxCacheSize);
    }
  }

  /**
   * VisionFeaturesから768次元の埋め込みベクトルを生成
   *
   * @param features - 視覚特徴量
   * @returns 768次元のL2正規化されたベクトル
   */
  async generateVisionEmbedding(features: VisionFeatures): Promise<number[]> {
    const cacheKey = getCacheKey(features);

    // キャッシュチェック（LRU更新付き）
    const cached = this.getCacheEntry(cacheKey);
    if (cached) {
      this.cacheHits++;
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('[VisionEmbedding] Cache hit');
      }
      return cached;
    }

    this.cacheMisses++;

    // テキスト表現に変換
    const text = visionFeaturesToText(features);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[VisionEmbedding] Generating embedding for:', text.substring(0, 80));
    }

    // EmbeddingServiceを使用して埋め込み生成
    // 'passage'プレフィックスを使用（ドキュメント埋め込み）
    const embedding = await this.embeddingService.generateEmbedding(text, 'passage');

    // キャッシュに保存（LRU eviction付き）
    this.setCacheEntry(cacheKey, embedding);

    return embedding;
  }

  /**
   * 複数のVisionFeaturesから埋め込みベクトルを一括生成
   *
   * @param featuresArray - 視覚特徴量の配列
   * @returns 768次元ベクトルの配列
   */
  async generateBatchVisionEmbeddings(featuresArray: VisionFeatures[]): Promise<number[][]> {
    if (featuresArray.length === 0) {
      return [];
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[VisionEmbedding] Batch processing', featuresArray.length, 'items');
    }

    // キャッシュチェックと未キャッシュアイテムの特定
    const results: (number[] | undefined)[] = new Array(featuresArray.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < featuresArray.length; i++) {
      const features = featuresArray[i];
      if (!features) continue;

      const cacheKey = getCacheKey(features);
      const cached = this.getCacheEntry(cacheKey);

      if (cached) {
        this.cacheHits++;
        results[i] = cached;
      } else {
        this.cacheMisses++;
        uncachedIndices.push(i);
        uncachedTexts.push(visionFeaturesToText(features));
      }
    }

    // 未キャッシュアイテムの一括生成
    if (uncachedTexts.length > 0) {
      const embeddings = await this.embeddingService.generateBatchEmbeddings(
        uncachedTexts,
        'passage'
      );

      for (let j = 0; j < uncachedIndices.length; j++) {
        const originalIndex = uncachedIndices[j];
        const embedding = embeddings[j];
        const features = featuresArray[originalIndex ?? 0];

        if (originalIndex !== undefined && embedding && features) {
          results[originalIndex] = embedding;

          // キャッシュに保存
          const cacheKey = getCacheKey(features);
          this.setCacheEntry(cacheKey, embedding);
        }
      }
    }

    // undefinedを除去して返却
    return results.filter((r): r is number[] => r !== undefined);
  }

  /**
   * キャッシュ統計を取得
   */
  getCacheStats(): VisionCacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
      evictions: this.cacheEvictions,
    };
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheEvictions = 0;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log('[VisionEmbedding] Cache cleared');
    }
  }

  /**
   * キャッシュエントリを取得（LRU更新）
   */
  private getCacheEntry(key: string): number[] | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // LRU: 最近使用したエントリを末尾に移動
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * キャッシュエントリを設定（LRU eviction）
   */
  private setCacheEntry(key: string, value: number[]): void {
    // キャッシュがいっぱいの場合、最も古いエントリを削除
    while (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.cacheEvictions++;
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('[VisionEmbedding] Cache evicted oldest entry');
        }
      } else {
        break;
      }
    }
    this.cache.set(key, value);
  }
}

// シングルトンインスタンス
export const visionEmbeddingService = new VisionEmbeddingService();

/**
 * 単一のVisionFeaturesから埋め込みを生成するヘルパー関数
 */
export async function createVisionEmbedding(features: VisionFeatures): Promise<number[]> {
  return visionEmbeddingService.generateVisionEmbedding(features);
}

/**
 * 複数のVisionFeaturesから埋め込みを一括生成するヘルパー関数
 */
export async function createBatchVisionEmbeddings(
  featuresArray: VisionFeatures[]
): Promise<number[][]> {
  return visionEmbeddingService.generateBatchVisionEmbeddings(featuresArray);
}
