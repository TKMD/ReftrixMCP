// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.inspect MCPツール
 * 特定のUIコンポーネントパーツの詳細情報を取得します
 *
 * 機能:
 * - パーツIDによる詳細情報取得（computedStyles, htmlSnippet, interactionInfo等）
 * - Embedding情報の取得（オプション）
 * - セクションパターン・WebページURLとの関連情報
 *
 * Features:
 * - Detailed part info by part ID (computedStyles, htmlSnippet, interactionInfo, etc.)
 * - Embedding info retrieval (optional)
 * - Related section pattern and web page URL info
 *
 * @module tools/part/inspect.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeHtml } from "../../utils/html-sanitizer";
import {
  partInspectInputSchema,
  truncateId,
  type PartInspectInput,
} from "../../services/part/schemas";

// =====================================================
// 型定義
// =====================================================

/**
 * PrismaClientインターフェース（部分的、DI用）
 * PrismaClient interface (partial, for DI)
 */
export interface PartInspectPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * part.inspect 結果のパーツ詳細情報
 * Part detail info for part.inspect result
 */
export interface PartInspectDetail {
  id: string;
  partType: string;
  partSubtype: string | null;
  htmlSnippet: string | null;
  computedStyles: Record<string, string>;
  boundingBox: Record<string, unknown>;
  cssClasses: string[];
  attributes: Record<string, unknown>;
  interactionInfo: Record<string, unknown>;
  visualSignature: string | null;
  sampleIndex: number;
  piiRiskLevel: string;
  tags: string[];
  metadata: Record<string, unknown>;
  sourceUrl: string | null;
  usageScope: string;
  sectionType: string;
  webPageUrl: string;
  createdAt: string;
  hasTextEmbedding?: boolean;
  hasVisualEmbedding?: boolean;
}

/**
 * part.inspect 出力型
 * part.inspect output type
 */
