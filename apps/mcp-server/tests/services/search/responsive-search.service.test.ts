// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ResponsiveSearchService ユニットテスト
 *
 * createResponsiveSearchService() のすべてのメソッドを検証:
 * - generateQueryEmbedding: Embedding生成（正常系 / エラー時null返却）
 * - searchResponsiveAnalyses: ベクトル検索（フィルタ / ページネーション / COUNTクエリ）
 *
 * SEC H-1/M-1: Dynamic parameter indexing の正確性を検証
 *
 * @module tests/services/search/responsive-search.service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createResponsiveSearchService,
  type ResponsiveSearchOptions,
} from '../../../src/services/responsive-search.service';

// =====================================================
// logger モック
// =====================================================
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: (): boolean => false,
}));

// =====================================================
// テスト用ヘルパー
// =====================================================

/** 768次元の固定ベクトルを生成 */
function createMockEmbedding(fill = 0.01): number[] {
  return new Array(768).fill(fill);
}

/** テスト用DBレコード（snake_case形式） */
function createMockRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'rae-001',
    responsive_analysis_id: 'ra-001',
    web_page_id: 'wp-001',
    url: 'https://example.com',
    similarity: 0.89,
    text_representation: 'passage: Responsive analysis: https://example.com',
    viewports_analyzed: [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'mobile', width: 375, height: 667 },
    ],
    differences: [
      { category: 'layout', selector: '.grid', description: 'Grid changes' },
    ],
    breakpoints: [{ width: 768 }],
    screenshot_diffs: [
      { viewport1: 'desktop', viewport2: 'mobile', diffPercentage: 45.2 },
    ],
    analysis_time_ms: 3500,
    created_at: new Date('2026-03-01'),
    ...overrides,
  };
}

interface MockPrisma {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
}

interface MockEmbeddingService {
  generateEmbedding: ReturnType<typeof vi.fn>;
}

function createMockPrisma(): MockPrisma {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

function createMockEmbeddingService(): MockEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
  };
}

function createTestService(overrides?: {
  prisma?: MockPrisma;
  embeddingService?: MockEmbeddingService;
}): {
  service: ReturnType<typeof createResponsiveSearchService>;
  prisma: MockPrisma;
  embeddingService: MockEmbeddingService;
} {
  const prisma = overrides?.prisma ?? createMockPrisma();
  const embeddingService = overrides?.embeddingService ?? createMockEmbeddingService();
  const service = createResponsiveSearchService({ prisma, embeddingService });
  return { service, prisma, embeddingService };
}

// =====================================================
// テスト
// =====================================================

