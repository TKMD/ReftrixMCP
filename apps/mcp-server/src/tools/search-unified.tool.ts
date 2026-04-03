// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * search.unified MCPツール / search.unified MCP Tool
 *
 * Part/Section(Layout)/Motion/Background/Narrativeを横断的に検索する統一エンドポイント。
 * 既存の個別検索サービスをオーケストレーションし、
 * 結果をスコア順にマージして返却します。
 *
 * Cross-component unified search endpoint that orchestrates
 * layout.search, part.search, motion.search, background.search,
 * and narrative.search in parallel, merging results by similarity score.
 *
 * @module tools/search-unified.tool
 */

import { z } from "zod";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { layoutSearchHandler } from "./layout/search.tool";
import { partSearchHandler } from "./part/search.tool";
import { motionSearchHandler } from "./motion/search.tool";
import { backgroundSearchHandler } from "./background/search.tool";
import { narrativeSearchHandler } from "./narrative/search.tool";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../services/search-cache.service";
import { understandQuery, type QueryType } from "../services/search/query-understanding.service";
import { applyCrossEncoderReranking } from "../services/search/cross-encoder-rerank.service";
import {
  computeFacetsFromResults,
  SUPPORTED_FACET_FIELDS,
  type FacetCounts,
  type FacetField,
} from "../services/facet.service";
import { logSearch } from "../services/search-log.service";

// ============================================================================
// Input Schema
// ============================================================================

/**
 * 検索対象タイプ / Search target types
 */
const searchTargetTypeSchema = z.enum(["layout", "part", "motion", "background", "narrative"]);

/**
 * ファセットフィールドスキーマ / Facet field schema
 */
const facetFieldSchema = z.enum(["sectionType", "industry", "audience", "tags"]);

/**
 * search.unified 入力スキーマ / search.unified input schema
 */
export const searchUnifiedInputSchema = z.object({
  /** 検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars) */
  query: z.string().min(1).max(500),
  /** 検索対象タイプ（デフォルト: 全タイプ） / Target types (default: all types) */
  types: z.array(searchTargetTypeSchema).min(1).optional(),
  /** 取得件数（1-50、デフォルト: 10） / Result limit (1-50, default: 10) */
  limit: z.number().int().min(1).max(50).default(10),
  /** WebページIDでフィルター / Filter by web page ID */
  webPageId: z.string().uuid().optional(),
  /** 業種フィルター / Industry filter */
  industry: z.string().max(100).optional(),
  /** ターゲットオーディエンスフィルター / Target audience filter */
  audience: z.string().max(100).optional(),
  /** タグフィルター / Tags filter */
  tags: z.array(z.string()).max(10).optional(),
  /** 嗜好プロファイルID / Preference profile ID */
  profile_id: z.string().uuid().optional(),
  /** Cross-Encoderリランキング有効化（デフォルト: true） / Enable Cross-Encoder reranking (default: true) */
  enable_reranking: z.boolean().default(true),
  /** クエリタイプ（auto: 自動分類） / Query type (auto: auto-classify) */
  query_type: z.enum(["auto", "visual", "structural", "functional", "stylistic"]).default("auto"),
  /** ファセットカウント付与（デフォルト: false） / Include facet counts (default: false) */
  include_facets: z.boolean().default(false),
  /** ファセットフィールド指定（指定時はinclude_facetsが暗黙的にtrue） / Facet fields (implicitly enables include_facets when specified) */
  facet_fields: z.array(facetFieldSchema).min(1).optional(),
});
export type SearchUnifiedInput = z.infer<typeof searchUnifiedInputSchema>;

// ============================================================================
// Output Types
// ============================================================================

/**
 * 統一検索結果アイテム / Unified search result item
 */
export interface UnifiedSearchResultItem {
  /** 結果タイプ / Result type */
  type: "layout" | "part" | "motion" | "background" | "narrative";
  /** レコードID / Record ID */
  id: string;
  /** 類似度スコア / Similarity score */
  similarity: number;
  /** 追加情報 / Additional info */
  metadata: Record<string, unknown>;
}

/**
 * search.unified 出力型 / search.unified output type
 */
