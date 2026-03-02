// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Search Service
 *
 * responsive_analyses + responsive_analysis_embeddings を対象に
 * Vector Search + JSONB filter のハイブリッド検索を提供するサービス。
 *
 * パターン:
 * - background-search.service.ts / motion-search.service.ts と同一の DI パターン
 * - pgvector cosine similarity（<=> 演算子）
 * - JSONB フィルタ（differences, breakpoints, screenshot_diffs）
 * - Dynamic parameter indexing（SEC H-1/M-1 パターン）
 *
 * @module services/responsive-search
 */

import { isDevelopment, logger } from '../utils/logger';

// =====================================================
// 型定義
// =====================================================

export interface ResponsiveSearchResult {
  id: string;
  responsiveAnalysisId: string;
  webPageId: string;
  url: string;
  similarity: number;
  textRepresentation: string;
  viewportsAnalyzed: unknown;
  differences: unknown;
  breakpoints: unknown;
  screenshotDiffs: unknown;
  analysisTimeMs: number;
  createdAt: Date;
}

export interface ResponsiveSearchOptions {
  limit: number;
  offset: number;
  filters?: {
    diffCategory?: string;
    viewportPair?: string;
    breakpointRange?: { min?: number; max?: number };
    minDiffPercentage?: number;
    webPageId?: string;
  };
}

// =====================================================
// DI インターフェース
// =====================================================

interface IResponsiveSearchPrismaClient {
  $queryRawUnsafe: (...args: unknown[]) => Promise<unknown>;
}

interface IResponsiveSearchEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
}

// =====================================================
// サービス作成
// =====================================================

export interface ResponsiveSearchServiceConfig {
  prisma: IResponsiveSearchPrismaClient;
  embeddingService: IResponsiveSearchEmbeddingService;
}

export interface IResponsiveSearchService {
  generateQueryEmbedding: (query: string) => Promise<number[] | null>;
  searchResponsiveAnalyses: (
    embedding: number[],
    options: ResponsiveSearchOptions
  ) => Promise<{ results: ResponsiveSearchResult[]; total: number }>;
  searchResponsiveAnalysesHybrid?: (
    queryText: string,
    embedding: number[],
    options: ResponsiveSearchOptions
  ) => Promise<{ results: ResponsiveSearchResult[]; total: number }>;
}

export function createResponsiveSearchService(
  config: ResponsiveSearchServiceConfig
): IResponsiveSearchService {
  const { prisma, embeddingService } = config;

  return {
    generateQueryEmbedding: async (query: string): Promise<number[] | null> => {
      try {
        return await embeddingService.generateEmbedding(query, 'query');
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[ResponsiveSearch] Embedding generation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
    },

    searchResponsiveAnalyses: async (
      embedding: number[],
      options: ResponsiveSearchOptions
    ): Promise<{ results: ResponsiveSearchResult[]; total: number }> => {
      const vectorString = `[${embedding.join(',')}]`;
      const { limit, offset, filters } = options;

      // Dynamic parameter indexing (SEC H-1/M-1 pattern)
      let paramIndex = 2; // $1 = vectorString
      const conditions: string[] = ['rae.embedding IS NOT NULL'];
      const params: unknown[] = [vectorString];

      if (filters?.webPageId) {
        conditions.push(`ra.web_page_id = $${paramIndex}::uuid`);
        params.push(filters.webPageId);
        paramIndex++;
      }

      if (filters?.diffCategory) {
        conditions.push(`ra.differences @> $${paramIndex}::jsonb`);
        params.push(JSON.stringify([{ category: filters.diffCategory }]));
        paramIndex++;
      }

      if (filters?.breakpointRange) {
        if (filters.breakpointRange.min !== undefined) {
          conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(ra.breakpoints) bp WHERE (bp->>'width')::int >= $${paramIndex})`);
          params.push(filters.breakpointRange.min);
          paramIndex++;
        }
        if (filters.breakpointRange.max !== undefined) {
          conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(ra.breakpoints) bp WHERE (bp->>'width')::int <= $${paramIndex})`);
          params.push(filters.breakpointRange.max);
          paramIndex++;
        }
      }

      if (filters?.minDiffPercentage !== undefined) {
        conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(ra.screenshot_diffs) sd WHERE (sd->>'diffPercentage')::float >= $${paramIndex})`);
        params.push(filters.minDiffPercentage);
        paramIndex++;
      }

      if (filters?.viewportPair) {
        const [vp1, vp2] = filters.viewportPair.split('-');
        conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(ra.screenshot_diffs) sd WHERE sd->>'viewport1' = $${paramIndex} AND sd->>'viewport2' = $${paramIndex + 1})`);
        params.push(vp1);
        params.push(vp2);
        paramIndex += 2;
      }

      const whereClause = conditions.join(' AND ');

      // Limit & offset
      params.push(limit);
      const limitParam = paramIndex;
      paramIndex++;
      params.push(offset);
      const offsetParam = paramIndex;

      const sql = `
        SELECT
          rae.id,
          rae.responsive_analysis_id,
          ra.web_page_id,
          wp.url,
          1 - (rae.embedding <=> $1::vector) AS similarity,
          rae.text_representation,
          ra.viewports_analyzed,
          ra.differences,
          ra.breakpoints,
          ra.screenshot_diffs,
          ra.analysis_time_ms,
          ra.created_at
        FROM responsive_analysis_embeddings rae
        JOIN responsive_analyses ra ON rae.responsive_analysis_id = ra.id
        JOIN web_pages wp ON ra.web_page_id = wp.id
        WHERE ${whereClause}
        ORDER BY rae.embedding <=> $1::vector ASC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `;

      if (isDevelopment()) {
        logger.info('[ResponsiveSearch] Executing vector search', {
          filterCount: conditions.length - 1,
          limit,
          offset,
        });
      }

      const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as ResponsiveSearchResult[];

      // Count query for total
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM responsive_analysis_embeddings rae
        JOIN responsive_analyses ra ON rae.responsive_analysis_id = ra.id
        JOIN web_pages wp ON ra.web_page_id = wp.id
        WHERE ${whereClause}
      `;
      const countParams = params.slice(0, params.length - 2); // exclude limit/offset
      const countResult = (await prisma.$queryRawUnsafe(countSql, ...countParams)) as Array<{ total: number }>;
      const total = countResult[0]?.total ?? 0;

      if (isDevelopment()) {
        logger.info('[ResponsiveSearch] Search completed', {
          resultCount: rows.length,
          total,
          topSimilarity: rows.length > 0 ? rows[0]?.similarity : null,
        });
      }

      return { results: rows, total };
    },
  };
}
