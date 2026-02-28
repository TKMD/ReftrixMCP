// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * narrative.search MCPツール
 *
 * 世界観・レイアウト構成でセマンティック検索します。
 * 自然言語クエリまたは768次元Embeddingで検索可能。
 *
 * 検索フロー:
 * 1. クエリのEmbedding生成（query指定時）
 * 2. pgvector HNSW近傍探索（Vector検索）
 * 3. Full-text検索（hybridモード時）
 * 4. RRF（Reciprocal Rank Fusion）統合
 * 5. フィルター適用（moodCategory, minConfidence）
 *
 * @module tools/narrative/search.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  narrativeSearchInputSchema,
  NARRATIVE_MCP_ERROR_CODES,
  type NarrativeSearchInput,
  type NarrativeSearchOutput,
  type NarrativeSearchData,
  type NarrativeSearchResultItem,
  type NarrativeSearchInfo,
} from './schemas';
import type {
  INarrativeAnalysisService,
  NarrativeSearchOptions as ServiceSearchOptions,
  NarrativeSearchResult,
} from '../../services/narrative/types/narrative.types';

// ============================================================================
// Types
// ============================================================================

export type { NarrativeSearchInput, NarrativeSearchOutput };

/**
 * NarrativeAnalysisServiceファクトリー型
 */
export type INarrativeSearchServiceFactory = () => INarrativeAnalysisService;

// ============================================================================
// Service Factory (DI)
// ============================================================================

/** デフォルトのサービスファクトリー */
let narrativeSearchServiceFactory: INarrativeSearchServiceFactory | null = null;

/**
 * サービスファクトリーを設定
 * @param factory - サービスファクトリー
 */
export function setNarrativeSearchServiceFactory(
  factory: INarrativeSearchServiceFactory
): void {
  narrativeSearchServiceFactory = factory;
}

/**
 * サービスファクトリーをリセット（テスト用）
 */
export function resetNarrativeSearchServiceFactory(): void {
  narrativeSearchServiceFactory = null;
}

/**
 * NarrativeAnalysisServiceを取得
 */
async function getNarrativeAnalysisService(): Promise<INarrativeAnalysisService> {
  if (narrativeSearchServiceFactory !== null) {
    return narrativeSearchServiceFactory();
  }

  // デフォルト: 実サービスをインポート
  // NOTE: NarrativeAnalysisServiceはTask #2で実装予定
  // 現在は未実装のため、サービスファクトリ経由でのみ使用可能
  throw new Error(
    'NarrativeAnalysisService is not yet implemented. ' +
      'Please use setNarrativeSearchServiceFactory() to provide a service instance.'
  );
}

// ============================================================================
// Embedding Service (for query -> embedding)
// NOTE: 将来のembedding直接検索機能で使用予定
// 現在はNarrativeAnalysisService.search()がクエリ文字列から内部でembeddingを生成
// ============================================================================

/**
 * Embeddingサービスインターフェース
 */
interface IEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
}

/** デフォルトのEmbeddingサービスファクトリー */
let embeddingServiceFactory: (() => IEmbeddingService) | null = null;

/**
 * Embeddingサービスファクトリーを設定（テスト用）
 */
export function setEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * Embeddingサービスファクトリーをリセット（テスト用）
 */
export function resetEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * Embeddingサービスを取得
 * NOTE: 将来のsearchWithEmbedding実装で使用予定
 * @internal
 */
