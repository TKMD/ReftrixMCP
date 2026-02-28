// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackgroundSearchService — Background Design のベクトル＋ハイブリッド検索
 *
 * service-initializer.ts から抽出（TDA-HS-R1 / H-3 対応）。
 * LayoutSearchService / MotionSearchService と同一のDIパターンに統一。
 *
 * @module services/background-search.service
 */

import { logger } from '../utils/logger';
import { isDevelopmentEnvironment } from './production-guard';
import {
  executeHybridSearch,
  buildFulltextConditions,
  buildFulltextRankExpression,
  toRankedItems,
} from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import type { BackgroundDesignSearchResult } from '../tools/background/search.tool';

// =====================================================
// PrismaClient インターフェース（DI用）
// =====================================================

export interface IBackgroundSearchPrismaClient {
  $queryRawUnsafe: (...args: unknown[]) => Promise<unknown>;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

export interface IBackgroundSearchEmbeddingService {
  generateEmbedding: (text: string, type: 'query' | 'passage') => Promise<number[]>;
}

// =====================================================
// DI Factories
// =====================================================

let prismaClientFactory: (() => IBackgroundSearchPrismaClient) | null = null;
let embeddingServiceFactory: (() => IBackgroundSearchEmbeddingService) | null = null;

export function setBackgroundSearchPrismaClientFactory(
  factory: () => IBackgroundSearchPrismaClient
): void {
  prismaClientFactory = factory;
}

export function setBackgroundSearchEmbeddingServiceFactory(
  factory: () => IBackgroundSearchEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

// =====================================================
// Row型定義
// =====================================================

interface BackgroundSearchRow {
  id: string;
  web_page_id: string;
  name: string;
  design_type: string;
  css_value: string;
  selector: string | null;
  color_info: Record<string, unknown>;
  text_representation: string;
  similarity: number;
}

// =====================================================
// ヘルパー
// =====================================================

function mapRowToResult(row: BackgroundSearchRow): BackgroundDesignSearchResult {
  return {
    id: row.id,
    webPageId: row.web_page_id,
    name: row.name,
    designType: row.design_type,
    cssValue: row.css_value,
    selector: row.selector,
    similarity: row.similarity,
    colorInfo: row.color_info ?? {},
    textRepresentation: row.text_representation ?? '',
  };
}

interface BackgroundSearchFilters {
  designType?: string;
  webPageId?: string;
}

interface BuildWhereResult {
  whereClause: string;
  params: unknown[];
  nextParamIndex: number;
}

function buildWhereClause(
  filters: BackgroundSearchFilters | undefined,
  startParamIndex: number
): BuildWhereResult {
  const conditions: string[] = ['bde.embedding IS NOT NULL'];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

  if (filters?.designType) {
    conditions.push(`bd.design_type::text = $${paramIndex}`);
    params.push(filters.designType);
    paramIndex++;
  }

  if (filters?.webPageId) {
    conditions.push(`bd.web_page_id = $${paramIndex}`);
    params.push(filters.webPageId);
    paramIndex++;
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: paramIndex,
  };
}

// =====================================================
// BackgroundSearchService
// =====================================================

export interface BackgroundSearchServiceConfig {
  prisma: IBackgroundSearchPrismaClient;
  embeddingService: IBackgroundSearchEmbeddingService;
}

export function createBackgroundSearchService(config: BackgroundSearchServiceConfig): {
  generateQueryEmbedding: (query: string) => Promise<number[] | null>;
  searchBackgroundDesigns: (
    embedding: number[],
    options: { limit: number; offset: number; filters?: BackgroundSearchFilters }
  ) => Promise<{ results: BackgroundDesignSearchResult[]; total: number }>;
  searchBackgroundDesignsHybrid: (
    queryText: string,
    embedding: number[],
    options: { limit: number; offset: number; filters?: BackgroundSearchFilters }
  ) => Promise<{ results: BackgroundDesignSearchResult[]; total: number }>;
} {
  const { prisma, embeddingService } = config;

  // -----------------------------------------------
  // generateQueryEmbedding
  // -----------------------------------------------
  async function generateQueryEmbedding(query: string): Promise<number[] | null> {
    try {
      return await embeddingService.generateEmbedding(query, 'query');
    } catch (error) {
      if (isDevelopmentEnvironment()) {
        logger.warn('[BackgroundSearchService] Embedding generation failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return null;
    }
  }

  // -----------------------------------------------
  // searchBackgroundDesigns (vector-only)
  // -----------------------------------------------
  async function searchBackgroundDesigns(
    embedding: number[],
    options: { limit: number; offset: number; filters?: BackgroundSearchFilters }
  ): Promise<{ results: BackgroundDesignSearchResult[]; total: number }> {
    const vectorString = `[${embedding.join(',')}]`;
    const { whereClause, params: filterParams, nextParamIndex } = buildWhereClause(
      options.filters,
      2 // $1 is reserved for vectorString
    );

    const sql = `
      SELECT
        bd.id, bd.web_page_id, bd.name, bd.design_type,
        bd.css_value, bd.selector, bd.color_info,
        bde.text_representation,
        1 - (bde.embedding <=> $1::vector) AS similarity
      FROM background_designs bd
      INNER JOIN background_design_embeddings bde
        ON bd.id = bde.background_design_id
      ${whereClause}
      ORDER BY bde.embedding <=> $1::vector ASC
      LIMIT $${nextParamIndex}
      OFFSET $${nextParamIndex + 1}
    `;

    const allParams = [vectorString, ...filterParams, options.limit, options.offset];
    const rows = (await prisma.$queryRawUnsafe(sql, ...allParams)) as BackgroundSearchRow[];

    // Total count
    let total = rows.length;
    if (options.offset === 0 && rows.length >= options.limit) {
      const countSql = `
        SELECT COUNT(*) AS total
        FROM background_designs bd
        INNER JOIN background_design_embeddings bde
          ON bd.id = bde.background_design_id
        ${whereClause}
      `;
      const countResult = (await prisma.$queryRawUnsafe(
        countSql,
        vectorString,
        ...filterParams
      )) as Array<{ total: bigint | number }>;
      total = Number(countResult[0]?.total ?? rows.length);
    }

    return { results: rows.map(mapRowToResult), total };
  }

  // -----------------------------------------------
  // searchBackgroundDesignsHybrid (vector + fulltext → RRF)
  // -----------------------------------------------
  async function searchBackgroundDesignsHybrid(
    queryText: string,
    embedding: number[],
    options: { limit: number; offset: number; filters?: BackgroundSearchFilters }
  ): Promise<{ results: BackgroundDesignSearchResult[]; total: number }> {
    try {
      const vectorString = `[${embedding.join(',')}]`;
      const fetchLimit = Math.min(options.limit * 3, 150);

      const { whereClause: baseWhereClause, params: baseParams, nextParamIndex: paramIndex } =
        buildWhereClause(options.filters, 1);

      // ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vecParamIdx = paramIndex;
        const vecLimitIdx = paramIndex + 1;

        const vecSql = `
          SELECT
            bd.id, bd.web_page_id, bd.name, bd.design_type,
            bd.css_value, bd.selector, bd.color_info,
            bde.text_representation,
            1 - (bde.embedding <=> $${vecParamIdx}::vector) AS similarity
          FROM background_designs bd
          INNER JOIN background_design_embeddings bde
            ON bd.id = bde.background_design_id
          ${baseWhereClause}
          ORDER BY bde.embedding <=> $${vecParamIdx}::vector ASC
          LIMIT $${vecLimitIdx}
        `;

        const rows = (await prisma.$queryRawUnsafe(
          vecSql,
          ...baseParams,
          vectorString,
          fetchLimit
        )) as BackgroundSearchRow[];

        return toRankedItems(rows);
      };

      // 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        try {
          const ftQueryIdx = paramIndex;
          const ftLimitIdx = paramIndex + 1;

          const ftConditions = buildFulltextConditions('bde.search_vector', ftQueryIdx);
          const ftRank = buildFulltextRankExpression('bde.search_vector', ftQueryIdx);

          // ベースフィルター + 全文検索条件
          const conditions = baseWhereClause
            ? `${baseWhereClause} AND ${ftConditions}`
            : `WHERE ${ftConditions}`;

          const ftSql = `
            SELECT
              bd.id, bd.web_page_id, bd.name, bd.design_type,
              bd.css_value, bd.selector, bd.color_info,
              bde.text_representation,
              ${ftRank} AS similarity
            FROM background_designs bd
            INNER JOIN background_design_embeddings bde
              ON bd.id = bde.background_design_id
            ${conditions}
            ORDER BY similarity DESC
            LIMIT $${ftLimitIdx}
          `;

          const rows = (await prisma.$queryRawUnsafe(
            ftSql,
            ...baseParams,
            queryText,
            fetchLimit
          )) as BackgroundSearchRow[];

          return toRankedItems(rows);
        } catch (ftError) {
          if (isDevelopmentEnvironment()) {
            logger.warn('[BackgroundSearchService] Full-text search failed, using vector only', {
              error: ftError instanceof Error ? ftError.message : 'Unknown error',
            });
          }
          return [];
        }
      };

      const hybridResults = await executeHybridSearch(vectorSearchFn, fulltextSearchFn);

      // RRF結果をスライスしてマッピング
      const sliced = hybridResults.slice(options.offset, options.offset + options.limit);
      const results: BackgroundDesignSearchResult[] = sliced.map((hr) => {
        const data = hr.data as Record<string, unknown>;
        return {
          id: String(data.id ?? hr.id),
          webPageId: String(data.web_page_id ?? ''),
          name: String(data.name ?? ''),
          designType: String(data.design_type ?? ''),
          cssValue: String(data.css_value ?? ''),
          selector: data.selector !== null && data.selector !== undefined ? String(data.selector) : null,
          similarity: hr.similarity,
          colorInfo: (data.color_info as Record<string, unknown>) ?? {},
          textRepresentation: String(data.text_representation ?? ''),
        };
      });

      return { results, total: hybridResults.length };
    } catch (error) {
      if (isDevelopmentEnvironment()) {
        logger.error('[BackgroundSearchService] Hybrid search error, falling back to vector', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // フォールバック: ベクトル検索のみ
      return searchBackgroundDesigns(embedding, options);
    }
  }

  return {
    generateQueryEmbedding,
    searchBackgroundDesigns,
    searchBackgroundDesignsHybrid,
  };
}

/**
 * DI Factoryから BackgroundSearchService を作成するファクトリ関数。
 * service-initializer.ts から呼ばれる。
 */
export function createBackgroundSearchServiceFromFactories(): ReturnType<typeof createBackgroundSearchService> | null {
  if (!prismaClientFactory || !embeddingServiceFactory) {
    return null;
  }
  return createBackgroundSearchService({
    prisma: prismaClientFactory(),
    embeddingService: embeddingServiceFactory(),
  });
}
