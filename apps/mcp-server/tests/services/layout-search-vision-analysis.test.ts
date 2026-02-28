// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutSearchService - visionAnalysis拡張テスト
 *
 * TDD-Red フェーズ: layout.search の検索結果に visionAnalysis を含める機能のテスト
 *
 * 目的:
 * - SectionPattern.layoutInfo.visionAnalysis が検索結果に含まれることを検証
 * - VisionAnalysis の型定義が正しいことを検証
 * - visionAnalysis がない場合のフォールバック動作を検証
 *
 * @module tests/services/layout-search-vision-analysis.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LayoutSearchService,
  setLayoutEmbeddingServiceFactory,
  resetLayoutEmbeddingServiceFactory,
  setLayoutPrismaClientFactory,
  resetLayoutPrismaClientFactory,
  resetLayoutSearchService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../src/services/layout-search.service';
import type { SearchOptions, SearchResult } from '../../src/tools/layout/search.tool';

// =============================================================================
// テスト用 VisionAnalysis 型定義
// =============================================================================

/**
 * VisionAnalysis の期待される構造
 * DBに保存されている layoutInfo.visionAnalysis の形式
 */
interface ExpectedVisionAnalysis {
  success: boolean;
  features: Array<{
    type: string;
    confidence: number;
    description?: string;
    data?: unknown;
  }>;
  textRepresentation?: string;
  processingTimeMs: number;
  modelName: string;
  rawResponse?: string;
  error?: string;
}

// =============================================================================
// モックデータファクトリ
// =============================================================================

/**
 * VisionAnalysis を持つ layout_info のモックデータを生成
 */
function createMockLayoutInfoWithVisionAnalysis(): Record<string, unknown> {
  return {
    type: 'hero',
    confidence: 0.95,
    heading: 'Hero Section',
    description: 'Main hero section with CTA',
    grid: { columns: 2, gap: '2rem' },
    visionAnalysis: {
      success: true,
      features: [
        {
          type: 'layout_structure',
          confidence: 0.8,
          description: 'grid-type layout with centered content',
        },
        {
          type: 'color_palette',
          confidence: 0.9,
          description: 'dark theme with blue accents',
        },
      ],
      textRepresentation: 'Layout: grid-type layout with centered content. Colors: dark theme.',
      processingTimeMs: 8936,
      modelName: 'llama3.2-vision',
    },
  };
}

/**
 * VisionAnalysis を持たない layout_info のモックデータを生成
 */
function createMockLayoutInfoWithoutVisionAnalysis(): Record<string, unknown> {
  return {
    type: 'feature',
    heading: 'Features Section',
    description: 'Product features grid',
    grid: { columns: 3 },
  };
}

/**
 * VisionAnalysis が失敗した layout_info のモックデータを生成
 */
function createMockLayoutInfoWithFailedVisionAnalysis(): Record<string, unknown> {
  return {
    type: 'pricing',
    confidence: 0.85,
    visionAnalysis: {
      success: false,
      features: [],
      processingTimeMs: 1500,
      modelName: 'llama3.2-vision',
      error: 'Model timeout during analysis',
    },
  };
}

// =============================================================================
// テストスイート
// =============================================================================