export async function getEmbeddingService(): Promise<IEmbeddingService> {
  if (embeddingServiceFactory !== null) {
    return embeddingServiceFactory();
  }

  // デフォルト: 実サービスをインポート
  // NOTE: EmbeddingServiceは別タスクで実装予定
  // 現在は未実装のため、サービスファクトリ経由でのみ使用可能
  throw new Error(
    'EmbeddingService is not yet implemented. ' +
      'Please use setEmbeddingServiceFactory() to provide a service instance.'
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 検索結果をMCPレスポンス形式に変換
 */
function convertSearchResultsToMcpResponse(
  results: NarrativeSearchResult[],
  query: string,
  searchMode: 'vector' | 'hybrid',
  searchTimeMs: number
): NarrativeSearchData {
  const resultItems: NarrativeSearchResultItem[] = results.map((r) => ({
    id: r.id,
    webPageId: r.webPageId,
    sourceUrl: '', // TODO: WebPageテーブルから取得
    similarity: r.score,

    worldView: {
      moodCategory: r.moodCategory,
      moodDescription: r.moodDescription,
      overallTone: '', // TODO: サービスから詳細取得
    },

    layoutStructure: {
      gridType: 'mixed', // TODO: サービスから詳細取得
      columns: 12, // TODO: サービスから詳細取得
    },

    confidence: r.confidence,
  }));

  const searchInfo: NarrativeSearchInfo = {
    query,
    searchMode,
    totalResults: results.length,
    searchTimeMs,
  };

  return {
    results: resultItems,
    searchInfo,
  };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * narrative.search ハンドラー
 *
 * 世界観・レイアウト構成でセマンティック検索
 *
 * @param input - 入力パラメータ
 * @returns 検索結果
 *
 * @example
 * ```typescript
 * // 自然言語クエリ
 * const result = await narrativeSearchHandler({
 *   query: 'サイバーセキュリティ感のあるダークなデザイン',
 *   options: { limit: 10, searchMode: 'hybrid' }
 * });
 *
 * // Embedding指定
 * const result = await narrativeSearchHandler({
 *   embedding: [0.1, 0.2, ...], // 768次元
 *   filters: { moodCategory: 'tech' }
 * });
 * ```
 */
export async function narrativeSearchHandler(
  input: unknown
): Promise<NarrativeSearchOutput> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[narrative.search] Handler called', {
      inputType: typeof input,
    });
  }

  try {
    // 1. 入力バリデーション
    const validatedInput = narrativeSearchInputSchema.parse(input);

    if (isDevelopment()) {
      logger.info('[narrative.search] Input validated', {
        hasQuery: !!validatedInput.query,
        hasEmbedding: !!validatedInput.embedding,
        filters: validatedInput.filters,
        options: validatedInput.options,
      });
    }

    // 2. サービス取得
    const narrativeService = await getNarrativeAnalysisService();

    // 3. クエリ文字列の決定
    let queryText: string;

    if (validatedInput.query) {
      queryText = validatedInput.query;

      // Embedding生成（サービス内で行う場合はスキップ）
      // NOTE: サービスのsearch()がクエリ文字列を受け取る想定
    } else if (validatedInput.embedding) {
      queryText = '[embedding]';
      // NOTE: embedding直接検索はNarrativeAnalysisService.searchWithEmbeddingで実装予定
      // 現在はサービスがクエリ文字列からembeddingを生成する設計
    } else {
      // バリデーションでチェック済みなのでここには来ないはず
      throw new Error('queryまたはembeddingが必要です');
    }

    // 4. 検索オプションの準備
    // フィルターオブジェクトを構築（exactOptionalPropertyTypes対応）
    const baseSearchOptions: ServiceSearchOptions = {
      query: queryText,
      limit: validatedInput.options?.limit ?? 10,
      vectorWeight: validatedInput.options?.vectorWeight ?? 0.6,
      fulltextWeight: validatedInput.options?.fulltextWeight ?? 0.4,
    };

    // フィルターを条件付きで追加
    if (validatedInput.filters) {
      const moodCategory = validatedInput.filters.moodCategory;
      const minConfidence = validatedInput.filters.minConfidence;

      const filtersObj: NonNullable<ServiceSearchOptions['filters']> = {};
      if (moodCategory !== undefined) {
        filtersObj.moodCategory = [moodCategory];
      }
      if (minConfidence !== undefined) {
        filtersObj.minConfidence = minConfidence;
      }

      // フィールドが存在する場合のみ設定
      if (Object.keys(filtersObj).length > 0) {
        baseSearchOptions.filters = filtersObj;
      }
    }

    const searchOptions = baseSearchOptions;

    // 5. 検索実行（searchHybridが利用可能な場合はHybrid Search、なければvector-only）
    const searchMode = validatedInput.options?.searchMode ?? 'hybrid';
    let results: NarrativeSearchResult[];
    if (searchMode === 'hybrid' && narrativeService.searchHybrid != null) {
      results = await narrativeService.searchHybrid(searchOptions);
    } else {
      results = await narrativeService.search(searchOptions);
    }

    // 6. 最小類似度フィルター適用
    const minSimilarity = validatedInput.options?.minSimilarity ?? 0.6;
    const filteredResults = results.filter((r) => r.score >= minSimilarity);

    const searchTimeMs = Date.now() - startTime;

    // 7. レスポンス生成
    const data = convertSearchResultsToMcpResponse(
      filteredResults,
      queryText,
      searchMode,
      searchTimeMs
    );

    if (isDevelopment()) {
      logger.info('[narrative.search] Search completed', {
        query: queryText.substring(0, 50),
        totalResults: data.searchInfo.totalResults,
        searchTimeMs,
        searchMode,
      });
    }

    return {
      success: true,
      data,
    };
  } catch (error) {
    // エラーハンドリング
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      }));

      if (isDevelopment()) {
        logger.warn('[narrative.search] Validation error', { details });
      }

      return {
        success: false,
        error: {
          code: NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: 'バリデーションエラー',
        },
      };
    }

    // 特定エラータイプのハンドリング
    if (error instanceof Error) {
      const errorCode = mapErrorToCode(error);

      if (isDevelopment()) {
        logger.error('[narrative.search] Error', {
          code: errorCode,
          message: error.message,
          stack: error.stack,
        });
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: error.message,
        },
      };
    }

    // 未知のエラー
    logger.error('[narrative.search] Unknown error', { error });

    return {
      success: false,
      error: {
        code: NARRATIVE_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: '内部エラーが発生しました',
      },
    };
  }
}

