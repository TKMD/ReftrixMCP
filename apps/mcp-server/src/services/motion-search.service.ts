// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionSearchService
 * motion.search ツール用のサービス実装
 *
 * 機能:
 * - モーションパターンのベクトル検索
 * - テキストクエリ/サンプルパターンによる類似検索
 * - フィルタリング（タイプ、duration範囲、トリガー）
 *
 * @module services/motion-search.service
 */

import { isDevelopment, logger } from '../utils/logger';
import { executeHybridSearch, buildFulltextConditions, buildFulltextRankExpression, toRankedItems } from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import type {
  IMotionSearchService,
  MotionSearchParams,
  MotionSearchResult,
} from '../tools/motion/search.tool';
import type {
  MotionSearchResultItem,
  MotionSearchQueryInfo,
  MotionPattern,
  MotionSearchFilters,
  SamplePattern,
  // JSAnimationFilters は将来のJS Animation検索統合で使用予定
} from '../tools/motion/schemas';
import { assertNonProductionFactory } from './production-guard';
import {
  validateEmbeddingVector,
  EmbeddingValidationError,
} from './embedding-validation.service';
import type {
  JSAnimationSearchService,
  JSAnimationSearchResultItem,
  JSAnimationSearchParams,
} from './motion/js-animation-search.service';

// =====================================================
// 定数
// =====================================================

// NOTE: これらの定数は将来のEmbedding最適化で使用予定
// /** デフォルトのモデル名 */
// const DEFAULT_MODEL_NAME = 'multilingual-e5-base';
// /** デフォルトのEmbedding次元数 */
// const DEFAULT_EMBEDDING_DIMENSIONS = 768;

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
 * PrismaClientインターフェース（部分的）
 */
