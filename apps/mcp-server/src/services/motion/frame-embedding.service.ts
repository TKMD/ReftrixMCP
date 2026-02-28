// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameEmbeddingService
 * VideoModeで取得したフレーム解析結果（FrameImageAnalysisOutput）からEmbeddingを生成するサービス
 *
 * 設計:
 * - AnimationZone/MotionVectorInfoをテキスト表現に変換してEmbedding生成
 * - multilingual-e5-base（768次元）を使用
 * - L2正規化必須
 * - DIパターンでEmbeddingServiceを注入可能
 *
 * パフォーマンス目標:
 * - 単一Embedding: < 200ms
 * - バッチ10件: < 2s
 *
 * @module services/motion/frame-embedding.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import type {
  FrameImageAnalysisOutput,
  AnimationZone,
  LayoutShiftInfo,
  MotionVectorInfo,
} from './frame-image-analyzer.adapter';
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
// キャッシュ統計型
// =====================================================

/**
 * キャッシュ統計
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

// =====================================================
// インターフェース
// =====================================================

/**
 * EmbeddingServiceインターフェース
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): CacheStats;
  clearCache(): void;
}

/**
 * PrismaClient インターフェース（部分的）
 */
export interface IPrismaClient {
  motionPattern: {
    create: (args: {
      data: {
        id?: string;
        webPageId?: string;
        name: string;
        type?: string;
        category: string;
        triggerType: string;
        triggerConfig?: unknown;
        animation: unknown;
        properties: unknown;
        implementation?: unknown;
        accessibility?: unknown;
        performance?: unknown;
        sourceUrl?: string;
        usageScope?: string;
        tags?: string[];
        metadata?: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  motionEmbedding: {
    create: (args: {
      data: {
        motionPatternId: string;
        textRepresentation?: string;
        modelVersion: string;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
}

/**
 * Embedding生成結果
 */
export interface EmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト */
  textUsed: string;
  /** 使用したモデル名 */
  modelName: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム分析Embedding結果（generateFromAnalysis用）
 */
export interface FrameEmbeddingResult {
  /** AnimationZoneごとのEmbedding */
  zoneEmbeddings: EmbeddingResult[];
  /** MotionVectorごとのEmbedding */
  vectorEmbeddings: EmbeddingResult[];
  /** サマリーEmbedding */
  summaryEmbedding: EmbeddingResult;
  /** メタデータ */
  metadata: {
    totalFrames: number;
    analyzedPairs: number;
    framesDir: string;
    analysisTime: string;
  };
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム分析結果の保存入力
 */
export interface SaveFrameAnalysisInput {
  /** フレーム画像分析結果 */
  analysisResult: FrameImageAnalysisOutput;
  /** WebPage ID（任意） */
  webPageId?: string | undefined;
  /** ソースURL（任意） */
  sourceUrl?: string | undefined;
}

/**
 * 保存結果
 */
export interface SavedFrameAnalysisResult {
  /** 保存が成功したか */
  saved: boolean;
  /** 保存したパターン数 */
  savedCount: number;
  /** 保存したパターンID一覧 */
  patternIds: string[];
  /** 保存したパターンID一覧（エイリアス） */
  savedPatternIds: string[];
  /** 保存したEmbedding ID一覧 */
  embeddingIds: string[];
  /** エラー理由（失敗時） */
  reason?: string | undefined;
  /** カテゴリ別保存数 */
  byCategory?: {
    animationZones: number;
    layoutShifts: number;
    motionVectors: number;
  } | undefined;
}

/**
 * FrameEmbeddingServiceオプション
 */
export interface FrameEmbeddingServiceOptions {
  /** モデル名 */
  modelName?: string;
  /** L2正規化を行うか */
  normalize?: boolean;
  /** EmbeddingService（DI用） */
  embeddingService?: IEmbeddingService;
}

/**
 * バッチ処理オプション
 */
export interface BatchOptions {
  /** 進捗コールバック */
  onProgress?: (completed: number, total: number) => void;
  /** エラー時に継続するか */
  continueOnError?: boolean;
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 */
export function setPrismaClientFactory(
  factory: () => IPrismaClient
): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// Backward compatibility aliases
export const setFrameEmbeddingServiceFactory = setEmbeddingServiceFactory;
export const resetFrameEmbeddingServiceFactory = resetEmbeddingServiceFactory;
export const setFramePrismaClientFactory = setPrismaClientFactory;
export const resetFramePrismaClientFactory = resetPrismaClientFactory;

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * AnimationZoneからテキスト表現を生成
 *
 * @example
 * "scroll-linked animation from 500px to 1200px, duration 700px, 15.5% average change"
 */
export function animationZoneToText(zone: AnimationZone): string {
  const parts: string[] = [];

  // アニメーションタイプ
  parts.push(`${zone.animationType} animation zone`);

  // スクロール範囲
  parts.push(`scroll range: ${zone.scrollStart}px to ${zone.scrollEnd}px`);

  // 継続時間
  parts.push(`duration: ${zone.duration}px scroll distance`);

  // 変化量
  parts.push(`average change: ${zone.avgDiff}%`);
  parts.push(`peak change: ${zone.peakDiff}%`);

  // フレーム範囲
  parts.push(`frames: ${zone.frameStart} to ${zone.frameEnd}`);

  return parts.join('. ') + '.';
}

/**
 * LayoutShiftInfoからテキスト表現を生成
 */
export function layoutShiftToText(
  layoutShift: LayoutShiftInfo
): string {
  const parts: string[] = [];

  // タイプ
  parts.push('layout shift detected');

  // フレーム範囲
  parts.push(`frame range: ${layoutShift.frameRange}`);

  // スクロール範囲
  parts.push(`scroll range: ${layoutShift.scrollRange}`);

  // 影響度
  parts.push(`impact fraction: ${layoutShift.impactFraction}`);

  // 境界ボックス
  const bbox = layoutShift.boundingBox;
  parts.push(
    `bounding box: x=${bbox.x}, y=${bbox.y}, width=${bbox.width}, height=${bbox.height}`
  );

  return parts.join('. ') + '.';
}

/**
 * MotionVectorInfoからテキスト表現を生成
 *
 * @example
 * "motion vector moving down at 45 degrees, magnitude 120px"
 */
export function motionVectorToText(vector: MotionVectorInfo): string {
  const parts: string[] = [];

  // タイプ
  parts.push('motion vector detected');

  // 方向
  parts.push(`direction: ${vector.direction}`);

  // フレーム範囲
  parts.push(`frame range: ${vector.frameRange}`);

  // 移動量
  parts.push(`displacement: dx=${vector.dx}px, dy=${vector.dy}px`);

  // 強度
  parts.push(`magnitude: ${vector.magnitude}px`);

  // 角度
  parts.push(`angle: ${vector.angle} degrees`);

  return parts.join('. ') + '.';
}

/**
 * FrameImageAnalysisOutputからテキスト表現を生成
 */
export function frameAnalysisToText(analysis: FrameImageAnalysisOutput): string {
  const parts: string[] = [];

  // メタデータ
  parts.push(`frame analysis: ${analysis.metadata.totalFrames} total frames`);
  parts.push(`analyzed ${analysis.metadata.analyzedPairs} pairs`);
  parts.push(`average diff: ${analysis.statistics.averageDiffPercentage}%`);

  // アニメーションゾーン
  if (analysis.animationZones.length > 0) {
    parts.push(`${analysis.animationZones.length} animation zones detected`);
    for (const zone of analysis.animationZones) {
      parts.push(animationZoneToText(zone));
    }
  }

  // モーションベクトル
  if (analysis.motionVectors.length > 0) {
    parts.push(`${analysis.motionVectors.length} motion vectors detected`);
    for (const vector of analysis.motionVectors) {
      parts.push(motionVectorToText(vector));
    }
  }

  // レイアウトシフト
  if (analysis.layoutShifts.length > 0) {
    parts.push(`${analysis.layoutShifts.length} layout shifts detected`);
    for (const shift of analysis.layoutShifts) {
      parts.push(layoutShiftToText(shift));
    }
  }

  return parts.join(' ');
}

// Backward compatibility aliases
export const animationZoneToTextRepresentation = animationZoneToText;
export const layoutShiftToTextRepresentation = layoutShiftToText;
export const motionVectorToTextRepresentation = motionVectorToText;

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
 * コサイン類似度を計算
 */
function calculateCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimensions do not match: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

// =====================================================
// FrameEmbeddingService クラス
// =====================================================

/**
 * FrameEmbeddingService
 * フレーム画像分析結果からEmbeddingを生成するサービス
 */
export class FrameEmbeddingService {
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;
  private readonly modelName: string;
  private readonly normalize: boolean;

  constructor(options?: FrameEmbeddingServiceOptions) {
    this.modelName = options?.modelName ?? DEFAULT_MODEL_NAME;
    this.normalize = options?.normalize ?? true;

    if (options?.embeddingService) {
      this.embeddingService = options.embeddingService;
    }

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Service initialized', {
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

    throw new Error('EmbeddingService not initialized');
  }

  /**
   * PrismaClientを取得
   */
  private getPrismaClient(): IPrismaClient {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    throw new Error('PrismaClient not initialized');
  }

  /**
   * テキストからEmbeddingを生成
   */
  private async generateEmbeddingFromText(text: string): Promise<number[]> {
    const service = this.getEmbeddingService();
    const embedding = await service.generateEmbedding(`passage: ${text}`, 'passage');

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
      return normalizeL2(embedding);
    }

    return embedding;
  }

  // =====================================================
  // 単一生成メソッド
  // =====================================================

  /**
   * AnimationZoneからEmbeddingを生成
   */
  async generateFromAnimationZone(zone: AnimationZone): Promise<EmbeddingResult> {
    if (!zone || typeof zone !== 'object') {
      throw new Error('Invalid input: zone must be a valid AnimationZone object');
    }

    const startTime = Date.now();
    const textUsed = animationZoneToText(zone);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Generating from animation zone', {
        animationType: zone.animationType,
        scrollRange: `${zone.scrollStart}-${zone.scrollEnd}`,
      });
    }

    const embedding = await this.generateEmbeddingFromText(textUsed);
    const processingTimeMs = Date.now() - startTime;

    return {
      embedding,
      textUsed,
      modelName: this.modelName,
      processingTimeMs,
    };
  }

  /**
   * MotionVectorInfoからEmbeddingを生成
   */
  async generateFromMotionVector(vector: MotionVectorInfo): Promise<EmbeddingResult> {
    if (!vector || typeof vector !== 'object') {
      throw new Error('Invalid input: vector must be a valid MotionVectorInfo object');
    }

    const startTime = Date.now();
    const textUsed = motionVectorToText(vector);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Generating from motion vector', {
        direction: vector.direction,
        magnitude: vector.magnitude,
      });
    }

    const embedding = await this.generateEmbeddingFromText(textUsed);
    const processingTimeMs = Date.now() - startTime;

    return {
      embedding,
      textUsed,
      modelName: this.modelName,
      processingTimeMs,
    };
  }

  /**
   * FrameImageAnalysisOutputからEmbeddingを生成
   */
  async generateFromFrameAnalysis(analysis: FrameImageAnalysisOutput): Promise<EmbeddingResult> {
    if (!analysis || typeof analysis !== 'object') {
      throw new Error('Invalid input: analysis must be a valid FrameImageAnalysisOutput object');
    }

    const startTime = Date.now();
    const textUsed = frameAnalysisToText(analysis);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Generating from frame analysis', {
        totalFrames: analysis.metadata.totalFrames,
        zones: analysis.animationZones.length,
        vectors: analysis.motionVectors.length,
      });
    }

    const embedding = await this.generateEmbeddingFromText(textUsed);
    const processingTimeMs = Date.now() - startTime;

    return {
      embedding,
      textUsed,
      modelName: this.modelName,
      processingTimeMs,
    };
  }

