// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style Embedding Service
 *
 * スタイル特徴量のテキスト表現から埋め込みベクトルを生成するサービス。
 * 既存のEmbeddingServiceをラップし、スタイル特徴量に特化した機能を提供。
 *
 * @module embeddings/style-embedding.service
 * @version 0.1.0
 */

import { EmbeddingService } from './service.js';
import type { CacheStats } from './types.js';

// 開発環境でのログ出力
const isDevelopment = process.env.NODE_ENV === 'development';
const log = (message: string, data?: unknown): void => {
  if (isDevelopment) {
    // eslint-disable-next-line no-console
    console.log(`[StyleEmbedding] ${message}`, data ?? '');
  }
};

/**
 * スタイル埋め込みの設定
 */
export interface StyleEmbeddingConfig {
  /**
   * 内部で使用するEmbeddingServiceのインスタンス
   * デフォルトは新規インスタンスを作成
   */
  embeddingService?: EmbeddingService;

  /**
   * バッチ処理時の最大並列数
   * @default 32
   */
  batchSize?: number;
}

/**
 * スタイル特徴量埋め込み生成サービス
 *
 * スタイル特徴量テキスト表現から768次元の埋め込みベクトルを生成。
 * multilingual-e5-baseモデルを使用し、HNSWベクトル検索と互換。
 */
export class StyleEmbeddingService {
  private embeddingService: EmbeddingService;
  private batchSize: number;

  constructor(config: StyleEmbeddingConfig = {}) {
    this.embeddingService = config.embeddingService ?? new EmbeddingService();
    this.batchSize = config.batchSize ?? 32;

    log('StyleEmbeddingService created', { batchSize: this.batchSize });
  }

  /**
   * スタイル特徴量テキストから埋め込みを生成
   *
   * @param styleText - StyleFeaturesToTextで生成されたテキスト表現
   * @returns 768次元の正規化済み埋め込みベクトル
   *
   * @example
   * ```typescript
   * const styleText = 'Design style: thin stroke (1px) consistent outlined simple complexity';
   * const embedding = await service.generateEmbedding(styleText);
   * // embedding.length === 768
   * ```
   */
  async generateEmbedding(styleText: string): Promise<number[]> {
    log('Generating embedding for style text', { length: styleText.length });

    // "passage:" プレフィックスを使用（ドキュメント埋め込みとして扱う）
    // スタイル特徴量は検索対象のドキュメント側なのでpassageを使用
    const embedding = await this.embeddingService.generateEmbedding(styleText, 'passage');

    log('Embedding generated', { dimension: embedding.length });

    return embedding;
  }

  /**
   * クエリテキストから検索用埋め込みを生成
   *
   * 類似デザイン検索時に使用。ユーザーのクエリや参照デザインの
   * スタイル特徴量テキストから検索用の埋め込みを生成。
   *
   * @param queryText - 検索クエリまたは参照スタイルテキスト
   * @returns 768次元の正規化済み埋め込みベクトル
   *
   * @example
   * ```typescript
   * const queryEmbedding = await service.generateQueryEmbedding('thin stroke outlined icon');
   * // HNSW検索で使用
   * ```
   */
  async generateQueryEmbedding(queryText: string): Promise<number[]> {
    log('Generating query embedding', { length: queryText.length });

    // "query:" プレフィックスを使用（検索クエリとして扱う）
    const embedding = await this.embeddingService.generateEmbedding(queryText, 'query');

    log('Query embedding generated', { dimension: embedding.length });

    return embedding;
  }

  /**
   * 複数のスタイル特徴量テキストからバッチで埋め込みを生成
   *
   * @param styleTexts - スタイル特徴量テキストの配列
   * @returns 768次元の埋め込みベクトルの配列
   *
   * @example
   * ```typescript
   * const embeddings = await service.generateBatchEmbeddings([
   *   'Design style: thin stroke outlined',
   *   'Design style: thick stroke filled',
   * ]);
   * // embeddings.length === 2
   * ```
   */
  async generateBatchEmbeddings(styleTexts: string[]): Promise<number[][]> {
    if (styleTexts.length === 0) {
      return [];
    }

    log('Generating batch embeddings', { count: styleTexts.length });

    const startTime = performance.now();

    // "passage:" プレフィックスを使用（ドキュメント埋め込み）
    const embeddings = await this.embeddingService.generateBatchEmbeddings(styleTexts, 'passage');

    const elapsed = performance.now() - startTime;
    log('Batch embeddings generated', {
      count: embeddings.length,
      elapsedMs: elapsed,
      avgMs: elapsed / embeddings.length,
    });

    return embeddings;
  }

  /**
   * キャッシュ統計を取得
   */
  getCacheStats(): CacheStats {
    return this.embeddingService.getCacheStats();
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.embeddingService.clearCache();
    log('Cache cleared');
  }
}

// =============================================================================
// シングルトンとヘルパー関数
// =============================================================================

/**
 * デフォルトのスタイル埋め込みサービスインスタンス
 */
export const styleEmbeddingService = new StyleEmbeddingService();

/**
 * スタイル特徴量テキストから埋め込みを生成するヘルパー関数
 *
 * @param styleText - スタイル特徴量テキスト
 * @returns 768次元の埋め込みベクトル
 */
export async function createStyleEmbedding(styleText: string): Promise<number[]> {
  return styleEmbeddingService.generateEmbedding(styleText);
}

/**
 * 複数のスタイル特徴量テキストからバッチで埋め込みを生成するヘルパー関数
 *
 * @param styleTexts - スタイル特徴量テキストの配列
 * @returns 768次元の埋め込みベクトルの配列
 */
export async function createBatchStyleEmbeddings(styleTexts: string[]): Promise<number[][]> {
  return styleEmbeddingService.generateBatchEmbeddings(styleTexts);
}

/**
 * 検索クエリ用の埋め込みを生成するヘルパー関数
 *
 * @param queryText - 検索クエリテキスト
 * @returns 768次元の埋め込みベクトル
 */
export async function createQueryEmbedding(queryText: string): Promise<number[]> {
  return styleEmbeddingService.generateQueryEmbedding(queryText);
}
