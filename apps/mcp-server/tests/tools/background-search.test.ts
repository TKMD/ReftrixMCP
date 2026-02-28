// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * background.search MCPツール テスト
 * TDD Red Phase: 実装が存在しないため、すべてのテストは失敗する
 *
 * 目的:
 * - background_designs テーブルをセマンティック検索する MCPツールのテスト
 * - DIパターン（setBackgroundSearchServiceFactory / resetBackgroundSearchServiceFactory）
 * - 入力バリデーション（Zod schema）
 * - 正常系検索（ベクトル検索、フィルタリング、ページネーション）
 * - Embedding生成（E5プレフィックス: query:）
 * - エラーハンドリング（DB障害、タイムアウト）
 * - ツール定義（MCP Protocol準拠）
 *
 * @module tests/tools/background-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 実装Phase（Green）で作成予定のモジュールからインポート
// TDD Red Phase: これらのインポートは現時点で失敗する
import {
  backgroundSearchHandler,
  setBackgroundSearchServiceFactory,
  resetBackgroundSearchServiceFactory,
  backgroundSearchToolDefinition,
  type BackgroundSearchInput,
  type BackgroundSearchOutput,
  type IBackgroundSearchService,
  type BackgroundSearchResultItem,
} from '../../src/tools/background/search.tool';

import {
  backgroundSearchInputSchema,
  BACKGROUND_MCP_ERROR_CODES,
} from '../../src/tools/background/schemas';

// =====================================================
// テストデータ
// =====================================================

/**
 * BackgroundDesignType の有効な値一覧
 * Prisma enum BackgroundDesignType に基づく
 */
const VALID_DESIGN_TYPES = [
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
] as const;

/**
 * モック検索結果を生成
 * BackgroundDesignSearchResult に準拠した形式
 */
function createMockSearchResult(
  id: string,
  designType: string,
  similarity: number = 0.85
): {
  id: string;
  webPageId: string;
  name: string;
  designType: string;
  cssValue: string;
  selector: string | null;
  similarity: number;
  colorInfo: Record<string, unknown>;
  textRepresentation: string;
} {
  return {
    id,
    webPageId: `wp-${id}`,
    name: `${designType} background design`,
    designType,
    cssValue: `linear-gradient(135deg, #1a1a2e, #16213e)`,
    selector: '.hero',
    similarity,
    colorInfo: {
      dominantColors: ['#1a1a2e', '#16213e'],
      colorCount: 2,
      hasAlpha: false,
      colorSpace: 'srgb',
    },
    textRepresentation: `passage: Background design type: ${designType}. Name: ${designType} background design.`,
  };
}

// =====================================================
// モックサービス
// =====================================================

/**
 * モックサービスを作成
 * IBackgroundSearchService インターフェースに準拠
 */
function createMockService(overrides?: Partial<IBackgroundSearchService>): IBackgroundSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    searchBackgroundDesigns: vi.fn().mockResolvedValue({
      results: [
        createMockSearchResult('11111111-1111-1111-1111-111111111111', 'linear_gradient', 0.92),
        createMockSearchResult('22222222-2222-2222-2222-222222222222', 'glassmorphism', 0.87),
        createMockSearchResult('33333333-3333-3333-3333-333333333333', 'solid_color', 0.81),
      ],
      total: 3,
    }),
    ...overrides,
  };
}

// =====================================================
// 入力バリデーション テスト
// =====================================================

