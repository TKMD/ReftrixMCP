// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * style.get_palette MCPツールハンドラー
 * ブランドパレットを取得するMCPツール
 *
 * 機能:
 * - パラメータなし: 全パレット一覧を返す
 * - id指定: パレット詳細を返す
 * - brand_name指定: ブランド名で部分一致検索
 * - mode指定: light/dark/bothでフィルタリング
 * - include_gradients: グラデーションの有無
 *
 * @module tools/style-get-palette
 */

import { ZodError } from 'zod';
import {
  styleGetPaletteInputSchema,
  type StyleGetPaletteInput,
} from './schemas/style-schemas';
import {
  PaletteService,
  createPaletteServiceWithDb,
  type GetPaletteResult,
  type GetPaletteOptions,
} from '../services/style/palette-service';
import { createLogger, isDevelopment } from '../utils/logger';
import { McpError, ErrorCode } from '../utils/errors';
import { prisma } from '@reftrix/database';

// =============================================================================
// サービスインターフェース（テスト用依存性注入）
// =============================================================================

/**
 * PaletteServiceのインターフェース（テスト用）
 */
interface IPaletteService {
  getPalette(options: GetPaletteOptions): Promise<GetPaletteResult>;
}

/**
 * デフォルトPaletteServiceファクトリー
 * データベースを優先使用し、失敗時はインメモリにフォールバック
 */
function createDefaultPaletteService(): IPaletteService {
  try {
    return createPaletteServiceWithDb(prisma);
  } catch (error) {
    if (isDevelopment()) {
      logger.warn('Failed to create DB-backed PaletteService, falling back to in-memory', { error });
    }
    return new PaletteService();
  }
}

/**
 * PaletteServiceファクトリー
 * テスト時にモックを注入するために使用
 */
let paletteServiceFactory: () => IPaletteService = createDefaultPaletteService;

/**
 * PaletteServiceファクトリーを設定（テスト用）
 * @internal
 */
export function setPaletteServiceFactory(factory: () => IPaletteService): void {
  paletteServiceFactory = factory;
}

/**
 * PaletteServiceファクトリーをリセット（テスト後のクリーンアップ用）
 * @internal
 */
export function resetPaletteServiceFactory(): void {
  paletteServiceFactory = createDefaultPaletteService;
}

// =============================================================================
// 型定義
// =============================================================================

/**
 * style.get_palette 成功レスポンス
 */
interface StyleGetPaletteSuccessResponse {
  success: true;
  data: GetPaletteResult;
}

/**
 * style.get_palette エラーレスポンス
 */
interface StyleGetPaletteErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

/**
 * style.get_palette レスポンス型
 */
type StyleGetPaletteResponse = StyleGetPaletteSuccessResponse | StyleGetPaletteErrorResponse;

// =============================================================================
// ユーティリティ
// =============================================================================

const logger = createLogger('style.get_palette');

/**
 * エラーレスポンスを生成
 */
function createErrorResponse(
  code: string,
  message: string,
  suggestion?: string
): StyleGetPaletteErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      suggestion: suggestion ?? 'パラメータなしで呼び出して利用可能なパレット一覧を確認してください。',
    },
  };
}

/**
 * 成功レスポンスを生成
 */
function createSuccessResponse(data: GetPaletteResult): StyleGetPaletteSuccessResponse {
  return {
    success: true,
    data,
  };
}

// =============================================================================
// ハンドラー
// =============================================================================

/**
 * style.get_palette ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns ツールレスポンス（server.tsでMCP形式にラップされる）
 */
