// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TASK-05 (GREEN Phase): MoodBrandToneSearchService Implementation
 *
 * Purpose: Implement mood/brandTone semantic search using pgvector + HNSW
 * - searchByMood(): Query moodEmbedding with pgvector cosine distance
 * - searchByBrandTone(): Query brandToneEmbedding with pgvector cosine distance
 * - combineResultsWithRRF(): Merge results using Reciprocal Rank Fusion
 *
 * Database: SectionEmbedding table (moodEmbedding, brandToneEmbedding)
 * Vector Index: HNSW (m=16, ef_construction=64, cosine distance)
 * Embedding Dimensions: 768 (multilingual-e5-base, L2 normalized)
 *
 * @module services/search/mood-brandtone-search.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import {
  parseMoodFilter,
  parseBrandToneFilter,
  parseRRFWeights,
  type RRFWeights,
  type SearchResult,
  type CombinedSearchResult,
} from '../../schemas/mood-brandtone-filters';

// =====================================================
// 定数
// =====================================================

/** pgvector cosine distance operator */
const PGVECTOR_COSINE_DISTANCE = '<=>';

/** デフォルトのRRF重み */
const DEFAULT_RRF_WEIGHTS: RRFWeights = {
  mood: 0.6,
  brandTone: 0.4,
};

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
 * SectionEmbedding record type for findMany results
 */
export interface SectionEmbeddingRecord {
  id: string;
  section_pattern_id: string;
  moodEmbedding?: number[] | null;
  brandToneEmbedding?: number[] | null;
  [key: string]: unknown;
}

/**
 * PrismaClientインターフェース（部分的）
 */
export interface IPrismaClient {
  sectionEmbedding: {
    findMany: (args?: unknown) => Promise<SectionEmbeddingRecord[]>;
  };
  $queryRaw: <T = unknown>(sql: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;
}

/**
 * Internal search result from database
 */
interface DBSearchResult {
  pattern_id: string;
  section_pattern_id: string;
  similarity: number;
  distance: number;
}

// =====================================================
// MoodBrandToneSearchService
// =====================================================

export class MoodBrandToneSearchService {
  private prisma: IPrismaClient;
  private embeddingService: IEmbeddingService;

  constructor(prisma: IPrismaClient, embeddingService: IEmbeddingService) {
    this.prisma = prisma;
    this.embeddingService = embeddingService;
  }

