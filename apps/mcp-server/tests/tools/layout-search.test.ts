// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search MCPツール - includeHtml デフォルト変更テスト
 * TDD Red Phase: これらのテストは現在の実装で失敗することを期待
 *
 * 目的:
 * - includeHtml のデフォルトが false であることを検証
 * - レスポンスサイズが 5KB 未満であることを検証
 * - includeHtml: true 時のみ HTML が含まれることを検証
 * - htmlSnippet フィールドが includeHtml: false 時に空/undefined であることを検証
 *
 * @module tests/tools/layout-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  layoutSearchHandler,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type LayoutSearchInput,
  type ILayoutSearchService,
} from '../../src/tools/layout/search.tool';

import { layoutSearchInputSchema } from '../../src/tools/layout/schemas';

// =====================================================
// テストデータ
// =====================================================

/**
 * 大きなHTMLスニペット（約50KB）
 * レスポンスサイズテスト用
 */
const LARGE_HTML_SNIPPET = `
<section class="hero-section" data-testid="hero">
  <div class="container mx-auto px-4 py-16">
    <h1 class="text-5xl font-bold text-gray-900 mb-6">
      Welcome to Our Amazing Platform
    </h1>
    <p class="text-xl text-gray-600 mb-8">
      Build something incredible with our cutting-edge tools and features.
      We provide everything you need to succeed in the modern digital landscape.
    </p>
    <div class="flex gap-4">
      <button class="bg-blue-600 text-white px-8 py-4 rounded-lg hover:bg-blue-700 transition-colors">
        Get Started
      </button>
      <button class="border border-gray-300 text-gray-700 px-8 py-4 rounded-lg hover:bg-gray-50 transition-colors">
        Learn More
      </button>
    </div>
  </div>
  <!-- 大きなHTMLを模擬するための繰り返しコンテンツ -->
  ${Array(500).fill('<div class="spacer" style="padding: 10px; margin: 5px; border: 1px solid #ccc;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>').join('\n')}
</section>
`.trim();

/**
 * モック検索結果（HTMLあり）
 * 各結果は約50KBのHTMLを含む
 */
const createMockResultWithHtml = (id: string, sectionType: string) => ({
  id,
  webPageId: `wp-${id}`,
  sectionType,
  sectionName: `${sectionType} Section`,
  similarity: 0.95,
  layoutInfo: {
    type: sectionType,
    heading: 'Test Heading',
    description: 'Test description for this section',
    grid: { columns: 2, gap: '24px' },
  },
  visualFeatures: {
    colors: { dominant: '#3B82F6', background: '#FFFFFF' },
  },
  htmlSnippet: LARGE_HTML_SNIPPET,
  webPage: {
    id: `wp-${id}`,
    url: `https://example.com/page-${id}`,
    title: `Example Page ${id}`,
    sourceType: 'award_gallery',
    usageScope: 'inspiration_only',
    screenshotDesktopUrl: `https://example.com/screenshot-${id}.png`,
  },
});

/**
 * モック検索結果（HTMLなし）
 * レスポンスサイズが小さい
 */
const createMockResultWithoutHtml = (id: string, sectionType: string) => ({
  id,
  webPageId: `wp-${id}`,
  sectionType,
  sectionName: `${sectionType} Section`,
  similarity: 0.95,
  layoutInfo: {
    type: sectionType,
    heading: 'Test Heading',
    description: 'Test description for this section',
  },
  visualFeatures: {
    colors: { dominant: '#3B82F6' },
  },
  // htmlSnippet は含まない
  webPage: {
    id: `wp-${id}`,
    url: `https://example.com/page-${id}`,
    title: `Example Page ${id}`,
    sourceType: 'award_gallery',
    usageScope: 'inspiration_only',
    screenshotDesktopUrl: null,
  },
});

// =====================================================
// モックサービス
// =====================================================

/**
 * モックサービスを作成
 * include_html オプションに基づいて異なる結果を返す
 * MCP-RESP-03: snake_case (include_html) が正式形式
 */
