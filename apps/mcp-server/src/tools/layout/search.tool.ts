// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search MCPツール
 * セクションパターンを自然言語クエリでセマンティック検索します
 *
 * 機能:
 * - 日本語/英語対応の自然言語検索
 * - pgvector HNSW インデックスによるベクトル検索
 * - multilingual-e5-baseによるクエリEmbedding生成
 * - セクションタイプ/ソースタイプ/利用範囲フィルタリング
 * - ページネーション対応
 *
 * @module tools/layout/search.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import { sanitizeHtml } from '../../utils/html-sanitizer';
import {
  layoutSearchInputSchema,
  LAYOUT_MCP_ERROR_CODES,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type LayoutSearchFilters,
  type LayoutSearchResultItem,
  type ProjectContextOptions,
  type IntegrationHints,
  type InferredContextOutput,
} from './schemas';
import {
  getQueryContextAnalyzer,
  calculateContextBoost,
  type InferredContext,
} from '../../services/query-context-analyzer';
import {
  ProjectContextAnalyzer,
  type ProjectPatterns,
} from '../../services/project-context-analyzer';
import type {
  VisionSearchQuery as VisionSearchQueryService,
  VisionSearchOptions as VisionSearchOptionsService,
  HybridSearchOptions,
  VisionSearchResult,
  VisionSearchServiceResult,
} from '../../services/vision-embedding-search.service';
import type {
  MoodBrandToneSearchService,
} from '../../services/search/mood-brandtone-search.service';
import type {
  Mood,
  BrandTone,
} from '../../schemas/mood-brandtone-filters';

// =====================================================
// 型定義
// =====================================================

export type { LayoutSearchInput, LayoutSearchOutput };

/**
 * 検索オプション
 * MCP-RESP-03: include_html (snake_case) を正式形式とし、
 * includeHtml (camelCase) はレガシー互換として維持
 */
export interface SearchOptions {
  filters?: LayoutSearchFilters | undefined;
  limit: number;
  offset: number;
  /** HTMLを含めるか（snake_case正式形式） */
  include_html: boolean;
  /** @deprecated include_html を使用してください */
  includeHtml?: boolean;
  project_context?: ProjectContextOptions | undefined;
}

/**
 * 検索結果（サービスから返される形式）
 */
/**
 * VisionAnalysis 結果（layout.inspect Vision分析の結果）
 */
export interface VisionAnalysisResult {
  success: boolean;
  features: Array<{
    type: string;
    confidence: number;
    description?: string;
    data?: unknown;
  }>;
  textRepresentation?: string;
  processingTimeMs?: number;
  modelName?: string;
  rawResponse?: string;
  error?: string;
}

/**
 * VisualFeatures テーマ情報
 */
export interface VisualFeaturesTheme {
  type: 'light' | 'dark' | 'mixed';
  backgroundColor?: string;
  textColor?: string;
  contrastRatio?: number;
  luminance?: {
    background: number;
    text: number;
  };
  source?: string;
  confidence?: number;
}

/**
 * VisualFeatures カラー情報
 */
export interface VisualFeaturesColors {
  dominant?: string;
  accent?: string[];
  palette?: string[];
}

/**
 * VisualFeatures 密度情報
 */
export interface VisualFeaturesDensity {
  contentDensity?: number;
  whitespaceRatio?: number;
  visualBalance?: number;
}

/**
 * VisualFeatures 統合情報
 */
export interface VisualFeatures {
  theme?: VisualFeaturesTheme;
  colors?: VisualFeaturesColors;
  density?: VisualFeaturesDensity;
}

export interface SearchResult {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName?: string;
  similarity: number;
  layoutInfo?: {
    type?: string;
    heading?: string;
    description?: string;
    grid?: unknown;
    visionAnalysis?: VisionAnalysisResult;
    visualFeatures?: VisualFeatures;
  };
  visualFeatures?: VisualFeatures;
  htmlSnippet?: string;
  webPage: {
    id: string;
    url: string;
    title?: string;
    sourceType: string;
    usageScope: string;
    screenshotDesktopUrl?: string | null;
  };
  // RRF統合検索時の情報（combined モード時のみ）
  rrfDetails?: {
    textRank: number; // テキスト検索でのランク（0=含まれない）
    visionRank: number; // Vision検索でのランク（0=含まれない）
    textScore?: number;
    visionScore?: number;
    rrfScore?: number;
  };
}

/**
 * 検索サービスの結果
 */
export interface SearchServiceResult {
  results: SearchResult[];
  total: number;
}

/**
 * layout.search サービスインターフェース（DI用）
 */
export interface ILayoutSearchService {
  /**
   * クエリテキストからEmbeddingを生成
   * EmbeddingServiceが利用できない場合はnullを返す
   */
  generateQueryEmbedding: (query: string) => Promise<number[] | null>;

  /**
   * セクションパターンを検索（ベクトル検索のみ）
   */
  searchSectionPatterns: (
    embedding: number[],
    options: SearchOptions
  ) => Promise<SearchServiceResult | null>;

  /**
   * ハイブリッド検索: ベクトル検索 + 全文検索をRRFで統合
   * 実装されていない場合はsearchSectionPatternsにフォールバック
   */
  searchSectionPatternsHybrid?: (
    queryText: string,
    embedding: number[],
    options: SearchOptions
  ) => Promise<SearchServiceResult | null>;
}

/**
 * Vision検索サービスインターフェース（DI用）
 * Phase 4-2: visionEmbeddingベースのセマンティック検索
 */
export interface IVisionSearchService {
  /**
   * vision_embeddingでセマンティック検索
   */
  searchByVisionEmbedding: (
    query: VisionSearchQueryService,
    options: VisionSearchOptionsService
  ) => Promise<VisionSearchServiceResult | null>;

  /**
   * ハイブリッド検索（text_embedding + vision_embedding）
   * RRF (Reciprocal Rank Fusion) で結果を統合
   */
  hybridSearch: (
    textQuery: string,
    visionQuery: VisionSearchQueryService,
    options: HybridSearchOptions
  ) => Promise<VisionSearchServiceResult | null>;
}

// =====================================================
// サービスファクトリー（DI）
// =====================================================

let serviceFactory: (() => ILayoutSearchService) | null = null;

/**
 * VisionSearchサービスファクトリー（DI）
 * Phase 4-2: visionEmbeddingベースの検索
 */
let visionSearchServiceFactory: (() => IVisionSearchService) | null = null;

/**
 * ProjectContextAnalyzer シングルトンインスタンス
 */
let projectContextAnalyzer: ProjectContextAnalyzer | null = null;

/**
 * ProjectContextAnalyzer インスタンスを取得
 */
