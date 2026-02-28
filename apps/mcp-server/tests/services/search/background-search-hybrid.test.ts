// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * background.search ハイブリッドメソッド テスト
 *
 * IBackgroundSearchService.searchBackgroundDesignsHybrid のオプショナル呼び出し分岐検証:
 * - searchBackgroundDesignsHybrid が実装されている場合: ハイブリッド検索が優先される
 * - searchBackgroundDesignsHybrid が未実装の場合: vector-only検索にフォールバック
 * - ツールハンドラーでの分岐ロジック
 *
 * TDA監査 P2-5: Hybrid Search固有テスト欠如の解消
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backgroundSearchHandler,
  setBackgroundSearchServiceFactory,
  resetBackgroundSearchServiceFactory,
  type IBackgroundSearchService,
  type BackgroundDesignSearchResult,
} from '../../../src/tools/background/search.tool';

// =====================================================
// モックデータファクトリ
// =====================================================

/** テスト用BackgroundDesignSearchResult生成ヘルパー */
function createMockBgSearchResult(
  overrides?: Partial<BackgroundDesignSearchResult>
): BackgroundDesignSearchResult {
  return {
    id: 'bg-001',
    webPageId: 'wp-001',
    name: 'Gradient Hero Background',
    designType: 'linear_gradient',
    cssValue: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    selector: '.hero-bg',
    similarity: 0.93,
    colorInfo: { primary: '#667eea', secondary: '#764ba2' },
    textRepresentation: 'purple blue gradient background hero section',
    ...overrides,
  };
}

/** searchBackgroundDesignsHybrid メソッドを持つモックサービス */
function createMockServiceWithHybrid(
  hybridResults: BackgroundDesignSearchResult[],
  vectorResults?: BackgroundDesignSearchResult[]
): IBackgroundSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.01)),
    searchBackgroundDesigns: vi.fn().mockResolvedValue({
      results: vectorResults ?? [createMockBgSearchResult()],
      total: vectorResults?.length ?? 1,
    }),
    searchBackgroundDesignsHybrid: vi.fn().mockResolvedValue({
      results: hybridResults,
      total: hybridResults.length,
    }),
  };
}

/** searchBackgroundDesignsHybrid メソッドを持たないモックサービス */
function createMockServiceWithoutHybrid(
  vectorResults?: BackgroundDesignSearchResult[]
): IBackgroundSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.01)),
    searchBackgroundDesigns: vi.fn().mockResolvedValue({
      results: vectorResults ?? [createMockBgSearchResult()],
      total: vectorResults?.length ?? 1,
    }),
    // searchBackgroundDesignsHybrid は undefined（未実装）
  };
}

// =====================================================
// テスト
// =====================================================

