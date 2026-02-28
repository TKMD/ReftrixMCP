// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BenchmarkService
 * 高品質パターンのベンチマーク管理サービス
 *
 * 機能:
 * - HNSW ベクトル検索による類似ベンチマーク検索
 * - セクションタイプ別ベンチマーク取得
 * - 業界別平均スコア取得（マテリアライズドビュー）
 * - パーセンタイル計算
 * - 新規ベンチマーク登録
 *
 * @module services/quality/benchmark.service
 */

import type { PrismaClient } from '@prisma/client';
import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// Types
// =====================================================

/**
 * ベンチマークマッチ結果
 * HNSW検索で見つかった類似ベンチマーク
 */
export interface BenchmarkMatch {
  /** ベンチマークID (UUID) */
  benchmarkId: string;
  /** セクションタイプ */
  sectionType: string;
  /** 総合スコア (85-100) */
  overallScore: number;
  /** グレード (A or B) */
  grade: string;
  /** コサイン類似度 (0-1) */
  similarity: number;
  /** ソースURL */
  sourceUrl: string;
  /** プレビューURL (スクリーンショット) */
  previewUrl?: string;
}

/**
 * 業界別平均スコア
 * マテリアライズドビュー mv_industry_quality_averages から取得
 */
export interface IndustryAverages {
  /** 業界名 */
  industry: string;
  /** 評価件数 */
  evaluationCount: number;
  /** 平均総合スコア */
  avgOverallScore: number;
  /** 平均独自性スコア */
  avgOriginality?: number;
  /** 平均技巧スコア */
  avgCraftsmanship?: number;
  /** 平均文脈適合性スコア */
  avgContextuality?: number;
}

/**
 * ベンチマーク登録用メタデータ
 */
export interface BenchmarkMetadata {
  /** 総合スコア (85-100) */
  overallScore: number;
  /** グレード (A or B) */
  grade: string;
  /** 特徴量リスト */
  characteristics: string[];
  /** 軸別スコア */
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  /** 業界 */
  industry?: string;
  /** ターゲットオーディエンス */
  audience?: string;
}

/**
 * 類似ベンチマーク検索オプション
 */
export interface FindSimilarBenchmarksOptions {
  /** セクションタイプでフィルタリング */
  sectionType?: string;
  /** 最小類似度しきい値 (デフォルト: 0.7) */
  minSimilarity?: number;
  /** 最大取得件数 (デフォルト: 5) */
  limit?: number;
}

// =====================================================
// IBenchmarkService Interface
// =====================================================

/**
 * ベンチマークサービスインターフェース
 */
export interface IBenchmarkService {
  /**
   * HNSW ベクトル検索で類似ベンチマークを検索
   *
   * @param embedding - 検索用768次元ベクトル
   * @param options - 検索オプション
   * @returns ベンチマークマッチ配列（類似度降順）
   */
  findSimilarBenchmarks(
    embedding: number[],
    options?: FindSimilarBenchmarksOptions
  ): Promise<BenchmarkMatch[]>;

  /**
   * セクションタイプ別にベンチマークを取得
   *
   * @param sectionType - セクションタイプ (hero, feature, cta, etc.)
   * @param limit - 最大取得件数 (デフォルト: 5)
   * @returns ベンチマーク配列（スコア降順）
   */
  getBenchmarksByType(
    sectionType: string,
    limit?: number
  ): Promise<BenchmarkMatch[]>;

  /**
   * 業界別平均スコアを取得
   *
   * @param industry - 業界名
   * @returns 業界平均スコア情報またはnull
   */
  getIndustryAverages(industry: string): Promise<IndustryAverages | null>;

  /**
   * スコアのパーセンタイルを計算
   *
   * @param score - 対象スコア (0-100)
   * @param sectionType - セクションタイプ（オプション）
   * @returns パーセンタイル (0-100)
   */
  calculatePercentile(score: number, sectionType?: string): Promise<number>;

  /**
   * 新規ベンチマークを登録
   *
   * @param sectionPatternId - セクションパターンID (UUID)
   * @param metadata - ベンチマークメタデータ
   * @returns 登録されたベンチマークID (UUID)
   */
  registerBenchmark(
    sectionPatternId: string,
    metadata: BenchmarkMetadata
  ): Promise<string>;
}

// =====================================================
// BenchmarkService Implementation
// =====================================================

