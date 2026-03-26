// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search ヘルパー関数・型定義
 * search.tool.ts から分離された型定義、ユーティリティ関数、マッピング関数
 *
 * @module tools/layout/search-helpers
 */

import { sanitizeHtml } from "../../utils/html-sanitizer";
import {
  LAYOUT_MCP_ERROR_CODES,
  type LayoutSearchInput,
  type LayoutSearchResultItem,
  type LayoutSearchFilters,
  type ProjectContextOptions,
  type IntegrationHints,
} from "./schemas";
import type {
  VisionSearchQuery,
  VisionSearchOptions,
  VisionSearchServiceResult,
  HybridSearchOptions,
} from "../../services/vision-embedding-search.service";
import type { VisionSearchResult } from "../../services/vision-embedding-search.service";
import type { Mood, BrandTone } from "../../schemas/mood-brandtone-filters";

// =====================================================
// 型定義
// =====================================================

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
  type: "light" | "dark" | "mixed";
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
    query: VisionSearchQuery,
    options: VisionSearchOptions
  ) => Promise<VisionSearchServiceResult | null>;

  /**
   * ハイブリッド検索（text_embedding + vision_embedding）
   * RRF (Reciprocal Rank Fusion) で結果を統合
   */
  hybridSearch: (
    textQuery: string,
    visionQuery: VisionSearchQuery,
    options: HybridSearchOptions
  ) => Promise<VisionSearchServiceResult | null>;
}

// =====================================================
// ヘルパー型定義
// =====================================================

/**
 * Adaptability情報（オプション）
 */
export interface AdaptabilityInfo {
  score: number;
  hints: IntegrationHints;
}

/**
 * HTMLプレビュー生成オプション
 */
export interface PreviewOptions {
  /** プレビューを含めるか（デフォルト: true） */
  includePreview: boolean;
  /** プレビューの最大文字数（デフォルト: 500） */
  maxLength: number;
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
  let normalized = query.replace(/\u3000/g, " ");

  // 2. 改行・タブを空白に変換
  normalized = normalized.replace(/[\n\t\r]/g, " ");

  // 3. 連続する空白を1つに正規化
  normalized = normalized.replace(/\s+/g, " ");

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
export function determineErrorCode(error: Error | string): string {
  const message = typeof error === "string" ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // Embeddingエラー
  if (
    lowerMessage.includes("embedding") ||
    lowerMessage.includes("model") ||
    lowerMessage.includes("tensor")
  ) {
    return "EMBEDDING_ERROR";
  }

  // データベースエラー
  if (
    lowerMessage.includes("database") ||
    lowerMessage.includes("prisma") ||
    lowerMessage.includes("connection")
  ) {
    return LAYOUT_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  // タイムアウトエラー
  if (lowerMessage.includes("timeout")) {
    return LAYOUT_MCP_ERROR_CODES.TIMEOUT;
  }

  // その他は内部エラー
  return LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// HTMLプレビュー生成
// =====================================================

/**
 * HTMLスニペットからサニタイズ済みプレビューを生成
 *
 * @param htmlSnippet - 元のHTMLスニペット
 * @param maxLength - 最大文字数
 * @returns サニタイズ・切り詰め済みHTMLプレビューと元の長さ
 */
export function generateHtmlPreview(
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
    const lastOpenTagIndex = htmlPreview.lastIndexOf("<");
    const lastCloseTagIndex = htmlPreview.lastIndexOf(">");

    if (lastOpenTagIndex > lastCloseTagIndex) {
      // 不完全なタグがある場合、その前まで切り詰め
      htmlPreview = htmlPreview.substring(0, lastOpenTagIndex);
    }

    // 省略記号を追加
    htmlPreview = htmlPreview.trimEnd() + "...";
  }

  return { htmlPreview, previewLength };
}

// =====================================================
// 入力ヘルパー
// =====================================================

/**
 * バリデーション済み入力からinclude_htmlを取得
 * MCP-RESP-03: snake_case (include_html) を優先し、camelCase (includeHtml) はフォールバック
 */
export function getIncludeHtml(validated: LayoutSearchInput): boolean {
  // snake_case優先
  if (validated.include_html !== undefined) {
    return validated.include_html;
  }
  // camelCaseフォールバック（後方互換）
  return validated.includeHtml ?? false;
}

// =====================================================
// 結果マッピング
// =====================================================

/**
 * 検索結果をMCPレスポンス形式にマップ
 * @param result - 検索結果
 * @param include_html - HTMLを含めるか（snake_case正式形式）
 */
export function mapSearchResult(
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
  const preview: LayoutSearchResultItem["preview"] = {};

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
      type: result.webPage.sourceType as "award_gallery" | "user_provided",
      usageScope: result.webPage.usageScope as "inspiration_only" | "owned_asset",
    },
  };