function getProjectContextAnalyzer(): ProjectContextAnalyzer {
  if (!projectContextAnalyzer) {
    projectContextAnalyzer = new ProjectContextAnalyzer();
  }
  return projectContextAnalyzer;
}

/**
 * サービスファクトリーを設定
 */
export function setLayoutSearchServiceFactory(
  factory: () => ILayoutSearchService
): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリーをリセット
 */
export function resetLayoutSearchServiceFactory(): void {
  serviceFactory = null;
}

/**
 * VisionSearchサービスファクトリーを設定
 * Phase 4-2: visionEmbeddingベースの検索
 */
export function setVisionSearchServiceFactory(
  factory: () => IVisionSearchService
): void {
  visionSearchServiceFactory = factory;
}

/**
 * VisionSearchサービスファクトリーをリセット
 */
export function resetVisionSearchServiceFactory(): void {
  visionSearchServiceFactory = null;
}

/**
 * ProjectContextAnalyzer をリセット（テスト用）
 */
export function resetProjectContextAnalyzer(): void {
  if (projectContextAnalyzer) {
    projectContextAnalyzer.clearCache();
  }
  projectContextAnalyzer = null;
}

/**
 * MoodBrandToneSearchサービスファクトリー（DI）
 * GREEN Phase: mood/brandTone semantic search
 */
let moodBrandToneSearchServiceFactory: (() => MoodBrandToneSearchService) | null = null;

/**
 * MoodBrandToneSearchサービスファクトリーを設定
 */
export function setMoodBrandToneSearchServiceFactory(
  factory: () => MoodBrandToneSearchService
): void {
  moodBrandToneSearchServiceFactory = factory;
}

/**
 * MoodBrandToneSearchサービスファクトリーをリセット
 */
export function resetMoodBrandToneSearchServiceFactory(): void {
  moodBrandToneSearchServiceFactory = null;
}

// =====================================================
// クエリ前処理
// =====================================================

/**
 * 検索クエリを前処理する
 * - E5モデル用のquery:プレフィックスを追加
 * - 空白の正規化
 * - 全角スペースの半角変換
 *
 * @param query - 元のクエリ文字列
 * @returns 前処理されたクエリ文字列
 */
export function preprocessQuery(query: string): string {
  // 1. 全角スペースを半角に変換
  let normalized = query.replace(/\u3000/g, ' ');

  // 2. 改行・タブを空白に変換
  normalized = normalized.replace(/[\n\t\r]/g, ' ');

  // 3. 連続する空白を1つに正規化
  normalized = normalized.replace(/\s+/g, ' ');

  // 4. 前後の空白を除去
  normalized = normalized.trim();

  // 5. E5モデル用のquery:プレフィックスを追加
  return `query: ${normalized}`;
}

// =====================================================
// エラーコード判定
// =====================================================

/**
 * エラーからエラーコードを判定
 */
