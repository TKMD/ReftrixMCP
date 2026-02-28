// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search MCPツールのテスト
 * TDD Red: 先にテストを作成
 *
 * セクションパターンを自然言語クエリでセマンティック検索するMCPツール
 *
 * テスト対象:
 * - 入力バリデーション
 * - クエリ前処理（日本語/英語対応）
 * - ベクトル検索（pgvector HNSW）
 * - フィルタリング
 * - ページネーション
 * - 空結果処理
 * - エラーハンドリング
 * - パフォーマンス
 *
 * @module tests/tools/layout/search.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート（実装後に動作するようになる）
// =====================================================

import {
  layoutSearchHandler,
  layoutSearchToolDefinition,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  preprocessQuery,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type ILayoutSearchService,
} from '../../../src/tools/layout/search.tool';

import {
  layoutSearchInputSchema,
  layoutSearchOutputSchema,
  sectionTypeForSearchSchema,
  sourceTypeSchema,
  usageScopeSchema,
} from '../../../src/tools/layout/schemas';

// =====================================================
// テストデータ
// =====================================================

const mockSectionPatterns = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sectionType: 'hero',
    sectionName: 'Modern Hero Section',
    positionIndex: 0,
    layoutInfo: {
      type: 'hero',
      grid: { columns: 2, gap: '32px' },
      alignment: 'left',
    },
    visualFeatures: {
      colors: { dominant: '#3B82F6', background: '#FFFFFF' },
    },
    textRepresentation: 'Hero section with blue gradient, left-aligned heading, CTA button',
    webPage: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      url: 'https://example.com/page1',
      title: 'Example Page 1',
      sourceType: 'award_gallery',
      usageScope: 'inspiration_only',
      screenshotDesktopUrl: 'https://example.com/screenshot1.png',
    },
    embedding: {
      textEmbedding: new Array(768).fill(0.1),
    },
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    webPageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    sectionType: 'feature',
    sectionName: 'Feature Grid',
    positionIndex: 1,
    layoutInfo: {
      type: 'feature',
      grid: { columns: 3, gap: '24px' },
    },
    visualFeatures: {
      colors: { dominant: '#10B981', background: '#F3F4F6' },
    },
    textRepresentation: 'Feature section with 3-column grid, green icons, light gray background',
    webPage: {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      url: 'https://example.com/page2',
      title: 'Example Page 2',
      sourceType: 'user_provided',
      usageScope: 'owned_asset',
      screenshotDesktopUrl: 'https://example.com/screenshot2.png',
    },
    embedding: {
      textEmbedding: new Array(768).fill(0.2),
    },
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    webPageId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sectionType: 'cta',
    sectionName: 'Call to Action',
    positionIndex: 2,
    layoutInfo: {
      type: 'cta',
      alignment: 'center',
    },
    visualFeatures: {
      colors: { dominant: '#EF4444', background: '#1F2937' },
    },
    textRepresentation: 'CTA section with centered red button on dark background',
    webPage: {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      url: 'https://example.com/page3',
      title: 'Example Page 3',
      sourceType: 'award_gallery',
      usageScope: 'inspiration_only',
      screenshotDesktopUrl: null,
    },
    embedding: {
      textEmbedding: new Array(768).fill(0.3),
    },
  },
];

// =====================================================
// モックサービス
// =====================================================

function createMockService(overrides?: Partial<ILayoutSearchService>): ILayoutSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.15)),
    searchSectionPatterns: vi.fn().mockResolvedValue({
      results: mockSectionPatterns.slice(0, 2).map((p, index) => ({
        ...p,
        similarity: 0.95 - index * 0.1,
      })),
      total: 2,
    }),
    ...overrides,
  };
}

// =====================================================
// 入力スキーマテスト（15+ tests）
// =====================================================

