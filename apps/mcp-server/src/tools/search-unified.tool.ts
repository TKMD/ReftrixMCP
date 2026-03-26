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

// ============================================================================
// Input Schema
// ============================================================================

/**
 * 検索対象タイプ / Search target types
 */
const searchTargetTypeSchema = z.enum(["layout", "part", "motion", "background", "narrative"]);

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

  // キャッシュチェック / Cache check
  const cacheKey = generateCacheKey(
    "search.unified",
    validated as unknown as Record<string, unknown>
  );
  const cached = getCachedResult<SearchUnifiedOutput>(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. 並列検索実行 / Execute searches in parallel
  const layoutPromise = types.includes("layout")
    ? searchLayout(validated)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const partPromise = types.includes("part")
    ? searchPart(validated)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const motionPromise = types.includes("motion")
    ? searchMotion(validated)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const backgroundPromise = types.includes("background")
    ? searchBackground(validated)
    : Promise.resolve([] as UnifiedSearchResultItem[]);

  const narrativePromise = types.includes("narrative")
    ? searchNarrative(validated)
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

    // 3. 結果マージ（similarity降順）/ Merge results by similarity desc
    const allResults = [
      ...layoutResults,
      ...partResults,
      ...motionResults,
      ...backgroundResults,
      ...narrativeResults,
    ]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, validated.limit);

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
      },
    };

    setCachedResult(cacheKey, result);
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
    },
    required: ["query"],
  },
};