function determineErrorCode(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // Embeddingエラー
  if (
    lowerMessage.includes('embedding') ||
    lowerMessage.includes('model') ||
    lowerMessage.includes('tensor')
  ) {
    return 'EMBEDDING_ERROR';
  }

  // データベースエラー
  if (
    lowerMessage.includes('database') ||
    lowerMessage.includes('prisma') ||
    lowerMessage.includes('connection')
  ) {
    return LAYOUT_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  // タイムアウトエラー
  if (lowerMessage.includes('timeout')) {
    return LAYOUT_MCP_ERROR_CODES.TIMEOUT;
  }

  // その他は内部エラー
  return LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// 結果マッピング
// =====================================================

/**
 * Adaptability情報（オプション）
 */
interface AdaptabilityInfo {
  score: number;
  hints: IntegrationHints;
}

/**
 * HTMLプレビュー生成オプション
 */
interface PreviewOptions {
  /** プレビューを含めるか（デフォルト: true） */
  includePreview: boolean;
  /** プレビューの最大文字数（デフォルト: 500） */
  maxLength: number;
}

/**
 * HTMLスニペットからサニタイズ済みプレビューを生成
 *
 * @param htmlSnippet - 元のHTMLスニペット
 * @param maxLength - 最大文字数
 * @returns サニタイズ・切り詰め済みHTMLプレビューと元の長さ
 */
function generateHtmlPreview(
  htmlSnippet: string,
  maxLength: number
): { htmlPreview: string; previewLength: number } {
  // 1. HTMLをサニタイズ（XSS対策）
  const sanitized = sanitizeHtml(htmlSnippet);

  // 元の長さを記録
  const previewLength = sanitized.length;

  // 2. 最大長に切り詰め
  let htmlPreview = sanitized;
  if (sanitized.length > maxLength) {
    // タグの途中で切らないように、最後の完全なタグまで切り詰める
    htmlPreview = sanitized.substring(0, maxLength);

    // 開いているタグを検出して閉じる試み
    // 簡易的に最後の不完全なタグを除去
    const lastOpenTagIndex = htmlPreview.lastIndexOf('<');
    const lastCloseTagIndex = htmlPreview.lastIndexOf('>');

    if (lastOpenTagIndex > lastCloseTagIndex) {
      // 不完全なタグがある場合、その前まで切り詰め
      htmlPreview = htmlPreview.substring(0, lastOpenTagIndex);
    }

    // 省略記号を追加
    htmlPreview = htmlPreview.trimEnd() + '...';
  }

  return { htmlPreview, previewLength };
}

/**
 * バリデーション済み入力からinclude_htmlを取得
 * MCP-RESP-03: snake_case (include_html) を優先し、camelCase (includeHtml) はフォールバック
 */
function getIncludeHtml(validated: LayoutSearchInput): boolean {
  // snake_case優先
  if (validated.include_html !== undefined) {
    return validated.include_html;
  }
  // camelCaseフォールバック（後方互換）
  return validated.includeHtml ?? false;
}

/**
 * 検索結果をMCPレスポンス形式にマップ
 * @param result - 検索結果
 * @param include_html - HTMLを含めるか（snake_case正式形式）
 */
function mapSearchResult(
  result: SearchResult,
  include_html: boolean,
  adaptability?: AdaptabilityInfo,
  semanticInfo?: {
    moodInfo?: { primary: Mood; secondary?: Mood | undefined };
    brandToneInfo?: { primary: BrandTone; secondary?: BrandTone | undefined };
  },
  previewOptions?: PreviewOptions,
  contextBoost?: number
): LayoutSearchResultItem {
  const preview: LayoutSearchResultItem['preview'] = {};

  // プレビュー情報を抽出
  if (result.layoutInfo) {
    if (result.layoutInfo.heading) {
      preview.heading = result.layoutInfo.heading;
    }
    if (result.layoutInfo.description) {
      preview.description = result.layoutInfo.description;
    }
  }

  // サムネイル（スクリーンショットURL）
  if (result.webPage.screenshotDesktopUrl) {
    preview.thumbnail = result.webPage.screenshotDesktopUrl;
  }

  const item: LayoutSearchResultItem = {
    id: result.id,
    webPageId: result.webPageId,
    type: result.sectionType,
    similarity: result.similarity,
    preview,
    source: {
      url: result.webPage.url,
      type: result.webPage.sourceType as 'award_gallery' | 'user_provided',
      usageScope: result.webPage.usageScope as 'inspiration_only' | 'owned_asset',
    },
  };

  // HTMLを含める場合
  if (include_html && result.htmlSnippet) {
    item.html = result.htmlSnippet;
  }

  // HTMLプレビューを含める場合（デフォルト有効）
  const shouldIncludePreview = previewOptions?.includePreview ?? true;
  const maxLength = previewOptions?.maxLength ?? 500;

  if (shouldIncludePreview && result.htmlSnippet) {
    const { htmlPreview, previewLength } = generateHtmlPreview(
      result.htmlSnippet,
      maxLength
    );
    item.htmlPreview = htmlPreview;
    item.previewLength = previewLength;
  }

  // Vision分析結果を含める（存在する場合）
  if (result.layoutInfo?.visionAnalysis) {
    item.visionAnalysis = result.layoutInfo.visionAnalysis;
  }

  // Adaptability情報を含める（project_context.enabled=true時）
  if (adaptability) {
    item.adaptability_score = adaptability.score;
    item.integration_hints = adaptability.hints;
  }

  // TASK-06-3 Step 2: セマンティックメタデータを含める（mood/brandTone検索結果がある場合）
  if (semanticInfo?.moodInfo) {
    item.moodInfo = semanticInfo.moodInfo;
  }
  if (semanticInfo?.brandToneInfo) {
    item.brandToneInfo = semanticInfo.brandToneInfo;
  }

  // REFTRIX-LAYOUT-02: Context boost
  if (contextBoost !== undefined && contextBoost > 0) {
    item.context_boost = contextBoost;
  }

  // RRF統合検索時の詳細情報（combined モード時のみ）
  if (result.rrfDetails) {
    item.rrfDetails = result.rrfDetails;
  }

  return item;
}

// =====================================================
// Vision検索実行（Phase 4-2）
// =====================================================

/**
 * VisionSearchResult を SearchResult に変換
 */
function mapVisionResultToSearchResult(visionResult: VisionSearchResult): SearchResult {
  const result: SearchResult = {
    id: visionResult.id,
    webPageId: visionResult.webPageId,
    sectionType: visionResult.sectionType,
    similarity: visionResult.similarity,
    webPage: {
      id: visionResult.webPage.id,
      url: visionResult.webPage.url,
      sourceType: visionResult.webPage.sourceType,
      usageScope: visionResult.webPage.usageScope,
      screenshotDesktopUrl: visionResult.webPage.screenshotDesktopUrl,
    },
  };

  // Optional fields - only set if defined
  if (visionResult.sectionName) {
    result.sectionName = visionResult.sectionName;
  }
  if (visionResult.webPage.title) {
    result.webPage.title = visionResult.webPage.title;
  }
  // layoutInfo: 存在する場合にオブジェクトを構築
  if (visionResult.layoutInfo !== undefined) {
    const layoutInfoSrc = visionResult.layoutInfo;
    const layoutInfo: NonNullable<SearchResult['layoutInfo']> = {};
    if (typeof layoutInfoSrc['type'] === 'string') {
      layoutInfo.type = layoutInfoSrc['type'];
    }
    if (typeof layoutInfoSrc['heading'] === 'string') {
      layoutInfo.heading = layoutInfoSrc['heading'];
    }
    if (typeof layoutInfoSrc['description'] === 'string') {
      layoutInfo.description = layoutInfoSrc['description'];
    }
    if (layoutInfoSrc['grid'] !== undefined) {
      layoutInfo.grid = layoutInfoSrc['grid'];
    }
    if (layoutInfoSrc['visionAnalysis'] !== undefined) {
      layoutInfo.visionAnalysis = layoutInfoSrc['visionAnalysis'] as VisionAnalysisResult;
    }
    if (layoutInfoSrc['visualFeatures'] !== undefined) {
      layoutInfo.visualFeatures = layoutInfoSrc['visualFeatures'] as VisualFeatures;
    }
    result.layoutInfo = layoutInfo;
  }
  // visualFeatures: 存在する場合にオブジェクトを構築
  // VisualFeaturesはtheme?, colors?, density?の複合型
  if (visionResult.visualFeatures !== undefined) {
    const vfSrc = visionResult.visualFeatures;
    const visualFeatures: VisualFeatures = {};
    // theme: VisualFeaturesTheme型（type, backgroundColor, textColor, contrastRatio, luminance, source, confidence）
    if (vfSrc['theme'] !== undefined && typeof vfSrc['theme'] === 'object') {
      visualFeatures.theme = vfSrc['theme'] as VisualFeaturesTheme;
    }
    // colors: VisualFeaturesColors型（dominant?, accent?, palette?）
    if (vfSrc['colors'] !== undefined && typeof vfSrc['colors'] === 'object') {
      visualFeatures.colors = vfSrc['colors'] as VisualFeaturesColors;
    }
    // density: VisualFeaturesDensity型（contentDensity?, whitespaceRatio?, visualBalance?）
    if (vfSrc['density'] !== undefined && typeof vfSrc['density'] === 'object') {
      visualFeatures.density = vfSrc['density'] as VisualFeaturesDensity;
    }
    result.visualFeatures = visualFeatures;
  }
  if (visionResult.htmlSnippet) {
    result.htmlSnippet = visionResult.htmlSnippet;
  }

  // RRF詳細情報（combined モード時のみ）
  if (visionResult.textRank !== undefined || visionResult.visionRank !== undefined) {
    result.rrfDetails = {
      textRank: visionResult.textRank ?? 0,
      visionRank: visionResult.visionRank ?? 0,
    };
    if (visionResult.rrfDetails) {
      if (visionResult.rrfDetails.textScore !== undefined) {
        result.rrfDetails.textScore = visionResult.rrfDetails.textScore;
      }
      if (visionResult.rrfDetails.visionScore !== undefined) {
        result.rrfDetails.visionScore = visionResult.rrfDetails.visionScore;
      }
      if (visionResult.rrfDetails.combinedScore !== undefined) {
        result.rrfDetails.rrfScore = visionResult.rrfDetails.combinedScore;
      }
    }
  }

  return result;
}

/**
 * Vision検索を実行（Phase 4-2）
 * useVisionSearch=true の場合に呼び出される
 *
 * @param validated - バリデーション済み入力
 * @param startTime - 開始時刻
 */
async function executeVisionSearch(
  validated: LayoutSearchInput,
  startTime: number
): Promise<LayoutSearchOutput> {
  // VisionSearchサービスチェック
  if (!visionSearchServiceFactory) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] layout.search vision search service not available, falling back to text search');
    }

    // フォールバック: 通常の検索を実行（サービスがない場合）
    return {
      success: false,
      error: {
        code: 'VISION_SEARCH_UNAVAILABLE',
        message: 'Vision search service is not available. Set use_vision_search=false to use text-only search.',
      },
    };
  }

  const visionService = visionSearchServiceFactory();

  // VisionSearchQueryの構築
  const visionQuery: VisionSearchQueryService = {
    textQuery: validated.vision_search_query?.textQuery ?? validated.query,
  };

  // visualFeaturesが定義されている場合のみ追加
  if (validated.vision_search_query?.visualFeatures) {
    const vf = validated.vision_search_query.visualFeatures;
    const visualFeatures: NonNullable<VisionSearchQueryService['visualFeatures']> = {};

    if (vf.theme) visualFeatures.theme = vf.theme;
    if (vf.colors) visualFeatures.colors = vf.colors;
    if (vf.density) visualFeatures.density = vf.density;
    if (vf.gradient) visualFeatures.gradient = vf.gradient;
    if (vf.mood) visualFeatures.mood = vf.mood;
    if (vf.brandTone) visualFeatures.brandTone = vf.brandTone;

    visionQuery.visualFeatures = visualFeatures;
  }

  // sectionPatternIdが定義されている場合のみ追加
  if (validated.vision_search_query?.sectionPatternId) {
    visionQuery.sectionPatternId = validated.vision_search_query.sectionPatternId;
  }

  // VisionSearchOptionsの構築
  const visionOptions: HybridSearchOptions = {
    limit: validated.limit,
    offset: validated.offset,
    minSimilarity: validated.vision_search_options?.minSimilarity ?? 0.5,
    visionWeight: validated.vision_search_options?.visionWeight ?? 0.6,
    textWeight: validated.vision_search_options?.textWeight ?? 0.4,
  };

  // フィルターが定義されている場合のみ追加
  if (validated.filters?.sectionType) {
    visionOptions.sectionType = validated.filters.sectionType;
  }
  if (validated.filters?.sourceType) {
    visionOptions.sourceType = validated.filters.sourceType;
  }
  if (validated.filters?.usageScope) {
    visionOptions.usageScope = validated.filters.usageScope;
  }

  if (isDevelopment()) {
    logger.debug('[MCP Tool] layout.search executing vision search', {
      visionQuery,
      visionOptions,
    });
  }

  try {
    // ハイブリッド検索を実行（text_embedding + vision_embedding のRRF統合）
    const visionResult = await visionService.hybridSearch(
      validated.query,
      visionQuery,
      visionOptions
    );

    if (!visionResult) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // Vision結果を標準形式にマップ
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };

    const includeHtmlValue = getIncludeHtml(validated);
    const mappedResults = visionResult.results.map((vr) => {
      const searchResult = mapVisionResultToSearchResult(vr);
      return mapSearchResult(
        searchResult,
        includeHtmlValue,
        undefined, // adaptability
        undefined, // semanticInfo
        previewOptions
      );
    });

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MCP Tool] layout.search vision search completed', {
        query: validated.query,
        use_vision_search: true,
        resultCount: mappedResults.length,
        total: visionResult.total,
        searchTimeMs,
      });
    }

    return {
      success: true,
      data: {
        results: mappedResults,
        total: visionResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        searchTimeMs,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);

    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.search vision search error', {
        code: errorCode,
        error: errorMessage,
      });
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
      },
    };
  }
}

