// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query Understanding Service
 * クエリ理解サービス
 *
 * 検索クエリを意味的に理解し、構造化パラメータに変換する。
 * LLM依存なし（ルールベース + embeddingベースの軽量実装）。
 *
 * Semantically understands search queries and converts them to structured parameters.
 * No LLM dependency (rule-based + embedding-based lightweight implementation).
 *
 * Features / 機能:
 * - Query type classification: visual, structural, functional, stylistic
 * - Auto-filter extraction: industry, audience, tags
 * - Query expansion: synonym/related term auto-addition
 *
 * @module services/search/query-understanding.service
 */

import { logger } from "../../utils/logger";

// =====================================================
// Types / 型定義
// =====================================================

/**
 * クエリタイプ / Query type
 *
 * - visual: 見た目・色・画像に関するクエリ
 * - structural: レイアウト構造に関するクエリ
 * - functional: 機能・インタラクションに関するクエリ
 * - stylistic: スタイル・雰囲気に関するクエリ
 */
export type QueryType = "visual" | "structural" | "functional" | "stylistic";

/**
 * 自動抽出されたフィルタ / Auto-extracted filters
 */
export interface ExtractedFilters {
  /** 業種 / Industry */
  industry?: string;
  /** ターゲットオーディエンス / Target audience */
  audience?: string;
  /** タグ / Tags */
  tags?: string[];
}

/**
 * クエリ理解の結果 / Query understanding result
 */
export interface QueryUnderstandingResult {
  /** 元のクエリ / Original query */
  originalQuery: string;
  /** 拡張されたクエリ / Expanded query */
  expandedQuery: string;
  /** クエリタイプ / Query type */
  queryType: QueryType;
  /** 自動抽出されたフィルタ / Auto-extracted filters */
  extractedFilters: ExtractedFilters;
}

// =====================================================
// Query Type Classification / クエリタイプ分類
// =====================================================

/**
 * クエリタイプ分類用のキーワードマッピング
 * Keyword mapping for query type classification
 *
 * 各タイプに関連するキーワードとその重み（1-3）を定義。
 * 重みが高いキーワードはより強い分類シグナルを持つ。
 */
