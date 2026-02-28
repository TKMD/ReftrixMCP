// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background Design Embedding Service
 *
 * BackgroundDesign レコードからテキスト表現を生成し、
 * multilingual-e5-base (768D) Embedding を生成・DB保存するサービス。
 * pgvector HNSW cosine similarity を使用したセマンティック検索も提供。
 *
 * パターン:
 * - SectionEmbedding / MotionEmbedding と同一の DI パターン
 * - passage: プレフィックスでドキュメント Embedding 生成
 * - query: プレフィックスで検索クエリ Embedding 生成
 * - 2段階DB保存: Prisma create → raw SQL で vector 更新
 * - Graceful Degradation（部分失敗時も継続）
 *
 * @module services/background/background-design-embedding
 */

import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * Embedding 生成用の背景デザインデータ
 *
 * BackgroundDesign テーブルから取得したデータの部分型。
 * テキスト表現生成に必要なフィールドのみを定義。
 */
export interface BackgroundDesignForText {
  /** デザイン名（例: "hero linear gradient, 135deg"） */
  name: string;
  /** デザインタイプ（例: "linear_gradient", "glassmorphism"） */
  designType: string;
  /** CSSセレクタ（例: ".hero"） */
  selector?: string | undefined;
  /** 色彩情報 */
  colorInfo?: {
    dominantColors?: string[];
    colorCount?: number;
    hasAlpha?: boolean;
    colorSpace?: string;
  } | undefined;
  /** グラデーション情報 */
  gradientInfo?: {
    type?: string;
    angle?: number;
    stops?: Array<{ color: string; position: number }>;
    repeating?: boolean;
  } | undefined;
  /** 視覚プロパティ */
  visualProperties?: {
    blurRadius?: number;
    opacity?: number;
    blendMode?: string;
    hasOverlay?: boolean;
    layers?: number;
  } | undefined;
  /** アニメーション情報 */
  animationInfo?: {
    isAnimated?: boolean;
    animationName?: string;
    duration?: string;
    easing?: string;
  } | undefined;
}

/**
 * Embedding 生成結果
 */
export interface BackgroundDesignEmbeddingResult {
  /** 全体の成功フラグ（部分成功でもtrue） */
  success: boolean;
  /** 生成成功件数 */
  generatedCount: number;
  /** 生成失敗件数 */
  failedCount: number;
  /** エラー詳細配列 */
  errors: Array<{
    name: string;
    error: string;
  }>;
}

/**
 * セマンティック検索結果
 */
export interface BackgroundDesignSearchResult {
  /** BackgroundDesign ID */
  id: string;
  /** デザイン名 */
  name: string;
  /** デザインタイプ */
  design_type: string;
  /** テキスト表現 */
  text_representation: string;
  /** コサイン類似度スコア */
  similarity: number;
  /** CSS値 */
  css_value: string;
  /** CSSセレクタ */
  selector: string | null;
  /** 色彩情報 */
  color_info: Record<string, unknown>;
  /** WebPage ID */
  web_page_id: string | null;
}

/**
 * 検索オプション
 */
