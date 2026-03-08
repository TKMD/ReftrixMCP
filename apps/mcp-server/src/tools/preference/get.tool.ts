// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.get MCPツール
 * 現在の嗜好プロファイルを取得
 *
 * preference.get MCP tool
 * Get current preference profile
 *
 * @module tools/preference/get.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  preferenceGetInputSchema,
  PREFERENCE_MCP_ERROR_CODES,
  sanitizeErrorMessage,
  truncateId,
  type PreferenceGetInput,
} from './schemas';
import type { IPreferenceService } from './hear.tool';

// =====================================================
// 型定義 / Type Definitions
// =====================================================

export type { IPreferenceService };

/**
 * preference.get 出力型
 * preference.get output type
 */
import type { SignalData } from './hear.tool';

export type PreferenceGetOutput =
  | {
      success: true;
      data:
        | {
            profile_id: string;
            name: string;
            preference_text: string | null;
            interaction_count: number;
            created_at: string;
            updated_at: string;
            signals?: SignalData[];
          }
        | {
            exists: false;
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

let preferenceServiceFactory: (() => IPreferenceService) | null = null;

/**
 * サービスファクトリーを設定
 * Set service factory
 */
export function setPreferenceServiceFactory(
  factory: () => IPreferenceService
): void {
  preferenceServiceFactory = factory;
}

/**
 * サービスファクトリーをリセット
 * Reset service factory
 */
export function resetPreferenceServiceFactory(): void {
  preferenceServiceFactory = null;
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * preference.get ツールハンドラー
 * preference.get tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns プロファイルデータ / Profile data
 */
export async function preferenceGetHandler(
  input: unknown
): Promise<PreferenceGetOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] preference.get called', {
      profileId: truncateId((input as Record<string, unknown>)?.profile_id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: PreferenceGetInput;
  try {
    validated = preferenceGetInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      logger.warn('[MCP Tool] preference.get validation error', {
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

  // サービスファクトリーチェック / Service factory check
  if (!preferenceServiceFactory) {
    logger.warn('[MCP Tool] preference.get service factory not set');

    return {
      success: false,
      error: {
        code: PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'Preference service is not available',
      },
    };
  }

  const service = preferenceServiceFactory();

  try {
    const profile = await service.getProfile(validated.profile_id);

    if (profile === null) {
      if (isDevelopment()) {
        logger.info('[MCP Tool] preference.get profile not found', {
          profileId: truncateId(validated.profile_id),
        });
      }

      return {
        success: true,
        data: { exists: false },
      };
    }

    // include_signals: true → シグナルも含める（GDPRデータポータビリティ）
    // include_signals: true → include signals (GDPR data portability)
    let signals: SignalData[] | undefined;
    if (validated.include_signals) {
      signals = await service.getSignals(profile.profile_id);
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] preference.get completed', {
        profileId: truncateId(profile.profile_id),
        interactionCount: profile.interaction_count,
        signalsIncluded: !!signals,
      });
    }

    return {
      success: true,
      data: signals ? { ...profile, signals } : profile,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));

    // 全環境でログ出力（isDevelopmentガードなし）
    // Log in all environments (no isDevelopment guard)
    logger.warn('[MCP Tool] preference.get error', {
      code: PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR,
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * preference.get MCPツール定義
 * preference.get MCP tool definition
 */
export const preferenceGetToolDefinition = {
  name: 'preference.get',
  description:
    '現在の嗜好プロファイルを取得します。profile_id省略時はデフォルトプロファイルを返します。' +
    'Get current preference profile. Returns default profile when profile_id is omitted.',
  annotations: {
    title: 'Preference Get',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      profile_id: {
        type: 'string',
        format: 'uuid',
        description: 'プロファイルID（省略時はデフォルト） / Profile ID (default if omitted)',
      },
      include_signals: {
        type: 'boolean',
        description:
          'シグナルデータを含める（GDPRデータポータビリティ対応） / ' +
          'Include signal data (GDPR data portability compliance)',
      },
    },
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug('[preference.get] Tool module loaded');
}
