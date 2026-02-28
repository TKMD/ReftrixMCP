// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLAnimationEmbeddingService
 * WebGLアニメーションパターン用のEmbedding生成サービス
 *
 * 機能:
 * - WebGLAnimationPatternからテキスト表現を生成
 * - multilingual-e5-base (768次元) Embeddingを生成
 * - DB保存連携（WebGLAnimationEmbeddingテーブル）
 * - 類似パターン検索（HNSW cosine similarity）
 *
 * パフォーマンス目標:
 * - 単一Embedding生成: < 200ms
 * - バッチ100件: < 10s
 * - 類似検索: < 100ms
 *
 * @module services/motion/webgl-animation-embedding.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import {
  validateEmbeddingVector,
  EmbeddingValidationError,
} from '../embedding-validation.service';

// =====================================================
// 定数
// =====================================================

/** デフォルトのモデル名 */
export const DEFAULT_MODEL_NAME = 'multilingual-e5-base';

/** デフォルトのEmbedding次元数 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

// =====================================================
// 型定義
// =====================================================

/**
 * WebGLアニメーションパターン入力型（Embedding生成用）
 * フレーム画像解析で検出されたWebGLアニメーションの特徴を表現
 */
export interface WebGLAnimationPatternData {
  /** パターンID（UUIDv7） */
  id: string;
  /** アニメーションカテゴリ（wave, particle-system, morphing, unknown等） */
  category: string;
  /** 検出されたライブラリ（Three.js, Babylon.js, PixiJS等） */
  libraries: string[];
  /** アニメーションの説明 */
  description?: string | null;
  /** 周期性情報 */
  periodicity?: {
    /** 周期的かどうか */
    isPeriodic: boolean;
    /** 1サイクルの秒数（周期的な場合） */
    cycleSeconds: number | null;
    /** 周期性検出の信頼度（0-1） */
    confidence: number;
  } | null;
  /** 平均変化率（0-1） */
  avgChangeRatio: number;
  /** ピーク変化率（0-1） */
  peakChangeRatio?: number | null;
  /** ビジュアル特徴（gradient-colors, particles, mesh-deformation等） */
  visualFeatures?: string[] | null;
  /** キャンバスサイズ */
  canvasDimensions: {
    width: number;
    height: number;
  };
  /** WebGLバージョン（1または2） */
  webglVersion: 1 | 2;
  /** 解析したフレーム数 */
  framesAnalyzed?: number | null;
  /** 解析したアニメーションの持続時間（ミリ秒） */
  durationMs?: number | null;
  /** WebPageへの参照（任意） */
  webPageId?: string | null;
  /** ソースURL（任意） */
  sourceUrl?: string | null;
}

/**
 * Embedding生成結果
 */
export interface WebGLAnimationEmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト */
  textRepresentation: string;
  /** 使用したモデル名 */
  modelVersion: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs?: number;
  /** DB保存ID（保存した場合） */
  savedEmbeddingId?: string;
}

/**
 * 類似パターン検索結果
 */
export interface SimilarWebGLAnimationResult {
  /** パターンID */
  id: string;
  /** 類似度スコア（0-1） */
  similarity: number;
  /** パターンカテゴリ */
  category?: string;
  /** パターン説明 */
  description?: string;
  /** WebGLバージョン */
  webglVersion?: 1 | 2;
  /** ソースURL */
  sourceUrl?: string;
}

/**
 * EmbeddingServiceインターフェース（DI用）
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): { hits: number; misses: number; size: number; evictions: number };
  clearCache(): void;
}

/**
 * PrismaClientインターフェース（部分的、WebGLAnimationEmbedding用）
 */