export type SearchUnifiedOutput =
  | {
      success: true;
      data: {
        results: UnifiedSearchResultItem[];
        total: number;
        query: string;
        searchTimeMs: number;
        /** 各タイプの検索結果数 / Result count per type */
        breakdown: {
          layout: number;
          part: number;
          motion: number;
          background: number;
          narrative: number;
        };
        /** セマンティック検索メタデータ / Semantic search metadata */
        semantic?: {
          /** 分類されたクエリタイプ / Classified query type */
          queryType: string;
          /** 拡張クエリが使用されたか / Whether expanded query was used */
          queryExpanded: boolean;
          /** 自動抽出されたフィルタ / Auto-extracted filters */
          extractedFilters: Record<string, unknown>;
          /** リランキングが適用されたか / Whether reranking was applied */
          reranked: boolean;
          /** リランキング手法 / Reranking method */
          rerankMethod: string;
        };
        /** ファセットカウント（include_facets: true時のみ） / Facet counts (only when include_facets: true) */
        facets?: FacetCounts | undefined;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// ============================================================================
// Error Codes
// ============================================================================

export const UNIFIED_SEARCH_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SEARCH_FAILED: "SEARCH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ============================================================================
// Handler
// ============================================================================

/**
 * search.unified ツールハンドラー / search.unified tool handler
 *
 * layout.search, part.search, motion.search を並列実行し、
 * 結果をsimilarityスコア降順でマージして返却。
 *
 * Executes layout.search, part.search, and motion.search in parallel,
 * merging results by descending similarity score.
 */
export async function searchUnifiedHandler(input: unknown): Promise<SearchUnifiedOutput> {
  const startTime = Date.now();

  // 1. 入力バリデーション / Input validation
  let validated: SearchUnifiedInput;
  try {
    validated = searchUnifiedInputSchema.parse(input);
  } catch (error) {
    logger.warn("[search.unified] Validation error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR,
        message: "Validation error",
      },
    };
  }

  const types = validated.types ?? ["layout", "part", "motion", "background", "narrative"];

  // 2. クエリ理解 / Query Understanding
  const queryTypeOverride =
    validated.query_type !== "auto" ? (validated.query_type as QueryType) : undefined;
  const queryUnderstanding = understandQuery(validated.query, queryTypeOverride);

  // 自動抽出フィルタをマージ（明示指定が優先） / Merge auto-extracted filters (explicit takes precedence)
  const effectiveInput: SearchUnifiedInput = {
    ...validated,
    // 拡張クエリを使用 / Use expanded query
    query: queryUnderstanding.expandedQuery,
    // 明示指定がない場合は自動抽出フィルタを使用 / Use auto-extracted filters if not explicitly specified
    industry: validated.industry ?? queryUnderstanding.extractedFilters.industry,
    audience: validated.audience ?? queryUnderstanding.extractedFilters.audience,
    tags: validated.tags ?? queryUnderstanding.extractedFilters.tags,
  };

  // キャッシュチェック / Cache check
  const cacheKey = generateCacheKey(
    "search.unified",
    effectiveInput as unknown as Record<string, unknown>
  );
  const cached = getCachedResult<SearchUnifiedOutput>(cacheKey);
  if (cached) {
    // キャッシュヒット時も検索ログ記録（fire-and-forget）
    // Log search on cache hit too (fire-and-forget)
    logSearch({
      query: validated.query,
      queryType: queryUnderstanding.queryType,
      services: types,
      resultCount: cached.success ? cached.data.total : 0,
      latencyMs: Date.now() - startTime,
      cacheHit: true,
      profileId: validated.profile_id,
    }).catch(() => {
      // fire-and-forget
    });
    return cached;
  }

  // 3. 並列検索実行 / Execute searches in parallel
  const layoutPromise = types.includes("layout")
    ? searchLayout(effectiveInput)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const partPromise = types.includes("part")
    ? searchPart(effectiveInput)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const motionPromise = types.includes("motion")
    ? searchMotion(effectiveInput)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const backgroundPromise = types.includes("background")
    ? searchBackground(effectiveInput)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const narrativePromise = types.includes("narrative")
    ? searchNarrative(effectiveInput)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  try {
    const [layoutResults, partResults, motionResults, backgroundResults, narrativeResults] =
      await Promise.all([
        layoutPromise,
        partPromise,
        motionPromise,
        backgroundPromise,
        narrativePromise,
      ]);

    // 4. 結果マージ（similarity降順）/ Merge results by similarity desc
    let allResults = [
      ...layoutResults,
      ...partResults,
      ...motionResults,
      ...backgroundResults,
      ...narrativeResults,
    ].sort((a, b) => b.similarity - a.similarity);

    // 5. Cross-Encoder リランキング / Cross-Encoder Reranking
    let rerankApplied = false;
    let rerankMethod = "none";

    if (validated.enable_reranking && allResults.length > 1) {
      try {
        const rerankResult = await applyCrossEncoderReranking(
          allResults,
          validated.query, // 元のクエリを使用 / Use original query
          undefined, // queryEmbeddingは現在未対応（検索サービス内で生成済み）
          { alpha: 0.5 }
        );
        if (rerankResult.reranked) {
          allResults = rerankResult.items;
          rerankApplied = true;
          rerankMethod = rerankResult.method;
        }
      } catch (rerankError) {
        // Graceful Degradation: リランキング失敗時は元の順序を維持
        // Graceful Degradation: maintain original order on reranking failure
        logger.warn("[search.unified] Cross-encoder reranking failed, using original order", {
          error: rerankError instanceof Error ? rerankError.message : String(rerankError),
        });
      }
    }

    // 6. ファセットカウント算出（limit適用前の全結果対象、オプション）
    // Compute facet counts from all results BEFORE limit (optional)
    const shouldComputeFacets = validated.include_facets || validated.facet_fields != null;
    let facets: FacetCounts | undefined;
    if (shouldComputeFacets) {
      const facetFields: FacetField[] =
        validated.facet_fields ?? ([...SUPPORTED_FACET_FIELDS] as FacetField[]);
      facets = computeFacetsFromResults(allResults, facetFields);
    }

    // limitを適用 / Apply limit
    allResults = allResults.slice(0, validated.limit);

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[search.unified] Search completed", {
        query: validated.query.substring(0, 50),
        types,
        totalResults: allResults.length,
        breakdown: {
          layout: layoutResults.length,
          part: partResults.length,
          motion: motionResults.length,
          background: backgroundResults.length,
          narrative: narrativeResults.length,
        },
        searchTimeMs,
        queryType: queryUnderstanding.queryType,
        queryExpanded: queryUnderstanding.expandedQuery.length > validated.query.length,
        reranked: rerankApplied,
      });
    }

    const result: SearchUnifiedOutput = {
      success: true,
      data: {
        results: allResults,
        total: allResults.length,
        query: validated.query,
        searchTimeMs,
        breakdown: {
          layout: layoutResults.length,
          part: partResults.length,
          motion: motionResults.length,
          background: backgroundResults.length,
          narrative: narrativeResults.length,
        },
        semantic: {
          queryType: queryUnderstanding.queryType,
          queryExpanded: queryUnderstanding.expandedQuery.length > validated.query.length,
          extractedFilters: queryUnderstanding.extractedFilters as Record<string, unknown>,
          reranked: rerankApplied,
          rerankMethod,
        },
        facets,
      },
    };

    setCachedResult(cacheKey, result);

    // 7. 検索ログ記録（fire-and-forget） / Log search (fire-and-forget)
    logSearch({
      query: validated.query,
      queryType: queryUnderstanding.queryType,
      services: types,
      resultCount: allResults.length,
      topResultId: allResults[0]?.id,
      filters: {
        industry: validated.industry,
        audience: validated.audience,
        tags: validated.tags,
        webPageId: validated.webPageId,
      },
      latencyMs: searchTimeMs,
      cacheHit: false,
      profileId: validated.profile_id,
    }).catch(() => {
      // fire-and-forget: エラーは logSearch 内部で処理済み
    });

    return result;
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    logger.warn("[search.unified] Search failed", {
      error: sanitizeErrorMessage(errorInstance),
    });

    return {
      success: false,
      error: {
        code: UNIFIED_SEARCH_ERROR_CODES.SEARCH_FAILED,
        message: sanitizeErrorMessage(errorInstance),
      },
    };
  }
}