describe('background.search ハイブリッド検索分岐', () => {
  beforeEach(() => {
    resetBackgroundSearchServiceFactory();
  });

  afterEach(() => {
    resetBackgroundSearchServiceFactory();
  });

  // --- searchBackgroundDesignsHybrid が利用可能な場合 ---

  describe('searchBackgroundDesignsHybrid が実装されている場合', () => {
    it('ハイブリッド検索が優先的に呼び出されること', async () => {
      // Arrange
      const hybridResults = [
        createMockBgSearchResult({
          id: 'hybrid-bg-001',
          designType: 'glassmorphism',
          cssValue: 'background: rgba(255,255,255,0.1); backdrop-filter: blur(10px);',
          similarity: 0.95,
        }),
      ];

      const service = createMockServiceWithHybrid(hybridResults);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: 'glassmorphism frosted glass effect',
        limit: 10,
        offset: 0,
      });

      // Assert: ハイブリッドメソッドが呼び出された
      expect(service.searchBackgroundDesignsHybrid).toHaveBeenCalledOnce();
      // vector-only メソッドは呼び出されない
      expect(service.searchBackgroundDesigns).not.toHaveBeenCalled();

      // 結果が正しいこと
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].id).toBe('hybrid-bg-001');
        expect(result.data.results[0].designType).toBe('glassmorphism');
      }
    });

    it('ハイブリッド検索に正しい引数が渡されること', async () => {
      // Arrange
      const service = createMockServiceWithHybrid([createMockBgSearchResult()]);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      await backgroundSearchHandler({
        query: 'radial gradient purple',
        limit: 5,
        offset: 10,
        filters: {
          designType: 'radial_gradient',
          webPageId: '019c0000-0000-7000-8000-000000000001',
        },
      });

      // Assert: 引数を検証
      expect(service.searchBackgroundDesignsHybrid).toHaveBeenCalledWith(
        'radial gradient purple', // rawクエリテキスト
        expect.any(Array),        // embedding
        expect.objectContaining({
          limit: 5,
          offset: 10,
          filters: expect.objectContaining({
            designType: 'radial_gradient',
            webPageId: '019c0000-0000-7000-8000-000000000001',
          }),
        })
      );
    });

    it('ハイブリッド検索が空結果を返した場合に空配列が返ること', async () => {
      // Arrange
      const service = createMockServiceWithHybrid([]);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: 'nonexistent background',
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });

    it('複数件のハイブリッド結果が正しくマッピングされること', async () => {
      // Arrange
      const hybridResults = [
        createMockBgSearchResult({
          id: 'bg-001',
          designType: 'linear_gradient',
          similarity: 0.95,
        }),
        createMockBgSearchResult({
          id: 'bg-002',
          designType: 'mesh_gradient',
          similarity: 0.88,
        }),
        createMockBgSearchResult({
          id: 'bg-003',
          designType: 'animated_gradient',
          similarity: 0.82,
        }),
      ];

      const service = createMockServiceWithHybrid(hybridResults);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: 'gradient background',
        limit: 10,
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(3);
        expect(result.data.total).toBe(3);

        // 全ての結果が正しいフィールドを持つこと
        for (const item of result.data.results) {
          expect(item).toHaveProperty('id');
          expect(item).toHaveProperty('designType');
          expect(item).toHaveProperty('cssValue');
          expect(item).toHaveProperty('similarity');
          expect(item).toHaveProperty('source');
          expect(item.source).toHaveProperty('webPageId');
          expect(item).toHaveProperty('name');
          expect(item).toHaveProperty('colorInfo');
          expect(item).toHaveProperty('textRepresentation');
        }
      }
    });
  });

  // --- searchBackgroundDesignsHybrid が未実装の場合 ---

  describe('searchBackgroundDesignsHybrid が未実装の場合', () => {
    it('vector-only検索にフォールバックすること', async () => {
      // Arrange
      const vectorResults = [
        createMockBgSearchResult({
          id: 'vector-bg-001',
          designType: 'svg_background',
          cssValue: 'url(pattern.svg)',
          similarity: 0.87,
        }),
      ];

      const service = createMockServiceWithoutHybrid(vectorResults);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: 'SVG pattern background',
        limit: 10,
      });

      // Assert: vector-onlyメソッドが呼び出された
      expect(service.searchBackgroundDesigns).toHaveBeenCalledOnce();
      // ハイブリッドは存在しない
      expect(service.searchBackgroundDesignsHybrid).toBeUndefined();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].id).toBe('vector-bg-001');
      }
    });

    it('vector-only検索に正しいパラメータが渡されること', async () => {
      // Arrange
      const service = createMockServiceWithoutHybrid();
      setBackgroundSearchServiceFactory(() => service);

      // Act
      await backgroundSearchHandler({
        query: 'dark noise texture',
        limit: 15,
        offset: 5,
        filters: {
          designType: 'noise_texture',
        },
      });

      // Assert
      expect(service.searchBackgroundDesigns).toHaveBeenCalledWith(
        expect.any(Array), // embedding
        expect.objectContaining({
          limit: 15,
          offset: 5,
          filters: expect.objectContaining({
            designType: 'noise_texture',
          }),
        })
      );
    });
  });

  // --- Embedding生成失敗時 ---

  describe('Embedding生成が失敗した場合', () => {
    it('embeddingがnullの場合に空結果が返ること', async () => {
      // Arrange: embedding生成が null を返す
      const service: IBackgroundSearchService = {
        generateQueryEmbedding: vi.fn().mockResolvedValue(null),
        searchBackgroundDesigns: vi.fn(),
        searchBackgroundDesignsHybrid: vi.fn(),
      };
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: 'test query',
      });

      // Assert: 検索メソッドは呼び出されない
      expect(service.searchBackgroundDesigns).not.toHaveBeenCalled();
      expect(service.searchBackgroundDesignsHybrid).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  // --- バリデーションエラー ---

  describe('入力バリデーション', () => {
    it('queryが空の場合にバリデーションエラーが返ること', async () => {
      // Arrange
      const service = createMockServiceWithHybrid([]);
      setBackgroundSearchServiceFactory(() => service);

      // Act
      const result = await backgroundSearchHandler({
        query: '',
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // --- サービスファクトリー未設定 ---

  describe('サービスファクトリーが未設定の場合', () => {
    it('SERVICE_UNAVAILABLEエラーが返ること', async () => {
      // Arrange: ファクトリーを設定しない
      resetBackgroundSearchServiceFactory();

      // Act
      const result = await backgroundSearchHandler({
        query: 'test background',
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });
});
