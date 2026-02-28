// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search ハイブリッドメソッド テスト
 *
 * MotionSearchService.searchHybrid のオプショナル呼び出し分岐検証:
 * - searchHybrid が実装されている場合: ハイブリッド検索が優先される
 * - searchHybrid が未実装の場合: 通常の search にフォールバック
 * - ツールハンドラーでの分岐ロジック
 *
 * TDA監査 P2-5: Hybrid Search固有テスト欠如の解消
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  motionSearchHandler,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchParams,
  type MotionSearchResult,
} from '../../../src/tools/motion/search.tool';

// =====================================================
// モックデータファクトリ
// =====================================================

/** テスト用MotionSearchResult生成ヘルパー */
function createMockMotionSearchResult(overrides?: Partial<MotionSearchResult>): MotionSearchResult {
  return {
    results: [
      {
        pattern: {
          id: 'mp-001',
          type: 'css_animation',
          category: 'scroll_trigger',
          name: 'fadeInUp',
          trigger: 'scroll',
          animation: {
            duration: 800,
            easing: { type: 'ease-out' },
          },
          properties: [
            { property: 'opacity', from: 0, to: 1 },
            { property: 'transform', from: 'translateY(20px)', to: 'translateY(0)' },
          ],
        },
        similarity: 0.92,
        source: { pageId: 'wp-001', url: 'https://example.com' },
      },
      {
        pattern: {
          id: 'mp-002',
          type: 'css_transition',
          category: 'hover_effect',
          name: 'scaleHover',
          trigger: 'hover',
          animation: {
            duration: 300,
            easing: { type: 'ease' },
          },
          properties: [
            { property: 'transform', from: 'scale(1)', to: 'scale(1.05)' },
          ],
        },
        similarity: 0.85,
      },
    ],
    total: 2,
    query: { text: 'scroll animation' },
    ...overrides,
  };
}

/** searchHybrid メソッドを持つモックサービス */
function createMockServiceWithHybrid(
  hybridResult: MotionSearchResult,
  searchResult?: MotionSearchResult
): IMotionSearchService {
  return {
    search: vi.fn().mockResolvedValue(searchResult ?? createMockMotionSearchResult()),
    searchHybrid: vi.fn().mockResolvedValue(hybridResult),
  };
}

/** searchHybrid メソッドを持たないモックサービス */
function createMockServiceWithoutHybrid(
  searchResult?: MotionSearchResult
): IMotionSearchService {
  return {
    search: vi.fn().mockResolvedValue(searchResult ?? createMockMotionSearchResult()),
    // searchHybrid は undefined
  };
}

// =====================================================
// テスト
// =====================================================

