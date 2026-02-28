// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QualitySearchService — Quality Evaluate のベクトル検索・ベンチマーク・評価保存
 *
 * service-initializer.ts から抽出（TDA-HS-R1 / M-2 対応）。
 * BackgroundSearchService / NarrativeSearchService と同一のDIパターンに統一。
 *
 * @module services/quality-search.service
 */

import { logger } from '../utils/logger';
import { isDevelopmentEnvironment } from './production-guard';
import type { IQualityEvaluateService } from './quality/quality-evaluate.service.interface';
import type { QualityEvaluateData } from '../tools/quality/schemas';

// =====================================================
// PrismaClient インターフェース（DI用）
// =====================================================

export interface IQualitySearchPrismaClient {
  $queryRawUnsafe: (...args: unknown[]) => Promise<unknown>;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

export interface IQualitySearchEmbeddingService {
  generateEmbedding: (text: string, type: 'query' | 'passage') => Promise<number[]>;
}

// =====================================================
// WebPageService インターフェース（DI用）
// =====================================================

export interface IQualitySearchWebPageService {
  getPageById: (id: string) => Promise<{ id: string; htmlContent: string } | null>;
}

// =====================================================
// Row型定義
// =====================================================

interface SimilarSectionRow {
  id: string;
  section_type: string;
  similarity: number;
  quality_score: number | null;
  web_page_url: string | null;
  web_page_id: string | null;
  web_page_title: string | null;
}

interface SimilarMotionRow {
  id: string;
  motion_type: string;
  similarity: number;
  trigger: string | null;
  duration: number | null;
  source_url: string | null;
}

interface BenchmarkRow {
  id: string;
  section_pattern_id: string | null;
  section_type: string;
  overall_score: number;
  grade: string;
  characteristics: string[];
  axis_scores: string;
  source_url: string;
  preview_url: string | null;
  industry: string | null;
  audience: string | null;
  extracted_at: Date;
}

interface EvaluationInsertRow {
  id: string;
}

// =====================================================
// QualitySearchService
// =====================================================

export interface QualitySearchServiceConfig {
  prisma: IQualitySearchPrismaClient;
  embeddingService: IQualitySearchEmbeddingService;
  webPageService?: IQualitySearchWebPageService | undefined;
}

export function createQualitySearchService(config: QualitySearchServiceConfig): IQualityEvaluateService {
  const { prisma, embeddingService, webPageService } = config;

  const qualityService: IQualityEvaluateService = {
    // -----------------------------------------------
    // getPageById
    // -----------------------------------------------
    getPageById: async (id: string): Promise<{ id: string; htmlContent: string } | null> => {
      if (webPageService) {
        const result = await webPageService.getPageById(id);
        if (!result) return null;
        return {
          id: result.id,
          htmlContent: result.htmlContent ?? '',
        };
      }
      return null;
    },

    // -----------------------------------------------
    // saveEvaluation
    // -----------------------------------------------
    saveEvaluation: async (_evaluation: QualityEvaluateData): Promise<boolean> => {
      // TODO: QualityEvaluationテーブルへの保存を実装
      if (isDevelopmentEnvironment()) {
        logger.debug('[QualitySearchService] saveEvaluation called (not yet implemented)');
      }
      return true;
    },

    // -----------------------------------------------
    // generateEmbedding
    // -----------------------------------------------
    generateEmbedding: async (textRepresentation: string): Promise<number[]> => {
      return embeddingService.generateEmbedding(textRepresentation, 'passage');
    },

    // -----------------------------------------------
    // findSimilarSections
    // -----------------------------------------------
    findSimilarSections: async (embedding, options = {}) => {
      const { sectionType, limit = 10, minSimilarity = 0.7, minQualityScore = 0 } = options;

      try {
        const embeddingStr = `[${embedding.join(',')}]`;

        // Dynamic parameter index management ($1=embedding, $2=minSimilarity, $3=minQualityScore, $4=limit)
        let paramIndex = 5;
        const optionalConditions: string[] = [];
        const optionalParams: unknown[] = [];

        if (sectionType) {
          optionalConditions.push(`AND sp.section_type = $${paramIndex}`);
          optionalParams.push(sectionType);
          paramIndex++;
        }

        const results = (await prisma.$queryRawUnsafe(
          `
          SELECT
            sp.id,
            sp.section_type,
            1 - (se.text_embedding <=> $1::vector) AS similarity,
            COALESCE((sp.quality_score->>'overall')::numeric, 0) AS quality_score,
            wp.url AS web_page_url,
            wp.id AS web_page_id,
            wp.title AS web_page_title
          FROM section_patterns sp
          JOIN section_embeddings se ON se.section_pattern_id = sp.id
          LEFT JOIN web_pages wp ON wp.id = sp.web_page_id
          WHERE 1 - (se.text_embedding <=> $1::vector) >= $2
            ${optionalConditions.join('\n            ')}
            AND COALESCE((sp.quality_score->>'overall')::numeric, 0) >= $3
          ORDER BY similarity DESC
          LIMIT $4
          `,
          embeddingStr,
          minSimilarity,
          minQualityScore,
          limit,
          ...optionalParams
        )) as SimilarSectionRow[];

        return results.map((row) => {
          const section: {
            id: string;
            sectionType: string;
            similarity: number;
            qualityScore?: number;
            sourceUrl?: string;
            webPageId?: string;
            webPageUrl?: string;
            webPageTitle?: string;
          } = {
            id: row.id,
            sectionType: row.section_type,
            similarity: row.similarity,
          };
          if (row.quality_score !== null) section.qualityScore = row.quality_score;
          if (row.web_page_url !== null) section.sourceUrl = row.web_page_url;
          if (row.web_page_id !== null) section.webPageId = row.web_page_id;
          if (row.web_page_url !== null) section.webPageUrl = row.web_page_url;
          if (row.web_page_title !== null) section.webPageTitle = row.web_page_title;
          return section;
        });
      } catch (error) {
        if (isDevelopmentEnvironment()) {
          logger.error('[QualitySearchService] findSimilarSections error', { error });
        }
        return [];
      }
    },

    // -----------------------------------------------
    // findSimilarMotions
    // -----------------------------------------------
    findSimilarMotions: async (embedding, options = {}) => {
      const { motionType, limit = 10, minSimilarity = 0.7, trigger } = options;

      try {
        const embeddingStr = `[${embedding.join(',')}]`;

        // Dynamic parameter index management ($1=embedding, $2=minSimilarity, $3=limit)
        let paramIndex = 4;
        const optionalConditions: string[] = [];
        const optionalParams: unknown[] = [];

        if (motionType) {
          optionalConditions.push(`AND mp.type = $${paramIndex}`);
          optionalParams.push(motionType);
          paramIndex++;
        }

        if (trigger) {
          optionalConditions.push(`AND mp.trigger = $${paramIndex}`);
          optionalParams.push(trigger);
          paramIndex++;
        }

        const results = (await prisma.$queryRawUnsafe(
          `
          SELECT
            mp.id,
            mp.type AS motion_type,
            1 - (me.embedding <=> $1::vector) AS similarity,
            mp.trigger,
            mp.duration,
            wp.url AS source_url
          FROM motion_patterns mp
          JOIN motion_embeddings me ON me.motion_pattern_id = mp.id
          LEFT JOIN web_pages wp ON wp.id = mp.web_page_id
          WHERE 1 - (me.embedding <=> $1::vector) >= $2
            ${optionalConditions.join('\n            ')}
          ORDER BY similarity DESC
          LIMIT $3
          `,
          embeddingStr,
          minSimilarity,
          limit,
          ...optionalParams
        )) as SimilarMotionRow[];

        return results.map((row) => {
          const motion: {
            id: string;
            motionType: string;
            similarity: number;
            trigger?: string;
            duration?: number;
            sourceUrl?: string;
          } = {
            id: row.id,
            motionType: row.motion_type,
            similarity: row.similarity,
          };
          if (row.trigger !== null) motion.trigger = row.trigger;
          if (row.duration !== null) motion.duration = row.duration;
          if (row.source_url !== null) motion.sourceUrl = row.source_url;
          return motion;
        });
      } catch (error) {
        if (isDevelopmentEnvironment()) {
          logger.error('[QualitySearchService] findSimilarMotions error', { error });
        }
        return [];
      }
    },

    // -----------------------------------------------
    // getHighQualityBenchmarks
    // -----------------------------------------------
    getHighQualityBenchmarks: async (sectionType, limit = 5) => {
      try {
        const results = (await prisma.$queryRawUnsafe(
          `
          SELECT
            qb.id,
            qb.section_pattern_id,
            qb.section_type,
            qb.overall_score,
            qb.grade,
            qb.characteristics,
            qb.axis_scores::text,
            qb.source_url,
            wp.screenshot AS preview_url,
            NULL AS industry,
            NULL AS audience,
            qb.extracted_at
          FROM quality_benchmarks qb
          LEFT JOIN web_pages wp ON wp.id = qb.web_page_id
          WHERE qb.section_type = $1
            AND qb.overall_score >= 85
          ORDER BY qb.overall_score DESC
          LIMIT $2
          `,
          sectionType,
          limit
        )) as BenchmarkRow[];

        return results.map((row) => {
          const benchmark: {
            id: string;
            sectionPatternId?: string;
            sectionType: string;
            overallScore: number;
            grade: 'A' | 'B';
            characteristics: string[];
            axisScores: {
              originality: number;
              craftsmanship: number;
              contextuality: number;
            };
            sourceUrl: string;
            previewUrl?: string;
            industry?: string;
            audience?: string;
            extractedAt: Date;
          } = {
            id: row.id,
            sectionType: row.section_type,
            overallScore: row.overall_score,
            grade: row.grade as 'A' | 'B',
            characteristics: row.characteristics ?? [],
            axisScores: JSON.parse(row.axis_scores) as {
              originality: number;
              craftsmanship: number;
              contextuality: number;
            },
            sourceUrl: row.source_url,
            extractedAt: row.extracted_at,
          };
          if (row.section_pattern_id !== null) benchmark.sectionPatternId = row.section_pattern_id;
          if (row.preview_url !== null) benchmark.previewUrl = row.preview_url;
          if (row.industry !== null) benchmark.industry = row.industry;
          if (row.audience !== null) benchmark.audience = row.audience;
          return benchmark;
        });
      } catch (error) {
        if (isDevelopmentEnvironment()) {
          logger.error('[QualitySearchService] getHighQualityBenchmarks error', { error });
        }
        return [];
      }
    },

    // -----------------------------------------------
    // saveEvaluationWithPatterns
    // -----------------------------------------------
    saveEvaluationWithPatterns: async (evaluation, patternRefs) => {
      try {
        const results = (await prisma.$queryRawUnsafe(
          `
          INSERT INTO quality_evaluations (
            overall_score,
            grade,
            originality_score,
            craftsmanship_score,
            contextuality_score,
            referenced_patterns,
            evaluated_at,
            created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, NOW()
          )
          RETURNING id
          `,
          evaluation.overall,
          evaluation.grade,
          evaluation.originality.score,
          evaluation.craftsmanship.score,
          evaluation.contextuality.score,
          JSON.stringify({
            similar_sections: patternRefs.similarSections,
            similar_motions: patternRefs.similarMotions,
            benchmarks_used: patternRefs.benchmarksUsed,
          }),
          new Date(evaluation.evaluatedAt)
        )) as EvaluationInsertRow[];

        return results[0]?.id ?? '';
      } catch (error) {
        if (isDevelopmentEnvironment()) {
          logger.error('[QualitySearchService] saveEvaluationWithPatterns error', { error });
        }
        throw error;
      }
    },
  };

  return qualityService;
}
