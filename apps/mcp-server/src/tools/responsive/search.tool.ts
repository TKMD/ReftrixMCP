// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.search MCPツール
 * レスポンシブ分析をセマンティック検索します
 *
 * 機能:
 * - 自然言語クエリによるベクトル検索
 * - JSONB フィルタ（diffCategory, viewportPair, breakpointRange, minDiffPercentage）
 * - ページネーション対応
 * - multilingual-e5-base によるクエリ Embedding 生成（query: プレフィックス）
 *
 * @module tools/responsive/search.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  responsiveSearchInputSchema,
  RESPONSIVE_MCP_ERROR_CODES,
  type ResponsiveSearchInput as ResponsiveSearchInputType,
} from './schemas';
import type {
  IResponsiveSearchService,
  ResponsiveSearchResult,
  ResponsiveSearchOptions,
} from '../../services/responsive-search.service';

// =====================================================
// 型定義
// =====================================================

export interface ResponsiveSearchResultItem {
  id: string;
  similarity: number;
  url: string;
  source: {
    webPageId: string;
    responsiveAnalysisId: string;
  };
  viewportsAnalyzed: unknown;
  differencesCount: number;
  breakpointsCount: number;
  screenshotDiffs: unknown;
  analysisTimeMs: number;
  textRepresentation: string;
}

export type ResponsiveSearchInput = ResponsiveSearchInputType;

export type ResponsiveSearchOutput =
  | {
      success: true;
      data: {
        results: ResponsiveSearchResultItem[];
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

// =====================================================
// サービスファクトリー（DI）
// =====================================================

let responsiveSearchServiceFactory: (() => IResponsiveSearchService) | null = null;

export function setResponsiveSearchServiceFactory(
  factory: () => IResponsiveSearchService
): void {
  responsiveSearchServiceFactory = factory;
}

export function resetResponsiveSearchServiceFactory(): void {
  responsiveSearchServiceFactory = null;
}

export { IResponsiveSearchService };

// =====================================================
// エラーコード判定
// =====================================================

function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes('embedding') || message.includes('model')) {
    return RESPONSIVE_MCP_ERROR_CODES.EMBEDDING_FAILED;
  }

  if (
    message.includes('database') ||
    message.includes('prisma') ||
    message.includes('connection')
  ) {
    return RESPONSIVE_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  if (message.includes('timeout')) {
    return RESPONSIVE_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  return RESPONSIVE_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// メインハンドラー
// =====================================================

export async function responsiveSearchHandler(
  input: unknown
): Promise<ResponsiveSearchOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[MCP Tool] responsive.search called', {
      query: (input as Record<string, unknown>)?.query,
    });
  }

  // 入力バリデーション
  let validated: ResponsiveSearchInputType;
  try {
    validated = responsiveSearchInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] responsive.search validation error', {
          errors: error.errors,
        });
      }

      return {
        success: false,
        error: {
          code: RESPONSIVE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック
  if (!responsiveSearchServiceFactory) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] responsive.search service factory not set');
    }

    return {
      success: false,
      error: {
        code: RESPONSIVE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'Responsive search service is not available',
      },
    };
  }

  const service = responsiveSearchServiceFactory();

  try {
    // E5 モデル用 query: プレフィックスを付与
    const processedQuery = `query: ${validated.query}`;

    // Embedding 生成
    const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

    if (queryEmbedding === null) {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] responsive.search embedding not available, returning empty results');
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
    const searchOptions: ResponsiveSearchOptions = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.filters) {
      const filters: ResponsiveSearchOptions['filters'] = {};
      if (validated.filters.diffCategory) {
        filters.diffCategory = validated.filters.diffCategory;
      }
      if (validated.filters.viewportPair) {
        filters.viewportPair = validated.filters.viewportPair;
      }
      if (validated.filters.breakpointRange) {
        filters.breakpointRange = {
          ...(validated.filters.breakpointRange.min !== undefined && { min: validated.filters.breakpointRange.min }),
          ...(validated.filters.breakpointRange.max !== undefined && { max: validated.filters.breakpointRange.max }),
        };
      }
      if (validated.filters.minDiffPercentage !== undefined) {
        filters.minDiffPercentage = validated.filters.minDiffPercentage;
      }
      if (validated.filters.webPageId) {
        filters.webPageId = validated.filters.webPageId;
      }
      if (Object.keys(filters).length > 0) {
        searchOptions.filters = filters;
      }
    }

    // 検索実行
    const searchResult = await service.searchResponsiveAnalyses(
      queryEmbedding,
      searchOptions
    );

    // 結果マッピング
    const mappedResults: ResponsiveSearchResultItem[] = searchResult.results.map(
      (r: ResponsiveSearchResult) => ({
        id: r.id,
        similarity: r.similarity,
        url: r.url,
        source: {
          webPageId: r.webPageId,
          responsiveAnalysisId: r.responsiveAnalysisId,
        },
        viewportsAnalyzed: r.viewportsAnalyzed,
        differencesCount: Array.isArray(r.differences) ? r.differences.length : 0,
        breakpointsCount: Array.isArray(r.breakpoints) ? r.breakpoints.length : 0,
        screenshotDiffs: r.screenshotDiffs,
        analysisTimeMs: r.analysisTimeMs,
        textRepresentation: r.textRepresentation,
      })
    );

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MCP Tool] responsive.search completed', {
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
      logger.error('[MCP Tool] responsive.search error', {
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

export const responsiveSearchToolDefinition = {
  name: 'responsive.search',
  description:
    'レスポンシブデザイン分析結果をセマンティック検索します。' +
    'ビューポート間の差異（レイアウト変化、ナビゲーション変化、表示切替等）を' +
    '自然言語で検索できます。差異カテゴリ、ビューポートペア、ブレークポイント範囲、' +
    'スクリーンショット差分率でフィルタリング可能です。',
  annotations: {
    title: 'Responsive Search',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: '検索クエリ（自然言語、1-500文字）。例: "モバイルでハンバーガーメニューに変わるサイト"',
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
          diffCategory: {
            type: 'string',
            enum: ['layout', 'typography', 'spacing', 'visibility', 'navigation', 'image', 'interaction', 'animation'],
            description: 'レスポンシブ差異カテゴリでフィルター',
          },
          viewportPair: {
            type: 'string',
            enum: ['desktop-tablet', 'desktop-mobile', 'tablet-mobile'],
            description: 'ビューポートペアでフィルター',
          },
          breakpointRange: {
            type: 'object',
            description: 'ブレークポイント範囲でフィルター',
            properties: {
              min: { type: 'number', description: '最小ブレークポイント（px）' },
              max: { type: 'number', description: '最大ブレークポイント（px）' },
            },
          },
          minDiffPercentage: {
            type: 'number',
            description: '最小スクリーンショット差分率（0-100）',
            minimum: 0,
            maximum: 100,
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

if (isDevelopment()) {
  logger.debug('[responsive.search] Tool module loaded');
}