export interface BackgroundDesignSearchOptions {
  /** デザインタイプフィルタ */
  designType?: string | undefined;
  /** 返却件数上限（デフォルト: 10） */
  limit?: number | undefined;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

/**
 * EmbeddingService の最小インターフェース
 *
 * LayoutEmbeddingService.generateFromText と互換性のある形式。
 * テスト時にモックを注入するための DI ポイント。
 */
interface IBackgroundEmbeddingService {
  generateFromText(text: string): Promise<{
    embedding: number[];
    modelName: string;
    textUsed: string;
    processingTimeMs: number;
  }>;
}

// ファクトリ関数（テスト時の DI 用）
let backgroundEmbeddingServiceFactory: (() => IBackgroundEmbeddingService) | null = null;

/**
 * EmbeddingService ファクトリを設定（テスト用）
 */
export function setBackgroundEmbeddingServiceFactory(
  factory: () => IBackgroundEmbeddingService
): void {
  backgroundEmbeddingServiceFactory = factory;
}

/**
 * EmbeddingService ファクトリをリセット（テスト用）
 */
export function resetBackgroundEmbeddingServiceFactory(): void {
  backgroundEmbeddingServiceFactory = null;
}

// =====================================================
// PrismaClient インターフェース（DI用）
// =====================================================

/**
 * PrismaClient の最小インターフェース（背景デザイン Embedding 用）
 */
interface IBackgroundPrismaClient {
  backgroundDesignEmbedding: {
    create: (args: {
      data: {
        backgroundDesignId: string;
        textRepresentation: string;
        modelVersion: string;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

// ファクトリ関数（テスト時の DI 用）
let backgroundPrismaClientFactory: (() => IBackgroundPrismaClient) | null = null;

/**
 * PrismaClient ファクトリを設定（テスト用）
 */
export function setBackgroundPrismaClientFactory(
  factory: () => IBackgroundPrismaClient
): void {
  backgroundPrismaClientFactory = factory;
}

/**
 * PrismaClient ファクトリをリセット（テスト用）
 */
export function resetBackgroundPrismaClientFactory(): void {
  backgroundPrismaClientFactory = null;
}

// =====================================================
// ヘルパー: サービス取得
// =====================================================

/**
 * EmbeddingService を取得（DI 対応）
 */
function getEmbeddingService(): IBackgroundEmbeddingService {
  if (backgroundEmbeddingServiceFactory) {
    return backgroundEmbeddingServiceFactory();
  }
  throw new Error(
    'BackgroundEmbeddingService not initialized. Use setBackgroundEmbeddingServiceFactory.'
  );
}

/**
 * PrismaClient を取得（DI 対応）
 */
function getPrismaClient(): IBackgroundPrismaClient {
  if (backgroundPrismaClientFactory) {
    return backgroundPrismaClientFactory();
  }
  throw new Error(
    'BackgroundPrismaClient not initialized. Use setBackgroundPrismaClientFactory.'
  );
}

// =====================================================
// テキスト表現生成
// =====================================================

/**
 * BackgroundDesign からセマンティック検索用テキスト表現を生成
 *
 * E5 モデルの passage: プレフィックスを付与し、
 * デザインの特徴を構造化テキストとして表現する。
 *
 * @param bg - 背景デザインデータ
 * @returns passage: プレフィックス付きテキスト表現
 */
export function generateBackgroundDesignTextRepresentation(
  bg: BackgroundDesignForText
): string {
  const parts: string[] = [];

  // デザインタイプ（アンダースコアをスペースに変換）
  const designTypeReadable = bg.designType.replace(/_/g, ' ');
  parts.push(`Background design type: ${designTypeReadable}`);

  // デザイン名
  parts.push(`Name: ${bg.name}`);

  // CSSセレクタ
  if (bg.selector) {
    parts.push(`Selector: ${bg.selector}`);
  }

  // 色彩情報
  if (bg.colorInfo?.dominantColors && bg.colorInfo.dominantColors.length > 0) {
    parts.push(`Colors: ${bg.colorInfo.dominantColors.join(', ')}`);
  }

  // グラデーション情報
  if (bg.gradientInfo) {
    const gradientParts: string[] = [];

    if (bg.gradientInfo.type) {
      gradientParts.push(`${bg.gradientInfo.type} gradient`);
    }
    if (bg.gradientInfo.angle !== undefined) {
      gradientParts.push(`${bg.gradientInfo.angle}deg`);
    }
    if (bg.gradientInfo.stops && bg.gradientInfo.stops.length > 0) {
      gradientParts.push(`${bg.gradientInfo.stops.length} color stops`);
    }
    if (bg.gradientInfo.repeating) {
      gradientParts.push('repeating');
    }

    if (gradientParts.length > 0) {
      parts.push(`Gradient: ${gradientParts.join(', ')}`);
    }
  }

  // 視覚プロパティ
  if (bg.visualProperties) {
    const vizParts: string[] = [];

    // blurRadius > 0 の場合のみ表示
    if (bg.visualProperties.blurRadius && bg.visualProperties.blurRadius > 0) {
      vizParts.push(`Blur: ${bg.visualProperties.blurRadius}px`);
    }

    // blendMode が 'normal' でない場合のみ表示
    if (bg.visualProperties.blendMode && bg.visualProperties.blendMode !== 'normal') {
      vizParts.push(`Blend mode: ${bg.visualProperties.blendMode}`);
    }

    // layers > 1 の場合のみ表示
    if (bg.visualProperties.layers && bg.visualProperties.layers > 1) {
      vizParts.push(`Layers: ${bg.visualProperties.layers}`);
    }

    if (vizParts.length > 0) {
      parts.push(vizParts.join('. '));
    }
  }

  // アニメーション情報
  if (bg.animationInfo?.isAnimated) {
    const animParts: string[] = [];

    if (bg.animationInfo.animationName) {
      animParts.push(`Animated: ${bg.animationInfo.animationName}`);
    }
    if (bg.animationInfo.duration) {
      animParts.push(`Duration: ${bg.animationInfo.duration}`);
    }
    if (bg.animationInfo.easing) {
      animParts.push(`Easing: ${bg.animationInfo.easing}`);
    }

    if (animParts.length > 0) {
      parts.push(animParts.join('. '));
    }
  }

  return `passage: ${parts.join('. ')}.`;
}

// =====================================================
// Embedding 生成 + DB 保存
// =====================================================

/**
 * BackgroundDesign 配列から Embedding を生成し DB に保存
 *
 * 処理フロー:
 * 1. テキスト表現を生成（passage: プレフィックス付き）
 * 2. EmbeddingService で 768D ベクトルを生成
 * 3. BackgroundDesignEmbedding レコードを Prisma で create
 * 4. pgvector 形式で embedding カラムを raw SQL で更新
 *
 * Graceful Degradation: 個別の失敗は全体を止めない
 *
 * @param backgrounds - 背景デザインデータ配列
 * @param idMapping - name -> BackgroundDesign DB ID のマッピング
 * @param backgroundDesignIds - DB保存済みのBackgroundDesign ID配列（backgrounds配列と1:1対応）。
 *   指定された場合はidMappingよりも優先使用し、name重複によるマッピング欠落を回避する。
 * @returns 生成結果
 */
export async function generateBackgroundDesignEmbeddings(
  backgrounds: BackgroundDesignForText[],
  idMapping: Map<string, string>,
  backgroundDesignIds?: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<BackgroundDesignEmbeddingResult> {
  const result: BackgroundDesignEmbeddingResult = {
    success: true,
    generatedCount: 0,
    failedCount: 0,
    errors: [],
  };

  // 空配列の場合は即座に返却
  if (backgrounds.length === 0) {
    return result;
  }

  // backgroundDesignIds が指定されている場合、配列長の一致を検証
  if (backgroundDesignIds && backgroundDesignIds.length !== backgrounds.length) {
    if (isDevelopment()) {
      logger.warn('[BackgroundDesignEmbedding] backgroundDesignIds length mismatch, falling back to idMapping', {
        backgroundsLength: backgrounds.length,
        idsLength: backgroundDesignIds.length,
      });
    }
    // 長さ不一致の場合は安全のためidMappingにフォールバック
    backgroundDesignIds = undefined;
  }

  if (isDevelopment()) {
    logger.info('[BackgroundDesignEmbedding] Starting embedding generation', {
      backgroundCount: backgrounds.length,
      idMappingSize: idMapping.size,
      usingDirectIds: backgroundDesignIds !== undefined,
    });
  }

  const embeddingService = getEmbeddingService();
  const prisma = getPrismaClient();

  for (let i = 0; i < backgrounds.length; i++) {
    // Periodic GC to prevent V8 heap pressure during batch processing
    // (matches MotionEmbedding's 10-item GC interval in embedding-handler.ts)
    if (i > 0 && i % 10 === 0 && typeof global.gc === 'function') {
      global.gc();
    }

    const bg = backgrounds[i]!;

    // ID の取得: backgroundDesignIds優先、なければidMappingフォールバック
    const backgroundDesignId = backgroundDesignIds
      ? backgroundDesignIds[i]
      : idMapping.get(bg.name);

    if (!backgroundDesignId) {
      result.failedCount++;
      result.errors.push({
        name: bg.name,
        error: `Background design ID not found for "${bg.name}" (index: ${i})`,
      });

      if (isDevelopment()) {
        logger.warn('[BackgroundDesignEmbedding] ID not found, skipping', {
          name: bg.name,
          index: i,
          lookupMethod: backgroundDesignIds ? 'directIds' : 'idMapping',
        });
      }
      continue;
    }

    try {
      // 1. テキスト表現を生成
      const textRepresentation = generateBackgroundDesignTextRepresentation(bg);

      // 2. Embedding を生成
      const embeddingResult = await embeddingService.generateFromText(textRepresentation);

      // 3. BackgroundDesignEmbedding レコードを作成
      const createdRecord = await prisma.backgroundDesignEmbedding.create({
        data: {
          backgroundDesignId,
          textRepresentation,
          modelVersion: embeddingResult.modelName,
        },
      });

      // 4. pgvector 形式で embedding を更新
      const vectorString = `[${embeddingResult.embedding.join(',')}]`;
      await prisma.$executeRawUnsafe(
        `UPDATE background_design_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
        vectorString,
        createdRecord.id
      );

      result.generatedCount++;

      if (isDevelopment()) {
        logger.info('[BackgroundDesignEmbedding] Embedding saved', {
          name: bg.name,
          backgroundDesignId,
          embeddingId: createdRecord.id,
          dimensions: embeddingResult.embedding.length,
          processingTimeMs: embeddingResult.processingTimeMs,
        });
      }
    } catch (error) {
      result.failedCount++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push({
        name: bg.name,
        error: errorMessage,
      });

      if (isDevelopment()) {
        logger.warn('[BackgroundDesignEmbedding] Embedding generation failed', {
          name: bg.name,
          backgroundDesignId,
          error: errorMessage,
        });
      }
    }

    // Granular progress: report after each background design (fire-and-forget)
    try { onProgress?.(result.generatedCount + result.failedCount, backgrounds.length); } catch { /* fire-and-forget */ }
  }

  if (isDevelopment()) {
    logger.info('[BackgroundDesignEmbedding] Generation completed', {
      generatedCount: result.generatedCount,
      failedCount: result.failedCount,
      errorCount: result.errors.length,
    });
  }

  return result;
}

// =====================================================
// セマンティック検索
// =====================================================

/**
 * 類似の背景デザインをセマンティック検索
 *
 * 処理フロー:
 * 1. クエリテキストから query: プレフィックス付き Embedding を生成
 * 2. pgvector cosine similarity (<=> 演算子) で近傍探索
 * 3. オプションで designType フィルタを適用
 *
 * HNSW Index: idx_background_design_embeddings_hnsw
 * Distance: cosine (1 - cosine_similarity)
 *
 * @param query - 検索クエリ（例: "dark gradient background"）
 * @param options - 検索オプション
 * @returns 類似度順の検索結果配列
 */
export async function searchSimilarBackgroundDesigns(
  query: string,
  options: BackgroundDesignSearchOptions = {}
): Promise<BackgroundDesignSearchResult[]> {
  const limit = options.limit ?? 10;

  if (isDevelopment()) {
    logger.info('[BackgroundDesignEmbedding] Starting semantic search', {
      query,
      designType: options.designType,
      limit,
    });
  }

  // 1. クエリ Embedding を生成（query: プレフィックス）
  const embeddingService = getEmbeddingService();
  const queryText = `query: ${query}`;
  const embeddingResult = await embeddingService.generateFromText(queryText);

  // 2. pgvector cosine similarity 検索
  const prisma = getPrismaClient();
  const vectorString = `[${embeddingResult.embedding.join(',')}]`;

  let sql: string;
  let params: unknown[];

  if (options.designType) {
    sql = `
      SELECT
        bd.id,
        bd.name,
        bd.design_type,
        bde.text_representation,
        1 - (bde.embedding <=> $1::vector) AS similarity,
        bd.css_value,
        bd.selector,
        bd.color_info,
        bd.web_page_id
      FROM background_designs bd
      INNER JOIN background_design_embeddings bde
        ON bd.id = bde.background_design_id
      WHERE bde.embedding IS NOT NULL
        AND bd.design_type = $2
      ORDER BY bde.embedding <=> $1::vector ASC
      LIMIT $3
    `;
    params = [vectorString, options.designType, limit];
  } else {
    sql = `
      SELECT
        bd.id,
        bd.name,
        bd.design_type,
        bde.text_representation,
        1 - (bde.embedding <=> $1::vector) AS similarity,
        bd.css_value,
        bd.selector,
        bd.color_info,
        bd.web_page_id
      FROM background_designs bd
      INNER JOIN background_design_embeddings bde
        ON bd.id = bde.background_design_id
      WHERE bde.embedding IS NOT NULL
      ORDER BY bde.embedding <=> $1::vector ASC
      LIMIT $2
    `;
    params = [vectorString, limit];
  }

  const rows = await prisma.$queryRawUnsafe<BackgroundDesignSearchResult[]>(sql, ...params);

  if (isDevelopment()) {
    logger.info('[BackgroundDesignEmbedding] Search completed', {
      query,
      resultCount: rows.length,
      topSimilarity: rows.length > 0 ? rows[0]?.similarity : null,
    });
  }

  return rows;
}
