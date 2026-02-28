// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Embedding Service
 *
 * VisualFeatures データから 768 次元 Embedding を生成し、
 * SectionEmbedding.visionEmbedding 列に保存するサービス。
 *
 * Phase 3-3: visionEmbedding列への保存実装
 *
 * 機能:
 * - visualFeaturesToText: VisualFeatures → テキスト表現変換
 * - generateVisionEmbedding: テキスト表現 → 768D Embedding生成
 * - saveVisionEmbedding: DB保存（SectionEmbedding.vision_embedding）
 * - バッチ処理対応
 *
 * @module services/vision-embedding.service
 */

import { isDevelopment, logger } from '../utils/logger';
import type { VisualFeatures } from '../tools/page/schemas';
import {
  LayoutEmbeddingService,
  DEFAULT_MODEL_NAME,
  type IPrismaClient,
} from './layout-embedding.service';

// =====================================================
// 型定義
// =====================================================

/**
 * VisionEmbedding生成結果
 */
export interface VisionEmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト表現 */
  textRepresentation: string;
  /** 使用したモデル名 */
  modelName: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * バッチ処理オプション
 */
export interface VisionBatchOptions {
  /** 進捗コールバック */
  onProgress?: (completed: number, total: number) => void;
  /** エラー時に継続するか（デフォルト: true） */
  continueOnError?: boolean;
}

/**
 * バッチアイテム
 */
export interface VisionEmbeddingBatchItem {
  /** セクションID（SectionEmbedding用） */
  sectionPatternId: string;
  /** VisualFeatures データ */
  visualFeatures: VisualFeatures;
}

/**
 * バッチ処理結果
 */
export interface VisionEmbeddingBatchResult {
  /** 成功件数 */
  successCount: number;
  /** 失敗件数 */
  failedCount: number;
  /** 処理結果の詳細 */
  results: Array<{
    sectionPatternId: string;
    success: boolean;
    embeddingId?: string;
    error?: string;
  }>;
}

// =====================================================
// PrismaClient DI
// =====================================================

let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定（テスト用）
 */
export function setVisionPrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット（テスト用）
 */
export function resetVisionPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// LayoutEmbeddingService DI（VisionEmbeddingService用）
// =====================================================

/**
 * LayoutEmbeddingServiceインターフェース（Vision用）
 */
export interface ILayoutEmbeddingServiceForVision {
  generateFromText(text: string): Promise<{ embedding: number[]; modelName: string }>;
}

let layoutEmbeddingServiceFactory: (() => ILayoutEmbeddingServiceForVision) | null = null;

/**
 * LayoutEmbeddingServiceファクトリを設定（テスト用）
 */
export function setVisionLayoutEmbeddingServiceFactory(
  factory: () => ILayoutEmbeddingServiceForVision
): void {
  layoutEmbeddingServiceFactory = factory;
}

/**
 * LayoutEmbeddingServiceファクトリをリセット（テスト用）
 */
export function resetVisionLayoutEmbeddingServiceFactory(): void {
  layoutEmbeddingServiceFactory = null;
}

/**
 * LayoutEmbeddingServiceを取得（DI対応）
 */
function getLayoutEmbeddingService(): ILayoutEmbeddingServiceForVision {
  if (layoutEmbeddingServiceFactory) {
    return layoutEmbeddingServiceFactory();
  }
  // 本番環境では実際のLayoutEmbeddingServiceを使用
  return new LayoutEmbeddingService();
}

/**
 * PrismaClientを取得
 */
function getPrismaClient(): IPrismaClient {
  if (prismaClientFactory) {
    return prismaClientFactory();
  }

  throw new Error('PrismaClient not initialized. Use setVisionPrismaClientFactory in production.');
}

// =====================================================
// visualFeaturesToText 関数
// =====================================================

