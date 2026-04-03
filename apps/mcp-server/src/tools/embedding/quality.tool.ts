// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding.quality MCPツール — Embedding品質監視
 *
 * DINOv2/e5-base両方のembedding品質を監視し、
 * サイレント劣化を防止するMCPツール。
 *
 * embedding.quality MCP tool — Embedding quality monitoring
 * Monitors embedding quality for both DINOv2/e5-base,
 * preventing silent degradation.
 *
 * @module tools/embedding/quality.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { logger, isDevelopment } from "../../utils/logger";
import type {
  EmbeddingQualityMonitorService,
  QualityMonitorResult,
  MonitorScope,
} from "../../services/embedding-quality-monitor.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

/**
 * embedding.quality MCPエラーコード
 * embedding.quality MCP error codes
 */
export const EMBEDDING_QUALITY_ERROR_CODES = {
  /** 入力バリデーションエラー / Input validation error */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** サービス未設定 / Service not available */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** 内部エラー / Internal error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type EmbeddingQualityErrorCode =
  (typeof EMBEDDING_QUALITY_ERROR_CODES)[keyof typeof EMBEDDING_QUALITY_ERROR_CODES];

// =====================================================
// 入力スキーマ / Input Schema
// =====================================================

/**
 * embedding.quality 入力スキーマ
 * embedding.quality input schema
 */
export const embeddingQualityInputSchema = z.object({
  /** 監視スコープ / Monitoring scope */
  scope: z
    .enum(["all", "sections", "parts"])
    .optional()
    .default("all")
    .describe("Monitoring scope: all, sections, or parts"),
  /** 特定ページに限定 / Limit to specific page */
  web_page_id: z.string().uuid().optional().describe("Filter by specific web page ID (UUID)"),
  /** 分布統計を含めるか / Include distribution statistics */
  include_distribution: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include embedding distribution statistics (mean, std, min, max, L2 norm)"),
});

export type EmbeddingQualityInput = z.infer<typeof embeddingQualityInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

/**
 * embedding.quality 出力型
 * embedding.quality output type
 */
export type EmbeddingQualityOutput =
  | {
      success: true;
      data: QualityMonitorResult;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// DI Factory
// =====================================================

const embeddingQualityServiceDI = createDIFactory<EmbeddingQualityMonitorService>(
  "EmbeddingQualityMonitorService"
);

export const setEmbeddingQualityServiceFactory = embeddingQualityServiceDI.set;
export const resetEmbeddingQualityServiceFactory = embeddingQualityServiceDI.reset;

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * embedding.quality ツールハンドラー
 * embedding.quality tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns 品質監視結果 / Quality monitoring result
 */
export async function embeddingQualityHandler(input: unknown): Promise<EmbeddingQualityOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] embedding.quality called");
  }

  // 入力バリデーション / Input validation
  let validated: EmbeddingQualityInput;
  try {
    validated = embeddingQualityInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] embedding.quality validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: EMBEDDING_QUALITY_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!embeddingQualityServiceDI.get()) {
    logger.warn("[MCP Tool] embedding.quality service factory not set");

    return {
      success: false,
      error: {
        code: EMBEDDING_QUALITY_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Embedding quality monitor service is not available",
      },
    };
  }

  const service = embeddingQualityServiceDI.get()!();

  try {
    const result = await service.monitor({
      scope: validated.scope as MonitorScope,
      webPageId: validated.web_page_id,
      includeDistribution: validated.include_distribution ?? false,
    });

    if (isDevelopment()) {
      logger.info("[MCP Tool] embedding.quality completed", {
        qualityScore: result.qualityScore,
        alertCount: result.alerts.length,
      });
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));

    logger.warn("[MCP Tool] embedding.quality error", {
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: EMBEDDING_QUALITY_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * embedding.quality MCPツール定義
 * embedding.quality MCP tool definition
 */
export const embeddingQualityToolDefinition = {
  name: "embedding.quality",
  description:
    "Embedding品質を監視します。DINOv2/e5-baseのカバレッジ、異常検出、ドリフト検出を実行。" +
    "Monitor embedding quality. Runs coverage, anomaly detection, and drift detection for DINOv2/e5-base.",
  annotations: {
    title: "Embedding Quality Monitor",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "sections", "parts"],
        description:
          "監視スコープ（all: セクション+パーツ、sections: セクションのみ、parts: パーツのみ） / " +
          "Monitoring scope (all: sections+parts, sections: sections only, parts: parts only)",
        default: "all",
      },
      web_page_id: {
        type: "string",
        format: "uuid",
        description: "特定ページに限定（UUID） / " + "Filter by specific web page ID (UUID)",
      },
      include_distribution: {
        type: "boolean",
        description:
          "分布統計を含める（mean, std, min, max, L2 norm） / " +
          "Include distribution statistics (mean, std, min, max, L2 norm)",
        default: false,
      },
    },
    required: [],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[embedding.quality] Tool module loaded");
}
