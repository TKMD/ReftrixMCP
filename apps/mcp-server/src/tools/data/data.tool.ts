// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * data.delete / data.export MCPツール
 * GDPR Art.17 データ削除 + Art.20 データポータビリティ
 *
 * data.delete: 指定対象のデータを完全削除（忘れられる権利）
 * data.export: 指定対象のデータをJSON形式でエクスポート（データポータビリティ）
 *
 * data.delete / data.export MCP tools
 * GDPR Art.17 data deletion + Art.20 data portability
 *
 * @module tools/data/data.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "../../utils/truncate-id";
import { logger, isDevelopment } from "../../utils/logger";
import { getAuditLogService } from "../../services/audit-log.service";
import type {
  PageDeletionResult,
  ProfileDeletionResult,
  AllUserDataDeletionResult,
  PageExportResult,
  ProfileExportResult,
} from "../../services/gdpr-deletion.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

/**
 * data MCPエラーコード / data MCP error codes
 */
export const DATA_MCP_ERROR_CODES = {
  /** 入力バリデーションエラー / Input validation error */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** 削除未確認 / Deletion not confirmed */
  DELETE_NOT_CONFIRMED: "DELETE_NOT_CONFIRMED",
  /** リソース未検出 / Resource not found */
  NOT_FOUND: "NOT_FOUND",
  /** サービス未設定 / Service not available */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** 内部エラー / Internal error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type DataMcpErrorCode = (typeof DATA_MCP_ERROR_CODES)[keyof typeof DATA_MCP_ERROR_CODES];

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * GdprDeletionServiceのツール向けインターフェース
 * GdprDeletionService interface for tool use
 */
export interface GdprDeletionServiceForTool {
  deletePage(pageId: string, reason: string): Promise<PageDeletionResult>;
  deleteProfile(profileId: string, reason: string): Promise<ProfileDeletionResult>;
  deleteAllUserData(
    pageIds: string[],
    profileId: string | undefined,
    reason: string
  ): Promise<AllUserDataDeletionResult>;
  exportPageData(pageId: string): Promise<PageExportResult>;
  exportProfileData(profileId: string): Promise<ProfileExportResult>;
}

// =====================================================
// Zodスキーマ / Zod Schemas
// =====================================================

/**
 * data.delete 入力スキーマ / data.delete input schema
 */
export const dataDeleteInputSchema = z.object({
  /** 削除対象 / Deletion target */
  target: z.enum(["page", "profile", "all_user_data"]),
  /** 対象ID（UUIDv7） / Target ID (UUIDv7) */
  id: z.string().uuid(),
  /** 削除理由（GDPR監査要件） / Deletion reason (GDPR audit requirement) */
  reason: z.string().min(1).max(500),
  /** 削除確認フラグ（必須: true） / Deletion confirmation flag (required: true) */
  confirm: z.boolean(),
  /** ページID配列（target=all_user_data時のみ） / Page IDs (only for target=all_user_data) */
  page_ids: z.array(z.string().uuid()).max(100).optional(),
});

export type DataDeleteInput = z.infer<typeof dataDeleteInputSchema>;

/**
 * data.export 入力スキーマ / data.export input schema
 */
export const dataExportInputSchema = z.object({
  /** エクスポート対象 / Export target */
  target: z.enum(["page", "profile"]),
  /** 対象ID（UUIDv7） / Target ID (UUIDv7) */
  id: z.string().uuid(),
});

export type DataExportInput = z.infer<typeof dataExportInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

export type DataDeleteOutput =
  | {
      success: true;
      data: PageDeletionResult | ProfileDeletionResult | AllUserDataDeletionResult;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export type DataExportOutput =
  | {
      success: true;
      data: PageExportResult | ProfileExportResult;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// サービスファクトリー（DI） / Service Factory (DI)
// =====================================================

const deleteServiceDI = createDIFactory<GdprDeletionServiceForTool>("GdprDeletionService");
export const setDataDeleteServiceFactory = deleteServiceDI.set;
export const resetDataDeleteServiceFactory = deleteServiceDI.reset;

const exportServiceDI = createDIFactory<GdprDeletionServiceForTool>("GdprDeletionServiceExport");
export const setDataExportServiceFactory = exportServiceDI.set;
export const resetDataExportServiceFactory = exportServiceDI.reset;

// =====================================================
// エラーコード判定 / Error Code Mapping
// =====================================================

function mapErrorToCode(error: Error): DataMcpErrorCode {
  const message = error.message.toLowerCase();

  if (message.includes("not found")) {
    return DATA_MCP_ERROR_CODES.NOT_FOUND;
  }

  if (message.includes("invalid uuid") || message.includes("validation")) {
    return DATA_MCP_ERROR_CODES.VALIDATION_ERROR;
  }

  return DATA_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// data.delete ハンドラー / data.delete handler
// =====================================================

/**
 * data.delete ツールハンドラー
 * data.delete tool handler
 */
export async function dataDeleteHandler(input: unknown): Promise<DataDeleteOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] data.delete called", {
      target: (input as Record<string, unknown>)?.target,
      id: truncateId((input as Record<string, unknown>)?.id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: DataDeleteInput;
  try {
    validated = dataDeleteInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] data.delete validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: DATA_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // confirm チェック / Confirm check
  if (!validated.confirm) {
    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.DELETE_NOT_CONFIRMED,
        message:
          "Deletion not confirmed. Set confirm: true to proceed with data deletion. " +
          "削除が確認されていません。データ削除を実行するには confirm: true を設定してください。",
      },
    };
  }

  // サービスファクトリーチェック / Service factory check
  if (!deleteServiceDI.get()) {
    logger.warn("[MCP Tool] data.delete service factory not set");

    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "GDPR deletion service is not available",
      },
    };
  }

  const service = deleteServiceDI.get()!();

  try {
    let result: PageDeletionResult | ProfileDeletionResult | AllUserDataDeletionResult;

    switch (validated.target) {
      case "page":
        result = await service.deletePage(validated.id, validated.reason);
        break;

      case "profile":
        result = await service.deleteProfile(validated.id, validated.reason);
        break;

      case "all_user_data":
        result = await service.deleteAllUserData(
          validated.page_ids ?? [],
          validated.id,
          validated.reason
        );
        break;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] data.delete completed", {
        target: validated.target,
        id: truncateId(validated.id),
      });
    }

    // 監査ログ記録（GDPR Art.30） / Audit log (GDPR Art.30)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.delete",
      actor: "mcp-client",
      targetType:
        validated.target === "page"
          ? "web_page"
          : validated.target === "profile"
            ? "preference_profile"
            : "all_user_data",
      targetId: validated.id,
      result: "success",
      details: { reason: validated.reason },
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.warn("[MCP Tool] data.delete error", {
      code: errorCode,
      error: errorInstance.message,
    });

    // 監査ログ記録（失敗） / Audit log (failure)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.delete",
      actor: "mcp-client",
      targetType:
        validated.target === "page"
          ? "web_page"
          : validated.target === "profile"
            ? "preference_profile"
            : "all_user_data",
      targetId: validated.id,
      result: "failure",
      details: { reason: validated.reason },
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
// data.export ハンドラー / data.export handler
// =====================================================