describe('LayoutSearchService - visionAnalysis 拡張', () => {
  let mockEmbeddingService: IEmbeddingService;
  let mockPrismaClient: IPrismaClient;

  beforeEach(() => {
    // モック EmbeddingService を作成
    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    };

    // モック PrismaClient を作成
    mockPrismaClient = {
      sectionPattern: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    // サービスファクトリをリセット
    resetLayoutEmbeddingServiceFactory();
    resetLayoutPrismaClientFactory();
    resetLayoutSearchService();
  });

  afterEach(() => {
    resetLayoutEmbeddingServiceFactory();
    resetLayoutPrismaClientFactory();
    resetLayoutSearchService();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // 型定義テスト
  // ===========================================================================

  describe('SearchResult 型定義', () => {
    it('layoutInfo に visionAnalysis プロパティが存在すること', () => {
      // SearchResult 型に visionAnalysis が含まれることを型レベルで検証
      // この型チェックはコンパイル時に検証される
      const mockResult: SearchResult = {
        id: 'test-id',
        webPageId: 'page-id',
        sectionType: 'hero',
        similarity: 0.95,
        webPage: {
          id: 'page-id',
          url: 'https://example.com',
          sourceType: 'user_provided',
          usageScope: 'inspiration_only',
        },
        layoutInfo: {
          type: 'hero',
          heading: 'Test',
          // visionAnalysis プロパティが型に含まれることを期待
          visionAnalysis: {
            success: true,
            features: [
              {
                type: 'layout_structure',
                confidence: 0.8,
                description: 'test layout',
              },
            ],
            processingTimeMs: 1000,
            modelName: 'llama3.2-vision',
          },
        },
      };

      // visionAnalysis が正しく設定されていることを確認
      expect(mockResult.layoutInfo).toBeDefined();
      expect(mockResult.layoutInfo?.visionAnalysis).toBeDefined();
      expect(mockResult.layoutInfo?.visionAnalysis?.success).toBe(true);
      expect(mockResult.layoutInfo?.visionAnalysis?.features).toHaveLength(1);
      expect(mockResult.layoutInfo?.visionAnalysis?.modelName).toBe('llama3.2-vision');
    });

    it('visionAnalysis がオプショナルであること', () => {
      // visionAnalysis なしでも型が有効であることを確認
      const mockResult: SearchResult = {
        id: 'test-id',
        webPageId: 'page-id',
        sectionType: 'feature',
        similarity: 0.85,
        webPage: {
          id: 'page-id',
          url: 'https://example.com',
          sourceType: 'user_provided',
          usageScope: 'inspiration_only',
        },
        layoutInfo: {
          type: 'feature',
          heading: 'Features',
        },
      };

      expect(mockResult.layoutInfo).toBeDefined();
      expect(mockResult.layoutInfo?.visionAnalysis).toBeUndefined();
    });
  });

  // ===========================================================================
  // vectorResultToSearchResult 変換テスト
  // ===========================================================================

  describe('vectorResultToSearchResult 変換', () => {
    const mockEmbedding = new Array(768).fill(0.1);
    const defaultOptions: SearchOptions = {
      limit: 10,
      offset: 0,
      includeHtml: false,
    };

    it('visionAnalysis が存在する場合、正しく抽出されること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-1',
          web_page_id: 'page-id-1',
          section_type: 'hero',
          section_name: 'Hero Section',
          layout_info: createMockLayoutInfoWithVisionAnalysis(),
          visual_features: { colors: ['#000', '#fff'] },
          html_snippet: '<section>...</section>',
          similarity: 0.92,
          wp_id: 'page-id-1',
          wp_url: 'https://example.com',
          wp_title: 'Example Site',
          wp_source_type: 'user_provided',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      // 検索結果が存在すること
      expect(result).not.toBeNull();
      expect(result?.results).toHaveLength(1);

      const firstResult = result?.results[0];
      expect(firstResult).toBeDefined();

      // layoutInfo に visionAnalysis が含まれること
      expect(firstResult?.layoutInfo).toBeDefined();
      expect(firstResult?.layoutInfo?.visionAnalysis).toBeDefined();

      // visionAnalysis の各フィールドを検証
      const visionAnalysis = firstResult?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis;
      expect(visionAnalysis.success).toBe(true);
      expect(visionAnalysis.features).toHaveLength(2);
      expect(visionAnalysis.features[0]?.type).toBe('layout_structure');
      expect(visionAnalysis.features[0]?.confidence).toBe(0.8);
      expect(visionAnalysis.processingTimeMs).toBe(8936);
      expect(visionAnalysis.modelName).toBe('llama3.2-vision');
      expect(visionAnalysis.textRepresentation).toContain('grid-type layout');
    });

    it('visionAnalysis が存在しない場合、エラーにならずに処理されること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-2',
          web_page_id: 'page-id-2',
          section_type: 'feature',
          section_name: null,
          layout_info: createMockLayoutInfoWithoutVisionAnalysis(),
          visual_features: {},
          html_snippet: null,
          similarity: 0.80,
          wp_id: 'page-id-2',
          wp_url: 'https://example2.com',
          wp_title: null,
          wp_source_type: 'user_provided',
          wp_usage_scope: 'owned_asset',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results).toHaveLength(1);

      const firstResult = result?.results[0];
      expect(firstResult).toBeDefined();

      // layoutInfo は存在するが、visionAnalysis は含まれないこと
      expect(firstResult?.layoutInfo).toBeDefined();
      expect(firstResult?.layoutInfo?.type).toBe('feature');
      expect(firstResult?.layoutInfo?.visionAnalysis).toBeUndefined();
    });

    it('visionAnalysis.success が false の場合も正しく含まれること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-3',
          web_page_id: 'page-id-3',
          section_type: 'pricing',
          section_name: 'Pricing Section',
          layout_info: createMockLayoutInfoWithFailedVisionAnalysis(),
          visual_features: {},
          html_snippet: '<section>pricing</section>',
          similarity: 0.75,
          wp_id: 'page-id-3',
          wp_url: 'https://example3.com',
          wp_title: 'Pricing Page',
          wp_source_type: 'award_gallery',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: 'https://example3.com/screenshot.png',
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results).toHaveLength(1);

      const firstResult = result?.results[0];
      expect(firstResult?.layoutInfo?.visionAnalysis).toBeDefined();

      const visionAnalysis = firstResult?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis;
      expect(visionAnalysis.success).toBe(false);
      expect(visionAnalysis.features).toHaveLength(0);
      expect(visionAnalysis.error).toBe('Model timeout during analysis');
      expect(visionAnalysis.modelName).toBe('llama3.2-vision');
    });

    it('複数の検索結果で visionAnalysis が混在する場合も正しく処理されること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-1',
          web_page_id: 'page-id-1',
          section_type: 'hero',
          section_name: 'Hero',
          layout_info: createMockLayoutInfoWithVisionAnalysis(),
          visual_features: {},
          html_snippet: null,
          similarity: 0.95,
          wp_id: 'page-id-1',
          wp_url: 'https://example1.com',
          wp_title: 'Site 1',
          wp_source_type: 'user_provided',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
        {
          id: 'section-id-2',
          web_page_id: 'page-id-2',
          section_type: 'feature',
          section_name: null,
          layout_info: createMockLayoutInfoWithoutVisionAnalysis(),
          visual_features: {},
          html_snippet: null,
          similarity: 0.85,
          wp_id: 'page-id-2',
          wp_url: 'https://example2.com',
          wp_title: 'Site 2',
          wp_source_type: 'user_provided',
          wp_usage_scope: 'owned_asset',
          wp_screenshot_desktop_url: null,
        },
        {
          id: 'section-id-3',
          web_page_id: 'page-id-3',
          section_type: 'pricing',
          section_name: 'Pricing',
          layout_info: createMockLayoutInfoWithFailedVisionAnalysis(),
          visual_features: {},
          html_snippet: null,
          similarity: 0.75,
          wp_id: 'page-id-3',
          wp_url: 'https://example3.com',
          wp_title: 'Site 3',
          wp_source_type: 'award_gallery',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 3n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results).toHaveLength(3);
      expect(result?.total).toBe(3);

      // 1つ目: visionAnalysis あり (success: true)
      expect(result?.results[0]?.layoutInfo?.visionAnalysis).toBeDefined();
      expect((result?.results[0]?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis).success).toBe(true);

      // 2つ目: visionAnalysis なし
      expect(result?.results[1]?.layoutInfo?.visionAnalysis).toBeUndefined();

      // 3つ目: visionAnalysis あり (success: false)
      expect(result?.results[2]?.layoutInfo?.visionAnalysis).toBeDefined();
      expect((result?.results[2]?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis).success).toBe(false);
    });

    it('layout_info が null の場合、visionAnalysis は含まれないこと', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-null',
          web_page_id: 'page-id-null',
          section_type: 'unknown',
          section_name: null,
          layout_info: null, // null の場合
          visual_features: null,
          html_snippet: null,
          similarity: 0.60,
          wp_id: 'page-id-null',
          wp_url: 'https://example-null.com',
          wp_title: null,
          wp_source_type: 'user_provided',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results).toHaveLength(1);

      // layoutInfo が存在しないか、空オブジェクト
      const firstResult = result?.results[0];
      expect(firstResult?.layoutInfo).toBeUndefined();
    });

    it('layout_info.visionAnalysis が不正な形式の場合でもエラーにならないこと', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-invalid',
          web_page_id: 'page-id-invalid',
          section_type: 'cta',
          section_name: 'CTA Section',
          layout_info: {
            type: 'cta',
            visionAnalysis: 'invalid-not-an-object', // 不正な形式
          },
          visual_features: {},
          html_snippet: null,
          similarity: 0.70,
          wp_id: 'page-id-invalid',
          wp_url: 'https://example-invalid.com',
          wp_title: 'Invalid',
          wp_source_type: 'user_provided',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();

      // エラーが発生しないこと
      await expect(
        service.searchSectionPatterns(mockEmbedding, defaultOptions)
      ).resolves.not.toThrow();

      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);
      expect(result).not.toBeNull();
    });
  });

  // ===========================================================================
  // visionAnalysis フィールドの詳細検証
  // ===========================================================================

  describe('visionAnalysis フィールド詳細検証', () => {
    const mockEmbedding = new Array(768).fill(0.1);
    const defaultOptions: SearchOptions = {
      limit: 10,
      offset: 0,
      includeHtml: false,
    };

    it('features 配列の各要素が正しく抽出されること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const complexVisionAnalysis = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.85,
            description: 'Two-column grid layout',
            data: {
              gridType: 'two-column',
              mainAreas: ['header', 'content', 'sidebar'],
            },
          },
          {
            type: 'color_palette',
            confidence: 0.92,
            description: 'Dark theme with blue accents',
            data: {
              dominantColors: ['#1a1a2e', '#16213e', '#0f3460', '#e94560'],
              mood: 'professional',
              contrast: 'high',
            },
          },
          {
            type: 'typography',
            confidence: 0.78,
            description: 'Modern sans-serif typography',
          },
        ],
        textRepresentation: 'Layout: Two-column grid. Colors: Dark theme.',
        processingTimeMs: 12500,
        modelName: 'llama3.2-vision',
      };

      const mockResults = [
        {
          id: 'section-complex',
          web_page_id: 'page-complex',
          section_type: 'hero',
          section_name: 'Complex Hero',
          layout_info: {
            type: 'hero',
            visionAnalysis: complexVisionAnalysis,
          },
          visual_features: {},
          html_snippet: null,
          similarity: 0.98,
          wp_id: 'page-complex',
          wp_url: 'https://complex-example.com',
          wp_title: 'Complex Site',
          wp_source_type: 'award_gallery',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: 'https://complex-example.com/ss.png',
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result?.results[0]?.layoutInfo?.visionAnalysis).toBeDefined();

      const visionAnalysis = result?.results[0]?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis;

      // features 配列の検証
      expect(visionAnalysis.features).toHaveLength(3);

      // layout_structure 特徴
      const layoutFeature = visionAnalysis.features.find(f => f.type === 'layout_structure');
      expect(layoutFeature).toBeDefined();
      expect(layoutFeature?.confidence).toBe(0.85);
      expect(layoutFeature?.description).toBe('Two-column grid layout');

      // color_palette 特徴
      const colorFeature = visionAnalysis.features.find(f => f.type === 'color_palette');
      expect(colorFeature).toBeDefined();
      expect(colorFeature?.confidence).toBe(0.92);

      // typography 特徴
      const typographyFeature = visionAnalysis.features.find(f => f.type === 'typography');
      expect(typographyFeature).toBeDefined();
      expect(typographyFeature?.confidence).toBe(0.78);

      // その他のフィールド
      expect(visionAnalysis.textRepresentation).toBe('Layout: Two-column grid. Colors: Dark theme.');
      expect(visionAnalysis.processingTimeMs).toBe(12500);
    });

    it('features が空配列の場合も正しく処理されること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-empty-features',
          web_page_id: 'page-empty',
          section_type: 'footer',
          section_name: null,
          layout_info: {
            type: 'footer',
            visionAnalysis: {
              success: true,
              features: [], // 空配列
              processingTimeMs: 500,
              modelName: 'llama3.2-vision',
            },
          },
          visual_features: {},
          html_snippet: null,
          similarity: 0.65,
          wp_id: 'page-empty',
          wp_url: 'https://empty-features.com',
          wp_title: null,
          wp_source_type: 'user_provided',
          wp_usage_scope: 'inspiration_only',
          wp_screenshot_desktop_url: null,
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();
      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      const visionAnalysis = result?.results[0]?.layoutInfo?.visionAnalysis as ExpectedVisionAnalysis;
      expect(visionAnalysis.success).toBe(true);
      expect(visionAnalysis.features).toEqual([]);
      expect(visionAnalysis.processingTimeMs).toBe(500);
    });
  });
});