export type PartInspectOutput =
  | {
      success: true;
      data: PartInspectDetail;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// エラーコード / Error codes
// =====================================================

export const PART_INSPECT_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// =====================================================
// DI ファクトリー / DI Factory
// =====================================================

let prismaClientFactory: (() => PartInspectPrismaClient) | null = null;

/**
 * PrismaClientファクトリーを設定
 * Set PrismaClient factory
 */
export function setPartInspectPrismaClientFactory(factory: () => PartInspectPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリーをリセット（テスト用）
 * Reset PrismaClient factory (for testing)
 */
export function resetPartInspectPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// エラーハンドリング / Error handling
// =====================================================

/**
 * エラーメッセージをサニタイズ（内部構造の漏洩防止）
 * Sanitize error message (prevent internal structure leakage)
 */
function sanitizePartInspectError(error: unknown): string {
  if (error instanceof Error) {
    const prismaError = error as { code?: string };
    if (prismaError.code) {
      switch (prismaError.code) {
        case "P2002":
          return "A record with this value already exists";
        case "P2025":
          return "Record not found";
        default:
          return "Database operation failed";
      }
    }
  }
  return "An internal error occurred";
}

// =====================================================
// DB行の型定義 / DB row types
// =====================================================

/**
 * パーツ詳細クエリの結果行
 * Part detail query result row
 */
interface PartDetailRow {
  id: string;
  part_type: string;
  part_subtype: string | null;
  html_snippet: string | null;
  computed_styles: Record<string, string>;
  bounding_box: Record<string, unknown>;
  css_classes: string[];
  attributes: Record<string, unknown>;
  interaction_info: Record<string, unknown>;
  visual_signature: string | null;
  sample_index: number;
  pii_risk_level: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source_url: string | null;
  usage_scope: string;
  section_type: string;
  web_page_url: string;
  created_at: string;
  has_text_embedding: boolean;
  has_visual_embedding: boolean;
}

// =====================================================
// メインハンドラー
// =====================================================

/**
 * part.inspect ツールハンドラー
 * part.inspect tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns パーツ詳細情報 / Part detail info
 */
export async function partInspectHandler(input: unknown): Promise<PartInspectOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] part.inspect called", {
      partId: (input as Record<string, unknown>)?.part_id
        ? truncateId(String((input as Record<string, unknown>).part_id))
        : undefined,
    });
  }

  // 入力バリデーション / Input validation
  let validated: PartInspectInput;
  try {
    validated = partInspectInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] part.inspect validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: PART_INSPECT_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // PrismaClient取得 / Get PrismaClient
  if (!prismaClientFactory) {
    return {
      success: false,
      error: {
        code: PART_INSPECT_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Part inspect service is not available",
      },
    };
  }

  const prisma = prismaClientFactory();

  try {
    // パーツ詳細を取得 / Get part details
    const rows = await prisma.$queryRawUnsafe<PartDetailRow[]>(
      `SELECT
        cp.id,
        cp.part_type,
        cp.part_subtype,
        ${validated.include_html ? "cp.html_snippet," : "NULL AS html_snippet,"}
        cp.computed_styles,
        cp.bounding_box,
        cp.css_classes,
        cp.attributes,
        cp.interaction_info,
        cp.visual_signature,
        cp.sample_index,
        cp.pii_risk_level,
        cp.tags,
        cp.metadata,
        cp.source_url,
        cp.usage_scope,
        sp.section_type,
        wp.url AS web_page_url,
        cp.created_at::text AS created_at,
        ${
          validated.include_embedding
            ? "(cpe.text_embedding IS NOT NULL) AS has_text_embedding, (cpe.visual_embedding IS NOT NULL) AS has_visual_embedding"
            : "FALSE AS has_text_embedding, FALSE AS has_visual_embedding"
        }
      FROM component_parts cp
      INNER JOIN section_patterns sp ON sp.id = cp.section_pattern_id
      INNER JOIN web_pages wp ON wp.id = cp.web_page_id
      ${
        validated.include_embedding
          ? "LEFT JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id"
          : ""
      }
      WHERE cp.id = $1
      LIMIT 1`,
      validated.part_id
    );

    if (rows.length === 0) {
      return {
        success: false,
        error: {
          code: PART_INSPECT_ERROR_CODES.NOT_FOUND,
          message: `Part not found: ${truncateId(validated.part_id)}`,
        },
      };
    }

    const row = rows[0];
    if (!row) {
      return {
        success: false,
        error: {
          code: PART_INSPECT_ERROR_CODES.NOT_FOUND,
          message: `Part not found: ${truncateId(validated.part_id)}`,
        },
      };
    }

    // レスポンス構築 / Build response
    const detail: PartInspectDetail = {
      id: row.id,
      partType: row.part_type,
      partSubtype: row.part_subtype,
      htmlSnippet: row.html_snippet ? sanitizeHtml(row.html_snippet) : row.html_snippet,
      computedStyles: row.computed_styles ?? {},
      boundingBox: row.bounding_box ?? {},
      cssClasses: row.css_classes ?? [],
      attributes: row.attributes ?? {},
      interactionInfo: row.interaction_info ?? {},
      visualSignature: row.visual_signature,
      sampleIndex: row.sample_index,
      piiRiskLevel: row.pii_risk_level,
      tags: row.tags ?? [],
      metadata: row.metadata ?? {},
      sourceUrl: row.source_url,
      usageScope: row.usage_scope,
      sectionType: row.section_type,
      webPageUrl: row.web_page_url,
      createdAt: row.created_at,
    };

    if (validated.include_embedding) {
      detail.hasTextEmbedding = row.has_text_embedding;
      detail.hasVisualEmbedding = row.has_visual_embedding;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] part.inspect completed", {
        partId: truncateId(validated.part_id),
        partType: detail.partType,
      });
    }

    return {
      success: true,
      data: detail,
    };
  } catch (error) {
    logger.warn("[MCP Tool] part.inspect error", {
      error: sanitizePartInspectError(error),
      partId: truncateId(validated.part_id),
    });

    return {
      success: false,
      error: {
        code: PART_INSPECT_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizePartInspectError(error),
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * part.inspect MCPツール定義
 * part.inspect MCP tool definition
 */
export const partInspectToolDefinition = {
  name: "part.inspect",
  description:
    "特定のUIコンポーネントパーツの詳細情報を取得します。" +
    "スタイル、HTML、バウンディングボックス、インタラクション情報、Embedding有無等を返します。" +
    " / Inspect a specific UI component part by ID. " +
    "Returns styles, HTML, bounding box, interaction info, embedding status, etc.",
  annotations: {
    title: "Part Inspect",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      part_id: {
        type: "string",
        format: "uuid",
        description: "パーツID（UUID） / Part ID (UUID)",
      },
      include_html: {
        type: "boolean",
        default: false,
        description: "サニタイズ済みHTMLスニペットを含める / Include sanitized HTML snippet",
      },
      include_embedding: {
        type: "boolean",
        default: false,
        description: "Embedding有無情報を含める / Include embedding availability info",
      },
    },
    required: ["part_id"],
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug("[part.inspect] Tool module loaded");
}