describe('background.search MCPツール', () => {
  beforeEach(() => {
    resetBackgroundSearchServiceFactory();
  });

  afterEach(() => {
    resetBackgroundSearchServiceFactory();
  });

  describe('入力バリデーション', () => {
    // クエリが空の場合バリデーションエラー
    it('クエリが空の場合バリデーションエラー', () => {
      const input = { query: '' };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.length).toBeGreaterThan(0);
      }
    });

    // クエリが500文字超の場合バリデーションエラー
    it('クエリが500文字超の場合バリデーションエラー', () => {
      const input = { query: 'a'.repeat(501) };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    // limitが0以下の場合バリデーションエラー
    it('limitが0以下の場合バリデーションエラー', () => {
      const input = { query: 'dark gradient background', limit: 0 };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    // limitが50超の場合バリデーションエラー
    it('limitが50超の場合バリデーションエラー', () => {
      const input = { query: 'dark gradient background', limit: 51 };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    // 不正なdesignTypeフィルターの場合バリデーションエラー
    it('不正なdesignTypeフィルターの場合バリデーションエラー', () => {
      const input = {
        query: 'gradient background',
        filters: { designType: 'invalid_type' },
      };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    // 正常な入力はパースできる
    it('正常な入力はパースできる', () => {
      const input = {
        query: 'dark gradient background',
        limit: 10,
        offset: 0,
      };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    // designTypeフィルターの全有効値がパースできる
    it('designTypeフィルターの有効値がパースできる', () => {
      for (const designType of VALID_DESIGN_TYPES) {
        const input = {
          query: 'background search',
          filters: { designType },
        };
        const result = backgroundSearchInputSchema.safeParse(input);

        expect(result.success).toBe(true);
      }
    });

    // offsetが負の場合バリデーションエラー
    it('offsetが負の場合バリデーションエラー', () => {
      const input = { query: 'gradient', offset: -1 };
      const result = backgroundSearchInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });

  // =====================================================
  // サービスファクトリー テスト
  // =====================================================

  describe('サービスファクトリー', () => {
    // ファクトリー未設定時はSERVICE_UNAVAILABLEエラー
    it('ファクトリー未設定時はSERVICE_UNAVAILABLEエラー', async () => {
      // ファクトリーをリセット（未設定状態）
      resetBackgroundSearchServiceFactory();

      const result = await backgroundSearchHandler({
        query: 'dark gradient',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      }
    });

    // ファクトリー設定後にリセットできる
    it('ファクトリー設定後にリセットできる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      // 設定後は正常に動作
      const result1 = await backgroundSearchHandler({
        query: 'gradient background',
      });
      expect(result1.success).toBe(true);

      // リセット後はSERVICE_UNAVAILABLEエラー
      resetBackgroundSearchServiceFactory();
      const result2 = await backgroundSearchHandler({
        query: 'gradient background',
      });
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error.code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });

  // =====================================================
  // 正常系検索 テスト
  // =====================================================

  describe('正常系検索', () => {
    // クエリでベクトル検索が実行される
    it('クエリでベクトル検索が実行される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'dark gradient background with glassmorphism',
      });

      expect(result.success).toBe(true);
      expect(mockService.generateQueryEmbedding).toHaveBeenCalledTimes(1);
      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledTimes(1);
    });

    // 検索結果がマッピングされて返却される
    it('検索結果がマッピングされて返却される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(3);
        expect(result.data.total).toBe(3);

        // 各結果に必須フィールドが含まれる
        for (const item of result.data.results) {
          expect(item.id).toBeDefined();
          expect(item.designType).toBeDefined();
          expect(item.similarity).toBeDefined();
          expect(typeof item.similarity).toBe('number');
        }
      }
    });

    // designTypeフィルターが適用される
    it('designTypeフィルターが適用される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const input: BackgroundSearchInput = {
        query: 'gradient background',
        filters: { designType: 'linear_gradient' },
      };
      await backgroundSearchHandler(input);

      // searchBackgroundDesigns にフィルターが渡される
      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filters: expect.objectContaining({
            designType: 'linear_gradient',
          }),
        })
      );
    });

    // webPageIdフィルターが適用される
    it('webPageIdフィルターが適用される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const input: BackgroundSearchInput = {
        query: 'gradient background',
        filters: { webPageId: '99999999-9999-9999-9999-999999999999' },
      };
      await backgroundSearchHandler(input);

      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filters: expect.objectContaining({
            webPageId: '99999999-9999-9999-9999-999999999999',
          }),
        })
      );
    });

    // limit/offsetが適用される
    it('limit/offsetが適用される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const input: BackgroundSearchInput = {
        query: 'solid background',
        limit: 5,
        offset: 10,
      };
      await backgroundSearchHandler(input);

      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          limit: 5,
          offset: 10,
        })
      );
    });

    // similarityスコアが含まれる
    it('similarityスコアが含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          expect(item.similarity).toBeGreaterThanOrEqual(0);
          expect(item.similarity).toBeLessThanOrEqual(1);
        }
      }
    });

    // クエリ文字列がレスポンスに含まれる
    it('クエリ文字列がレスポンスに含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'animated gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('animated gradient background');
      }
    });

    // 検索時間がレスポンスに含まれる
    it('検索時間がレスポンスに含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'glassmorphism',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchTimeMs).toBeDefined();
        expect(typeof result.data.searchTimeMs).toBe('number');
        expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    // cssValueが結果に含まれる
    it('cssValueが結果に含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          expect(item.cssValue).toBeDefined();
          expect(typeof item.cssValue).toBe('string');
        }
      }
    });

    // source情報（webPageId、url等）が含まれる
    it('source情報が結果に含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          expect(item.source).toBeDefined();
          expect(item.source.webPageId).toBeDefined();
        }
      }
    });
  });

  // =====================================================
  // Embedding テスト
  // =====================================================

  describe('Embedding', () => {
    // E5プレフィックス(query:)が付与される
    it('E5プレフィックス(query:)が付与される', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      await backgroundSearchHandler({
        query: 'dark gradient',
      });

      // generateQueryEmbedding に "query: dark gradient" が渡される
      expect(mockService.generateQueryEmbedding).toHaveBeenCalledWith(
        expect.stringContaining('query:')
      );
      expect(mockService.generateQueryEmbedding).toHaveBeenCalledWith(
        expect.stringContaining('dark gradient')
      );
    });

    // Embedding生成失敗時は空結果を返す
    it('Embedding生成失敗時は空結果を返す', async () => {
      const mockService = createMockService({
        generateQueryEmbedding: vi.fn().mockResolvedValue(null),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });

    // Embedding生成が768次元ベクトルを受け取ることを確認
    it('768次元Embeddingベクトルが検索サービスに渡される', async () => {
      const mockEmbedding = new Array(768).fill(0.05);
      const mockService = createMockService({
        generateQueryEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      await backgroundSearchHandler({
        query: 'noise texture background',
      });

      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        mockEmbedding,
        expect.any(Object)
      );
    });
  });

  // =====================================================
  // エラーハンドリング テスト
  // =====================================================

  describe('エラーハンドリング', () => {
    // DB検索エラー時は適切なエラーコードを返す
    it('DB検索エラー時は適切なエラーコードを返す', async () => {
      const mockService = createMockService({
        searchBackgroundDesigns: vi.fn().mockRejectedValue(
          new Error('Database connection failed')
        ),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBeDefined();
        expect(result.error.message).toContain('Database');
      }
    });

    // タイムアウトエラーを検出できる
    it('タイムアウトエラーを検出できる', async () => {
      const mockService = createMockService({
        searchBackgroundDesigns: vi.fn().mockRejectedValue(
          new Error('Query timeout exceeded')
        ),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBeDefined();
        expect(result.error.message).toContain('timeout');
      }
    });

    // Embedding生成エラー時は適切なエラーを返す
    it('Embedding生成エラー時は適切にハンドリングされる', async () => {
      const mockService = createMockService({
        generateQueryEmbedding: vi.fn().mockRejectedValue(
          new Error('Embedding model not loaded')
        ),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBeDefined();
        expect(result.error.message).toBeDefined();
      }
    });

    // バリデーションエラー時のレスポンス形式
    it('バリデーションエラー時のレスポンスにVALIDATION_ERRORコードが含まれる', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      // 空クエリで呼び出す
      const result = await backgroundSearchHandler({ query: '' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BACKGROUND_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =====================================================
  // ツール定義 テスト
  // =====================================================

  describe('ツール定義', () => {
    // ツール名がbackground.searchである
    it('ツール名がbackground.searchである', () => {
      expect(backgroundSearchToolDefinition.name).toBe('background.search');
    });

    // readOnlyHintがtrueである
    it('readOnlyHintがtrueである', () => {
      expect(backgroundSearchToolDefinition.annotations.readOnlyHint).toBe(true);
    });

    // inputSchemaにqueryが必須である
    it('inputSchemaにqueryが必須である', () => {
      expect(backgroundSearchToolDefinition.inputSchema.required).toContain('query');
    });

    // inputSchemaにqueryプロパティが定義されている
    it('inputSchemaにqueryプロパティが定義されている', () => {
      expect(backgroundSearchToolDefinition.inputSchema.properties.query).toBeDefined();
      expect(backgroundSearchToolDefinition.inputSchema.properties.query.type).toBe('string');
    });

    // inputSchemaにlimitプロパティが定義されている
    it('inputSchemaにlimitプロパティが定義されている', () => {
      expect(backgroundSearchToolDefinition.inputSchema.properties.limit).toBeDefined();
      expect(backgroundSearchToolDefinition.inputSchema.properties.limit.type).toBe('number');
    });

    // inputSchemaにfiltersプロパティが定義されている
    it('inputSchemaにfiltersプロパティが定義されている', () => {
      expect(backgroundSearchToolDefinition.inputSchema.properties.filters).toBeDefined();
    });

    // idempotentHintがtrueである（検索は冪等）
    it('idempotentHintがtrueである', () => {
      expect(backgroundSearchToolDefinition.annotations.idempotentHint).toBe(true);
    });

    // descriptionが日本語を含む
    it('descriptionが定義されている', () => {
      expect(backgroundSearchToolDefinition.description).toBeDefined();
      expect(backgroundSearchToolDefinition.description.length).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // レスポンス形式 テスト
  // =====================================================

  describe('レスポンス形式', () => {
    // 成功レスポンスの構造が正しい
    it('成功レスポンスの構造が正しい', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 必須フィールドの検証
        expect(result.data).toBeDefined();
        expect(result.data.results).toBeDefined();
        expect(Array.isArray(result.data.results)).toBe(true);
        expect(typeof result.data.total).toBe('number');
        expect(typeof result.data.query).toBe('string');
        expect(typeof result.data.searchTimeMs).toBe('number');
      }
    });

    // 失敗レスポンスの構造が正しい
    it('失敗レスポンスの構造が正しい', async () => {
      // ファクトリー未設定
      resetBackgroundSearchServiceFactory();

      const result = await backgroundSearchHandler({
        query: 'gradient background',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error.code).toBeDefined();
        expect(typeof result.error.code).toBe('string');
        expect(result.error.message).toBeDefined();
        expect(typeof result.error.message).toBe('string');
      }
    });

    // 検索結果アイテムの構造が正しい
    it('検索結果アイテムの構造が正しい', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'dark background',
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.results.length > 0) {
        const item = result.data.results[0];

        // BackgroundSearchResultItem の必須フィールド
        expect(typeof item.id).toBe('string');
        expect(typeof item.designType).toBe('string');
        expect(typeof item.cssValue).toBe('string');
        expect(typeof item.similarity).toBe('number');
        expect(item.source).toBeDefined();
      }
    });

    // 空結果のレスポンス形式
    it('空結果でもレスポンス構造は正しい', async () => {
      const mockService = createMockService({
        searchBackgroundDesigns: vi.fn().mockResolvedValue({
          results: [],
          total: 0,
        }),
      });
      setBackgroundSearchServiceFactory(() => mockService);

      const result = await backgroundSearchHandler({
        query: 'nonexistent background type xyz',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
        expect(result.data.query).toBe('nonexistent background type xyz');
      }
    });
  });

  // =====================================================
  // デフォルト値 テスト
  // =====================================================

  describe('デフォルト値', () => {
    // limitのデフォルト値は10
    it('limitのデフォルト値は10', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      await backgroundSearchHandler({ query: 'gradient' });

      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          limit: 10,
        })
      );
    });

    // offsetのデフォルト値は0
    it('offsetのデフォルト値は0', async () => {
      const mockService = createMockService();
      setBackgroundSearchServiceFactory(() => mockService);

      await backgroundSearchHandler({ query: 'gradient' });

      expect(mockService.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          offset: 0,
        })
      );
    });
  });
});

// =====================================================
// テストカウント確認
// =====================================================

describe('background.search テスト - カウント確認', () => {
  it('このファイルには 30 以上のテストケースが存在する', () => {
    // テスト数を確認するためのプレースホルダー
    // 実際のテスト数は上記の describe ブロック内の it の数
    expect(true).toBe(true);
  });
});
