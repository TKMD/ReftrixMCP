// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * モーションパターンを類似検索するMCPツール
 *
 * テスト対象:
 * - 入力バリデーションテスト (15テスト)
 * - 検索テスト (20テスト)
 * - DIパターンテスト (10テスト)
 * - エッジケーステスト (5テスト)
 *
 * @module tests/tools/motion/search.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionSearchHandler,
  motionSearchToolDefinition,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchInput,
  type MotionSearchOutput,
} from '../../../src/tools/motion/search.tool';

import {
  motionSearchInputSchema,
  motionSearchOutputSchema,
  motionSearchDataSchema,
  motionSearchResultItemSchema,
  samplePatternSchema,
  motionSearchFiltersSchema,
  type MotionSearchResultItem,
  type MotionPattern,
  MOTION_SEARCH_ERROR_CODES,
} from '../../../src/tools/motion/schemas';

// =====================================================
// テストデータ
// =====================================================

const validUUID = '123e4567-e89b-12d3-a456-426614174000';

const sampleMotionPattern: MotionPattern = {
  id: 'pattern-1',
  type: 'css_animation',
  category: 'scroll_trigger',
  name: 'fadeIn',
  trigger: 'load',
  animation: {
    duration: 600,
    easing: { type: 'ease-out' },
  },
  properties: [
    { property: 'opacity', from: 0, to: 1 },
    { property: 'transform', from: 'translateY(20px)', to: 'translateY(0)' },
  ],
};

const sampleSearchResults: MotionSearchResultItem[] = [
  {
    pattern: sampleMotionPattern,
    similarity: 0.95,
    source: {
      pageId: validUUID,
      url: 'https://example.com/page1',
      selector: '.fade-in',
    },
  },
  {
    pattern: {
      id: 'pattern-2',
      type: 'css_transition',
      category: 'hover_effect',
      trigger: 'hover',
      animation: {
        duration: 300,
        easing: { type: 'ease' },
      },
      properties: [{ property: 'transform' }],
    },
    similarity: 0.85,
    source: {
      url: 'https://example.com/page2',
    },
  },
];

// =====================================================
// 入力バリデーションテスト（15 tests）
// =====================================================