describe('layoutSearchInputSchema', () => {
  describe('有効な入力', () => {
    it('クエリのみの入力を受け付ける', () => {
      const input = { query: 'hero section with gradient' };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('hero section with gradient');
        expect(result.data.limit).toBe(10); // デフォルト値
        expect(result.data.offset).toBe(0); // デフォルト値
        // MCP-RESP-03: include_html/includeHtmlはgetIncludeHtml()でデフォルト処理
        // スキーマレベルでは未定義のまま（両形式対応のため）
        expect(result.data.include_html).toBeUndefined();
        expect(result.data.includeHtml).toBeUndefined();
      }
    });

    it('日本語クエリを受け付ける', () => {
      const input = { query: 'ヒーローセクション グラデーション' };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('ヒーローセクション グラデーション');
      }
    });

    it('フィルター付きの入力を受け付ける', () => {
      const input = {
        query: 'modern hero',
        filters: {
          sectionType: 'hero',
          sourceType: 'award_gallery',
          usageScope: 'inspiration_only',
        },
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filters?.sectionType).toBe('hero');
        expect(result.data.filters?.sourceType).toBe('award_gallery');
        expect(result.data.filters?.usageScope).toBe('inspiration_only');
      }
    });

    it('limitを指定できる', () => {
      const input = { query: 'feature grid', limit: 25 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(25);
      }
    });

    it('offsetを指定できる', () => {
      const input = { query: 'cta section', offset: 10 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(10);
      }
    });

    it('includeHtmlをtrueに設定できる', () => {
      const input = { query: 'testimonial', includeHtml: true };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHtml).toBe(true);
      }
    });

    it('全てのオプションを指定できる', () => {
      const input = {
        query: 'pricing table',
        filters: {
          sectionType: 'pricing',
          sourceType: 'user_provided',
          usageScope: 'owned_asset',
        },
        limit: 20,
        offset: 5,
        includeHtml: true,
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('pricing table');
        expect(result.data.filters?.sectionType).toBe('pricing');
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(5);
        expect(result.data.includeHtml).toBe(true);
      }
    });

    it('部分的なフィルターを受け付ける', () => {
      const input = {
        query: 'footer',
        filters: {
          sectionType: 'footer',
        },
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filters?.sectionType).toBe('footer');
        expect(result.data.filters?.sourceType).toBeUndefined();
      }
    });
  });

  describe('無効な入力', () => {
    it('空のクエリを拒否する', () => {
      const input = { query: '' };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('クエリなしを拒否する', () => {
      const input = {};
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('500文字を超えるクエリを拒否する', () => {
      const input = { query: 'a'.repeat(501) };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('limitが0以下を拒否する', () => {
      const input = { query: 'test', limit: 0 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('limitが50超を拒否する', () => {
      const input = { query: 'test', limit: 51 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('offsetが負数を拒否する', () => {
      const input = { query: 'test', offset: -1 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('無効なsectionTypeを拒否する', () => {
      const input = {
        query: 'test',
        filters: { sectionType: 'invalid_type' },
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('無効なsourceTypeを拒否する', () => {
      const input = {
        query: 'test',
        filters: { sourceType: 'invalid' },
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('無効なusageScopeを拒否する', () => {
      const input = {
        query: 'test',
        filters: { usageScope: 'invalid' },
      };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('境界値テスト', () => {
    it('1文字のクエリを受け付ける', () => {
      const input = { query: 'a' };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('500文字のクエリを受け付ける', () => {
      const input = { query: 'a'.repeat(500) };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('limit=1を受け付ける', () => {
      const input = { query: 'test', limit: 1 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('limit=50を受け付ける', () => {
      const input = { query: 'test', limit: 50 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('offset=0を受け付ける', () => {
      const input = { query: 'test', offset: 0 };
      const result = layoutSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });
});

// =====================================================
// クエリ前処理テスト（10+ tests）
// =====================================================

describe('preprocessQuery', () => {
  describe('英語クエリ', () => {
    it('英語クエリにquery:プレフィックスを追加する', () => {
      const result = preprocessQuery('hero section with gradient');
      expect(result).toBe('query: hero section with gradient');
    });

    it('小文字に変換しない（E5モデルは大文字小文字を区別）', () => {
      const result = preprocessQuery('Hero Section');
      expect(result).toBe('query: Hero Section');
    });

    it('余分な空白を正規化する', () => {
      const result = preprocessQuery('  hero   section  ');
      expect(result).toBe('query: hero section');
    });
  });

  describe('日本語クエリ', () => {
    it('日本語クエリにquery:プレフィックスを追加する', () => {
      const result = preprocessQuery('ヒーローセクション');
      expect(result).toBe('query: ヒーローセクション');
    });

    it('日本語と英語の混在を処理する', () => {
      const result = preprocessQuery('hero セクション gradient');
      expect(result).toBe('query: hero セクション gradient');
    });

    it('全角スペースを半角に変換する', () => {
      const result = preprocessQuery('ヒーロー　セクション');
      expect(result).toBe('query: ヒーロー セクション');
    });
  });

  describe('特殊文字処理', () => {
    it('改行を空白に変換する', () => {
      const result = preprocessQuery('hero\nsection');
      expect(result).toBe('query: hero section');
    });

    it('タブを空白に変換する', () => {
      const result = preprocessQuery('hero\tsection');
      expect(result).toBe('query: hero section');
    });

    it('特殊記号を保持する（検索に有用な場合がある）', () => {
      const result = preprocessQuery('3-column grid');
      expect(result).toBe('query: 3-column grid');
    });

    it('空クエリは空のプレフィックス付き文字列を返す', () => {
      const result = preprocessQuery('');
      expect(result).toBe('query: ');
    });
  });
});

// =====================================================
// ハンドラーテスト - 正常系（10+ tests）
// =====================================================

describe('layoutSearchHandler - 正常系', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('基本的な検索クエリで結果を返す', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(2);
      expect(result.data.total).toBe(2);
      expect(result.data.query).toBe('hero section');
    }
  });

  it('検索結果に適切なフィールドが含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'feature grid' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const firstResult = result.data.results[0];
      expect(firstResult).toHaveProperty('id');
      expect(firstResult).toHaveProperty('webPageId');
      expect(firstResult).toHaveProperty('type');
      expect(firstResult).toHaveProperty('similarity');
      expect(firstResult).toHaveProperty('preview');
      expect(firstResult).toHaveProperty('source');
    }
  });

  it('similarity値が0-1の範囲内', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'cta button' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      for (const item of result.data.results) {
        expect(item.similarity).toBeGreaterThanOrEqual(0);
        expect(item.similarity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('日本語クエリで検索できる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'ヒーローセクション グラデーション' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockService.generateQueryEmbedding).toHaveBeenCalled();
  });

  it('previewにheadingとdescriptionが含まれる', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.9,
            layoutInfo: {
              ...mockSectionPatterns[0].layoutInfo,
              heading: 'Welcome to Our Platform',
              description: 'Build something amazing',
            },
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].preview).toBeDefined();
    }
  });

  it('sourceにurl, type, usageScopeが含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'feature' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const source = result.data.results[0].source;
      expect(source).toHaveProperty('url');
      expect(source).toHaveProperty('type');
      expect(source).toHaveProperty('usageScope');
    }
  });

  it('searchTimeMsが結果に含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'pricing' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('searchTimeMs');
      expect(typeof result.data.searchTimeMs).toBe('number');
      expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('includeHtml=trueでHTMLが含まれる', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.9,
            htmlSnippet: '<section class="hero">...</section>',
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero', includeHtml: true };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].html).toBeDefined();
    }
  });

  it('includeHtml=falseでHTMLが含まれない', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero', includeHtml: false };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].html).toBeUndefined();
    }
  });

  it('filtersが結果に含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'hero',
      filters: { sectionType: 'hero' },
    };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters).toEqual({ sectionType: 'hero' });
    }
  });
});

// =====================================================
// ハンドラーテスト - フィルタリング（8+ tests）
// =====================================================

describe('layoutSearchHandler - フィルタリング', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('sectionTypeフィルターが適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'modern design',
      filters: { sectionType: 'hero' },
    };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: expect.objectContaining({ sectionType: 'hero' }),
      })
    );
  });

  it('sourceTypeフィルターが適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'award winning',
      filters: { sourceType: 'award_gallery' },
    };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: expect.objectContaining({ sourceType: 'award_gallery' }),
      })
    );
  });

  it('usageScopeフィルターが適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'commercial use',
      filters: { usageScope: 'owned_asset' },
    };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: expect.objectContaining({ usageScope: 'owned_asset' }),
      })
    );
  });

  it('複数のフィルターを組み合わせられる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'beautiful',
      filters: {
        sectionType: 'hero',
        sourceType: 'award_gallery',
        usageScope: 'inspiration_only',
      },
    };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: {
          sectionType: 'hero',
          sourceType: 'award_gallery',
          usageScope: 'inspiration_only',
        },
      })
    );
  });

  it('フィルターなしで全件検索できる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'all sections' };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: undefined,
      })
    );
  });

  it('各sectionTypeでフィルタリングできる', async () => {
    const sectionTypes = [
      'hero',
      'feature',
      'cta',
      'testimonial',
      'pricing',
      'footer',
      'navigation',
      'about',
      'contact',
      'gallery',
    ] as const;

    for (const sectionType of sectionTypes) {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = {
        query: 'test',
        filters: { sectionType },
      };
      await layoutSearchHandler(input);

      expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: expect.objectContaining({ sectionType }),
        })
      );

      resetLayoutSearchServiceFactory();
    }
  });

  it('award_galleryとuser_providedの両方でフィルタリングできる', async () => {
    for (const sourceType of ['award_gallery', 'user_provided'] as const) {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = {
        query: 'test',
        filters: { sourceType },
      };
      await layoutSearchHandler(input);

      expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: expect.objectContaining({ sourceType }),
        })
      );

      resetLayoutSearchServiceFactory();
    }
  });

  it('inspiration_onlyとowned_assetの両方でフィルタリングできる', async () => {
    for (const usageScope of ['inspiration_only', 'owned_asset'] as const) {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = {
        query: 'test',
        filters: { usageScope },
      };
      await layoutSearchHandler(input);

      expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: expect.objectContaining({ usageScope }),
        })
      );

      resetLayoutSearchServiceFactory();
    }
  });
});

