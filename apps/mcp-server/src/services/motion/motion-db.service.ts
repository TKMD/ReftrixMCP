// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionDbService
 *
 * Frame Image Analysis結果をMotionAnalysisResult/MotionAnalysisEmbeddingテーブルに保存するサービス
 *
 * 設計方針:
 * - MotionAnalysisResult テーブルに AnimationZone, LayoutShift, MotionVector を保存
 * - MotionAnalysisEmbedding テーブルに768次元ベクトル（multilingual-e5-base）を保存
 * - UUIDv7を使用（時間順序保証）
 * - DIパターンでEmbeddingService/PrismaClientを注入可能
 *
 * テーブル構造:
 * - resultType: 'animation_zone' | 'layout_shift' | 'motion_vector'
 * - resultData: 各タイプ固有のJSONデータ
 * - affectedRegions: BoundingBox[]のJSON
 *
 * @module services/motion/motion-db.service
 */

import { v7 as uuidv7 } from 'uuid';
import { isDevelopment, logger } from '../../utils/logger';
import type {
  AnimationZone,
  LayoutShiftInfo,
  MotionVectorInfo,
  FrameImageAnalysisOutput,
} from './frame-image-analyzer.adapter';
import { assertNonProductionFactory } from '../production-guard';
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

/** デフォルトのFPS */
export const DEFAULT_FPS = 30;

/** 結果タイプ */
export const RESULT_TYPES = {
  ANIMATION_ZONE: 'animation_zone',
  LAYOUT_SHIFT: 'layout_shift',
  MOTION_VECTOR: 'motion_vector',
} as const;

export type ResultType = (typeof RESULT_TYPES)[keyof typeof RESULT_TYPES];

// =====================================================
// インターフェース
// =====================================================

/**
 * EmbeddingServiceインターフェース
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
}

/**
 * PrismaClient インターフェース（部分的）
 */