const QUERY_TYPE_KEYWORDS: Record<QueryType, Array<{ keyword: string; weight: number }>> = {
  visual: [
    { keyword: "color", weight: 3 },
    { keyword: "colour", weight: 3 },
    { keyword: "gradient", weight: 3 },
    { keyword: "image", weight: 2 },
    { keyword: "photo", weight: 2 },
    { keyword: "illustration", weight: 2 },
    { keyword: "icon", weight: 2 },
    { keyword: "dark", weight: 2 },
    { keyword: "light", weight: 2 },
    { keyword: "theme", weight: 2 },
    { keyword: "typography", weight: 2 },
    { keyword: "font", weight: 2 },
    { keyword: "bold", weight: 1 },
    { keyword: "shadow", weight: 2 },
    { keyword: "border", weight: 1 },
    { keyword: "rounded", weight: 1 },
    { keyword: "opacity", weight: 2 },
    { keyword: "background", weight: 1 },
    { keyword: "texture", weight: 2 },
    { keyword: "pattern", weight: 1 },
    { keyword: "palette", weight: 3 },
    { keyword: "contrast", weight: 2 },
    { keyword: "white", weight: 1 },
    { keyword: "black", weight: 1 },
    { keyword: "blue", weight: 2 },
    { keyword: "red", weight: 2 },
    { keyword: "green", weight: 2 },
    { keyword: "purple", weight: 2 },
    { keyword: "yellow", weight: 2 },
    { keyword: "orange", weight: 2 },
    { keyword: "pink", weight: 2 },
  ],
  structural: [
    { keyword: "layout", weight: 3 },
    { keyword: "grid", weight: 3 },
    { keyword: "column", weight: 3 },
    { keyword: "row", weight: 2 },
    { keyword: "flexbox", weight: 3 },
    { keyword: "sidebar", weight: 3 },
    { keyword: "header", weight: 3 },
    { keyword: "footer", weight: 3 },
    { keyword: "navbar", weight: 3 },
    { keyword: "navigation", weight: 2 },
    { keyword: "section", weight: 2 },
    { keyword: "container", weight: 2 },
    { keyword: "wrapper", weight: 2 },
    { keyword: "spacing", weight: 2 },
    { keyword: "margin", weight: 2 },
    { keyword: "padding", weight: 2 },
    { keyword: "alignment", weight: 2 },
    { keyword: "centered", weight: 1 },
    { keyword: "sticky", weight: 2 },
    { keyword: "fixed", weight: 2 },
    { keyword: "responsive", weight: 1 },
    { keyword: "breakpoint", weight: 2 },
    { keyword: "stack", weight: 2 },
    { keyword: "split", weight: 2 },
    { keyword: "asymmetric", weight: 2 },
  ],
  functional: [
    { keyword: "button", weight: 3 },
    { keyword: "form", weight: 3 },
    { keyword: "input", weight: 3 },
    { keyword: "dropdown", weight: 3 },
    { keyword: "modal", weight: 3 },
    { keyword: "dialog", weight: 3 },
    { keyword: "popup", weight: 2 },
    { keyword: "carousel", weight: 3 },
    { keyword: "slider", weight: 3 },
    { keyword: "tab", weight: 2 },
    { keyword: "accordion", weight: 3 },
    { keyword: "toggle", weight: 2 },
    { keyword: "animation", weight: 3 },
    { keyword: "transition", weight: 2 },
    { keyword: "hover", weight: 3 },
    { keyword: "click", weight: 2 },
    { keyword: "scroll", weight: 2 },
    { keyword: "interactive", weight: 3 },
    { keyword: "drag", weight: 2 },
    { keyword: "tooltip", weight: 2 },
    { keyword: "notification", weight: 2 },
    { keyword: "toast", weight: 2 },
    { keyword: "menu", weight: 2 },
    { keyword: "search", weight: 1 },
    { keyword: "filter", weight: 1 },
    { keyword: "validation", weight: 2 },
    { keyword: "pagination", weight: 2 },
  ],
  stylistic: [
    { keyword: "minimal", weight: 3 },
    { keyword: "minimalist", weight: 3 },
    { keyword: "clean", weight: 2 },
    { keyword: "modern", weight: 2 },
    { keyword: "professional", weight: 3 },
    { keyword: "corporate", weight: 3 },
    { keyword: "elegant", weight: 3 },
    { keyword: "luxury", weight: 3 },
    { keyword: "playful", weight: 3 },
    { keyword: "fun", weight: 2 },
    { keyword: "creative", weight: 2 },
    { keyword: "artistic", weight: 2 },
    { keyword: "retro", weight: 3 },
    { keyword: "vintage", weight: 3 },
    { keyword: "futuristic", weight: 3 },
    { keyword: "brutalist", weight: 3 },
    { keyword: "glassmorphism", weight: 3 },
    { keyword: "neomorphism", weight: 3 },
    { keyword: "flat", weight: 2 },
    { keyword: "material", weight: 2 },
    { keyword: "organic", weight: 2 },
    { keyword: "geometric", weight: 2 },
    { keyword: "trendy", weight: 2 },
    { keyword: "warm", weight: 2 },
    { keyword: "cool", weight: 1 },
    { keyword: "cozy", weight: 2 },
    { keyword: "bold", weight: 1 },
    { keyword: "subtle", weight: 2 },
    { keyword: "premium", weight: 2 },
    { keyword: "style", weight: 1 },
    { keyword: "feel", weight: 1 },
    { keyword: "mood", weight: 2 },
    { keyword: "vibe", weight: 2 },
    { keyword: "aesthetic", weight: 3 },
  ],
};

