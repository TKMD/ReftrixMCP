// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.to_code MCPツール
 * セクションパターンからReact/Vue/HTMLコードを生成します
 *
 * 機能:
 * - セクションパターンIDからコード生成
 * - React/Vue/HTML出力対応
 * - TypeScript/JavaScript選択
 * - Tailwind CSS/Vanilla CSS選択
 * - カスタムコンポーネント名設定
 * - ブランドパレット適用
 *
 * @module tools/layout/to-code.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  layoutToCodeInputSchema,
  layoutToCodeDataSchema,
  LAYOUT_MCP_ERROR_CODES,
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
  type LayoutToCodeOptions,
  type LayoutToCodeData,
  type Framework,
  type UsageScope,
} from './schemas';
import {
  createSuccessResponse,
  createErrorResponse,
} from '../common/error-codes';

// =====================================================
// 型定義
// =====================================================

export type { LayoutToCodeInput, LayoutToCodeOutput };

/**
 * コンポーネント情報の型
 */
export interface ComponentInfo {
  type: string;
  level?: number;
  text?: string;
  variant?: string;
  src?: string;
  alt?: string;
  [key: string]: unknown;
}

/**
 * セクションパターン（DBから取得される形式）
 */
export interface SectionPattern {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName?: string;
  positionIndex: number;
  layoutInfo?: {
    type?: string;
    heading?: string;
    description?: string;
    grid?: {
      columns?: number;
      gap?: string;
    };
    alignment?: string;
  };
  visualFeatures?: {
    colors?: {
      dominant?: string;
      background?: string;
    };
  };
  /** コンポーネント情報（heading, paragraph, button等） */
  components?: ComponentInfo[];
  htmlSnippet?: string;
  /** CSSスニペット（style/link/inline styles） */
  cssSnippet?: string;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent?: string;
  /** CSSフレームワーク（tailwind, bootstrap, css_modules, styled_components, vanilla, unknown） */
  cssFramework?: string | null;
  /** CSSフレームワーク検出メタデータ */
  cssFrameworkMeta?: {
    confidence?: number;
    evidence?: string[];
  } | null;
  textRepresentation?: string;
  webPage: {
    id: string;
    url: string;
    title?: string;
    sourceType: string;
    usageScope: string;
  };
}

/**
 * コード生成オプション（サービスに渡す形式）
 */
export interface CodeGeneratorOptions {
  framework: Framework;
  typescript: boolean;
  tailwind: boolean;
  componentName?: string;
  paletteId?: string;
  /** HTMLを意味のあるサブコンポーネントに分割するか（デフォルト: false） */
  splitComponents?: boolean;
  /** レスポンシブブレークポイント自動生成（デフォルト: true） */
  responsive?: boolean;
}

/**
 * サブコンポーネント情報
 */
export interface SubComponentInfo {
  name: string;
  code: string;
  filename: string;
  props: Array<{ name: string; type: string }>;
}

/**
 * 生成されたコード結果
 */
export interface GeneratedCode {
  code: string;
  componentName: string;
  filename: string;
  dependencies: string[];
  /** splitComponents=true時に生成されるサブコンポーネント */
  subComponents?: SubComponentInfo[];
}

/**
 * layout.to_code サービスインターフェース（DI用）
 */
export interface ILayoutToCodeService {
  /**
   * セクションパターンをIDで取得
   */
  getSectionPatternById: (id: string) => Promise<SectionPattern | null>;

  /**
   * コードを生成
   */
  generateCode: (
    pattern: SectionPattern,
    options: CodeGeneratorOptions
  ) => Promise<GeneratedCode>;
}

// =====================================================
// サービスファクトリー（DI）
// =====================================================

let serviceFactory: (() => ILayoutToCodeService) | null = null;

/**
 * サービスファクトリーを設定
 */
export function setLayoutToCodeServiceFactory(
  factory: () => ILayoutToCodeService
): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリーをリセット
 */
export function resetLayoutToCodeServiceFactory(): void {
  serviceFactory = null;
}