describe('ResponsiveSearchService', () => {
  describe('generateQueryEmbedding', () => {
    it('should generate embedding for query text', async () => {
      const { service, embeddingService } = createTestService();

      const result = await service.generateQueryEmbedding('query: hamburger menu responsive');

      expect(result).not.toBeNull();
      expect(result).toHaveLength(768);
      expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(
        'query: hamburger menu responsive',
        'query'
      );
    });

    it('should return null on embedding generation error', async () => {
      const embeddingService = createMockEmbeddingService();
      embeddingService.generateEmbedding.mockRejectedValue(new Error('Model not loaded'));
      const { service } = createTestService({ embeddingService });

      const result = await service.generateQueryEmbedding('query: test');

      expect(result).toBeNull();
    });
  });

  describe('searchResponsiveAnalyses', () => {
    let prisma: MockPrisma;
    let service: ReturnType<typeof createResponsiveSearchService>;

    beforeEach(() => {
      const testService = createTestService();
      prisma = testService.prisma;
      service = testService.service;
    });

    it('should execute vector search with no filters', async () => {
      const mockRows = [createMockRow(), createMockRow({ id: 'rae-002', similarity: 0.82 })];
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce(mockRows) // search query
        .mockResolvedValueOnce([{ total: 2 }]); // count query

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = { limit: 10, offset: 0 };

      const result = await service.searchResponsiveAnalyses(embedding, options);

      expect(result.results).toHaveLength(2);
      expect(result.total).toBe(2);

      // SQLパラメータ確認: [vectorString, limit, offset]
      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain('rae.embedding <=> $1::vector');
      expect(sql).toContain('LIMIT $2 OFFSET $3');
      expect(params).toHaveLength(3);
    });

    it('should apply webPageId filter', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([createMockRow()])
        .mockResolvedValueOnce([{ total: 1 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 10,
        offset: 0,
        filters: { webPageId: 'wp-001' },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      // [vectorString, webPageId, limit, offset]
      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain('ra.web_page_id = $2::uuid');
      expect(sql).toContain('LIMIT $3 OFFSET $4');
      expect(params[1]).toBe('wp-001');
    });

    it('should apply diffCategory filter with JSONB @>', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 10,
        offset: 0,
        filters: { diffCategory: 'navigation' },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain('ra.differences @> $2::jsonb');
      expect(params[1]).toBe(JSON.stringify([{ category: 'navigation' }]));
    });

    it('should apply breakpointRange min/max filters', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 10,
        offset: 0,
        filters: { breakpointRange: { min: 320, max: 1024 } },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain("(bp->>'width')::int >= $2");
      expect(sql).toContain("(bp->>'width')::int <= $3");
      expect(params[1]).toBe(320);
      expect(params[2]).toBe(1024);
    });

    it('should apply minDiffPercentage filter', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 10,
        offset: 0,
        filters: { minDiffPercentage: 30 },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain("(sd->>'diffPercentage')::float >= $2");
      expect(params[1]).toBe(30);
    });

    it('should apply viewportPair filter', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 10,
        offset: 0,
        filters: { viewportPair: 'desktop-mobile' },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain("sd->>'viewport1' = $2");
      expect(sql).toContain("sd->>'viewport2' = $3");
      expect(params[1]).toBe('desktop');
      expect(params[2]).toBe('mobile');
    });

    it('should correctly index parameters with multiple filters (SEC H-1/M-1)', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = {
        limit: 5,
        offset: 10,
        filters: {
          webPageId: 'wp-001',
          diffCategory: 'layout',
          breakpointRange: { min: 320, max: 1024 },
          minDiffPercentage: 20,
          viewportPair: 'desktop-tablet',
        },
      };

      await service.searchResponsiveAnalyses(embedding, options);

      // Expected parameter order:
      // $1=vectorString, $2=webPageId, $3=diffCategory, $4=breakpointMin, $5=breakpointMax,
      // $6=minDiffPercentage, $7=viewport1, $8=viewport2, $9=limit, $10=offset
      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      expect(params[0]).toMatch(/^\[/); // vectorString
      expect(params[1]).toBe('wp-001');
      expect(params[2]).toBe(JSON.stringify([{ category: 'layout' }]));
      expect(params[3]).toBe(320);
      expect(params[4]).toBe(1024);
      expect(params[5]).toBe(20);
      expect(params[6]).toBe('desktop');
      expect(params[7]).toBe('tablet');
      expect(params[8]).toBe(5);
      expect(params[9]).toBe(10);

      expect(sql).toContain('LIMIT $9 OFFSET $10');
    });

    it('should issue separate count query excluding limit/offset', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([createMockRow()])
        .mockResolvedValueOnce([{ total: 42 }]);

      const embedding = createMockEmbedding();
      const options: ResponsiveSearchOptions = { limit: 10, offset: 0 };

      const result = await service.searchResponsiveAnalyses(embedding, options);

      expect(result.total).toBe(42);

      // 2回呼ばれる: search query + count query
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);

      const countCall = prisma.$queryRawUnsafe.mock.calls[1] as [string, ...unknown[]];
      expect(countCall[0]).toContain('COUNT(*)::int');
      // count query は limit/offset パラメータを含まない
      expect(countCall.length).toBeLessThan(
        (prisma.$queryRawUnsafe.mock.calls[0] as unknown[]).length
      );
    });

    it('should handle empty results', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const embedding = createMockEmbedding();
      const result = await service.searchResponsiveAnalyses(embedding, {
        limit: 10,
        offset: 0,
      });

      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should respect pagination parameters', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([createMockRow()])
        .mockResolvedValueOnce([{ total: 50 }]);

      const embedding = createMockEmbedding();
      await service.searchResponsiveAnalyses(embedding, { limit: 5, offset: 20 });

      const [, ...params] = prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
      // Last two params are limit and offset
      expect(params[params.length - 2]).toBe(5);
      expect(params[params.length - 1]).toBe(20);
    });
  });
});
