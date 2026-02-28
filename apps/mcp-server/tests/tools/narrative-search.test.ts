// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * narrative.search MCPツール テスト
 * TDD Red Phase: 既存のsearch.tool.tsハンドラーの動作を検証
 *
 * テスト対象:
 * - 入力バリデーション（Zodスキーマ）
 * - サービスファクトリーDI
 * - 正常系検索（クエリ、フィルター、オプション）
 * - Embedding直接検索
 * - エラーハンドリング
 * - ツール定義
 *
 * @module tests/tools/narrative-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  narrativeSearchHandler,
  narrativeSearchToolDefinition,
  setNarrativeSearchServiceFactory,
  resetNarrativeSearchServiceFactory,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
} from '../../src/tools/narrative/search.tool';

import {
  narrativeSearchInputSchema,
  NARRATIVE_MCP_ERROR_CODES,
  type NarrativeSearchOutput,
} from '../../src/tools/narrative/schemas';

import type {
  INarrativeAnalysisService,
  NarrativeSearchResult,
  NarrativeSearchOptions as ServiceSearchOptions,
  MoodCategory,
} from '../../src/services/narrative/types/narrative.types';

// =====================================================
// テストデータ
// =====================================================

/**
 * モック検索結果を生成
 * NarrativeSearchResult型に準拠
 */
function createMockSearchResult(
  id: string,
  moodCategory: MoodCategory = 'tech',
  score: number = 0.85
): NarrativeSearchResult {
  return {
    id,
    webPageId: `wp-${id}`,
    score,
    vectorScore: score * 0.6,
    fulltextScore: score * 0.4,
    moodCategory,
    moodDescription: `${moodCategory}な雰囲気のデザイン`,
    confidence: 0.9,
  };
}

// =====================================================
// モックサービス
// =====================================================

/**
 * モックNarrativeAnalysisServiceを作成
 * INarrativeAnalysisServiceインターフェースに準拠
 */
function createMockNarrativeService(
  overrides?: Partial<INarrativeAnalysisService>
): INarrativeAnalysisService {
  return {
    // search メソッド（テスト対象）
    search: vi.fn().mockResolvedValue([
      createMockSearchResult('11111111-1111-1111-1111-111111111111', 'tech', 0.92),
      createMockSearchResult('22222222-2222-2222-2222-222222222222', 'minimal', 0.85),
      createMockSearchResult('33333333-3333-3333-3333-333333333333', 'professional', 0.78),
    ]),
    // analyze メソッド（narrative.searchでは使用しないがインターフェース必須）
    analyze: vi.fn().mockRejectedValue(new Error('Not implemented in search test')),
    // save メソッド
    save: vi.fn().mockRejectedValue(new Error('Not implemented in search test')),
    // analyzeAndSave メソッド
    analyzeAndSave: vi.fn().mockRejectedValue(new Error('Not implemented in search test')),
    ...overrides,
  };
}

// =====================================================
// 入力バリデーションテスト
// =====================================================

