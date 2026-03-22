// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.reset MCPツール
 * 嗜好プロファイルのリセット
 *
 * preference.reset MCP tool
 * Reset preference profile
 *
 * @module tools/preference/reset.tool
 */

import { ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import {
  preferenceResetInputSchema,
  PREFERENCE_MCP_ERROR_CODES,
  sanitizeErrorMessage,
  truncateId,
  type PreferenceResetInput,
} from "./schemas";
import type { IPreferenceService } from "./hear.tool";

// =====================================================
// 型定義 / Type Definitions
// =====================================================

export type { IPreferenceService };

/**
 * preference.reset 出力型
 * preference.reset output type
 */
export type PreferenceResetOutput =
  | {
      success: true;
      data: {
        reset: boolean;
        profile_id: string;
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
// サービスファクトリー（DI） / Service Factory (DI)
// =====================================================

const preferenceServiceDI = createDIFactory<IPreferenceService>("PreferenceService");
export const setPreferenceServiceFactory = preferenceServiceDI.set;
export const resetPreferenceServiceFactory = preferenceServiceDI.reset;

// =====================================================
// エラーコード判定 / Error Code Mapping
// =====================================================

/**
 * エラーからエラーコードを判定
 * Map error to error code
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("profile not found") || message.includes("not found")) {
    return PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND;
  }

  return PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * preference.reset ツールハンドラー
 * preference.reset tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns リセット結果 / Reset result
 */
export async function preferenceResetHandler(input: unknown): Promise<PreferenceResetOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] preference.reset called", {
      profileId: truncateId((input as Record<string, unknown>)?.profile_id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: PreferenceResetInput;
  try {
    validated = preferenceResetInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] preference.reset validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // confirm チェック / Confirm check
  if (!validated.confirm) {
    if (isDevelopment()) {
      logger.info("[MCP Tool] preference.reset rejected: confirm is false");
    }

    return {
      success: false,
      error: {
        code: PREFERENCE_MCP_ERROR_CODES.RESET_NOT_CONFIRMED,
        message: "Reset not confirmed. Set confirm: true to proceed with profile reset.",
      },
    };
  }

  // サービスファクトリーチェック / Service factory check
  if (!preferenceServiceDI.get()) {
    logger.warn("[MCP Tool] preference.reset service factory not set");

    return {
      success: false,
      error: {
        code: PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Preference service is not available",
      },
    };
  }

  const service = preferenceServiceDI.get()!();

  try {
    // hard_delete: true → プロファイル完全削除（GDPR忘れられる権利）
    // hard_delete: true → permanently delete profile (GDPR Right to Erasure)
    if (validated.hard_delete) {
      const result = await service.deleteProfile(validated.profile_id);

      if (isDevelopment()) {
        logger.info("[MCP Tool] preference.reset hard delete completed", {
          profileId: truncateId(result.profile_id),
          deleted: result.deleted,
        });
      }

      return {
        success: true,
        data: { reset: true, profile_id: result.profile_id },
      };
    }

    const result = await service.resetProfile(validated.profile_id);

    if (isDevelopment()) {
      logger.info("[MCP Tool] preference.reset completed", {
        profileId: truncateId(result.profile_id),
        reset: result.reset,
      });
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    // 全環境でログ出力（isDevelopmentガードなし）
    // Log in all environments (no isDevelopment guard)
    logger.warn("[MCP Tool] preference.reset error", {
      code: errorCode,
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(errorCode),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * preference.reset MCPツール定義
 * preference.reset MCP tool definition
 */
export const preferenceResetToolDefinition = {
  name: "preference.reset",
  description:
    "嗜好プロファイルをリセットします。confirm: trueが必須です。preference_signalsもCASCADE削除されます。" +
    "Reset preference profile. confirm: true is required. preference_signals are CASCADE deleted.",
  annotations: {
    title: "Preference Reset",
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      profile_id: {
        type: "string",
        format: "uuid",
        description: "プロファイルID（必須） / Profile ID (required)",
      },
      confirm: {
        type: "boolean",
        description:
          "リセット確認フラグ（trueでリセット実行） / Reset confirmation flag (true to execute reset)",
      },
      hard_delete: {
        type: "boolean",
        description:
          "完全削除フラグ（trueでプロファイルとシグナルを完全に削除、GDPR忘れられる権利対応） / " +
          "Hard delete flag (true to permanently delete profile and signals, GDPR Right to Erasure)",
      },
    },
    required: ["profile_id", "confirm"],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[preference.reset] Tool module loaded");
}
