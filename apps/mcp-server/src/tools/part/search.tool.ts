// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.search MCPツール
 * UIコンポーネントパーツをセマンティック検索します
 *
 * 機能:
 * - テキストクエリによるベクトル検索（e5-base text_embedding）
 * - 画像URLによるビジュアル類似検索（DINOv2 visual_embedding）
 * - ハイブリッド検索（RRF: 60% vector + 40% fulltext）
 * - パーツタイプ / WebページID フィルタリング
 * - ページネーション対応
 *
 * Features:
 * - Text query vector search (e5-base text_embedding)
 * - Visual similarity search by image URL (DINOv2 visual_embedding)
 * - Hybrid search (RRF: 60% vector + 40% fulltext)
 * - Part type / web page ID filtering
 * - Pagination support
 *
 * @module tools/part/search.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { sanitizeHtml } from "../../utils/html-sanitizer";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";
import { partSearchInputSchema, type PartSearchInput } from "../../services/part/schemas";
import {
  getPartSearchService,
  type PartSearchResult,
  type PartSearchResultItem,
  type PartSearchOptions,
} from "../../services/part/part-search.service";
import type { DegradedReason } from "../../services/_shared/resolve-query-embedding";
import { buildEmbeddingFailureError } from "../_shared/embedding-failure-response";

// =====================================================
// 型定義
// =====================================================

/**
 * MCP レスポンス用の検索結果アイテム
 * MCP response search result item
 */
export interface PartSearchMcpResultItem {
  id: string;
  partType: string;
  partSubtype: string | null;
  sectionType: string;
  webPageUrl: string;
  similarity: number;
  boundingBox: Record<string, unknown>;
  visualSimilarity?: number;
  textSimilarity?: number;
  computedStyles?: Record<string, string>;
  htmlSnippet?: string;
}

/**
 * part.search 出力型
 * part.search output type
 */
export type PartSearchOutput =
  | {
      success: true;
      data: {
        results: PartSearchMcpResultItem[];
        total: number;
        query: { text?: string; imageUrl?: string };
        searchTimeMs: number;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
        /**
         * embedding 障害の degraded 理由 (ADR-0043 / plan v4 §4.1)。
         * embedding_unavailable | embedding_failed。aggregator (search.unified、PR-2b)
         * が service 単位 degraded 分類に使う。embedding 障害以外の error では undefined。
         */
        degradedReason?: DegradedReason;
      };
    };

// =====================================================
// エラーコード / Error codes
// =====================================================

export const PART_SEARCH_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SEARCH_FAILED: "SEARCH_FAILED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// =====================================================
// エラーハンドリング / Error handling
// =====================================================

/**
 * エラーからエラーコードを判定
 * Determine error code from error
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("embedding") || message.includes("model")) {
    return PART_SEARCH_ERROR_CODES.EMBEDDING_FAILED;
  }

  if (
    message.includes("database") ||
    message.includes("prisma") ||
    message.includes("connection")
  ) {
    return PART_SEARCH_ERROR_CODES.SEARCH_FAILED;
  }

  if (message.includes("timeout")) {
    return PART_SEARCH_ERROR_CODES.SEARCH_FAILED;
  }

  return PART_SEARCH_ERROR_CODES.INTERNAL_ERROR;
}

// sanitizeErrorMessage は ../../utils/sanitize-error から統一インポート
// Unified import from ../../utils/sanitize-error (CWE-209)

// =====================================================
// 結果フォーマット / Result formatting
// =====================================================

/**
 * PartSearchResult を MCP レスポンス用にフォーマット
 * Format PartSearchResult for MCP response
 */
function formatSearchResult(
  result: PartSearchResult,
  includeStyles: boolean,
  includeHtml: boolean
): PartSearchMcpResultItem[] {
  return result.results.map((r: PartSearchResultItem) => {
    const item: PartSearchMcpResultItem = {
      id: r.id,
      partType: r.partType,
      partSubtype: r.partSubtype,
      sectionType: r.sectionType,
      webPageUrl: r.webPageUrl,
      similarity: r.similarity,
      boundingBox: r.boundingBox,
    };

    if (r.visualSimilarity !== undefined) {
      item.visualSimilarity = r.visualSimilarity;
    }
    if (r.textSimilarity !== undefined) {
      item.textSimilarity = r.textSimilarity;
    }
    if (includeStyles && r.computedStyles) {
      item.computedStyles = r.computedStyles;
    }
    if (includeHtml && r.htmlSnippet) {
      item.htmlSnippet = sanitizeHtml(r.htmlSnippet);
    }

    return item;
  });
}