export interface IWebGLPrismaClient {
  webGLAnimationEmbedding: {
    upsert: (args: {
      where: { webglAnimationPatternId: string };
      create: {
        webglAnimationPatternId: string;
        textRepresentation: string;
        modelVersion: string;
      };
      update: {
        textRepresentation?: string;
        modelVersion?: string;
        embeddingTimestamp?: Date;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
}

/**
 * WebGLAnimationEmbeddingServiceオプション
 */
export interface WebGLAnimationEmbeddingServiceOptions {
  /** EmbeddingService（DI用） */
  embeddingService?: IEmbeddingService;
  /** モデル名 */
  modelName?: string;
  /** L2正規化を行うか（デフォルト: true） */
  normalize?: boolean;
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IWebGLPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setWebGLAnimationEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetWebGLAnimationEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 */
export function setWebGLPrismaClientFactory(
  factory: () => IWebGLPrismaClient
): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetWebGLPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * L2正規化
 */
function normalizeL2(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map((val) => val / norm);
}

/**
 * モーション強度をテキストに変換
 */
function getMotionIntensityText(avgChangeRatio: number): string {
  if (avgChangeRatio >= 0.4) {
    return 'high motion intensity';
  } else if (avgChangeRatio >= 0.2) {
    return 'moderate motion intensity';
  } else if (avgChangeRatio >= 0.1) {
    return 'low motion intensity';
  }
  return 'minimal motion';
}

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * WebGLAnimationPatternからEmbedding用テキスト表現を生成
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param pattern - WebGLアニメーションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 *
 * @example
 * "passage: WebGL wave animation with Three.js, Perlin noise-based smooth color transitions,
 * periodic 2-second cycle, moderate motion intensity 0.12, gradient colors, geometry-based rendering,
 * full-screen canvas 1920x1080, WebGL 2.0."
 */
export function generateWebGLAnimationTextRepresentation(
  pattern: WebGLAnimationPatternData
): string {
  const parts: string[] = [];

  // カテゴリ（必須）
  parts.push(`WebGL ${pattern.category} animation`);

  // ライブラリ（任意）
  if (pattern.libraries && pattern.libraries.length > 0) {
    parts.push(`with ${pattern.libraries.join(', ')}`);
  }

  // 説明（任意）
  if (pattern.description) {
    parts.push(pattern.description);
  }

  // 周期性情報（任意）
  if (pattern.periodicity) {
    if (pattern.periodicity.isPeriodic && pattern.periodicity.cycleSeconds !== null) {
      parts.push(`periodic ${pattern.periodicity.cycleSeconds}-second cycle`);
    }
    // 非周期的な場合は特に記載しない
  }

  // モーション強度
  const intensityText = getMotionIntensityText(pattern.avgChangeRatio);
  parts.push(`${intensityText} ${pattern.avgChangeRatio.toFixed(2)}`);

  // ビジュアル特徴（任意）
  if (pattern.visualFeatures && pattern.visualFeatures.length > 0) {
    parts.push(pattern.visualFeatures.join(', '));
  }

  // キャンバスサイズ
  const { width, height } = pattern.canvasDimensions;
  parts.push(`canvas ${width}x${height}`);

  // WebGLバージョン
  parts.push(`WebGL ${pattern.webglVersion}.0`);

  // E5モデル用プレフィックス付きで返す
  return `passage: ${parts.join(', ')}.`;
}

// =====================================================
// WebGLAnimationEmbeddingService クラス
// =====================================================

/**
 * WebGLアニメーションパターン用のEmbedding生成サービス
 *
 * @example
 * ```typescript
 * const service = new WebGLAnimationEmbeddingService({
 *   embeddingService: myEmbeddingService,
 * });
 *
 * const result = await service.generateAndSave(pattern, patternId);
 * console.log(result.embedding.length); // 768
 * ```
 */
export class WebGLAnimationEmbeddingService {
  private readonly modelName: string;
  private readonly normalize: boolean;
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IWebGLPrismaClient | null = null;

  constructor(options?: WebGLAnimationEmbeddingServiceOptions) {
    this.modelName = options?.modelName ?? DEFAULT_MODEL_NAME;
    this.normalize = options?.normalize ?? true;

    if (options?.embeddingService) {
      this.embeddingService = options.embeddingService;
    }

    if (isDevelopment()) {
      logger.info('[WebGLAnimationEmbedding] Service created', {
        modelName: this.modelName,
        normalize: this.normalize,
      });
    }
  }

  /**
   * EmbeddingServiceを取得
   */
  private getEmbeddingService(): IEmbeddingService {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    if (embeddingServiceFactory) {
      this.embeddingService = embeddingServiceFactory();
      return this.embeddingService;
    }

    throw new Error(
      'EmbeddingService not initialized. Provide embeddingService in constructor options or set factory.'
    );
  }

  /**
   * PrismaClientを取得
   */
  private getPrismaClient(): IWebGLPrismaClient {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    throw new Error(
      'PrismaClient not initialized. Set factory with setWebGLPrismaClientFactory.'
    );
  }

  /**
   * テキスト表現を生成（公開メソッド）
   *
   * @param pattern - WebGLアニメーションパターン
   * @returns テキスト表現（passage:プレフィックス付き）
   */
  generateTextRepresentation(pattern: WebGLAnimationPatternData): string {
    return generateWebGLAnimationTextRepresentation(pattern);
  }

  /**
   * WebGLアニメーションパターンからEmbeddingを生成・保存
   *
   * @param pattern - WebGLアニメーションパターン情報
   * @param patternId - パターンID（DB保存に使用）
   * @returns Embedding結果
   */
  async generateAndSave(
    pattern: WebGLAnimationPatternData,
    patternId: string
  ): Promise<WebGLAnimationEmbeddingResult> {
    // バリデーション
    if (!pattern || typeof pattern !== 'object') {
      throw new Error('Invalid pattern: must be a valid object');
    }

    if (!pattern.category || !pattern.canvasDimensions) {
      throw new Error('Invalid pattern: category and canvasDimensions are required');
    }

    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[WebGLAnimationEmbedding] Generating embedding', {
        patternId,
        category: pattern.category,
        libraries: pattern.libraries,
      });
    }

    // テキスト表現を生成
    const textRepresentation = generateWebGLAnimationTextRepresentation(pattern);

    // Embedding生成
    const service = this.getEmbeddingService();
    let embedding = await service.generateEmbedding(textRepresentation, 'passage');

    // Embeddingベクトルの検証
    const validationResult = validateEmbeddingVector(embedding);
    if (!validationResult.isValid) {
      const error = validationResult.error;
      const errorMessage =
        error?.index !== undefined
          ? `${error.message} at index ${error.index}`
          : error?.message ?? 'Unknown validation error';
      throw new EmbeddingValidationError(
        error?.code ?? 'INVALID_VECTOR',
        errorMessage,
        error?.index
      );
    }

    // L2正規化
    if (this.normalize) {
      embedding = normalizeL2(embedding);
    }

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[WebGLAnimationEmbedding] Generated embedding', {
        patternId,
        dimensions: embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding,
      textRepresentation,
      modelVersion: this.modelName,
      processingTimeMs,
    };
  }

  /**
   * 類似WebGLアニメーション検索
   *
   * @param queryEmbedding - クエリEmbedding（768次元）
   * @param options - 検索オプション
   * @returns 類似パターン結果配列
   */
  async findSimilar(
    queryEmbedding: number[],
    options: { limit?: number; minSimilarity?: number }
  ): Promise<SimilarWebGLAnimationResult[]> {
    const limit = options.limit ?? 10;
    const minSimilarity = options.minSimilarity ?? 0.5;

    if (isDevelopment()) {
      logger.info('[WebGLAnimationEmbedding] Finding similar patterns', {
        limit,
        minSimilarity,
      });
    }

    try {
      const prisma = this.getPrismaClient();

      // pgvector cosine similarity検索
      const vectorString = `[${queryEmbedding.join(',')}]`;
      const results = (await prisma.$executeRawUnsafe(
        `
        SELECT
          wae.webgl_animation_pattern_id as id,
          1 - (wae.embedding <=> $1::vector) as similarity,
          wap.category,
          wap.description,
          wap.webgl_version as "webglVersion",
          wap.source_url as "sourceUrl"
        FROM webgl_animation_embeddings wae
        JOIN webgl_animation_patterns wap ON wap.id = wae.webgl_animation_pattern_id
        WHERE 1 - (wae.embedding <=> $1::vector) >= $2
        ORDER BY similarity DESC
        LIMIT $3
        `,
        vectorString,
        minSimilarity,
        limit
      )) as SimilarWebGLAnimationResult[];

      if (isDevelopment()) {
        logger.info('[WebGLAnimationEmbedding] Found similar patterns', {
          count: results.length,
        });
      }

      return results;
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[WebGLAnimationEmbedding] findSimilar failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // PrismaClientが初期化されていない場合は空配列を返す
      return [];
    }
  }

  /**
   * キャッシュ統計を取得
   */
  getCacheStats(): { hits: number; misses: number; size: number; evictions: number } {
    try {
      const service = this.getEmbeddingService();
      return service.getCacheStats();
    } catch {
      return { hits: 0, misses: 0, size: 0, evictions: 0 };
    }
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    try {
      const service = this.getEmbeddingService();
      service.clearCache();
    } catch {
      // サービスが初期化されていない場合は何もしない
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let webglAnimationEmbeddingServiceInstance: WebGLAnimationEmbeddingService | null = null;

/**
 * WebGLAnimationEmbeddingServiceインスタンスを取得
 */
export function getWebGLAnimationEmbeddingService(): WebGLAnimationEmbeddingService {
  if (!webglAnimationEmbeddingServiceInstance) {
    webglAnimationEmbeddingServiceInstance = new WebGLAnimationEmbeddingService();
  }
  return webglAnimationEmbeddingServiceInstance;
}

/**
 * WebGLAnimationEmbeddingServiceインスタンスをリセット
 */
export function resetWebGLAnimationEmbeddingService(): void {
  webglAnimationEmbeddingServiceInstance = null;
}

export default WebGLAnimationEmbeddingService;