  // =====================================================
  // 配列生成メソッド
  // =====================================================

  /**
   * AnimationZone配列からEmbedding配列を生成
   */
  async generateFromAnimationZones(zones: AnimationZone[]): Promise<EmbeddingResult[]> {
    if (zones.length === 0) {
      return [];
    }

    const texts = zones.map((zone) => animationZoneToText(zone));

    try {
      const service = this.getEmbeddingService();
      const embeddings = await service.generateBatchEmbeddings(
        texts.map((t) => `passage: ${t}`),
        'passage'
      );

      return zones.map((_zone, i) => {
        let embedding = embeddings[i] ?? [];
        if (this.normalize && embedding.length > 0) {
          embedding = normalizeL2(embedding);
        }
        return {
          embedding,
          textUsed: texts[i] ?? '',
          modelName: this.modelName,
          processingTimeMs: 0,
        };
      });
    } catch (error) {
      // バッチ処理が失敗した場合は個別に処理
      if (isDevelopment()) {
        logger.warn('[FrameEmbedding] Batch failed, falling back to individual', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      const results: EmbeddingResult[] = [];
      for (const zone of zones) {
        try {
          const result = await this.generateFromAnimationZone(zone);
          results.push(result);
        } catch {
          // Skip failed ones
        }
      }
      return results;
    }
  }

  /**
   * MotionVectorInfo配列からEmbedding配列を生成
   */
  async generateFromMotionVectors(vectors: MotionVectorInfo[]): Promise<EmbeddingResult[]> {
    if (vectors.length === 0) {
      return [];
    }

    const texts = vectors.map((v) => motionVectorToText(v));

    try {
      const service = this.getEmbeddingService();
      const embeddings = await service.generateBatchEmbeddings(
        texts.map((t) => `passage: ${t}`),
        'passage'
      );

      return vectors.map((_vector, i) => {
        let embedding = embeddings[i] ?? [];
        if (this.normalize && embedding.length > 0) {
          embedding = normalizeL2(embedding);
        }
        return {
          embedding,
          textUsed: texts[i] ?? '',
          modelName: this.modelName,
          processingTimeMs: 0,
        };
      });
    } catch (error) {
      // バッチ処理が失敗した場合は個別に処理
      if (isDevelopment()) {
        logger.warn('[FrameEmbedding] Batch failed, falling back to individual', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      const results: EmbeddingResult[] = [];
      for (const vector of vectors) {
        try {
          const result = await this.generateFromMotionVector(vector);
          results.push(result);
        } catch {
          // Skip failed ones
        }
      }
      return results;
    }
  }

  // =====================================================
  // 統合生成メソッド
  // =====================================================

  /**
   * FrameImageAnalysisOutputから統合Embedding結果を生成
   */
  async generateFromAnalysis(analysis: FrameImageAnalysisOutput): Promise<FrameEmbeddingResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Generating from analysis (integrated)', {
        zones: analysis.animationZones.length,
        vectors: analysis.motionVectors.length,
      });
    }

    // AnimationZonesのEmbedding生成
    const zoneEmbeddings = await this.generateFromAnimationZones(analysis.animationZones);

    // MotionVectorsのEmbedding生成
    const vectorEmbeddings = await this.generateFromMotionVectors(analysis.motionVectors);

    // サマリーEmbedding生成
    const summaryEmbedding = await this.generateFromFrameAnalysis(analysis);

    const processingTimeMs = Date.now() - startTime;

    return {
      zoneEmbeddings,
      vectorEmbeddings,
      summaryEmbedding,
      metadata: {
        totalFrames: analysis.metadata.totalFrames,
        analyzedPairs: analysis.metadata.analyzedPairs,
        framesDir: analysis.metadata.framesDir,
        analysisTime: analysis.metadata.analysisTime,
      },
      processingTimeMs,
    };
  }

