// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionPatternPersistenceService
 * motion.detect で検出したパターンをDBに保存するサービス
 *
 * 機能:
 * - MotionPattern テーブルへの保存
 * - Embedding 生成と MotionEmbedding テーブルへの保存
 * - トランザクション管理
 *
 * @module services/motion-persistence.service
 */

import { isDevelopment, logger } from '../utils/logger';
import type { MotionPattern, MotionSaveResult } from '../tools/motion/schemas';
import { assertNonProductionFactory } from './production-guard';
import {
  validateEmbeddingVector,
  EmbeddingValidationError,
} from './embedding-validation.service';

// =====================================================
// 定数
// =====================================================

/** デフォルトのモデル名 */
export const DEFAULT_MODEL_NAME = 'multilingual-e5-base';

/** デフォルトのEmbedding次元数 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

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
  motionPattern: {
    create: (args: {
      data: {
        id?: string;
        webPageId?: string;
        name: string;
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
  $transaction: <T>(fn: (tx: IPrismaClient) => Promise<T>) => Promise<T>;
}

/**
 * パターン保存入力
 */
export interface SavePatternInput {
  pattern: MotionPattern;
  webPageId?: string | undefined;
  sourceUrl?: string | undefined;
}

/**
 * 保存結果
 */
export interface SavedPatternResult {
  patternId: string;
  embeddingId: string;
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
export function setMotionPersistenceEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (embeddingServiceFactory !== null) {
    assertNonProductionFactory('motionPersistenceEmbeddingService');
  }
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetMotionPersistenceEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setMotionPersistencePrismaClientFactory(
  factory: () => IPrismaClient
): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (prismaClientFactory !== null) {
    assertNonProductionFactory('motionPersistencePrismaClient');
  }
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetMotionPersistencePrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * MotionPatternからテキスト表現を生成
 * Embedding生成に使用
 * @internal テスト用にエクスポート
 */
export function patternToTextRepresentation(pattern: MotionPattern): string {
  const parts: string[] = [];

  // パターンタイプ
  parts.push(`${pattern.type} animation`);

  // パターン名
  if (pattern.name) {
    parts.push(`name: ${pattern.name}`);
  }

  // カテゴリ
  parts.push(`category: ${pattern.category}`);

  // トリガー
  parts.push(`trigger: ${pattern.trigger}`);

  // Duration
  if (pattern.animation.duration !== undefined) {
    parts.push(`duration: ${pattern.animation.duration}ms`);
  }

  // Easing
  if (pattern.animation.easing?.type) {
    parts.push(`easing: ${pattern.animation.easing.type}`);
  }

  // Iterations
  if (pattern.animation.iterations !== undefined) {
    parts.push(`iterations: ${pattern.animation.iterations}`);
  }

  // プロパティ
  if (pattern.properties.length > 0) {
    const propNames = pattern.properties.map((p) => p.property).join(', ');
    parts.push(`properties: ${propNames}`);
  }

  // セレクタ
  if (pattern.selector) {
    parts.push(`selector: ${pattern.selector}`);
  }

  return parts.join('. ') + '.';
}

/**
 * MotionPatternスキーマのカテゴリをDBカラムにマッピング
 * @internal テスト用にエクスポート
 */
export function mapCategoryToDb(category: string): string {
  // スキーマのカテゴリはそのままDBに保存可能
  return category;
}

/**
 * MotionPatternスキーマのトリガーをDBカラムにマッピング
 * @internal テスト用にエクスポート
 */
export function mapTriggerToDb(trigger: string): string {
  // スキーマのトリガーはそのままDBに保存可能
  return trigger;
}

// =====================================================
// MotionPatternPersistenceService
// =====================================================

/**
 * MotionPatternPersistenceServiceクラス
 */
export class MotionPatternPersistenceService {
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

  /**
   * 単一のパターンを保存
   */
  async savePattern(input: SavePatternInput): Promise<SavedPatternResult> {
    const { pattern, webPageId, sourceUrl } = input;
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info('[MotionPersistence] Saving pattern', {
        name: pattern.name,
        type: pattern.type,
        category: pattern.category,
        webPageId,
      });
    }

    // MotionPattern を作成
    const motionPatternData: {
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
      name: pattern.name || `${pattern.type}_${pattern.category}`,
      category: mapCategoryToDb(pattern.category),
      triggerType: mapTriggerToDb(pattern.trigger),
      triggerConfig: {},
      animation: pattern.animation,
      properties: pattern.properties,
      implementation: {},
      accessibility: pattern.accessibility || {},
      performance: pattern.performance || {},
      usageScope: 'inspiration_only',
      tags: [],
      metadata: {
        selector: pattern.selector,
        keyframes: pattern.keyframes,
      },
    };

    // undefined ではない場合のみプロパティを追加
    if (webPageId !== undefined) {
      motionPatternData.webPageId = webPageId;
    }
    if (sourceUrl !== undefined) {
      motionPatternData.sourceUrl = sourceUrl;
    }