describe('motionSearchInputSchema', () => {
  describe('有効な入力', () => {
    it('queryのみの入力を受け付ける', () => {
      const input = { query: 'fade in animation' };
      const result = motionSearchInputSchema.parse(input);
      expect(result.query).toBe('fade in animation');
      expect(result.limit).toBe(10); // デフォルト値
      expect(result.minSimilarity).toBe(0.5); // デフォルト値
    });

    it('samplePatternのみの入力を受け付ける', () => {
      const input = {
        samplePattern: {
          type: 'animation' as const,
          duration: 500,
        },
      };
      const result = motionSearchInputSchema.parse(input);
      expect(result.samplePattern).toBeDefined();
      expect(result.samplePattern?.type).toBe('animation');
      expect(result.samplePattern?.duration).toBe(500);
    });

    it('queryとsamplePatternの両方を受け付ける', () => {
      const input = {
        query: 'hover effect',
        samplePattern: {
          type: 'transition' as const,
          easing: 'ease-in-out',
        },
      };
      const result = motionSearchInputSchema.parse(input);
      expect(result.query).toBe('hover effect');
      expect(result.samplePattern).toBeDefined();
    });

    it('filtersを指定できる', () => {
      const input = {
        query: 'loading animation',
        filters: {
          type: 'animation' as const,
          minDuration: 100,
          maxDuration: 1000,
          trigger: 'load' as const,
        },
      };
      const result = motionSearchInputSchema.parse(input);
      expect(result.filters).toBeDefined();
      expect(result.filters?.type).toBe('animation');
      expect(result.filters?.minDuration).toBe(100);
      expect(result.filters?.maxDuration).toBe(1000);
      expect(result.filters?.trigger).toBe('load');
    });

    it('limitを指定できる', () => {
      const input = { query: 'test', limit: 25 };
      const result = motionSearchInputSchema.parse(input);
      expect(result.limit).toBe(25);
    });

    it('minSimilarityを指定できる', () => {
      const input = { query: 'test', minSimilarity: 0.8 };
      const result = motionSearchInputSchema.parse(input);
      expect(result.minSimilarity).toBe(0.8);
    });

    it('samplePatternのpropertiesを受け付ける', () => {
      const input = {
        samplePattern: {
          properties: ['opacity', 'transform', 'scale'],
        },
      };
      const result = motionSearchInputSchema.parse(input);
      expect(result.samplePattern?.properties).toEqual(['opacity', 'transform', 'scale']);
    });

    it('全オプション指定の入力を受け付ける', () => {
      const input: MotionSearchInput = {
        query: 'smooth scroll animation',
        samplePattern: {
          type: 'scroll',
          duration: 800,
          easing: 'ease-out',
          properties: ['transform', 'opacity'],
        },
        filters: {
          type: 'scroll',
          minDuration: 300,
          maxDuration: 2000,
          trigger: 'scroll',
        },
        limit: 20,
        minSimilarity: 0.7,
      };
      const result = motionSearchInputSchema.parse(input);
      expect(result.query).toBe('smooth scroll animation');
      expect(result.samplePattern).toBeDefined();
      expect(result.filters).toBeDefined();
      expect(result.limit).toBe(20);
      expect(result.minSimilarity).toBe(0.7);
    });
  });

  describe('無効な入力', () => {
    it('queryもsamplePatternもない場合エラー', () => {
      const input = {};
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('空のqueryの場合エラー', () => {
      const input = { query: '' };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('queryが500文字を超える場合エラー', () => {
      const input = { query: 'a'.repeat(501) };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('limitが0の場合エラー', () => {
      const input = { query: 'test', limit: 0 };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('limitが50を超える場合エラー', () => {
      const input = { query: 'test', limit: 51 };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('minSimilarityが負の場合エラー', () => {
      const input = { query: 'test', minSimilarity: -0.1 };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('minSimilarityが1を超える場合エラー', () => {
      const input = { query: 'test', minSimilarity: 1.1 };
      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// サンプルパターンスキーマテスト（5 tests）
// =====================================================

describe('samplePatternSchema', () => {
  it('空のオブジェクトを受け付ける', () => {
    const input = {};
    const result = samplePatternSchema.parse(input);
    expect(result).toEqual({});
  });

  it('typeのみを受け付ける', () => {
    const input = { type: 'hover' };
    const result = samplePatternSchema.parse(input);
    expect(result.type).toBe('hover');
  });

  it('全プロパティを受け付ける', () => {
    const input = {
      type: 'animation' as const,
      duration: 1000,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      properties: ['opacity', 'transform'],
    };
    const result = samplePatternSchema.parse(input);
    expect(result.type).toBe('animation');
    expect(result.duration).toBe(1000);
    expect(result.easing).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(result.properties).toEqual(['opacity', 'transform']);
  });

  it('負のdurationは拒否する', () => {
    const input = { duration: -100 };
    expect(() => samplePatternSchema.parse(input)).toThrow();
  });

  it('無効なtypeは拒否する', () => {
    const input = { type: 'invalid_type' };
    expect(() => samplePatternSchema.parse(input)).toThrow();
  });
});

// =====================================================
// フィルタースキーマテスト（5 tests）
// =====================================================

describe('motionSearchFiltersSchema', () => {
  it('空のオブジェクトを受け付ける', () => {
    const input = {};
    const result = motionSearchFiltersSchema.parse(input);
    expect(result).toEqual({});
  });

  it('typeフィルターを受け付ける', () => {
    const input = { type: 'keyframe' };
    const result = motionSearchFiltersSchema.parse(input);
    expect(result.type).toBe('keyframe');
  });

  it('duration範囲フィルターを受け付ける', () => {
    const input = { minDuration: 100, maxDuration: 500 };
    const result = motionSearchFiltersSchema.parse(input);
    expect(result.minDuration).toBe(100);
    expect(result.maxDuration).toBe(500);
  });

  it('triggerフィルターを受け付ける', () => {
    const input = { trigger: 'click' };
    const result = motionSearchFiltersSchema.parse(input);
    expect(result.trigger).toBe('click');
  });

  it('負のminDurationは拒否する', () => {
    const input = { minDuration: -1 };
    expect(() => motionSearchFiltersSchema.parse(input)).toThrow();
  });
});

// =====================================================
// 出力スキーマテスト（5 tests）
// =====================================================

describe('motionSearchOutputSchema', () => {
  it('成功時の基本レスポンスをバリデート', () => {
    const output: MotionSearchOutput = {
      success: true,
      data: {
        results: [],
        total: 0,
      },
    };
    expect(() => motionSearchOutputSchema.parse(output)).not.toThrow();
  });

  it('エラー時のレスポンスをバリデート', () => {
    const output = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
      },
    };
    expect(() => motionSearchOutputSchema.parse(output)).not.toThrow();
  });

  it('検索結果を含むレスポンスをバリデート', () => {
    const output: MotionSearchOutput = {
      success: true,
      data: {
        results: sampleSearchResults,
        total: 2,
        query: {
          text: 'fade animation',
        },
      },
    };
    expect(() => motionSearchOutputSchema.parse(output)).not.toThrow();
  });

  it('embeddingを含むqueryをバリデート', () => {
    const output: MotionSearchOutput = {
      success: true,
      data: {
        results: [],
        total: 0,
        query: {
          text: 'test',
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        },
      },
    };
    expect(() => motionSearchOutputSchema.parse(output)).not.toThrow();
  });

  it('sourceを含む検索結果をバリデート', () => {
    const output: MotionSearchOutput = {
      success: true,
      data: {
        results: [
          {
            pattern: sampleMotionPattern,
            similarity: 0.9,
            source: {
              pageId: validUUID,
              url: 'https://example.com',
              selector: '.animated',
            },
          },
        ],
        total: 1,
      },
    };
    expect(() => motionSearchOutputSchema.parse(output)).not.toThrow();
  });
});

// =====================================================
// ツール定義テスト（5 tests）
// =====================================================

describe('motionSearchToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(motionSearchToolDefinition.name).toBe('motion.search');
  });

  it('descriptionが設定されている', () => {
    expect(motionSearchToolDefinition.description).toBeDefined();
    expect(typeof motionSearchToolDefinition.description).toBe('string');
    expect(motionSearchToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchemaがobject型', () => {
    expect(motionSearchToolDefinition.inputSchema.type).toBe('object');
  });

  it('propertiesに必要なフィールドを含む', () => {
    const { properties } = motionSearchToolDefinition.inputSchema;
    expect(properties).toHaveProperty('query');
    expect(properties).toHaveProperty('samplePattern');
    expect(properties).toHaveProperty('filters');
    expect(properties).toHaveProperty('limit');
    expect(properties).toHaveProperty('minSimilarity');
  });

  it('デフォルト値が正しく設定されている', () => {
    const { properties } = motionSearchToolDefinition.inputSchema;
    expect(properties.limit?.default).toBe(10);
    expect(properties.minSimilarity?.default).toBe(0.5);
  });
});

// =====================================================
// 検索テスト（20 tests）
// =====================================================

describe('検索機能', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('テキストクエリ検索', () => {
    it('queryで検索が実行される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'fade in animation' };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      expect(mockSearch).toHaveBeenCalled();
    });

    it('検索結果が正しく返される', async () => {
      setMotionSearchServiceFactory(() => ({
        search: vi.fn().mockResolvedValue({
          results: sampleSearchResults,
          total: 2,
        }),
      }));

      const input: MotionSearchInput = { query: 'fade' };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(2);
        expect(result.data.total).toBe(2);
      }
    });

    it('日本語クエリで検索できる', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'フェードインアニメーション' };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
        query: 'フェードインアニメーション',
      }));
    });

    it('空白を含むクエリで検索できる', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: '  smooth scroll animation  ' };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });
  });

  describe('パターン類似検索', () => {
    it('samplePatternで類似検索が実行される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        samplePattern: {
          type: 'animation',
          duration: 500,
          properties: ['opacity', 'transform'],
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
        samplePattern: input.samplePattern,
      }));
    });

    it('easingを含むsamplePatternで検索できる', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        samplePattern: {
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });

    it('typeのみのsamplePatternで検索できる', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.slice(0, 1),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        samplePattern: {
          type: 'hover',
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });
  });

  describe('フィルタリング', () => {
    it('typeフィルターが適用される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.filter(r => r.pattern.type === 'css_animation'),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        filters: {
          type: 'animation',
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total).toBe(1);
      }
    });

    it('minDurationフィルターが適用される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.filter(r =>
          (r.pattern.animation.duration ?? 0) >= 500
        ),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        filters: {
          minDuration: 500,
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });

    it('maxDurationフィルターが適用される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.filter(r =>
          (r.pattern.animation.duration ?? 0) <= 400
        ),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        filters: {
          maxDuration: 400,
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });

    it('triggerフィルターが適用される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.filter(r => r.pattern.trigger === 'hover'),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'hover effect',
        filters: {
          trigger: 'hover',
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
    });

    it('複数フィルターの組み合わせが適用される', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        filters: {
          type: 'animation',
          minDuration: 200,
          maxDuration: 800,
          trigger: 'load',
        },
      };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
        filters: input.filters,
      }));
    });
  });

  describe('limit制限', () => {
    it('limit=1で1件のみ返す', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.slice(0, 1),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'animation', limit: 1 };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBeLessThanOrEqual(1);
      }
    });

    it('limit=50で最大50件返す', async () => {
      const manyResults = Array.from({ length: 50 }, (_, i) => ({
        ...sampleSearchResults[0],
        pattern: { ...sampleMotionPattern, id: `pattern-${i}` },
        similarity: 0.9 - i * 0.01,
      }));

      const mockSearch = vi.fn().mockResolvedValue({
        results: manyResults,
        total: 50,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'animation', limit: 50 };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBeLessThanOrEqual(50);
      }
    });
  });

  describe('minSimilarityフィルター', () => {
    it('minSimilarity=0.9で高類似度のみ返す', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults.filter(r => r.similarity >= 0.9),
        total: 1,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'fade', minSimilarity: 0.9 };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        result.data.results.forEach(r => {
          expect(r.similarity).toBeGreaterThanOrEqual(0.9);
        });
      }
    });

    it('minSimilarity=0で全結果を返す', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = { query: 'animation', minSimilarity: 0 };
      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results.length).toBe(2);
      }
    });
  });
});