  // =====================================================
  // バッチ処理メソッド
  // =====================================================

  /**
   * AnimationZone配列からバッチでEmbeddingを生成（進捗コールバック対応）
   */
  async generateBatchFromAnimationZones(
    zones: AnimationZone[],
    options?: BatchOptions
  ): Promise<EmbeddingResult[]> {
    if (zones.length === 0) {
      return [];
    }

    const continueOnError = options?.continueOnError ?? false;
    const results: EmbeddingResult[] = [];

    try {
      const service = this.getEmbeddingService();
      const texts = zones.map((zone) => animationZoneToText(zone));
      const embeddings = await service.generateBatchEmbeddings(
        texts.map((t) => `passage: ${t}`),
        'passage'
      );

      for (let i = 0; i < zones.length; i++) {
        let embedding = embeddings[i] ?? [];
        if (this.normalize && embedding.length > 0) {
          embedding = normalizeL2(embedding);
        }
        results.push({
          embedding,
          textUsed: texts[i] ?? '',
          modelName: this.modelName,
          processingTimeMs: 0,
        });

        if (options?.onProgress) {
          options.onProgress(i + 1, zones.length);
        }
      }
    } catch (error) {
      // バッチ処理が失敗した場合は個別に処理
      if (isDevelopment()) {
        logger.warn('[FrameEmbedding] Batch failed, falling back to individual', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        if (!zone) continue;

        try {
          const result = await this.generateFromAnimationZone(zone);
          results.push(result);
        } catch (indError) {
          if (!continueOnError) {
            throw indError;
          }
          // continueOnError=trueの場合はスキップ
        }

        if (options?.onProgress) {
          options.onProgress(i + 1, zones.length);
        }
      }
    }

    return results;
  }

  // =====================================================
  // 類似度計算
  // =====================================================

  /**
   * 2つのEmbedding間の類似度を計算
   */
  calculateSimilarity(embedding1: number[], embedding2: number[]): number {
    return calculateCosineSimilarity(embedding1, embedding2);
  }

  // =====================================================
  // キャッシュ管理
  // =====================================================

  /**
   * キャッシュ統計を取得
   */
  getCacheStats(): CacheStats {
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

  // =====================================================
  // DB保存メソッド
  // =====================================================

  /**
   * AnimationZoneをMotionPatternとして保存
   */
  private async saveAnimationZone(
    zone: AnimationZone,
    webPageId: string | undefined,
    sourceUrl: string | undefined
  ): Promise<{ patternId: string; embeddingId: string }> {
    const prisma = this.getPrismaClient();

    const textRepresentation = animationZoneToText(zone);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Saving animation zone', {
        animationType: zone.animationType,
        scrollRange: `${zone.scrollStart}-${zone.scrollEnd}`,
      });
    }