/**
 * data.export ツールハンドラー
 * data.export tool handler
 */
export async function dataExportHandler(input: unknown): Promise<DataExportOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] data.export called", {
      target: (input as Record<string, unknown>)?.target,
      id: truncateId((input as Record<string, unknown>)?.id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: DataExportInput;
  try {
    validated = dataExportInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] data.export validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: DATA_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!exportServiceDI.get()) {
    logger.warn("[MCP Tool] data.export service factory not set");

    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "GDPR export service is not available",
      },
    };
  }

  const service = exportServiceDI.get()!();

  try {
    let result: PageExportResult | ProfileExportResult;

    switch (validated.target) {
      case "page":
        result = await service.exportPageData(validated.id);
        break;

      case "profile":
        result = await service.exportProfileData(validated.id);
        break;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] data.export completed", {
        target: validated.target,
        id: truncateId(validated.id),
      });
    }

    // 監査ログ記録（GDPR Art.30） / Audit log (GDPR Art.30)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.export",
      actor: "mcp-client",
      targetType: validated.target === "page" ? "web_page" : "preference_profile",
      targetId: validated.id,
      result: "success",
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.warn("[MCP Tool] data.export error", {
      code: errorCode,
      error: errorInstance.message,
    });

    // 監査ログ記録（失敗） / Audit log (failure)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.export",
      actor: "mcp-client",
      targetType: validated.target === "page" ? "web_page" : "preference_profile",
      targetId: validated.id,
      result: "failure",
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
// ツール定義 / Tool Definitions
// =====================================================

