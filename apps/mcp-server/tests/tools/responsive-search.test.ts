// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.search MCPツール テスト
 *
 * 目的:
 * - responsive_analyses テーブルをセマンティック検索する MCPツールのテスト
 * - DIパターン（setResponsiveSearchServiceFactory / resetResponsiveSearchServiceFactory）
 * - 入力バリデーション（Zod schema）
 * - 正常系検索（ベクトル検索、フィルタリング、ページネーション）
 * - Embedding生成（E5プレフィックス: query:）
 * - エラーハンドリング（DB障害、タイムアウト）
 * - ツール定義（MCP Protocol準拠）
 *
 * @module tests/tools/responsive-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  responsiveSearchHandler,
  setResponsiveSearchServiceFactory,
  resetResponsiveSearchServiceFactory,
  responsiveSearchToolDefinition,
  type ResponsiveSearchInput,
  type ResponsiveSearchOutput,
  type IResponsiveSearchService,
  type ResponsiveSearchResultItem,
} from '../../src/tools/responsive/search.tool';

import {
  responsiveSearchInputSchema,
  RESPONSIVE_MCP_ERROR_CODES,
} from '../../src/tools/responsive/schemas';

// =====================================================
// logger モック
// =====================================================
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: (): boolean => false,
}));

// =====================================================
// テストデータ
// =====================================================

const VALID_DIFF_CATEGORIES = [
  'layout',
  'typography',
  'spacing',
  'visibility',
  'navigation',
  'image',
  'interaction',
  'animation',
] as const;

const VALID_VIEWPORT_PAIRS = [
  'desktop-tablet',
  'desktop-mobile',
  'tablet-mobile',
] as const;

function createMockSearchResult(
  id: string,
  similarity: number = 0.85
): {
  id: string;
  responsiveAnalysisId: string;
  webPageId: string;
  url: string;
  similarity: number;
  textRepresentation: string;
  viewportsAnalyzed: unknown;
  differences: unknown[];
  breakpoints: unknown[];
  screenshotDiffs: unknown[];
  analysisTimeMs: number;
  createdAt: Date;
} {
  return {
    id,
    responsiveAnalysisId: `ra-${id}`,
    webPageId: `wp-${id}`,
    url: `https://example.com/page-${id}`,
    similarity,
    textRepresentation: `passage: Responsive analysis: https://example.com/page-${id}`,
    viewportsAnalyzed: [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'mobile', width: 375, height: 667 },
    ],
    differences: [
      { category: 'layout', selector: '.grid', description: 'Grid column change' },
      { category: 'navigation', selector: 'nav', description: 'Hamburger menu' },
    ],
    breakpoints: [{ width: 768 }, { width: 479 }],
    screenshotDiffs: [
      { viewport1: 'desktop', viewport2: 'mobile', diffPercentage: 45.2 },
    ],
    analysisTimeMs: 3200,
    createdAt: new Date('2026-03-01'),
  };
}

// =====================================================
// モックサービス
// =====================================================

function createMockService(overrides?: Partial<IResponsiveSearchService>): IResponsiveSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    searchResponsiveAnalyses: vi.fn().mockResolvedValue({
      results: [
        createMockSearchResult('001', 0.92),
        createMockSearchResult('002', 0.87),
        createMockSearchResult('003', 0.81),
      ],
      total: 3,
    }),
    ...overrides,
  };
}

// =====================================================
// テスト
// =====================================================