// =====================================================
// エラー生成ヘルパー
// =====================================================

/**
 * エラーからエラーコードを判定
 */
function determineErrorCode(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // コード生成エラー
  if (
    lowerMessage.includes('generation') ||
    lowerMessage.includes('template') ||
    lowerMessage.includes('parsing')
  ) {
    return LAYOUT_MCP_ERROR_CODES.CODE_GENERATION_FAILED;
  }

  // データベースエラー
  if (
    lowerMessage.includes('database') ||
    lowerMessage.includes('prisma') ||
    lowerMessage.includes('connection')
  ) {
    return LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR;
  }

  // パターン見つからない
  if (lowerMessage.includes('not found') || lowerMessage.includes('pattern')) {
    return LAYOUT_MCP_ERROR_CODES.PATTERN_NOT_FOUND;
  }

  // その他は内部エラー
  return LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// オプション正規化
// =====================================================

/**
 * 入力オプションをCodeGeneratorOptionsに正規化
 */
function normalizeOptions(options?: LayoutToCodeOptions): CodeGeneratorOptions {
  const result: CodeGeneratorOptions = {
    framework: options?.framework ?? 'react',
    typescript: options?.typescript ?? true,
    tailwind: options?.tailwind ?? true,
  };

  // オプショナルフィールドは定義されている場合のみ追加
  if (options?.componentName !== undefined) {
    result.componentName = options.componentName;
  }
  if (options?.paletteId !== undefined) {
    result.paletteId = options.paletteId;
  }
  if (options?.splitComponents !== undefined) {
    result.splitComponents = options.splitComponents;
  }
  // responsiveはデフォルトtrue（未指定時もtrue）
  result.responsive = options?.responsive ?? true;

  return result;
}

// =====================================================
// メインハンドラー
// =====================================================

/**
 * layout.to_code ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns 生成されたコード（Response Objectパターン）
 *
 * @example
 * ```typescript
 * const result = await layoutToCodeHandler({
 *   patternId: '11111111-1111-1111-1111-111111111111',
 *   options: {
 *     framework: 'react',
 *     typescript: true,
 *     tailwind: true,
 *   },
 * });
 *
 * if (result.success) {
 *   console.log(result.data.code);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export async function layoutToCodeHandler(
  input: unknown
): Promise<LayoutToCodeOutput> {
  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.to_code called', {
      patternId: (input as Record<string, unknown>)?.patternId,
    });
  }

  // 入力バリデーション
  let validated: LayoutToCodeInput;
  try {
    validated = layoutToCodeInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.to_code validation error', {
          errors: error.errors,
        });
      }

      return createErrorResponse(
        LAYOUT_MCP_ERROR_CODES.VALIDATION_ERROR,
        `Validation error: ${errorMessage}`
      ) as LayoutToCodeOutput;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErrorResponse(
      LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR,
      errorMessage
    ) as LayoutToCodeOutput;
  }

  // サービスファクトリーチェック
  if (!serviceFactory) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.to_code service factory not set');
    }

    return createErrorResponse(
      'SERVICE_UNAVAILABLE',
      'Code generation service is not available'
    ) as LayoutToCodeOutput;
  }

  const service = serviceFactory();

  try {
    // セクションパターン取得
    const pattern = await service.getSectionPatternById(validated.patternId);

    if (!pattern) {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] layout.to_code pattern not found', {
          patternId: validated.patternId,
        });
      }

      return createErrorResponse(
        LAYOUT_MCP_ERROR_CODES.PATTERN_NOT_FOUND,
        `Pattern not found: ${validated.patternId}`
      ) as LayoutToCodeOutput;
    }

    // オプション正規化
    const options = normalizeOptions(validated.options);

    if (isDevelopment()) {
      logger.debug('[MCP Tool] layout.to_code generating code', {
        patternId: validated.patternId,
        sectionType: pattern.sectionType,
        framework: options.framework,
        typescript: options.typescript,
        tailwind: options.tailwind,
      });
    }

    // コード生成
    let generatedCode: GeneratedCode;
    try {
      generatedCode = await service.generateCode(pattern, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.to_code generation error', {
          error: errorMessage,
        });
      }

      return createErrorResponse(
        LAYOUT_MCP_ERROR_CODES.CODE_GENERATION_FAILED,
        `Code generation failed: ${errorMessage}`
      ) as LayoutToCodeOutput;
    }

    // 結果を構築
    const data: LayoutToCodeData = {
      code: generatedCode.code,
      framework: options.framework,
      componentName: generatedCode.componentName,
      filename: generatedCode.filename,
      dependencies: generatedCode.dependencies,
      inspirationUrls: [pattern.webPage.url],
      usageScope: pattern.webPage.usageScope as UsageScope,
    };

    // データバリデーション
    layoutToCodeDataSchema.parse(data);

    if (isDevelopment()) {
      logger.info('[MCP Tool] layout.to_code completed', {
        patternId: validated.patternId,
        framework: options.framework,
        componentName: generatedCode.componentName,
        codeLength: generatedCode.code.length,
      });
    }

    return createSuccessResponse(data) as LayoutToCodeOutput;
  } catch (error) {
    // その他のエラーは変換
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);

    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.to_code error', {
        code: errorCode,
        error: errorMessage,
      });
    }

    return createErrorResponse(errorCode, errorMessage) as LayoutToCodeOutput;
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * layout.generate_code MCPツール定義
 * MCP Protocol用のツール定義オブジェクト
 *
 * v0.1.0: layout.to_code から layout.generate_code にリネーム
 * 後方互換性のため layoutToCodeToolDefinition も引き続きエクスポート
 */
export const layoutGenerateCodeToolDefinition = {
  name: 'layout.generate_code',
  description:
    'セクションパターンからReact/Vue/HTMLコードを生成します。' +
    'パターンIDを指定して、選択したフレームワーク（React, Vue, HTML）でコードを出力できます。' +
    'TypeScript/JavaScript、Tailwind CSS/Vanilla CSSの選択も可能です。',
  annotations: {
    title: 'Layout Generate Code',
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      patternId: {
        type: 'string',
        format: 'uuid',
        description: 'セクションパターンID（UUID形式、必須）',
      },
      options: {
        type: 'object',
        description: 'コード生成オプション',
        properties: {
          framework: {
            type: 'string',
            enum: ['react', 'vue', 'html'],
            description: '出力フレームワーク（デフォルト: react）',
            default: 'react',
          },
          typescript: {
            type: 'boolean',
            description: 'TypeScript出力するか（デフォルト: true）',
            default: true,
          },
          tailwind: {
            type: 'boolean',
            description: 'Tailwind CSSを使用するか（デフォルト: true）',
            default: true,
          },
          componentName: {
            type: 'string',
            description: 'カスタムコンポーネント名（PascalCase形式）',
            pattern: '^[A-Z][a-zA-Z0-9]*$',
          },
          paletteId: {
            type: 'string',
            format: 'uuid',
            description: '適用するブランドパレットID（UUID形式）',
          },
          responsive: {
            type: 'boolean',
            description:
              'レスポンシブブレークポイント自動生成（デフォルト: true）。' +
              '大きなwidth/padding/font-size/flex-directionをモバイルファーストのレスポンシブクラスに変換します。',
            default: true,
          },
        },
      },
    },
    required: ['patternId'],
  },
};

/**
 * @deprecated v0.1.0 で layout.generate_code にリネームされました。
 * 後方互換性のためのエイリアス。新規コードでは layoutGenerateCodeToolDefinition を使用してください。
 */
export const layoutToCodeToolDefinition = layoutGenerateCodeToolDefinition;

/**
 * layout.generate_code ツールハンドラー
 *
 * v0.1.0: layoutToCodeHandler から layoutGenerateCodeHandler にリネーム
 * 後方互換性のため layoutToCodeHandler も引き続きエクスポート
 */
export const layoutGenerateCodeHandler = layoutToCodeHandler;

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[layout.generate_code] Tool module loaded');
}
