// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PartSearchService
 * part.search ツール用のサービス実装
 *
 * 機能:
 * - コンポーネントパーツのビジュアル検索（DINOv2 visual_embedding）
 * - テキスト検索（e5-base text_embedding）
 * - 全文検索（PostgreSQL tsvector）
 * - ハイブリッド検索（RRF: 60% vector + 40% fulltext）
 * - 参照パーツIDによるビジュアル類似検索
 * - フィルタリング（パーツタイプ、セクションタイプ、CSSフレームワーク）
 *
 * Features:
 * - Visual search for component parts (DINOv2 visual_embedding)
 * - Text search (e5-base text_embedding)
 * - Full-text search (PostgreSQL tsvector)
 * - Hybrid search (RRF: 60% vector + 40% fulltext)
 * - Visual similarity search by reference part ID
 * - Filtering (part type, section type, CSS framework)
 *
 * @module services/part/part-search.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import {
  executeHybridSearch,
  buildFulltextConditions,
  buildFulltextRankExpression,
  toRankedItems,
} from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import { truncateId } from './schemas';

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * EmbeddingServiceインターフェース
 * EmbeddingService interface
 */
export interface PartSearchEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
}

/**
 * PrismaClientインターフェース（部分的）
 * PrismaClient interface (partial)
 */
export interface PartSearchPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * パーツ検索オプション
 * Part search options
 */
export interface PartSearchOptions {
  /** 返却件数 / Result limit (default 10) */
  limit: number;
  /** オフセット / Offset (default 0) */
  offset: number;
  /** 最小類似度閾値 / Minimum similarity threshold (default 0.3) */
  minSimilarity: number;
  /** パーツタイプフィルタ / Part type filter */
  partType?: string;
  /** セクションタイプフィルタ（section_patterns結合） / Section type filter (via section_patterns join) */
  sectionType?: string;
  /** CSSフレームワークフィルタ（section_patterns.css_framework） / CSS framework filter */
  cssFramework?: string;
  /** 検索モード / Search mode (default 'hybrid') */
  searchMode: 'visual' | 'text' | 'hybrid';
}

/**
 * 検索結果アイテム
 * Search result item
 */
export interface PartSearchResultItem {
  id: string;
  partType: string;
  partSubtype: string | null;
  sectionType: string;
  webPageUrl: string;
  similarity: number;
  visualSimilarity?: number;
  textSimilarity?: number;
  boundingBox: Record<string, unknown>;
  computedStyles?: Record<string, string>;
  htmlSnippet?: string;
}

/**
 * 検索結果
 * Search result
 */
export interface PartSearchResult {
  results: PartSearchResultItem[];
  total: number;
  query: { text?: string; referencePartId?: string };
}

/**
 * PartSearchServiceInterface インターフェース
 * PartSearchServiceInterface interface
 */
export interface PartSearchServiceInterface {
  generateQueryEmbedding(query: string): Promise<number[] | null>;
  searchParts(embedding: number[], options: PartSearchOptions): Promise<PartSearchResult>;
  searchPartsHybrid(
    queryText: string,
    embedding: number[],
    options: PartSearchOptions
  ): Promise<PartSearchResult>;
  searchPartsByVisual(
    referencePartId: string,
    options: PartSearchOptions
  ): Promise<PartSearchResult>;
}

// =====================================================
// DB Row型 / DB Row types
// =====================================================

/**
 * ベクトル検索結果行
 * Vector search result row
 */
interface PartVectorSearchRow {
  id: string;
  part_type: string;
  part_subtype: string | null;
  bounding_box: Record<string, unknown>;
  computed_styles: Record<string, string>;
  html_snippet: string | null;
  section_type: string;
  web_page_url: string;
  similarity: number;
}

// =====================================================
// DI Factories
// =====================================================