// ============================================================================
// Individual Search Adapters
// ============================================================================

/**
 * layout.search を呼び出して統一形式に変換
 * Call layout.search and convert to unified format
 */
async function searchLayout(input: SearchUnifiedInput): Promise<UnifiedSearchResultItem[]> {
  try {
    const filters: Record<string, unknown> = {};
    if (input.webPageId) filters.webPageId = input.webPageId;
    if (input.industry) filters.industry = input.industry;
    if (input.audience) filters.audience = input.audience;
    if (input.tags) filters.tags = input.tags;
    const result = (await layoutSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          sectionType?: string;
          webPageUrl?: string;
        }>;
      };
    };

    if (!result.success || !result.data) return [];

    return result.data.results.map((r) => ({
      type: "layout" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        sectionType: r.sectionType,
        webPageUrl: r.webPageUrl,
      },
    }));
  } catch (error) {
    logger.warn("[search.unified] layout search failed", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * part.search を呼び出して統一形式に変換
 * Call part.search and convert to unified format
 */
async function searchPart(input: SearchUnifiedInput): Promise<UnifiedSearchResultItem[]> {
  try {
    const result = (await partSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      web_page_id: input.webPageId,
      industry: input.industry,
      audience: input.audience,
      tags: input.tags,
    })) as {
      success: boolean;
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          partType?: string;
          webPageUrl?: string;
        }>;
      };
    };

    if (!result.success || !result.data) return [];

    return result.data.results.map((r) => ({
      type: "part" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        partType: r.partType,
        webPageUrl: r.webPageUrl,
      },
    }));
  } catch (error) {
    logger.warn("[search.unified] part search failed", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * motion.search を呼び出して統一形式に変換
 * Call motion.search and convert to unified format
 */
async function searchMotion(input: SearchUnifiedInput): Promise<UnifiedSearchResultItem[]> {
  try {
    const motionFilters: Record<string, unknown> = {};
    if (input.webPageId) motionFilters.webPageId = input.webPageId;
    if (input.industry) motionFilters.industry = input.industry;
    if (input.audience) motionFilters.audience = input.audience;
    if (input.tags) motionFilters.tags = input.tags;
    const result = (await motionSearchHandler({
      action: "search",
      query: input.query,
      limit: input.limit,
      minSimilarity: 0.3,
      filters: Object.keys(motionFilters).length > 0 ? motionFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      data?: {
        results: Array<{
          pattern: { name?: string; type?: string };
          similarity: number;
          source?: { pageId?: string; url?: string };
        }>;
      };
    };

    if (!result.success || !result.data) return [];

    // motion結果はnested structureのため適応変換
    // Motion results have nested structure, adapt accordingly
    return result.data.results.map((r, idx) => ({
      type: "motion" as const,
      id: r.source?.pageId ?? `motion-${idx}`,
      similarity: r.similarity,
      metadata: {
        patternName: r.pattern?.name,
        patternType: r.pattern?.type,
        sourceUrl: r.source?.url,
      },
    }));
  } catch (error) {
    logger.warn("[search.unified] motion search failed", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * background.search を呼び出して統一形式に変換
 * Call background.search and convert to unified format
 */
async function searchBackground(input: SearchUnifiedInput): Promise<UnifiedSearchResultItem[]> {
  try {
    const bgFilters: Record<string, unknown> = {};
    if (input.webPageId) bgFilters.webPageId = input.webPageId;
    if (input.industry) bgFilters.industry = input.industry;
    if (input.audience) bgFilters.audience = input.audience;
    if (input.tags) bgFilters.tags = input.tags;
    const result = (await backgroundSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      filters: Object.keys(bgFilters).length > 0 ? bgFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          designType?: string;
          source?: { webPageId?: string };
          name?: string;
        }>;
      };
    };

    if (!result.success || !result.data) return [];

    return result.data.results.map((r) => ({
      type: "background" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        designType: r.designType,
        webPageId: r.source?.webPageId,
        name: r.name,
      },
    }));
  } catch (error) {
    logger.warn("[search.unified] background search failed", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * narrative.search を呼び出して統一形式に変換
 * Call narrative.search and convert to unified format
 */
async function searchNarrative(input: SearchUnifiedInput): Promise<UnifiedSearchResultItem[]> {
  try {
    const narrativeFilters: Record<string, unknown> = {};
    if (input.webPageId) narrativeFilters.webPageId = input.webPageId;
    if (input.industry) narrativeFilters.industry = input.industry;
    if (input.audience) narrativeFilters.audience = input.audience;
    if (input.tags) narrativeFilters.tags = input.tags;
    const result = (await narrativeSearchHandler({
      query: input.query,
      options: { limit: input.limit },
      filters: Object.keys(narrativeFilters).length > 0 ? narrativeFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          webPageId?: string;
          sourceUrl?: string;
          worldView?: { moodCategory?: string; moodDescription?: string };
        }>;
      };
    };

    if (!result.success || !result.data) return [];

    return result.data.results.map((r) => ({
      type: "narrative" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        webPageId: r.webPageId,
        sourceUrl: r.sourceUrl,
        moodCategory: r.worldView?.moodCategory,
        moodDescription: r.worldView?.moodDescription,
      },
    }));
  } catch (error) {
    logger.warn("[search.unified] narrative search failed", {
      error: (error as Error).message,
    });
    return [];
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * search.unified MCPツール定義 / search.unified MCP tool definition
 */
export const searchUnifiedToolDefinition = {
  name: "search.unified",
  description:
    "Layout（セクション）・Part（UIコンポーネント）・Motion（アニメーション）・Background（背景デザイン）・Narrative（世界観）を横断的にセマンティック検索します。" +
    "個別検索ツールを並列実行し、結果をsimilarityスコア順にマージして返却します。" +
    " / Cross-component semantic search across Layout sections, UI Parts, Motion patterns, Background designs, and Narratives. " +
    "Executes individual search tools in parallel and merges results by similarity score.",
  annotations: {
    title: "Unified Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars)",
        minLength: 1,
        maxLength: 500,
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: ["layout", "part", "motion", "background", "narrative"],
        },
        description: "検索対象タイプ（デフォルト: 全タイプ） / Target types (default: all types)",
      },
      limit: {
        type: "number",
        description: "取得件数（1-50、デフォルト: 10） / Result limit (1-50, default: 10)",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      webPageId: {
        type: "string",
        format: "uuid",
        description: "WebページIDでフィルター / Filter by web page ID",
      },
      industry: {
        type: "string",
        maxLength: 100,
        description: "業種フィルター / Industry filter (e.g., 'SaaS', 'E-commerce')",
      },
      audience: {
        type: "string",
        maxLength: 100,
        description:
          "ターゲットオーディエンスフィルター / Target audience filter (e.g., 'Developer', 'Enterprise')",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "タグフィルター / Tags filter",
      },
      profile_id: {
        type: "string",
        format: "uuid",
        description: "嗜好プロファイルID（検索結果のリランキングに使用） / Preference profile ID",
      },
      enable_reranking: {
        type: "boolean",
        description:
          "Cross-Encoderリランキング有効化（デフォルト: true） / Enable Cross-Encoder reranking (default: true)",
        default: true,
      },
      query_type: {
        type: "string",
        enum: ["auto", "visual", "structural", "functional", "stylistic"],
        description:
          "クエリタイプ（auto: 自動分類、visual: 見た目、structural: レイアウト構造、functional: 機能、stylistic: スタイル） / Query type (auto: auto-classify)",
        default: "auto",
      },
      include_facets: {
        type: "boolean",
        description:
          "ファセットカウント付与（デフォルト: false）。trueにすると sectionType/industry/audience/tags のカウントを返却 / Include facet counts (default: false). Returns counts for sectionType/industry/audience/tags when true",
        default: false,
      },
      facet_fields: {
        type: "array",
        items: {
          type: "string",
          enum: ["sectionType", "industry", "audience", "tags"],
        },
        minItems: 1,
        description:
          "ファセットフィールド指定（指定時はinclude_facetsが暗黙的にtrue）。未指定時は全4フィールド / " +
          "Facet fields to compute (implicitly enables include_facets). Defaults to all 4 fields when omitted. " +
          "sectionType: セクション/パーツタイプ, industry: 業種, audience: ターゲット, tags: タグ",
      },
    },
    required: ["query"],
  },
};