    // MotionPatternを作成
    const patternData: {
      webPageId?: string;
      name: string;
      type: string;
      category: string;
      triggerType: string;
      triggerConfig: unknown;
      animation: unknown;
      properties: unknown;
      implementation: unknown;
      accessibility: unknown;
      performance: unknown;
      sourceUrl?: string;
      usageScope: string;
      tags: string[];
      metadata: unknown;
    } = {
      name: `${zone.animationType}_${zone.scrollStart}-${zone.scrollEnd}`,
      type: `scroll_animation_${zone.animationType}`,
      category: this.mapAnimationTypeToCategory(zone.animationType),
      triggerType: 'scroll',
      triggerConfig: { scrollStart: zone.scrollStart, scrollEnd: zone.scrollEnd },
      animation: {
        duration: zone.duration,
        avgChange: parseFloat(zone.avgDiff),
        peakChange: parseFloat(zone.peakDiff),
      },
      properties: [
        { property: 'opacity', from: '0', to: '1' },
        { property: 'transform', from: 'none', to: 'none' },
      ],
      implementation: {},
      accessibility: {},
      performance: {},
      usageScope: 'inspiration_only',
      tags: ['frame-analysis', zone.animationType],
      metadata: {
        frameStart: zone.frameStart,
        frameEnd: zone.frameEnd,
        analysisSource: 'frame-image-analysis',
      },
    };