  // HTMLを含める場合
  if (include_html && result.htmlSnippet) {
    item.html = sanitizeHtml(result.htmlSnippet);
  }

  // HTMLプレビューを含める場合（デフォルト有効）
  const shouldIncludePreview = previewOptions?.includePreview ?? true;
  const maxLength = previewOptions?.maxLength ?? 500;

  if (shouldIncludePreview && result.htmlSnippet) {
    const { htmlPreview, previewLength } = generateHtmlPreview(result.htmlSnippet, maxLength);
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
// Vision結果マッピング
// =====================================================

/**
 * VisionSearchResult を SearchResult に変換
 */
export function mapVisionResultToSearchResult(visionResult: VisionSearchResult): SearchResult {
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
    const layoutInfo: NonNullable<SearchResult["layoutInfo"]> = {};
    if (typeof layoutInfoSrc["type"] === "string") {
      layoutInfo.type = layoutInfoSrc["type"];
    }
    if (typeof layoutInfoSrc["heading"] === "string") {
      layoutInfo.heading = layoutInfoSrc["heading"];
    }
    if (typeof layoutInfoSrc["description"] === "string") {
      layoutInfo.description = layoutInfoSrc["description"];
    }
    if (layoutInfoSrc["grid"] !== undefined) {
      layoutInfo.grid = layoutInfoSrc["grid"];
    }
    if (layoutInfoSrc["visionAnalysis"] !== undefined) {
      layoutInfo.visionAnalysis = layoutInfoSrc["visionAnalysis"] as VisionAnalysisResult;
    }
    if (layoutInfoSrc["visualFeatures"] !== undefined) {
      layoutInfo.visualFeatures = layoutInfoSrc["visualFeatures"] as VisualFeatures;
    }
    result.layoutInfo = layoutInfo;
  }
  // visualFeatures: 存在する場合にオブジェクトを構築
  // VisualFeaturesはtheme?, colors?, density?の複合型
  if (visionResult.visualFeatures !== undefined) {
    const vfSrc = visionResult.visualFeatures;
    const visualFeatures: VisualFeatures = {};
    // theme: VisualFeaturesTheme型（type, backgroundColor, textColor, contrastRatio, luminance, source, confidence）
    if (vfSrc["theme"] !== undefined && typeof vfSrc["theme"] === "object") {
      visualFeatures.theme = vfSrc["theme"] as VisualFeaturesTheme;
    }
    // colors: VisualFeaturesColors型（dominant?, accent?, palette?）
    if (vfSrc["colors"] !== undefined && typeof vfSrc["colors"] === "object") {
      visualFeatures.colors = vfSrc["colors"] as VisualFeaturesColors;
    }
    // density: VisualFeaturesDensity型（contentDensity?, whitespaceRatio?, visualBalance?）
    if (vfSrc["density"] !== undefined && typeof vfSrc["density"] === "object") {
      visualFeatures.density = vfSrc["density"] as VisualFeaturesDensity;
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

// =====================================================
// RRF / 検索モード判定
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
  requestedMode: "text_only" | "vision_only" | "combined",
  hasVisionService: boolean,
  hasVisionEmbeddings: boolean = true
): { actualMode: "text_only" | "vision_only" | "combined"; warnings: string[] } {
  const warnings: string[] = [];

  // text_only は常にそのまま
  if (requestedMode === "text_only") {
    return { actualMode: "text_only", warnings };
  }

  // VisionSearchServiceが利用不可
  if (!hasVisionService) {
    if (requestedMode === "vision_only") {
      warnings.push("VisionSearchService unavailable, falling back to text_only");
    } else if (requestedMode === "combined") {
      warnings.push("VisionSearchService unavailable, falling back to text_only");
    }
    return { actualMode: "text_only", warnings };
  }

  // vision_embeddingが存在しない
  if (!hasVisionEmbeddings) {
    if (requestedMode === "vision_only") {
      warnings.push("vision_embedding not available, falling back to text_only");
    } else if (requestedMode === "combined") {
      warnings.push("No vision embeddings available, falling back to text_only");
    }
    return { actualMode: "text_only", warnings };
  }

  // 要求されたモードをそのまま使用
  return { actualMode: requestedMode, warnings };
}
