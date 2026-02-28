// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionEmbeddingSearchService
 *
 * visionEmbedding列を活用したセマンティック検索サービス
 *
 * Phase 4-2: visionEmbeddingベースのセマンティック検索
 *
 * 機能:
 * - vision_embedding列でのコサイン類似度検索
 * - 既存セクションからの類似検索
 * - RRFハイブリッド検索（text_embedding + vision_embedding）
 *
 * @module services/vision-embedding-search.service
 */

import { isDevelopment, logger } from '../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * Vision検索クエリ
 */
export interface VisionSearchQuery {
  /** テキストクエリ（日本語/英語） */
  textQuery?: string;
  /** VisualFeatures条件 */
  visualFeatures?: {
    theme?: string;
    colors?: string[];
    density?: string;
    gradient?: string;
    mood?: string;
    brandTone?: string;
  };
  /** 既存セクションのIDで類似検索 */
  sectionPatternId?: string;
}

/**
 * Vision検索結果
 */
export interface VisionSearchResult {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName?: string;
  layoutInfo?: Record<string, unknown>;
  visualFeatures?: Record<string, unknown>;
  htmlSnippet?: string;
  similarity: number;
  webPage: {
    id: string;
    url: string;
    title?: string;
    sourceType: string;
    usageScope: string;
    screenshotDesktopUrl: string | null;
  };
  // RRF統合検索時の情報（combined モード時のみ）
  textRank?: number; // テキスト検索でのランク（0=含まれない）
  visionRank?: number; // Vision検索でのランク（0=含まれない）
  rrfDetails?: {
    textScore?: number;
    visionScore?: number;
    combinedScore?: number;
  };
}

/**
 * Vision検索サービス結果
 */
export interface VisionSearchServiceResult {
  results: VisionSearchResult[];
  total: number;
  /**
   * Graceful Degradation
   * vision_embeddingがnullの場合、trueを返す
   */
  fallbackToTextOnly?: boolean;
  /**
   * フォールバック理由
   */
  fallbackReason?: string;
  /**
   * 警告メッセージ配列
   * フォールバック時や部分的なvision_embedding時の警告
   */
  warnings?: string[];
  /**
   * 実際に使用された検索モード
   * 'text_only' | 'vision_only' | 'combined'
   */
  actualSearchMode?: 'text_only' | 'vision_only' | 'combined';
  /**
   * vision_embeddingのカバレッジ率
   * vision_embeddingを持つ結果の割合（0-1）
   */
  visionCoverageRatio?: number;
  /**
   * 調整後の重み
   * カバレッジ率に基づいて調整された重み
   */
  adjustedWeights?: {
    textWeight: number;
    visionWeight: number;
  };
}

/**
 * Vision検索オプション
 */
export interface VisionSearchOptions {
  limit: number;
  offset: number;
  minSimilarity?: number;
  sectionType?: string;
  sourceType?: string;
  usageScope?: string;
}

/**
 * ハイブリッド検索オプション
 */
export interface HybridSearchOptions extends VisionSearchOptions {
  /** vision_embeddingの重み（デフォルト0.6） */
  visionWeight?: number;
  /** text_embeddingの重み（デフォルト0.4） */
  textWeight?: number;
  /** RRFのkパラメータ（デフォルト60） */
  rrfK?: number;
}

/**
 * EmbeddingServiceインターフェース
 */
export interface IVisionSearchEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[] | null>;
}

/**
 * PrismaClientインターフェース
 */
export interface IVisionSearchPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * IVisionEmbeddingSearchServiceインターフェース
 */
export interface IVisionEmbeddingSearchService {
  searchByVisionEmbedding(
    query: VisionSearchQuery,
    options: VisionSearchOptions
  ): Promise<VisionSearchServiceResult | null>;
  searchSimilarSections(
    sectionPatternId: string,
    options: VisionSearchOptions
  ): Promise<VisionSearchServiceResult | null>;
  hybridSearch(
    query: VisionSearchQuery,
    options: HybridSearchOptions
  ): Promise<VisionSearchServiceResult | null>;
}

// =====================================================
// ベクトル検索結果型
// =====================================================