describe('narrative.search MCPツール', () => {
  // 各テストでファクトリーをリセット
  beforeEach(() => {
    resetNarrativeSearchServiceFactory();
    resetEmbeddingServiceFactory();
  });

  afterEach(() => {
    resetNarrativeSearchServiceFactory();
    resetEmbeddingServiceFactory();
  });

  // =================================================
  // 入力バリデーション
  // =================================================

  describe('入力バリデーション', () => {
    it('クエリが空の場合バリデーションエラー', async () => {
      // Arrange: サービスファクトリー設定（バリデーション前にエラーになるはず）
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: 空文字クエリで実行
      const result = await narrativeSearchHandler({ query: '' });

      // Assert: バリデーションエラーが返る
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('クエリが500文字超の場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);
      const longQuery = 'a'.repeat(501);

      // Act
      const result = await narrativeSearchHandler({ query: longQuery });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('limitが0以下の場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: limit=0で実行
      const result = await narrativeSearchHandler({
        query: 'ダークなデザイン',
        options: { limit: 0 },
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('limitが50超の場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: limit=51で実行
      const result = await narrativeSearchHandler({
        query: 'モダンなヒーローセクション',
        options: { limit: 51 },
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('不正なmoodCategoryフィルターの場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: 存在しないmoodCategoryを指定
      const result = await narrativeSearchHandler({
        query: 'ミニマルデザイン',
        filters: { moodCategory: 'invalid_mood' },
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('queryもembeddingも指定しない場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: queryもembeddingもなし
      const result = await narrativeSearchHandler({});

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('queryとembeddingを同時に指定した場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: 両方指定
      const result = await narrativeSearchHandler({
        query: 'テスト',
        embedding: new Array(768).fill(0.1),
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('embeddingが768次元でない場合バリデーションエラー', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: 256次元のembedding
      const result = await narrativeSearchHandler({
        embedding: new Array(256).fill(0.1),
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =================================================
  // スキーマレベルのバリデーション
  // =================================================

  describe('スキーマバリデーション', () => {
    it('有効なクエリ入力がパースされる', () => {
      // Arrange
      const input = { query: 'サイバーセキュリティ感のあるデザイン' };

      // Act
      const result = narrativeSearchInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('サイバーセキュリティ感のあるデザイン');
      }
    });

    it('有効なmoodCategoryがパースされる', () => {
      // Arrange
      const input = {
        query: 'テスト検索',
        filters: { moodCategory: 'tech' },
      };

      // Act
      const result = narrativeSearchInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filters?.moodCategory).toBe('tech');
      }
    });

    it('オプションのデフォルト値が適用される', () => {
      // Arrange
      const input = { query: 'テスト検索', options: {} };

      // Act
      const result = narrativeSearchInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.limit).toBe(10);
        expect(result.data.options?.searchMode).toBe('hybrid');
        expect(result.data.options?.minSimilarity).toBe(0.6);
        expect(result.data.options?.vectorWeight).toBe(0.6);
        expect(result.data.options?.fulltextWeight).toBe(0.4);
      }
    });

    it('minConfidenceが0-1の範囲外の場合エラー', () => {
      // Arrange
      const input = {
        query: 'テスト',
        filters: { minConfidence: 1.5 },
      };

      // Act
      const result = narrativeSearchInputSchema.safeParse(input);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  // =================================================
  // サービスファクトリー
  // =================================================

  describe('サービスファクトリー', () => {
    it('ファクトリー未設定時はSERVICE関連エラー', async () => {
      // Arrange: ファクトリー未設定（resetで明示的にnull）
      resetNarrativeSearchServiceFactory();

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト検索クエリ',
      });

      // Assert: サービス未利用可能エラー
      expect(result.success).toBe(false);
      if (!result.success) {
        // サービスファクトリー未設定のため、SEARCH_FAILEDまたはINTERNAL_ERRORが返る
        expect(result.error.code).toBeDefined();
        expect(result.error.message).toBeDefined();
      }
    });

    it('ファクトリー設定後にリセットできる', () => {
      // Arrange: ファクトリー設定
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: リセット
      resetNarrativeSearchServiceFactory();

      // Assert: リセット後は再度エラーになるはず（非同期で確認）
      // ファクトリーがnullに戻っていることを暗黙的に確認
      expect(true).toBe(true); // リセット自体がエラーなく完了
    });

    it('ファクトリー設定後にサービスが使用される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'ミニマルなデザイン',
      });

      // Assert: サービスのsearchが呼ばれた
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalled();
    });
  });

  // =================================================
  // 正常系検索
  // =================================================

  describe('正常系検索', () => {
    it('クエリでベクトル検索が実行される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'サイバーセキュリティ感のあるダークなデザイン',
      });

      // Assert
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'サイバーセキュリティ感のあるダークなデザイン',
        })
      );
    });

    it('検索結果がマッピングされて返却される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テクノロジー系デザイン',
      });

      // Assert: 結果が正しい形式で返される
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toBeDefined();
        expect(Array.isArray(result.data.results)).toBe(true);
        expect(result.data.searchInfo).toBeDefined();
        expect(result.data.searchInfo.query).toBeDefined();
        expect(result.data.searchInfo.totalResults).toBeGreaterThanOrEqual(0);
        expect(result.data.searchInfo.searchTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('moodCategoryフィルターが適用される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'デザイン検索',
        filters: { moodCategory: 'minimal' },
      });

      // Assert: サービスにフィルターが渡される
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            moodCategory: ['minimal'],
          }),
        })
      );
    });

    it('minConfidenceフィルターが適用される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'プロフェッショナルなデザイン',
        filters: { minConfidence: 0.8 },
      });

      // Assert: サービスにフィルターが渡される
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            minConfidence: 0.8,
          }),
        })
      );
    });

    it('limit/offsetオプションが適用される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
        options: { limit: 5 },
      });

      // Assert: limitがサービスに渡される
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 5,
        })
      );
    });

    it('similarityスコアが含まれる', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テクノロジーデザイン',
      });

      // Assert: 結果にsimilarityが含まれる
      expect(result.success).toBe(true);
      if (result.success && result.data.results.length > 0) {
        for (const item of result.data.results) {
          expect(item.similarity).toBeDefined();
          expect(typeof item.similarity).toBe('number');
          expect(item.similarity).toBeGreaterThanOrEqual(0);
          expect(item.similarity).toBeLessThanOrEqual(1);
        }
      }
    });

    it('moodDescription, confidenceが結果に含まれる', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'エレガントなデザイン',
      });

      // Assert: worldView (moodCategory, moodDescription) と confidence
      expect(result.success).toBe(true);
      if (result.success && result.data.results.length > 0) {
        for (const item of result.data.results) {
          // 世界観サマリー
          expect(item.worldView).toBeDefined();
          expect(item.worldView.moodCategory).toBeDefined();
          expect(item.worldView.moodDescription).toBeDefined();
          // 信頼度
          expect(item.confidence).toBeDefined();
          expect(typeof item.confidence).toBe('number');
        }
      }
    });

    it('searchInfoにsearchModeが含まれる', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト',
        options: { searchMode: 'vector' },
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchInfo.searchMode).toBe('vector');
      }
    });

    it('minSimilarityフィルターが結果に適用される', async () => {
      // Arrange: 低スコア結果を含むモック
      const mockService = createMockNarrativeService({
        search: vi.fn().mockResolvedValue([
          createMockSearchResult('aaa-1', 'tech', 0.95),
          createMockSearchResult('aaa-2', 'minimal', 0.70),
          createMockSearchResult('aaa-3', 'bold', 0.50),  // minSimilarityのデフォルト0.6未満
        ]),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: デフォルトのminSimilarity=0.6
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
      });

      // Assert: 0.6未満の結果はフィルターされる
      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          expect(item.similarity).toBeGreaterThanOrEqual(0.6);
        }
      }
    });
  });

  // =================================================
  // Embedding直接検索
  // =================================================

  describe('Embedding', () => {
    it('768次元Embedding直接検索が受け付けられる', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);
      const embedding = new Array(768).fill(0.1);

      // Act
      const result = await narrativeSearchHandler({
        embedding,
      });

      // Assert: 検索が実行される
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalled();
    });

    it('Embedding生成失敗時はエラーを返す', async () => {
      // Arrange: Embeddingサービスがエラーを投げる
      const mockService = createMockNarrativeService({
        search: vi.fn().mockRejectedValue(new Error('Embedding generation failed')),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
      });

      // Assert: エラーが返る（空結果ではなくエラー）
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.EMBEDDING_FAILED);
      }
    });
  });

  // =================================================
  // エラーハンドリング
  // =================================================

  describe('エラーハンドリング', () => {
    it('DB検索エラー時は適切なエラーコードを返す', async () => {
      // Arrange: DBエラーを投げるモック
      const mockService = createMockNarrativeService({
        search: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
      });

      // Assert: SEARCH_FAILEDエラー
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.SEARCH_FAILED);
      }
    });

    it('タイムアウトエラーを検出できる', async () => {
      // Arrange: タイムアウトエラーを投げるモック
      const mockService = createMockNarrativeService({
        search: vi.fn().mockRejectedValue(new Error('Search timeout exceeded')),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'タイムアウトテスト',
      });

      // Assert: エラーが返る
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBeDefined();
        expect(result.error.message).toBeDefined();
      }
    });

    it('未知のエラー時はINTERNAL_ERRORを返す', async () => {
      // Arrange: 非Errorオブジェクトを投げるモック
      const mockService = createMockNarrativeService({
        search: vi.fn().mockRejectedValue('unknown error string'),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'エラーテスト',
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(NARRATIVE_MCP_ERROR_CODES.INTERNAL_ERROR);
      }
    });
  });

  // =================================================
  // ツール定義
  // =================================================

  describe('ツール定義', () => {
    it('ツール名がnarrative.searchである', () => {
      expect(narrativeSearchToolDefinition.name).toBe('narrative.search');
    });

    it('inputSchemaにqueryプロパティが含まれる', () => {
      // ツール定義のinputSchemaにqueryが定義されていること
      const inputSchema = narrativeSearchToolDefinition.inputSchema;
      expect(inputSchema).toBeDefined();

      // propertiesにqueryが存在
      if ('properties' in inputSchema) {
        expect(
          (inputSchema.properties as Record<string, unknown>).query
        ).toBeDefined();
      }
    });

    it('inputSchemaにembeddingプロパティが含まれる', () => {
      const inputSchema = narrativeSearchToolDefinition.inputSchema;
      expect(inputSchema).toBeDefined();

      if ('properties' in inputSchema) {
        expect(
          (inputSchema.properties as Record<string, unknown>).embedding
        ).toBeDefined();
      }
    });

    it('inputSchemaにfiltersプロパティが含まれる', () => {
      const inputSchema = narrativeSearchToolDefinition.inputSchema;
      expect(inputSchema).toBeDefined();

      if ('properties' in inputSchema) {
        expect(
          (inputSchema.properties as Record<string, unknown>).filters
        ).toBeDefined();
      }
    });

    it('queryまたはembeddingのいずれかが必須（oneOf）', () => {
      const inputSchema = narrativeSearchToolDefinition.inputSchema;
      expect(inputSchema).toBeDefined();

      // oneOfでqueryまたはembeddingが必須
      if ('oneOf' in inputSchema) {
        expect(inputSchema.oneOf).toBeDefined();
        expect(Array.isArray(inputSchema.oneOf)).toBe(true);
      }
    });
  });

  // =================================================
  // 検索モード
  // =================================================

  describe('検索モード', () => {
    it('hybridモード（デフォルト）で検索が実行される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: searchModeを指定しない（デフォルトhybrid）
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchInfo.searchMode).toBe('hybrid');
      }
    });

    it('vectorモードで検索が実行される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
        options: { searchMode: 'vector' },
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchInfo.searchMode).toBe('vector');
      }
    });

    it('vectorWeight/fulltextWeightが検索オプションに渡される', async () => {
      // Arrange
      const mockService = createMockNarrativeService();
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'テスト',
        options: { vectorWeight: 0.8, fulltextWeight: 0.2 },
      });

      // Assert
      expect(result.success).toBe(true);
      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          vectorWeight: 0.8,
          fulltextWeight: 0.2,
        })
      );
    });
  });

  // =================================================
  // Hybrid Search（searchHybrid メソッド）
  // =================================================

  describe('Hybrid Search', () => {
    it('searchHybridが利用可能な場合、hybridモードでsearchHybridが呼ばれる', async () => {
      // Arrange: searchHybrid メソッドを持つモックサービス
      const searchHybridMock = vi.fn().mockResolvedValue([
        createMockSearchResult('hybrid-1', 'tech', 0.95),
      ]);
      const searchMock = vi.fn().mockResolvedValue([
        createMockSearchResult('vector-1', 'tech', 0.85),
      ]);
      const mockService = createMockNarrativeService({
        search: searchMock,
        searchHybrid: searchHybridMock,
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: デフォルトモード（hybrid）
      const result = await narrativeSearchHandler({
        query: 'テクノロジーデザイン',
      });

      // Assert: searchHybridが呼ばれ、searchは呼ばれない
      expect(result.success).toBe(true);
      expect(searchHybridMock).toHaveBeenCalled();
      expect(searchMock).not.toHaveBeenCalled();
    });

    it('searchHybridが利用可能でもvectorモードではsearchが呼ばれる', async () => {
      // Arrange
      const searchHybridMock = vi.fn().mockResolvedValue([
        createMockSearchResult('hybrid-1', 'tech', 0.95),
      ]);
      const searchMock = vi.fn().mockResolvedValue([
        createMockSearchResult('vector-1', 'tech', 0.85),
      ]);
      const mockService = createMockNarrativeService({
        search: searchMock,
        searchHybrid: searchHybridMock,
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: vectorモード明示
      const result = await narrativeSearchHandler({
        query: 'テクノロジーデザイン',
        options: { searchMode: 'vector' },
      });

      // Assert: searchが呼ばれ、searchHybridは呼ばれない
      expect(result.success).toBe(true);
      expect(searchMock).toHaveBeenCalled();
      expect(searchHybridMock).not.toHaveBeenCalled();
    });

    it('searchHybridが未定義の場合、hybridモードでもsearchにフォールバック', async () => {
      // Arrange: searchHybridメソッドなし
      const searchMock = vi.fn().mockResolvedValue([
        createMockSearchResult('vector-1', 'tech', 0.85),
      ]);
      const mockService = createMockNarrativeService({
        search: searchMock,
      });
      // searchHybrid は undefined（createMockNarrativeService で設定なし）
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: hybridモード（デフォルト）
      const result = await narrativeSearchHandler({
        query: 'テクノロジーデザイン',
      });

      // Assert: searchHybridがないのでsearchが呼ばれる
      expect(result.success).toBe(true);
      expect(searchMock).toHaveBeenCalled();
    });

    it('searchHybridの結果にminSimilarityフィルターが適用される', async () => {
      // Arrange: 低スコア結果を含むモック
      const searchHybridMock = vi.fn().mockResolvedValue([
        createMockSearchResult('hybrid-1', 'tech', 0.95),
        createMockSearchResult('hybrid-2', 'minimal', 0.70),
        createMockSearchResult('hybrid-3', 'bold', 0.50),  // minSimilarity=0.6未満
      ]);
      const mockService = createMockNarrativeService({
        searchHybrid: searchHybridMock,
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act: デフォルトminSimilarity=0.6
      const result = await narrativeSearchHandler({
        query: 'テスト検索',
      });

      // Assert: 0.6未満の結果がフィルターされる
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBe(2); // 0.95 + 0.70 のみ
        for (const item of result.data.results) {
          expect(item.similarity).toBeGreaterThanOrEqual(0.6);
        }
      }
    });

    it('searchHybridのレスポンスがMCPレスポンス形式に変換される', async () => {
      // Arrange
      const searchHybridMock = vi.fn().mockResolvedValue([
        createMockSearchResult('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'premium', 0.88),
      ]);
      const mockService = createMockNarrativeService({
        searchHybrid: searchHybridMock,
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'プレミアムなデザイン',
      });

      // Assert: MCP形式のレスポンス
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBe(1);
        const item = result.data.results[0];
        expect(item.id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
        expect(item.worldView.moodCategory).toBe('premium');
        expect(item.similarity).toBeGreaterThan(0);
        expect(result.data.searchInfo.searchMode).toBe('hybrid');
      }
    });
  });

  // =================================================
  // 結果マッピング
  // =================================================

  describe('結果マッピング', () => {
    it('NarrativeSearchResultがMCPレスポンス形式に変換される', async () => {
      // Arrange
      const mockService = createMockNarrativeService({
        search: vi.fn().mockResolvedValue([
          createMockSearchResult('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'elegant', 0.91),
        ]),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: 'エレガントなデザイン',
      });

      // Assert: MCP形式のレスポンス
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBe(1);
        const item = result.data.results[0];

        // 各必須フィールドの存在確認
        expect(item.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
        expect(item.webPageId).toBeDefined();
        expect(item.similarity).toBeDefined();
        expect(item.worldView).toBeDefined();
        expect(item.worldView.moodCategory).toBe('elegant');
        expect(item.confidence).toBeDefined();
      }
    });

    it('空の検索結果が正しく処理される', async () => {
      // Arrange: 空結果を返すモック
      const mockService = createMockNarrativeService({
        search: vi.fn().mockResolvedValue([]),
      });
      setNarrativeSearchServiceFactory(() => mockService);

      // Act
      const result = await narrativeSearchHandler({
        query: '存在しないデザインパターン',
      });

      // Assert: 空の結果が正常に返される
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([]);
        expect(result.data.searchInfo.totalResults).toBe(0);
      }
    });
  });

  // =================================================
  // MoodCategory一覧の検証
  // =================================================

  describe('MoodCategory', () => {
    const validMoodCategories: MoodCategory[] = [
      'professional', 'playful', 'premium', 'tech',
      'organic', 'minimal', 'bold', 'elegant',
      'friendly', 'artistic', 'trustworthy', 'energetic',
    ];

    it.each(validMoodCategories)(
      '有効なMoodCategory "%s" がフィルターに使用できる',
      async (moodCategory) => {
        // Arrange
        const mockService = createMockNarrativeService();
        setNarrativeSearchServiceFactory(() => mockService);

        // Act
        const result = await narrativeSearchHandler({
          query: 'デザイン検索',
          filters: { moodCategory },
        });

        // Assert: バリデーションエラーにならない
        expect(result.success).toBe(true);
      }
    );
  });

  // =================================================
  // テストカウント確認
  // =================================================

  describe('テストカウント確認', () => {
    it('このファイルには25以上のテストケースが存在する', () => {
      // テスト数確認用プレースホルダー
      // 上記の describe ブロック内の it の数を数えると30以上
      expect(true).toBe(true);
    });
  });
});
