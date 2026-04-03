// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * audit.query MCPツール — 監査ログ検索
 *
 * GDPR Art.30 処理活動記録の検索・閲覧ツール。
 * PII配慮: targetIdはtruncate済み、details内機密情報除去済み。
 *
 * audit.query MCP tool — Audit log query
 * GDPR Art.30 processing activities records search tool.
 * PII consideration: targetId truncated, details sanitized.
 *
 * @module tools/audit/query.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { logger, isDevelopment } from "../../utils/logger";
import type { AuditLogService, AuditLogRecord } from "../../services/audit-log.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

/**
 * audit.query MCPエラーコード
 * audit.query MCP error codes
 */
export const AUDIT_QUERY_ERROR_CODES = {
  /** 入力バリデーションエラー / Input validation error */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** サービス未設定 / Service not available */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** 内部エラー / Internal error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AuditQueryErrorCode =
  (typeof AUDIT_QUERY_ERROR_CODES)[keyof typeof AUDIT_QUERY_ERROR_CODES];

// =====================================================
// 入力スキーマ / Input Schema
// =====================================================

/**
 * ISO 8601日付文字列バリデーション
 * ISO 8601 date string validation
 */
const isoDateStringSchema = z.string().refine(
  (val) => {
    const d = new Date(val);
    return !isNaN(d.getTime());
  },
  { message: "Invalid ISO 8601 date string" }
);

/**
 * audit.query 入力スキーマ
 * audit.query input schema
 */
export const auditQueryInputSchema = z.object({
  /** アクションフィルタ / Action filter */
  action: z.string().max(100).optional(),
  /** ターゲットタイプフィルタ / Target type filter */
  target_type: z.string().max(100).optional(),
  /** 開始日時（ISO 8601） / Start date (ISO 8601) */
  start_date: isoDateStringSchema.optional(),
  /** 終了日時（ISO 8601） / End date (ISO 8601) */
  end_date: isoDateStringSchema.optional(),
  /** 結果上限（最大100、デフォルト20） / Result limit (max 100, default 20) */
  limit: z.number().int().min(1).max(100).optional(),
});

export type AuditQueryInput = z.infer<typeof auditQueryInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

/**
 * 監査ログクエリ結果のログエントリ
 * Audit log query result entry
 */
interface AuditLogOutputEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  result: string;
}

/**
 * audit.query 出力型
 * audit.query output type
 */
export type AuditQueryOutput =
  | {
      success: true;
      data: {
        logs: AuditLogOutputEntry[];
        count: number;
      };
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

const auditLogServiceDI = createDIFactory<AuditLogService>("AuditLogService");

export const setAuditQueryServiceFactory = auditLogServiceDI.set;
export const resetAuditQueryServiceFactory = auditLogServiceDI.reset;

// =====================================================
// ヘルパー / Helpers
// =====================================================

/**
 * DB AuditLogRecord → MCP出力形式に変換
 * Convert DB AuditLogRecord to MCP output format
 */
function toOutputEntry(record: AuditLogRecord): AuditLogOutputEntry {
  return {
    id: record.id,
    timestamp:
      record.timestamp instanceof Date ? record.timestamp.toISOString() : String(record.timestamp),
    action: record.action,
    actor: record.actor,
    target_type: record.targetType,
    target_id: record.targetId,
    details: record.details,
    result: record.result,
  };
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * audit.query ツールハンドラー
 * audit.query tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns クエリ結果 / Query result
 */
export async function auditQueryHandler(input: unknown): Promise<AuditQueryOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] audit.query called");
  }

  // 入力バリデーション / Input validation
  let validated: AuditQueryInput;
  try {
    validated = auditQueryInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] audit.query validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: AUDIT_QUERY_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!auditLogServiceDI.get()) {
    logger.warn("[MCP Tool] audit.query service factory not set");

    return {
      success: false,
      error: {
        code: AUDIT_QUERY_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Audit log service is not available",
      },
    };
  }

  const service = auditLogServiceDI.get()!();

  try {
    const records = await service.query({
      action: validated.action,
      targetType: validated.target_type,
      startDate: validated.start_date ? new Date(validated.start_date) : undefined,
      endDate: validated.end_date ? new Date(validated.end_date) : undefined,
      limit: validated.limit,
    });

    const logs = records.map(toOutputEntry);

    if (isDevelopment()) {
      logger.info("[MCP Tool] audit.query completed", {
        count: logs.length,
      });
    }

    return {
      success: true,
      data: {
        logs,
        count: logs.length,
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));

    logger.warn("[MCP Tool] audit.query error", {
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: AUDIT_QUERY_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * audit.query MCPツール定義
 * audit.query MCP tool definition
 */
export const auditQueryToolDefinition = {
  name: "audit.query",
  description:
    "監査ログを検索します。GDPR Art.30に基づく処理活動記録の閲覧。" +
    "Query audit logs. View records of processing activities per GDPR Art.30.",
  annotations: {
    title: "Audit Log Query",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        description:
          "アクションフィルタ（例: data.delete, page.analyze） / " +
          "Action filter (e.g., data.delete, page.analyze)",
      },
      target_type: {
        type: "string",
        description:
          "ターゲットタイプフィルタ（例: web_page, preference_profile） / " +
          "Target type filter (e.g., web_page, preference_profile)",
      },
      start_date: {
        type: "string",
        format: "date-time",
        description: "開始日時（ISO 8601形式） / Start date (ISO 8601 format)",
      },
      end_date: {
        type: "string",
        format: "date-time",
        description: "終了日時（ISO 8601形式） / End date (ISO 8601 format)",
      },
      limit: {
        type: "number",
        description: "結果上限（最大100、デフォルト20） / Result limit (max 100, default 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[audit.query] Tool module loaded");
}