export async function styleGetPaletteHandler(
  input: unknown
): Promise<StyleGetPaletteResponse> {
  if (isDevelopment()) {
    logger.info('style.get_palette called', { input });
  }

  // 入力バリデーション
  let validated: StyleGetPaletteInput;
  try {
    validated = styleGetPaletteInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const firstError = error.errors[0];

      // IDの形式エラー
      if (firstError?.path.includes('id')) {
        if (isDevelopment()) {
          logger.error('Invalid palette ID format', { errors: error.errors });
        }
        return createErrorResponse(
          'CREATIVE_INVALID_PALETTE_ID',
          `無効なパレットID形式です: ${firstError.message}`,
          'UUIDv7形式のIDを指定してください。'
        );
      }

      // その他のバリデーションエラー
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('Validation error', { errors: error.errors });
      }

      return createErrorResponse(
        'VALIDATION_ERROR',
        `入力バリデーションエラー: ${errorMessage}`
      );
    }
    throw error;
  }

  try {
    // PaletteServiceを使用してパレットを取得
    // テスト時にファクトリーを通じてモックを注入可能
    const service = paletteServiceFactory();
    const result = await service.getPalette({
      id: validated.id,
      brand_name: validated.brand_name,
      mode: validated.mode,
      include_gradients: validated.include_gradients,
      auto_generate_gradients: validated.auto_generate_gradients,
      gradient_options: validated.gradient_options,
    });

    if (isDevelopment()) {
      logger.info('style.get_palette completed', {
        hasPalette: result.palette !== undefined,
        paletteCount: result.palettes?.length,
      });
    }

    return createSuccessResponse(result);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('style.get_palette error', { error });
    }

    // エラーメッセージを取得
    const errorMessage = error instanceof Error ? error.message : String(error);

    // CREATIVE_PALETTE_NOT_FOUNDエラー
    if (errorMessage.includes('CREATIVE_PALETTE_NOT_FOUND')) {
      return createErrorResponse(
        'CREATIVE_PALETTE_NOT_FOUND',
        'パレットが見つかりません',
        'パラメータなしで呼び出して利用可能なパレット一覧を確認してください。'
      );
    }

    // CREATIVE_INVALID_PALETTE_IDエラー
    if (errorMessage.includes('CREATIVE_INVALID_PALETTE_ID')) {
      return createErrorResponse(
        'CREATIVE_INVALID_PALETTE_ID',
        '無効なパレットID形式です',
        'UUIDv7形式のIDを指定してください。'
      );
    }

    // McpErrorの場合
    if (error instanceof McpError) {
      return createErrorResponse(error.code, error.message);
    }

    // 予期しないエラー
    return createErrorResponse(
      ErrorCode.INTERNAL_ERROR,
      'パレット取得中にエラーが発生しました',
      'しばらく待ってから再試行してください。'
    );
  }
}

// =============================================================================
// ツール定義
// =============================================================================

/**
 * style.get_palette ツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const styleGetPaletteToolDefinition = {
  name: 'style.get_palette',
  description:
    'Get brand palette. Specify ID for details or no params for list. Includes OKLCH color values and gradient definitions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: 'Palette ID (UUID). Returns palette details when specified.',
      },
      brand_name: {
        type: 'string',
        maxLength: 200,
        description: 'Partial match search by brand name.',
      },
      mode: {
        type: 'string',
        enum: ['light', 'dark', 'both'],
        default: 'both',
        description:
          'Filter by palette mode. light/dark/both (default: both)',
      },
      include_gradients: {
        type: 'boolean',
        default: true,
        description:
          'Include gradient info when ID specified (default: true)',
      },
      auto_generate_gradients: {
        type: 'boolean',
        default: false,
        description:
          'Auto-generate gradients from color tokens (default: false). When true, generates gradients based on token pairs.',
      },
      gradient_options: {
        type: 'object',
        description: 'Options for auto-generating gradients.',
        properties: {
          type: {
            type: 'string',
            enum: ['linear', 'radial'],
            default: 'linear',
            description: 'Gradient type (default: linear)',
          },
          angle: {
            type: 'number',
            minimum: 0,
            maximum: 360,
            default: 135,
            description: 'Angle for linear gradient (0-360, default: 135)',
          },
          token_pairs: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 2,
            },
            description: 'Token pairs to generate gradients from (e.g., [["primary", "accent"]])',
          },
          include_complementary: {
            type: 'boolean',
            default: false,
            description: 'Include complementary color gradients (default: false)',
          },
          include_analogous: {
            type: 'boolean',
            default: false,
            description: 'Include analogous color gradients (default: false)',
          },
        },
      },
    },
    // All parameters are optional
  },
  annotations: {
    title: 'Style Get Palette',
    destructive: false,
    idempotent: true,
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};