describe('responsive.search MCPツール', () => {
  beforeEach(() => {
    resetResponsiveSearchServiceFactory();
  });

  afterEach(() => {
    resetResponsiveSearchServiceFactory();
  });

  // ===================================================
  // ツール定義
  // ===================================================

  describe('ツール定義', () => {
    it('should have correct tool name', () => {
      expect(responsiveSearchToolDefinition.name).toBe('responsive.search');
    });

    it('should have required query parameter', () => {
      expect(responsiveSearchToolDefinition.inputSchema.required).toContain('query');
    });

    it('should have read-only and idempotent annotations', () => {
      expect(responsiveSearchToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(responsiveSearchToolDefinition.annotations.idempotentHint).toBe(true);
    });

    it('should include filter properties in schema', () => {
      const properties = responsiveSearchToolDefinition.inputSchema.properties;
      expect(properties).toHaveProperty('query');
      expect(properties).toHaveProperty('limit');
      expect(properties).toHaveProperty('offset');
      expect(properties).toHaveProperty('filters');
    });
  });

  // ===================================================
  // 入力バリデーション（Zod schema）
  // ===================================================

  describe('入力バリデーション', () => {
    it('should accept valid minimal input', () => {
      const input = { query: 'hamburger menu' };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject empty query', () => {
      const input = { query: '' };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject query exceeding 500 chars', () => {
      const input = { query: 'a'.repeat(501) };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should apply default limit of 10', () => {
      const input = { query: 'test' };
      const result = responsiveSearchInputSchema.parse(input);
      expect(result.limit).toBe(10);
    });

    it('should apply default offset of 0', () => {
      const input = { query: 'test' };
      const result = responsiveSearchInputSchema.parse(input);
      expect(result.offset).toBe(0);
    });

    it('should reject limit > 50', () => {
      const input = { query: 'test', limit: 51 };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject limit < 1', () => {
      const input = { query: 'test', limit: 0 };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject negative offset', () => {
      const input = { query: 'test', offset: -1 };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it.each(VALID_DIFF_CATEGORIES)('should accept diffCategory: %s', (category) => {
      const input = { query: 'test', filters: { diffCategory: category } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject invalid diffCategory', () => {
      const input = { query: 'test', filters: { diffCategory: 'invalid' } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it.each(VALID_VIEWPORT_PAIRS)('should accept viewportPair: %s', (pair) => {
      const input = { query: 'test', filters: { viewportPair: pair } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject invalid viewportPair', () => {
      const input = { query: 'test', filters: { viewportPair: 'invalid' } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should accept valid breakpointRange', () => {
      const input = { query: 'test', filters: { breakpointRange: { min: 320, max: 1024 } } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should accept minDiffPercentage within 0-100', () => {
      const input = { query: 'test', filters: { minDiffPercentage: 30 } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject minDiffPercentage > 100', () => {
      const input = { query: 'test', filters: { minDiffPercentage: 101 } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should accept valid webPageId (UUID)', () => {
      const input = {
        query: 'test',
        filters: { webPageId: '11111111-1111-1111-1111-111111111111' },
      };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject invalid webPageId', () => {
      const input = { query: 'test', filters: { webPageId: 'not-a-uuid' } };
      const result = responsiveSearchInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  // ===================================================
  // サービスファクトリー
  // ===================================================

  describe('サービスファクトリー', () => {
    it('should return SERVICE_UNAVAILABLE when factory not set', async () => {
      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it('should work after factory is set', async () => {
      const mockService = createMockService();
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'hamburger menu',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(true);
    });

    it('should return SERVICE_UNAVAILABLE after factory is reset', async () => {
      const mockService = createMockService();
      setResponsiveSearchServiceFactory(() => mockService);
      resetResponsiveSearchServiceFactory();

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });
  });

  // ===================================================
  // 正常系検索
  // ===================================================

  describe('正常系検索', () => {
    let mockService: IResponsiveSearchService;

    beforeEach(() => {
      mockService = createMockService();
      setResponsiveSearchServiceFactory(() => mockService);
    });

    it('should execute search with query', async () => {
      const result = (await responsiveSearchHandler({
        query: 'hamburger menu responsive',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(3);
        expect(result.data.total).toBe(3);
        expect(result.data.query).toBe('hamburger menu responsive');
        expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('should prepend query: prefix for E5 model', async () => {
      await responsiveSearchHandler({ query: 'test query' });

      expect(mockService.generateQueryEmbedding).toHaveBeenCalledWith(
        'query: test query'
      );
    });

    it('should map result fields correctly', async () => {
      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        const firstResult = result.data.results[0]!;
        expect(firstResult).toHaveProperty('id');
        expect(firstResult).toHaveProperty('similarity');
        expect(firstResult).toHaveProperty('url');
        expect(firstResult).toHaveProperty('source');
        expect(firstResult.source).toHaveProperty('webPageId');
        expect(firstResult.source).toHaveProperty('responsiveAnalysisId');
        expect(firstResult).toHaveProperty('differencesCount');
        expect(firstResult).toHaveProperty('breakpointsCount');
        expect(firstResult).toHaveProperty('screenshotDiffs');
        expect(firstResult).toHaveProperty('textRepresentation');
      }
    });

    it('should count differences and breakpoints from arrays', async () => {
      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        const firstResult = result.data.results[0]!;
        expect(firstResult.differencesCount).toBe(2);
        expect(firstResult.breakpointsCount).toBe(2);
      }
    });

    it('should pass filters to service', async () => {
      await responsiveSearchHandler({
        query: 'test',
        filters: {
          diffCategory: 'navigation',
          viewportPair: 'desktop-mobile',
          breakpointRange: { min: 320, max: 1024 },
          minDiffPercentage: 25,
          webPageId: '11111111-1111-1111-1111-111111111111',
        },
      });

      expect(mockService.searchResponsiveAnalyses).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filters: expect.objectContaining({
            diffCategory: 'navigation',
            viewportPair: 'desktop-mobile',
            minDiffPercentage: 25,
            webPageId: '11111111-1111-1111-1111-111111111111',
          }),
        })
      );
    });

    it('should pass limit and offset to service', async () => {
      await responsiveSearchHandler({
        query: 'test',
        limit: 5,
        offset: 20,
      });

      expect(mockService.searchResponsiveAnalyses).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ limit: 5, offset: 20 })
      );
    });
  });

  // ===================================================
  // Embedding unavailable (graceful degradation)
  // ===================================================

  describe('Embedding unavailable', () => {
    it('should return empty results when embedding returns null', async () => {
      const mockService = createMockService({
        generateQueryEmbedding: vi.fn().mockResolvedValue(null),
      });
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  // ===================================================
  // エラーハンドリング
  // ===================================================

  describe('エラーハンドリング', () => {
    it('should return VALIDATION_ERROR for invalid input', async () => {
      const mockService = createMockService();
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: '',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('should return EMBEDDING_FAILED for embedding errors', async () => {
      const mockService = createMockService({
        generateQueryEmbedding: vi.fn().mockRejectedValue(new Error('embedding model failed')),
      });
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.EMBEDDING_FAILED);
      }
    });

    it('should return SEARCH_FAILED for database errors', async () => {
      const mockService = createMockService({
        searchResponsiveAnalyses: vi.fn().mockRejectedValue(new Error('database connection failed')),
      });
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.SEARCH_FAILED);
      }
    });

    it('should return SEARCH_FAILED for timeout errors', async () => {
      const mockService = createMockService({
        searchResponsiveAnalyses: vi.fn().mockRejectedValue(new Error('query timeout exceeded')),
      });
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.SEARCH_FAILED);
      }
    });

    it('should return INTERNAL_ERROR for unknown errors', async () => {
      const mockService = createMockService({
        searchResponsiveAnalyses: vi.fn().mockRejectedValue(new Error('something unexpected')),
      });
      setResponsiveSearchServiceFactory(() => mockService);

      const result = (await responsiveSearchHandler({
        query: 'test',
      })) as ResponsiveSearchOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(RESPONSIVE_MCP_ERROR_CODES.INTERNAL_ERROR);
      }
    });
  });
});