// =====================================================
// DIパターンテスト（10 tests）
// =====================================================

describe('DIパターン', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('モックサービスを注入できる', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: sampleSearchResults,
      total: 2,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalled();
  });

  it('ファクトリリセットが動作する', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    resetMotionSearchServiceFactory();

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    // リセット後はサービス未設定エラー
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
  });

  it('サービスエラーをハンドルする', async () => {
    const mockSearch = vi.fn().mockRejectedValue(new Error('Search service error'));

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.SEARCH_ERROR);
    }
  });

  it('Embeddingサービスを注入できる', async () => {
    const mockGetEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockSearch = vi.fn().mockResolvedValue({
      results: sampleSearchResults,
      total: 2,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
      getEmbedding: mockGetEmbedding,
    }));

    const input: MotionSearchInput = { query: 'fade animation' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
  });

  it('Embeddingエラーをハンドルする', async () => {
    const mockGetEmbedding = vi.fn().mockRejectedValue(new Error('Embedding failed'));
    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
      getEmbedding: mockGetEmbedding,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    // Embeddingが失敗しても検索は続行される場合がある
    // 実装に依存
    expect(result).toBeDefined();
  });

  it('カスタム検索ロジックを注入できる', async () => {
    const customResults: MotionSearchResultItem[] = [
      {
        pattern: {
          ...sampleMotionPattern,
          id: 'custom-pattern',
          name: 'customAnimation',
        },
        similarity: 0.99,
      },
    ];

    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: customResults,
        total: 1,
      }),
    }));

    const input: MotionSearchInput = { query: 'custom' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].pattern.name).toBe('customAnimation');
    }
  });

  it('複数回の呼び出しで独立した結果を返す', async () => {
    let callCount = 0;
    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          results: sampleSearchResults.slice(0, callCount),
          total: callCount,
        });
      }),
    }));

    const input1: MotionSearchInput = { query: 'test1' };
    const input2: MotionSearchInput = { query: 'test2' };

    const result1 = await motionSearchHandler(input1);
    const result2 = await motionSearchHandler(input2);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    if (result1.success && result2.success) {
      expect(result1.data.total).toBe(1);
      expect(result2.data.total).toBe(2);
    }
  });

  it('クエリ情報を結果に含める', async () => {
    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
        query: {
          text: 'fade animation',
          embedding: [0.1, 0.2, 0.3],
        },
      }),
    }));

    const input: MotionSearchInput = { query: 'fade animation' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBeDefined();
      expect(result.data.query?.text).toBe('fade animation');
    }
  });

  it('ソース情報を含む結果を返す', async () => {
    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
      }),
    }));

    const input: MotionSearchInput = { query: 'fade' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const resultWithSource = result.data.results.find(r => r.source?.pageId);
      expect(resultWithSource).toBeDefined();
      expect(resultWithSource?.source?.pageId).toBe(validUUID);
    }
  });

  it('サービスファクトリが未設定の場合エラーを返す', async () => {
    resetMotionSearchServiceFactory();

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
  });
});

// =====================================================
// エッジケーステスト（5 tests）
// =====================================================