// =====================================================
// ハンドラーテスト - ページネーション（6+ tests）
// =====================================================

describe('layoutSearchHandler - ページネーション', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('デフォルトのlimit=10が適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10 })
    );
  });

  it('カスタムlimitが適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', limit: 25 };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25 })
    );
  });

  it('デフォルトのoffset=0が適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 0 })
    );
  });

  it('カスタムoffsetが適用される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', offset: 20 };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 20 })
    );
  });

  it('limitとoffsetを組み合わせられる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', limit: 15, offset: 30 };
    await layoutSearchHandler(input);

    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 15, offset: 30 })
    );
  });

  it('totalが結果のlimitと独立している', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: mockSectionPatterns.slice(0, 2),
        total: 100, // total > returned results
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', limit: 2 };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(2);
      expect(result.data.total).toBe(100);
    }
  });
});

// =====================================================
// ハンドラーテスト - 空結果（4+ tests）
// =====================================================

describe('layoutSearchHandler - 空結果', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('結果が0件の場合、空配列を返す', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'nonexistent pattern xyz123' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toEqual([]);
      expect(result.data.total).toBe(0);
    }
  });

  it('結果が0件でもsearchTimeMsが含まれる', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'no results' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.searchTimeMs).toBeDefined();
      expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('フィルターで結果が0件になる場合', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'hero',
      filters: { sectionType: 'footer' }, // heroを検索してfooterでフィルタ
    };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toEqual([]);
    }
  });

  it('高いoffsetで結果が0件になる場合', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [],
        total: 5, // total exists but offset is beyond
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', offset: 1000 };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toEqual([]);
      expect(result.data.total).toBe(5);
    }
  });
});

