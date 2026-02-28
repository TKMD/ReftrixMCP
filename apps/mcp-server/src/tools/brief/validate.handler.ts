// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.validate MCPツールハンドラー
 * デザインブリーフを検証し、完成度スコアと改善提案を返します
 *
 * 機能:
 * - ブリーフの完成度検証
 * - 完成度スコア計算（0-100）
 * - Issue生成（error/warning/suggestion）
 * - 改善提案生成
 * - strictMode対応
 * - Response Objectパターン
 *
 * @module tools/brief/validate.handler
 */

import { logger, isDevelopment } from '../../utils/logger';

import {
  briefValidateInputSchema,
  BRIEF_MCP_ERROR_CODES,
  type BriefValidateInput,
  type BriefValidateOutput,
  type BriefValidationResult,
} from './schemas';

import {
  BriefValidateService,
  type IBriefValidateService,
} from './validate.service';

// =====================================================
// 型定義
// =====================================================

export type { BriefValidateInput, BriefValidateOutput };

/**
 * サービスファクトリインターフェース
 * テスト時のDI用
 */
export type IBriefValidateServiceFactory = () => IBriefValidateService;

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let serviceFactory: IBriefValidateServiceFactory | null = null;

/**
 * カスタムサービスファクトリを設定
 * @param factory - サービスファクトリ関数
 */
export function setBriefValidateServiceFactory(
  factory: IBriefValidateServiceFactory
): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリをリセット（デフォルトに戻す）
 */
export function resetBriefValidateServiceFactory(): void {
  serviceFactory = null;
}

/**
 * サービスインスタンスを取得
 * @returns IBriefValidateService
 */
function getService(): IBriefValidateService {
  if (serviceFactory) {
    return serviceFactory();
  }
  return new BriefValidateService();
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * brief.validate ツールハンドラー
 * デザインブリーフを検証し、完成度スコアと改善提案を返します
 *
 * @param input - 入力（brief, strictMode）
 * @returns BriefValidateOutput - Response Objectパターン
 */
export async function briefValidateHandler(
  input: unknown
): Promise<BriefValidateOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] brief.validate called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: BriefValidateInput;
  try {
    validated = briefValidateInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] brief.validate validation error', { error });
    }
    return {
      success: false,
      error: {
        code: BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  try {
    // サービスを取得してバリデーション実行
    const service = getService();
    const result: BriefValidationResult = await service.validate(
      validated.brief,
      validated.strictMode
    );

    if (isDevelopment()) {
      logger.info('[MCP Tool] brief.validate completed', {
        isValid: result.isValid,
        completenessScore: result.completenessScore,
        issueCount: result.issues.length,
        readyForDesign: result.readyForDesign,
      });
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] brief.validate error', { error });
    }
    return {
      success: false,
      error: {
        code: BRIEF_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Validation failed',
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * brief.validate ツール定義
 * MCP Server登録用
 */
export const briefValidateToolDefinition = {
  name: 'brief.validate' as const,
  description:
    'Validate design brief and return completeness score with improvement suggestions.',
  annotations: {
    title: 'Brief Validate',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      brief: {
        type: 'object' as const,
        description: 'Design brief to validate',
        properties: {
          projectName: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Project name (required, 1-200 chars)',
          },
          description: {
            type: 'string',
            maxLength: 2000,
            description: 'Project description (optional, max 2000 chars)',
          },
          targetAudience: {
            type: 'string',
            maxLength: 500,
            description: 'Target audience (optional, max 500 chars)',
          },
          industry: {
            type: 'string',
            maxLength: 100,
            description: 'Industry/field (optional, max 100 chars)',
          },
          tone: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'professional',
                'playful',
                'minimal',
                'bold',
                'elegant',
                'friendly',
                'corporate',
                'creative',
              ],
            },
            description:
              'Design tone (optional): professional, playful, minimal, bold, elegant, friendly, corporate, creative',
          },
          colorPreferences: {
            type: 'object',
            description: 'Color settings (optional)',
            properties: {
              primary: {
                type: 'string',
                pattern: '^#[0-9A-Fa-f]{6}$',
                description: 'Primary color (HEX: #RRGGBB)',
              },
              secondary: {
                type: 'string',
                pattern: '^#[0-9A-Fa-f]{6}$',
                description: 'Secondary color (HEX: #RRGGBB)',
              },
              accent: {
                type: 'string',
                pattern: '^#[0-9A-Fa-f]{6}$',
                description: 'Accent color (HEX: #RRGGBB)',
              },
            },
          },
          references: {
            type: 'array',
            maxItems: 10,
            description: 'Reference sites (optional, max 10)',
            items: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  format: 'uri',
                  description: 'Reference site URL',
                },
                note: {
                  type: 'string',
                  maxLength: 200,
                  description: 'Note (max 200 chars)',
                },
              },
              required: ['url'],
            },
          },
          constraints: {
            type: 'object',
            description: 'Constraints (optional)',
            properties: {
              mustHave: {
                type: 'array',
                items: { type: 'string' },
                description: 'Required elements',
              },
              mustAvoid: {
                type: 'array',
                items: { type: 'string' },
                description: 'Elements to avoid',
              },
            },
          },
        },
        required: ['projectName'],
      },
      strictMode: {
        type: 'boolean',
        default: false,
        description:
          'Strict mode: require description, tone, colorPreferences, references (2+) (default: false)',
      },
    },
    required: ['brief'],
  },
};