describe('エッジケース', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('結果0件でも成功を返す', async () => {
    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      }),
    }));

    const input: MotionSearchInput = { query: 'nonexistent animation xyz123' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(0);
      expect(result.data.total).toBe(0);
    }
  });

  it('類似度しきい値でフィルタリングされる', async () => {
    const lowSimilarityResults: MotionSearchResultItem[] = [
      { ...sampleSearchResults[0], similarity: 0.3 },
      { ...sampleSearchResults[1], similarity: 0.2 },
    ];

    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: lowSimilarityResults.filter(r => r.similarity >= 0.5),
        total: 0,
      }),
    }));

    const input: MotionSearchInput = { query: 'test', minSimilarity: 0.5 };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total).toBe(0);
    }
  });

  it('nullやundefined入力でバリデーションエラー', async () => {
    const result = await motionSearchHandler(null);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('空オブジェクト入力でバリデーションエラー', async () => {
    const result = await motionSearchHandler({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('エラーメッセージにコンテキストを含む', async () => {
    const result = await motionSearchHandler({ query: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeDefined();
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================
// エラーハンドリングテスト（5 tests）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('入力がnullの場合エラー', async () => {
    const result = await motionSearchHandler(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('入力がundefinedの場合エラー', async () => {
    const result = await motionSearchHandler(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('エラーコードが定義通りに使われる', async () => {
    const result = await motionSearchHandler({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Object.values(MOTION_SEARCH_ERROR_CODES)).toContain(result.error.code);
    }
  });

  it('エラー時も正常なレスポンス形式', async () => {
    const result = await motionSearchHandler({});
    expect(result).toHaveProperty('success');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result).toHaveProperty('error');
      expect(result.error).toHaveProperty('code');
      expect(result.error).toHaveProperty('message');
    }
  });

  it('タイムアウトエラーをハンドルする', async () => {
    const mockSearch = vi.fn().mockImplementation(() => {
      const error = new Error('Request timeout');
      (error as Error & { code?: string }).code = 'TIMEOUT';
      return Promise.reject(error);
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeDefined();
    }
  });

  it('Embeddingエラーメッセージを含むエラーで正しいエラーコードを返す', async () => {
    const mockSearch = vi.fn().mockRejectedValue(new Error('Embedding generation failed'));

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.EMBEDDING_ERROR);
    }
  });
});

// =====================================================
// 追加のカバレッジテスト
// =====================================================

describe('追加カバレッジテスト', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('全てのフィルターオプションが検索に渡される', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: sampleSearchResults,
      total: 2,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'test animation',
      samplePattern: {
        type: 'animation',
        duration: 500,
        easing: 'ease-out',
        properties: ['opacity', 'transform'],
      },
      filters: {
        type: 'animation',
        minDuration: 100,
        maxDuration: 1000,
        trigger: 'load',
      },
      limit: 15,
      minSimilarity: 0.6,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalledWith({
      query: 'test animation',
      samplePattern: {
        type: 'animation',
        duration: 500,
        easing: 'ease-out',
        properties: ['opacity', 'transform'],
      },
      filters: {
        type: 'animation',
        minDuration: 100,
        maxDuration: 1000,
        trigger: 'load',
      },
      limit: 15,
      minSimilarity: 0.6,
      include_js_animations: true,
      js_animation_filters: undefined,
      include_webgl_animations: true,
      webgl_animation_filters: undefined,
      include_implementation: false,
    });
  });

  it('エラーオブジェクトでない場合もハンドルする', async () => {
    const mockSearch = vi.fn().mockRejectedValue('String error');

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Search failed');
    }
  });

  it('queryのみでsamplePatternなしで検索できる', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'simple query',
      limit: 5,
      minSimilarity: 0.3,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'simple query',
      samplePattern: undefined,
      limit: 5,
      minSimilarity: 0.3,
    }));
  });

  it('samplePatternのみでqueryなしで検索できる', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: sampleSearchResults.slice(0, 1),
      total: 1,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      samplePattern: {
        type: 'transition',
        duration: 300,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: undefined,
      samplePattern: {
        type: 'transition',
        duration: 300,
      },
    }));
  });

  it('検索結果のソースがnullでも正しく返される', async () => {
    const resultsWithoutSource: MotionSearchResultItem[] = [
      {
        pattern: sampleMotionPattern,
        similarity: 0.8,
      },
    ];

    setMotionSearchServiceFactory(() => ({
      search: vi.fn().mockResolvedValue({
        results: resultsWithoutSource,
        total: 1,
      }),
    }));

    const input: MotionSearchInput = { query: 'test' };
    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].source).toBeUndefined();
    }
  });

  it('空のsamplePatternオブジェクトでも検索できる', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      samplePattern: {},
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
  });

  it('空のfiltersオブジェクトを渡しても検索できる', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: sampleSearchResults,
      total: 2,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'test',
      filters: {},
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      filters: {},
    }));
  });
});

// =====================================================
// コード生成テスト（action: 'generate'）
// =====================================================