/**
 * エラーをエラーコードにマッピング
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes('embedding')) {
    return NARRATIVE_MCP_ERROR_CODES.EMBEDDING_FAILED;
  }
  if (message.includes('not found')) {
    return NARRATIVE_MCP_ERROR_CODES.NARRATIVE_NOT_FOUND;
  }
  if (message.includes('db') || message.includes('database')) {
    return NARRATIVE_MCP_ERROR_CODES.SEARCH_FAILED;
  }

  return NARRATIVE_MCP_ERROR_CODES.SEARCH_FAILED;
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * narrative.search ツール定義
 * MCP Server初期化時に使用
 */
export const narrativeSearchToolDefinition = {
  name: 'narrative.search',
  description:
    '世界観・レイアウト構成でセマンティック検索します。' +
    '自然言語クエリ（例: "サイバーセキュリティ感のあるダークなデザイン"）または768次元Embeddingで検索可能。' +
    'Hybrid Search（Vector + Full-text）でRRF統合。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '検索クエリ（queryまたはembeddingのいずれか必須）',
        minLength: 1,
        maxLength: 500,
      },
      embedding: {
        type: 'array',
        items: { type: 'number' },
        description: '直接Embedding指定（768次元、queryまたはembeddingのいずれか必須）',
        minItems: 768,
        maxItems: 768,
      },
      filters: {
        type: 'object',
        properties: {
          moodCategory: {
            type: 'string',
            enum: [
              'professional', 'playful', 'premium', 'tech',
              'organic', 'minimal', 'bold', 'elegant',
              'friendly', 'artistic', 'trustworthy', 'energetic',
            ],
            description: 'ムードカテゴリでフィルター',
          },
          minConfidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: '最小信頼度フィルター（0-1）',
          },
        },
      },
      options: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            default: 10,
            minimum: 1,
            maximum: 50,
            description: '結果数',
          },
          minSimilarity: {
            type: 'number',
            default: 0.6,
            minimum: 0,
            maximum: 1,
            description: '最小類似度',
          },
          searchMode: {
            type: 'string',
            enum: ['vector', 'hybrid'],
            default: 'hybrid',
            description: '検索モード',
          },
          vectorWeight: {
            type: 'number',
            default: 0.6,
            minimum: 0,
            maximum: 1,
            description: 'Vector検索の重み（hybridモード時）',
          },
          fulltextWeight: {
            type: 'number',
            default: 0.4,
            minimum: 0,
            maximum: 1,
            description: 'Full-text検索の重み（hybridモード時）',
          },
        },
      },
    },
  },
};
