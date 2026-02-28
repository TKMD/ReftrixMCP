// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationSearchService
 * JSアニメーションパターンのベクトル類似検索サービス
 *
 * 機能:
 * - JSAnimationPattern + JSAnimationEmbedding テーブルからベクトル類似検索
 * - ライブラリタイプ、アニメーションタイプでフィルタリング
 * - 類似度しきい値によるフィルタリング
 * - ページネーション対応
 *
 * @module services/motion/js-animation-search.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import {
  executeHybridSearch,
  buildFulltextConditions,
  buildFulltextRankExpression,
  toRankedItems,
} from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import type {
  JSAnimationLibraryType,
  JSAnimationType,
} from '../../tools/motion/schemas';

// =====================================================
// UUIDv7 検証ユーティリティ
// =====================================================

/**
 * UUIDv7形式のバリデーション正規表現
 * 形式: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
 */
const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUIDv7形式の文字列かどうかを検証
 * @param value 検証する文字列
 * @returns UUIDv7形式の場合true
 */
function isValidUUIDv7(value: string): boolean {
  return UUID_V7_REGEX.test(value);
}

/**
 * 安全な整数値検証
 * @param value 検証する値
 * @param min 最小値
 * @param max 最大値
 * @returns 検証済みの整数値
 * @throws Error 検証失敗時
 */
