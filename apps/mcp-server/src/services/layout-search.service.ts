// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutSearchService
 * layout.search ツール用のサービス実装
 *
 * 機能:
 * - セクションパターンのベクトル検索
 * - 日本語/英語対応のセマンティック検索
 * - フィルタリング（セクションタイプ、ソースタイプ、利用範囲）
 * - ページネーション対応
 *
 * @module services/layout-search.service
 */

import { isDevelopment, logger } from '../utils/logger';
import { executeHybridSearch, buildFulltextConditions, buildFulltextRankExpression, toRankedItems } from '@reftrix/ml';
import type { RankedItem } from '@reftrix/ml';
import type {
  ILayoutSearchService,
  SearchOptions,
  SearchResult,
  SearchServiceResult,
  VisualFeatures,
  VisualFeaturesTheme,
  VisualFeaturesColors,
  VisualFeaturesDensity,
} from '../tools/layout/search.tool';
import type {
  LayoutSearchFilters,
  VisualFeaturesFilter,
} from '../tools/layout/schemas';
import { isColorWithinTolerance } from '../utils/color';

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
  sectionPattern: {
    findMany: (args?: {
      where?: Record<string, unknown>;
      include?: Record<string, boolean>;
      orderBy?: Record<string, string>;
      take?: number;
      skip?: number;
    }) => Promise<SectionPatternRecord[]>;
    count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
  };
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * DBから取得するSectionPatternレコード
 */
interface SectionPatternRecord {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName: string | null;
  layoutInfo: unknown;
  visualFeatures: unknown;
  htmlSnippet: string | null;
  webPage: {
    id: string;
    url: string;
    title: string | null;
    sourceType: string;
    usageScope: string;
    screenshotDesktopUrl: string | null;
  };
}

/**
 * ベクトル検索結果
 */
interface VectorSearchResult {
  id: string;
  web_page_id: string;
  section_type: string;
  section_name: string | null;
  layout_info: unknown;
  visual_features: unknown;
  html_snippet: string | null;
  similarity: number;
  // WebPage情報
  wp_id: string;
  wp_url: string;
  wp_title: string | null;
  wp_source_type: string;
  wp_usage_scope: string;
  wp_screenshot_desktop_url: string | null;
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setLayoutEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetLayoutEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 */
export function setLayoutPrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetLayoutPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * フィルター条件をWHERE句に変換
 */
function buildWhereClause(filters?: LayoutSearchFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters?.sectionType) {
    conditions.push(`sp.section_type = $${paramIndex}`);
    params.push(filters.sectionType);
    paramIndex++;
  }

  if (filters?.sourceType) {
    conditions.push(`wp.source_type = $${paramIndex}`);
    params.push(filters.sourceType);
    paramIndex++;
  }

  if (filters?.usageScope) {
    conditions.push(`wp.usage_scope = $${paramIndex}`);
    params.push(filters.usageScope);
    paramIndex++;
  }

  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : '',
    params,
  };
}

/**
 * visualFeatures JSONをパースしてVisualFeatures型に変換
 */
