// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Narrative Search Service
 *
 * DesignNarrativeのセマンティック検索（HNSW）と
 * Hybrid Search（RRF: 60% vector + 40% full-text）を提供するサービス。
 *
 * 検索モード:
 * - vector: pgvector cosine similarity検索
 * - hybrid: RRF（Reciprocal Rank Fusion）による結合
 *
 * DB Tables:
 * - design_narratives (dn): mood_category, mood_description, confidence, etc.
 * - design_narrative_embeddings (dne): embedding (768D vector), search_vector (tsvector)
 * - web_pages (wp): url, title
 *
 * @module services/narrative/narrative-search.service
 */

import type {
  NarrativeSearchOptions,
  NarrativeSearchResult,
  MoodCategory,
} from './types/narrative.types';
import {
  executeHybridSearch,
  buildFulltextConditions,
  buildFulltextRankExpression,
  toRankedItems,
} from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import { isDevelopment, logger } from '../../utils/logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * デフォルト検索設定
 */
const DEFAULT_SEARCH_CONFIG = {
  limit: 10,
  vectorWeight: 0.6,
  fulltextWeight: 0.4,
  minSimilarity: 0.5,
} as const;

// =============================================================================
// Interfaces
// =============================================================================

/**
 * EmbeddingServiceインターフェース（DI用）
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
}

/**
 * PrismaClientインターフェース（DI用、部分的）
 */
export interface IPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * NarrativeSearchService設定
 */
export interface NarrativeSearchServiceConfig {
  /** デフォルトの取得件数 */
  defaultLimit?: number;
  /** Vector検索の重み（0-1） */
  vectorWeight?: number;
  /** Full-text検索の重み（0-1） */
  fulltextWeight?: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * ベクトル検索の生SQL結果
 */
interface VectorSearchRow {
  id: string;
  web_page_id: string;
  mood_category: string;
  mood_description: string;
  confidence: number;
  similarity: number;
  wp_url: string;
  wp_title: string | null;
}

// =============================================================================
// DI Factories
// =============================================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setNarrativeEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット（テスト用）
 */
export function resetNarrativeEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 */
export function setNarrativePrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット（テスト用）
 */
export function resetNarrativePrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * フィルター条件をWHERE句に変換（動的パラメータインデックス）
 *
 * @param filters - 検索フィルター
 * @param startParamIndex - パラメータインデックスの開始値
 * @returns WHERE句構成要素
 */
function buildWhereClause(
  filters: NarrativeSearchOptions['filters'],
  startParamIndex: number
): { conditions: string[]; params: unknown[]; nextParamIndex: number } {
  const conditions: string[] = ['dne.embedding IS NOT NULL'];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

  if (filters?.moodCategory && filters.moodCategory.length > 0) {
    conditions.push(`dn.mood_category::text = ANY($${paramIndex}::text[])`);
    params.push(filters.moodCategory);
    paramIndex++;
  }

  if (filters?.minConfidence !== undefined) {
    conditions.push(`dn.confidence >= $${paramIndex}`);
    params.push(filters.minConfidence);
    paramIndex++;
  }

  return {
    conditions,
    params,
    nextParamIndex: paramIndex,
  };
}

/**
 * VectorSearchRowをNarrativeSearchResultに変換
 */
function mapRowToResult(row: VectorSearchRow): NarrativeSearchResult {
  return {
    id: row.id,
    webPageId: row.web_page_id,
    score: row.similarity,
    vectorScore: row.similarity,
    fulltextScore: 0,
    moodCategory: row.mood_category as MoodCategory,
    moodDescription: row.mood_description ?? '',
    confidence: row.confidence ?? 0,
  };
}

// =============================================================================
// NarrativeSearchService Class
// =============================================================================

/**
 * Narrative Search Service
 *
 * pgvectorによるセマンティック検索とHybrid Searchを提供。
 * DI経由でEmbeddingServiceとPrismaClientを取得。
 */
export class NarrativeSearchService {
  private readonly config: Required<NarrativeSearchServiceConfig>;
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;

  constructor(config?: NarrativeSearchServiceConfig) {
    this.config = {
      defaultLimit: config?.defaultLimit ?? DEFAULT_SEARCH_CONFIG.limit,
      vectorWeight: config?.vectorWeight ?? DEFAULT_SEARCH_CONFIG.vectorWeight,
      fulltextWeight: config?.fulltextWeight ?? DEFAULT_SEARCH_CONFIG.fulltextWeight,
    };

    if (isDevelopment()) {
      logger.info('[NarrativeSearchService] Initialized', {
        defaultLimit: this.config.defaultLimit,
        vectorWeight: this.config.vectorWeight,
        fulltextWeight: this.config.fulltextWeight,
      });
    }
  }