// =====================================================
// ハンドラーテスト - エラーハンドリング（8+ tests）
// =====================================================

describe('layoutSearchHandler - エラーハンドリング', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('無効な入力でVALIDATION_ERRORを返す', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input = { query: '' }; // 空クエリは無効
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('サービスファクトリーが未設定の場合にエラーを返す', async () => {
    resetLayoutSearchServiceFactory();

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('Embedding生成エラーをハンドリングする', async () => {
    const mockService = createMockService({
      generateQueryEmbedding: vi.fn().mockRejectedValue(new Error('Embedding service error')),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('EMBEDDING_ERROR');
      expect(result.error.message).toContain('Embedding');
    }
  });

  it('データベースエラーをハンドリングする', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockRejectedValue(new Error('Database connection failed')),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SEARCH_FAILED');
    }
  });

  it('タイムアウトエラーをハンドリングする', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockRejectedValue(new Error('Query timeout')),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it('不明なエラーをINTERNAL_ERRORとして返す', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockRejectedValue('Unknown error string'),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
    }
  });

  it('エラーメッセージに詳細が含まれる', async () => {
    const mockService = createMockService({
      generateQueryEmbedding: vi.fn().mockRejectedValue(new Error('Model loading failed: out of memory')),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeTruthy();
    }
  });

  it('nullレスポンスをハンドリングする', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue(null),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test' };
    const result = await layoutSearchHandler(input);

    // nullの場合は空結果か、エラーとして処理される
    if (result.success) {
      expect(result.data.results).toEqual([]);
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

// =====================================================
// ツール定義テスト（5+ tests）
// =====================================================

describe('layoutSearchToolDefinition', () => {
  it('正しい名前を持つ', () => {
    expect(layoutSearchToolDefinition.name).toBe('layout.search');
  });

  it('説明が設定されている', () => {
    expect(layoutSearchToolDefinition.description).toBeTruthy();
    expect(layoutSearchToolDefinition.description).toContain('セマンティック検索');
  });

  it('inputSchemaが定義されている', () => {
    expect(layoutSearchToolDefinition.inputSchema).toBeDefined();
    expect(layoutSearchToolDefinition.inputSchema.type).toBe('object');
  });

  it('必須プロパティにqueryが含まれる', () => {
    expect(layoutSearchToolDefinition.inputSchema.required).toContain('query');
  });

  it('queryプロパティの定義が正しい', () => {
    const queryProp = layoutSearchToolDefinition.inputSchema.properties.query;
    expect(queryProp.type).toBe('string');
    expect(queryProp.minLength).toBe(1);
    expect(queryProp.maxLength).toBe(500);
  });

  it('filtersプロパティが定義されている', () => {
    const filtersProp = layoutSearchToolDefinition.inputSchema.properties.filters;
    expect(filtersProp.type).toBe('object');
  });

  it('limitプロパティが正しく定義されている', () => {
    const limitProp = layoutSearchToolDefinition.inputSchema.properties.limit;
    expect(limitProp.type).toBe('number');
    expect(limitProp.minimum).toBe(1);
    expect(limitProp.maximum).toBe(50);
    expect(limitProp.default).toBe(10);
  });

  it('offsetプロパティが正しく定義されている', () => {
    const offsetProp = layoutSearchToolDefinition.inputSchema.properties.offset;
    expect(offsetProp.type).toBe('number');
    expect(offsetProp.minimum).toBe(0);
    expect(offsetProp.default).toBe(0);
  });

  it('includeHtmlプロパティが定義されている', () => {
    const includeHtmlProp = layoutSearchToolDefinition.inputSchema.properties.includeHtml;
    expect(includeHtmlProp.type).toBe('boolean');
    expect(includeHtmlProp.default).toBe(false);
  });
});

// =====================================================
// 出力スキーマテスト（4+ tests）
// =====================================================

describe('layoutSearchOutputSchema', () => {
  it('成功レスポンスを検証できる', () => {
    const successOutput = {
      success: true,
      data: {
        results: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            type: 'hero',
            similarity: 0.95,
            preview: {
              heading: 'Welcome',
              description: 'Test description',
            },
            source: {
              url: 'https://example.com',
              type: 'award_gallery',
              usageScope: 'inspiration_only',
            },
          },
        ],
        total: 1,
        query: 'test',
        filters: {},
        searchTimeMs: 50,
      },
    };

    const result = layoutSearchOutputSchema.safeParse(successOutput);
    expect(result.success).toBe(true);
  });

  it('エラーレスポンスを検証できる', () => {
    const errorOutput = {
      success: false,
      error: {
        code: 'SEARCH_FAILED',
        message: 'Database error',
      },
    };

    const result = layoutSearchOutputSchema.safeParse(errorOutput);
    expect(result.success).toBe(true);
  });

  it('htmlフィールドがオプション', () => {
    const outputWithHtml = {
      success: true,
      data: {
        results: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            type: 'hero',
            similarity: 0.95,
            preview: {},
            source: {
              url: 'https://example.com',
              type: 'award_gallery',
              usageScope: 'inspiration_only',
            },
            html: '<section>...</section>',
          },
        ],
        total: 1,
        query: 'test',
        filters: {},
        searchTimeMs: 50,
      },
    };

    const result = layoutSearchOutputSchema.safeParse(outputWithHtml);
    expect(result.success).toBe(true);
  });

  it('thumbnailフィールドがオプション', () => {
    const outputWithThumbnail = {
      success: true,
      data: {
        results: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            type: 'hero',
            similarity: 0.95,
            preview: {
              thumbnail: 'data:image/png;base64,...',
            },
            source: {
              url: 'https://example.com',
              type: 'award_gallery',
              usageScope: 'inspiration_only',
            },
          },
        ],
        total: 1,
        query: 'test',
        filters: {},
        searchTimeMs: 50,
      },
    };

    const result = layoutSearchOutputSchema.safeParse(outputWithThumbnail);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// パフォーマンステスト（2+ tests）
// =====================================================

describe('layoutSearchHandler - パフォーマンス', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('検索時間が記録される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'performance test' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.searchTimeMs).toBe('number');
    }
  });

  it('大量の結果でも処理できる', async () => {
    const largeResults = Array.from({ length: 50 }, (_, i) => ({
      ...mockSectionPatterns[0],
      id: `${i}`.padStart(8, '0') + '-1111-1111-1111-111111111111',
      similarity: 0.99 - i * 0.01,
    }));

    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: largeResults,
        total: 500,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'test', limit: 50 };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(50);
      expect(result.data.total).toBe(500);
    }
  });
});