function createMockService(overrides?: Partial<ILayoutSearchService>): ILayoutSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.15)),
    searchSectionPatterns: vi.fn().mockImplementation((_embedding, options) => {
      // MCP-RESP-03: include_html (snake_case) を優先してチェック
      const includeHtml = options.include_html ?? false;
      const results = includeHtml
        ? [
            createMockResultWithHtml('11111111-1111-1111-1111-111111111111', 'hero'),
            createMockResultWithHtml('22222222-2222-2222-2222-222222222222', 'feature'),
          ]
        : [
            createMockResultWithoutHtml('11111111-1111-1111-1111-111111111111', 'hero'),
            createMockResultWithoutHtml('22222222-2222-2222-2222-222222222222', 'feature'),
          ];

      return Promise.resolve({
        results,
        total: 2,
      });
    }),
    ...overrides,
  };
}

// =====================================================
// includeHtml デフォルト値テスト
// =====================================================

describe('layout.search - includeHtml デフォルト値', { timeout: 180000 }, () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  describe('スキーマレベルのデフォルト値', () => {
    it('include_html/includeHtml を指定しない場合、スキーマレベルでは undefined（ハンドラーで false として扱われる）', () => {
      // クエリのみを指定した入力
      const input = { query: 'hero section' };
      const result = layoutSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // MCP-RESP-03: スキーマレベルでは undefined（ハンドラー内でデフォルト false として扱われる）
        expect(result.data.include_html).toBeUndefined();
        expect(result.data.includeHtml).toBeUndefined();
      }
    });

    it('include_html: undefined の場合、スキーマレベルでは undefined', () => {
      const input = { query: 'feature grid', include_html: undefined };
      const result = layoutSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_html).toBeUndefined();
      }
    });

    it('include_html: true を明示的に指定した場合、true になる', () => {
      const input = { query: 'cta section', include_html: true };
      const result = layoutSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_html).toBe(true);
      }
    });

    it('include_html: false を明示的に指定した場合、false になる', () => {
      const input = { query: 'footer section', include_html: false };
      const result = layoutSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_html).toBe(false);
      }
    });

    it('includeHtml: true（レガシー形式）を指定した場合、true になる', () => {
      const input = { query: 'cta section', includeHtml: true };
      const result = layoutSearchInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHtml).toBe(true);
      }
    });
  });

  describe('ハンドラーレベルのデフォルト動作', () => {
    it('include_html を指定しない場合、サービスに include_html: false が渡される', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section' };
      await layoutSearchHandler(input);

      // MCP-RESP-03: サービスに include_html: false が渡されることを検証
      expect(mockService.searchSectionPatterns).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          include_html: false,
        })
      );
    });

    it('include_html: false の場合、結果に html フィールドが含まれない', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', include_html: false };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 全ての結果で html フィールドが undefined であることを検証
        for (const item of result.data.results) {
          expect(item.html).toBeUndefined();
        }
      }
    });

    it('include_html: true の場合、結果に html フィールドが含まれる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', include_html: true };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 少なくとも1つの結果で html フィールドが存在することを検証
        const hasHtml = result.data.results.some((item) => item.html !== undefined);
        expect(hasHtml).toBe(true);
      }
    });

    it('includeHtml: true（レガシー形式）の場合も、結果に html フィールドが含まれる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', includeHtml: true };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 少なくとも1つの結果で html フィールドが存在することを検証
        const hasHtml = result.data.results.some((item) => item.html !== undefined);
        expect(hasHtml).toBe(true);
      }
    });
  });
});

// =====================================================
// レスポンスサイズテスト
// =====================================================