  /**
   * Search patterns by mood filter using pgvector cosine similarity
   *
   * Algorithm:
   * 1. Validate input using moodFilterSchema
   * 2. Generate query embedding for primary mood
   * 3. Execute pgvector cosine distance search
   * 4. Filter by minSimilarity threshold
   * 5. If secondary mood provided, include in result metadata
   * 6. Sort by similarity descending
   *
   * @param filter MoodFilter with primary/secondary mood and constraints
   * @returns Array of SearchResult with similarity scores [0, 1]
   * @throws ZodError if filter validation fails
   * @performance Target: P95 < 100ms for typical queries
   */
  async searchByMood(filter: unknown): Promise<SearchResult[]> {
    try {
      // Step 1: Validate input
      const validatedFilter = parseMoodFilter(filter);

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] searchByMood', {
          primary: validatedFilter.primary,
          secondary: validatedFilter.secondary,
          minSimilarity: validatedFilter.minSimilarity,
          weight: validatedFilter.weight,
        });
      }

      // Step 2: Generate query embedding for primary mood
      // NOTE: generateEmbedding() が内部で E5 prefix ("query: ") を自動付与するため、
      // プレフィックスなしのテキストを渡す。
      const queryText = `${validatedFilter.primary} mood`;
      const queryEmbedding = await this.embeddingService.generateEmbedding(
        queryText,
        'query'
      );

      // Step 3: Execute pgvector cosine distance search via raw SQL
      // pgvector cosine distance (<=>) returns distance [0, 2], where:
      // distance = 1 - cosine_similarity for normalized vectors
      // similarity = 1 - distance
      const maxDistance = 1 - validatedFilter.minSimilarity;

      const results = await this.prisma.$queryRaw`
        SELECT
          se.id as pattern_id,
          se.section_pattern_id,
          (1 - (se."moodEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector)) as similarity,
          (se."moodEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector) as distance
        FROM "SectionEmbedding" se
        WHERE
          se."moodEmbedding" IS NOT NULL
          AND (se."moodEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector) <= ${maxDistance}
        ORDER BY similarity DESC
      ` as DBSearchResult[];

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] searchByMood results', {
          count: results.length,
          maxDistance,
        });
      }

      // Step 5: Build result array with metadata
      return results.map((r) => ({
        patternId: r.section_pattern_id || r.pattern_id,
        similarity: r.similarity,
        moodInfo: {
          primary: validatedFilter.primary,
          secondary: validatedFilter.secondary,
        },
      }));
    } catch (error) {
      logger.error('[MoodBrandToneSearchService] searchByMood error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Search patterns by brand tone filter using pgvector cosine similarity
   *
   * Algorithm: Identical to searchByMood but uses brandToneEmbedding
   * 1. Validate input using brandToneFilterSchema
   * 2. Generate query embedding for primary brand tone
   * 3. Execute pgvector cosine distance search
   * 4. Filter by minSimilarity threshold
   * 5. If secondary brand tone provided, include in result metadata
   * 6. Sort by similarity descending
   *
   * @param filter BrandToneFilter with primary/secondary tone and constraints
   * @returns Array of SearchResult with similarity scores [0, 1]
   * @throws ZodError if filter validation fails
   * @performance Target: P95 < 100ms for typical queries
   */
  async searchByBrandTone(filter: unknown): Promise<SearchResult[]> {
    try {
      // Step 1: Validate input
      const validatedFilter = parseBrandToneFilter(filter);

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] searchByBrandTone', {
          primary: validatedFilter.primary,
          secondary: validatedFilter.secondary,
          minSimilarity: validatedFilter.minSimilarity,
          weight: validatedFilter.weight,
        });
      }

      // Step 2: Generate query embedding for primary brand tone
      // NOTE: generateEmbedding() が内部で E5 prefix ("query: ") を自動付与するため、
      // プレフィックスなしのテキストを渡す。
      const queryText = `${validatedFilter.primary} brand tone`;
      const queryEmbedding = await this.embeddingService.generateEmbedding(
        queryText,
        'query'
      );

      // Step 3: Execute pgvector cosine distance search
      const maxDistance = 1 - validatedFilter.minSimilarity;

      const results = await this.prisma.$queryRaw`
        SELECT
          se.id as pattern_id,
          se.section_pattern_id,
          (1 - (se."brandToneEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector)) as similarity,
          (se."brandToneEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector) as distance
        FROM "SectionEmbedding" se
        WHERE
          se."brandToneEmbedding" IS NOT NULL
          AND (se."brandToneEmbedding" ${PGVECTOR_COSINE_DISTANCE} ${queryEmbedding}::vector) <= ${maxDistance}
        ORDER BY similarity DESC
      ` as DBSearchResult[];

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] searchByBrandTone results', {
          count: results.length,
          maxDistance,
        });
      }

      // Step 5: Build result array with metadata
      return results.map((r) => ({
        patternId: r.section_pattern_id || r.pattern_id,
        similarity: r.similarity,
        brandToneInfo: {
          primary: validatedFilter.primary,
          secondary: validatedFilter.secondary,
        },
      }));
    } catch (error) {
      logger.error('[MoodBrandToneSearchService] searchByBrandTone error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Combine mood and brandTone results using Reciprocal Rank Fusion (RRF)
   *
   * Algorithm:
   * 1. Validate RRF weights (sum <= 1.0)
   * 2. Create result map from both result sets
   * 3. For each result:
   *    - If only in mood results: add with RRF score
   *    - If only in brandTone results: add with RRF score
   *    - If in both: combine scores using weighted average
   * 4. Apply RRF formula: final_score = (mood_sim * mood_weight) + (brandTone_sim * brandTone_weight)
   * 5. Sort by final score descending
   * 6. Return results with metadata about source (mood/brandTone/both)
   *
   * RRF Formula:
   * combined_score = (mood_similarity * mood_weight) + (brandTone_similarity * brandTone_weight)
   *
   * @param moodResults SearchResult[] from searchByMood()
   * @param brandToneResults SearchResult[] from searchByBrandTone()
   * @param weights RRFWeights (default: {mood: 0.6, brandTone: 0.4})
   * @returns CombinedSearchResult with merged results sorted by score descending
   * @throws Error if weight validation fails
   * @performance Target: P95 < 50ms for typical result sets (< 100 items each)
   */
  async combineResultsWithRRF(
    moodResults: SearchResult[],
    brandToneResults: SearchResult[],
    weights?: Partial<RRFWeights>
  ): Promise<CombinedSearchResult> {
    try {
      // Step 1: Validate and apply default weights
      const validatedWeights = weights
        ? parseRRFWeights({ ...DEFAULT_RRF_WEIGHTS, ...weights })
        : DEFAULT_RRF_WEIGHTS;

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] combineResultsWithRRF', {
          moodCount: moodResults.length,
          brandToneCount: brandToneResults.length,
          weights: validatedWeights,
        });
      }

      // Step 2: Create maps for deduplication and combination
      type CombinedResult = SearchResult & {
        moodSimilarity?: number;
        brandToneSimilarity?: number;
      };

      const resultMap = new Map<string, CombinedResult>();

      // Add mood results
      for (const result of moodResults) {
        const existing = resultMap.get(result.patternId) || {
          ...result,
          moodSimilarity: result.similarity,
        };
        resultMap.set(result.patternId, existing);
      }

      // Add brand tone results
      for (const result of brandToneResults) {
        if (resultMap.has(result.patternId)) {
          // Pattern exists in both - merge
          const existing = resultMap.get(result.patternId)!;
          existing.brandToneSimilarity = result.similarity;
          // Merge metadata
          if (result.brandToneInfo) {
            existing.brandToneInfo = result.brandToneInfo;
          }
        } else {
          // Pattern only in brandTone results
          resultMap.set(result.patternId, {
            ...result,
            brandToneSimilarity: result.similarity,
          });
        }
      }

      // Step 3-4: Calculate RRF scores and sort
      const combinedResults = Array.from(resultMap.values())
        .map((result) => {
          // Apply RRF formula
          const moodScore = result.moodSimilarity || 0;
          const brandToneScore = result.brandToneSimilarity || 0;

          const rrfScore =
            moodScore * validatedWeights.mood +
            brandToneScore * validatedWeights.brandTone;

          return {
            ...result,
            similarity: rrfScore,
          };
        })
        .sort((a, b) => b.similarity - a.similarity);

      // Step 5: Calculate statistics
      const averageSimilarity =
        combinedResults.length > 0
          ? combinedResults.reduce((sum, r) => sum + r.similarity, 0) /
            combinedResults.length
          : 0;

      // Step 6: Build metadata
      const metadata = {
        moodCount: moodResults.length,
        brandToneCount: brandToneResults.length,
        totalCount: combinedResults.length,
        rrfWeights: validatedWeights,
      };

      if (isDevelopment()) {
        logger.debug('[MoodBrandToneSearchService] combineResultsWithRRF output', {
          totalCount: combinedResults.length,
          averageSimilarity,
          metadata,
        });
      }

      return {
        results: combinedResults,
        averageSimilarity,
        metadata,
      };
    } catch (error) {
      logger.error('[MoodBrandToneSearchService] combineResultsWithRRF error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// =====================================================
// Factory function
// =====================================================

/**
 * Create MoodBrandToneSearchService instance
 *
 * @param prisma Prisma client instance
 * @param embeddingService Embedding service instance
 * @returns MoodBrandToneSearchService
 */
export function createMoodBrandToneSearchService(
  prisma: IPrismaClient,
  embeddingService: IEmbeddingService
): MoodBrandToneSearchService {
  return new MoodBrandToneSearchService(prisma, embeddingService);
}