let embeddingServiceFactory: (() => PartSearchEmbeddingService) | null = null;
let prismaClientFactory: (() => PartSearchPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 * Set EmbeddingService factory
 */
export function setPartSearchEmbeddingServiceFactory(
  factory: () => PartSearchEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 * Reset EmbeddingService factory
 */
export function resetPartSearchEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 * Set PrismaClient factory
 */
export function setPartSearchPrismaClientFactory(
  factory: () => PartSearchPrismaClient
): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 * Reset PrismaClient factory
 */
export function resetPartSearchPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数 / Helper functions
// =====================================================

/**
 * WHERE句構築結果
 * WHERE clause build result
 */
interface BuildWhereResult {
  clause: string;
  params: unknown[];
  nextIndex: number;
}

/**
 * フィルター条件をWHERE句に変換
 * Convert filter conditions to WHERE clause
 */
export function buildPartSearchWhereClause(
  options: Pick<PartSearchOptions, 'partType' | 'sectionType' | 'cssFramework'>,
  startIndex: number = 1
): BuildWhereResult {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = startIndex;

  if (options.partType) {
    conditions.push(`cp.part_type = $${paramIndex}`);
    params.push(options.partType);
    paramIndex++;
  }

  if (options.sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(options.sectionType);
    paramIndex++;
  }

  if (options.cssFramework) {
    conditions.push(`sp.css_framework = $${paramIndex}`);
    params.push(options.cssFramework);
    paramIndex++;
  }

  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : '',
    params,
    nextIndex: paramIndex,
  };
}

/**
 * DB行を検索結果アイテムに変換
 * Convert DB row to search result item
 */
function mapRowToResultItem(row: PartVectorSearchRow): PartSearchResultItem {
  const item: PartSearchResultItem = {
    id: row.id,
    partType: row.part_type,
    partSubtype: row.part_subtype,
    sectionType: row.section_type,
    webPageUrl: row.web_page_url,
    similarity: row.similarity,
    boundingBox: row.bounding_box ?? {},
  };

  if (row.computed_styles && Object.keys(row.computed_styles).length > 0) {
    item.computedStyles = row.computed_styles;
  }

  if (row.html_snippet) {
    item.htmlSnippet = row.html_snippet;
  }

  return item;
}

/**
 * エラーメッセージをサニタイズ（内部構造の漏洩防止）
 * Sanitize error message (prevent internal structure leakage)
 */
function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Prisma系エラーコードを検出
    const prismaError = error as { code?: string };
    if (prismaError.code) {
      switch (prismaError.code) {
        case 'P2002': return 'A record with this value already exists';
        case 'P2025': return 'Record not found';
        default: return 'Database operation failed';
      }
    }
  }
  return 'An internal error occurred';
}

// =====================================================
// PartSearchService
// =====================================================

/**
 * PartSearchServiceクラス
 * PartSearchService class
 *
 * コンポーネントパーツのベクトル検索、全文検索、ハイブリッド検索を提供。
 * Provides vector, full-text, and hybrid search for component parts.
 */
export class PartSearchService implements PartSearchServiceInterface {
  private embeddingService: PartSearchEmbeddingService | null = null;
  private prismaClient: PartSearchPrismaClient | null = null;