// =====================================================
// メインハンドラー
// =====================================================

/**
 * part.search ツールハンドラー
 * part.search tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns 検索結果 / Search results
 */
export async function partSearchHandler(input: unknown): Promise<PartSearchOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info("[MCP Tool] part.search called", {
      query: (input as Record<string, unknown>)?.query,
      image_url: (input as Record<string, unknown>)?.image_url ? "(provided)" : undefined,
    });
  }

  // 入力バリデーション / Input validation
  let validated: PartSearchInput;
  try {
    validated = partSearchInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] part.search validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: PART_SEARCH_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // Search result cache check / 検索キャッシュチェック
  const cacheKey = generateCacheKey("part.search", validated as unknown as Record<string, unknown>);
  const cached = getCachedResult<PartSearchOutput>(cacheKey);
  if (cached) {
    return cached;
  }

  // サービス取得 / Get service
  let searchService: ReturnType<typeof getPartSearchService>;
  try {
    searchService = getPartSearchService();
  } catch {
    return {
      success: false,
      error: {
        code: PART_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Part search service is not available",
      },
    };
  }

  try {
    // 検索オプション構築 / Build search options
    // exactOptionalPropertyTypes: undefinedを明示的に渡さない
    const options: PartSearchOptions = {
      limit: validated.limit,
      offset: validated.offset,
      minSimilarity: validated.min_similarity,
      searchMode: validated.search_mode,
    };
    if (validated.part_type) {
      options.partType = validated.part_type;
    }
    if (validated.web_page_id) {
      options.webPageId = validated.web_page_id;
    }
    if (validated.tags && validated.tags.length > 0) {
      options.tags = validated.tags;
    }
    if (validated.industry) {
      options.industry = validated.industry;
    }
    if (validated.audience) {
      options.audience = validated.audience;
    }

    let result: PartSearchResult;

    if (validated.search_mode === "visual" && validated.image_url) {
      // ビジュアル検索: imageUrlをreferencePartIdとして使用できるか確認
      // 現在の実装は referencePartId（既存パーツID）のみ対応
      // Visual search: currently only supports referencePartId (existing part ID)
      // imageUrl direct search is a future extension
      return {
        success: false,
        error: {
          code: PART_SEARCH_ERROR_CODES.VALIDATION_ERROR,
          message:
            "Visual search by imageUrl is not yet supported. Use text or hybrid mode, or provide an existing part ID via part.inspect + visual search.",
        },
      };
    }

    if (validated.query) {
      // ADR-0043 Decision 3 / plan v4 §4.3.2 part 4-state dispatch
      // (embedding ok/unavailable/failed × search_mode):
      const embeddingResult = await searchService.resolveQueryEmbeddingResult(validated.query);

      if (embeddingResult.status === "ok") {
        if (validated.search_mode !== "text") {
          // state 1: embedding ok + visual/hybrid → ハイブリッド (vector + fulltext RRF)
          result = await searchService.searchPartsHybrid(
            validated.query,
            embeddingResult.embedding,
            options
          );
        } else {
          // state 2: embedding ok + text → text-to-vector (現状維持・後方互換)
          result = await searchService.searchParts(embeddingResult.embedding, options);
        }
      } else if (validated.search_mode === "text") {
        // state 3: embedding failed/unavailable + text → fulltext-only 続行 (success:true 正当)
        if (isDevelopment()) {
          logger.warn(
            "[MCP Tool] part.search: embedding unavailable, falling back to fulltext-only (text mode)"
          );
        }
        result = await searchService.searchPartsFulltext(validated.query, options);
      } else {
        // state 4: embedding failed/unavailable + visual/hybrid → success:false (案A leaf fail-loud)
        const failure = buildEmbeddingFailureError(embeddingResult.status);
        logger.warn("[MCP Tool] part.search: embedding required but unavailable (fail-loud)", {
          code: failure.code,
          degradedReason: failure.degradedReason,
          searchMode: validated.search_mode,
        });
        return {
          success: false,
          error: {
            code: failure.code,
            message: failure.message,
            degradedReason: failure.degradedReason,
          },
        };
      }
    } else {
      // queryもimageUrlもない場合（Zodの.refineで防がれるはず）
      // Neither query nor imageUrl (should be prevented by Zod .refine())
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: {},
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // 結果フォーマット / Format results
    // include_styles/include_html はスキーマに未定義のためデフォルトfalse
    // Currently partSearchInputSchema doesn't have include_styles/include_html
    // Part search results omit computedStyles and htmlSnippet by default
    const mappedResults = formatSearchResult(result, false, false);

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[MCP Tool] part.search completed", {
        query: validated.query,
        searchMode: validated.search_mode,
        resultCount: mappedResults.length,
        total: result.total,
        searchTimeMs,
      });
    }

    const searchOutput: PartSearchOutput = {
      success: true,
      data: {
        results: mappedResults,
        total: result.total,
        query: {
          ...(validated.query ? { text: validated.query } : {}),
          ...(validated.image_url ? { imageUrl: validated.image_url } : {}),
        },
        searchTimeMs,
      },
    };
    // Cache successful results / 成功結果をキャッシュ
    setCachedResult(cacheKey, searchOutput);
    return searchOutput;
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.warn("[MCP Tool] part.search error", {
      code: errorCode,
      error: sanitizeErrorMessage(error),
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * part.search MCPツール定義
 * part.search MCP tool definition
 */
export const partSearchToolDefinition = {
  name: "part.search",
  description:
    "UIコンポーネントパーツ（ボタン、カード、リンク等）をセマンティック検索します。" +
    "テキストクエリ（e5-base + full-text）によるハイブリッド検索を提供。" +
    "partType（16種類）やsearchMode（visual/text/hybrid）でフィルタリング可能です。" +
    " / Search UI component parts (buttons, cards, links, etc.) by text query. " +
    "Provides hybrid search via e5-base + full-text. " +
    "Filterable by partType (16 types) and searchMode (visual/text/hybrid).",
  annotations: {
    title: "Part Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "テキスト検索クエリ（1-500文字） / Text search query (1-500 chars)",
        minLength: 1,
        maxLength: 500,
      },
      image_url: {
        type: "string",
        format: "uri",
        description:
          "画像URLによるビジュアル検索（将来対応予定） / Visual search by image URL (future support)",
      },
      part_type: {
        type: "string",
        enum: [
          "button",
          "link",
          "image",
          "video",
          "form",
          "input",
          "heading",
          "card",
          "navigation",
          "footer",
          "cta",
          "hero_image",
          "icon",
          "badge",
          "tag",
          "avatar",
        ],
        description: "パーツタイプでフィルター（16種類） / Filter by part type (16 types)",
      },
      web_page_id: {
        type: "string",
        format: "uuid",
        description: "WebページIDでフィルター / Filter by web page ID",
      },
      limit: {
        type: "number",
        description: "取得件数（1-100、デフォルト: 20） / Result limit (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
        default: 20,
      },
      offset: {
        type: "number",
        description: "オフセット（0以上、デフォルト: 0） / Offset (0+, default: 0)",
        minimum: 0,
        default: 0,
      },
      search_mode: {
        type: "string",
        enum: ["visual", "text", "hybrid"],
        default: "hybrid",
        description: "検索モード（デフォルト: hybrid） / Search mode (default: hybrid)",
      },
      min_similarity: {
        type: "number",
        description:
          "最小類似度閾値（0-1、デフォルト: 0.3） / Min similarity threshold (0-1, default: 0.3)",
        minimum: 0,
        maximum: 1,
        default: 0.3,
      },
      industry: {
        type: "string",
        description: "業種フィルター（例: tech, finance, healthcare） / Industry filter",
        maxLength: 100,
      },
      audience: {
        type: "string",
        description:
          "ターゲットオーディエンス（例: b2b, b2c, enterprise） / Target audience filter",
        maxLength: 100,
      },
      tags: {
        type: "array",
        items: { type: "string", maxLength: 50 },
        maxItems: 10,
        description: "タグフィルター / Tag filter",
      },
    },
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug("[part.search] Tool module loaded");
}