interface VectorSearchRecord {
  id: string;
  web_page_id: string;
  section_type: string;
  section_name: string | null;
  layout_info: unknown;
  visual_features: unknown;
  html_snippet: string | null;
  similarity: number;
  wp_id: string;
  wp_url: string;
  wp_title: string | null;
  wp_source_type: string;
  wp_usage_scope: string;
  wp_screenshot_desktop_url: string | null;
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IVisionSearchEmbeddingService) | null = null;
let prismaClientFactory: (() => IVisionSearchPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setVisionSearchEmbeddingServiceFactory(
  factory: () => IVisionSearchEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetVisionSearchEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 */
export function setVisionSearchPrismaClientFactory(
  factory: () => IVisionSearchPrismaClient
): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetVisionSearchPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * RRF（Reciprocal Rank Fusion）定数
 * k=60が標準定数
 */
const RRF_K = 60;

/**
 * RRFスコアを計算
 * @param rank 1-indexed ランク
 */
function calculateRRFScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * UUID形式を検証
 */
function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * VisionSearchQueryからテキスト表現を生成
 */
function queryToText(query: VisionSearchQuery): string {
  const parts: string[] = [];

  if (query.textQuery) {
    parts.push(query.textQuery);
  }

  if (query.visualFeatures) {
    const vf = query.visualFeatures;
    if (vf.theme) {
      parts.push(`theme: ${vf.theme}`);
    }
    if (vf.colors && vf.colors.length > 0) {
      parts.push(`colors: ${vf.colors.join(', ')}`);
    }
    if (vf.density) {
      parts.push(`content density: ${vf.density}`);
    }
    if (vf.gradient) {
      parts.push(`gradient type: ${vf.gradient}`);
    }
    if (vf.mood) {
      parts.push(`mood: ${vf.mood}`);
    }
    if (vf.brandTone) {
      parts.push(`brand tone: ${vf.brandTone}`);
    }
  }

  return parts.join('. ');
}

/**
 * DBレコードをVisionSearchResultに変換
 */
function recordToResult(r: VectorSearchRecord): VisionSearchResult {
  const layoutInfo =
    typeof r.layout_info === 'object' && r.layout_info !== null
      ? (r.layout_info as Record<string, unknown>)
      : {};

  const visualFeatures =
    typeof r.visual_features === 'object' && r.visual_features !== null
      ? (r.visual_features as Record<string, unknown>)
      : {};

  const result: VisionSearchResult = {
    id: r.id,
    webPageId: r.web_page_id,
    sectionType: r.section_type,
    similarity: r.similarity,
    webPage: {
      id: r.wp_id,
      url: r.wp_url,
      sourceType: r.wp_source_type,
      usageScope: r.wp_usage_scope,
      screenshotDesktopUrl: r.wp_screenshot_desktop_url,
    },
  };

  if (r.section_name) {
    result.sectionName = r.section_name;
  }
  if (Object.keys(layoutInfo).length > 0) {
    result.layoutInfo = layoutInfo;
  }
  if (Object.keys(visualFeatures).length > 0) {
    result.visualFeatures = visualFeatures;
  }
  if (r.html_snippet) {
    result.htmlSnippet = r.html_snippet;
  }
  if (r.wp_title) {
    result.webPage.title = r.wp_title;
  }

  return result;
}

/**
 * フィルター条件をWHERE句に変換
 */
function buildFilterClause(
  options: VisionSearchOptions,
  excludeId?: string
): { clause: string; params: unknown[]; paramOffset: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(options.sectionType);
    paramIndex++;
  }

  if (options.sourceType) {
    conditions.push(`wp.source_type = $${paramIndex}`);
    params.push(options.sourceType);
    paramIndex++;
  }

  if (options.usageScope) {
    conditions.push(`wp.usage_scope = $${paramIndex}`);
    params.push(options.usageScope);
    paramIndex++;
  }

  if (excludeId) {
    conditions.push(`sp.id != $${paramIndex}`);
    params.push(excludeId);
    paramIndex++;
  }

  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : '',
    params,
    paramOffset: paramIndex - 1,
  };
}

// =====================================================
// VisionEmbeddingSearchService
// =====================================================

/**
 * VisionEmbeddingSearchServiceクラス
 */
export class VisionEmbeddingSearchService implements IVisionEmbeddingSearchService {
  private embeddingService: IVisionSearchEmbeddingService | null = null;
  private prismaClient: IVisionSearchPrismaClient | null = null;