/**
 * ベンチマークサービス実装
 *
 * PostgreSQL + pgvector のHNSWインデックスを使用した
 * 高品質パターンのベンチマーク管理
 */
export class BenchmarkService implements IBenchmarkService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * HNSW ベクトル検索で類似ベンチマークを検索
   *
   * SQL関数 find_similar_benchmarks() を使用:
   * - HNSWインデックスによる高速検索
   * - コサイン類似度でソート
   */
  async findSimilarBenchmarks(
    embedding: number[],
    options: FindSimilarBenchmarksOptions = {}
  ): Promise<BenchmarkMatch[]> {
    const {
      sectionType,
      minSimilarity = 0.7,
      limit = 5,
    } = options;

    if (isDevelopment()) {
      logger.debug('[BenchmarkService] findSimilarBenchmarks', {
        embeddingDim: embedding.length,
        sectionType,
        minSimilarity,
        limit,
      });
    }

    try {
      // Embedding配列を文字列に変換（PostgreSQL vector型用）
      const embeddingStr = `[${embedding.join(',')}]`;

      // HNSWベクトル検索クエリ
      // QualityBenchmarkテーブルが存在しない場合は空配列を返す
      const results = (await this.prisma.$queryRawUnsafe(
        `
        SELECT
          qb.id,
          qb.section_type,
          qb.overall_score,
          qb.grade,
          qb.source_url,
          wp.screenshot AS preview_url,
          1 - (qb.embedding <=> $1::vector) AS similarity
        FROM quality_benchmarks qb
        LEFT JOIN web_pages wp ON wp.id = qb.web_page_id
        WHERE qb.embedding IS NOT NULL
          ${sectionType ? `AND qb.section_type = $4` : ''}
          AND 1 - (qb.embedding <=> $1::vector) >= $2
        ORDER BY similarity DESC
        LIMIT $3
        `,
        embeddingStr,
        minSimilarity,
        limit,
        ...(sectionType ? [sectionType] : [])
      )) as Array<{
        id: string;
        section_type: string;
        overall_score: number;
        grade: string;
        source_url: string;
        preview_url: string | null;
        similarity: number;
      }>;

      if (isDevelopment()) {
        logger.debug('[BenchmarkService] findSimilarBenchmarks result', {
          count: results.length,
        });
      }

      return results.map((row): BenchmarkMatch => {
        const match: BenchmarkMatch = {
          benchmarkId: row.id,
          sectionType: row.section_type,
          overallScore: row.overall_score,
          grade: row.grade,
          similarity: row.similarity,
          sourceUrl: row.source_url,
        };
        if (row.preview_url !== null) {
          match.previewUrl = row.preview_url;
        }
        return match;
      });
    } catch (error) {
      // テーブルが存在しない場合は空配列を返す（マイグレーション前対応）
      if (
        error instanceof Error &&
        error.message.includes('relation "quality_benchmarks" does not exist')
      ) {
        if (isDevelopment()) {
          logger.warn('[BenchmarkService] quality_benchmarks table not found, returning empty array');
        }
        return [];
      }
      throw error;
    }
  }

  /**
   * セクションタイプ別にベンチマークを取得
   *
   * スコア降順でソートして返す
   */
  async getBenchmarksByType(
    sectionType: string,
    limit: number = 5
  ): Promise<BenchmarkMatch[]> {
    if (isDevelopment()) {
      logger.debug('[BenchmarkService] getBenchmarksByType', {
        sectionType,
        limit,
      });
    }

    try {
      const results = (await this.prisma.$queryRawUnsafe(
        `
        SELECT
          qb.id,
          qb.section_type,
          qb.overall_score,
          qb.grade,
          qb.source_url,
          wp.screenshot AS preview_url
        FROM quality_benchmarks qb
        LEFT JOIN web_pages wp ON wp.id = qb.web_page_id
        WHERE qb.section_type = $1
        ORDER BY qb.overall_score DESC
        LIMIT $2
        `,
        sectionType,
        limit
      )) as Array<{
        id: string;
        section_type: string;
        overall_score: number;
        grade: string;
        source_url: string;
        preview_url: string | null;
      }>;

      if (isDevelopment()) {
        logger.debug('[BenchmarkService] getBenchmarksByType result', {
          count: results.length,
        });
      }

      return results.map((row): BenchmarkMatch => {
        const match: BenchmarkMatch = {
          benchmarkId: row.id,
          sectionType: row.section_type,
          overallScore: row.overall_score,
          grade: row.grade,
          similarity: 1.0, // 同一タイプなので類似度は1.0とする
          sourceUrl: row.source_url,
        };
        if (row.preview_url !== null) {
          match.previewUrl = row.preview_url;
        }
        return match;
      });
    } catch (error) {
      // テーブルが存在しない場合は空配列を返す
      if (
        error instanceof Error &&
        error.message.includes('relation "quality_benchmarks" does not exist')
      ) {
        if (isDevelopment()) {
          logger.warn('[BenchmarkService] quality_benchmarks table not found, returning empty array');
        }
        return [];
      }
      throw error;
    }
  }

  /**
   * 業界別平均スコアを取得
   *
   * マテリアライズドビュー mv_industry_quality_averages を使用
   */
  async getIndustryAverages(industry: string): Promise<IndustryAverages | null> {
    if (isDevelopment()) {
      logger.debug('[BenchmarkService] getIndustryAverages', { industry });
    }

    try {
      const results = (await this.prisma.$queryRawUnsafe(
        `
        SELECT
          industry,
          evaluation_count,
          avg_overall_score,
          avg_originality,
          avg_craftsmanship,
          avg_contextuality
        FROM mv_industry_quality_averages
        WHERE industry = $1
        LIMIT 1
        `,
        industry
      )) as Array<{
        industry: string;
        evaluation_count: number;
        avg_overall_score: number;
        avg_originality: number | null;
        avg_craftsmanship: number | null;
        avg_contextuality: number | null;
      }>;

      if (results.length === 0) {
        if (isDevelopment()) {
          logger.debug('[BenchmarkService] getIndustryAverages - not found', { industry });
        }
        return null;
      }

      const row = results[0];
      if (!row) {
        return null;
      }

      const averages: IndustryAverages = {
        industry: row.industry,
        evaluationCount: row.evaluation_count,
        avgOverallScore: row.avg_overall_score,
      };
      if (row.avg_originality !== null) {
        averages.avgOriginality = row.avg_originality;
      }
      if (row.avg_craftsmanship !== null) {
        averages.avgCraftsmanship = row.avg_craftsmanship;
      }
      if (row.avg_contextuality !== null) {
        averages.avgContextuality = row.avg_contextuality;
      }
      return averages;
    } catch (error) {
      // マテリアライズドビューが存在しない場合はnullを返す
      if (
        error instanceof Error &&
        error.message.includes('relation "mv_industry_quality_averages" does not exist')
      ) {
        if (isDevelopment()) {
          logger.warn('[BenchmarkService] mv_industry_quality_averages view not found');
        }
        return null;
      }
      throw error;
    }
  }

  /**
   * スコアのパーセンタイルを計算
   *
   * SQL関数 calculate_quality_percentile() を使用
   */
  async calculatePercentile(score: number, sectionType?: string): Promise<number> {
    if (isDevelopment()) {
      logger.debug('[BenchmarkService] calculatePercentile', { score, sectionType });
    }

    try {
      // パーセンタイル計算クエリ
      // QualityEvaluationテーブルから計算
      const results = (await this.prisma.$queryRawUnsafe(
        `
        SELECT
          COALESCE(
            (SELECT
              ROUND(
                (COUNT(*) FILTER (WHERE overall_score <= $1)::NUMERIC / NULLIF(COUNT(*), 0)) * 100,
                2
              )
            FROM quality_evaluations
            ${sectionType ? `WHERE section_type = $2` : ''}
            ),
            50.0
          ) AS percentile
        `,
        score,
        ...(sectionType ? [sectionType] : [])
      )) as Array<{ percentile: number }>;

      const percentile = results[0]?.percentile ?? 50;

      if (isDevelopment()) {
        logger.debug('[BenchmarkService] calculatePercentile result', { percentile });
      }

      return percentile;
    } catch (error) {
      // テーブルが存在しない場合は50（中央値）を返す
      if (
        error instanceof Error &&
        error.message.includes('relation "quality_evaluations" does not exist')
      ) {
        if (isDevelopment()) {
          logger.warn('[BenchmarkService] quality_evaluations table not found, returning 50');
        }
        return 50;
      }
      throw error;
    }
  }

  /**
   * 新規ベンチマークを登録
   *
   * SectionPatternから高品質パターンをベンチマークとして登録
   */
  async registerBenchmark(
    sectionPatternId: string,
    metadata: BenchmarkMetadata
  ): Promise<string> {
    if (isDevelopment()) {
      logger.debug('[BenchmarkService] registerBenchmark', {
        sectionPatternId,
        overallScore: metadata.overallScore,
        grade: metadata.grade,
      });
    }

    // 品質スコアの検証（85以上のみ登録可能）
    if (metadata.overallScore < 85) {
      throw new Error(
        `Benchmark requires overallScore >= 85, got ${metadata.overallScore}`
      );
    }

    try {
      // SectionPatternの情報を取得
      const sectionPatternResults = (await this.prisma.$queryRawUnsafe(
        `
        SELECT
          sp.id,
          sp.section_type,
          sp.web_page_id,
          se.text_embedding::text AS embedding
        FROM section_patterns sp
        LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
        WHERE sp.id = $1
        LIMIT 1
        `,
        sectionPatternId
      )) as Array<{
        id: string;
        section_type: string;
        web_page_id: string;
        embedding: string | null;
      }>;

      if (sectionPatternResults.length === 0) {
        throw new Error(`SectionPattern not found: ${sectionPatternId}`);
      }

      const sp = sectionPatternResults[0];
      if (!sp) {
        throw new Error(`SectionPattern not found: ${sectionPatternId}`);
      }

      // WebPageのURL取得
      const webPageResults = (await this.prisma.$queryRawUnsafe(
        `SELECT url FROM web_pages WHERE id = $1 LIMIT 1`,
        sp.web_page_id
      )) as Array<{ url: string }>;

      const sourceUrl = webPageResults[0]?.url ?? 'unknown';

      // ベンチマーク登録（embeddingの有無で別クエリ）
      let result: Array<{ id: string }>;
      if (sp.embedding) {
        result = (await this.prisma.$queryRawUnsafe(
          `
          INSERT INTO quality_benchmarks (
            section_pattern_id,
            web_page_id,
            section_type,
            overall_score,
            grade,
            characteristics,
            axis_scores,
            source_url,
            embedding,
            extracted_at,
            created_at
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::vector,
            NOW(),
            NOW()
          )
          RETURNING id
          `,
          sectionPatternId,
          sp.web_page_id,
          sp.section_type,
          metadata.overallScore,
          metadata.grade,
          metadata.characteristics,
          JSON.stringify(metadata.axisScores),
          sourceUrl,
          sp.embedding
        )) as Array<{ id: string }>;
      } else {
        result = (await this.prisma.$queryRawUnsafe(
          `
          INSERT INTO quality_benchmarks (
            section_pattern_id,
            web_page_id,
            section_type,
            overall_score,
            grade,
            characteristics,
            axis_scores,
            source_url,
            embedding,
            extracted_at,
            created_at
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NULL,
            NOW(),
            NOW()
          )
          RETURNING id
          `,
          sectionPatternId,
          sp.web_page_id,
          sp.section_type,
          metadata.overallScore,
          metadata.grade,
          metadata.characteristics,
          JSON.stringify(metadata.axisScores),
          sourceUrl
        )) as Array<{ id: string }>;
      }

      const benchmarkId = result[0]?.id;

      if (!benchmarkId) {
        throw new Error('Failed to create benchmark');
      }

      if (isDevelopment()) {
        logger.info('[BenchmarkService] registerBenchmark success', {
          benchmarkId,
          sectionType: sp.section_type,
          overallScore: metadata.overallScore,
        });
      }

      return benchmarkId;
    } catch (error) {
      // テーブルが存在しない場合の詳細エラー
      if (
        error instanceof Error &&
        error.message.includes('relation "quality_benchmarks" does not exist')
      ) {
        throw new Error(
          'quality_benchmarks table does not exist. Please run migrations.'
        );
      }
      throw error;
    }
  }
}

// =====================================================
// Factory Function
// =====================================================

/**
 * BenchmarkServiceファクトリ関数
 *
 * @param prisma - PrismaClient インスタンス
 * @returns BenchmarkService インスタンス
 */
export function createBenchmarkService(prisma: PrismaClient): IBenchmarkService {
  return new BenchmarkService(prisma);
}
