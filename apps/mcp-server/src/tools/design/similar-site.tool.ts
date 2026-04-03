// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.similar_site MCPツール
 * URL入力からDB内の類似デザインを検索
 *
 * 機能:
 * - URLのWebPageをDBから取得
 * - セクションembeddingsのmean pooling（text + vision）
 * - pgvector HNSW検索でページレベル類似度計算
 * - RRF 3-source fusion: text(40%) + vision(30%) + fulltext(30%)
 * - 自サイト除外フィルタ
 *
 * セキュリティ:
 * - URL入力: SSRF防止（validateExternalUrl使用）
 * - Zodバリデーション
 * - sanitizeErrorMessage使用
 * - NaN/Infinity防御
 *
 * @module tools/design/similar-site.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl } from "../../utils/url-validator";
import {
  searchSimilarSites,
  SIMILAR_SITE_ERROR_CODES as SERVICE_ERROR_CODES,
  type SimilarSiteSearchOutput,
} from "../../services/similar-site.service";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";

// =====================================================
// Re-export error codes / エラーコードの再エクスポート
// =====================================================

export const SIMILAR_SITE_ERROR_CODES = {
  ...SERVICE_ERROR_CODES,
} as const;

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

/** URLの最大長 / Maximum URL length */
const MAX_URL_LENGTH = 2048;

export const designSimilarSiteInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(MAX_URL_LENGTH)
    .describe(
      "検索対象のURL。DB内のweb_pagesに存在する必要があります（未分析URLは404）。" +
        " / Target URL. Must exist in web_pages DB (unanalyzed URLs return 404)."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("取得件数（1-20、デフォルト: 5） / Number of results (1-20, default: 5)"),
  include_details: z
    .boolean()
    .default(false)
    .describe(
      "詳細情報（共通パターン・差分）を含めるか（デフォルト: false）" +
        " / Include details (common patterns, differences) (default: false)"
    ),
});

export type DesignSimilarSiteInput = z.infer<typeof designSimilarSiteInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface DesignSimilarSiteOutput {
  success: boolean;
  query_url: string;
  similar_sites: Array<{
    url: string;
    title: string | undefined;
    similarity_score: number;
    common_patterns?: string[];
    differences?: string[];
  }>;
  total: number;
  error?: string;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * design.similar_site ハンドラー
 * design.similar_site handler
 *
 * @param input - ツール入力（バリデーション前） / Tool input (pre-validation)
 * @returns 検索結果 / Search results
 */
export async function designSimilarSiteHandler(input: unknown): Promise<DesignSimilarSiteOutput> {
  const startTime = Date.now();

  // 入力バリデーション / Input validation
  let parsed: DesignSimilarSiteInput;
  try {
    parsed = designSimilarSiteInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      query_url: "",
      similar_sites: [],
      total: 0,
      error: `${SIMILAR_SITE_ERROR_CODES.INVALID_INPUT}: ${message}`,
    };
  }

  // SSRF検証（URLがプライベートIPを指していないか） / SSRF validation
  const urlValidation = validateExternalUrl(parsed.url);
  if (!urlValidation.valid) {
    return {
      success: false,
      query_url: parsed.url,
      similar_sites: [],
      total: 0,
      error: `${SIMILAR_SITE_ERROR_CODES.INVALID_INPUT}: ${urlValidation.error ?? "URL validation failed"}`,
    };
  }

  // キャッシュチェック / Cache check
  const cacheKeyParams = {
    url: parsed.url,
    limit: parsed.limit,
    include_details: parsed.include_details,
  } as Record<string, unknown>;
  const cacheKey = generateCacheKey("design.similar_site", cacheKeyParams);
  const cachedResult = getCachedResult<DesignSimilarSiteOutput>(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  try {
    // 検索実行（サービス層に委譲） / Execute search (delegate to service layer)
    const serviceResult: SimilarSiteSearchOutput = await searchSimilarSites({
      url: parsed.url,
      limit: parsed.limit,
      include_details: parsed.include_details,
    });

    const output: DesignSimilarSiteOutput = {
      success: serviceResult.success,
      query_url: serviceResult.query_url,
      similar_sites: serviceResult.similar_sites,
      total: serviceResult.total,
      ...(serviceResult.error !== undefined && { error: serviceResult.error }),
    };

    // キャッシュ保存 / Cache result
    if (output.success) {
      setCachedResult(cacheKey, output);
    }

    return output;
  } catch (error) {
    logger.warn("[design.similar_site] Handler failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      query_url: parsed.url,
      similar_sites: [],
      total: 0,
      error: `${SIMILAR_SITE_ERROR_CODES.SEARCH_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.similar_site] completed", {
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const designSimilarSiteToolDefinition = {
  name: "design.similar_site",
  description:
    "URLを入力として、DB内の類似デザインのWebサイトを検索します。" +
    "指定URLのページのセクションembedding（DINOv2 vision + e5-base text）のmean poolingで" +
    "ページレベルの代表ベクトルを生成し、pgvector HNSW検索で類似サイトを発見します。" +
    "RRF 3-source fusion（text 40% + vision 30% + fulltext 30%）で総合スコアを算出。" +
    " / Searches for similar website designs in DB given a URL. " +
    "Generates page-level representative vectors via mean pooling of section embeddings " +
    "(DINOv2 vision + e5-base text) and finds similar sites using pgvector HNSW search.",
  annotations: {
    title: "Similar Site Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "検索対象のURL。DB内のweb_pagesに存在する必要があります（未分析URLは404）",
      },
      limit: {
        type: "number",
        description: "取得件数（1-20、デフォルト: 5）",
        minimum: 1,
        maximum: 20,
        default: 5,
      },
      include_details: {
        type: "boolean",
        description: "詳細情報（共通パターン・差分）を含めるか（デフォルト: false）",
        default: false,
      },
    },
    required: ["url"],
  },
};