function validateSafeInteger(value: number, min: number, max: number, paramName: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${paramName} must be an integer, got: ${value}`);
  }
  if (value < min || value > max) {
    throw new Error(`${paramName} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

// =====================================================
// 型定義
// =====================================================

/**
 * JSアニメーション検索パラメータ
 * Note: exactOptionalPropertyTypes対応でundefinedを明示的に許容
 */
export interface JSAnimationSearchParams {
  /** クエリEmbedding（768次元） */
  queryEmbedding: number[];
  /** 全文検索用クエリテキスト（searchHybridで使用） */
  queryText?: string | undefined;
  /** 最小類似度（0-1） */
  minSimilarity?: number | undefined;
  /** 取得上限 */
  limit?: number | undefined;
  /** オフセット */
  offset?: number | undefined;
  /** ライブラリタイプでフィルタリング */
  libraryType?: JSAnimationLibraryType | undefined;
  /** アニメーションタイプでフィルタリング */
  animationType?: JSAnimationType | undefined;
}

/**
 * JSアニメーション検索結果アイテム
 */
export interface JSAnimationSearchResultItem {
  /** パターンID */
  id: string;
  /** WebページID（null可） */
  webPageId: string | null;
  /** ライブラリタイプ */
  libraryType: JSAnimationLibraryType;
  /** ライブラリバージョン */
  libraryVersion: string | null;
  /** アニメーション名 */
  name: string;
  /** アニメーションタイプ */
  animationType: JSAnimationType | null;
  /** ターゲットセレクタ */
  targetSelector: string | null;
  /** Duration（ミリ秒） */
  durationMs: number | null;
  /** Easing関数 */
  easing: string | null;
  /** キーフレームデータ */
  keyframes: unknown | null;
  /** プロパティデータ */
  properties: unknown | null;
  /** 類似度スコア（0-1） */
  similarity: number;
  /** 作成日時 */
  createdAt: Date;
}

/**
 * JSアニメーション検索結果
 */
export interface JSAnimationSearchResult {
  /** 検索結果 */
  results: JSAnimationSearchResultItem[];
  /** 総件数（フィルタリング後） */
  total: number;
  /** 検索パラメータ情報 */
  searchInfo: {
    minSimilarity: number;
    limit: number;
    offset: number;
    libraryTypeFilter?: string;
    animationTypeFilter?: string;
  };
}

/**
 * PrismaClientインターフェース（DI用）
 */
export interface IPrismaClient {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * JSAnimationSearchServiceオプション
 */
export interface JSAnimationSearchServiceOptions {
  prisma: IPrismaClient;
}

// =====================================================
// デフォルト値
// =====================================================

const DEFAULT_MIN_SIMILARITY = 0.5;
const DEFAULT_LIMIT = 10;
const DEFAULT_OFFSET = 0;

// =====================================================
// JSAnimationSearchService クラス
// =====================================================

/**
 * JSアニメーション検索サービス
 *
 * pgvector HNSW インデックスを使用した高速ベクトル類似検索を提供します。
 *
 * @example
 * ```typescript
 * const service = new JSAnimationSearchService({ prisma });
 * const results = await service.search({
 *   queryEmbedding: [...], // 768次元
 *   minSimilarity: 0.7,
 *   limit: 10,
 *   libraryType: 'gsap',
 * });
 * ```
 */
export class JSAnimationSearchService {
  private readonly prisma: IPrismaClient;

  constructor(options: JSAnimationSearchServiceOptions) {
    this.prisma = options.prisma;
  }

  /**
   * JSアニメーションパターンをベクトル類似検索
   *
   * @param params 検索パラメータ
   * @returns 検索結果
   */
  async search(params: JSAnimationSearchParams): Promise<JSAnimationSearchResult> {
    const startTime = Date.now();

    const {
      queryEmbedding,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      limit = DEFAULT_LIMIT,
      offset = DEFAULT_OFFSET,
      libraryType,
      animationType,
    } = params;

    if (isDevelopment()) {
      logger.info('[JSAnimationSearch] Starting search', {
        embeddingDimensions: queryEmbedding.length,
        minSimilarity,
        limit,
        offset,
        libraryType,
        animationType,
      });
    }

    // Embedding次元数の検証
    if (queryEmbedding.length !== 768) {
      throw new Error(
        `Invalid embedding dimensions: expected 768, got ${queryEmbedding.length}`
      );
    }

    // SEC: limit/offset の安全な整数値検証（SQLインジェクション対策）
    const validatedLimit = validateSafeInteger(limit, 1, 100, 'limit');
    const validatedOffset = validateSafeInteger(offset, 0, 100000, 'offset');

    // ベクトル文字列を構築
    const vectorString = `[${queryEmbedding.join(',')}]`;

    // 動的フィルター条件を構築
    const filterConditions: string[] = [];
    const filterValues: unknown[] = [];
    let paramIndex = 5; // $1=vector, $2=minSimilarity, $3=limit, $4=offset

    if (libraryType) {
      filterConditions.push(`jap.library_type = $${paramIndex}::text`);
      filterValues.push(libraryType);
      paramIndex++;
    }

    if (animationType) {
      filterConditions.push(`jap.animation_type = $${paramIndex}::text`);
      filterValues.push(animationType);
      paramIndex++;
    }

    const whereClause = filterConditions.length > 0
      ? `AND ${filterConditions.join(' AND ')}`
      : '';

    // メインクエリ（SEC: すべての値をパラメータバインドで渡す）
    const query = `
      SELECT
        jap.id,
        jap.web_page_id as "webPageId",
        jap.library_type as "libraryType",
        jap.library_version as "libraryVersion",
        jap.name,
        jap.animation_type as "animationType",
        jap.target_selector as "targetSelector",
        jap.duration_ms as "durationMs",
        jap.easing,
        jap.keyframes,
        jap.properties,
        jap.created_at as "createdAt",
        1 - (jae.embedding <=> $1::vector) as similarity
      FROM js_animation_patterns jap
      INNER JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
      WHERE 1 - (jae.embedding <=> $1::vector) >= $2
        ${whereClause}
      ORDER BY similarity DESC
      LIMIT $3
      OFFSET $4
    `;

    // カウントクエリ
    const countQuery = `
      SELECT COUNT(*)::int as count
      FROM js_animation_patterns jap
      INNER JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
      WHERE 1 - (jae.embedding <=> $1::vector) >= $2
        ${whereClause}
    `;

    try {
      // クエリ実行（SEC: すべてのパラメータをバインド変数として渡す）
      const [results, countResult] = await Promise.all([
        this.prisma.$queryRawUnsafe<JSAnimationSearchResultItem[]>(
          query,
          vectorString,
          minSimilarity,
          validatedLimit,
          validatedOffset,
          ...filterValues
        ),
        this.prisma.$queryRawUnsafe<[{ count: number }]>(
          countQuery,
          vectorString,
          minSimilarity,
          ...filterValues
        ),
      ]);

      const total = countResult[0]?.count ?? 0;
      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[JSAnimationSearch] Search completed', {
          resultsCount: results.length,
          total,
          processingTimeMs,
        });
      }

      const searchInfo: {
        minSimilarity: number;
        limit: number;
        offset: number;
        libraryTypeFilter?: string;
        animationTypeFilter?: string;
      } = {
        minSimilarity,
        limit,
        offset,
      };
      if (libraryType !== undefined) {
        searchInfo.libraryTypeFilter = libraryType;
      }
      if (animationType !== undefined) {
        searchInfo.animationTypeFilter = animationType;
      }

      return {
        results,
        total,
        searchInfo,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationSearch] Search failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * 類似JSアニメーションパターンを検索（パターンIDベース）
   *
   * @param patternId 基準パターンID（UUIDv7形式必須）
   * @param limit 取得上限（1-50）
   * @param minSimilarity 最小類似度（0-1）
   * @returns 類似パターンの配列
   * @throws Error UUIDv7形式でない場合、または不正なパラメータの場合
   */
  async findSimilar(
    patternId: string,
    limit: number = 5,
    minSimilarity: number = 0.7
  ): Promise<JSAnimationSearchResultItem[]> {
    // SEC: UUIDv7形式の検証（SQLインジェクション対策）
    if (!isValidUUIDv7(patternId)) {
      throw new Error(
        `Invalid patternId: must be a valid UUIDv7 format, got: ${patternId}`
      );
    }

    // SEC: limit/minSimilarityの検証
    const validatedLimit = validateSafeInteger(limit, 1, 50, 'limit');
    if (typeof minSimilarity !== 'number' || !Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      throw new Error(`minSimilarity must be between 0 and 1, got: ${minSimilarity}`);
    }

    if (isDevelopment()) {
      logger.info('[JSAnimationSearch] Finding similar patterns', {
        patternId,
        limit: validatedLimit,
        minSimilarity,
      });
    }

    const query = `
      SELECT
        jap.id,
        jap.web_page_id as "webPageId",
        jap.library_type as "libraryType",
        jap.library_version as "libraryVersion",
        jap.name,
        jap.animation_type as "animationType",
        jap.target_selector as "targetSelector",
        jap.duration_ms as "durationMs",
        jap.easing,
        jap.keyframes,
        jap.properties,
        jap.created_at as "createdAt",
        1 - (jae2.embedding <=> jae1.embedding) as similarity
      FROM js_animation_embeddings jae1
      CROSS JOIN LATERAL (
        SELECT jae.embedding, jae.js_animation_pattern_id
        FROM js_animation_embeddings jae
        WHERE jae.js_animation_pattern_id != $1
          AND 1 - (jae.embedding <=> jae1.embedding) >= $2
        ORDER BY jae.embedding <=> jae1.embedding
        LIMIT $3
      ) jae2
      INNER JOIN js_animation_patterns jap ON jap.id = jae2.js_animation_pattern_id
      WHERE jae1.js_animation_pattern_id = $1
      ORDER BY similarity DESC
    `;

    try {
      // SEC: 検証済みパラメータをバインド変数として渡す
      const results = await this.prisma.$queryRawUnsafe<JSAnimationSearchResultItem[]>(
        query,
        patternId,
        minSimilarity,
        validatedLimit
      );

      if (isDevelopment()) {
        logger.info('[JSAnimationSearch] findSimilar completed', {
          resultsCount: results.length,
        });
      }

      return results;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationSearch] findSimilar failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * JSアニメーションパターンをハイブリッド検索（ベクトル + 全文検索 → RRF）
   *
   * tsvector search_vector カラム（GENERATED ALWAYS AS STORED）を使用した全文検索と
   * pgvector HNSW ベクトル検索を RRF（60% vector + 40% full-text）でマージする。
   * 全文検索が失敗した場合はベクトル検索のみにフォールバック。
   *
   * @param params 検索パラメータ（queryText が必須）
   * @returns 検索結果
   */
  async searchHybrid(params: JSAnimationSearchParams): Promise<JSAnimationSearchResult> {
    const startTime = Date.now();

    const {
      queryEmbedding,
      queryText,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      limit = DEFAULT_LIMIT,
      offset = DEFAULT_OFFSET,
      libraryType,
      animationType,
    } = params;

    if (!queryText) {
      // queryText がない場合はベクトル検索にフォールバック
      return this.search(params);
    }

    if (isDevelopment()) {
      logger.info('[JSAnimationSearch] Starting hybrid search', {
        embeddingDimensions: queryEmbedding.length,
        queryText: queryText.substring(0, 50),
        minSimilarity,
        limit,
        libraryType,
        animationType,
      });
    }

    // Embedding次元数の検証
    if (queryEmbedding.length !== 768) {
      throw new Error(
        `Invalid embedding dimensions: expected 768, got ${queryEmbedding.length}`
      );
    }

    const validatedLimit = validateSafeInteger(limit, 1, 100, 'limit');
    const validatedOffset = validateSafeInteger(offset, 0, 100000, 'offset');
    const vectorString = `[${queryEmbedding.join(',')}]`;
    const fetchLimit = Math.min(validatedLimit * 3, 150);

    // 動的フィルター条件を構築（ベクトル検索・全文検索で共有）
    const filterConditions: string[] = [];
    const filterValues: unknown[] = [];
    let paramIndex = 1; // 動的開始

    if (libraryType) {
      filterConditions.push(`jap.library_type = $${paramIndex}::text`);
      filterValues.push(libraryType);
      paramIndex++;
    }

    if (animationType) {
      filterConditions.push(`jap.animation_type = $${paramIndex}::text`);
      filterValues.push(animationType);
      paramIndex++;
    }

    const filterWhereClause = filterConditions.length > 0
      ? `WHERE ${filterConditions.join(' AND ')}`
      : '';

    const filterAndClause = filterConditions.length > 0
      ? `AND ${filterConditions.join(' AND ')}`
      : '';

    try {
      // ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vecIdx = paramIndex;
        const simIdx = paramIndex + 1;
        const limIdx = paramIndex + 2;

        const vecSql = `
          SELECT
            jap.id,
            jap.web_page_id as "webPageId",
            jap.library_type as "libraryType",
            jap.library_version as "libraryVersion",
            jap.name,
            jap.animation_type as "animationType",
            jap.target_selector as "targetSelector",
            jap.duration_ms as "durationMs",
            jap.easing,
            jap.keyframes,
            jap.properties,
            jap.created_at as "createdAt",
            1 - (jae.embedding <=> $${vecIdx}::vector) as similarity
          FROM js_animation_patterns jap
          INNER JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
          WHERE 1 - (jae.embedding <=> $${vecIdx}::vector) >= $${simIdx}
            ${filterAndClause}
          ORDER BY similarity DESC
          LIMIT $${limIdx}
        `;

        const rows = await this.prisma.$queryRawUnsafe<JSAnimationSearchResultItem[]>(
          vecSql,
          ...filterValues,
          vectorString,
          minSimilarity,
          fetchLimit
        );

        return toRankedItems(rows.map((r) => ({
          id: r.id,
          webPageId: r.webPageId,
          libraryType: r.libraryType,
          name: r.name,
          animationType: r.animationType,
          targetSelector: r.targetSelector,
          durationMs: r.durationMs,
          easing: r.easing,
          keyframes: r.keyframes,
          properties: r.properties,
          similarity: r.similarity,
        })));
      };

      // 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        try {
          const ftQueryIdx = paramIndex;
          const ftLimitIdx = paramIndex + 1;

          const ftCond = buildFulltextConditions('jae.search_vector', ftQueryIdx);
          const ftRank = buildFulltextRankExpression('jae.search_vector', ftQueryIdx);

          const ftWhereBase = filterWhereClause
            ? `${filterWhereClause} AND ${ftCond}`
            : `WHERE ${ftCond}`;

          const ftSql = `
            SELECT
              jap.id,
              jap.web_page_id as "webPageId",
              jap.library_type as "libraryType",
              jap.library_version as "libraryVersion",
              jap.name,
              jap.animation_type as "animationType",
              jap.target_selector as "targetSelector",
              jap.duration_ms as "durationMs",
              jap.easing,
              jap.keyframes,
              jap.properties,
              jap.created_at as "createdAt",
              ${ftRank} as similarity
            FROM js_animation_patterns jap
            INNER JOIN js_animation_embeddings jae ON jae.js_animation_pattern_id = jap.id
            ${ftWhereBase}
            ORDER BY similarity DESC
            LIMIT $${ftLimitIdx}
          `;

          const rows = await this.prisma.$queryRawUnsafe<JSAnimationSearchResultItem[]>(
            ftSql,
            ...filterValues,
            queryText,
            fetchLimit
          );

          return toRankedItems(rows.map((r) => ({
            id: r.id,
            webPageId: r.webPageId,
            libraryType: r.libraryType,
            name: r.name,
            animationType: r.animationType,
            targetSelector: r.targetSelector,
            durationMs: r.durationMs,
            easing: r.easing,
            keyframes: r.keyframes,
            properties: r.properties,
            similarity: r.similarity,
          })));
        } catch (ftError) {
          if (isDevelopment()) {
            logger.warn('[JSAnimationSearch] Full-text search failed, using vector only', {
              error: ftError instanceof Error ? ftError.message : 'Unknown error',
            });
          }
          return [];
        }
      };

      // RRFマージ
      const hybridResults = await executeHybridSearch(vectorSearchFn, fulltextSearchFn);

      const results: JSAnimationSearchResultItem[] = hybridResults
        .slice(validatedOffset, validatedOffset + validatedLimit)
        .map((hr) => {
          const data = hr.data as Record<string, unknown>;
          return {
            id: String(data.id ?? hr.id),
            webPageId: (data.webPageId as string | null) ?? null,
            libraryType: String(data.libraryType ?? '') as JSAnimationLibraryType,
            libraryVersion: (data.libraryVersion as string | null) ?? null,
            name: String(data.name ?? ''),
            animationType: (data.animationType as JSAnimationType | null) ?? null,
            targetSelector: (data.targetSelector as string | null) ?? null,
            durationMs: (data.durationMs as number | null) ?? null,
            easing: (data.easing as string | null) ?? null,
            keyframes: (data.keyframes as unknown) ?? null,
            properties: (data.properties as unknown) ?? null,
            similarity: hr.similarity,
            createdAt: new Date(),
          };
        });

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[JSAnimationSearch] Hybrid search completed', {
          resultsCount: results.length,
          processingTimeMs,
        });
      }

      const searchInfo: JSAnimationSearchResult['searchInfo'] = {
        minSimilarity,
        limit: validatedLimit,
        offset: validatedOffset,
      };
      if (libraryType !== undefined) {
        searchInfo.libraryTypeFilter = libraryType;
      }
      if (animationType !== undefined) {
        searchInfo.animationTypeFilter = animationType;
      }

      return {
        results,
        total: results.length,
        searchInfo,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationSearch] Hybrid search failed, falling back to vector search', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // フォールバック: ベクトル検索のみ
      return this.search(params);
    }
  }
}

// =====================================================
// ファクトリー関数
// =====================================================

let searchServiceInstance: JSAnimationSearchService | null = null;

/**
 * JSAnimationSearchServiceのシングルトンインスタンスを取得
 */
export function getJSAnimationSearchService(
  prisma: IPrismaClient
): JSAnimationSearchService {
  if (!searchServiceInstance) {
    searchServiceInstance = new JSAnimationSearchService({ prisma });
  }
  return searchServiceInstance;
}

/**
 * サービスインスタンスをリセット（テスト用）
 */
export function resetJSAnimationSearchService(): void {
  searchServiceInstance = null;
}