/**
 * data.delete MCPツール定義 / data.delete MCP tool definition
 */
export const dataDeleteToolDefinition = {
  name: "data.delete",
  description:
    "GDPR Art.17「忘れられる権利」に基づくデータ完全削除。" +
    "page（全関連テーブルCASCADE DELETE）、profile（嗜好プロファイル完全削除）、" +
    "all_user_data（全ユーザーデータ一括削除）から選択。confirm: true 必須。" +
    "GDPR Art.17 Right to Erasure. Permanently deletes all data for the specified target. " +
    "Supports page (CASCADE DELETE), profile (hard delete), all_user_data (bulk delete). " +
    "confirm: true is required.",
  annotations: {
    title: "Data Delete (GDPR Art.17)",
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      target: {
        type: "string",
        enum: ["page", "profile", "all_user_data"],
        description:
          "削除対象 / Deletion target: page (web page + all related data), " +
          "profile (preference profile + signals), all_user_data (all pages + profile)",
      },
      id: {
        type: "string",
        format: "uuid",
        description:
          "対象ID（UUIDv7形式） / Target ID (UUIDv7 format). " +
          "page → web_page.id, profile/all_user_data → preference_profile.id",
      },
      reason: {
        type: "string",
        description:
          "削除理由（GDPR監査要件、1-500文字） / Deletion reason (GDPR audit requirement, 1-500 chars)",
      },
      confirm: {
        type: "boolean",
        description:
          "削除確認フラグ（true必須、誤削除防止） / Deletion confirmation flag (must be true)",
      },
      page_ids: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description:
          "ページID配列（target=all_user_data時のみ、最大100件） / " +
          "Page IDs (only for target=all_user_data, max 100)",
      },
    },
    required: ["target", "id", "reason", "confirm"],
  },
};

/**
 * data.export MCPツール定義 / data.export MCP tool definition
 */
export const dataExportToolDefinition = {
  name: "data.export",
  description:
    "GDPR Art.20「データポータビリティの権利」に基づくデータエクスポート。" +
    "指定されたpage/profileの全関連データをJSON形式でエクスポート。PII情報を明示的にマーキング。" +
    "GDPR Art.20 Right to Data Portability. Exports all related data for the specified target in JSON format. " +
    "PII fields are explicitly marked.",
  annotations: {
    title: "Data Export (GDPR Art.20)",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      target: {
        type: "string",
        enum: ["page", "profile"],
        description:
          "エクスポート対象 / Export target: page (web page + all related data), profile (preference profile + signals)",
      },
      id: {
        type: "string",
        format: "uuid",
        description: "対象ID（UUIDv7形式） / Target ID (UUIDv7 format)",
      },
    },
    required: ["target", "id"],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[data.delete] Tool module loaded");
  logger.debug("[data.export] Tool module loaded");
}
