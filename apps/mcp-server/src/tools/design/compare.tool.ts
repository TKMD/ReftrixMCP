// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.compare MCPツール
 * 2-5件のWebページを多次元で比較する
 *
 * 比較軸:
 * - layout: セクション構造のcosine類似度（text_embedding mean pooling）
 * - visual: DINOv2 vision embeddingのcosine類似度（vision_embedding mean pooling）
 * - quality: 品質スコア差分の正規化
 * - color: カラーパレット距離（CIE76 deltaE近似）
 *
 * セキュリティ:
 * - Zodバリデーション
 * - sanitizeErrorMessage使用 (CWE-209)
 * - UUIDv7バリデーション
 * - NaN/Infinity防御（サービス層で実装）
 *
 * @module tools/design/compare.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  compareDesigns,
  DESIGN_COMPARE_ERROR_CODES,
  type ComparisonDimension,
  type DesignCompareResult,
} from "../../services/design-compare.service";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";

// =====================================================
// Re-export error codes / エラーコードの再エクスポート
// =====================================================

export { DESIGN_COMPARE_ERROR_CODES } from "../../services/design-compare.service";

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

/** UUID v4/v7 pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const designCompareInputSchema = z.object({
  page_ids: z
    .array(z.string().regex(UUID_PATTERN, "Invalid UUID format"))
    .min(2)
    .max(5)
    .describe(
      "比較対象ページID（2-5件、UUID形式）。web_pagesテーブルに存在する必要があります。" +
        " / Page IDs to compare (2-5, UUID format). Must exist in web_pages table."
    ),
  dimensions: z
    .array(z.enum(["layout", "visual", "quality", "color"]))
    .min(1)
    .max(4)
    .default(["layout", "visual", "quality", "color"])
    .describe(
      "比較次元（layout/visual/quality/color）。デフォルト: 全4次元。" +
        " / Comparison dimensions. Default: all 4 dimensions."
    ),
  include_details: z
    .boolean()
    .default(false)
    .describe(
      "共通パターン・差分ポイントを含めるか（デフォルト: false）。" +
        " / Include common patterns and key differences (default: false)."
    ),
});

export type DesignCompareInput = z.infer<typeof designCompareInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface DesignCompareOutput {
  success: boolean;
  pages: Array<{
    id: string;
    url: string;
    title: string | undefined;
  }>;
  comparisons: Array<{
    pair: [string, string];
    scores: Partial<Record<ComparisonDimension, number>>;
    overall: number;
  }>;
  common_patterns: Array<{
    dimension: ComparisonDimension;
    description: string;
  }>;
  key_differences: Array<{
    dimension: ComparisonDimension;
    description: string;
    page_ids: string[];
  }>;
  error?: string;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * design.compare ハンドラー
 * design.compare handler
 *
 * @param input - ツール入力（バリデーション前） / Tool input (pre-validation)
 * @returns 比較結果 / Comparison results
 */
export async function designCompareHandler(input: unknown): Promise<DesignCompareOutput> {
  const startTime = Date.now();

  // 入力バリデーション / Input validation
  let parsed: DesignCompareInput;
  try {
    parsed = designCompareInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: `${DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT}: ${message}`,
    };
  }

  // 重複IDチェック / Duplicate ID check
  const uniqueIds = new Set(parsed.page_ids);
  if (uniqueIds.size !== parsed.page_ids.length) {
    return {
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: `${DESIGN_COMPARE_ERROR_CODES.INVALID_INPUT}: Duplicate page_ids detected`,
    };
  }

  // キャッシュチェック / Cache check
  const cacheKeyParams = {
    page_ids: parsed.page_ids.sort().join(","),
    dimensions: parsed.dimensions.sort().join(","),
    include_details: parsed.include_details,
  } as Record<string, unknown>;
  const cacheKey = generateCacheKey("design.compare", cacheKeyParams);
  const cachedResult = getCachedResult<DesignCompareOutput>(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  try {
    // サービス層に委譲 / Delegate to service layer
    const result: DesignCompareResult = await compareDesigns({
      page_ids: parsed.page_ids,
      dimensions: parsed.dimensions as ComparisonDimension[],
      include_details: parsed.include_details,
    });

    const output: DesignCompareOutput = {
      success: result.success,
      pages: result.pages,
      comparisons: result.comparisons,
      common_patterns: result.common_patterns,
      key_differences: result.key_differences,
      ...(result.error !== undefined && { error: result.error }),
    };

    // キャッシュ保存（成功時のみ） / Cache on success
    if (output.success) {
      setCachedResult(cacheKey, output);
    }

    return output;
  } catch (error) {
    logger.warn("[design.compare] Handler failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: `${DESIGN_COMPARE_ERROR_CODES.COMPARE_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.compare] completed", {
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const designCompareToolDefinition = {
  name: "design.compare",
  description:
    "2-5件のWebページをレイアウト・視覚・品質・カラーの4軸で比較し、ペアワイズ類似度スコア（0-1）を算出します。include_detailsで共通パターンと差分ポイントも取得可能。" +
    " / Compare 2-5 web pages across layout, visual, quality, and color dimensions. Returns pairwise similarity scores (0-1). Set include_details for common patterns and key differences.",
  annotations: {
    title: "Design Compare",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      page_ids: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 2,
        maxItems: 5,
        description: "比較対象ページID（2-5件、UUID形式） / Page IDs to compare (2-5, UUID format)",
      },
      dimensions: {
        type: "array",
        items: {
          type: "string",
          enum: ["layout", "visual", "quality", "color"],
        },
        default: ["layout", "visual", "quality", "color"],
        description: "比較次元（デフォルト: 全4次元） / Comparison dimensions (default: all 4)",
      },
      include_details: {
        type: "boolean",
        description:
          "共通パターン・差分ポイントを含めるか（デフォルト: false） / Include details (default: false)",
        default: false,
      },
    },
    required: ["page_ids"],
  },
};
