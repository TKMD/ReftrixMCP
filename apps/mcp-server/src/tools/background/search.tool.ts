// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * background.search MCPツール
 * BackgroundDesign テーブルをセマンティック検索します
 *
 * 機能:
 * - 自然言語クエリによるベクトル検索
 * - designType / webPageId フィルタリング
 * - ページネーション対応
 * - multilingual-e5-base によるクエリ Embedding 生成（query: プレフィックス）
 *
 * @module tools/background/search.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  backgroundSearchInputSchema,
  BACKGROUND_MCP_ERROR_CODES,
  type BackgroundSearchInput as BackgroundSearchInputType,
} from './schemas';

// =====================================================
// 型定義
// =====================================================

/**
 * BackgroundDesign 検索結果アイテム（サービスから返される形式）
 */
export interface BackgroundDesignSearchResult {
  id: string;
  webPageId: string;
  name: string;
  designType: string;
  cssValue: string;
  selector: string | null;
  similarity: number;
  colorInfo: Record<string, unknown>;
  textRepresentation: string;
}

/**
 * MCP レスポンス用の検索結果アイテム
 */
export interface BackgroundSearchResultItem {
  id: string;
  designType: string;
  cssValue: string;
  similarity: number;
  source: {
    webPageId: string;
  };
  name: string;
  selector: string | null;
  colorInfo: Record<string, unknown>;
  textRepresentation: string;
}

/**
 * background.search 入力型（エクスポート用）
 */
export type BackgroundSearchInput = BackgroundSearchInputType;

/**
 * background.search 出力型
 */
