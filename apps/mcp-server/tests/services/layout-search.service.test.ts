// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutSearchService Unit Tests
 *
 * @module tests/services/layout-search.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LayoutSearchService,
  setLayoutEmbeddingServiceFactory,
  resetLayoutEmbeddingServiceFactory,
  setLayoutPrismaClientFactory,
  resetLayoutPrismaClientFactory,
  createLayoutSearchServiceFactory,
  getLayoutSearchService,
  resetLayoutSearchService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../src/services/layout-search.service';
import type { SearchOptions } from '../../src/tools/layout/search.tool';

describe('LayoutSearchService', () => {
  let mockEmbeddingService: IEmbeddingService;
  let mockPrismaClient: IPrismaClient;

  beforeEach(() => {
    // モックEmbeddingServiceを作成
    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    };

    // モックPrismaClientを作成
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

  describe('createLayoutSearchServiceFactory', () => {
    it('ファクトリ関数がILayoutSearchServiceを返すこと', () => {
      const factory = createLayoutSearchServiceFactory();
      const service = factory();
      expect(service).toBeDefined();
      expect(typeof service.generateQueryEmbedding).toBe('function');
      expect(typeof service.searchSectionPatterns).toBe('function');
    });
  });

  describe('getLayoutSearchService', () => {
    it('シングルトンインスタンスを返すこと', () => {
      const service1 = getLayoutSearchService();
      const service2 = getLayoutSearchService();
      expect(service1).toBe(service2);
    });

    it('リセット後は新しいインスタンスを返すこと', () => {
      const service1 = getLayoutSearchService();
      resetLayoutSearchService();
      const service2 = getLayoutSearchService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('generateQueryEmbedding', () => {
    it('EmbeddingServiceが設定されている場合、Embeddingを生成すること', async () => {
      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);

      const service = new LayoutSearchService();
      const embedding = await service.generateQueryEmbedding('hero section');

      expect(embedding).toBeDefined();
      expect(embedding.length).toBe(768);
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith(
        'hero section',
        'query'
      );
    });

    it('EmbeddingServiceが未設定の場合、nullを返すこと', async () => {
      const service = new LayoutSearchService();

      const result = await service.generateQueryEmbedding('test');

      expect(result).toBeNull();
    });

    it('EmbeddingServiceがエラーを返す場合、nullを返すこと', async () => {
      const failingService: IEmbeddingService = {
        generateEmbedding: vi.fn().mockRejectedValue(new Error('Model error')),
      };
      setLayoutEmbeddingServiceFactory(() => failingService);

      const service = new LayoutSearchService();

      const result = await service.generateQueryEmbedding('test');

      expect(result).toBeNull();
    });
  });

  describe('searchSectionPatterns', () => {
    const mockEmbedding = new Array(768).fill(0.1);
    const defaultOptions: SearchOptions = {
      limit: 10,
      offset: 0,
      includeHtml: false,
    };

    it('PrismaClientが未設定の場合、nullを返すこと', async () => {
      const service = new LayoutSearchService();

      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).toBeNull();
    });

    it('PrismaClientが設定されている場合、検索を実行すること', async () => {
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-1',
          web_page_id: 'page-id-1',
          section_type: 'hero',
          section_name: 'Hero Section',
          layout_info: { type: 'hero', grid: { columns: 2 } },
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
        .mockResolvedValueOnce(mockResults)  // 検索結果
        .mockResolvedValueOnce([{ total: 1n }]);  // カウント

      const service = new LayoutSearchService();

      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results.length).toBe(1);
      expect(result?.results[0]?.sectionType).toBe('hero');
      expect(result?.results[0]?.similarity).toBe(0.92);
      expect(result?.total).toBe(1);
    });

    it('フィルターが適用されること', async () => {
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const service = new LayoutSearchService();

      const options: SearchOptions = {
        filters: {
          sectionType: 'hero',
          sourceType: 'award_gallery',
          usageScope: 'inspiration_only',
        },
        limit: 10,
        offset: 0,
        includeHtml: false,
      };

      await service.searchSectionPatterns(mockEmbedding, options);

      expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const query = queryCall?.[0] as string;

      // フィルター条件がクエリに含まれていることを確認
      expect(query).toContain('section_type');
      expect(query).toContain('source_type');
      expect(query).toContain('usage_scope');
    });

    it('ページネーションが適用されること', async () => {
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const service = new LayoutSearchService();

      const options: SearchOptions = {
        limit: 20,
        offset: 40,
        includeHtml: false,
      };

      await service.searchSectionPatterns(mockEmbedding, options);

      expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const params = queryCall?.slice(1) as unknown[];

      // LIMIT と OFFSET のパラメータを確認
      expect(params).toContain(20);  // limit
      expect(params).toContain(40);  // offset
    });

    it('データベースエラーの場合、空の結果を返すこと', async () => {
      const failingPrismaClient: IPrismaClient = {
        sectionPattern: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('DB error')),
      };
      setLayoutPrismaClientFactory(() => failingPrismaClient);

      const service = new LayoutSearchService();

      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result).not.toBeNull();
      expect(result?.results).toEqual([]);
      expect(result?.total).toBe(0);
    });

    it('結果のマッピングが正しく行われること', async () => {
      setLayoutPrismaClientFactory(() => mockPrismaClient);

      const mockResults = [
        {
          id: 'section-id-1',
          web_page_id: 'page-id-1',
          section_type: 'feature',
          section_name: null,
          layout_info: {},
          visual_features: {},
          html_snippet: null,
          similarity: 0.75,
          wp_id: 'page-id-1',
          wp_url: 'https://example.com',
          wp_title: null,
          wp_source_type: 'user_provided',
          wp_usage_scope: 'owned_asset',
          wp_screenshot_desktop_url: 'https://example.com/screenshot.png',
        },
      ];

      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResults)
        .mockResolvedValueOnce([{ total: 1n }]);

      const service = new LayoutSearchService();

      const result = await service.searchSectionPatterns(mockEmbedding, defaultOptions);

      expect(result?.results[0]).toBeDefined();
      expect(result?.results[0]?.sectionName).toBeUndefined();  // nullはundefinedにマップされない
      expect(result?.results[0]?.htmlSnippet).toBeUndefined();
      expect(result?.results[0]?.webPage.screenshotDesktopUrl).toBe('https://example.com/screenshot.png');
    });
  });
});