  // ===========================================================================
  // DI Getters
  // ===========================================================================

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

    throw new Error('EmbeddingService not initialized. Call setNarrativeEmbeddingServiceFactory() first.');
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

    throw new Error('PrismaClient not initialized. Call setNarrativePrismaClientFactory() first.');
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Narrative検索（ベクトル検索）
   *
   * クエリテキストからEmbeddingを生成し、pgvector HNSW近傍探索を実行。
   *
   * @param options - 検索オプション
   * @returns 検索結果
   */
  async search(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> {
    const startTime = Date.now();
    const limit = options.limit ?? this.config.defaultLimit;

    if (isDevelopment()) {
      logger.info('[NarrativeSearchService] Starting search', {
        query: options.query,
        limit,
        filters: options.filters,
      });
    }

    try {
      // 1. クエリからEmbeddingを生成
      const queryEmbedding = await this.generateQueryEmbedding(options.query);
      const vectorString = `[${queryEmbedding.join(',')}]`;

      // 2. フィルター条件を構築（$1 = vectorString）
      const { conditions, params: filterParams, nextParamIndex } = buildWhereClause(
        options.filters,
        2 // $1 is reserved for vectorString
      );

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // 3. pgvector HNSW cosine similarity検索
      const sql = `
        SELECT
          dn.id, dn.web_page_id, dn.mood_category,
          dn.mood_description, dn.confidence,
          1 - (dne.embedding <=> $1::vector) AS similarity,
          wp.url AS wp_url, wp.title AS wp_title
        FROM design_narratives dn
        INNER JOIN design_narrative_embeddings dne
          ON dn.id = dne.design_narrative_id
        INNER JOIN web_pages wp ON wp.id = dn.web_page_id
        ${whereClause}
        ORDER BY dne.embedding <=> $1::vector ASC
        LIMIT $${nextParamIndex}
      `;

      const prisma = this.getPrismaClient();
      const allParams = [vectorString, ...filterParams, limit];
      const rows = await prisma.$queryRawUnsafe<VectorSearchRow[]>(sql, ...allParams);

      const results = rows.map(mapRowToResult);

      const processingTimeMs = Date.now() - startTime;
      if (isDevelopment()) {
        logger.info('[NarrativeSearchService] Search complete', {
          processingTimeMs,
          resultCount: results.length,
        });
      }

      return results;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[NarrativeSearchService] Search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          query: options.query,
        });
      }
      throw error;
    }
  }

  /**
   * Hybrid検索（ベクトル + 全文検索 → RRF マージ）
   *
   * 両検索を並列実行し、Reciprocal Rank Fusion (60% vector + 40% fulltext) で
   * 結果をマージ。全文検索が失敗した場合はベクトル検索のみで結果を返す。
   *
   * @param options - 検索オプション
   * @returns 検索結果
   */
  async searchHybrid(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> {
    const startTime = Date.now();
    const limit = options.limit ?? this.config.defaultLimit;
    const queryText = options.query;

    if (isDevelopment()) {
      logger.info('[NarrativeSearchService] Starting hybrid search (vector + fulltext)', {
        query: queryText,
        limit,
        vectorWeight: options.vectorWeight ?? this.config.vectorWeight,
        fulltextWeight: options.fulltextWeight ?? this.config.fulltextWeight,
        filters: options.filters,
      });
    }

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[NarrativeSearchService] PrismaClient not available, returning empty');
      }
      return [];
    }

    try {
      // 1. クエリEmbedding生成
      const queryEmbedding = await this.generateQueryEmbedding(queryText);
      const vectorString = `[${queryEmbedding.join(',')}]`;
      const fetchLimit = Math.min(limit * 3, 150);

      // フィルター条件を構築（パラメータインデックスは1から開始）
      const { conditions: baseConditions, params: baseParams, nextParamIndex: paramIndex } =
        buildWhereClause(options.filters, 1);
      const baseWhereClause = `WHERE ${baseConditions.join(' AND ')}`;

      // 2. ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vecParamIdx = paramIndex;
        const vecLimitIdx = paramIndex + 1;

        const vecSql = `
          SELECT
            dn.id, dn.web_page_id, dn.mood_category,
            dn.mood_description, dn.confidence,
            1 - (dne.embedding <=> $${vecParamIdx}::vector) AS similarity,
            wp.url AS wp_url, wp.title AS wp_title
          FROM design_narratives dn
          INNER JOIN design_narrative_embeddings dne
            ON dn.id = dne.design_narrative_id
          INNER JOIN web_pages wp ON wp.id = dn.web_page_id
          ${baseWhereClause}
          ORDER BY dne.embedding <=> $${vecParamIdx}::vector ASC
          LIMIT $${vecLimitIdx}
        `;

        const rows = await prisma.$queryRawUnsafe<VectorSearchRow[]>(
          vecSql,
          ...baseParams,
          vectorString,
          fetchLimit
        );

        return toRankedItems(rows.map((r) => ({
          id: r.id,
          web_page_id: r.web_page_id,
          mood_category: r.mood_category,
          mood_description: r.mood_description,
          confidence: r.confidence,
          similarity: r.similarity,
          wp_url: r.wp_url,
          wp_title: r.wp_title,
        })));
      };

      // 3. 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        try {
          const ftQueryIdx = paramIndex;
          const ftLimitIdx = paramIndex + 1;

          const ftCond = buildFulltextConditions('dne.search_vector', ftQueryIdx);
          const ftRank = buildFulltextRankExpression('dne.search_vector', ftQueryIdx);

          // ベースフィルター条件を取得（WHERE を除去してANDで連結）
          const baseConditionsPart = baseWhereClause.replace(/^WHERE\s+/i, '');
          const ftWhereClause = `WHERE ${baseConditionsPart} AND ${ftCond}`;

          const ftSql = `
            SELECT
              dn.id, dn.web_page_id, dn.mood_category,
              dn.mood_description, dn.confidence,
              ${ftRank} AS similarity,
              wp.url AS wp_url, wp.title AS wp_title
            FROM design_narratives dn
            INNER JOIN design_narrative_embeddings dne
              ON dn.id = dne.design_narrative_id
            INNER JOIN web_pages wp ON wp.id = dn.web_page_id
            ${ftWhereClause}
            ORDER BY similarity DESC
            LIMIT $${ftLimitIdx}
          `;

          const rows = await prisma.$queryRawUnsafe<VectorSearchRow[]>(
            ftSql,
            ...baseParams,
            queryText,
            fetchLimit
          );

          return toRankedItems(rows.map((r) => ({
            id: r.id,
            web_page_id: r.web_page_id,
            mood_category: r.mood_category,
            mood_description: r.mood_description,
            confidence: r.confidence,
            similarity: r.similarity,
            wp_url: r.wp_url,
            wp_title: r.wp_title,
          })));
        } catch (ftError) {
          // 全文検索の失敗はハイブリッド検索全体をブロックしない
          if (isDevelopment()) {
            logger.warn('[NarrativeSearchService] Full-text search failed, using vector only', {
              error: ftError instanceof Error ? ftError.message : 'Unknown error',
            });
          }
          return [];
        }
      };

      // 4. executeHybridSearch で RRF マージ（両検索を並列実行）
      const hybridResults = await executeHybridSearch(vectorSearchFn, fulltextSearchFn);

      // 5. 結果をスライスして NarrativeSearchResult 形式に変換
      const results: NarrativeSearchResult[] = hybridResults.slice(0, limit).map((hr) => {
        const data = hr.data as Record<string, unknown>;
        return {
          id: String(data.id ?? hr.id),
          webPageId: String(data.web_page_id ?? ''),
          score: hr.similarity,
          vectorScore: hr.similarity,
          fulltextScore: 0, // RRFスコアに統合済み
          moodCategory: String(data.mood_category ?? '') as MoodCategory,
          moodDescription: String(data.mood_description ?? ''),
          confidence: Number(data.confidence ?? 0),
        };
      });

      const processingTimeMs = Date.now() - startTime;
      if (isDevelopment()) {
        logger.info('[NarrativeSearchService] Hybrid search completed', {
          totalMerged: hybridResults.length,
          resultsCount: results.length,
          processingTimeMs,
        });
      }

      return results;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[NarrativeSearchService] Hybrid search error, falling back to vector search', {
          error: error instanceof Error ? error.message : 'Unknown error',
          query: queryText,
        });
      }
      // フォールバック: ベクトル検索のみ
      return this.search(options);
    }
  }

  /**
   * Vector検索のみ（Embedding直接指定）
   *
   * @param embedding - クエリEmbedding（768次元）
   * @param limit - 取得件数
   * @param minSimilarity - 最小類似度
   * @param filters - オプショナルフィルター
   * @returns 検索結果
   */
  async searchByVector(
    embedding: number[],
    limit?: number,
    minSimilarity?: number,
    filters?: NarrativeSearchOptions['filters']
  ): Promise<NarrativeSearchResult[]> {
    const effectiveLimit = limit ?? this.config.defaultLimit;
    const effectiveMinSimilarity = minSimilarity ?? DEFAULT_SEARCH_CONFIG.minSimilarity;

    if (isDevelopment()) {
      logger.info('[NarrativeSearchService] Vector search', {
        embeddingDimensions: embedding.length,
        limit: effectiveLimit,
        minSimilarity: effectiveMinSimilarity,
      });
    }

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[NarrativeSearchService] PrismaClient not available for vector search');
      }
      return [];
    }

    try {
      const vectorString = `[${embedding.join(',')}]`;

      // フィルター条件を構築（$1 = vectorString, $2 = minSimilarity）
      const { conditions, params: filterParams, nextParamIndex } = buildWhereClause(
        filters,
        3 // $1 = vectorString, $2 = minSimilarity
      );

      // 最小類似度フィルターを追加
      conditions.push(`1 - (dne.embedding <=> $1::vector) >= $2`);

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const sql = `
        SELECT
          dn.id, dn.web_page_id, dn.mood_category,
          dn.mood_description, dn.confidence,
          1 - (dne.embedding <=> $1::vector) AS similarity,
          wp.url AS wp_url, wp.title AS wp_title
        FROM design_narratives dn
        INNER JOIN design_narrative_embeddings dne
          ON dn.id = dne.design_narrative_id
        INNER JOIN web_pages wp ON wp.id = dn.web_page_id
        ${whereClause}
        ORDER BY dne.embedding <=> $1::vector ASC
        LIMIT $${nextParamIndex}
      `;

      const allParams = [vectorString, effectiveMinSimilarity, ...filterParams, effectiveLimit];
      const rows = await prisma.$queryRawUnsafe<VectorSearchRow[]>(sql, ...allParams);

      return rows.map(mapRowToResult);
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[NarrativeSearchService] Vector search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw error;
    }
  }

  /**
   * MoodCategoryでフィルター検索
   *
   * Embeddingを使わず、MoodCategoryフィルターのみで検索。
   * confidenceの降順でソート。
   *
   * @param moodCategories - フィルターするMoodCategory配列
   * @param limit - 取得件数
   * @returns 検索結果
   */
  async searchByMoodCategory(
    moodCategories: MoodCategory[],
    limit?: number
  ): Promise<NarrativeSearchResult[]> {
    const effectiveLimit = limit ?? this.config.defaultLimit;

    if (isDevelopment()) {
      logger.info('[NarrativeSearchService] MoodCategory search', {
        moodCategories,
        limit: effectiveLimit,
      });
    }

    if (moodCategories.length === 0) {
      return [];
    }

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[NarrativeSearchService] PrismaClient not available for mood search');
      }
      return [];
    }

    try {
      const sql = `
        SELECT
          dn.id, dn.web_page_id, dn.mood_category,
          dn.mood_description, dn.confidence,
          dn.confidence AS similarity,
          wp.url AS wp_url, wp.title AS wp_title
        FROM design_narratives dn
        INNER JOIN web_pages wp ON wp.id = dn.web_page_id
        WHERE dn.mood_category::text = ANY($1::text[])
        ORDER BY dn.confidence DESC
        LIMIT $2
      `;

      const rows = await prisma.$queryRawUnsafe<VectorSearchRow[]>(
        sql,
        moodCategories,
        effectiveLimit
      );

      return rows.map(mapRowToResult);
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[NarrativeSearchService] MoodCategory search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          moodCategories,
        });
      }
      throw error;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * クエリからEmbeddingを生成
   */
  private async generateQueryEmbedding(query: string): Promise<number[]> {
    const embeddingService = this.getEmbeddingService();

    // NOTE: generateEmbedding() が内部で E5 prefix ("query: " / "passage: ") を
    // 自動付与するため、ここではプレフィックスなしのテキストを渡す。
    return embeddingService.generateEmbedding(query, 'query');
  }
}

/**
 * NarrativeSearchServiceインスタンスを作成
 */
export function createNarrativeSearchService(
  config?: NarrativeSearchServiceConfig
): NarrativeSearchService {
  return new NarrativeSearchService(config);
}