/**
 * クエリタイプを分類する / Classify query type
 *
 * クエリ内のキーワードを検出し、重み付きスコアが最も高いタイプを返す。
 * 明示的なタイプ指定がある場合はそれを優先する。
 *
 * Detects keywords in the query and returns the type with the highest weighted score.
 * If an explicit type override is provided, it takes precedence.
 *
 * @param query - 検索クエリ / Search query
 * @param typeOverride - 明示的なタイプ指定（"auto"以外） / Explicit type override (non-"auto")
 * @returns 分類されたクエリタイプ / Classified query type
 */
export function classifyQueryType(query: string, typeOverride?: QueryType): QueryType {
  if (typeOverride) {
    return typeOverride;
  }

  if (!query.trim()) {
    return "visual"; // デフォルト / Default
  }

  const lowerQuery = query.toLowerCase();
  const scores: Record<QueryType, number> = {
    visual: 0,
    structural: 0,
    functional: 0,
    stylistic: 0,
  };

  for (const [type, keywords] of Object.entries(QUERY_TYPE_KEYWORDS) as Array<
    [QueryType, Array<{ keyword: string; weight: number }>]
  >) {
    for (const { keyword, weight } of keywords) {
      if (lowerQuery.includes(keyword)) {
        scores[type] += weight;
      }
    }
  }

  // 最高スコアのタイプを返す
  // Return the type with the highest score
  let maxScore = 0;
  let maxType: QueryType = "visual"; // デフォルト / Default

  for (const [type, score] of Object.entries(scores) as Array<[QueryType, number]>) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type;
    }
  }

  return maxType;
}

// =====================================================
// Filter Extraction / フィルタ抽出
// =====================================================

/**
 * 業種キーワードマッピング / Industry keyword mapping
 */
const INDUSTRY_KEYWORDS: Array<{ pattern: RegExp; industry: string }> = [
  { pattern: /\bsaas\b/i, industry: "SaaS" },
  { pattern: /\be-?commerce\b/i, industry: "E-commerce" },
  { pattern: /\bfintech\b/i, industry: "Fintech" },
  { pattern: /\bhealthcare\b/i, industry: "Healthcare" },
  { pattern: /\bmedical\b/i, industry: "Healthcare" },
  { pattern: /\beducation\b/i, industry: "Education" },
  { pattern: /\bedtech\b/i, industry: "Education" },
  { pattern: /\breal\s*estate\b/i, industry: "Real Estate" },
  { pattern: /\btravel\b/i, industry: "Travel" },
  { pattern: /\bfood\b/i, industry: "Food & Beverage" },
  { pattern: /\brestaurant\b/i, industry: "Food & Beverage" },
  { pattern: /\bfitness\b/i, industry: "Fitness" },
  { pattern: /\bgaming\b/i, industry: "Gaming" },
  { pattern: /\bmusic\b/i, industry: "Music" },
  { pattern: /\bfashion\b/i, industry: "Fashion" },
  { pattern: /\bportfolio\b/i, industry: "Portfolio" },
  { pattern: /\bagency\b/i, industry: "Agency" },
  { pattern: /\bstartup\b/i, industry: "Startup" },
  { pattern: /\bnews\b/i, industry: "News & Media" },
  { pattern: /\bmedia\b/i, industry: "News & Media" },
  { pattern: /\bblog\b/i, industry: "Blog" },
];

/**
 * オーディエンスキーワードマッピング / Audience keyword mapping
 */