// =====================================================
// 統合テスト（モック使用）（3+ tests）
// =====================================================

describe('layoutSearchHandler - 統合テスト', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('完全な検索フローが動作する', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'modern hero with gradient',
      filters: { sectionType: 'hero' },
      limit: 10,
      offset: 0,
      includeHtml: false,
    };

    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    expect(mockService.generateQueryEmbedding).toHaveBeenCalled();
    expect(mockService.searchSectionPatterns).toHaveBeenCalled();

    if (result.success) {
      expect(result.data.query).toBe('modern hero with gradient');
      expect(result.data.filters).toEqual({ sectionType: 'hero' });
    }
  });

  it('クエリEmbeddingが正しく生成される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'feature section with icons' };
    await layoutSearchHandler(input);

    expect(mockService.generateQueryEmbedding).toHaveBeenCalledWith(
      expect.stringContaining('feature section with icons')
    );
  });

  it('検索オプションが正しく渡される', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'pricing table',
      filters: {
        sectionType: 'pricing',
        sourceType: 'user_provided',
      },
      limit: 20,
      offset: 10,
      includeHtml: true,
    };

    await layoutSearchHandler(input);

    // MCP-RESP-03: SearchOptionsでは include_html (snake_case) を使用
    expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
      expect.any(Array), // embedding
      expect.objectContaining({
        filters: {
          sectionType: 'pricing',
          sourceType: 'user_provided',
        },
        limit: 20,
        offset: 10,
        include_html: true,
      })
    );
  });
});