    if (webPageId !== undefined) {
      patternData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      patternData.sourceUrl = sourceUrl;
    }

    const createdPattern = await prisma.motionPattern.create({
      data: patternData,
    });

    // Embeddingを生成して保存
    const embeddingId = await this.saveEmbeddingToDb(
      createdPattern.id,
      textRepresentation
    );

    return { patternId: createdPattern.id, embeddingId };
  }

  /**
   * LayoutShiftをMotionPatternとして保存
   */
  private async saveLayoutShift(
    layoutShift: LayoutShiftInfo,
    webPageId: string | undefined,
    sourceUrl: string | undefined
  ): Promise<{ patternId: string; embeddingId: string }> {
    const prisma = this.getPrismaClient();

    const textRepresentation = layoutShiftToText(layoutShift);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Saving layout shift', {
        frameRange: layoutShift.frameRange,
        impactFraction: layoutShift.impactFraction,
      });
    }

    // MotionPatternを作成
    const patternData: {
      webPageId?: string;
      name: string;
      category: string;
      triggerType: string;
      triggerConfig: unknown;
      animation: unknown;
      properties: unknown;
      implementation: unknown;
      accessibility: unknown;
      performance: unknown;
      sourceUrl?: string;
      usageScope: string;
      tags: string[];
      metadata: unknown;
    } = {
      name: `layout_shift_${layoutShift.impactFraction}`,
      category: 'layout_shift',
      triggerType: 'scroll',
      triggerConfig: {},
      animation: {
        impactFraction: parseFloat(layoutShift.impactFraction),
      },
      properties: [
        { property: 'position', from: 'initial', to: 'shifted' },
      ],
      implementation: {},
      accessibility: {
        warnings: ['potential-cls-issue'],
      },
      performance: {
        clsImpact: parseFloat(layoutShift.impactFraction),
      },
      usageScope: 'inspiration_only',
      tags: ['frame-analysis', 'layout-shift', 'cls'],
      metadata: {
        frameRange: layoutShift.frameRange,
        scrollRange: layoutShift.scrollRange,
        boundingBox: layoutShift.boundingBox,
        analysisSource: 'frame-image-analysis',
      },
    };

    if (webPageId !== undefined) {
      patternData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      patternData.sourceUrl = sourceUrl;
    }

    const createdPattern = await prisma.motionPattern.create({
      data: patternData,
    });

    // Embeddingを生成して保存
    const embeddingId = await this.saveEmbeddingToDb(
      createdPattern.id,
      textRepresentation
    );

    return { patternId: createdPattern.id, embeddingId };
  }

  /**
   * MotionVectorをMotionPatternとして保存
   */
  private async saveMotionVector(
    vector: MotionVectorInfo,
    webPageId: string | undefined,
    sourceUrl: string | undefined
  ): Promise<{ patternId: string; embeddingId: string }> {
    const prisma = this.getPrismaClient();

    const textRepresentation = motionVectorToText(vector);

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Saving motion vector', {
        direction: vector.direction,
        magnitude: vector.magnitude,
      });
    }

    // MotionPatternを作成
    const patternData: {
      webPageId?: string;
      name: string;
      category: string;
      triggerType: string;
      triggerConfig: unknown;
      animation: unknown;
      properties: unknown;
      implementation: unknown;
      accessibility: unknown;
      performance: unknown;
      sourceUrl?: string;
      usageScope: string;
      tags: string[];
      metadata: unknown;
    } = {
      name: `motion_${vector.direction}_${vector.magnitude}`,
      category: 'motion_vector',
      triggerType: 'scroll',
      triggerConfig: {},
      animation: {
        dx: vector.dx,
        dy: vector.dy,
        magnitude: parseFloat(vector.magnitude),
        angle: parseFloat(vector.angle),
      },
      properties: [
        { property: 'transform', from: 'translate(0,0)', to: `translate(${vector.dx}px,${vector.dy}px)` },
      ],
      implementation: {},
      accessibility: {},
      performance: {},
      usageScope: 'inspiration_only',
      tags: ['frame-analysis', 'motion-vector', vector.direction],
      metadata: {
        frameRange: vector.frameRange,
        direction: vector.direction,
        analysisSource: 'frame-image-analysis',
      },
    };

    if (webPageId !== undefined) {
      patternData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      patternData.sourceUrl = sourceUrl;
    }

    const createdPattern = await prisma.motionPattern.create({
      data: patternData,
    });

    // Embeddingを生成して保存
    const embeddingId = await this.saveEmbeddingToDb(
      createdPattern.id,
      textRepresentation
    );

    return { patternId: createdPattern.id, embeddingId };
  }

  /**
   * Embeddingを生成してDBに保存
   */
  private async saveEmbeddingToDb(
    patternId: string,
    textRepresentation: string
  ): Promise<string> {
    const prisma = this.getPrismaClient();

    // Embeddingを生成
    let embedding: number[];
    try {
      embedding = await this.generateEmbeddingFromText(textRepresentation);
    } catch (error) {
      // EmbeddingValidationError は再スロー
      if (error instanceof EmbeddingValidationError) {
        throw error;
      }
      if (isDevelopment()) {
        logger.warn('[FrameEmbedding] Embedding generation failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          patternId,
        });
      }
      // Embeddingなしで保存（後でリトライ可能）
      embedding = [];
    }

    // MotionEmbeddingを作成
    const createdEmbedding = await prisma.motionEmbedding.create({
      data: {
        motionPatternId: patternId,
        textRepresentation,
        modelVersion: this.modelName,
      },
    });

    // Embeddingベクトルを更新（pgvector形式）
    if (embedding.length > 0) {
      const vectorString = `[${embedding.join(',')}]`;
      await prisma.$executeRawUnsafe(
        `UPDATE motion_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
        vectorString,
        createdEmbedding.id
      );
    }

    return createdEmbedding.id;
  }

  /**
   * AnimationTypeをDBカテゴリにマッピング
   */
  private mapAnimationTypeToCategory(
    animationType: AnimationZone['animationType']
  ): string {
    switch (animationType) {
      case 'micro-interaction':
        return 'micro_interaction';
      case 'fade/slide transition':
        return 'transition';
      case 'scroll-linked animation':
        return 'scroll_animation';
      case 'long-form reveal':
        return 'reveal_animation';
      default:
        return 'unknown';
    }
  }

  /**
   * フレーム画像分析結果をDBに保存
   */
  async saveFrameAnalysis(
    input: SaveFrameAnalysisInput
  ): Promise<SavedFrameAnalysisResult> {
    const { analysisResult, webPageId, sourceUrl } = input;
    const patternIds: string[] = [];
    const embeddingIds: string[] = [];
    const errors: Array<{ type: string; index: number; error: Error }> = [];

    let animationZonesSaved = 0;
    let layoutShiftsSaved = 0;
    let motionVectorsSaved = 0;

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Starting frame analysis save', {
        animationZones: analysisResult.animationZones.length,
        layoutShifts: analysisResult.layoutShifts.length,
        motionVectors: analysisResult.motionVectors.length,
        webPageId,
      });
    }

    // AnimationZonesを保存
    for (let i = 0; i < analysisResult.animationZones.length; i++) {
      const zone = analysisResult.animationZones[i];
      if (!zone) continue;

      try {
        const result = await this.saveAnimationZone(zone, webPageId, sourceUrl);
        patternIds.push(result.patternId);
        embeddingIds.push(result.embeddingId);
        animationZonesSaved++;
      } catch (error) {
        errors.push({
          type: 'animationZone',
          index: i,
          error: error instanceof Error ? error : new Error('Unknown error'),
        });
        if (isDevelopment()) {
          logger.warn('[FrameEmbedding] Failed to save animation zone', {
            index: i,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    // LayoutShiftsを保存
    for (let i = 0; i < analysisResult.layoutShifts.length; i++) {
      const layoutShift = analysisResult.layoutShifts[i];
      if (!layoutShift) continue;

      try {
        const result = await this.saveLayoutShift(
          layoutShift,
          webPageId,
          sourceUrl
        );
        patternIds.push(result.patternId);
        embeddingIds.push(result.embeddingId);
        layoutShiftsSaved++;
      } catch (error) {
        errors.push({
          type: 'layoutShift',
          index: i,
          error: error instanceof Error ? error : new Error('Unknown error'),
        });
        if (isDevelopment()) {
          logger.warn('[FrameEmbedding] Failed to save layout shift', {
            index: i,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    // MotionVectorsを保存
    for (let i = 0; i < analysisResult.motionVectors.length; i++) {
      const vector = analysisResult.motionVectors[i];
      if (!vector) continue;

      try {
        const result = await this.saveMotionVector(vector, webPageId, sourceUrl);
        patternIds.push(result.patternId);
        embeddingIds.push(result.embeddingId);
        motionVectorsSaved++;
      } catch (error) {
        errors.push({
          type: 'motionVector',
          index: i,
          error: error instanceof Error ? error : new Error('Unknown error'),
        });
        if (isDevelopment()) {
          logger.warn('[FrameEmbedding] Failed to save motion vector', {
            index: i,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    const savedCount = patternIds.length;
    const totalItems =
      analysisResult.animationZones.length +
      analysisResult.layoutShifts.length +
      analysisResult.motionVectors.length;

    if (isDevelopment()) {
      logger.info('[FrameEmbedding] Frame analysis save completed', {
        savedCount,
        totalItems,
        errorCount: errors.length,
        byCategory: {
          animationZones: animationZonesSaved,
          layoutShifts: layoutShiftsSaved,
          motionVectors: motionVectorsSaved,
        },
      });
    }

    const result: SavedFrameAnalysisResult = {
      saved: savedCount > 0,
      savedCount,
      patternIds,
      savedPatternIds: patternIds, // エイリアス（テスト互換性用）
      embeddingIds,
      byCategory: {
        animationZones: animationZonesSaved,
        layoutShifts: layoutShiftsSaved,
        motionVectors: motionVectorsSaved,
      },
    };

    // エラーがある場合は理由を設定
    if (!result.saved && errors.length > 0) {
      const firstError = errors[0];
      result.reason = `Save failed: ${firstError?.error.message || 'Unknown error'} [total=${totalItems}, errors=${errors.length}]`;
    } else if (!result.saved && totalItems === 0) {
      result.reason = 'No items to save';
    }

    return result;
  }

  /**
   * 利用可能かどうかをチェック
   */
  isAvailable(): boolean {
    try {
      this.getPrismaClient();
      return true;
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[FrameEmbedding] isAvailable check failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          hasPrismaClientFactory: prismaClientFactory !== null,
          hasEmbeddingServiceFactory: embeddingServiceFactory !== null,
        });
      }
      return false;
    }
  }
}

// =====================================================
// DB保存関数（非クラスメソッド）
// =====================================================

/**
 * MotionEmbeddingをDBに保存
 *
 * @param motionPatternId - MotionPattern ID
 * @param embedding - Embeddingベクトル
 * @param modelVersion - モデルバージョン（テキスト表現としても使用）
 * @returns 作成されたMotionEmbedding ID
 */
export async function saveMotionEmbedding(
  motionPatternId: string,
  embedding: number[],
  modelVersion: string
): Promise<string> {
  if (!prismaClientFactory) {
    throw new Error('PrismaClient not initialized');
  }

  const prisma = prismaClientFactory();

  // MotionEmbeddingを作成
  const createdEmbedding = await prisma.motionEmbedding.create({
    data: {
      motionPatternId,
      textRepresentation: modelVersion, // テキスト表現としても使用
      modelVersion,
    },
  });

  // Embeddingベクトルを更新（pgvector形式）
  if (embedding.length > 0) {
    const vectorString = `[${embedding.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE motion_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
      vectorString,
      createdEmbedding.id
    );
  }

  return createdEmbedding.id;
}

/**
 * フレーム分析結果をEmbeddingと共にDBに保存
 *
 * @param webPageId - WebPage ID
 * @param analysis - フレーム画像分析結果
 * @param embeddingResult - Embedding結果（オプション、事前生成済みの場合）
 * @returns 保存結果
 */
export async function saveFrameAnalysisWithEmbeddings(
  webPageId: string,
  analysis: FrameImageAnalysisOutput,
  embeddingResult?: FrameEmbeddingResult
): Promise<SavedFrameAnalysisResult> {
  // 新しいインスタンスを作成してDI設定を反映
  // （テスト時にモックファクトリが使用されるようにする）
  const service = new FrameEmbeddingService();
  // embeddingResultは現在未使用（将来の最適化用）
  // 事前に生成されたEmbeddingを再利用する場合に使用可能
  void embeddingResult;
  return service.saveFrameAnalysis({
    analysisResult: analysis,
    webPageId,
  });
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let frameEmbeddingServiceInstance: FrameEmbeddingService | null = null;

/**
 * FrameEmbeddingServiceインスタンスを取得
 */
export function getFrameEmbeddingService(): FrameEmbeddingService {
  if (!frameEmbeddingServiceInstance) {
    frameEmbeddingServiceInstance = new FrameEmbeddingService();
  }
  return frameEmbeddingServiceInstance;
}

/**
 * FrameEmbeddingServiceインスタンスをリセット
 */
export function resetFrameEmbeddingService(): void {
  frameEmbeddingServiceInstance = null;
}

export default FrameEmbeddingService;