const AUDIENCE_KEYWORDS: Array<{ pattern: RegExp; audience: string }> = [
  { pattern: /\bdeveloper\b/i, audience: "Developer" },
  { pattern: /\bdev\b/i, audience: "Developer" },
  { pattern: /\benterprise\b/i, audience: "Enterprise" },
  { pattern: /\bb2b\b/i, audience: "Enterprise" },
  { pattern: /\bconsumer\b/i, audience: "Consumer" },
  { pattern: /\bb2c\b/i, audience: "Consumer" },
  { pattern: /\bstudent\b/i, audience: "Student" },
  { pattern: /\bchild(ren)?\b/i, audience: "Children" },
  { pattern: /\bkid(s)?\b/i, audience: "Children" },
  { pattern: /\bsenior\b/i, audience: "Senior" },
  { pattern: /\bdesigner\b/i, audience: "Designer" },
  { pattern: /\bmarketer\b/i, audience: "Marketer" },
  { pattern: /\bsmall\s*business\b/i, audience: "Small Business" },
  { pattern: /\bsmb\b/i, audience: "Small Business" },
  { pattern: /\bfreelancer?\b/i, audience: "Freelancer" },
  { pattern: /\bcreator\b/i, audience: "Creator" },
];

/**
 * タグキーワードマッピング / Tag keyword mapping
 */
const TAG_KEYWORDS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bresponsive\b/i, tag: "responsive" },
  { pattern: /\bmobile[- ]?first\b/i, tag: "mobile-first" },
  { pattern: /\baccessib(le|ility)\b/i, tag: "accessibility" },
  { pattern: /\bwcag\b/i, tag: "accessibility" },
  { pattern: /\ba11y\b/i, tag: "accessibility" },
  { pattern: /\blanding[- ]?page\b/i, tag: "landing-page" },
  { pattern: /\bdashboard\b/i, tag: "dashboard" },
  { pattern: /\bpricing\b/i, tag: "pricing" },
  { pattern: /\babout\b/i, tag: "about" },
  { pattern: /\bcontact\b/i, tag: "contact" },
  { pattern: /\bsign[- ]?up\b/i, tag: "signup" },
  { pattern: /\blogin\b/i, tag: "login" },
  { pattern: /\bonboarding\b/i, tag: "onboarding" },
  { pattern: /\b404\b/i, tag: "error-page" },
  { pattern: /\berror[- ]?page\b/i, tag: "error-page" },
  { pattern: /\bdark[- ]?mode\b/i, tag: "dark-mode" },
  { pattern: /\banimated\b/i, tag: "animated" },
  { pattern: /\billustrat(ion|ed)\b/i, tag: "illustration" },
  { pattern: /\b3d\b/i, tag: "3d" },
  { pattern: /\bvideo\b/i, tag: "video" },
  { pattern: /\bparallax\b/i, tag: "parallax" },
  { pattern: /\bsingle[- ]?page\b/i, tag: "single-page" },
  { pattern: /\bmulti[- ]?page\b/i, tag: "multi-page" },
  { pattern: /\bcms\b/i, tag: "cms" },
];

/**
 * クエリからフィルタを自動抽出する / Auto-extract filters from query
 *
 * @param query - 検索クエリ / Search query
 * @returns 抽出されたフィルタ / Extracted filters
 */
