// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * search.facets MCPツール / search.facets MCP Tool
 *
 * ファセット検索（絞り込みカウント表示）を提供する。
 * search.unified の結果からリアルタイムにファセットカウントを算出し、
 * 検索結果の絞り込みに使用できるカウント付きフィルタ値を返却する。
 *
 * Provides faceted search (filter counts). Computes facet counts
 * from search.unified results in real-time, returning filter values
 * with counts for search result refinement.
 *
 * @module tools/search/facets.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { searchUnifiedHandler, type SearchUnifiedOutput } from "../search-unified.tool";
import {
  computeFacetsFromResults,
  SUPPORTED_FACET_FIELDS,
  type FacetCounts,
  type FacetField,
} from "../../services/facet.service";
import { classifyQueryType } from "../../services/search/query-understanding.service";
import { logSearch } from "../../services/search-log.service";

// ============================================================================
// Input Schema
// ============================================================================

/**
 * ファセットフィールドスキーマ / Facet field schema
 */
const facetFieldSchema = z.enum(["sectionType", "industry", "audience", "tags"]);

/**
 * search.facets 入力スキーマ / search.facets input schema
 */
export const searchFacetsInputSchema = z.object({
  /** 検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars) */
  query: z.string().min(1).max(500),
  /** ファセットフィールド（デフォルト: 全フィールド） / Facet fields (default: all) */
  facet_fields: z.array(facetFieldSchema).min(1).optional(),
  /** 取得件数（1-50、デフォルト: 50） / Result limit for facet computation (1-50, default: 50) */
  limit: z.number().int().min(1).max(50).default(50),
  /** WebページIDでフィルター / Filter by web page ID */
  webPageId: z.string().uuid().optional(),
  /** 業種フィルター / Industry filter */
  industry: z.string().max(100).optional(),
  /** ターゲットオーディエンスフィルター / Target audience filter */
  audience: z.string().max(100).optional(),
  /** タグフィルター / Tags filter */
  tags: z.array(z.string()).max(10).optional(),
});
export type SearchFacetsInput = z.infer<typeof searchFacetsInputSchema>;

// ============================================================================
// Output Types
// ============================================================================

/**
 * search.facets 出力型 / search.facets output type
 */
export type SearchFacetsOutput =
  | {
      success: true;
      data: {
        /** ファセットカウント / Facet counts */
        facets: FacetCounts;
        /** クエリタイプ / Query type */
        query_type: string;
        /** 検索結果総数（ファセット算出のベース） / Total results (base for facet computation) */
        total_results: number;
        /** 検索時間（ms） / Search time (ms) */
        searchTimeMs: number;
        /** 非推奨警告 / Deprecation warning */
        _deprecation: {
          message: string;
          removal_version: string;
          alternative: string;
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

export const SEARCH_FACETS_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SEARCH_FAILED: "SEARCH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ============================================================================
// Handler
// ============================================================================

/**
 * search.facets ツールハンドラー / search.facets tool handler
 *
 * search.unified を呼び出し、結果セットからファセットカウントを算出。
 * 検索ログも自動記録する。
 *
 * Calls search.unified and computes facet counts from the result set.
 * Also automatically records search logs.
 */
export async function searchFacetsHandler(input: unknown): Promise<SearchFacetsOutput> {
  const startTime = Date.now();

  // 1. 入力バリデーション / Input validation
  let validated: SearchFacetsInput;
  try {
    validated = searchFacetsInputSchema.parse(input);
  } catch (error) {
    logger.warn("[search.facets] Validation error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: SEARCH_FACETS_ERROR_CODES.VALIDATION_ERROR,
        message: "Validation error",
      },
    };
  }

  const facetFields: FacetField[] =
    validated.facet_fields ?? ([...SUPPORTED_FACET_FIELDS] as FacetField[]);

  // 2. クエリタイプ分類 / Classify query type
  const queryType = classifyQueryType(validated.query);

  try {
    // 3. search.unified 実行 / Execute search.unified
    const searchResult = (await searchUnifiedHandler({
      query: validated.query,
      limit: validated.limit,
      webPageId: validated.webPageId,
      industry: validated.industry,
      audience: validated.audience,
      tags: validated.tags,
      enable_reranking: false, // ファセットカウントにはリランキング不要
    })) as SearchUnifiedOutput;

    if (!searchResult.success) {
      return {
        success: false,
        error: {
          code: SEARCH_FACETS_ERROR_CODES.SEARCH_FAILED,
          message: "Unified search failed",
        },
      };
    }

    // 4. ファセットカウント算出 / Compute facet counts
    const facets = computeFacetsFromResults(searchResult.data.results, facetFields);

    const searchTimeMs = Date.now() - startTime;

    // 5. 検索ログ記録（fire-and-forget） / Log search (fire-and-forget)
    logSearch({
      query: validated.query,
      queryType,
      services: ["facets"],
      resultCount: searchResult.data.total,
      topResultId: searchResult.data.results[0]?.id,
      filters: {
        facet_fields: facetFields,
        industry: validated.industry,
        audience: validated.audience,
        tags: validated.tags,
      },
      latencyMs: searchTimeMs,
      cacheHit: false,
    }).catch(() => {
      // fire-and-forget: エラーは logSearch 内部で処理済み
    });

    return {
      success: true,
      data: {
        facets,
        query_type: queryType,
        total_results: searchResult.data.total,
        searchTimeMs,
        _deprecation: {
          message:
            "search.facets is deprecated. Use search.unified with include_facets: true (and optionally facet_fields) instead. " +
            "Example: search.unified({ query: '...', include_facets: true, facet_fields: ['sectionType'], enable_reranking: false, limit: 50 })",
          removal_version: "v0.4.0",
          alternative: "search.unified with include_facets: true",
        },
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    logger.warn("[search.facets] Failed", {
      error: sanitizeErrorMessage(errorInstance),
    });

    return {
      success: false,
      error: {
        code: SEARCH_FACETS_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(errorInstance),
      },
    };
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * search.facets MCPツール定義 / search.facets MCP tool definition
 */
export const searchFacetsToolDefinition = {
  name: "search.facets",
  description:
    "[DEPRECATED: Use search.unified with include_facets: true instead] " +
    "ファセット検索（絞り込みカウント表示）。検索結果をsectionType・industry・audience・tagsで" +
    "分類し、各値の件数を返却します。検索結果の絞り込みUIやフィルタ選択に使用します。" +
    "代替: search.unified({ query: '...', include_facets: true, facet_fields: ['sectionType'], enable_reranking: false, limit: 50 })" +
    " / Faceted search with filter counts. Classifies search results by sectionType, industry, " +
    "audience, and tags, returning counts per value. Used for search result refinement UI and filter selection.",
  annotations: {
    title: "Faceted Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
    deprecated: true,
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
      facet_fields: {
        type: "array",
        items: {
          type: "string",
          enum: ["sectionType", "industry", "audience", "tags"],
        },
        description:
          "ファセットフィールド（デフォルト: 全フィールド） / Facet fields (default: all). " +
          "sectionType: セクション/パーツタイプ, industry: 業種, audience: ターゲット, tags: タグ",
      },
      limit: {
        type: "number",
        description:
          "ファセット算出のベース結果数（1-50、デフォルト: 50） / Base result limit for facet computation (1-50, default: 50)",
        minimum: 1,
        maximum: 50,
        default: 50,
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
          "ターゲットオーディエンスフィルター / Target audience filter (e.g., 'Developer')",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "タグフィルター / Tags filter",
      },
    },
    required: ["query"],
  },
};