// =====================================================
// Multimodal Search / RRF Functions
// =====================================================

/**
 * RRF (Reciprocal Rank Fusion) スコアを計算
 *
 * 公式: score = 1 / (k + rank)
 *
 * @param textRank - テキスト検索でのランク（1から開始、0は未検索）
 * @param visionRank - Vision検索でのランク（1から開始、0は未検索）
 * @param textWeight - テキスト検索の重み（デフォルト0.6）
 * @param visionWeight - Vision検索の重み（デフォルト0.4）
 * @param k - RRFのkパラメータ（デフォルト60）
 */
export function calculateRrfScore(
  textRank: number,
  visionRank: number,
  textWeight: number = 0.6,
  visionWeight: number = 0.4,
  k: number = 60
): number {
  const textScore = textRank > 0 ? 1 / (k + textRank) : 0;
  const visionScore = visionRank > 0 ? 1 / (k + visionRank) : 0;
  return textWeight * textScore + visionWeight * visionScore;
}

/**
 * 検索モードを決定し、必要に応じてフォールバック（Graceful Degradation）
 *
 * @param requestedMode - 要求された検索モード
 * @param hasVisionService - VisionSearchServiceが利用可能か
 * @param hasVisionEmbeddings - vision_embeddingが存在するか（DBチェック）
 * @returns 実際の検索モードと警告メッセージ
 */
export function determineSearchMode(
  requestedMode: 'text_only' | 'vision_only' | 'combined',
  hasVisionService: boolean,
  hasVisionEmbeddings: boolean = true
): { actualMode: 'text_only' | 'vision_only' | 'combined'; warnings: string[] } {
  const warnings: string[] = [];

  // text_only は常にそのまま
  if (requestedMode === 'text_only') {
    return { actualMode: 'text_only', warnings };
  }

  // VisionSearchServiceが利用不可
  if (!hasVisionService) {
    if (requestedMode === 'vision_only') {
      warnings.push('VisionSearchService unavailable, falling back to text_only');
    } else if (requestedMode === 'combined') {
      warnings.push('VisionSearchService unavailable, falling back to text_only');
    }
    return { actualMode: 'text_only', warnings };
  }

  // vision_embeddingが存在しない
  if (!hasVisionEmbeddings) {
    if (requestedMode === 'vision_only') {
      warnings.push('vision_embedding not available, falling back to text_only');
    } else if (requestedMode === 'combined') {
      warnings.push('No vision embeddings available, falling back to text_only');
    }
    return { actualMode: 'text_only', warnings };
  }

  // 要求されたモードをそのまま使用
  return { actualMode: requestedMode, warnings };
}

/**
 * search_modeに基づくマルチモーダル検索実行
 */
