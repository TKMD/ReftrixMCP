// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * report.generate MCPツール
 * 分析結果をHTML/PDFレポートとして出力する
 *
 * report.generate MCP Tool
 * Generates analysis reports in HTML or PDF format
 *
 * セキュリティ:
 * - Zodバリデーション
 * - sanitizeErrorMessage使用 (CWE-209)
 * - UUIDバリデーション
 *
 * @module tools/report/generate.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { generateReport, REPORT_ERROR_CODES } from "../../services/report-template.service";

// =====================================================
// Constants / 定数
// =====================================================

/** UUID v4/v7 pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

export const reportGenerateInputSchema = z.object({
  web_page_id: z
    .string()
    .regex(UUID_PATTERN, "Invalid UUID format")
    .describe("レポート対象のWebページID（UUID形式） / Web page ID for report (UUID format)"),
  format: z
    .enum(["html", "pdf"])
    .describe(
      "出力フォーマット: html（インタラクティブ）またはpdf（印刷用） / " +
        "Output format: html (interactive) or pdf (printable)"
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe("レポートタイトル（省略時は自動生成） / Report title (auto-generated if omitted)"),
  include_screenshot: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "スクリーンショットを埋め込むか（デフォルト: true） / " + "Embed screenshot (default: true)"
    ),
  include_motion: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "モーションパターンを含めるか（デフォルト: true） / " +
        "Include motion patterns (default: true)"
    ),
  include_quality: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "品質評価を含めるか（デフォルト: true） / " + "Include quality evaluation (default: true)"
    ),
});

export type ReportGenerateInput = z.infer<typeof reportGenerateInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface ReportGenerateOutput {
  success: boolean;
  /** 出力フォーマット / Output format */
  format?: string;
  /** HTMLコンテンツ or PDF Base64 / HTML content or PDF Base64 */
  content?: string;
  /** コンテンツサイズ (bytes) / Content size (bytes) */
  content_size_bytes?: number;
  /** エラー情報 / Error info */
  error?: string;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * report.generate ハンドラー
 * report.generate handler
 */
export async function reportGenerateHandler(input: unknown): Promise<ReportGenerateOutput> {
  const startTime = Date.now();

  // 入力バリデーション / Input validation
  let parsed: ReportGenerateInput;
  try {
    parsed = reportGenerateInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      error: `${REPORT_ERROR_CODES.VALIDATION_ERROR}: ${message}`,
    };
  }

  try {
    const reportInput: Parameters<typeof generateReport>[0] = {
      webPageId: parsed.web_page_id,
      format: parsed.format,
      includeScreenshot: parsed.include_screenshot,
      includeMotion: parsed.include_motion,
      includeQuality: parsed.include_quality,
    };
    if (parsed.title !== undefined) reportInput.title = parsed.title;

    const result = await generateReport(reportInput);

    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }

    const output: ReportGenerateOutput = { success: true };
    if (result.format !== undefined) output.format = result.format;
    if (result.content !== undefined) output.content = result.content;
    if (result.contentSizeBytes !== undefined) output.content_size_bytes = result.contentSizeBytes;
    return output;
  } catch (error) {
    logger.warn("[report.generate] Handler failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${REPORT_ERROR_CODES.TEMPLATE_ERROR}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[report.generate] completed", {
      format: parsed.format,
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const reportGenerateToolDefinition = {
  name: "report.generate",
  description:
    "分析済みWebページのレポートをHTML（インタラクティブ）またはPDF（印刷用）形式で生成します。" +
    "セクション構成、モーションパターン、品質スコア、スクリーンショットを集約した" +
    "クライアント納品可能なレポートを出力します。" +
    " / Generates analysis reports in HTML (interactive) or PDF (printable) format. " +
    "Aggregates sections, motion patterns, quality scores, and screenshots " +
    "into a client-deliverable report.",
  annotations: {
    title: "Report Generator",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      web_page_id: {
        type: "string",
        format: "uuid",
        description: "レポート対象のWebページID / Web page ID for report",
      },
      format: {
        type: "string",
        enum: ["html", "pdf"],
        description: "出力フォーマット / Output format: html or pdf",
      },
      title: {
        type: "string",
        maxLength: 200,
        description: "レポートタイトル（省略時は自動生成） / Report title (optional)",
      },
      include_screenshot: {
        type: "boolean",
        default: true,
        description: "スクリーンショット埋め込み / Include screenshot",
      },
      include_motion: {
        type: "boolean",
        default: true,
        description: "モーションパターン / Include motion patterns",
      },
      include_quality: {
        type: "boolean",
        default: true,
        description: "品質評価 / Include quality evaluation",
      },
    },
    required: ["web_page_id", "format"],
  },
};