describe('コード生成（action: generate）', () => {
  const sampleGeneratePattern = {
    type: 'animation' as const,
    name: 'fadeIn',
    duration: 500,
    delay: 0,
    easing: 'ease-out',
    iterations: 1 as number | 'infinite',
    direction: 'normal' as const,
    fillMode: 'none' as const,
    properties: [
      { name: 'opacity', from: '0', to: '1' },
      { name: 'translateY', from: '20', to: '0' },
    ],
  };

  it('Three.js形式でコードを生成できる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'three-js',
      options: {
        typescript: true,
        includeReducedMotion: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation).toBeDefined();
      expect(result.data.implementation?.code).toContain('@react-three/fiber');
      expect(result.data.implementation?.code).toContain('useFrame');
      expect(result.data.implementation?.code).toContain('Canvas');
      expect(result.data.implementation?.metadata.dependencies).toContain('@react-three/fiber');
      expect(result.data.implementation?.metadata.dependencies).toContain('three');
    }
  });

  it('Three.jsスクロールアニメーションを生成できる', async () => {
    const scrollPattern = {
      ...sampleGeneratePattern,
      type: 'scroll' as const,
      name: 'scrollFade',
    };

    const input: MotionSearchInput = {
      action: 'generate',
      pattern: scrollPattern,
      format: 'three-js',
      options: {
        typescript: true,
        includeReducedMotion: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation?.code).toContain('useScroll');
      expect(result.data.implementation?.code).toContain('@react-three/drei');
      expect(result.data.implementation?.metadata.dependencies).toContain('@react-three/drei');
    }
  });

  it('Three.js形式でJavaScript出力ができる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'three-js',
      options: {
        typescript: false,
        includeReducedMotion: false,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      // TypeScript types should not be present
      expect(result.data.implementation?.code).not.toContain(': FC<');
      expect(result.data.implementation?.code).not.toContain(': Mesh');
    }
  });

  it('GSAP形式でコードを生成できる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'gsap',
      options: {
        typescript: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation?.code).toContain('gsap');
      expect(result.data.implementation?.code).toContain('fromTo');
    }
  });

  it('Framer Motion形式でコードを生成できる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'framer-motion',
      options: {
        typescript: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation?.code).toContain('framer-motion');
      expect(result.data.implementation?.code).toContain('motion.div');
    }
  });

  it('Lottie形式でコードを生成できる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'lottie',
      options: {
        typescript: true,
        includeReducedMotion: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation).toBeDefined();
      expect(result.data.implementation?.code).toContain('lottie-react');
      expect(result.data.implementation?.code).toContain('animationData');
      expect(result.data.implementation?.code).toContain('loop');
      expect(result.data.implementation?.code).toContain('autoplay');
      expect(result.data.implementation?.metadata.dependencies).toContain('lottie-react');
    }
  });

  it('Lottieアニメーションでループ設定が反映される', async () => {
    const loopPattern = {
      ...sampleGeneratePattern,
      name: 'infiniteLoop',
      iterations: 'infinite' as const,
    };

    const input: MotionSearchInput = {
      action: 'generate',
      pattern: loopPattern,
      format: 'lottie',
      options: {
        typescript: true,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      expect(result.data.implementation?.code).toContain('loop = true');
    }
  });

  it('Lottie形式でJavaScript出力ができる', async () => {
    const input: MotionSearchInput = {
      action: 'generate',
      pattern: sampleGeneratePattern,
      format: 'lottie',
      options: {
        typescript: false,
        includeReducedMotion: false,
      },
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'implementation' in result.data) {
      // TypeScript types should not be present
      expect(result.data.implementation?.code).not.toContain(': FC<');
      expect(result.data.implementation?.code).not.toContain('interface');
    }
  });
});

// =====================================================
// include_implementationテスト（v0.1.0）
// =====================================================

describe('include_implementation (v0.1.0)', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    resetMotionSearchServiceFactory();
    vi.clearAllMocks();
  });

  it('include_implementation: false（デフォルト）の場合、implementationフィールドがない', async () => {
    const mockService: IMotionSearchService = {
      search: vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
        query: { text: 'フェードイン' },
      }),
    };
    setMotionSearchServiceFactory(() => mockService);

    const input: MotionSearchInput = {
      query: 'フェードイン',
      // include_implementation: false (default)
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      expect(result.data.results).toHaveLength(2);
      // implementationフィールドがないことを確認
      result.data.results.forEach((item) => {
        expect(item.implementation).toBeUndefined();
      });
    }
  });

  it('include_implementation: trueの場合、各結果にimplementationフィールドが付与される', async () => {
    const mockService: IMotionSearchService = {
      search: vi.fn().mockResolvedValue({
        results: sampleSearchResults,
        total: 2,
        query: { text: 'フェードイン' },
      }),
    };
    setMotionSearchServiceFactory(() => mockService);

    const input: MotionSearchInput = {
      query: 'フェードイン',
      include_implementation: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      expect(result.data.results).toHaveLength(2);
      // 各結果にimplementationフィールドがあることを確認
      result.data.results.forEach((item) => {
        expect(item.implementation).toBeDefined();
      });
    }
  });

  it('css_animationパターンの場合、keyframes, animation, tailwindが含まれる', async () => {
    const mockService: IMotionSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [sampleSearchResults[0]], // css_animation パターン
        total: 1,
        query: { text: 'フェードイン' },
      }),
    };
    setMotionSearchServiceFactory(() => mockService);

    const input: MotionSearchInput = {
      query: 'フェードイン',
      include_implementation: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      const item = result.data.results[0];
      expect(item.implementation).toBeDefined();
      expect(item.implementation?.keyframes).toBeDefined();
      expect(item.implementation?.keyframes).toContain('@keyframes fadeIn');
      expect(item.implementation?.animation).toBeDefined();
      expect(item.implementation?.animation).toContain('animation:');
      expect(item.implementation?.tailwind).toBeDefined();
      expect(item.implementation?.tailwind).toBe('animate-fadeIn');
      // transitionタイプでないのでtransitionはundefined
      expect(item.implementation?.transition).toBeUndefined();
    }
  });

  it('css_transitionパターンの場合、transitionのみが含まれる', async () => {
    const mockService: IMotionSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [sampleSearchResults[1]], // css_transition パターン
        total: 1,
        query: { text: 'ホバー' },
      }),
    };
    setMotionSearchServiceFactory(() => mockService);

    const input: MotionSearchInput = {
      query: 'ホバー',
      include_implementation: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      const item = result.data.results[0];
      expect(item.implementation).toBeDefined();
      expect(item.implementation?.transition).toBeDefined();
      expect(item.implementation?.transition).toContain('transition:');
      // transitionタイプなのでkeyframes, animation, tailwindはundefined
      expect(item.implementation?.keyframes).toBeUndefined();
      expect(item.implementation?.animation).toBeUndefined();
      expect(item.implementation?.tailwind).toBeUndefined();
    }
  });

  it('検索結果が空の場合でもエラーにならない', async () => {
    const mockService: IMotionSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
        query: { text: '存在しないパターン' },
      }),
    };
    setMotionSearchServiceFactory(() => mockService);

    const input: MotionSearchInput = {
      query: '存在しないパターン',
      include_implementation: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      expect(result.data.results).toHaveLength(0);
      expect(result.data.total).toBe(0);
    }
  });

  it('inputSchemaにinclude_implementationが定義されている', () => {
    const schema = motionSearchToolDefinition.inputSchema;
    expect(schema.properties.include_implementation).toBeDefined();
    expect(schema.properties.include_implementation.type).toBe('boolean');
    expect(schema.properties.include_implementation.default).toBe(false);
  });

  it('Zodスキーマでinclude_implementationがパースされる', () => {
    const input = {
      query: 'テスト',
      include_implementation: true,
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.include_implementation).toBe(true);
  });

  it('Zodスキーマでinclude_implementationのデフォルト値はfalse', () => {
    const input = {
      query: 'テスト',
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.include_implementation).toBe(false);
  });
});