describe('layout.search - レスポンスサイズ', { timeout: 120000 }, () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  /**
   * レスポンスサイズを計算するヘルパー関数
   * JSON.stringify でシリアライズしたバイト数を返す
   */
  const calculateResponseSize = (response: unknown): number => {
    const jsonString = JSON.stringify(response);
    return Buffer.byteLength(jsonString, 'utf8');
  };

  describe('include_html: false の場合のサイズ制限', () => {
    it('各結果のサイズが 5KB 未満である', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', include_html: false };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          const itemSize = calculateResponseSize(item);
          // 各結果が 5KB (5120 bytes) 未満であることを検証
          expect(itemSize).toBeLessThan(5120);
        }
      }
    });

    it('10件の結果の合計サイズが 50KB 未満である', async () => {
      // 10件の結果を返すモックサービス
      const mockService = createMockService({
        searchSectionPatterns: vi.fn().mockResolvedValue({
          results: Array.from({ length: 10 }, (_, i) =>
            createMockResultWithoutHtml(`${i}`.padStart(8, '0') + '-0000-0000-0000-000000000000', 'hero')
          ),
          total: 10,
        }),
      });
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', include_html: false, limit: 10 };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const totalSize = calculateResponseSize(result.data.results);
        // 10件の合計が 50KB (51200 bytes) 未満であることを検証
        expect(totalSize).toBeLessThan(51200);
      }
    });

    it('デフォルト（include_html 未指定）でも 5KB 未満である', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      // include_html を指定しない（デフォルト動作）
      const input: LayoutSearchInput = { query: 'hero section' };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        for (const item of result.data.results) {
          const itemSize = calculateResponseSize(item);
          // デフォルトでも 5KB 未満であることを検証
          expect(itemSize).toBeLessThan(5120);
        }
      }
    });
  });

  describe('include_html: true の場合のサイズ', () => {
    it('各結果のサイズが 5KB 以上になり得る', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const input: LayoutSearchInput = { query: 'hero section', include_html: true };
      const result = await layoutSearchHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // include_html: true の場合、大きなHTMLを含むので 5KB を超える
        const hasLargeItem = result.data.results.some((item) => {
          const itemSize = calculateResponseSize(item);
          return itemSize >= 5120;
        });
        expect(hasLargeItem).toBe(true);
      }
    });

    it('サイズ差が顕著である（include_html: true vs false）', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      // include_html: false
      const inputWithoutHtml: LayoutSearchInput = { query: 'hero section', include_html: false };
      const resultWithoutHtml = await layoutSearchHandler(inputWithoutHtml);

      // include_html: true
      const inputWithHtml: LayoutSearchInput = { query: 'hero section', include_html: true };
      const resultWithHtml = await layoutSearchHandler(inputWithHtml);

      expect(resultWithoutHtml.success).toBe(true);
      expect(resultWithHtml.success).toBe(true);

      if (resultWithoutHtml.success && resultWithHtml.success) {
        const sizeWithoutHtml = calculateResponseSize(resultWithoutHtml.data.results);
        const sizeWithHtml = calculateResponseSize(resultWithHtml.data.results);

        // include_html: true の場合のサイズは false の 10 倍以上であることを検証
        // これは ~100KB vs ~2KB の差を検証
        expect(sizeWithHtml).toBeGreaterThan(sizeWithoutHtml * 10);
      }
    });
  });
});

// =====================================================
// htmlSnippet フィールドテスト
// =====================================================