export interface IPrismaClient {
  motionPattern: {
    findMany: (args?: {
      where?: Record<string, unknown>;
      include?: Record<string, boolean>;
      orderBy?: Record<string, string>;
      take?: number;
      skip?: number;
    }) => Promise<MotionPatternRecord[]>;
    count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
  };
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * DBから取得するMotionPatternレコード
 */
export interface MotionPatternRecord {
  id: string;
  name: string;
  category: string;
  triggerType: string;
  animation: unknown;
  properties: unknown;
  sourceUrl: string | null;
  webPageId: string | null;
  embedding?: {
    embedding: number[] | null;
    textRepresentation: string | null;
  };
}

/**
 * ベクトル検索結果
 */
export interface VectorSearchResult {
  id: string;
  name: string;
  category: string;
  trigger_type: string;
  animation: unknown;
  properties: unknown;
  source_url: string | null;
  web_page_id: string | null;
  similarity: number;
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;
// v0.1.0: JSAnimation検索統合
let jsAnimationSearchServiceFactory: (() => JSAnimationSearchService) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (embeddingServiceFactory !== null) {
    assertNonProductionFactory('motionSearchEmbeddingService');
  }
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setPrismaClientFactory(factory: () => IPrismaClient): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (prismaClientFactory !== null) {
    assertNonProductionFactory('motionSearchPrismaClient');
  }
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetPrismaClientFactory(): void {
  prismaClientFactory = null;
}

/**
 * JSAnimationSearchServiceファクトリを設定（v0.1.0）
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setJSAnimationSearchServiceFactory(factory: () => JSAnimationSearchService): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (jsAnimationSearchServiceFactory !== null) {
    assertNonProductionFactory('jsAnimationSearchService');
  }
  jsAnimationSearchServiceFactory = factory;
}

/**
 * JSAnimationSearchServiceファクトリをリセット（v0.1.0）
 */
export function resetJSAnimationSearchServiceFactory(): void {
  jsAnimationSearchServiceFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * サンプルパターンからテキスト表現を生成
 * @param pattern サンプルパターン
 * @returns テキスト表現
 */
export function samplePatternToText(pattern: SamplePattern): string {
  const parts: string[] = [];

  if (pattern.type) {
    parts.push(`${pattern.type} animation`);
  }

  if (pattern.duration !== undefined) {
    parts.push(`duration ${pattern.duration}ms`);
  }

  if (pattern.easing) {
    parts.push(`easing ${pattern.easing}`);
  }

  if (pattern.properties && pattern.properties.length > 0) {
    parts.push(`properties: ${pattern.properties.join(', ')}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'motion animation';
}

/**
 * パターン名からCSSセレクタを生成
 * @param name パターン名
 * @returns CSSセレクタ（クラス名形式）
 */
export function generateSelectorFromName(name: string): string {
  // パターン名をkebab-caseに変換してクラス名として使用
  const kebabName = name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return `.${kebabName}`;
}

/**
 * DBレコードをMotionPatternに変換
 * @param record DBレコードまたはベクトル検索結果
 * @returns MotionPatternオブジェクト
 */
export function recordToMotionPattern(record: MotionPatternRecord | VectorSearchResult): MotionPattern {
  // VectorSearchResult用の型ガード
  const isVectorResult = 'trigger_type' in record;
  const triggerType = isVectorResult ? record.trigger_type : record.triggerType;
  // sourceUrlはWebページのURLであり、selectorではないため使用しない
  // const sourceUrl = isVectorResult ? record.source_url : record.sourceUrl;
  // webPageId は将来のソース情報拡張で使用予定
  // const webPageId = isVectorResult ? record.web_page_id : record.webPageId;

  const animation = typeof record.animation === 'object' && record.animation !== null
    ? record.animation as Record<string, unknown>
    : {};

  const properties = Array.isArray(record.properties)
    ? record.properties
    : [];

  // selectorを決定: 名前からセレクタを生成（フォールバック）
  // 例: "fadeIn" -> ".fade-in", "scrollAnimation" -> ".scroll-animation"
  const selector = record.name ? generateSelectorFromName(record.name) : undefined;

  return {
    id: record.id,
    type: 'css_animation', // デフォルト値
    category: mapCategory(record.category),
    name: record.name,
    trigger: mapTrigger(triggerType),
    animation: {
      duration: typeof animation.duration === 'number' ? animation.duration : undefined,
      delay: typeof animation.delay === 'number' ? animation.delay : undefined,
      easing: animation.easing ? {
        type: typeof animation.easing === 'string'
          ? mapEasingType(animation.easing)
          : 'ease',
      } : undefined,
      iterations: animation.iterations as number | 'infinite' | undefined,
      direction: animation.direction as 'normal' | 'reverse' | 'alternate' | 'alternate-reverse' | undefined,
      fillMode: animation.fill_mode as 'none' | 'forwards' | 'backwards' | 'both' | undefined,
    },
    properties: properties.map((p: unknown) => {
      if (typeof p === 'object' && p !== null) {
        const prop = p as Record<string, unknown>;
        return {
          property: typeof prop.property === 'string' ? prop.property : String(prop.property || ''),
          from: prop.from as string | number | undefined,
          to: prop.to as string | number | undefined,
        };
      }
      return { property: String(p) };
    }),
    selector,
  };
}

/**
 * カテゴリをマッピング
 * @param category DB上のカテゴリ文字列
 * @returns MotionPatternのカテゴリ
 */
export function mapCategory(category: string): MotionPattern['category'] {
  const mapping: Record<string, MotionPattern['category']> = {
    scroll_trigger: 'scroll_trigger',
    hover_effect: 'hover_effect',
    page_transition: 'page_transition',
    loading: 'loading_state',
    loading_state: 'loading_state',
    micro_interaction: 'micro_interaction',
    attention_grabber: 'attention_grabber',
    navigation: 'navigation',
    feedback: 'feedback',
  };
  return mapping[category] || 'unknown';
}

/**
 * トリガーをマッピング
 * @param trigger DB上のトリガー文字列
 * @returns MotionPatternのトリガー
 */
export function mapTrigger(trigger: string): MotionPattern['trigger'] {
  const mapping: Record<string, MotionPattern['trigger']> = {
    scroll: 'scroll',
    hover: 'hover',
    click: 'click',
    focus: 'focus',
    load: 'load',
    intersection: 'intersection',
    time: 'time',
    state_change: 'state_change',
  };
  return mapping[trigger] || 'unknown';
}

/**
 * イージングタイプをマッピング
 * @param easing イージング文字列
 * @returns 正規化されたイージングタイプ
 */
export function mapEasingType(easing: string): 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier' | 'spring' | 'steps' | 'unknown' {
  const mapping: Record<string, 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier' | 'spring' | 'steps' | 'unknown'> = {
    linear: 'linear',
    ease: 'ease',
    'ease-in': 'ease-in',
    'ease-out': 'ease-out',
    'ease-in-out': 'ease-in-out',
  };
  if (easing.startsWith('cubic-bezier')) return 'cubic-bezier';
  if (easing.startsWith('steps')) return 'steps';
  return mapping[easing] || 'unknown';
}

/**
 * フィルター条件をWHERE句に変換
 * @param filters 検索フィルター
 * @returns WHERE句とパラメータ配列
 */
export function buildWhereClause(filters?: MotionSearchFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters?.type) {
    // motion.searchのtypeをDBのcategoryにマッピング
    const categoryMapping: Record<string, string> = {
      animation: 'css_animation',
      transition: 'page_transition',
      transform: 'micro_interaction',
      scroll: 'scroll_trigger',
      hover: 'hover_effect',
      keyframe: 'css_animation',
    };
    const category = categoryMapping[filters.type] || filters.type;
    conditions.push(`mp.category = $${paramIndex}`);
    params.push(category);
    paramIndex++;
  }

  if (filters?.trigger) {
    conditions.push(`mp.trigger_type = $${paramIndex}`);
    params.push(filters.trigger);
    paramIndex++;
  }

  if (filters?.minDuration !== undefined) {
    conditions.push(`(mp.animation->>'duration')::float >= $${paramIndex}`);
    params.push(filters.minDuration);
    paramIndex++;
  }

  if (filters?.maxDuration !== undefined) {
    conditions.push(`(mp.animation->>'duration')::float <= $${paramIndex}`);
    params.push(filters.maxDuration);
    paramIndex++;
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// =====================================================
// MotionSearchService
// =====================================================

/**
 * MotionSearchServiceクラス
 */
export class MotionSearchService implements IMotionSearchService {
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;
  private jsAnimationSearchService: JSAnimationSearchService | null = null;

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

    throw new Error('EmbeddingService not initialized');
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

    throw new Error('PrismaClient not initialized');
  }

  /**
   * JSAnimationSearchServiceを取得（v0.1.0）
   * @returns JSAnimationSearchService or null if not available
   */
  private getJSAnimationSearchService(): JSAnimationSearchService | null {
    if (this.jsAnimationSearchService) {
      return this.jsAnimationSearchService;
    }

    if (jsAnimationSearchServiceFactory) {
      this.jsAnimationSearchService = jsAnimationSearchServiceFactory();
      return this.jsAnimationSearchService;
    }

    return null; // Graceful degradation - JSAnimation search is optional
  }

  /**
   * CSSモーションのベクトル検索SQL・パラメータを構築
   *
   * search() と searchHybrid() の共通ロジックを一元化。
   * CCN削減のため抽出（TDA-Medium-2対応）。
   */
  private buildCSSVectorSearchQuery(
    clause: string,
    whereParams: unknown[],
    vectorString: string,
    similarityThreshold: number,
    limit: number
  ): { sql: string; params: unknown[] } {
    const vectorParamIndex = whereParams.length + 1;
    const similarityParamIndex = whereParams.length + 2;
    const limitParamIndex = whereParams.length + 3;

    const whereClauseWithSimilarity = clause
      ? `${clause} AND 1 - (me.embedding <=> $${vectorParamIndex}::vector) >= $${similarityParamIndex}`
      : `WHERE 1 - (me.embedding <=> $${vectorParamIndex}::vector) >= $${similarityParamIndex}`;

    const sql = `
      SELECT
        mp.id, mp.name, mp.category, mp.trigger_type,
        mp.animation, mp.properties, mp.source_url, mp.web_page_id,
        1 - (me.embedding <=> $${vectorParamIndex}::vector) as similarity
      FROM motion_patterns mp
      LEFT JOIN motion_embeddings me ON me.motion_pattern_id = mp.id
      ${whereClauseWithSimilarity}
      ORDER BY similarity DESC
      LIMIT $${limitParamIndex}
    `;

    return {
      sql,
      params: [...whereParams, vectorString, similarityThreshold, limit],
    };
  }

  /**
   * CSSモーションの全文検索SQL・パラメータを構築
   *
   * searchHybrid() の全文検索ロジックを抽出（TDA-Medium-2対応）。
   */
  private buildCSSFulltextSearchQuery(
    clause: string,
    whereParams: unknown[],
    queryText: string,
    limit: number
  ): { sql: string; params: unknown[] } {
    const ftParamIndex = whereParams.length + 1;
    const ftLimitParamIndex = whereParams.length + 2;

    const ftConditions = buildFulltextConditions('me.search_vector', ftParamIndex);
    const ftRank = buildFulltextRankExpression('me.search_vector', ftParamIndex);
    const ftWhereBase = clause
      ? `${clause} AND ${ftConditions}`
      : `WHERE ${ftConditions}`;

    const sql = `
      SELECT
        mp.id, mp.name, mp.category, mp.trigger_type,
        mp.animation, mp.properties, mp.source_url, mp.web_page_id,
        ${ftRank} as similarity
      FROM motion_patterns mp
      LEFT JOIN motion_embeddings me ON me.motion_pattern_id = mp.id
      ${ftWhereBase}
      ORDER BY similarity DESC
      LIMIT $${ftLimitParamIndex}
    `;

    return {
      sql,
      params: [...whereParams, queryText, limit],
    };
  }

  /**
   * モーションパターンを検索
   */
  async search(params: MotionSearchParams): Promise<MotionSearchResult> {
    const startTime = Date.now();

    // v0.1.0: include_js_animations はデフォルトtrue
    const includeJsAnimations = params.include_js_animations !== false;

    if (isDevelopment()) {
      logger.info('[MotionSearchService] Starting search', {
        hasQuery: !!params.query,
        hasSamplePattern: !!params.samplePattern,
        hasFilters: !!params.filters,
        limit: params.limit,
        minSimilarity: params.minSimilarity,
        includeJsAnimations,
        hasJsAnimationFilters: !!params.js_animation_filters,
      });
    }

    try {
      // クエリテキストを準備
      // NOTE: generateEmbedding() が内部で E5 prefix ("query: " / "passage: ") を
      // 自動付与するため、ここではプレフィックスなしのテキストを渡す。
      let queryText: string;
      if (params.query) {
        queryText = params.query;
      } else if (params.samplePattern) {
        queryText = samplePatternToText(params.samplePattern);
      } else {
        throw new Error('query or samplePattern is required');
      }

      // Embedding生成を試みる
      let queryEmbedding: number[] | null = null;
      try {
        const embeddingService = this.getEmbeddingService();
        queryEmbedding = await embeddingService.generateEmbedding(queryText, 'query');

        // Embedding ベクトルの検証（Phase6-SEC-2対応）
        // 検索はEmbeddingなしでは不可能なため、検証失敗時はエラーをスロー
        const validationResult = validateEmbeddingVector(queryEmbedding);
        if (!validationResult.isValid) {
          const error = validationResult.error;
          const errorMessage = error?.index !== undefined
            ? `${error.message} at index ${error.index}`
            : error?.message ?? 'Unknown validation error';
          throw new EmbeddingValidationError(
            error?.code ?? 'INVALID_VECTOR',
            errorMessage,
            error?.index
          );
        }
      } catch (embeddingError) {
        // EmbeddingValidationError は再スロー（検索不可能）
        if (embeddingError instanceof EmbeddingValidationError) {
          throw embeddingError;
        }
        if (isDevelopment()) {
          logger.warn('[MotionSearchService] Embedding generation failed, falling back to text search', {
            error: embeddingError instanceof Error ? embeddingError.message : 'Unknown error',
          });
        }
        // Embedding生成に失敗した場合は空の結果を返す
        // （テキスト検索フォールバックは将来実装）
      }

      // PrismaClient取得を試みる
      let prisma: IPrismaClient;
      try {
        prisma = this.getPrismaClient();
      } catch {
        // PrismaClientが利用できない場合は空の結果を返す
        if (isDevelopment()) {
          logger.warn('[MotionSearchService] PrismaClient not available, returning empty results');
        }
        return {
          results: [],
          total: 0,
          query: {
            text: params.query || samplePatternToText(params.samplePattern!),
          },
        };
      }

      // ベクトル検索を実行
      let results: MotionSearchResultItem[] = [];

      if (queryEmbedding) {
        const { clause, params: whereParams } = buildWhereClause(params.filters);
        const vectorString = `[${queryEmbedding.join(',')}]`;
        const { sql: query, params: queryParams } = this.buildCSSVectorSearchQuery(
          clause, whereParams, vectorString, params.minSimilarity, params.limit
        );

        try {
          const searchResults = await prisma.$queryRawUnsafe<VectorSearchResult[]>(
            query,
            ...queryParams
          );

          results = searchResults.map((r) => ({
            pattern: recordToMotionPattern(r),
            similarity: r.similarity,
            source: r.web_page_id
              ? { pageId: r.web_page_id, url: r.source_url || undefined }
              : undefined,
          }));
        } catch (dbError) {
          if (isDevelopment()) {
            logger.warn('[MotionSearchService] Vector search failed, returning empty results', {
              error: dbError instanceof Error ? dbError.message : 'Unknown error',
            });
          }
          // データベースエラー時は空の結果を返す
        }
      }

      // v0.1.0: JSAnimation検索を実行
      let jsAnimationResults: JSAnimationSearchResultItem[] = [];
      if (includeJsAnimations && queryEmbedding) {
        const jsSearchService = this.getJSAnimationSearchService();
        if (jsSearchService) {
          try {
            // フィルターパラメータを構築
            const jsSearchParams: JSAnimationSearchParams = {
              queryEmbedding,
              minSimilarity: params.minSimilarity,
              limit: params.limit,
              libraryType: params.js_animation_filters?.libraryType,
              animationType: params.js_animation_filters?.animationType,
            };
            const jsSearchResult = await jsSearchService.search(jsSearchParams);
            jsAnimationResults = jsSearchResult.results;

            if (isDevelopment()) {
              logger.info('[MotionSearchService] JSAnimation search completed', {
                resultsCount: jsSearchResult.results.length,
                total: jsSearchResult.total,
              });
            }
          } catch (jsError) {
            if (isDevelopment()) {
              logger.warn('[MotionSearchService] JSAnimation search failed, continuing without JS results', {
                error: jsError instanceof Error ? jsError.message : 'Unknown error',
              });
            }
            // JSAnimation検索失敗時は空の結果で継続（Graceful Degradation）
          }
        } else if (isDevelopment()) {
          logger.debug('[MotionSearchService] JSAnimationSearchService not available, skipping JS search');
        }
      }

      // v0.1.0: 結果をマージして類似度順でソート
      const mergedResults = this.mergeAndSortResults(results, jsAnimationResults, params.limit);

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[MotionSearchService] Search completed', {
          cssResultsCount: results.length,
          jsResultsCount: jsAnimationResults.length,
          mergedResultsCount: mergedResults.length,
          processingTimeMs,
        });
      }

      const queryInfo: MotionSearchQueryInfo = {
        text: params.query || samplePatternToText(params.samplePattern!),
      };

      return {
        results: mergedResults,
        total: mergedResults.length,
        query: queryInfo,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[MotionSearchService] Search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw error;
    }
  }

  /**
   * テキストからEmbeddingを取得
   */
  async getEmbedding(text: string): Promise<number[]> {
    const embeddingService = this.getEmbeddingService();
    // NOTE: generateEmbedding() が内部で E5 prefix を自動付与するため、
    // プレフィックスなしのテキストを渡す。
    const embedding = await embeddingService.generateEmbedding(text, 'query');

    // Embedding ベクトルの検証（Phase6-SEC-2対応）
    const validationResult = validateEmbeddingVector(embedding);
    if (!validationResult.isValid) {
      const error = validationResult.error;
      const errorMessage = error?.index !== undefined
        ? `${error.message} at index ${error.index}`
        : error?.message ?? 'Unknown validation error';
      throw new EmbeddingValidationError(
        error?.code ?? 'INVALID_VECTOR',
        errorMessage,
        error?.index
      );
    }

    return embedding;
  }

  /**
   * CSSモーションパターンとJSアニメーション結果をマージしてソート（v0.1.0）
   *
   * @param cssResults CSSモーションパターン検索結果
   * @param jsResults JSアニメーション検索結果
   * @param limit 結果制限数
   * @returns マージ・ソート済みの検索結果
   */
  private mergeAndSortResults(
    cssResults: MotionSearchResultItem[],
    jsResults: JSAnimationSearchResultItem[],
    limit: number
  ): MotionSearchResultItem[] {
    // JSアニメーション結果をMotionSearchResultItem形式に変換
    const convertedJsResults: MotionSearchResultItem[] = jsResults.map((jsItem) => ({
      pattern: this.jsAnimationToMotionPattern(jsItem),
      similarity: jsItem.similarity,
      source: jsItem.webPageId ? { pageId: jsItem.webPageId } : undefined,
      jsAnimationInfo: {
        libraryType: jsItem.libraryType,
        animationType: jsItem.animationType ?? undefined,
        libraryVersion: jsItem.libraryVersion ?? undefined,
      },
    }));

    // 両方の結果をマージ
    const merged = [...cssResults, ...convertedJsResults];

    // 類似度で降順ソート
    merged.sort((a, b) => b.similarity - a.similarity);

    // limit制限を適用
    return merged.slice(0, limit);
  }

  /**
   * JSAnimationSearchResultItemをMotionPatternに変換（v0.1.0）
   */
  private jsAnimationToMotionPattern(jsItem: JSAnimationSearchResultItem): MotionPattern {
    // JSアニメーションタイプをCSSタイプにマッピング
    const typeMapping: Record<string, MotionPattern['type']> = {
      tween: 'css_animation',
      timeline: 'css_animation',
      spring: 'css_transition',
      physics: 'css_animation',
      keyframe: 'keyframes',
      morphing: 'css_animation',
      path: 'css_animation',
      scroll_driven: 'css_animation',
      gesture: 'css_transition',
    };

    // ライブラリタイプをカテゴリにマッピング
    const categoryMapping: Record<string, MotionPattern['category']> = {
      gsap: 'micro_interaction',
      framer_motion: 'page_transition',
      anime_js: 'micro_interaction',
      three_js: 'scroll_trigger',
      lottie: 'loading_state',
      web_animations_api: 'micro_interaction',
      unknown: 'unknown',
    };

    const animationType = jsItem.animationType ?? 'tween';
    const durationMs = jsItem.durationMs ?? undefined;
    const easing = jsItem.easing ?? undefined;

    // keyframesからpropertiesを抽出
    const properties: Array<{
      property: string;
      from?: string | number;
      to?: string | number;
    }> = [];

    if (jsItem.keyframes && Array.isArray(jsItem.keyframes)) {
      const keyframes = jsItem.keyframes as Array<Record<string, unknown>>;
      if (keyframes.length >= 2) {
        const firstKf = keyframes[0];
        const lastKf = keyframes[keyframes.length - 1];

        // 最初と最後のキーフレームからプロパティを抽出
        const allKeys = new Set([
          ...Object.keys(firstKf ?? {}),
          ...Object.keys(lastKf ?? {}),
        ]);

        for (const key of allKeys) {
          if (['offset', 'easing', 'composite', 'computedOffset'].includes(key)) {
            continue;
          }
          const fromValue = firstKf?.[key];
          const toValue = lastKf?.[key];
          const propEntry: { property: string; from?: string | number; to?: string | number } = {
            property: key,
          };
          if (typeof fromValue === 'string' || typeof fromValue === 'number') {
            propEntry.from = fromValue;
          }
          if (typeof toValue === 'string' || typeof toValue === 'number') {
            propEntry.to = toValue;
          }
          properties.push(propEntry);
        }
      }
    }

    // propertiesフィールドからも抽出
    if (jsItem.properties && Array.isArray(jsItem.properties)) {
      for (const prop of jsItem.properties as Array<Record<string, unknown>>) {
        if (typeof prop === 'object' && prop !== null && 'property' in prop) {
          const propEntry: { property: string; from?: string | number; to?: string | number } = {
            property: String(prop.property),
          };
          const fromValue = prop.from;
          const toValue = prop.to;
          if (typeof fromValue === 'string' || typeof fromValue === 'number') {
            propEntry.from = fromValue;
          }
          if (typeof toValue === 'string' || typeof toValue === 'number') {
            propEntry.to = toValue;
          }
          properties.push(propEntry);
        }
      }
    }

    // selectorフィールドを設定（v0.1.0）
    // 優先順位: targetSelector > nameから生成
    const selector =
      jsItem.targetSelector || generateSelectorFromName(jsItem.name);

    return {
      id: jsItem.id,
      type: typeMapping[animationType] || 'css_animation',
      category: categoryMapping[jsItem.libraryType] || 'unknown',
      name: jsItem.name,
      selector, // JSアニメーションのターゲットセレクタ
      trigger: 'load', // JSアニメーションはデフォルトでload
      animation: {
        duration: durationMs,
        easing: easing ? { type: mapEasingType(easing) } : undefined,
      },
      properties: properties.length > 0 ? properties : [],
    };
  }

  /**
   * ハイブリッド検索（ベクトル検索 + 全文検索 → RRF マージ）
   *
   * 既存の search() と同じインターフェースで、内部的に全文検索を追加し
   * Reciprocal Rank Fusion で結果をマージする。
   * 全文検索が失敗した場合はベクトル検索のみにフォールバック。
   */
  async searchHybrid(params: MotionSearchParams): Promise<MotionSearchResult> {
    const startTime = Date.now();
    const includeJsAnimations = params.include_js_animations !== false;

    if (isDevelopment()) {
      logger.info('[MotionSearchService] Starting hybrid search', {
        hasQuery: !!params.query,
        hasSamplePattern: !!params.samplePattern,
      });
    }

    try {
      // クエリテキストを準備
      // NOTE: generateEmbedding() が内部で E5 prefix を自動付与するため、
      // プレフィックスなしのテキストを渡す。
      let queryText: string;
      if (params.query) {
        queryText = params.query;
      } else if (params.samplePattern) {
        queryText = samplePatternToText(params.samplePattern);
      } else {
        throw new Error('query or samplePattern is required');
      }

      // Embedding 生成
      let queryEmbedding: number[] | null = null;
      try {
        const embeddingService = this.getEmbeddingService();
        queryEmbedding = await embeddingService.generateEmbedding(queryText, 'query');

        const validationResult = validateEmbeddingVector(queryEmbedding);
        if (!validationResult.isValid) {
          const error = validationResult.error;
          const errorMessage = error?.index !== undefined
            ? `${error.message} at index ${error.index}`
            : error?.message ?? 'Unknown validation error';
          throw new EmbeddingValidationError(
            error?.code ?? 'INVALID_VECTOR',
            errorMessage,
            error?.index
          );
        }
      } catch (embeddingError) {
        if (embeddingError instanceof EmbeddingValidationError) {
          throw embeddingError;
        }
        if (isDevelopment()) {
          logger.warn('[MotionSearchService] Embedding generation failed in hybrid search', {
            error: embeddingError instanceof Error ? embeddingError.message : 'Unknown error',
          });
        }
      }

      let prisma: IPrismaClient;
      try {
        prisma = this.getPrismaClient();
      } catch {
        if (isDevelopment()) {
          logger.warn('[MotionSearchService] PrismaClient not available');
        }
        return {
          results: [],
          total: 0,
          query: { text: queryText },
        };
      }

      // CSS モーション検索: ハイブリッド（ベクトル + 全文）
      let results: MotionSearchResultItem[] = [];

      if (queryEmbedding) {
        const { clause, params: whereParams } = buildWhereClause(params.filters);
        const vectorString = `[${queryEmbedding.join(',')}]`;
        const fetchLimit = Math.min(params.limit * 3, 150);

        // ベクトル検索関数（共通メソッドで SQL 構築）
        const vectorSearchFn = async (): Promise<RankedItem[]> => {
          const { sql, params: queryParams } = this.buildCSSVectorSearchQuery(
            clause, whereParams, vectorString, params.minSimilarity, fetchLimit
          );
          const rows = await prisma.$queryRawUnsafe<VectorSearchResult[]>(sql, ...queryParams);
          return toRankedItems(rows);
        };

        // 全文検索関数（共通メソッドで SQL 構築）
        const fulltextSearchFn = async (): Promise<RankedItem[]> => {
          try {
            const { sql, params: queryParams } = this.buildCSSFulltextSearchQuery(
              clause, whereParams, queryText, fetchLimit
            );
            const rows = await prisma.$queryRawUnsafe<VectorSearchResult[]>(sql, ...queryParams);
            return toRankedItems(rows);
          } catch (ftError) {
            if (isDevelopment()) {
              logger.warn('[MotionSearchService] Full-text search failed, using vector only', {
                error: ftError instanceof Error ? ftError.message : 'Unknown error',
              });
            }
            return [];
          }
        };

        try {
          const hybridResults = await executeHybridSearch(vectorSearchFn, fulltextSearchFn);

          results = hybridResults.slice(0, params.limit).map((hr) => {
            const data = hr.data as unknown as VectorSearchResult;
            return {
              pattern: recordToMotionPattern(data),
              similarity: hr.similarity,
              source: data.web_page_id
                ? { pageId: data.web_page_id, url: data.source_url || undefined }
                : undefined,
            };
          });
        } catch (dbError) {
          if (isDevelopment()) {
            logger.warn('[MotionSearchService] Hybrid search failed, returning empty results', {
              error: dbError instanceof Error ? dbError.message : 'Unknown error',
            });
          }
        }
      }

      // JSAnimation 検索: ハイブリッドモードで実行（tsvector search_vector 使用）
      let jsAnimationResults: JSAnimationSearchResultItem[] = [];
      if (includeJsAnimations && queryEmbedding) {
        const jsSearchService = this.getJSAnimationSearchService();
        if (jsSearchService) {
          try {
            const jsSearchParams: JSAnimationSearchParams = {
              queryEmbedding,
              queryText: queryText, // searchHybrid で全文検索に使用
              minSimilarity: params.minSimilarity,
              limit: params.limit,
              libraryType: params.js_animation_filters?.libraryType,
              animationType: params.js_animation_filters?.animationType,
            };
            const jsSearchResult = await jsSearchService.searchHybrid(jsSearchParams);
            jsAnimationResults = jsSearchResult.results;
          } catch (jsError) {
            if (isDevelopment()) {
              logger.warn('[MotionSearchService] JSAnimation hybrid search failed', {
                error: jsError instanceof Error ? jsError.message : 'Unknown error',
              });
            }
          }
        }
      }

      const mergedResults = this.mergeAndSortResults(results, jsAnimationResults, params.limit);
      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[MotionSearchService] Hybrid search completed', {
          cssResultsCount: results.length,
          jsResultsCount: jsAnimationResults.length,
          mergedResultsCount: mergedResults.length,
          processingTimeMs,
        });
      }

      return {
        results: mergedResults,
        total: mergedResults.length,
        query: { text: queryText },
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[MotionSearchService] Hybrid search error, falling back to standard search', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // フォールバック: 標準検索
      return this.search(params);
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let motionSearchServiceInstance: MotionSearchService | null = null;

/**
 * MotionSearchServiceインスタンスを取得
 */
export function getMotionSearchService(): MotionSearchService {
  if (!motionSearchServiceInstance) {
    motionSearchServiceInstance = new MotionSearchService();
  }
  return motionSearchServiceInstance;
}

/**
 * MotionSearchServiceインスタンスをリセット
 */
export function resetMotionSearchService(): void {
  motionSearchServiceInstance = null;
}

/**
 * MotionSearchServiceファクトリを作成
 */
export function createMotionSearchServiceFactory(): () => IMotionSearchService {
  return () => getMotionSearchService();
}

export default MotionSearchService;