function parseVisualFeatures(raw: unknown): VisualFeatures | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const data = raw as Record<string, unknown>;
  const result: VisualFeatures = {};

  // theme を抽出
  if (typeof data.theme === 'object' && data.theme !== null) {
    const themeData = data.theme as Record<string, unknown>;
    const theme: VisualFeaturesTheme = {
      type: themeData.type as 'light' | 'dark' | 'mixed',
    };
    if (typeof themeData.backgroundColor === 'string') {
      theme.backgroundColor = themeData.backgroundColor;
    }
    if (typeof themeData.textColor === 'string') {
      theme.textColor = themeData.textColor;
    }
    if (typeof themeData.contrastRatio === 'number') {
      theme.contrastRatio = themeData.contrastRatio;
    }
    if (typeof themeData.luminance === 'object' && themeData.luminance !== null) {
      const lum = themeData.luminance as Record<string, number>;
      if (typeof lum.background === 'number' && typeof lum.text === 'number') {
        theme.luminance = { background: lum.background, text: lum.text };
      }
    }
    if (typeof themeData.source === 'string') {
      theme.source = themeData.source;
    }
    if (typeof themeData.confidence === 'number') {
      theme.confidence = themeData.confidence;
    }
    result.theme = theme;
  }

  // colors を抽出
  if (typeof data.colors === 'object' && data.colors !== null) {
    const colorsData = data.colors as Record<string, unknown>;
    const colors: VisualFeaturesColors = {};
    if (typeof colorsData.dominant === 'string') {
      colors.dominant = colorsData.dominant;
    }
    if (Array.isArray(colorsData.accent)) {
      colors.accent = colorsData.accent.filter((c): c is string => typeof c === 'string');
    }
    if (Array.isArray(colorsData.palette)) {
      colors.palette = colorsData.palette.filter((c): c is string => typeof c === 'string');
    }
    result.colors = colors;
  }

  // density を抽出
  if (typeof data.density === 'object' && data.density !== null) {
    const densityData = data.density as Record<string, unknown>;
    const density: VisualFeaturesDensity = {};
    if (typeof densityData.contentDensity === 'number') {
      density.contentDensity = densityData.contentDensity;
    }
    if (typeof densityData.whitespaceRatio === 'number') {
      density.whitespaceRatio = densityData.whitespaceRatio;
    }
    if (typeof densityData.visualBalance === 'number') {
      density.visualBalance = densityData.visualBalance;
    }
    result.density = density;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * visualFeaturesフィルターによる結果のフィルタリング
 * PostgreSQL JSONBクエリで全てをカバーするのが難しい場合のフォールバック
 */
function matchesVisualFeaturesFilter(
  visualFeatures: VisualFeatures | undefined,
  filter: VisualFeaturesFilter
): boolean {
  // visualFeaturesが存在しない場合、フィルターが設定されていればマッチしない
  if (!visualFeatures) {
    // フィルターが設定されている場合、visualFeaturesがないとマッチしない
    const hasActiveFilters =
      (filter.theme && (filter.theme.type || filter.theme.minContrastRatio)) ||
      (filter.colors && filter.colors.dominantColor) ||
      (filter.density && (filter.density.minContentDensity !== undefined ||
        filter.density.maxContentDensity !== undefined ||
        filter.density.minWhitespaceRatio !== undefined));
    return !hasActiveFilters;
  }

  // Theme フィルター
  if (filter.theme) {
    if (filter.theme.type && visualFeatures.theme?.type !== filter.theme.type) {
      return false;
    }
    if (
      filter.theme.minContrastRatio !== undefined &&
      (visualFeatures.theme?.contrastRatio === undefined ||
        visualFeatures.theme.contrastRatio < filter.theme.minContrastRatio)
    ) {
      return false;
    }
  }

  // Colors フィルター（ΔE色距離によるマッチング）
  if (filter.colors?.dominantColor) {
    const dominant = visualFeatures.colors?.dominant;
    if (!dominant) {
      return false;
    }
    const tolerance = filter.colors.colorTolerance ?? 15;
    if (!isColorWithinTolerance(filter.colors.dominantColor, dominant, tolerance)) {
      return false;
    }
  }

  // Density フィルター
  if (filter.density) {
    const density = visualFeatures.density;
    if (!density) {
      // Densityフィルターが設定されているがdensityがない場合
      const hasDensityFilter =
        filter.density.minContentDensity !== undefined ||
        filter.density.maxContentDensity !== undefined ||
        filter.density.minWhitespaceRatio !== undefined;
      if (hasDensityFilter) {
        return false;
      }
    } else {
      if (
        filter.density.minContentDensity !== undefined &&
        (density.contentDensity === undefined ||
          density.contentDensity < filter.density.minContentDensity)
      ) {
        return false;
      }
      if (
        filter.density.maxContentDensity !== undefined &&
        (density.contentDensity === undefined ||
          density.contentDensity > filter.density.maxContentDensity)
      ) {
        return false;
      }
      if (
        filter.density.minWhitespaceRatio !== undefined &&
        (density.whitespaceRatio === undefined ||
          density.whitespaceRatio < filter.density.minWhitespaceRatio)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * ベクトル検索結果をSearchResultに変換
 */
function vectorResultToSearchResult(r: VectorSearchResult): SearchResult {
  const layoutInfo = typeof r.layout_info === 'object' && r.layout_info !== null
    ? r.layout_info as Record<string, unknown>
    : {};

  // visualFeaturesをパース（layout_infoとvisual_features両方を確認）
  const visualFeatures = parseVisualFeatures(r.visual_features) ||
    parseVisualFeatures(layoutInfo.visualFeatures);

  // layoutInfo オブジェクトを構築（undefinedプロパティを除外）
  const layoutInfoResult: SearchResult['layoutInfo'] = {};
  if (typeof layoutInfo.type === 'string') {
    layoutInfoResult.type = layoutInfo.type;
  }
  if (typeof layoutInfo.heading === 'string') {
    layoutInfoResult.heading = layoutInfo.heading;
  }
  if (typeof layoutInfo.description === 'string') {
    layoutInfoResult.description = layoutInfo.description;
  }
  if (layoutInfo.grid !== undefined) {
    layoutInfoResult.grid = layoutInfo.grid;
  }

  // visionAnalysis を抽出（型安全にオブジェクトかどうかをチェック）
  if (
    layoutInfo.visionAnalysis !== undefined &&
    typeof layoutInfo.visionAnalysis === 'object' &&
    layoutInfo.visionAnalysis !== null
  ) {
    const visionData = layoutInfo.visionAnalysis as Record<string, unknown>;
    // success と features が存在する場合のみ visionAnalysis として設定
    if (typeof visionData.success === 'boolean' && Array.isArray(visionData.features)) {
      layoutInfoResult.visionAnalysis = {
        success: visionData.success,
        features: visionData.features.map((f) => {
          const feature = f as Record<string, unknown>;
          const result: {
            type: string;
            confidence: number;
            description?: string;
            data?: unknown;
          } = {
            type: typeof feature.type === 'string' ? feature.type : '',
            confidence: typeof feature.confidence === 'number' ? feature.confidence : 0,
          };
          if (typeof feature.description === 'string') {
            result.description = feature.description;
          }
          if (feature.data !== undefined) {
            result.data = feature.data;
          }
          return result;
        }),
      };
      // オプショナルフィールドを追加
      if (typeof visionData.textRepresentation === 'string') {
        layoutInfoResult.visionAnalysis.textRepresentation = visionData.textRepresentation;
      }
      if (typeof visionData.processingTimeMs === 'number') {
        layoutInfoResult.visionAnalysis.processingTimeMs = visionData.processingTimeMs;
      }
      if (typeof visionData.modelName === 'string') {
        layoutInfoResult.visionAnalysis.modelName = visionData.modelName;
      }
      if (typeof visionData.rawResponse === 'string') {
        layoutInfoResult.visionAnalysis.rawResponse = visionData.rawResponse;
      }
      if (typeof visionData.error === 'string') {
        layoutInfoResult.visionAnalysis.error = visionData.error;
      }
    }
  }

  // visualFeaturesをlayoutInfoにも追加（存在する場合）
  if (visualFeatures) {
    layoutInfoResult.visualFeatures = visualFeatures;
  }

  // webPage オブジェクトを構築（undefinedプロパティを除外）
  const webPageResult: SearchResult['webPage'] = {
    id: r.wp_id,
    url: r.wp_url,
    sourceType: r.wp_source_type,
    usageScope: r.wp_usage_scope,
    screenshotDesktopUrl: r.wp_screenshot_desktop_url,
  };
  if (r.wp_title) {
    webPageResult.title = r.wp_title;
  }

  // 結果オブジェクトを構築（undefinedプロパティを除外）
  const result: SearchResult = {
    id: r.id,
    webPageId: r.web_page_id,
    sectionType: r.section_type,
    similarity: r.similarity,
    webPage: webPageResult,
  };

  // オプショナルプロパティは値がある場合のみ設定
  if (r.section_name) {
    result.sectionName = r.section_name;
  }
  if (Object.keys(layoutInfoResult).length > 0) {
    result.layoutInfo = layoutInfoResult;
  }
  if (visualFeatures) {
    result.visualFeatures = visualFeatures;
  }
  if (r.html_snippet) {
    result.htmlSnippet = r.html_snippet;
  }

  return result;
}

// =====================================================
// LayoutSearchService
// =====================================================

/**
 * LayoutSearchServiceクラス
 */
export class LayoutSearchService implements ILayoutSearchService {
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;

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
   * クエリテキストからEmbeddingを生成
   * EmbeddingServiceが利用できない場合はnullを返す
   */
  async generateQueryEmbedding(query: string): Promise<number[] | null> {
    if (isDevelopment()) {
      logger.info('[LayoutSearchService] Generating query embedding', {
        queryLength: query.length,
      });
    }

    // EmbeddingServiceが利用できない場合はnullを返す
    if (!embeddingServiceFactory) {
      if (isDevelopment()) {
        logger.warn('[LayoutSearchService] EmbeddingService not available, returning null');
      }
      return null;
    }

    try {
      const embeddingService = this.getEmbeddingService();
      return await embeddingService.generateEmbedding(query, 'query');
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[LayoutSearchService] Embedding generation failed, returning null', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // エラー時もnullを返し、空の結果を返す
      return null;
    }
  }

  /**
   * セクションパターンを検索
   */
  async searchSectionPatterns(
    embedding: number[],
    options: SearchOptions
  ): Promise<SearchServiceResult | null> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[LayoutSearchService] Starting section pattern search', {
        embeddingDimensions: embedding.length,
        limit: options.limit,
        offset: options.offset,
        hasFilters: !!options.filters,
      });
    }

    // PrismaClient取得を試みる
    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      // PrismaClientが利用できない場合はnullを返す
      if (isDevelopment()) {
        logger.warn('[LayoutSearchService] PrismaClient not available, returning null');
      }
      return null;
    }

    try {
      const { clause: filterClause, params: filterParams } = buildWhereClause(options.filters);
      const vectorString = `[${embedding.join(',')}]`;

      // パラメータインデックスを計算
      const vectorParamIndex = filterParams.length + 1;
      const limitParamIndex = filterParams.length + 2;
      const offsetParamIndex = filterParams.length + 3;

      // WHERE句を構築
      let whereClause = '';
      if (filterClause) {
        whereClause = `WHERE ${filterClause} AND se.text_embedding IS NOT NULL`;
      } else {
        whereClause = 'WHERE se.text_embedding IS NOT NULL';
      }

      // ベクトル検索クエリ
      const query = `
        SELECT
          sp.id,
          sp.web_page_id,
          sp.section_type,
          sp.section_name,
          sp.layout_info,
          sp.visual_features,
          sp.html_snippet,
          1 - (se.text_embedding <=> $${vectorParamIndex}::vector) as similarity,
          wp.id as wp_id,
          wp.url as wp_url,
          wp.title as wp_title,
          wp.source_type as wp_source_type,
          wp.usage_scope as wp_usage_scope,
          wp.screenshot_desktop_url as wp_screenshot_desktop_url
        FROM section_patterns sp
        LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
        INNER JOIN web_pages wp ON wp.id = sp.web_page_id
        ${whereClause}
        ORDER BY similarity DESC
        LIMIT $${limitParamIndex}
        OFFSET $${offsetParamIndex}
      `;

      // カウントクエリ
      const countQuery = `
        SELECT COUNT(*) as total
        FROM section_patterns sp
        LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
        INNER JOIN web_pages wp ON wp.id = sp.web_page_id
        ${whereClause}
      `;

      let searchResults: VectorSearchResult[] = [];
      let total = 0;

      try {
        // 検索実行
        searchResults = await prisma.$queryRawUnsafe<VectorSearchResult[]>(
          query,
          ...filterParams,
          vectorString,
          options.limit,
          options.offset
        );

        // カウント取得
        const countResult = await prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
          countQuery,
          ...filterParams,
          vectorString
        );
        total = Number(countResult[0]?.total || 0);
      } catch (dbError) {
        if (isDevelopment()) {
          logger.warn('[LayoutSearchService] Vector search failed, returning empty results', {
            error: dbError instanceof Error ? dbError.message : 'Unknown error',
          });
        }
        // データベースエラー時は空の結果を返す
        return {
          results: [],
          total: 0,
        };
      }

      // 結果をマップ
      let results: SearchResult[] = searchResults.map(vectorResultToSearchResult);

      // visualFeaturesフィルターを適用（アプリケーション層でのフィルタリング）
      if (options.filters?.visualFeatures) {
        const visualFeaturesFilter = options.filters.visualFeatures;
        results = results.filter((r) =>
          matchesVisualFeaturesFilter(r.visualFeatures, visualFeaturesFilter)
        );

        if (isDevelopment()) {
          logger.debug('[LayoutSearchService] Applied visualFeatures filter', {
            originalCount: searchResults.length,
            filteredCount: results.length,
            filter: visualFeaturesFilter,
          });
        }
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[LayoutSearchService] Search completed', {
          resultsCount: results.length,
          total,
          processingTimeMs,
        });
      }

      return {
        results,
        total,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[LayoutSearchService] Search error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw error;
    }
  }

  /**
   * ハイブリッド検索: ベクトル検索 + 全文検索をRRFで統合
   *
   * 両検索を並列実行し、Reciprocal Rank Fusion (60% vector + 40% fulltext) で
   * 結果をマージする。全文検索が失敗した場合はベクトル検索のみで結果を返す。
   *
   * @param queryText - 生のクエリテキスト（全文検索用）
   * @param embedding - クエリEmbedding（ベクトル検索用）
   * @param options - 検索オプション
   * @returns マージされた検索結果
   */
  async searchSectionPatternsHybrid(
    queryText: string,
    embedding: number[],
    options: SearchOptions
  ): Promise<SearchServiceResult | null> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[LayoutSearchService] Starting hybrid search (vector + fulltext)', {
        queryTextLength: queryText.length,
        embeddingDimensions: embedding.length,
        limit: options.limit,
        offset: options.offset,
      });
    }

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[LayoutSearchService] PrismaClient not available, returning null');
      }
      return null;
    }

    try {
      const { clause: filterClause, params: filterParams } = buildWhereClause(options.filters);
      // RRFマージ用に多めに取得（最終的にlimit/offsetで切り出す）
      const fetchLimit = Math.min(options.limit * 3, 150);

      // ベクトル検索関数
      const vectorSearchFn = async (): Promise<RankedItem[]> => {
        const vectorString = `[${embedding.join(',')}]`;
        const vectorParamIndex = filterParams.length + 1;
        const limitParamIndex = filterParams.length + 2;

        let whereClause = '';
        if (filterClause) {
          whereClause = `WHERE ${filterClause} AND se.text_embedding IS NOT NULL`;
        } else {
          whereClause = 'WHERE se.text_embedding IS NOT NULL';
        }

        const query = `
          SELECT
            sp.id,
            sp.web_page_id,
            sp.section_type,
            sp.section_name,
            sp.layout_info,
            sp.visual_features,
            sp.html_snippet,
            1 - (se.text_embedding <=> $${vectorParamIndex}::vector) as similarity,
            wp.id as wp_id,
            wp.url as wp_url,
            wp.title as wp_title,
            wp.source_type as wp_source_type,
            wp.usage_scope as wp_usage_scope,
            wp.screenshot_desktop_url as wp_screenshot_desktop_url
          FROM section_patterns sp
          LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
          INNER JOIN web_pages wp ON wp.id = sp.web_page_id
          ${whereClause}
          ORDER BY similarity DESC
          LIMIT $${limitParamIndex}
        `;

        const results = await prisma.$queryRawUnsafe<VectorSearchResult[]>(
          query,
          ...filterParams,
          vectorString,
          fetchLimit
        );

        return toRankedItems(results);
      };

      // 全文検索関数
      const fulltextSearchFn = async (): Promise<RankedItem[]> => {
        const queryParamIndex = filterParams.length + 1;
        const limitParamIndex = filterParams.length + 2;

        const ftConditions = buildFulltextConditions('se.search_vector', queryParamIndex);
        const ftRank = buildFulltextRankExpression('se.search_vector', queryParamIndex);
        const whereClause = filterClause
          ? `WHERE ${filterClause} AND ${ftConditions}`
          : `WHERE ${ftConditions}`;

        const query = `
          SELECT
            sp.id,
            sp.web_page_id,
            sp.section_type,
            sp.section_name,
            sp.layout_info,
            sp.visual_features,
            sp.html_snippet,
            ${ftRank} as similarity,
            wp.id as wp_id,
            wp.url as wp_url,
            wp.title as wp_title,
            wp.source_type as wp_source_type,
            wp.usage_scope as wp_usage_scope,
            wp.screenshot_desktop_url as wp_screenshot_desktop_url
          FROM section_patterns sp
          LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
          INNER JOIN web_pages wp ON wp.id = sp.web_page_id
          ${whereClause}
          ORDER BY similarity DESC
          LIMIT $${limitParamIndex}
        `;

        try {
          const results = await prisma.$queryRawUnsafe<VectorSearchResult[]>(
            query,
            ...filterParams,
            queryText,
            fetchLimit
          );

          return toRankedItems(results);
        } catch (ftError) {
          // 全文検索の失敗はハイブリッド検索全体をブロックしない
          if (isDevelopment()) {
            logger.warn('[LayoutSearchService] Full-text search failed, using vector only', {
              error: ftError instanceof Error ? ftError.message : 'Unknown error',
            });
          }
          return [];
        }
      };

      // RRFハイブリッド検索を実行（両検索を並列実行）
      const hybridResults = await executeHybridSearch(
        vectorSearchFn,
        fulltextSearchFn
      );

      // offset/limitを適用
      const paginatedResults = hybridResults.slice(
        options.offset,
        options.offset + options.limit
      );

      // HybridSearchResult を SearchResult に変換
      const results: SearchResult[] = paginatedResults.map((hr) => {
        const data = hr.data as unknown as VectorSearchResult;
        const converted = vectorResultToSearchResult(data);
        converted.similarity = hr.similarity;
        return converted;
      });

      // visualFeaturesフィルターを適用
      let filteredResults = results;
      if (options.filters?.visualFeatures) {
        const visualFeaturesFilter = options.filters.visualFeatures;
        filteredResults = results.filter((r) =>
          matchesVisualFeaturesFilter(r.visualFeatures, visualFeaturesFilter)
        );
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[LayoutSearchService] Hybrid search completed', {
          totalMerged: hybridResults.length,
          resultsCount: filteredResults.length,
          processingTimeMs,
        });
      }

      return {
        results: filteredResults,
        total: hybridResults.length,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[LayoutSearchService] Hybrid search error, falling back to vector only', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // フォールバック: ベクトル検索のみ
      return this.searchSectionPatterns(embedding, options);
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let layoutSearchServiceInstance: LayoutSearchService | null = null;

/**
 * LayoutSearchServiceインスタンスを取得
 */
export function getLayoutSearchService(): LayoutSearchService {
  if (!layoutSearchServiceInstance) {
    layoutSearchServiceInstance = new LayoutSearchService();
  }
  return layoutSearchServiceInstance;
}

/**
 * LayoutSearchServiceインスタンスをリセット
 */
export function resetLayoutSearchService(): void {
  layoutSearchServiceInstance = null;
}

/**
 * LayoutSearchServiceファクトリを作成
 */
export function createLayoutSearchServiceFactory(): () => ILayoutSearchService {
  return () => getLayoutSearchService();
}

export default LayoutSearchService;