export interface IPrismaClient {
  motionAnalysisResult: {
    create: (args: {
      data: {
        id: string;
        webPageId?: string;
        resultType: string;
        frameIndex: number;
        fps: number;
        resultData: unknown;
        affectedRegions: unknown;
        metadata: unknown;
        sourceUrl?: string;
        usageScope: string;
      };
    }) => Promise<{ id: string }>;
  };
  motionAnalysisEmbedding: {
    create: (args: {
      data: {
        id: string;
        motionAnalysisResultId: string;
        textRepresentation?: string;
        modelVersion: string;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(fn: (tx: IPrismaClient) => Promise<T>) => Promise<T>;
}

/**
 * AnimationZone保存入力
 */
export interface SaveAnimationZoneInput {
  zone: AnimationZone;
  webPageId?: string | undefined;
  sourceUrl?: string | undefined;
  embedding?: number[] | undefined;
}

/**
 * LayoutShift保存入力
 */
export interface SaveLayoutShiftInput {
  layoutShift: LayoutShiftInfo;
  webPageId?: string | undefined;
  sourceUrl?: string | undefined;
  embedding?: number[] | undefined;
}

/**
 * MotionVector保存入力
 */
export interface SaveMotionVectorInput {
  vector: MotionVectorInfo;
  webPageId?: string | undefined;
  sourceUrl?: string | undefined;
  embedding?: number[] | undefined;
}

/**
 * 保存結果
 */
export interface SavedResult {
  /** 結果ID */
  resultId: string;
  /** Embedding ID */
  embeddingId: string;
}

/**
 * バッチ保存結果
 */
export interface BatchSaveResult {
  /** 保存が成功したか */
  saved: boolean;
  /** 保存した件数 */
  savedCount: number;
  /** 保存した結果ID一覧 */
  resultIds: string[];
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

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setMotionDbEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  if (embeddingServiceFactory !== null) {
    assertNonProductionFactory('motionDbEmbeddingService');
  }
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetMotionDbEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setMotionDbPrismaClientFactory(
  factory: () => IPrismaClient
): void {
  if (prismaClientFactory !== null) {
    assertNonProductionFactory('motionDbPrismaClient');
  }
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetMotionDbPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * AnimationZoneからテキスト表現を生成
 * Embedding生成に使用
 *
 * @internal テスト用にエクスポート
 */
export function animationZoneToTextRepresentation(zone: AnimationZone): string {
  const parts: string[] = [];

  // アニメーションタイプ
  parts.push(`${zone.animationType} animation zone`);

  // スクロール範囲
  parts.push(`scroll range: ${zone.scrollStart}px to ${zone.scrollEnd}px`);

  // 継続時間（スクロール距離）
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
 *
 * @internal テスト用にエクスポート
 */
export function layoutShiftToTextRepresentation(
  layoutShift: LayoutShiftInfo
): string {
  const parts: string[] = [];

  // タイプ
  parts.push('layout shift detected (CLS issue)');

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
 * @internal テスト用にエクスポート
 */
export function motionVectorToTextRepresentation(
  vector: MotionVectorInfo
): string {
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
 * フレーム名からフレームインデックスを抽出
 *
 * @internal
 */
function extractFrameIndex(frameName: string): number {
  const match = frameName.match(/frame-(\d+)/);
  const numStr = match?.[1];
  return numStr ? parseInt(numStr, 10) : 0;
}

// =====================================================
// MotionDbService クラス
// =====================================================

/**
 * MotionDbService
 *
 * Frame Image Analysis結果をMotionAnalysisResult/MotionAnalysisEmbeddingテーブルに保存
 */
export class MotionDbService {
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;

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

  // =====================================================
  // Public API
  // =====================================================

  /**
   * AnimationZoneをMotionAnalysisResultとして保存
   *
   * @param input - 保存入力
   * @returns 保存結果（resultId, embeddingId）
   */
  async saveAnimationZone(input: SaveAnimationZoneInput): Promise<SavedResult> {
    const { zone, webPageId, sourceUrl, embedding: providedEmbedding } = input;
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info('[MotionDb] Saving animation zone', {
        animationType: zone.animationType,
        scrollRange: `${zone.scrollStart}-${zone.scrollEnd}`,
      });
    }

    // UUIDv7生成
    const resultId = uuidv7();
    const embeddingId = uuidv7();

    // テキスト表現生成
    const textRepresentation = animationZoneToTextRepresentation(zone);

    // フレームインデックス抽出
    const frameIndex = extractFrameIndex(zone.frameStart);

    // resultData構築
    const resultData = {
      animationType: zone.animationType,
      scrollStart: zone.scrollStart,
      scrollEnd: zone.scrollEnd,
      duration: zone.duration,
      avgDiff: parseFloat(zone.avgDiff),
      peakDiff: parseFloat(zone.peakDiff),
      frameStart: zone.frameStart,
      frameEnd: zone.frameEnd,
    };

    // affectedRegions（AnimationZoneはboundingBoxがないので空配列）
    const affectedRegions: unknown[] = [];

    // MotionAnalysisResult作成
    const createData: {
      id: string;
      webPageId?: string;
      resultType: string;
      frameIndex: number;
      fps: number;
      resultData: unknown;
      affectedRegions: unknown;
      metadata: unknown;
      sourceUrl?: string;
      usageScope: string;
    } = {
      id: resultId,
      resultType: RESULT_TYPES.ANIMATION_ZONE,
      frameIndex,
      fps: DEFAULT_FPS,
      resultData,
      affectedRegions,
      metadata: {
        textRepresentation,
        analysisSource: 'frame-image-analysis',
      },
      usageScope: 'inspiration_only',
    };

    if (webPageId !== undefined) {
      createData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      createData.sourceUrl = sourceUrl;
    }

    await prisma.motionAnalysisResult.create({ data: createData });

    // Embedding処理
    const savedEmbeddingId = await this.saveEmbedding(
      embeddingId,
      resultId,
      textRepresentation,
      providedEmbedding
    );

    if (isDevelopment()) {
      logger.info('[MotionDb] Animation zone saved', {
        resultId,
        embeddingId: savedEmbeddingId,
      });
    }

    return { resultId, embeddingId: savedEmbeddingId };
  }

  /**
   * LayoutShiftをMotionAnalysisResultとして保存
   *
   * @param input - 保存入力
   * @returns 保存結果（resultId, embeddingId）
   */
  async saveLayoutShift(input: SaveLayoutShiftInput): Promise<SavedResult> {
    const { layoutShift, webPageId, sourceUrl, embedding: providedEmbedding } = input;
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info('[MotionDb] Saving layout shift', {
        frameRange: layoutShift.frameRange,
        impactFraction: layoutShift.impactFraction,
      });
    }

    // UUIDv7生成
    const resultId = uuidv7();
    const embeddingId = uuidv7();

    // テキスト表現生成
    const textRepresentation = layoutShiftToTextRepresentation(layoutShift);

    // フレームインデックス抽出（frameRangeから）
    const frameMatch = layoutShift.frameRange.match(/frame-(\d+)/);
    const frameNumStr = frameMatch?.[1];
    const frameIndex = frameNumStr ? parseInt(frameNumStr, 10) : 0;

    // resultData構築
    const resultData = {
      frameRange: layoutShift.frameRange,
      scrollRange: layoutShift.scrollRange,
      impactFraction: parseFloat(layoutShift.impactFraction),
      estimatedCause: 'unknown', // フレーム分析では原因特定が難しい
    };

    // affectedRegions
    const affectedRegions = [layoutShift.boundingBox];

    // MotionAnalysisResult作成
    const createData: {
      id: string;
      webPageId?: string;
      resultType: string;
      frameIndex: number;
      fps: number;
      resultData: unknown;
      affectedRegions: unknown;
      metadata: unknown;
      sourceUrl?: string;
      usageScope: string;
    } = {
      id: resultId,
      resultType: RESULT_TYPES.LAYOUT_SHIFT,
      frameIndex,
      fps: DEFAULT_FPS,
      resultData,
      affectedRegions,
      metadata: {
        textRepresentation,
        analysisSource: 'frame-image-analysis',
        clsWarning: 'potential-cls-issue',
      },
      usageScope: 'inspiration_only',
    };

    if (webPageId !== undefined) {
      createData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      createData.sourceUrl = sourceUrl;
    }

    await prisma.motionAnalysisResult.create({ data: createData });

    // Embedding処理
    const savedEmbeddingId = await this.saveEmbedding(
      embeddingId,
      resultId,
      textRepresentation,
      providedEmbedding
    );

    if (isDevelopment()) {
      logger.info('[MotionDb] Layout shift saved', {
        resultId,
        embeddingId: savedEmbeddingId,
      });
    }

    return { resultId, embeddingId: savedEmbeddingId };
  }

  /**
   * MotionVectorをMotionAnalysisResultとして保存
   *
   * @param input - 保存入力
   * @returns 保存結果（resultId, embeddingId）
   */
  async saveMotionVector(input: SaveMotionVectorInput): Promise<SavedResult> {
    const { vector, webPageId, sourceUrl, embedding: providedEmbedding } = input;
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info('[MotionDb] Saving motion vector', {
        direction: vector.direction,
        magnitude: vector.magnitude,
      });
    }

    // UUIDv7生成
    const resultId = uuidv7();
    const embeddingId = uuidv7();

    // テキスト表現生成
    const textRepresentation = motionVectorToTextRepresentation(vector);

    // フレームインデックス抽出（frameRangeから）
    const frameMatch = vector.frameRange.match(/frame-(\d+)/);
    const frameNumStr = frameMatch?.[1];
    const frameIndex = frameNumStr ? parseInt(frameNumStr, 10) : 0;

    // resultData構築
    const resultData = {
      dominantDirection: parseFloat(vector.angle),
      avgSpeed: parseFloat(vector.magnitude),
      maxSpeed: parseFloat(vector.magnitude),
      confidence: 0.85, // フレーム分析のデフォルト信頼度
      motionType: this.mapDirectionToMotionType(vector.direction),
      dx: vector.dx,
      dy: vector.dy,
    };

    // affectedRegions（MotionVectorはboundingBoxがないので空配列）
    const affectedRegions: unknown[] = [];

    // MotionAnalysisResult作成
    const createData: {
      id: string;
      webPageId?: string;
      resultType: string;
      frameIndex: number;
      fps: number;
      resultData: unknown;
      affectedRegions: unknown;
      metadata: unknown;
      sourceUrl?: string;
      usageScope: string;
    } = {
      id: resultId,
      resultType: RESULT_TYPES.MOTION_VECTOR,
      frameIndex,
      fps: DEFAULT_FPS,
      resultData,
      affectedRegions,
      metadata: {
        textRepresentation,
        analysisSource: 'frame-image-analysis',
        direction: vector.direction,
      },
      usageScope: 'inspiration_only',
    };

    if (webPageId !== undefined) {
      createData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      createData.sourceUrl = sourceUrl;
    }

    await prisma.motionAnalysisResult.create({ data: createData });

    // Embedding処理
    const savedEmbeddingId = await this.saveEmbedding(
      embeddingId,
      resultId,
      textRepresentation,
      providedEmbedding
    );

    if (isDevelopment()) {
      logger.info('[MotionDb] Motion vector saved', {
        resultId,
        embeddingId: savedEmbeddingId,
      });
    }

    return { resultId, embeddingId: savedEmbeddingId };
  }

  /**
   * Frame Image Analysis結果をバッチ保存
   *
   * @param input - FrameImageAnalysisOutput
   * @param options - 保存オプション
   * @returns バッチ保存結果
   */
  async saveFrameAnalysis(
    input: FrameImageAnalysisOutput,
    options?: {
      webPageId?: string | undefined;
      sourceUrl?: string | undefined;
      continueOnError?: boolean | undefined;
    }
  ): Promise<BatchSaveResult> {
    const { webPageId, sourceUrl, continueOnError = true } = options ?? {};
    const resultIds: string[] = [];
    const embeddingIds: string[] = [];
    const errors: Array<{ type: string; index: number; error: Error }> = [];

    let animationZonesSaved = 0;
    let layoutShiftsSaved = 0;
    let motionVectorsSaved = 0;

    if (isDevelopment()) {
      logger.info('[MotionDb] Starting frame analysis batch save', {
        animationZones: input.animationZones.length,
        layoutShifts: input.layoutShifts.length,
        motionVectors: input.motionVectors.length,
        webPageId,
      });
    }

    // AnimationZonesを保存
    for (let i = 0; i < input.animationZones.length; i++) {
      const zone = input.animationZones[i];
      if (!zone) continue;

      try {
        const result = await this.saveAnimationZone({ zone, webPageId, sourceUrl });
        resultIds.push(result.resultId);
        embeddingIds.push(result.embeddingId);
        animationZonesSaved++;
      } catch (error) {
        if (continueOnError) {
          errors.push({
            type: 'animationZone',
            index: i,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });
          if (isDevelopment()) {
            logger.warn('[MotionDb] Failed to save animation zone', {
              index: i,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          throw error;
        }
      }
    }

    // LayoutShiftsを保存
    for (let i = 0; i < input.layoutShifts.length; i++) {
      const layoutShift = input.layoutShifts[i];
      if (!layoutShift) continue;

      try {
        const result = await this.saveLayoutShift({ layoutShift, webPageId, sourceUrl });
        resultIds.push(result.resultId);
        embeddingIds.push(result.embeddingId);
        layoutShiftsSaved++;
      } catch (error) {
        if (continueOnError) {
          errors.push({
            type: 'layoutShift',
            index: i,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });
          if (isDevelopment()) {
            logger.warn('[MotionDb] Failed to save layout shift', {
              index: i,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          throw error;
        }
      }
    }

    // MotionVectorsを保存
    for (let i = 0; i < input.motionVectors.length; i++) {
      const vector = input.motionVectors[i];
      if (!vector) continue;

      try {
        const result = await this.saveMotionVector({ vector, webPageId, sourceUrl });
        resultIds.push(result.resultId);
        embeddingIds.push(result.embeddingId);
        motionVectorsSaved++;
      } catch (error) {
        if (continueOnError) {
          errors.push({
            type: 'motionVector',
            index: i,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });
          if (isDevelopment()) {
            logger.warn('[MotionDb] Failed to save motion vector', {
              index: i,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          throw error;
        }
      }
    }

    const savedCount = resultIds.length;
    const totalItems =
      input.animationZones.length +
      input.layoutShifts.length +
      input.motionVectors.length;

    if (isDevelopment()) {
      logger.info('[MotionDb] Frame analysis batch save completed', {
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

    const result: BatchSaveResult = {
      saved: savedCount > 0,
      savedCount,
      resultIds,
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
      result.reason = `Save failed: ${firstError?.error.message ?? 'Unknown error'} [total=${totalItems}, errors=${errors.length}]`;
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
        logger.warn('[MotionDb] isAvailable check failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          hasPrismaClientFactory: prismaClientFactory !== null,
          hasEmbeddingServiceFactory: embeddingServiceFactory !== null,
        });
      }
      return false;
    }
  }

  // =====================================================
  // Private Methods
  // =====================================================

  /**
   * Embeddingを生成してDBに保存
   *
   * @param embeddingId - 事前生成されたUUIDv7
   * @param resultId - MotionAnalysisResultのID
   * @param textRepresentation - テキスト表現
   * @param providedEmbedding - 事前生成されたEmbedding（オプション）
   * @returns 保存されたEmbedding ID
   */
  private async saveEmbedding(
    embeddingId: string,
    resultId: string,
    textRepresentation: string,
    providedEmbedding?: number[] | undefined
  ): Promise<string> {
    const prisma = this.getPrismaClient();

    // Embeddingを生成（提供されていない場合）
    let embedding: number[];
    if (providedEmbedding && providedEmbedding.length > 0) {
      embedding = providedEmbedding;
    } else {
      try {
        const embeddingService = this.getEmbeddingService();
        embedding = await embeddingService.generateEmbedding(
          `passage: ${textRepresentation}`,
          'passage'
        );

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
      } catch (error) {
        // EmbeddingValidationError は再スロー
        if (error instanceof EmbeddingValidationError) {
          throw error;
        }
        if (isDevelopment()) {
          logger.warn('[MotionDb] Embedding generation failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
            resultId,
          });
        }
        // Embeddingなしで保存（後でリトライ可能）
        embedding = [];
      }
    }

    // MotionAnalysisEmbeddingを作成
    await prisma.motionAnalysisEmbedding.create({
      data: {
        id: embeddingId,
        motionAnalysisResultId: resultId,
        textRepresentation,
        modelVersion: DEFAULT_MODEL_NAME,
      },
    });

    // Embeddingベクトルを更新（pgvector形式）
    if (embedding.length > 0) {
      const vectorString = `[${embedding.join(',')}]`;
      await prisma.$executeRawUnsafe(
        `UPDATE motion_analysis_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
        vectorString,
        embeddingId
      );
    }

    return embeddingId;
  }

  /**
   * MotionDirectionをMotionTypeにマッピング
   */
  private mapDirectionToMotionType(
    direction: MotionVectorInfo['direction']
  ): string {
    switch (direction) {
      case 'up':
        return 'slide_up';
      case 'down':
        return 'slide_down';
      case 'left':
        return 'slide_left';
      case 'right':
        return 'slide_right';
      case 'stationary':
      default:
        return 'static';
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let motionDbServiceInstance: MotionDbService | null = null;

/**
 * MotionDbServiceインスタンスを取得
 */
export function getMotionDbService(): MotionDbService {
  if (!motionDbServiceInstance) {
    motionDbServiceInstance = new MotionDbService();
  }
  return motionDbServiceInstance;
}

/**
 * MotionDbServiceインスタンスをリセット
 */
export function resetMotionDbService(): void {
  motionDbServiceInstance = null;
}

export default MotionDbService;