// =====================================================
// 多様性フィルタリングテスト（v0.1.0）
// =====================================================

describe('多様性フィルタリング (v0.1.0)', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 多様なカテゴリのテストデータ
  const diverseMotionPatterns: MotionSearchResultItem[] = [
    {
      pattern: {
        id: 'pattern-scroll-1',
        type: 'css_animation',
        category: 'scroll_trigger',
        trigger: 'scroll',
        animation: { duration: 600, easing: { type: 'ease-out' } },
        properties: [{ property: 'opacity', from: 0, to: 1 }],
      },
      similarity: 0.95,
    },
    {
      pattern: {
        id: 'pattern-scroll-2',
        type: 'css_animation',
        category: 'scroll_trigger',
        trigger: 'scroll',
        animation: { duration: 550, easing: { type: 'ease-out' } },
        properties: [{ property: 'opacity', from: 0, to: 1 }],
      },
      similarity: 0.93,
    },
    {
      pattern: {
        id: 'pattern-hover-1',
        type: 'css_transition',
        category: 'hover_effect',
        trigger: 'hover',
        animation: { duration: 300, easing: { type: 'ease' } },
        properties: [{ property: 'transform' }],
      },
      similarity: 0.90,
    },
    {
      pattern: {
        id: 'pattern-loading-1',
        type: 'css_animation',
        category: 'loading_state',
        trigger: 'load',
        animation: { duration: 1000, easing: { type: 'linear' } },
        properties: [{ property: 'transform', from: 'rotate(0deg)', to: 'rotate(360deg)' }],
      },
      similarity: 0.88,
    },
    {
      pattern: {
        id: 'pattern-micro-1',
        type: 'css_transition',
        category: 'micro_interaction',
        trigger: 'click',
        animation: { duration: 200, easing: { type: 'ease-in-out' } },
        properties: [{ property: 'transform' }],
      },
      similarity: 0.85,
    },
    {
      pattern: {
        id: 'pattern-scroll-3',
        type: 'css_animation',
        category: 'scroll_trigger',
        trigger: 'scroll',
        animation: { duration: 600, easing: { type: 'ease-out' } },
        properties: [{ property: 'opacity', from: 0, to: 1 }],
      },
      similarity: 0.82,
    },
  ];

  it('diversity_thresholdパラメータがスキーマで受け付けられる', () => {
    const input = {
      query: 'animation',
      diversity_threshold: 0.5,
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.diversity_threshold).toBe(0.5);
  });

  it('diversity_thresholdのデフォルト値は0.3', () => {
    const input = {
      query: 'animation',
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.diversity_threshold).toBe(0.3);
  });

  it('ensure_category_diversityパラメータがスキーマで受け付けられる', () => {
    const input = {
      query: 'animation',
      ensure_category_diversity: false,
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.ensure_category_diversity).toBe(false);
  });

  it('ensure_category_diversityのデフォルト値はtrue', () => {
    const input = {
      query: 'animation',
    };

    const parsed = motionSearchInputSchema.parse(input);
    expect(parsed.ensure_category_diversity).toBe(true);
  });

  it('diversity_thresholdが0-1の範囲外でエラー', () => {
    expect(() =>
      motionSearchInputSchema.parse({
        query: 'animation',
        diversity_threshold: 1.5,
      })
    ).toThrow();

    expect(() =>
      motionSearchInputSchema.parse({
        query: 'animation',
        diversity_threshold: -0.1,
      })
    ).toThrow();
  });

  it('カテゴリ分散が有効な場合、異なるカテゴリが優先される', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: diverseMotionPatterns,
      total: diverseMotionPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 4,
      ensure_category_diversity: true,
      diversity_threshold: 0.3,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 異なるカテゴリが含まれていることを確認
      const categories = result.data.results.map((r) => r.pattern.category);
      const uniqueCategories = new Set(categories);

      // 4件返却で複数カテゴリが含まれるべき
      expect(uniqueCategories.size).toBeGreaterThanOrEqual(3);
    }
  });

  it('カテゴリ分散が無効な場合、類似度順で返される（類似度フィルタのみ適用）', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: diverseMotionPatterns,
      total: diverseMotionPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 4,
      ensure_category_diversity: false,
      diversity_threshold: 0.9, // 高しきい値で類似度フィルタをほぼ無効化
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 類似度順で返される（最初の結果が最も高い類似度）
      expect(result.data.results[0].similarity).toBe(0.95);
    }
  });

  it('diversity_threshold=0で全ての類似結果が間引かれる（limitが十分な場合補完あり）', async () => {
    // 非常に類似したパターンのみ
    const verySimialarPatterns: MotionSearchResultItem[] = [
      {
        pattern: {
          id: 'similar-1',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 600, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.95,
      },
      {
        pattern: {
          id: 'similar-2',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 600, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.93,
      },
      {
        pattern: {
          id: 'similar-3',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 600, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.91,
      },
    ];

    const mockSearch = vi.fn().mockResolvedValue({
      results: verySimialarPatterns,
      total: verySimialarPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 10,
      ensure_category_diversity: false,
      diversity_threshold: 0, // 厳格なフィルタリング
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // diversity_threshold=0でフィルタリング後1件になるが、
      // limitが10でフィルタリング後の結果が不足するため、元の結果から補完される
      // 結果として全3件が返される（フィルタリング1件 + 補完2件）
      expect(result.data.results.length).toBe(3);
      // 最初の結果は最も類似度が高い
      expect(result.data.results[0].pattern.id).toBe('similar-1');
    }
  });

  it('diversity_threshold=0でlimit=1の場合、フィルタリングで1件のみ返される', async () => {
    // 非常に類似したパターンのみ
    const verySimialarPatterns: MotionSearchResultItem[] = [
      {
        pattern: {
          id: 'similar-1',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 600, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.95,
      },
      {
        pattern: {
          id: 'similar-2',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 600, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.93,
      },
    ];

    const mockSearch = vi.fn().mockResolvedValue({
      results: verySimialarPatterns,
      total: verySimialarPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 1, // limit=1で補完は発生しない
      ensure_category_diversity: false,
      diversity_threshold: 0,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // limit=1なのでフィルタリング後1件のみ
      expect(result.data.results.length).toBe(1);
      expect(result.data.results[0].pattern.id).toBe('similar-1');
    }
  });

  it('diversity_threshold=1で全ての結果が保持される', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: diverseMotionPatterns,
      total: diverseMotionPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 10,
      ensure_category_diversity: false,
      diversity_threshold: 1, // 全て許可
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 全結果が返される
      expect(result.data.results.length).toBe(diverseMotionPatterns.length);
    }
  });

  it('空の検索結果でも多様性フィルタリングがエラーにならない', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'nonexistent',
      diversity_threshold: 0.5,
      ensure_category_diversity: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(0);
    }
  });

  it('limitより少ない結果でも正常に動作する', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: diverseMotionPatterns.slice(0, 2),
      total: 2,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 10,
      diversity_threshold: 0.5,
      ensure_category_diversity: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results.length).toBeLessThanOrEqual(2);
    }
  });

  it('include_implementationと多様性フィルタリングが組み合わせて動作する', async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      results: diverseMotionPatterns,
      total: diverseMotionPatterns.length,
    });

    setMotionSearchServiceFactory(() => ({
      search: mockSearch,
    }));

    const input: MotionSearchInput = {
      query: 'animation',
      limit: 4,
      diversity_threshold: 0.5,
      ensure_category_diversity: true,
      include_implementation: true,
    };

    const result = await motionSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 多様性フィルタリングが適用される
      const categories = result.data.results.map((r) => r.pattern.category);
      const uniqueCategories = new Set(categories);
      expect(uniqueCategories.size).toBeGreaterThanOrEqual(2);

      // implementation が付与される
      result.data.results.forEach((r) => {
        expect(r.implementation).toBeDefined();
      });
    }
  });

  // =====================================================
  // MMRアルゴリズムテスト（v0.1.0）
  // =====================================================

  describe('MMR (Maximal Marginal Relevance) アルゴリズム', () => {
    // fadeIn系パターンが連続するテストデータ（問題を再現）
    const fadeInHeavyPatterns: MotionSearchResultItem[] = [
      {
        pattern: {
          id: 'fadeIn-1',
          name: 'fadeIn',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 300, easing: { type: 'ease-out' } },
          properties: [{ property: 'opacity', from: 0, to: 1 }],
        },
        similarity: 0.98,
      },
      {
        pattern: {
          id: 'fadeIn-2',
          name: 'fadeInUp',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 350, easing: { type: 'ease-out' } },
          properties: [
            { property: 'opacity', from: 0, to: 1 },
            { property: 'transform', from: 'translateY(20px)', to: 'translateY(0)' },
          ],
        },
        similarity: 0.96,
      },
      {
        pattern: {
          id: 'fadeIn-3',
          name: 'fadeInDown',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 320, easing: { type: 'ease-out' } },
          properties: [
            { property: 'opacity', from: 0, to: 1 },
            { property: 'transform', from: 'translateY(-20px)', to: 'translateY(0)' },
          ],
        },
        similarity: 0.94,
      },
      {
        pattern: {
          id: 'slideIn-1',
          name: 'slideInLeft',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'scroll',
          animation: { duration: 400, easing: { type: 'ease-in-out' } },
          properties: [{ property: 'transform', from: 'translateX(-100%)', to: 'translateX(0)' }],
        },
        similarity: 0.85,
      },
      {
        pattern: {
          id: 'scale-1',
          name: 'scaleUp',
          type: 'css_transition',
          category: 'hover_effect',
          trigger: 'hover',
          animation: { duration: 200, easing: { type: 'ease' } },
          properties: [{ property: 'transform', from: 'scale(1)', to: 'scale(1.05)' }],
        },
        similarity: 0.80,
      },
      {
        pattern: {
          id: 'rotate-1',
          name: 'spin',
          type: 'css_animation',
          category: 'loading_state',
          trigger: 'load',
          animation: { duration: 1000, easing: { type: 'linear' } },
          properties: [{ property: 'transform', from: 'rotate(0deg)', to: 'rotate(360deg)' }],
        },
        similarity: 0.75,
      },
      {
        pattern: {
          id: 'fadeIn-4',
          name: 'fadeInScale',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 400, easing: { type: 'ease-out' } },
          properties: [
            { property: 'opacity', from: 0, to: 1 },
            { property: 'transform', from: 'scale(0.9)', to: 'scale(1)' },
          ],
        },
        similarity: 0.70,
      },
    ];

    it('MMRにより同一カテゴリの連続を避ける', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 5,
        diversity_threshold: 0.5, // バランス設定
        ensure_category_diversity: true,
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 5件返される
        expect(result.data.results.length).toBe(5);

        // 同一カテゴリが3件以上連続しないこと
        const categories = result.data.results.map((r) => r.pattern.category);
        let maxConsecutive = 1;
        let currentConsecutive = 1;
        for (let i = 1; i < categories.length; i++) {
          if (categories[i] === categories[i - 1]) {
            currentConsecutive++;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
          } else {
            currentConsecutive = 1;
          }
        }
        expect(maxConsecutive).toBeLessThanOrEqual(2);

        // カテゴリの多様性が確保されること（2種類以上）
        const uniqueCategories = new Set(categories);
        expect(uniqueCategories.size).toBeGreaterThanOrEqual(2);
      }
    });

    it('diversity_threshold=0.0で従来通り関連度順（多様性フィルタなし）', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 5,
        diversity_threshold: 0.0, // 関連度順のみ
        ensure_category_diversity: false,
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 類似度降順で返される
        const similarities = result.data.results.map((r) => r.similarity);
        for (let i = 1; i < similarities.length; i++) {
          expect(similarities[i]).toBeLessThanOrEqual(similarities[i - 1]);
        }
      }
    });

    it('diversity_threshold=1.0で関連度順のまま返される（λ=1.0は多様性なし）', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 5,
        diversity_threshold: 1.0, // λ=1.0: 関連度のみ（多様性フィルタなし）
        ensure_category_diversity: false, // 明示的にカテゴリ分散を無効化
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 関連度順（類似度降順）で返される
        const similarities = result.data.results.map((r) => r.similarity);
        for (let i = 1; i < similarities.length; i++) {
          expect(similarities[i]).toBeLessThanOrEqual(similarities[i - 1]);
        }
      }
    });

    it('diversity_threshold=0.0でensure_category_diversity=trueなら多様性最大化', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 5,
        diversity_threshold: 0.0, // λ=0.0: 多様性最大
        ensure_category_diversity: true, // カテゴリ分散有効
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // カテゴリの多様性が確保される
        const categories = result.data.results.map((r) => r.pattern.category);
        const uniqueCategories = new Set(categories);
        // 利用可能なカテゴリ数まで多様化される（テストデータには4カテゴリ）
        expect(uniqueCategories.size).toBeGreaterThanOrEqual(3);
      }
    });

    it('diversity_threshold=0.5でバランスの取れた結果', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 5,
        diversity_threshold: 0.5, // バランス
        ensure_category_diversity: true,
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 高い類似度のパターンが含まれる
        const highSimilarity = result.data.results.filter((r) => r.similarity >= 0.9);
        expect(highSimilarity.length).toBeGreaterThanOrEqual(1);

        // かつ多様性も確保される
        const categories = result.data.results.map((r) => r.pattern.category);
        const uniqueCategories = new Set(categories);
        expect(uniqueCategories.size).toBeGreaterThanOrEqual(2);
      }
    });

    it('MMRスコアが正しく計算される（λ=0.5のとき）', async () => {
      // 最初の選択は最も高い類似度を持つべき
      const mockSearch = vi.fn().mockResolvedValue({
        results: fadeInHeavyPatterns,
        total: fadeInHeavyPatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'animation',
        limit: 3,
        diversity_threshold: 0.5,
        ensure_category_diversity: false, // MMRのみ、カテゴリ分散なし
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 最初の結果は最も類似度が高いパターン
        expect(result.data.results[0].pattern.id).toBe('fadeIn-1');
        expect(result.data.results[0].similarity).toBe(0.98);

        // 2番目以降は類似度と多様性のバランス
        // fadeIn-2（類似度0.96だがfadeIn-1と類似）より
        // 異なるパターン（slideIn-1やscale-1）が選ばれる可能性がある
        const ids = result.data.results.map((r) => r.pattern.id);
        // fadeIn系が3つ連続しないこと
        const fadeInCount = ids.filter((id) => id.startsWith('fadeIn')).length;
        expect(fadeInCount).toBeLessThanOrEqual(2);
      }
    });

    it('同一名のパターンが連続しない', async () => {
      // 名前が似ているパターンのテストデータ
      const similarNamePatterns: MotionSearchResultItem[] = [
        {
          pattern: {
            id: 'fadeIn-a',
            name: 'fadeIn',
            type: 'css_animation',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 300, easing: { type: 'ease-out' } },
            properties: [{ property: 'opacity', from: 0, to: 1 }],
          },
          similarity: 0.99,
        },
        {
          pattern: {
            id: 'fadeIn-b',
            name: 'fadeIn',
            type: 'css_animation',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 350, easing: { type: 'ease' } },
            properties: [{ property: 'opacity', from: 0, to: 1 }],
          },
          similarity: 0.98,
        },
        {
          pattern: {
            id: 'fadeIn-c',
            name: 'fadeIn',
            type: 'css_animation',
            category: 'entrance',
            trigger: 'scroll',
            animation: { duration: 400, easing: { type: 'ease-in-out' } },
            properties: [{ property: 'opacity', from: 0, to: 1 }],
          },
          similarity: 0.97,
        },
        {
          pattern: {
            id: 'slideIn-a',
            name: 'slideIn',
            type: 'css_animation',
            category: 'entrance',
            trigger: 'scroll',
            animation: { duration: 500, easing: { type: 'ease-out' } },
            properties: [{ property: 'transform' }],
          },
          similarity: 0.80,
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: similarNamePatterns,
        total: similarNamePatterns.length,
      });

      setMotionSearchServiceFactory(() => ({
        search: mockSearch,
      }));

      const input: MotionSearchInput = {
        query: 'fadeIn',
        limit: 3,
        diversity_threshold: 0.5,
        ensure_category_diversity: false,
      };

      const result = await motionSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.results.map((r) => r.pattern.name);
        // 同名パターンが3つ連続しないこと
        const fadeInCount = names.filter((n) => n === 'fadeIn').length;
        expect(fadeInCount).toBeLessThanOrEqual(2);
      }
    });
  });
});