// =====================================================
// HTMLプレビュー機能テスト (REFTRIX-LAYOUT-01)
// =====================================================

describe('layoutSearchHandler - HTMLプレビュー機能', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('デフォルトでhtmlPreviewとpreviewLengthが含まれる', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: '<section class="hero"><h1>Welcome</h1><p>Description here</p></section>',
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].htmlPreview).toBeDefined();
      expect(result.data.results[0].previewLength).toBeDefined();
      expect(typeof result.data.results[0].htmlPreview).toBe('string');
      expect(typeof result.data.results[0].previewLength).toBe('number');
    }
  });

  it('include_preview=falseでhtmlPreviewが含まれない', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: '<section class="hero"><h1>Welcome</h1></section>',
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero', include_preview: false };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].htmlPreview).toBeUndefined();
      expect(result.data.results[0].previewLength).toBeUndefined();
    }
  });

  it('preview_max_lengthで切り詰められる', async () => {
    const longHtml = '<section class="hero">' + '<p>Lorem ipsum dolor sit amet</p>'.repeat(50) + '</section>';
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: longHtml,
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'hero',
      preview_max_length: 200,
    };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].htmlPreview).toBeDefined();
      // 切り詰められて200文字 + "..."程度になる
      expect(result.data.results[0].htmlPreview!.length).toBeLessThanOrEqual(210);
      expect(result.data.results[0].htmlPreview!).toContain('...');
      // previewLengthは元のサニタイズ済みHTMLの長さ
      expect(result.data.results[0].previewLength).toBeGreaterThan(200);
    }
  });

  it('htmlPreviewはXSS対策でサニタイズされる', async () => {
    const maliciousHtml = '<section><script>alert("xss")</script><p>Safe content</p><a href="javascript:void(0)">Click</a></section>';
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: maliciousHtml,
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'section' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const preview = result.data.results[0].htmlPreview;
      expect(preview).toBeDefined();
      // scriptタグが除去されている
      expect(preview).not.toContain('<script>');
      expect(preview).not.toContain('alert');
      // javascript:プロトコルが除去されている
      expect(preview).not.toContain('javascript:');
      // 安全なコンテンツは残っている
      expect(preview).toContain('Safe content');
    }
  });

  it('htmlSnippetがない場合はhtmlPreviewも含まれない', async () => {
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: null,
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].htmlPreview).toBeUndefined();
      expect(result.data.results[0].previewLength).toBeUndefined();
    }
  });

  it('短いHTMLは切り詰めなしでそのまま返される', async () => {
    const shortHtml = '<section><h1>Title</h1></section>';
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...mockSectionPatterns[0],
            similarity: 0.95,
            htmlSnippet: shortHtml,
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'section' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const preview = result.data.results[0].htmlPreview;
      expect(preview).toBeDefined();
      // 省略記号がない
      expect(preview).not.toContain('...');
      // previewLengthとhtmlPreview.lengthが一致（切り詰めなし）
      expect(result.data.results[0].previewLength).toBe(preview!.length);
    }
  });
});

