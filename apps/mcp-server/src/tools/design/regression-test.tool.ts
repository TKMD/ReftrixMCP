// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.regression_test MCPツール
 * ベースラインスナップショットと現在のページをPixelmatchでピクセルレベル比較し、
 * 閾値ベースのpass/fail判定 + diff画像を返却する
 *
 * design.regression_test MCP Tool
 * Pixel-level comparison between baseline snapshot and current page via Pixelmatch.
 * Returns threshold-based pass/fail + diff image.
 *
 * セキュリティ:
 * - Zodバリデーション
 * - sanitizeErrorMessage使用 (CWE-209)
 * - UUIDバリデーション
 * - SSRF対策（validateExternalUrl）
 *
 * @module tools/design/regression-test.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl } from "../../utils/url-validator";
import {
  runVisualRegression,
  VISUAL_REGRESSION_ERROR_CODES,
} from "../../services/visual-regression.service";

// =====================================================
// Constants / 定数
// =====================================================

/** UUID v4/v7 pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

export const designRegressionTestInputSchema = z.object({
  url: z
    .string()
    .url({ message: "有効なURL形式を指定してください / Valid URL format required" })
    .describe("比較対象のWebページURL / Target web page URL to compare against baseline"),
  baseline_snapshot_id: z
    .string()
    .regex(UUID_PATTERN, "Invalid UUID format")
    .describe(
      "ベースラインとして使用するスナップショットID（UUID形式） / " +
        "Baseline snapshot ID (UUID format, from design.track_changes snapshot action)"
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.001)
    .describe(
      "pass/fail判定の閾値（0-1、デフォルト0.001 = 0.1%）。変更ピクセル割合がこの値以下ならpass / " +
        "Threshold for pass/fail (0-1, default 0.001 = 0.1%). Pass if change percentage ≤ threshold"
    ),
  viewport_width: z
    .number()
    .int()
    .min(320)
    .max(4096)
    .optional()
    .default(1920)
    .describe(
      "スクリーンショットのビューポート幅（デフォルト1920） / Viewport width (default 1920)"
    ),
  viewport_height: z
    .number()
    .int()
    .min(240)
    .max(16384)
    .optional()
    .default(1080)
    .describe(
      "スクリーンショットのビューポート高さ（デフォルト1080） / Viewport height (default 1080)"
    ),
});

export type DesignRegressionTestInput = z.infer<typeof designRegressionTestInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface DesignRegressionTestOutput {
  success: boolean;
  /** テスト結果（pass/fail） / Test result (pass/fail) */
  passed?: boolean;
  /** 変更ピクセル割合（0-1） / Change percentage (0-1) */
  change_percentage?: number;
  /** 変更ピクセル数 / Changed pixel count */
  changed_pixels?: number;
  /** 全ピクセル数 / Total pixel count */
  total_pixels?: number;
  /** 使用閾値 / Threshold used */
  threshold?: number;
  /** diff画像（Base64 PNG） / Diff image (Base64 PNG) */
  diff_image_base64?: string;
  /** ベースライン情報 / Baseline info */
  baseline?: {
    snapshot_id: string;
    snapshot_at: string;
    web_page_url: string;
  };
  /** エラー情報 / Error info */
  error?: string;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * design.regression_test ハンドラー
 * design.regression_test handler
 */
export async function designRegressionTestHandler(
  input: unknown
): Promise<DesignRegressionTestOutput> {
  const startTime = Date.now();

  // 入力バリデーション / Input validation
  let parsed: DesignRegressionTestInput;
  try {
    parsed = designRegressionTestInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.VALIDATION_ERROR}: ${message}`,
    };
  }

  // SSRF対策 / SSRF prevention
  const urlValidation = validateExternalUrl(parsed.url);
  if (!urlValidation.valid) {
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.VALIDATION_ERROR}: URL blocked by security policy`,
    };
  }

  try {
    const result = await runVisualRegression({
      baselineSnapshotId: parsed.baseline_snapshot_id,
      url: parsed.url,
      threshold: parsed.threshold,
      viewportWidth: parsed.viewport_width,
      viewportHeight: parsed.viewport_height,
    });

    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }

    const output: DesignRegressionTestOutput = { success: true };
    if (result.passed !== undefined) output.passed = result.passed;
    if (result.changePercentage !== undefined) output.change_percentage = result.changePercentage;
    if (result.changedPixels !== undefined) output.changed_pixels = result.changedPixels;
    if (result.totalPixels !== undefined) output.total_pixels = result.totalPixels;
    if (result.threshold !== undefined) output.threshold = result.threshold;
    if (result.diffImageBase64 !== undefined) output.diff_image_base64 = result.diffImageBase64;
    if (result.baseline) {
      output.baseline = {
        snapshot_id: result.baseline.snapshotId,
        snapshot_at: result.baseline.snapshotAt,
        web_page_url: result.baseline.webPageUrl,
      };
    }
    return output;
  } catch (error) {
    logger.warn("[design.regression_test] Handler failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${VISUAL_REGRESSION_ERROR_CODES.DIFF_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.regression_test] completed", {
      url: parsed.url,
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const designRegressionTestToolDefinition = {
  name: "design.regression_test",
  description:
    "ベースラインスナップショットと現在のWebページをPixelmatchでピクセルレベル比較し、" +
    "閾値ベースのpass/fail判定を行います。diff画像（Base64 PNG）と変更ピクセル割合を返却します。" +
    "design.track_changesのsnapshotアクションで保存したスナップショットをベースラインとして使用します。" +
    " / Pixel-level comparison between baseline snapshot and current web page via Pixelmatch. " +
    "Returns threshold-based pass/fail, diff image (Base64 PNG), and change percentage. " +
    "Use snapshots from design.track_changes snapshot action as baseline.",
  annotations: {
    title: "Visual Regression Test",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "比較対象のWebページURL / Target web page URL",
      },
      baseline_snapshot_id: {
        type: "string",
        format: "uuid",
        description:
          "ベースラインスナップショットID（design.track_changesで取得） / " +
          "Baseline snapshot ID (from design.track_changes)",
      },
      threshold: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.001,
        description: "pass/fail閾値（デフォルト0.001 = 0.1%） / Threshold (default 0.001 = 0.1%)",
      },
      viewport_width: {
        type: "integer",
        minimum: 320,
        maximum: 4096,
        default: 1920,
        description: "ビューポート幅 / Viewport width",
      },
      viewport_height: {
        type: "integer",
        minimum: 240,
        maximum: 16384,
        default: 1080,
        description: "ビューポート高さ / Viewport height",
      },
    },
    required: ["url", "baseline_snapshot_id"],
  },
};