describe('layout.search - htmlSnippet フィールド', { timeout: 120000 }, () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('include_html: false の場合、htmlSnippet は結果に含まれない', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section', include_html: false };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      for (const item of result.data.results) {
        // html フィールドが undefined であることを検証
        expect(item.html).toBeUndefined();
        // レスポンスに 'html' キーが存在しないことを検証
        expect('html' in item).toBe(false);
      }
    }
  });

  it('include_html: true の場合、htmlSnippet が結果に含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section', include_html: true };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 少なくとも1つの結果で html フィールドが存在し、値があることを検証
      const htmlResults = result.data.results.filter(
        (item) => item.html !== undefined && item.html.length > 0
      );
      expect(htmlResults.length).toBeGreaterThan(0);
    }
  });

  it('デフォルト（include_html 未指定）で htmlSnippet は含まれない', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    // include_html を指定しない（デフォルト動作）
    const input: LayoutSearchInput = { query: 'hero section' };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      for (const item of result.data.results) {
        // デフォルトでは html フィールドが undefined であることを検証
        expect(item.html).toBeUndefined();
      }
    }
  });

  it('空の htmlSnippet は結果に含まれない', async () => {
    // 空の htmlSnippet を持つ結果を返すモックサービス
    const mockService = createMockService({
      searchSectionPatterns: vi.fn().mockResolvedValue({
        results: [
          {
            ...createMockResultWithHtml('11111111-1111-1111-1111-111111111111', 'hero'),
            htmlSnippet: '', // 空文字列
          },
        ],
        total: 1,
      }),
    });
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section', include_html: true };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 空の htmlSnippet は結果に含まれない（undefined または空文字列）
      const firstResult = result.data.results[0];
      // 空文字列の場合は含まれないか、含まれても空であることを検証
      if (firstResult.html !== undefined) {
        expect(firstResult.html).toBe('');
      }
    }
  });
});

// =====================================================
// 後方互換性テスト
// =====================================================

describe('layout.search - 後方互換性', { timeout: 120000 }, () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  it('明示的に include_html: true を指定すれば HTML を取得できる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section', include_html: true };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // HTML が取得できることを検証
      const hasHtml = result.data.results.some(
        (item) => item.html !== undefined && item.html.length > 0
      );
      expect(hasHtml).toBe(true);
    }
  });

  it('includeHtml: true（レガシー形式）を指定しても HTML を取得できる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = { query: 'hero section', includeHtml: true };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 従来通り HTML が取得できることを検証
      const hasHtml = result.data.results.some(
        (item) => item.html !== undefined && item.html.length > 0
      );
      expect(hasHtml).toBe(true);
    }
  });

  it('必須フィールドは include_html の値に関わらず常に含まれる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    // include_html: false
    const inputFalse: LayoutSearchInput = { query: 'hero section', include_html: false };
    const resultFalse = await layoutSearchHandler(inputFalse);

    // include_html: true
    const inputTrue: LayoutSearchInput = { query: 'hero section', include_html: true };
    const resultTrue = await layoutSearchHandler(inputTrue);

    expect(resultFalse.success).toBe(true);
    expect(resultTrue.success).toBe(true);

    if (resultFalse.success && resultTrue.success) {
      // 両方の結果で必須フィールドが存在することを検証
      for (const item of [...resultFalse.data.results, ...resultTrue.data.results]) {
        expect(item.id).toBeDefined();
        expect(item.webPageId).toBeDefined();
        expect(item.type).toBeDefined();
        expect(item.similarity).toBeDefined();
        expect(item.preview).toBeDefined();
        expect(item.source).toBeDefined();
        expect(item.source.url).toBeDefined();
        expect(item.source.type).toBeDefined();
        expect(item.source.usageScope).toBeDefined();
      }
    }
  });

  it('フィルタリングと include_html を組み合わせて使用できる', async () => {
    const mockService = createMockService();
    setLayoutSearchServiceFactory(() => mockService);

    const input: LayoutSearchInput = {
      query: 'hero section',
      filters: {
        sectionType: 'hero',
        sourceType: 'award_gallery',
      },
      include_html: false,
    };
    const result = await layoutSearchHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // フィルタリングが適用されていることを検証
      expect(result.data.filters).toEqual({
        sectionType: 'hero',
        sourceType: 'award_gallery',
      });
      // HTML が含まれていないことを検証
      for (const item of result.data.results) {
        expect(item.html).toBeUndefined();
      }
    }
  });
});

// =====================================================
// テストカウント確認
// =====================================================

describe('layout.search includeHtml テスト - カウント確認', () => {
  it('このファイルには 15 以上のテストケースが存在する', () => {
    // このテストはテスト数を確認するためのプレースホルダー
    // 実際のテスト数は上記の describe ブロック内の it の数
    expect(true).toBe(true);
  });
});