/**
 * VisualFeatures からテキスト表現を生成
 *
 * e5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param features - VisualFeatures データ
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function visualFeaturesToText(features: VisualFeatures): string {
  const parts: string[] = [];

  // Colors情報
  if (features.colors) {
    if (features.colors.dominant.length > 0) {
      parts.push(`dominant colors: ${features.colors.dominant.join(', ')}`);
    }
    if (features.colors.accent.length > 0) {
      parts.push(`accent colors: ${features.colors.accent.join(', ')}`);
    }
    // パレット情報（主要な色のみ、最大3色）
    const topPalette = features.colors.palette
      .slice(0, 3)
      .map((p) => `${p.color} (${p.percentage.toFixed(1)}%)`)
      .join(', ');
    if (topPalette.length > 0) {
      parts.push(`color palette: ${topPalette}`);
    }
  }

  // Theme情報
  if (features.theme) {
    parts.push(`theme: ${features.theme.type}`);
    parts.push(`background: ${features.theme.backgroundColor}`);
    parts.push(`text color: ${features.theme.textColor}`);
    parts.push(`contrast ratio: ${features.theme.contrastRatio.toFixed(2)}`);
  }

  // Density情報
  if (features.density) {
    parts.push(`content density: ${(features.density.contentDensity * 100).toFixed(1)}%`);
    parts.push(`whitespace ratio: ${(features.density.whitespaceRatio * 100).toFixed(1)}%`);
    parts.push(`visual balance: ${features.density.visualBalance.toFixed(1)}`);
  }

  // Gradient情報
  if (features.gradient) {
    if (features.gradient.hasGradient) {
      parts.push('has gradient');
      if (features.gradient.dominantGradientType) {
        parts.push(`gradient type: ${features.gradient.dominantGradientType}`);
      }
      // グラデーションの色情報（最初のグラデーントのみ）
      if (features.gradient.gradients.length > 0) {
        const firstGradient = features.gradient.gradients[0];
        if (firstGradient && firstGradient.colorStops.length > 0) {
          const colors = firstGradient.colorStops.map((stop) => stop.color).join(' to ');
          parts.push(`gradient colors: ${colors}`);
        }
      }
    } else {
      parts.push('no gradient');
    }
  }

  // Mood情報（Vision AI）
  if (features.mood) {
    parts.push(`mood: ${features.mood.primary}`);
    if (features.mood.secondary) {
      parts.push(`secondary mood: ${features.mood.secondary}`);
    }
  }

  // BrandTone情報（Vision AI）
  if (features.brandTone) {
    parts.push(`brand tone: ${features.brandTone.primary}`);
    if (features.brandTone.secondary) {
      parts.push(`secondary brand tone: ${features.brandTone.secondary}`);
    }
  }

  // メタデータから信頼度情報を追加
  if (features.metadata) {
    parts.push(`overall confidence: ${(features.metadata.overallConfidence * 100).toFixed(1)}%`);
  }

  // e5モデル用にpassage:プレフィックスを付与
  return `passage: ${parts.join('. ')}.`;
}

/**
 * VisualFeaturesが有効なデータを持っているか確認
 *
 * @param features - VisualFeatures データ
 * @returns 有効なデータがある場合 true
 */
export function hasValidVisualFeatures(features: VisualFeatures | null | undefined): boolean {
  if (!features) {
    return false;
  }

  // 少なくとも1つの有効なフィールドがあるか確認
  return (
    !!features.colors ||
    !!features.theme ||
    !!features.density ||
    !!features.gradient ||
    !!features.mood ||
    !!features.brandTone
  );
}

// =====================================================
// VisionEmbeddingService
// =====================================================

/**
 * Vision Embedding 生成サービス
 */
export class VisionEmbeddingService {
  private layoutEmbeddingService: ILayoutEmbeddingServiceForVision;
  private readonly modelName: string;

  constructor(layoutService?: ILayoutEmbeddingServiceForVision) {
    // DIパターン: 引数で渡された場合はそれを使用、なければファクトリ経由で取得
    this.layoutEmbeddingService = layoutService ?? getLayoutEmbeddingService();
    this.modelName = DEFAULT_MODEL_NAME;
  }