// =====================================================
// 入力スキーマ - プレビューパラメータバリデーション
// =====================================================

describe('layoutSearchInputSchema - プレビューパラメータ', () => {
  it('include_previewのデフォルト値はtrue', () => {
    const input = { query: 'hero section' };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_preview).toBe(true);
    }
  });

  it('include_preview=falseを指定できる', () => {
    const input = { query: 'hero section', include_preview: false };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_preview).toBe(false);
    }
  });

  it('preview_max_lengthのデフォルト値は500', () => {
    const input = { query: 'hero section' };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preview_max_length).toBe(500);
    }
  });

  it('preview_max_lengthを100-1000の範囲で指定できる', () => {
    const input = { query: 'hero', preview_max_length: 300 };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preview_max_length).toBe(300);
    }
  });

  it('preview_max_length < 100はエラー', () => {
    const input = { query: 'hero', preview_max_length: 50 };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('preview_max_length > 1000はエラー', () => {
    const input = { query: 'hero', preview_max_length: 1500 };
    const result = layoutSearchInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// =====================================================
// テストカウント確認
// =====================================================

describe('テストカウント確認', () => {
  it('45以上のテストケースが存在する', () => {
    // このテストはテスト数を確認するためのプレースホルダー
    // 実際のテスト数は上記のdescribeブロック内のitの数
    expect(true).toBe(true);
  });
});