export type BackgroundSearchOutput =
  | {
      success: true;
      data: {
        results: BackgroundSearchResultItem[];
        total: number;
        query: string;
        searchTimeMs: number;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

/**
 * background.search サービスインターフェース（DI用）
 */
export interface IBackgroundSearchService {
  /**
   * クエリテキストから Embedding を生成
   * Embedding サービスが利用できない場合は null を返す
   */
  generateQueryEmbedding: (query: string) => Promise<number[] | null>;

  /**
   * BackgroundDesign をベクトル検索
   */
  searchBackgroundDesigns: (
    embedding: number[],
    options: {
      limit: number;
      offset: number;
      filters?: {
        designType?: string;
        webPageId?: string;
      };
    }
  ) => Promise<{
    results: BackgroundDesignSearchResult[];
    total: number;
  }>;

  /**
   * BackgroundDesign をハイブリッド検索（ベクトル + 全文検索、RRFマージ）
   * 利用可能な場合に searchBackgroundDesigns の代わりに使用される
   */
  searchBackgroundDesignsHybrid?: (
    queryText: string,
    embedding: number[],
    options: {
      limit: number;
      offset: number;
      filters?: {
        designType?: string;
        webPageId?: string;
      };
    }
  ) => Promise<{
    results: BackgroundDesignSearchResult[];
    total: number;
  }>;
}

// =====================================================
// サービスファクトリー（DI）
// =====================================================

let backgroundSearchServiceFactory: (() => IBackgroundSearchService) | null = null;

/**
 * サービスファクトリーを設定
 */
export function setBackgroundSearchServiceFactory(
  factory: () => IBackgroundSearchService
): void {
  backgroundSearchServiceFactory = factory;
}

/**
 * サービスファクトリーをリセット
 */
export function resetBackgroundSearchServiceFactory(): void {
  backgroundSearchServiceFactory = null;
}

// =====================================================
// エラーコード判定
// =====================================================

/**
 * エラーからエラーコードを判定
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes('embedding') || message.includes('model')) {
    return BACKGROUND_MCP_ERROR_CODES.EMBEDDING_FAILED;
  }

  if (
    message.includes('database') ||
    message.includes('prisma') ||
    message.includes('connection')
  ) {
    return BACKGROUND_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  if (message.includes('timeout')) {
    return BACKGROUND_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  return BACKGROUND_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// メインハンドラー
// =====================================================

/**
 * background.search ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns 検索結果
 */
export async function backgroundSearchHandler(
  input: unknown
): Promise<BackgroundSearchOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[MCP Tool] background.search called', {
      query: (input as Record<string, unknown>)?.query,
    });
  }

  // 入力バリデーション
  let validated: BackgroundSearchInputType;
  try {
    validated = backgroundSearchInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] background.search validation error', {
          errors: error.errors,
        });
      }

      return {
        success: false,
        error: {
          code: BACKGROUND_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック
  if (!backgroundSearchServiceFactory) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] background.search service factory not set');
    }

    return {
      success: false,
      error: {
        code: BACKGROUND_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'Background search service is not available',
      },
    };
  }

  const service = backgroundSearchServiceFactory();

  try {
    // E5 モデル用 query: プレフィックスを付与
    const processedQuery = `query: ${validated.query}`;

    // Embedding 生成
    const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

    // Embedding が null の場合は空結果を返す
    if (queryEmbedding === null) {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] background.search embedding not available, returning empty results');
      }

      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // 検索オプション構築
    const searchOptions: {
      limit: number;
      offset: number;
      filters?: {
        designType?: string;
        webPageId?: string;
      };
    } = {
      limit: validated.limit,
      offset: validated.offset,
    };

    // フィルターが存在する場合のみ追加
    if (validated.filters) {
      const filters: { designType?: string; webPageId?: string } = {};
      if (validated.filters.designType) {
        filters.designType = validated.filters.designType;
      }
      if (validated.filters.webPageId) {
        filters.webPageId = validated.filters.webPageId;
      }
      if (Object.keys(filters).length > 0) {
        searchOptions.filters = filters;
      }
    }

    // 検索実行（ハイブリッド検索優先）
    const searchResult = service.searchBackgroundDesignsHybrid
      ? await service.searchBackgroundDesignsHybrid(
          validated.query,
          queryEmbedding,
          searchOptions
        )
      : await service.searchBackgroundDesigns(
          queryEmbedding,
          searchOptions
        );

    // 結果マッピング
    const mappedResults: BackgroundSearchResultItem[] = searchResult.results.map(
      (r) => ({
        id: r.id,
        designType: r.designType,
        cssValue: r.cssValue,
        similarity: r.similarity,
        source: {
          webPageId: r.webPageId,
        },
        name: r.name,
        selector: r.selector,
        colorInfo: r.colorInfo,
        textRepresentation: r.textRepresentation,
      })
    );

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MCP Tool] background.search completed', {
        query: validated.query,
        resultCount: mappedResults.length,
        total: searchResult.total,
        searchTimeMs,
      });
    }

    return {
      success: true,
      data: {
        results: mappedResults,
        total: searchResult.total,
        query: validated.query,
        searchTimeMs,
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    if (isDevelopment()) {
      logger.error('[MCP Tool] background.search error', {
        code: errorCode,
        error: errorInstance.message,
      });
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: errorInstance.message,
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * background.search MCPツール定義
 * MCP Protocol 用のツール定義オブジェクト
 */
export const backgroundSearchToolDefinition = {
  name: 'background.search',
  description:
    'BackgroundDesignをセマンティック検索します。' +
    'グラデーション、グラスモーフィズム、SVG背景等の背景デザインパターンを自然言語で検索できます。' +
    'designType（14種類）やwebPageIdでフィルタリング可能です。',
  annotations: {
    title: 'Background Search',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: '検索クエリ（自然言語、1-500文字）',
        minLength: 1,
        maxLength: 500,
      },
      limit: {
        type: 'number',
        description: '取得件数（1-50、デフォルト: 10）',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      offset: {
        type: 'number',
        description: 'オフセット（0以上、デフォルト: 0）',
        minimum: 0,
        default: 0,
      },
      filters: {
        type: 'object',
        description: '検索フィルター',
        properties: {
          designType: {
            type: 'string',
            enum: [
              'solid_color',
              'linear_gradient',
              'radial_gradient',
              'conic_gradient',
              'mesh_gradient',
              'image_background',
              'pattern_background',
              'video_background',
              'animated_gradient',
              'glassmorphism',
              'noise_texture',
              'svg_background',
              'multi_layer',
              'unknown',
            ],
            description: 'BackgroundDesignTypeでフィルター',
          },
          webPageId: {
            type: 'string',
            format: 'uuid',
            description: 'WebページIDでフィルター',
          },
        },
      },
    },
    required: ['query'],
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[background.search] Tool module loaded');
}