describe('motion.search ハイブリッド検索分岐', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    resetMotionSearchServiceFactory();
  });

  // --- searchHybrid が利用可能な場合 ---

  describe('searchHybrid が実装されている場合', () => {
    it('ハイブリッド検索が優先的に呼び出されること', async () => {
      // Arrange
      const hybridResult = createMockMotionSearchResult({
        results: [
          {
            pattern: {
              id: 'hybrid-mp-001',
              type: 'css_animation',
              category: 'scroll_trigger',
              name: 'hybridFadeIn',
              trigger: 'scroll',
              animation: { duration: 600 },
              properties: [],
            },
            similarity: 0.96,
          },
        ],
        total: 1,
      });

      const service = createMockServiceWithHybrid(hybridResult);
      setMotionSearchServiceFactory(() => service);

      // Act
      const result = await motionSearchHandler({
        query: 'scroll fade animation',
        limit: 10,
        minSimilarity: 0.5,
      });

      // Assert: searchHybrid が呼び出された
      expect(service.searchHybrid).toHaveBeenCalledOnce();
      // 通常の search は呼び出されない
      expect(service.search).not.toHaveBeenCalled();

      // 結果が正しいこと
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('searchHybrid に正しい MotionSearchParams が渡されること', async () => {
      // Arrange
      const service = createMockServiceWithHybrid(createMockMotionSearchResult());
      setMotionSearchServiceFactory(() => service);

      // Act
      await motionSearchHandler({
        query: 'hover scale effect',
        limit: 5,
        minSimilarity: 0.7,
        filters: {
          trigger: 'hover',
        },
      });

      // Assert: searchHybrid の引数を検証
      expect(service.searchHybrid).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'hover scale effect',
          limit: 5,
          minSimilarity: 0.7,
          filters: expect.objectContaining({ trigger: 'hover' }),
        })
      );
    });

    it('searchHybrid が空結果を返した場合に空配列が返ること', async () => {
      // Arrange
      const emptyResult = createMockMotionSearchResult({
        results: [],
        total: 0,
      });

      const service = createMockServiceWithHybrid(emptyResult);
      setMotionSearchServiceFactory(() => service);

      // Act
      const result = await motionSearchHandler({
        query: 'nonexistent pattern',
        limit: 10,
        minSimilarity: 0.9,
      });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  // --- searchHybrid が未実装の場合 ---

  describe('searchHybrid が未実装の場合', () => {
    it('通常の search メソッドにフォールバックすること', async () => {
      // Arrange
      const searchResult = createMockMotionSearchResult({
        results: [
          {
            pattern: {
              id: 'search-mp-001',
              type: 'css_animation',
              category: 'micro_interaction',
              name: 'vectorOnlyResult',
              trigger: 'click',
              animation: { duration: 200 },
              properties: [],
            },
            similarity: 0.88,
          },
        ],
        total: 1,
      });

      const service = createMockServiceWithoutHybrid(searchResult);
      setMotionSearchServiceFactory(() => service);

      // Act
      const result = await motionSearchHandler({
        query: 'click interaction',
        limit: 10,
        minSimilarity: 0.5,
      });

      // Assert: 通常の search が呼び出された
      expect(service.search).toHaveBeenCalledOnce();
      // searchHybrid は存在しない
      expect(service.searchHybrid).toBeUndefined();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('search に正しいパラメータが渡されること', async () => {
      // Arrange
      const service = createMockServiceWithoutHybrid();
      setMotionSearchServiceFactory(() => service);

      // Act
      await motionSearchHandler({
        query: 'loading animation',
        limit: 20,
        minSimilarity: 0.3,
        filters: {
          type: 'animation',
        },
      });

      // Assert
      expect(service.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'loading animation',
          limit: 20,
          minSimilarity: 0.3,
        })
      );
    });
  });

  // --- samplePattern 検索のハイブリッド分岐 ---

  describe('samplePattern を使用したハイブリッド検索', () => {
    it('samplePattern指定時もsearchHybridが優先されること', async () => {
      // Arrange
      const service = createMockServiceWithHybrid(createMockMotionSearchResult());
      setMotionSearchServiceFactory(() => service);

      // Act
      // samplePattern.type は motionSearchTypeSchema の enum値である必要がある
      // （'animation' | 'transition' | 'transform' | 'scroll' | 'hover' | 'keyframe'）
      const result = await motionSearchHandler({
        samplePattern: {
          type: 'animation',
          duration: 500,
          easing: 'ease-out',
          properties: ['opacity', 'transform'],
        },
        limit: 10,
        minSimilarity: 0.5,
      });

      // Assert
      expect(service.searchHybrid).toHaveBeenCalledOnce();
      expect(service.search).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  // --- サービスファクトリー未設定 ---

  describe('サービスファクトリーが未設定の場合', () => {
    it('SERVICE_UNAVAILABLEエラーが返ること', async () => {
      // Arrange: ファクトリーを設定しない
      resetMotionSearchServiceFactory();

      // Act
      const result = await motionSearchHandler({
        query: 'test',
        limit: 10,
        minSimilarity: 0.5,
      });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });
});