  /**
   * VisualFeatures から Embedding を生成
   *
   * @param features - VisualFeatures データ
   * @returns VisionEmbeddingResult
   */
  async generateEmbedding(features: VisualFeatures): Promise<VisionEmbeddingResult> {
    if (!hasValidVisualFeatures(features)) {
      throw new Error('Invalid VisualFeatures: no valid data');
    }

    const startTime = Date.now();

    // テキスト表現を生成
    const textRepresentation = visualFeaturesToText(features);

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Generating embedding from visual features', {
        textLength: textRepresentation.length,
        hasColors: !!features.colors,
        hasTheme: !!features.theme,
        hasDensity: !!features.density,
        hasGradient: !!features.gradient,
        hasMood: !!features.mood,
        hasBrandTone: !!features.brandTone,
      });
    }

    // LayoutEmbeddingServiceを使用してEmbedding生成
    const result = await this.layoutEmbeddingService.generateFromText(textRepresentation);

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Embedding generated', {
        dimensions: result.embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding: result.embedding,
      textRepresentation,
      modelName: this.modelName,
      processingTimeMs,
    };
  }

  /**
   * バッチ処理で複数の VisualFeatures から Embedding を生成
   *
   * @param items - バッチアイテム配列
   * @param options - バッチオプション
   * @returns バッチ処理結果
   */
  async generateBatch(
    items: VisionEmbeddingBatchItem[],
    options?: VisionBatchOptions
  ): Promise<VisionEmbeddingBatchResult> {
    const result: VisionEmbeddingBatchResult = {
      successCount: 0,
      failedCount: 0,
      results: [],
    };

    if (items.length === 0) {
      return result;
    }

    const continueOnError = options?.continueOnError ?? true;

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Starting batch generation', {
        count: items.length,
      });
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      try {
        // 有効なデータがない場合はスキップ
        if (!hasValidVisualFeatures(item.visualFeatures)) {
          result.results.push({
            sectionPatternId: item.sectionPatternId,
            success: false,
            error: 'No valid visual features data',
          });
          result.failedCount++;
          continue;
        }

        // Embedding生成
        const embeddingResult = await this.generateEmbedding(item.visualFeatures);

        // DB保存
        const embeddingId = await saveVisionEmbedding(
          item.sectionPatternId,
          embeddingResult.embedding,
          embeddingResult.textRepresentation,
          this.modelName
        );

        result.results.push({
          sectionPatternId: item.sectionPatternId,
          success: true,
          embeddingId,
        });
        result.successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.results.push({
          sectionPatternId: item.sectionPatternId,
          success: false,
          error: errorMessage,
        });
        result.failedCount++;

        if (!continueOnError) {
          throw error;
        }

        if (isDevelopment()) {
          logger.warn('[VisionEmbedding] Batch item failed', {
            sectionPatternId: item.sectionPatternId,
            error: errorMessage,
          });
        }
      }

      // 進捗コールバック
      if (options?.onProgress) {
        options.onProgress(i + 1, items.length);
      }
    }

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Batch generation completed', {
        total: items.length,
        successCount: result.successCount,
        failedCount: result.failedCount,
      });
    }

    return result;
  }
}

// =====================================================
// DB保存関数
// =====================================================

/**
 * VisionEmbedding を DB に保存
 *
 * SectionEmbedding.vision_embedding 列にベクトルを保存。
 * 既存のSectionEmbeddingレコードがある場合は更新、なければ作成。
 *
 * @param sectionPatternId - SectionPattern ID
 * @param embedding - 768次元ベクトル
 * @param textRepresentation - テキスト表現（ログ・デバッグ用）
 * @param modelName - モデル名
 * @returns SectionEmbedding ID
 */
