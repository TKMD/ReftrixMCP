// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * NarrativeSearchService — DesignNarrative のベクトル＋ハイブリッド検索
 *
 * service-initializer.ts から抽出（TDA-HS-R1 / M-1 対応）。
 * BackgroundSearchService / MotionSearchService と同一のDIパターンに統一。
 *
 * @module services/narrative-search.service
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
import type {
  INarrativeAnalysisService,
  NarrativeSearchOptions,
  NarrativeSearchResult,
  NarrativeAnalysisInput,
  NarrativeAnalysisResult,
  SavedNarrative,
  MoodCategory,
} from './narrative/types/narrative.types';

// =====================================================
// PrismaClient インターフェース（DI用）
// =====================================================

export interface INarrativeSearchPrismaClient {
  $queryRawUnsafe: (...args: unknown[]) => Promise<unknown>;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

export interface INarrativeSearchEmbeddingService {
  generateEmbedding: (text: string, type: 'query' | 'passage') => Promise<number[]>;
}

// =====================================================
// Row型定義
// =====================================================

interface NarrativeVectorRow {
  id: string;
  web_page_id: string;
  mood_category: string;
  mood_description: string;
  confidence: number;
  vector_score: number;
}

interface NarrativeFulltextRow {
  id: string;
  web_page_id: string;
  mood_category: string;
  mood_description: string;
  confidence: number;
  ft_score: number;
}

// =====================================================
// ヘルパー
// =====================================================

function mapRowToResult(row: NarrativeVectorRow): NarrativeSearchResult {
  return {
    id: row.id,
    webPageId: row.web_page_id,
    score: row.vector_score,
    vectorScore: row.vector_score,
    fulltextScore: 0,
    moodCategory: row.mood_category as MoodCategory,
    moodDescription: row.mood_description ?? '',
    confidence: row.confidence ?? 0,
  };
}

interface NarrativeSearchFilters {
  moodCategory?: MoodCategory[];
  minConfidence?: number;
}

interface BuildWhereResult {
  whereClause: string;
  params: unknown[];
  nextParamIndex: number;
}

function buildWhereClause(
  filters: NarrativeSearchFilters | undefined,
  startParamIndex: number
): BuildWhereResult {
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
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: paramIndex,
  };
}

// =====================================================
// NarrativeSearchService
// =====================================================

export interface NarrativeSearchServiceConfig {
  prisma: INarrativeSearchPrismaClient;
  embeddingService: INarrativeSearchEmbeddingService;
}