async function executeMultimodalSearch(
  validated: LayoutSearchInput,
  service: ILayoutSearchService,
  startTime: number
): Promise<LayoutSearchOutput> {
  const searchMode = validated.search_mode ?? 'text_only';
  const multimodalOptions = validated.multimodal_options;
  const textWeight = multimodalOptions?.textWeight ?? 0.6;
  const visionWeight = multimodalOptions?.visionWeight ?? 0.4;
  const rrfK = multimodalOptions?.rrfK ?? 60;

  // VisionSearchServiceの可用性チェック
  const hasVisionService = !!visionSearchServiceFactory;

  // 検索モードを決定（Graceful Degradation）
  const { actualMode, warnings } = determineSearchMode(
    searchMode,
    hasVisionService
  );

  if (isDevelopment()) {
    logger.debug('[MCP Tool] layout.search multimodal mode', {
      requestedMode: searchMode,
      actualMode,
      warnings,
    });
  }

  // text_only モード
  if (actualMode === 'text_only') {
    const processedQuery = preprocessQuery(validated.query);
    const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

    if (queryEmbedding === null) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }

    const searchOptions: SearchOptions = {
      filters: validated.filters,
      limit: validated.limit,
      offset: validated.offset,
      include_html: getIncludeHtml(validated),
      project_context: validated.project_context,
    };

    // ハイブリッド検索（vector + fulltext RRF）が利用可能な場合はそちらを使用
    const searchResult = service.searchSectionPatternsHybrid
      ? await service.searchSectionPatternsHybrid(
          validated.query,
          queryEmbedding,
          searchOptions
        )
      : await service.searchSectionPatterns(
          queryEmbedding,
          searchOptions
        );

    if (!searchResult) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }

    // 結果マッピング
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };
    const includeHtmlValue = getIncludeHtml(validated);
    const mappedResults = searchResult.results.map((sr) =>
      mapSearchResult(
        sr,
        includeHtmlValue,
        undefined, // adaptability
        undefined, // semanticInfo
        previewOptions
      )
    );

    return {
      success: true,
      data: {
        results: mappedResults,
        total: searchResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        searchTimeMs: Date.now() - startTime,
        searchMode: searchMode,
        actualSearchMode: actualMode,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }

  // vision_only または combined モードではVisionSearchServiceを使用
  if (!visionSearchServiceFactory) {
    // これはdetermineSearchModeで処理されるはずだが、安全のため
    return {
      success: false,
      error: {
        code: 'VISION_SEARCH_UNAVAILABLE',
        message: 'Vision search service is not available.',
      },
    };
  }

  const visionService = visionSearchServiceFactory();

  // vision_only モード
  if (actualMode === 'vision_only') {
    try {
      const visionQuery: VisionSearchQueryService = {
        textQuery: validated.vision_search_query?.textQuery ?? validated.query,
      };

      const visionOptions: HybridSearchOptions = {
        limit: validated.limit,
        offset: validated.offset,
        minSimilarity: 0.5,
        visionWeight: 1.0, // vision_onlyなので100%
        textWeight: 0.0,
      };

      if (validated.filters?.sectionType) {
        visionOptions.sectionType = validated.filters.sectionType;
      }

      // searchByVisionEmbeddingを呼び出し（vision_onlyモード）
      const visionResult = await visionService.searchByVisionEmbedding(
        visionQuery,
        visionOptions
      );

      if (!visionResult) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: actualMode,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        };
      }

      // Graceful Degradation - fallbackToTextOnly処理
      if (visionResult.fallbackToTextOnly) {
        warnings.push('vision_embedding not available, falling back to text_only');
        // text_onlyで再検索（警告を保持したまま）
        const processedQuery = preprocessQuery(validated.query);
        const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

        if (queryEmbedding === null) {
          return {
            success: true,
            data: {
              results: [],
              total: 0,
              query: validated.query,
              filters: validated.filters ?? {},
              searchTimeMs: Date.now() - startTime,
              searchMode: searchMode,
              actualSearchMode: 'text_only', // フォールバック後
              warnings: warnings,
            },
          };
        }

        const searchOptions: SearchOptions = {
          filters: validated.filters,
          limit: validated.limit,
          offset: validated.offset,
          include_html: getIncludeHtml(validated),
          project_context: validated.project_context,
        };

        const searchResult = await service.searchSectionPatterns(
          queryEmbedding,
          searchOptions
        );

        const previewOptionsForFallback: PreviewOptions = {
          includePreview: validated.include_preview,
          maxLength: validated.preview_max_length,
        };
        const includeHtmlValueForFallback = getIncludeHtml(validated);
        const mappedResultsForFallback = (searchResult?.results ?? []).map((sr) =>
          mapSearchResult(
            sr,
            includeHtmlValueForFallback,
            undefined,
            undefined,
            previewOptionsForFallback
          )
        );

        return {
          success: true,
          data: {
            results: mappedResultsForFallback,
            total: searchResult?.total ?? 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: 'text_only', // フォールバック後
            warnings: warnings,
          },
        };
      }

      const previewOptions: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValue = getIncludeHtml(validated);
      const mappedResults = visionResult.results.map((vr) => {
        const searchResult = mapVisionResultToSearchResult(vr);
        return mapSearchResult(
          searchResult,
          includeHtmlValue,
          undefined,
          undefined,
          previewOptions
        );
      });

      return {
        success: true,
        data: {
          results: mappedResults,
          total: visionResult.total,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    } catch (error) {
      // エラー時はtext_onlyにフォールバック（警告を保持）
      warnings.push(`Vision search error: ${error instanceof Error ? error.message : String(error)}, falling back to text_only`);

      const processedQuery = preprocessQuery(validated.query);
      const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

      if (queryEmbedding === null) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: 'text_only',
            warnings: warnings,
          },
        };
      }

      const searchOptions: SearchOptions = {
        filters: validated.filters,
        limit: validated.limit,
        offset: validated.offset,
        include_html: getIncludeHtml(validated),
        project_context: validated.project_context,
      };

      const searchResult = await service.searchSectionPatterns(
        queryEmbedding,
        searchOptions
      );

      const previewOptionsForError: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValueForError = getIncludeHtml(validated);
      const mappedResultsForError = (searchResult?.results ?? []).map((sr) =>
        mapSearchResult(
          sr,
          includeHtmlValueForError,
          undefined,
          undefined,
          previewOptionsForError
        )
      );

      return {
        success: true,
        data: {
          results: mappedResultsForError,
          total: searchResult?.total ?? 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: 'text_only',
          warnings: warnings,
        },
      };
    }
  }

  // combined モード（RRF統合検索）
  if (actualMode === 'combined') {
    const rrfStartTime = Date.now();

    try {
      const visionQuery: VisionSearchQueryService = {
        textQuery: validated.vision_search_query?.textQuery ?? validated.query,
      };

      const hybridOptions: HybridSearchOptions = {
        limit: validated.limit,
        offset: validated.offset,
        minSimilarity: 0.5,
        visionWeight: visionWeight,
        textWeight: textWeight,
        rrfK: rrfK, // RRFのkパラメータ
      };

      if (validated.filters?.sectionType) {
        hybridOptions.sectionType = validated.filters.sectionType;
      }

      // hybridSearchを呼び出し
      const hybridResult = await visionService.hybridSearch(
        validated.query,
        visionQuery,
        hybridOptions
      );

      const rrfCalculationTime = Date.now() - rrfStartTime;

      if (!hybridResult) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: actualMode,
            warnings: warnings.length > 0 ? warnings : undefined,
            rrfDetails: {
              k: rrfK,
              textWeight,
              visionWeight,
              textResultCount: 0,
              visionResultCount: 0,
              fusedResultCount: 0,
              calculationTimeMs: rrfCalculationTime,
            },
          },
        };
      }

      // Graceful Degradation - fallbackToTextOnly処理
      if (hybridResult.fallbackToTextOnly) {
        // フォールバック発生時は actualSearchMode を text_only に変更
        const fallbackReason = hybridResult.fallbackReason ?? 'No vision embeddings available';
        warnings.push(fallbackReason);

        const previewOptions: PreviewOptions = {
          includePreview: validated.include_preview,
          maxLength: validated.preview_max_length,
        };
        const includeHtmlValue = getIncludeHtml(validated);
        const mappedResults = hybridResult.results.map((vr) => {
          const searchResult = mapVisionResultToSearchResult(vr);
          return mapSearchResult(
            searchResult,
            includeHtmlValue,
            undefined,
            undefined,
            previewOptions
          );
        });

        return {
          success: true,
          data: {
            results: mappedResults,
            total: hybridResult.total,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: 'text_only', // フォールバック後のモード
            warnings: warnings.length > 0 ? warnings : undefined,
            fallbackReason: fallbackReason,
          },
        };
      }

      const previewOptions: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValue = getIncludeHtml(validated);
      const mappedResults = hybridResult.results.map((vr) => {
        const searchResult = mapVisionResultToSearchResult(vr);
        return mapSearchResult(
          searchResult,
          includeHtmlValue,
          undefined,
          undefined,
          previewOptions
        );
      });

      return {
        success: true,
        data: {
          results: mappedResults,
          total: hybridResult.total,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
          rrfDetails: {
            k: rrfK,
            textWeight,
            visionWeight,
            textResultCount: hybridResult.results.length,
            visionResultCount: hybridResult.results.length,
            fusedResultCount: hybridResult.results.length,
            calculationTimeMs: rrfCalculationTime,
          },
        },
      };
    } catch (error) {
      warnings.push(`Combined search error: ${error instanceof Error ? error.message : String(error)}, falling back to text_only`);
      return executeMultimodalSearch(
        { ...validated, search_mode: 'text_only' },
        service,
        startTime
      );
    }
  }

  // フォールバック（通常到達しない）
  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: `Unexpected search mode: ${actualMode}`,
    },
  };
}