    const createdPattern = await prisma.motionPattern.create({
      data: motionPatternData,
    });

    // Embedding を生成
    const textRepresentation = patternToTextRepresentation(pattern);
    let embedding: number[];

    try {
      const embeddingService = this.getEmbeddingService();
      embedding = await embeddingService.generateEmbedding(
        `passage: ${textRepresentation}`,
        'passage'
      );

      // Embedding ベクトルの検証（Phase6-SEC-2対応）
      const validationResult = validateEmbeddingVector(embedding);
      if (!validationResult.isValid) {
        const error = validationResult.error;
        const errorMessage = error?.index !== undefined
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
        logger.warn('[MotionPersistence] Embedding generation failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          patternId: createdPattern.id,
        });
      }
      // Embeddingなしで保存（後でリトライ可能）
      embedding = [];
    }

    // MotionEmbedding を作成
    const createdEmbedding = await prisma.motionEmbedding.create({
      data: {
        motionPatternId: createdPattern.id,
        textRepresentation,
        modelVersion: DEFAULT_MODEL_NAME,
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

    if (isDevelopment()) {
      logger.info('[MotionPersistence] Pattern saved', {
        patternId: createdPattern.id,
        embeddingId: createdEmbedding.id,
        embeddingGenerated: embedding.length > 0,
      });
    }

    return {
      patternId: createdPattern.id,
      embeddingId: createdEmbedding.id,
    };
  }

  /**
   * 複数のパターンを一括保存
   */
  async savePatterns(
    patterns: MotionPattern[],
    options?: {
      webPageId?: string | undefined;
      sourceUrl?: string | undefined;
      continueOnError?: boolean | undefined;
    }
  ): Promise<MotionSaveResult> {
    const { webPageId, sourceUrl, continueOnError = true } = options || {};
    const patternIds: string[] = [];
    const embeddingIds: string[] = [];
    const errors: Array<{ index: number; error: Error }> = [];

    if (patterns.length === 0) {
      return {
        saved: true,
        savedCount: 0,
        patternIds: [],
        embeddingIds: [],
      };
    }

    if (isDevelopment()) {
      logger.info('[MotionPersistence] Saving multiple patterns', {
        count: patterns.length,
        webPageId,
      });
    }

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      if (!pattern) continue;

      try {
        // SavePatternInput を構築（undefined の場合は省略）
        const saveInput: SavePatternInput = { pattern };
        if (webPageId !== undefined) {
          saveInput.webPageId = webPageId;
        }
        if (sourceUrl !== undefined) {
          saveInput.sourceUrl = sourceUrl;
        }
        const result = await this.savePattern(saveInput);
        patternIds.push(result.patternId);
        embeddingIds.push(result.embeddingId);
      } catch (error) {
        if (continueOnError) {
          errors.push({
            index: i,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });
          if (isDevelopment()) {
            logger.warn('[MotionPersistence] Failed to save pattern', {
              index: i,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          throw error;
        }
      }
    }

    const savedCount = patternIds.length;

    if (isDevelopment()) {
      logger.info('[MotionPersistence] Patterns saved', {
        savedCount,
        errorCount: errors.length,
        total: patterns.length,
      });
    }

    // エラーがあれば reason に含める
    const result: MotionSaveResult = {
      saved: savedCount > 0,
      savedCount,
      patternIds,
      embeddingIds,
    };

    // 保存が失敗した場合の reason 設定（デバッグ情報を含む）
    if (!result.saved) {
      const debugInfo = `[patterns=${patterns.length}, errors=${errors.length}, savedCount=${savedCount}]`;
      if (errors.length > 0) {
        const firstError = errors[0]?.error;
        result.reason = `Save failed: ${firstError?.message || 'Unknown error'} ${debugInfo}`;
      } else if (patterns.length > 0 && savedCount === 0) {
        // パターンがあるのに savedCount が 0 で errors も空の場合（予期しない状態）
        result.reason = `Unexpected: patterns exist but no saves and no errors recorded ${debugInfo}`;
      } else {
        result.reason = `Unknown failure ${debugInfo}`;
      }
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
        logger.warn('[MotionPersistence] isAvailable check failed', {
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
// シングルトンインスタンス
// =====================================================

let motionPersistenceServiceInstance: MotionPatternPersistenceService | null = null;

/**
 * MotionPatternPersistenceServiceインスタンスを取得
 */
export function getMotionPersistenceService(): MotionPatternPersistenceService {
  if (!motionPersistenceServiceInstance) {
    motionPersistenceServiceInstance = new MotionPatternPersistenceService();
  }
  return motionPersistenceServiceInstance;
}

/**
 * MotionPatternPersistenceServiceインスタンスをリセット
 */
export function resetMotionPersistenceService(): void {
  motionPersistenceServiceInstance = null;
}

export default MotionPatternPersistenceService;