export function extractFilters(query: string): ExtractedFilters {
  const result: ExtractedFilters = {};

  if (!query.trim()) {
    return result;
  }

  // Industry抽出 / Extract industry
  for (const { pattern, industry } of INDUSTRY_KEYWORDS) {
    if (pattern.test(query)) {
      result.industry = industry;
      break;
    }
  }

  // Audience抽出 / Extract audience
  for (const { pattern, audience } of AUDIENCE_KEYWORDS) {
    if (pattern.test(query)) {
      result.audience = audience;
      break;
    }
  }

  // Tags抽出 / Extract tags
  const tags: string[] = [];
  for (const { pattern, tag } of TAG_KEYWORDS) {
    if (pattern.test(query) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  if (tags.length > 0) {
    result.tags = tags;
  }

  return result;
}

// =====================================================
// Query Expansion / クエリ拡張
// =====================================================

/**
 * 同義語・関連語マッピング / Synonym/related term mapping
 *
 * キー: 検出するキーワード
 * 値: 追加する関連語の配列
 */
const EXPANSION_MAP: Record<string, string[]> = {
  hero: ["banner", "above-the-fold", "main-visual", "key-visual"],
  cta: ["call-to-action", "conversion", "action-button"],
  nav: ["navigation", "menu", "navbar"],
  navbar: ["navigation", "menu", "header-nav"],
  footer: ["bottom-section", "site-footer"],
  testimonial: ["review", "customer-feedback", "social-proof"],
  pricing: ["plans", "subscription", "tier"],
  faq: ["frequently-asked-questions", "help", "support"],
  gallery: ["portfolio", "showcase", "image-grid"],
  card: ["tile", "panel", "content-block"],
  carousel: ["slider", "swiper", "slideshow"],
  modal: ["dialog", "popup", "overlay"],
  sidebar: ["side-navigation", "drawer", "side-panel"],
  breadcrumb: ["navigation-trail", "path-indicator"],
  pagination: ["page-navigation", "pager"],
  accordion: ["collapsible", "expandable", "toggle-panel"],
  tab: ["tabbed-content", "tab-panel"],
  signup: ["registration", "sign-up", "onboarding"],
  login: ["sign-in", "authentication"],
  search: ["search-bar", "search-field", "autocomplete"],
  dashboard: ["admin-panel", "control-panel", "analytics"],
};

/**
 * クエリを拡張する（同義語・関連語の自動付与） / Expand query with synonyms/related terms
 *
 * ルールベースで同義語・関連語を付与する。
 * 重複する拡張語は追加しない。
 *
 * Rule-based synonym/related term expansion.
 * Does not add duplicate expansion terms.
 *
 * @param query - 検索クエリ / Search query
 * @returns 拡張されたクエリ / Expanded query
 */
export function expandQuery(query: string): string {
  if (!query.trim()) {
    return query;
  }

  const lowerQuery = query.toLowerCase();
  const lowerQueryWords = new Set(lowerQuery.split(/\s+/));
  const expansions: string[] = [];

  for (const [keyword, relatedTerms] of Object.entries(EXPANSION_MAP)) {
    if (lowerQueryWords.has(keyword) || lowerQuery.includes(keyword)) {
      for (const term of relatedTerms) {
        // 既にクエリに含まれている場合は追加しない
        // Don't add if already in query
        if (!lowerQuery.includes(term.toLowerCase()) && !expansions.includes(term)) {
          expansions.push(term);
        }
      }
    }
  }

  if (expansions.length === 0) {
    return query;
  }

  return `${query} ${expansions.join(" ")}`;
}

// =====================================================
// Query Understanding / クエリ理解（統合）
// =====================================================

/**
 * クエリを理解して構造化パラメータに変換する / Understand query and convert to structured parameters
 *
 * 以下の3つの処理を統合して実行する:
 * 1. クエリタイプ分類
 * 2. フィルタ自動抽出
 * 3. クエリ拡張
 *
 * Integrates 3 processing steps:
 * 1. Query type classification
 * 2. Auto-filter extraction
 * 3. Query expansion
 *
 * @param query - 検索クエリ / Search query
 * @param queryTypeOverride - クエリタイプのオーバーライド / Query type override
 * @returns クエリ理解の結果 / Query understanding result
 */
export function understandQuery(
  query: string,
  queryTypeOverride?: QueryType
): QueryUnderstandingResult {
  const queryType = classifyQueryType(query, queryTypeOverride);
  const extractedFilters = extractFilters(query);
  const expandedQuery = expandQuery(query);

  logger.info("[QueryUnderstanding] Query analyzed", {
    originalQuery: query.substring(0, 50),
    queryType,
    hasFilters:
      !!extractedFilters.industry || !!extractedFilters.audience || !!extractedFilters.tags,
    expanded: expandedQuery.length > query.length,
  });

  return {
    originalQuery: query,
    expandedQuery,
    queryType,
    extractedFilters,
  };
}