export function createNarrativeSearchService(config: NarrativeSearchServiceConfig): INarrativeAnalysisService {
  const { prisma, embeddingService } = config;

  // -----------------------------------------------
  // search (vector-only)
  // -----------------------------------------------
  async function search(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> {
    const limit = options.limit ?? 10;
    const queryText = options.query;

    try {
      // 1. クエリ Embedding 生成
      // NOTE: generateEmbedding() が内部で E5 prefix ("query: ") を自動付与するため、
      // プレフィックスなしのテキストを渡す。
      const queryEmbedding = await embeddingService.generateEmbedding(
        queryText,
        'query'
      );
      const vectorString = `[${queryEmbedding.join(',')}]`;

      // 2. pgvector HNSW cosine similarity 検索
      const { whereClause, params: filterParams, nextParamIndex } = buildWhereClause(
        options.filters,
        2 // $1 is reserved for vectorString
      );

      const sql = `
        SELECT
          dn.id, dn.web_page_id, dn.mood_category,
          dn.mood_description, dn.confidence,
          1 - (dne.embedding <=> $1::vector) AS vector_score
        FROM design_narratives dn
        INNER JOIN design_narrative_embeddings dne
          ON dn.id = dne.design_narrative_id
        ${whereClause}
        ORDER BY dne.embedding <=> $1::vector ASC
        LIMIT $${nextParamIndex}
      `;

      const allParams = [vectorString, ...filterParams, limit];
      const rows = (await prisma.$queryRawUnsafe(sql, ...allParams)) as NarrativeVectorRow[];

      // 3. 結果を NarrativeSearchResult 形式に変換
      return rows.map(mapRowToResult);
    } catch (error) {
      if (isDevelopmentEnvironment()) {
        logger.error('[NarrativeSearchService] Search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          query: queryText,
        });
      }
      throw error;
    }
  }

  // -----------------------------------------------
  // searchHybrid (vector + fulltext → RRF)
  // -----------------------------------------------
  async function searchHybrid(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> {
    const limit = options.limit ?? 10;
    const queryText = options.query;

    try {
      // 1. クエリ Embedding 生成
      // NOTE: generateEmbedding() が内部で E5 prefix ("query: ") を自動付与するため、
      // プレフィックスなしのテキストを渡す。
      const queryEmbedding = await embeddingService.generateEmbedding(
        queryText,
        'query'
      );
      const vectorString = `[${queryEmbedding.join(',')}]`;
      const fetchLimit = Math.min(limit * 3, 150);

      // フィルター条件を構築
      const { whereClause: baseWhereClause, params: baseParams, nextParamIndex: paramIndex } =
        buildWhereClause(options.filters, 1);

      // 2. ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vecParamIdx = paramIndex;
        const vecLimitIdx = paramIndex + 1;

        const vecSql = `
          SELECT
            dn.id, dn.web_page_id, dn.mood_category,
            dn.mood_description, dn.confidence,
            1 - (dne.embedding <=> $${vecParamIdx}::vector) AS vector_score
          FROM design_narratives dn
          INNER JOIN design_narrative_embeddings dne
            ON dn.id = dne.design_narrative_id
          ${baseWhereClause}
          ORDER BY dne.embedding <=> $${vecParamIdx}::vector ASC
          LIMIT $${vecLimitIdx}
        `;

        const rows = (await prisma.$queryRawUnsafe(
          vecSql,
          ...baseParams,
          vectorString,
          fetchLimit
        )) as NarrativeVectorRow[];

        return toRankedItems(rows.map((r) => ({
          id: r.id,
          web_page_id: r.web_page_id,
          mood_category: r.mood_category,
          mood_description: r.mood_description,
          confidence: r.confidence,
          similarity: r.vector_score,
        })));
      };

      // 3. 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        try {
          const ftQueryIdx = paramIndex;
          const ftLimitIdx = paramIndex + 1;

          const ftCond = buildFulltextConditions('dne.search_vector', ftQueryIdx);
          const ftRank = buildFulltextRankExpression('dne.search_vector', ftQueryIdx);

          // ベースフィルター条件を取得（WHERE を除去）
          const baseConditionsPart = baseWhereClause.replace(/^WHERE\s+/i, '');
          const ftConditions = baseConditionsPart
            ? `WHERE ${baseConditionsPart} AND ${ftCond}`
            : `WHERE ${ftCond}`;

          const ftSql = `
            SELECT
              dn.id, dn.web_page_id, dn.mood_category,
              dn.mood_description, dn.confidence,
              ${ftRank} AS ft_score
            FROM design_narratives dn
            INNER JOIN design_narrative_embeddings dne
              ON dn.id = dne.design_narrative_id
            ${ftConditions}
            ORDER BY ft_score DESC
            LIMIT $${ftLimitIdx}
          `;

          const rows = (await prisma.$queryRawUnsafe(
            ftSql,
            ...baseParams,
            queryText,
            fetchLimit
          )) as NarrativeFulltextRow[];

          return toRankedItems(rows.map((r) => ({
            id: r.id,
            web_page_id: r.web_page_id,
            mood_category: r.mood_category,
            mood_description: r.mood_description,
            confidence: r.confidence,
            similarity: r.ft_score,
          })));
        } catch (ftError) {
          if (isDevelopmentEnvironment()) {
            logger.warn('[NarrativeSearchService] Full-text search failed, using vector only', {
              error: ftError instanceof Error ? ftError.message : 'Unknown error',
            });
          }
          return [];
        }
      };

      // 4. executeHybridSearch で RRF マージ
      const hybridResults = await executeHybridSearch(vectorSearchFn, fulltextSearchFn);

      // 5. 結果をスライスして NarrativeSearchResult 形式に変換
      return hybridResults.slice(0, limit).map((hr) => {
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
    } catch (error) {
      if (isDevelopmentEnvironment()) {
        logger.error('[NarrativeSearchService] Hybrid search error, falling back to vector search', {
          error: error instanceof Error ? error.message : 'Unknown error',
          query: queryText,
        });
      }
      // フォールバック: ベクトル検索のみ
      return search(options);
    }
  }

  // -----------------------------------------------
  // INarrativeAnalysisService 実装
  // -----------------------------------------------
  return {
    analyze: async (_input: NarrativeAnalysisInput): Promise<NarrativeAnalysisResult> => {
      throw new Error('NarrativeAnalysisService.analyze() is not available via DI search factory. Use narrative.analyze tool directly.');
    },
    save: async (_webPageId: string, _result: NarrativeAnalysisResult): Promise<SavedNarrative> => {
      throw new Error('NarrativeAnalysisService.save() is not available via DI search factory.');
    },
    analyzeAndSave: async (_input: NarrativeAnalysisInput): Promise<SavedNarrative> => {
      throw new Error('NarrativeAnalysisService.analyzeAndSave() is not available via DI search factory.');
    },
    search,
    searchHybrid,
  };
}