export async function saveVisionEmbedding(
  sectionPatternId: string,
  embedding: number[],
  textRepresentation: string,
  modelName: string = DEFAULT_MODEL_NAME
): Promise<string> {
  const prisma = getPrismaClient();

  if (isDevelopment()) {
    logger.info('[VisionEmbedding] Saving vision embedding to DB', {
      sectionPatternId,
      embeddingDimensions: embedding.length,
      textLength: textRepresentation.length,
      modelName,
    });
  }

  // 既存のSectionEmbeddingを確認
  // $queryRawUnsafeを使用してSELECT結果を取得（$executeRawUnsafeは行数のみ返す）
  const existingRecords = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM section_embeddings WHERE section_pattern_id = $1::uuid LIMIT 1`,
    sectionPatternId
  );

  let sectionEmbeddingId: string;

  const existingRecord = existingRecords[0];
  if (existingRecord) {
    // 既存レコードがある場合はvision_embeddingのみ更新（text_embeddingは保持）
    sectionEmbeddingId = existingRecord.id;

    const vectorString = `[${embedding.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
       SET vision_embedding = $1::vector,
           model_version = $2,
           embedding_timestamp = NOW()
       WHERE section_pattern_id = $3::uuid`,
      vectorString,
      modelName,
      sectionPatternId
    );

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Updated existing SectionEmbedding vision_embedding', {
        sectionPatternId,
      });
    }
  } else {
    // 新規作成
    const newRecord = await prisma.sectionEmbedding.create({
      data: {
        sectionPatternId,
        modelVersion: modelName,
        textRepresentation: '', // text_representationはtext_embedding用
      },
    });

    sectionEmbeddingId = newRecord.id;

    // vision_embeddingをraw SQLで設定
    const vectorString = `[${embedding.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings SET vision_embedding = $1::vector WHERE id = $2::uuid`,
      vectorString,
      sectionEmbeddingId
    );

    if (isDevelopment()) {
      logger.info('[VisionEmbedding] Created new SectionEmbedding with vision_embedding', {
        sectionEmbeddingId,
        sectionPatternId,
      });
    }
  }

  return sectionEmbeddingId;
}

/**
 * 既存のSectionEmbeddingにvision_embeddingを追加
 *
 * text_embeddingが既に設定されているレコードに対して、
 * vision_embeddingのみを追加・更新する。
 *
 * @param sectionEmbeddingId - SectionEmbedding ID
 * @param embedding - 768次元ベクトル
 * @param modelName - モデル名
 */
export async function updateVisionEmbedding(
  sectionEmbeddingId: string,
  embedding: number[],
  modelName: string = DEFAULT_MODEL_NAME
): Promise<void> {
  const prisma = getPrismaClient();

  if (isDevelopment()) {
    logger.info('[VisionEmbedding] Updating vision embedding', {
      sectionEmbeddingId,
      embeddingDimensions: embedding.length,
      modelName,
    });
  }

  const vectorString = `[${embedding.join(',')}]`;
  await prisma.$executeRawUnsafe(
    `UPDATE section_embeddings
     SET vision_embedding = $1::vector,
         model_version = $2,
         embedding_timestamp = NOW()
     WHERE id = $3::uuid`,
    vectorString,
    modelName,
    sectionEmbeddingId
  );

  if (isDevelopment()) {
    logger.info('[VisionEmbedding] Vision embedding updated', {
      sectionEmbeddingId,
    });
  }
}

// =====================================================
// ヘルパー関数（page.analyze統合用）
// =====================================================

/**
 * page.analyze から呼び出される統合関数
 *
 * セクションのvisualFeaturesからvisionEmbeddingを生成・保存
 *
 * @param sectionPatternId - SectionPattern ID（DB保存済み）
 * @param visualFeatures - VisualFeatures データ
 * @returns 成功した場合はembeddingId、失敗した場合はnull
 */
export async function generateAndSaveVisionEmbedding(
  sectionPatternId: string,
  visualFeatures: VisualFeatures | null | undefined
): Promise<string | null> {
  if (!hasValidVisualFeatures(visualFeatures)) {
    if (isDevelopment()) {
      logger.info('[VisionEmbedding] No valid visual features, skipping embedding', {
        sectionPatternId,
      });
    }
    return null;
  }

  try {
    // DIパターン: ファクトリ経由でLayoutEmbeddingServiceを取得
    const layoutService = getLayoutEmbeddingService();
    const service = new VisionEmbeddingService(layoutService);
    const result = await service.generateEmbedding(visualFeatures!);

    const embeddingId = await saveVisionEmbedding(
      sectionPatternId,
      result.embedding,
      result.textRepresentation,
      result.modelName
    );

    return embeddingId;
  } catch (error) {
    if (isDevelopment()) {
      logger.warn('[VisionEmbedding] Failed to generate/save vision embedding', {
        sectionPatternId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return null;
  }
}

// =====================================================
// デフォルトエクスポート
// =====================================================

export default VisionEmbeddingService;