// =====================================================
// メインハンドラー
// =====================================================

/**
 * layout.search ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns 検索結果
 *
 * @example
 * ```typescript
 * const result = await layoutSearchHandler({
 *   query: 'modern hero section with gradient',
 *   filters: {
 *     sectionType: 'hero',
 *     sourceType: 'award_gallery',
 *   },
 *   limit: 10,
 *   offset: 0,
 * });
 * ```
 */
export async function layoutSearchHandler(
  input: unknown
): Promise<LayoutSearchOutput> {
  const startTime = Date.now();

  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.search called', {
      query: (input as Record<string, unknown>)?.query,
    });
  }

  // 入力バリデーション
  let validated: LayoutSearchInput;
  try {
    validated = layoutSearchInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.search validation error', {
          errors: error.errors,
        });
      }

      return {
        success: false,
        error: {
          code: LAYOUT_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック
  if (!serviceFactory) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.search service factory not set');
    }

    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Search service is not available',
      },
    };
  }

  const service = serviceFactory();

  try {
    // search_mode ベースのルーティング（text_only以外の場合）
    // search_mode が明示的に指定され、text_only以外の場合はマルチモーダル検索を実行
    if (validated.search_mode && validated.search_mode !== 'text_only') {
      return executeMultimodalSearch(validated, service, startTime);
    }

    // Phase 4-2: Vision検索が有効な場合（レガシー互換性）
    // use_vision_search=true かつ search_mode未指定の場合
    if (validated.use_vision_search && !validated.search_mode) {
      return executeVisionSearch(validated, startTime);
    }

    // 通常の検索（text_embedding）
    // クエリ前処理
    const processedQuery = preprocessQuery(validated.query);

    if (isDevelopment()) {
      logger.debug('[MCP Tool] layout.search processed query', {
        original: validated.query,
        processed: processedQuery,
      });
    }

    // Embedding生成
    const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

    // EmbeddingServiceが利用できない場合は空の結果を返す
    if (queryEmbedding === null) {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] layout.search embedding not available, returning empty results');
      }

      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // 検索オプション構築
    // MCP-RESP-03: include_html (snake_case) を優先使用
    const searchOptions: SearchOptions = {
      filters: validated.filters,
      limit: validated.limit,
      offset: validated.offset,
      include_html: getIncludeHtml(validated),
      project_context: validated.project_context,
    };

    // 検索実行: ハイブリッド検索（vector + fulltext RRF）が利用可能な場合はそちらを使用
    const searchResult = service.searchSectionPatternsHybrid
      ? await service.searchSectionPatternsHybrid(
          validated.query,
          queryEmbedding,
          searchOptions
        )
      : await service.searchSectionPatterns(
          queryEmbedding,
          searchOptions
        );

    // nullチェック
    if (!searchResult) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // TASK-06-3 Step 3: セマンティック検索統合
    // mood/brandTone フィルターに基づいてセマンティック検索を実行
    type SemanticMetadataMap = Map<
      string,
      {
        moodInfo?: { primary: Mood; secondary?: Mood | undefined };
        brandToneInfo?: { primary: BrandTone; secondary?: BrandTone | undefined };
      }
    >;
    const semanticMetadata: SemanticMetadataMap = new Map();

    // moodBrandToneSearchService インスタンスを取得
    let moodBrandToneService: MoodBrandToneSearchService | null = null;
    if (moodBrandToneSearchServiceFactory) {
      moodBrandToneService = moodBrandToneSearchServiceFactory();
    }

    // mood フィルターが提供されている場合、セマンティック検索を実行
    if (moodBrandToneService && validated.filters?.mood) {
      try {
        const moodResults = await moodBrandToneService.searchByMood(
          validated.filters.mood
        );

        if (isDevelopment()) {
          logger.debug('[MCP Tool] layout.search mood search completed', {
            resultCount: moodResults.length,
            mood: validated.filters.mood.primary,
          });
        }

        // 結果をマッピング用に保存
        for (const moodResult of moodResults) {
          const patternId = moodResult.patternId;
          const existing = semanticMetadata.get(patternId) ?? {};
          if (moodResult.moodInfo !== undefined) {
            existing.moodInfo = moodResult.moodInfo;
          }
          semanticMetadata.set(patternId, existing);
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.search mood search failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Graceful degradation: mood 検索失敗時は続行
      }
    }

    // brandTone フィルターが提供されている場合、セマンティック検索を実行
    if (moodBrandToneService && validated.filters?.brandTone) {
      try {
        const brandToneResults = await moodBrandToneService.searchByBrandTone(
          validated.filters.brandTone
        );

        if (isDevelopment()) {
          logger.debug('[MCP Tool] layout.search brandTone search completed', {
            resultCount: brandToneResults.length,
            brandTone: validated.filters.brandTone.primary,
          });
        }

        // 結果をマッピング用に保存
        for (const brandToneResult of brandToneResults) {
          const patternId = brandToneResult.patternId;
          const existing = semanticMetadata.get(patternId) ?? {};
          if (brandToneResult.brandToneInfo !== undefined) {
            existing.brandToneInfo = brandToneResult.brandToneInfo;
          }
          semanticMetadata.set(patternId, existing);
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.search brandTone search failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Graceful degradation: brandTone 検索失敗時は続行
      }
    }

    // ProjectContext解析（オプション）
    let projectPatterns: ProjectPatterns | null = null;
    const projectContextOptions = validated.project_context;
    const isProjectContextEnabled = projectContextOptions?.enabled !== false;

    if (isProjectContextEnabled && projectContextOptions?.project_path) {
      try {
        const analyzer = getProjectContextAnalyzer();
        projectPatterns = await analyzer.detectProjectPatterns(
          projectContextOptions.project_path
        );

        if (isDevelopment()) {
          logger.debug('[MCP Tool] layout.search project patterns detected', {
            stylesCount: projectPatterns.designTokens.styles.length,
            hooksCount: projectPatterns.hooks.length,
            cssFramework: projectPatterns.cssFramework,
            animationsCount: projectPatterns.animations.length,
          });
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.search project context analysis failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // ProjectContext解析失敗時は続行（Graceful degradation）
      }
    }

    // プレビューオプション
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };

    // REFTRIX-LAYOUT-02: auto_detect_context によるコンテキスト推論
    let inferredContext: InferredContext | null = null;
    let contextBoostApplied = false;

    if (validated.auto_detect_context !== false) {
      try {
        const queryAnalyzer = getQueryContextAnalyzer();
        inferredContext = queryAnalyzer.inferContext(validated.query);

        if (isDevelopment()) {
          logger.debug('[MCP Tool] layout.search context inferred', {
            query: validated.query,
            industry: inferredContext.industry,
            style: inferredContext.style,
            confidence: inferredContext.confidence,
            detectedKeywords: inferredContext.detectedKeywords,
          });
        }

        // 信頼度が0.5以上の場合のみブーストを適用
        if (inferredContext.confidence >= 0.5) {
          contextBoostApplied = true;
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.search context inference failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // コンテキスト推論失敗時は続行（Graceful degradation）
      }
    }

    // 結果をマップ（ProjectContext解析が成功した場合はadaptabilityを計算、セマンティックメタデータを含める）
    const mappedResults = searchResult.results.map((r) => {
      let adaptabilityInfo: AdaptabilityInfo | undefined;

      if (projectPatterns && r.htmlSnippet) {
        try {
          const analyzer = getProjectContextAnalyzer();
          const adaptabilityResult = analyzer.calculateAdaptabilityScore(
            r.htmlSnippet,
            projectPatterns
          );
          adaptabilityInfo = {
            score: adaptabilityResult.score,
            hints: adaptabilityResult.integration_hints,
          };
        } catch (error) {
          if (isDevelopment()) {
            logger.warn('[MCP Tool] layout.search adaptability calculation failed', {
              resultId: r.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // 個別の計算失敗は無視して続行
        }
      }

      // TASK-06-3 Step 2: セマンティックメタデータを取得
      const semanticInfo = semanticMetadata.get(r.id);

      // REFTRIX-LAYOUT-02: コンテキストブーストを計算
      let contextBoost: number | undefined;
      if (contextBoostApplied && inferredContext) {
        contextBoost = calculateContextBoost({
          context: inferredContext,
          resultMetadata: {
            heading: r.layoutInfo?.heading,
            description: r.layoutInfo?.description,
            url: r.webPage.url,
            sectionType: r.sectionType,
          },
        });
      }

      return mapSearchResult(r, getIncludeHtml(validated), adaptabilityInfo, semanticInfo, previewOptions, contextBoost);
    });

    // REFTRIX-LAYOUT-02: ブースト適用時は再ソート（similarity + boost で降順）
    if (contextBoostApplied) {
      mappedResults.sort((a, b) => {
        const aTotal = a.similarity + (a.context_boost ?? 0);
        const bTotal = b.similarity + (b.context_boost ?? 0);
        return bTotal - aTotal;
      });

      // ブースト後の類似度を更新（1.0上限）
      for (const result of mappedResults) {
        if (result.context_boost !== undefined && result.context_boost > 0) {
          result.similarity = Math.min(1.0, result.similarity + result.context_boost);
        }
      }
    }

    const searchTimeMs = Date.now() - startTime;

    // TASK-06-3 Step 4: filtersApplied の追跡
    const filtersApplied: string[] = [];
    if (validated.filters) {
      if (validated.filters.mood) {
        filtersApplied.push('mood');
      }
      if (validated.filters.brandTone) {
        filtersApplied.push('brandTone');
      }
      if (validated.filters.visualFeatures) {
        filtersApplied.push('visualFeatures');
      }
      if (validated.filters.sectionType) {
        filtersApplied.push('sectionType');
      }
      if (validated.filters.sourceType) {
        filtersApplied.push('sourceType');
      }
      if (validated.filters.usageScope) {
        filtersApplied.push('usageScope');
      }
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] layout.search completed', {
        query: validated.query,
        resultCount: mappedResults.length,
        total: searchResult.total,
        searchTimeMs,
        filtersApplied,
        contextBoostApplied,
      });
    }

    // REFTRIX-LAYOUT-02: Build inferred_context output
    let inferredContextOutput: InferredContextOutput | undefined;
    if (validated.auto_detect_context !== false && inferredContext) {
      inferredContextOutput = {
        industry: inferredContext.industry,
        style: inferredContext.style,
        confidence: inferredContext.confidence,
        detected_keywords: inferredContext.detectedKeywords,
      };
    }

    return {
      success: true,
      data: {
        results: mappedResults,
        total: searchResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        filtersApplied,
        searchTimeMs,
        inferred_context: inferredContextOutput,
        context_boost_applied: contextBoostApplied,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);

    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.search error', {
        code: errorCode,
        error: errorMessage,
      });
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * layout.search MCPツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const layoutSearchToolDefinition = {
  name: 'layout.search',
  description:
    'セクションパターンを自然言語クエリでセマンティック検索します。' +
    '日本語・英語の両方に対応しています。' +
    'hero、feature、cta、testimonial、pricing、footer等のセクションタイプでフィルタリングできます。' +
    'use_vision_search=trueでvision_embeddingを使用したハイブリッド検索（RRF: 60% vision + 40% text）が可能です。',
  annotations: {
    title: 'Layout Search',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: '検索クエリ（日本語または英語、1-500文字）',
        minLength: 1,
        maxLength: 500,
      },
      filters: {
        type: 'object',
        description: '検索フィルター',
        properties: {
          sectionType: {
            type: 'string',
            enum: [
              'hero',
              'feature',
              'cta',
              'testimonial',
              'pricing',
              'footer',
              'navigation',
              'about',
              'contact',
              'gallery',
            ],
            description: 'セクションタイプでフィルター',
          },
          sourceType: {
            type: 'string',
            enum: ['award_gallery', 'user_provided'],
            description: 'ソースタイプでフィルター（award_gallery: アワードサイト、user_provided: ユーザー提供）',
          },
          usageScope: {
            type: 'string',
            enum: ['inspiration_only', 'owned_asset'],
            description: '利用範囲でフィルター（inspiration_only: インスピレーションのみ、owned_asset: 所有アセット）',
          },
        },
      },
      limit: {
        type: 'number',
        description: '取得件数（1-50、デフォルト: 10）',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      offset: {
        type: 'number',
        description: 'オフセット（0以上、デフォルト: 0）',
        minimum: 0,
        default: 0,
      },
      // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
      include_html: {
        type: 'boolean',
        description: 'HTMLスニペットを含めるか（デフォルト: false）- snake_case正式形式',
        default: false,
      },
      // レガシー互換: camelCaseは後方互換として維持
      includeHtml: {
        type: 'boolean',
        description: 'HTMLスニペットを含めるか（デフォルト: false）- レガシー互換、include_html推奨',
        default: false,
      },
      include_preview: {
        type: 'boolean',
        description: 'サニタイズ済みHTMLプレビューを含めるか（デフォルト: true）',
        default: true,
      },
      preview_max_length: {
        type: 'number',
        description: 'HTMLプレビューの最大文字数（100-1000、デフォルト: 500）',
        minimum: 100,
        maximum: 1000,
        default: 500,
      },
      project_context: {
        type: 'object',
        description: 'プロジェクトコンテキスト解析オプション。プロジェクトのデザインパターンを検出し、検索結果の適合度を評価します。',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'プロジェクトコンテキスト解析を有効化（デフォルト: true）',
            default: true,
          },
          project_path: {
            type: 'string',
            description: 'スキャン対象のプロジェクトパス（例: /home/user/my-project）',
          },
          design_tokens_path: {
            type: 'string',
            description: 'デザイントークンファイルの特定パス（オプション）',
          },
        },
      },
      // Phase 4-3: Auto Context Detection
      auto_detect_context: {
        type: 'boolean',
        description:
          'クエリから業界・スタイルコンテキストを自動推論し、結果をブーストします。推論されたコンテキスト（業界: technology/ecommerce/healthcare等、スタイル: minimal/bold/corporate等）にマッチする結果の類似度スコアが最大0.15ブーストされます（デフォルト: true）',
        default: true,
      },
      // Phase 4-2: Vision Search Parameters
      use_vision_search: {
        type: 'boolean',
        description: 'Vision検索を有効化。vision_embeddingを使用したセマンティック検索を行います（デフォルト: false）',
        default: false,
      },
      vision_search_query: {
        type: 'object',
        description: 'Vision検索クエリ（use_vision_search=true時に使用）',
        properties: {
          textQuery: {
            type: 'string',
            description: 'テキストクエリ（視覚的特徴を自然言語で記述）',
          },
          visualFeatures: {
            type: 'object',
            description: '構造化された視覚的特徴条件',
            properties: {
              theme: { type: 'string', description: 'テーマ（light/dark/mixed）' },
              colors: { type: 'array', items: { type: 'string' }, description: '色指定（HEX形式配列）' },
              density: { type: 'string', description: '密度（sparse/moderate/dense）' },
              gradient: { type: 'string', description: 'グラデーション（none/subtle/prominent）' },
              mood: { type: 'string', description: '雰囲気（professional/playful/minimal等）' },
              brandTone: { type: 'string', description: 'ブランドトーン' },
            },
          },
          sectionPatternId: {
            type: 'string',
            format: 'uuid',
            description: '既存セクションIDで類似検索',
          },
        },
      },
      vision_search_options: {
        type: 'object',
        description: 'Vision検索オプション（use_vision_search=true時に使用）',
        properties: {
          minSimilarity: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.5,
            description: '最小類似度（0-1、デフォルト: 0.5）',
          },
          visionWeight: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.6,
            description: 'RRFでのvision_embeddingの重み（0-1、デフォルト: 0.6）',
          },
          textWeight: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: 'RRFでのtext_embeddingの重み（0-1、デフォルト: 0.4）',
          },
        },
      },
      // Multimodal Search Parameters
      search_mode: {
        type: 'string',
        enum: ['text_only', 'vision_only', 'combined'],
        default: 'text_only',
        description:
          '検索モード。' +
          'text_only: text_embeddingのみを使用（デフォルト）。' +
          'vision_only: vision_embeddingのみを使用。' +
          'combined: 両方を使用してRRF統合検索。',
      },
      multimodal_options: {
        type: 'object',
        description: 'マルチモーダルオプション。search_mode=\'combined\'時のRRF統合パラメータ。',
        properties: {
          textWeight: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.6,
            description: 'text_embeddingの重み（0-1、デフォルト: 0.6）',
          },
          visionWeight: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: 'vision_embeddingの重み（0-1、デフォルト: 0.4）',
          },
          rrfK: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            default: 60,
            description: 'RRFのkパラメータ（1-100、デフォルト: 60）',
          },
        },
      },
    },
    required: ['query'],
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[layout.search] Tool module loaded');
}