  /**
   * EmbeddingServiceを取得
   * Get EmbeddingService
   */
  private getEmbeddingService(): PartSearchEmbeddingService {
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
   * Get PrismaClient
   */
  private getPrismaClient(): PartSearchPrismaClient {
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
   * クエリテキストからEmbeddingを生成
   * Generate embedding from query text
   *
   * EmbeddingServiceが利用できない場合はnullを返す。
   * Returns null if EmbeddingService is not available.
   */
  async generateQueryEmbedding(query: string): Promise<number[] | null> {
    if (isDevelopment()) {
      logger.info('[PartSearchService] Generating query embedding', {
        queryLength: query.length,
      });
    }

    if (!embeddingServiceFactory) {
      if (isDevelopment()) {
        logger.warn('[PartSearchService] EmbeddingService not available, returning null');
      }
      return null;
    }

    try {
      const service = this.getEmbeddingService();
      return await service.generateEmbedding(query, 'query');
    } catch (error) {
      logger.warn('[PartSearchService] Embedding generation failed, returning null', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * テキストベクトル検索（e5-base text_embedding）
   * Text vector search (e5-base text_embedding)
   */
  async searchParts(
    embedding: number[],
    options: PartSearchOptions
  ): Promise<PartSearchResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[PartSearchService] Starting text vector search', {
        embeddingDimensions: embedding.length,
        limit: options.limit,
        offset: options.offset,
        searchMode: options.searchMode,
      });
    }

    let prisma: PartSearchPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      logger.warn('[PartSearchService] PrismaClient not available');
      return { results: [], total: 0, query: {} };
    }

    try {
      const { clause: filterClause, params: filterParams, nextIndex } =
        buildPartSearchWhereClause(options, 1);

      const vectorString = `[${embedding.join(',')}]`;
      const embeddingColumn = options.searchMode === 'visual'
        ? 'cpe.visual_embedding'
        : 'cpe.text_embedding';

      const vectorParamIndex = nextIndex;
      const limitParamIndex = nextIndex + 1;
      const offsetParamIndex = nextIndex + 2;

      // WHERE句を構築
      const embeddingNotNull = `${embeddingColumn} IS NOT NULL`;
      const whereClause = filterClause
        ? `WHERE ${filterClause} AND ${embeddingNotNull}`
        : `WHERE ${embeddingNotNull}`;

      const query = `
        SELECT
          cp.id, cp.part_type, cp.part_subtype,
          cp.bounding_box, cp.computed_styles, cp.html_snippet,
          sp.section_type,
          wp.url AS web_page_url,
          1 - (${embeddingColumn} <=> $${vectorParamIndex}::vector) AS similarity
        FROM component_parts cp
        INNER JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
        INNER JOIN section_patterns sp ON sp.id = cp.section_pattern_id
        INNER JOIN web_pages wp ON wp.id = cp.web_page_id
        ${whereClause}
        ORDER BY ${embeddingColumn} <=> $${vectorParamIndex}::vector ASC
        LIMIT $${limitParamIndex}
        OFFSET $${offsetParamIndex}
      `;

      let searchResults: PartVectorSearchRow[] = [];

      try {
        searchResults = await prisma.$queryRawUnsafe<PartVectorSearchRow[]>(
          query,
          ...filterParams,
          vectorString,
          options.limit,
          options.offset
        );
      } catch (dbError) {
        logger.warn('[PartSearchService] Vector search query failed', {
          error: dbError instanceof Error ? dbError.message : 'Unknown error',
        });
        return { results: [], total: 0, query: {} };
      }

      // 類似度閾値フィルタ
      const filtered = searchResults.filter((r) => r.similarity >= options.minSimilarity);
      const results = filtered.map(mapRowToResultItem);

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[PartSearchService] Text vector search completed', {
          resultsCount: results.length,
          processingTimeMs,
        });
      }

      return {
        results,
        total: results.length,
        query: {},
      };
    } catch (error) {
      logger.warn('[PartSearchService] searchParts error', {
        error: sanitizeErrorMessage(error),
      });
      return { results: [], total: 0, query: {} };
    }
  }

  /**
   * ハイブリッド検索: テキストベクトル + 全文検索をRRFで統合
   * Hybrid search: text vector + full-text search merged with RRF
   *
   * 両検索を並列実行し、Reciprocal Rank Fusion (60% vector + 40% fulltext) で
   * 結果をマージする。全文検索が失敗した場合はベクトル検索のみで結果を返す。
   *
   * Both searches run in parallel, merged with RRF (60% vector + 40% fulltext).
   * Falls back to vector-only if full-text search fails.
   */
  async searchPartsHybrid(
    queryText: string,
    embedding: number[],
    options: PartSearchOptions
  ): Promise<PartSearchResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[PartSearchService] Starting hybrid search (vector + fulltext)', {
        queryTextLength: queryText.length,
        embeddingDimensions: embedding.length,
        limit: options.limit,
        offset: options.offset,
      });
    }

    let prisma: PartSearchPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      logger.warn('[PartSearchService] PrismaClient not available');
      return { results: [], total: 0, query: { text: queryText } };
    }

    try {
      const { clause: filterClause, params: filterParams, nextIndex } =
        buildPartSearchWhereClause(options, 1);

      // RRFマージ用に多めに取得
      const fetchLimit = Math.min(options.limit * 3, 150);

      // ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vectorString = `[${embedding.join(',')}]`;
        const vecParamIdx = nextIndex;
        const vecLimitIdx = nextIndex + 1;

        const embeddingNotNull = 'cpe.text_embedding IS NOT NULL';
        const whereClause = filterClause
          ? `WHERE ${filterClause} AND ${embeddingNotNull}`
          : `WHERE ${embeddingNotNull}`;

        const sql = `
          SELECT
            cp.id, cp.part_type, cp.part_subtype,
            cp.bounding_box, cp.computed_styles, cp.html_snippet,
            sp.section_type,
            wp.url AS web_page_url,
            1 - (cpe.text_embedding <=> $${vecParamIdx}::vector) AS similarity
          FROM component_parts cp
          INNER JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
          INNER JOIN section_patterns sp ON sp.id = cp.section_pattern_id
          INNER JOIN web_pages wp ON wp.id = cp.web_page_id
          ${whereClause}
          ORDER BY cpe.text_embedding <=> $${vecParamIdx}::vector ASC
          LIMIT $${vecLimitIdx}
        `;

        const rows = await prisma.$queryRawUnsafe<PartVectorSearchRow[]>(
          sql,
          ...filterParams,
          vectorString,
          fetchLimit
        );

        return toRankedItems(rows);
      };

      // 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        try {
          const ftQueryIdx = nextIndex;
          const ftLimitIdx = nextIndex + 1;

          const ftConditions = buildFulltextConditions('cpe.search_vector', ftQueryIdx);
          const ftRank = buildFulltextRankExpression('cpe.search_vector', ftQueryIdx);

          const whereClause = filterClause
            ? `WHERE ${filterClause} AND ${ftConditions}`
            : `WHERE ${ftConditions}`;

          const sql = `
            SELECT
              cp.id, cp.part_type, cp.part_subtype,
              cp.bounding_box, cp.computed_styles, cp.html_snippet,
              sp.section_type,
              wp.url AS web_page_url,
              ${ftRank} AS similarity
            FROM component_parts cp
            INNER JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
            INNER JOIN section_patterns sp ON sp.id = cp.section_pattern_id
            INNER JOIN web_pages wp ON wp.id = cp.web_page_id
            ${whereClause}
            ORDER BY similarity DESC
            LIMIT $${ftLimitIdx}
          `;

          const rows = await prisma.$queryRawUnsafe<PartVectorSearchRow[]>(
            sql,
            ...filterParams,
            queryText,
            fetchLimit
          );

          return toRankedItems(rows);
        } catch (ftError) {
          logger.warn('[PartSearchService] Full-text search failed, using vector only', {
            error: ftError instanceof Error ? ftError.message : 'Unknown error',
          });
          return [];
        }
      };

      // RRFハイブリッド検索を実行（並列）
      const hybridResults = await executeHybridSearch(
        vectorSearchFn,
        fulltextSearchFn
      );

      // offset/limitを適用
      const paginatedResults = hybridResults.slice(
        options.offset,
        options.offset + options.limit
      );

      // HybridSearchResult を PartSearchResultItem に変換
      const results: PartSearchResultItem[] = paginatedResults
        .filter((hr) => hr.similarity >= options.minSimilarity)
        .map((hr) => {
          const data = hr.data as unknown as PartVectorSearchRow;
          data.id = hr.id;
          const item = mapRowToResultItem(data);
          item.similarity = hr.similarity;
          return item;
        });

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[PartSearchService] Hybrid search completed', {
          totalMerged: hybridResults.length,
          resultsCount: results.length,
          processingTimeMs,
        });
      }

      return {
        results,
        total: hybridResults.length,
        query: { text: queryText },
      };
    } catch (error) {
      logger.warn('[PartSearchService] Hybrid search error, falling back to vector only', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // フォールバック: ベクトル検索のみ
      return this.searchParts(embedding, options);
    }
  }

  /**
   * 参照パーツIDによるビジュアル類似検索
   * Visual similarity search by reference part ID
   *
   * 参照パーツのvisual_embeddingをDBから取得し、
   * それをクエリベクトルとしてDINOv2 HNSWビジュアル検索を実行する。
   *
   * Fetches the reference part's visual_embedding from DB and
   * uses it as query vector for DINOv2 HNSW visual search.
   */
  async searchPartsByVisual(
    referencePartId: string,
    options: PartSearchOptions
  ): Promise<PartSearchResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[PartSearchService] Starting visual search by reference part', {
        referencePartId: truncateId(referencePartId),
        limit: options.limit,
      });
    }

    let prisma: PartSearchPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      logger.warn('[PartSearchService] PrismaClient not available');
      return { results: [], total: 0, query: { referencePartId } };
    }

    try {
      // 1. 参照パーツのvisual_embeddingを取得
      const refRows = await prisma.$queryRawUnsafe<Array<{ visual_embedding: string }>>(
        `SELECT visual_embedding::text
         FROM component_part_embeddings
         WHERE component_part_id = $1
           AND visual_embedding IS NOT NULL
         LIMIT 1`,
        referencePartId
      );

      if (refRows.length === 0) {
        if (isDevelopment()) {
          logger.warn('[PartSearchService] Reference part visual embedding not found', {
            referencePartId: truncateId(referencePartId),
          });
        }
        return { results: [], total: 0, query: { referencePartId } };
      }

      // pgvector text表現をそのまま使用（例: "[0.1,0.2,...,0.768]"）
      const refRow = refRows[0];
      if (!refRow) {
        return { results: [], total: 0, query: { referencePartId } };
      }
      const vectorString = refRow.visual_embedding;

      // 2. ビジュアル類似検索を実行
      const { clause: filterClause, params: filterParams, nextIndex } =
        buildPartSearchWhereClause(options, 1);

      const vectorParamIndex = nextIndex;
      const limitParamIndex = nextIndex + 1;
      const offsetParamIndex = nextIndex + 2;

      const embeddingNotNull = 'cpe.visual_embedding IS NOT NULL';
      // 自分自身を除外
      const selfExclusion = `cp.id != $${vectorParamIndex + 3}`;
      let whereClause: string;
      if (filterClause) {
        whereClause = `WHERE ${filterClause} AND ${embeddingNotNull} AND ${selfExclusion}`;
      } else {
        whereClause = `WHERE ${embeddingNotNull} AND ${selfExclusion}`;
      }

      const query = `
        SELECT
          cp.id, cp.part_type, cp.part_subtype,
          cp.bounding_box, cp.computed_styles, cp.html_snippet,
          sp.section_type,
          wp.url AS web_page_url,
          1 - (cpe.visual_embedding <=> $${vectorParamIndex}::vector) AS similarity
        FROM component_parts cp
        INNER JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
        INNER JOIN section_patterns sp ON sp.id = cp.section_pattern_id
        INNER JOIN web_pages wp ON wp.id = cp.web_page_id
        ${whereClause}
        ORDER BY cpe.visual_embedding <=> $${vectorParamIndex}::vector ASC
        LIMIT $${limitParamIndex}
        OFFSET $${offsetParamIndex}
      `;

      const searchResults = await prisma.$queryRawUnsafe<PartVectorSearchRow[]>(
        query,
        ...filterParams,
        vectorString,
        options.limit,
        options.offset,
        referencePartId
      );

      // 類似度閾値フィルタ
      const filtered = searchResults.filter((r) => r.similarity >= options.minSimilarity);
      const results = filtered.map((row) => {
        const item = mapRowToResultItem(row);
        item.visualSimilarity = row.similarity;
        return item;
      });

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[PartSearchService] Visual search completed', {
          resultsCount: results.length,
          processingTimeMs,
        });
      }

      return {
        results,
        total: results.length,
        query: { referencePartId },
      };
    } catch (error) {
      logger.warn('[PartSearchService] Visual search error', {
        error: sanitizeErrorMessage(error),
      });
      return { results: [], total: 0, query: { referencePartId } };
    }
  }
}

// =====================================================
// シングルトンインスタンス / Singleton instance
// =====================================================

let partSearchServiceInstance: PartSearchService | null = null;

/**
 * PartSearchServiceインスタンスを取得
 * Get PartSearchService instance
 */
export function getPartSearchService(): PartSearchService {
  if (!partSearchServiceInstance) {
    partSearchServiceInstance = new PartSearchService();
  }
  return partSearchServiceInstance;
}

/**
 * PartSearchServiceインスタンスをリセット
 * Reset PartSearchService instance
 */
export function resetPartSearchService(): void {
  partSearchServiceInstance = null;
}

/**
 * PartSearchServiceファクトリを作成
 * Create PartSearchService factory
 */
export function createPartSearchServiceFactory(): () => PartSearchServiceInterface {
  return () => getPartSearchService();
}

export default PartSearchService;