  /**
   * EmbeddingServiceを取得
   */
  private getEmbeddingService(): IVisionSearchEmbeddingService | null {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    if (embeddingServiceFactory) {
      this.embeddingService = embeddingServiceFactory();
      return this.embeddingService;
    }

    if (isDevelopment()) {
      logger.warn('[VisionEmbeddingSearchService] EmbeddingService not available');
    }
    return null;
  }

  /**
   * PrismaClientを取得
   */
  private getPrismaClient(): IVisionSearchPrismaClient | null {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    if (isDevelopment()) {
      logger.warn('[VisionEmbeddingSearchService] PrismaClient not available');
    }
    return null;
  }

  /**
   * vision_embeddingでベクトル検索を実行
   */
  async searchByVisionEmbedding(
    query: VisionSearchQuery,
    options: VisionSearchOptions
  ): Promise<VisionSearchServiceResult | null> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[VisionEmbeddingSearchService] searchByVisionEmbedding', {
        hasTextQuery: !!query.textQuery,
        hasVisualFeatures: !!query.visualFeatures,
        limit: options.limit,
        offset: options.offset,
      });
    }

    // 空のクエリはnullを返す
    const queryText = queryToText(query);
    if (!queryText) {
      if (isDevelopment()) {
        logger.warn('[VisionEmbeddingSearchService] Empty query, returning null');
      }
      return null;
    }

    // EmbeddingService取得
    const embeddingService = this.getEmbeddingService();
    if (!embeddingService) {
      return null;
    }

    // PrismaClient取得
    const prisma = this.getPrismaClient();
    if (!prisma) {
      return null;
    }

    try {
      // クエリからEmbedding生成
      const embedding = await embeddingService.generateEmbedding(queryText, 'query');
      if (!embedding) {
        if (isDevelopment()) {
          logger.warn('[VisionEmbeddingSearchService] Embedding generation returned null');
        }
        return null;
      }

      // ベクトル検索実行
      return await this.executeVisionSearch(prisma, embedding, options);
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] searchByVisionEmbedding error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return null;
    } finally {
      if (isDevelopment()) {
        logger.info('[VisionEmbeddingSearchService] searchByVisionEmbedding completed', {
          processingTimeMs: Date.now() - startTime,
        });
      }
    }
  }

  /**
   * 既存セクションから類似セクションを検索
   */
  async searchSimilarSections(
    sectionPatternId: string,
    options: VisionSearchOptions
  ): Promise<VisionSearchServiceResult | null> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[VisionEmbeddingSearchService] searchSimilarSections', {
        sectionPatternId,
        limit: options.limit,
      });
    }

    // UUID検証
    if (!isValidUUID(sectionPatternId)) {
      if (isDevelopment()) {
        logger.warn('[VisionEmbeddingSearchService] Invalid UUID format', { sectionPatternId });
      }
      return null;
    }

    const prisma = this.getPrismaClient();
    if (!prisma) {
      return null;
    }

    try {
      // 既存セクションのvision_embeddingを取得
      const existingEmbedding = await this.getExistingVisionEmbedding(prisma, sectionPatternId);
      if (!existingEmbedding) {
        if (isDevelopment()) {
          logger.warn('[VisionEmbeddingSearchService] No vision_embedding found for section', {
            sectionPatternId,
          });
        }
        return null;
      }

      // 自分自身を除外して検索
      return await this.executeVisionSearch(prisma, existingEmbedding, options, sectionPatternId);
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] searchSimilarSections error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return null;
    } finally {
      if (isDevelopment()) {
        logger.info('[VisionEmbeddingSearchService] searchSimilarSections completed', {
          processingTimeMs: Date.now() - startTime,
        });
      }
    }
  }

  /**
   * RRFハイブリッド検索（text_embedding + vision_embedding）
   * RRFハイブリッド検索 - Graceful Degradation強化版
   */
  async hybridSearch(
    query: VisionSearchQuery,
    options: HybridSearchOptions
  ): Promise<VisionSearchServiceResult | null> {
    const startTime = Date.now();
    const originalVisionWeight = options.visionWeight ?? 0.6;
    const originalTextWeight = options.textWeight ?? 0.4;
    const warnings: string[] = [];

    if (isDevelopment()) {
      logger.info('[VisionEmbeddingSearchService] hybridSearch', {
        visionWeight: originalVisionWeight,
        textWeight: originalTextWeight,
        limit: options.limit,
      });
    }

    const queryText = queryToText(query);
    if (!queryText) {
      if (isDevelopment()) {
        logger.warn('[VisionEmbeddingSearchService] Empty query for hybrid search');
      }
      return null;
    }

    const embeddingService = this.getEmbeddingService();
    if (!embeddingService) {
      return null;
    }

    const prisma = this.getPrismaClient();
    if (!prisma) {
      return null;
    }

    try {
      // クエリからEmbedding生成
      const embedding = await embeddingService.generateEmbedding(queryText, 'query');
      if (!embedding) {
        return null;
      }

      // text_embeddingとvision_embedding両方で検索（並列実行）
      const [textResults, visionResults] = await Promise.all([
        this.executeTextSearch(prisma, embedding, options),
        this.executeVisionSearch(prisma, embedding, options),
      ]);

      const textResultCount = textResults?.results?.length ?? 0;
      const visionResultCount = visionResults?.results?.length ?? 0;

      // Graceful Degradation - 両方とも結果がない場合
      if (textResultCount === 0 && visionResultCount === 0) {
        const fallbackReason = 'No results from both text and vision search';
        warnings.push('No results found: returning empty result set');

        if (isDevelopment()) {
          logger.warn('[VisionEmbeddingSearchService] No results from hybrid search', {
            reason: fallbackReason,
          });
        }

        return {
          results: [],
          total: 0,
          fallbackToTextOnly: true,
          fallbackReason,
          warnings,
          actualSearchMode: 'text_only',
          visionCoverageRatio: 0,
          adjustedWeights: {
            textWeight: 1.0,
            visionWeight: 0,
          },
        };
      }

      // Graceful Degradation - vision_embeddingが空の場合
      if (visionResultCount === 0 && textResultCount > 0) {
        const fallbackReason = 'vision_embedding not available for any results';
        warnings.push('Fallback to text_only search: no vision_embedding found');

        if (isDevelopment()) {
          logger.warn('[VisionEmbeddingSearchService] Graceful Degradation to text_only', {
            reason: fallbackReason,
          });
        }

        // ページネーション適用
        const paginatedResults = textResults.results.slice(
          options.offset,
          options.offset + options.limit
        );

        return {
          results: paginatedResults,
          total: textResults.total,
          fallbackToTextOnly: true,
          fallbackReason,
          warnings,
          actualSearchMode: 'text_only',
          visionCoverageRatio: 0,
          adjustedWeights: {
            textWeight: 1.0,
            visionWeight: 0,
          },
        };
      }

      // カバレッジ率計算と重み調整
      const totalResults = textResultCount + visionResultCount;
      const visionCoverageRatio =
        totalResults > 0 ? visionResultCount / Math.max(textResultCount, visionResultCount) : 0;

      // カバレッジが50%未満の場合、重みを調整
      let adjustedTextWeight = originalTextWeight;
      let adjustedVisionWeight = originalVisionWeight;

      if (visionCoverageRatio < 0.5 && visionResultCount > 0) {
        // カバレッジ率に基づいて重みを調整
        // 例: カバレッジ30% → visionWeight * 0.3 / 0.5 = visionWeight * 0.6
        const adjustmentFactor = visionCoverageRatio / 0.5;
        adjustedVisionWeight = originalVisionWeight * adjustmentFactor;
        adjustedTextWeight = 1 - adjustedVisionWeight;

        warnings.push(
          `Vision coverage is low (${(visionCoverageRatio * 100).toFixed(1)}%), adjusted weights: text=${adjustedTextWeight.toFixed(2)}, vision=${adjustedVisionWeight.toFixed(2)}`
        );

        if (isDevelopment()) {
          logger.info('[VisionEmbeddingSearchService] RRF weight adjustment', {
            visionCoverageRatio,
            originalWeights: { text: originalTextWeight, vision: originalVisionWeight },
            adjustedWeights: { text: adjustedTextWeight, vision: adjustedVisionWeight },
          });
        }
      }

      // RRFでマージ（調整済み重みを使用）
      const mergedResults = this.mergeWithRRF(
        textResults?.results || [],
        visionResults?.results || [],
        adjustedTextWeight,
        adjustedVisionWeight
      );

      // ページネーション適用
      const paginatedResults = mergedResults.slice(options.offset, options.offset + options.limit);

      // totalカウント取得
      const total = await this.getHybridTotalCount(prisma, embedding, options);

      return {
        results: paginatedResults,
        total,
        fallbackToTextOnly: false,
        actualSearchMode: 'combined',
        visionCoverageRatio,
        adjustedWeights: {
          textWeight: adjustedTextWeight,
          visionWeight: adjustedVisionWeight,
        },
        warnings,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] hybridSearch error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // エラー時は空の結果を返す（Graceful Degradation）
      return {
        results: [],
        total: 0,
        fallbackToTextOnly: true,
        fallbackReason: `Search error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        warnings: ['Search failed, returning empty results'],
        actualSearchMode: 'text_only',
        visionCoverageRatio: 0,
        adjustedWeights: {
          textWeight: 1.0,
          visionWeight: 0,
        },
      };
    } finally {
      if (isDevelopment()) {
        logger.info('[VisionEmbeddingSearchService] hybridSearch completed', {
          processingTimeMs: Date.now() - startTime,
        });
      }
    }
  }

  // =====================================================
  // プライベートメソッド
  // =====================================================

  /**
   * vision_embeddingでベクトル検索を実行
   */
  private async executeVisionSearch(
    prisma: IVisionSearchPrismaClient,
    embedding: number[],
    options: VisionSearchOptions,
    excludeId?: string
  ): Promise<VisionSearchServiceResult> {
    const vectorString = `[${embedding.join(',')}]`;
    const { clause: filterClause, params: filterParams, paramOffset } = buildFilterClause(
      options,
      excludeId
    );

    // パラメータインデックス計算
    const vectorParamIndex = paramOffset + 1;
    const limitParamIndex = paramOffset + 2;
    const offsetParamIndex = paramOffset + 3;

    // WHERE句構築
    let whereClause = 'WHERE se.vision_embedding IS NOT NULL';
    if (filterClause) {
      whereClause += ` AND ${filterClause}`;
    }

    // minSimilarityのHAVING句（後でフィルタリング）
    const minSimilarity = options.minSimilarity ?? 0;

    const searchQuery = `
      SELECT
        sp.id,
        sp.web_page_id,
        sp.section_type,
        sp.section_name,
        sp.layout_info,
        sp.visual_features,
        sp.html_snippet,
        1 - (se.vision_embedding <=> $${vectorParamIndex}::vector) as similarity,
        wp.id as wp_id,
        wp.url as wp_url,
        wp.title as wp_title,
        wp.source_type as wp_source_type,
        wp.usage_scope as wp_usage_scope,
        wp.screenshot_desktop_url as wp_screenshot_desktop_url
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
      INNER JOIN web_pages wp ON wp.id = sp.web_page_id
      ${whereClause}
      ORDER BY similarity DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
      INNER JOIN web_pages wp ON wp.id = sp.web_page_id
      ${whereClause}
    `;

    try {
      const [searchResults, countResult] = await Promise.all([
        prisma.$queryRawUnsafe<VectorSearchRecord[]>(
          searchQuery,
          ...filterParams,
          vectorString,
          options.limit,
          options.offset
        ),
        prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
          countQuery,
          ...filterParams,
          vectorString
        ),
      ]);

      // minSimilarityでフィルタリング
      const filteredResults = searchResults.filter((r) => r.similarity >= minSimilarity);

      return {
        results: filteredResults.map(recordToResult),
        total: Number(countResult[0]?.total || 0),
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] executeVisionSearch error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return { results: [], total: 0 };
    }
  }

  /**
   * text_embeddingでベクトル検索を実行
   */
  private async executeTextSearch(
    prisma: IVisionSearchPrismaClient,
    embedding: number[],
    options: VisionSearchOptions
  ): Promise<VisionSearchServiceResult> {
    const vectorString = `[${embedding.join(',')}]`;
    const { clause: filterClause, params: filterParams, paramOffset } = buildFilterClause(options);

    const vectorParamIndex = paramOffset + 1;
    const limitParamIndex = paramOffset + 2;
    const offsetParamIndex = paramOffset + 3;

    let whereClause = 'WHERE se.text_embedding IS NOT NULL';
    if (filterClause) {
      whereClause += ` AND ${filterClause}`;
    }

    const searchQuery = `
      SELECT
        sp.id,
        sp.web_page_id,
        sp.section_type,
        sp.section_name,
        sp.layout_info,
        sp.visual_features,
        sp.html_snippet,
        1 - (se.text_embedding <=> $${vectorParamIndex}::vector) as similarity,
        wp.id as wp_id,
        wp.url as wp_url,
        wp.title as wp_title,
        wp.source_type as wp_source_type,
        wp.usage_scope as wp_usage_scope,
        wp.screenshot_desktop_url as wp_screenshot_desktop_url
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
      INNER JOIN web_pages wp ON wp.id = sp.web_page_id
      ${whereClause}
      ORDER BY similarity DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `;

    try {
      const searchResults = await prisma.$queryRawUnsafe<VectorSearchRecord[]>(
        searchQuery,
        ...filterParams,
        vectorString,
        options.limit,
        options.offset
      );

      return {
        results: searchResults.map(recordToResult),
        total: searchResults.length,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] executeTextSearch error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return { results: [], total: 0 };
    }
  }

  /**
   * 既存セクションのvision_embeddingを取得
   */
  private async getExistingVisionEmbedding(
    prisma: IVisionSearchPrismaClient,
    sectionPatternId: string
  ): Promise<number[] | null> {
    const query = `
      SELECT vision_embedding::text as vision_embedding
      FROM section_embeddings
      WHERE section_pattern_id = $1
      AND vision_embedding IS NOT NULL
    `;

    try {
      const result = await prisma.$queryRawUnsafe<Array<{ vision_embedding: string }>>(
        query,
        sectionPatternId
      );

      if (result.length === 0 || !result[0]?.vision_embedding) {
        return null;
      }

      // pgvector文字列をパース "[0.1,0.2,...]"
      const vectorStr = result[0].vision_embedding;
      const numbers = vectorStr
        .slice(1, -1) // "[" と "]" を除去
        .split(',')
        .map(Number);

      return numbers;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[VisionEmbeddingSearchService] getExistingVisionEmbedding error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return null;
    }
  }

  /**
   * RRFで結果をマージ
   */
  private mergeWithRRF(
    textResults: VisionSearchResult[],
    visionResults: VisionSearchResult[],
    textWeight: number,
    visionWeight: number
  ): VisionSearchResult[] {
    const scoreMap = new Map<string, { result: VisionSearchResult; score: number }>();

    // text結果のRRFスコアを計算
    textResults.forEach((result, index) => {
      const rrfScore = calculateRRFScore(index + 1) * textWeight;
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(result.id, { result, score: rrfScore });
      }
    });

    // vision結果のRRFスコアを計算
    visionResults.forEach((result, index) => {
      const rrfScore = calculateRRFScore(index + 1) * visionWeight;
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(result.id, { result, score: rrfScore });
      }
    });

    // スコア順にソート
    const sorted = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ result, score }) => ({
        ...result,
        similarity: score, // RRFスコアをsimilarityとして返す
      }));

    return sorted;
  }

  /**
   * ハイブリッド検索の総件数を取得
   */
  private async getHybridTotalCount(
    prisma: IVisionSearchPrismaClient,
    embedding: number[],
    options: VisionSearchOptions
  ): Promise<number> {
    const vectorString = `[${embedding.join(',')}]`;
    const { clause: filterClause, params: filterParams } = buildFilterClause(options);

    let whereClause = 'WHERE (se.text_embedding IS NOT NULL OR se.vision_embedding IS NOT NULL)';
    if (filterClause) {
      whereClause += ` AND ${filterClause}`;
    }

    const countQuery = `
      SELECT COUNT(DISTINCT sp.id) as total
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
      INNER JOIN web_pages wp ON wp.id = sp.web_page_id
      ${whereClause}
    `;

    try {
      const result = await prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
        countQuery,
        ...filterParams,
        vectorString
      );
      return Number(result[0]?.total || 0);
    } catch {
      return 0;
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let visionSearchServiceInstance: VisionEmbeddingSearchService | null = null;

/**
 * VisionEmbeddingSearchServiceインスタンスを取得
 */
export function getVisionEmbeddingSearchService(): VisionEmbeddingSearchService {
  if (!visionSearchServiceInstance) {
    visionSearchServiceInstance = new VisionEmbeddingSearchService();
  }
  return visionSearchServiceInstance;
}

/**
 * VisionEmbeddingSearchServiceインスタンスをリセット
 */
export function resetVisionEmbeddingSearchService(): void {
  visionSearchServiceInstance = null;
}

/**
 * VisionEmbeddingSearchServiceファクトリを作成
 */
export function createVisionEmbeddingSearchServiceFactory(): () => IVisionEmbeddingSearchService {
  return () => getVisionEmbeddingSearchService();
}

export default VisionEmbeddingSearchService;
