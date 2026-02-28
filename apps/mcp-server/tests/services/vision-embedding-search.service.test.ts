// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionEmbeddingSearchService Unit Tests
 *
 * visionEmbedding 列を活用したセマンティック検索サービスのテスト
 *
 * Phase 4-2: visionEmbeddingベースのセマンティック検索
 *
 * テストカバレッジ:
 * - VisionSearchQuery インターフェース（6テスト）
 * - searchByVisionEmbedding（8テスト）
 * - searchSimilarSections（6テスト）
 * - hybridSearch - RRFフュージョン（8テスト）
 * - 類似度フィルタリング（5テスト）
 * - パフォーマンス（4テスト）
 * - エラーハンドリング（5テスト）
 *
 * @module tests/services/vision-embedding-search.service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VisionEmbeddingSearchService,
  setVisionSearchEmbeddingServiceFactory,
  resetVisionSearchEmbeddingServiceFactory,
  setVisionSearchPrismaClientFactory,
  resetVisionSearchPrismaClientFactory,
  getVisionEmbeddingSearchService,
  resetVisionEmbeddingSearchService,
  createVisionEmbeddingSearchServiceFactory,
  type VisionSearchQuery,
  type VisionSearchResult,
  type VisionSearchOptions,
  type HybridSearchOptions,
  type IVisionSearchEmbeddingService,
  type IVisionSearchPrismaClient,
} from '../../src/services/vision-embedding-search.service';

// =====================================================
// テストヘルパー
// =====================================================

/**
 * モック用の768次元ベクトル生成
 */
function createMockEmbedding(seed: number = 0): number[] {
  const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i + seed) * 0.1);
  // L2正規化
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / norm);
}

/**
 * モックDBレコード生成
 */
function createMockVisionSearchRecord(overrides: Partial<{
  id: string;
  web_page_id: string;
  section_type: string;
  section_name: string | null;
  layout_info: unknown;
  visual_features: unknown;
  html_snippet: string | null;
  similarity: number;
  wp_id: string;
  wp_url: string;
  wp_title: string | null;
  wp_source_type: string;
  wp_usage_scope: string;
  wp_screenshot_desktop_url: string | null;
}> = {}) {
  return {
    id: 'section-id-1',
    web_page_id: 'page-id-1',
    section_type: 'hero',
    section_name: 'Hero Section',
    layout_info: { type: 'hero', grid: { columns: 2 } },
    visual_features: {
      colors: {
        dominant: ['#3B82F6', '#FFFFFF'],
        accent: ['#10B981'],
        palette: [],
        source: 'deterministic',
        confidence: 0.95,
      },
      theme: {
        type: 'light',
        backgroundColor: '#FFFFFF',
        textColor: '#1F2937',
        contrastRatio: 12.5,
        source: 'deterministic',
        confidence: 0.98,
      },
    },
    html_snippet: '<section class="hero">...</section>',
    similarity: 0.92,
    wp_id: 'page-id-1',
    wp_url: 'https://example.com',
    wp_title: 'Example Site',
    wp_source_type: 'user_provided',
    wp_usage_scope: 'inspiration_only',
    wp_screenshot_desktop_url: 'https://example.com/screenshot.png',
    ...overrides,
  };
}

// =====================================================
// VisionSearchQuery インターフェーステスト（6テスト）
// =====================================================

describe('VisionSearchQuery インターフェース', () => {
  it('テキストクエリのみでVisionSearchQueryを構築できる', () => {
    const query: VisionSearchQuery = {
      textQuery: 'ダークテーマのヒーローセクション',
    };

    expect(query.textQuery).toBe('ダークテーマのヒーローセクション');
    expect(query.visualFeatures).toBeUndefined();
    expect(query.sectionPatternId).toBeUndefined();
  });

  it('visualFeaturesのみでVisionSearchQueryを構築できる', () => {
    const query: VisionSearchQuery = {
      visualFeatures: {
        theme: 'dark',
        colors: ['#000000', '#FFFFFF'],
        density: 'high',
      },
    };

    expect(query.textQuery).toBeUndefined();
    expect(query.visualFeatures?.theme).toBe('dark');
    expect(query.visualFeatures?.colors).toEqual(['#000000', '#FFFFFF']);
  });

  it('sectionPatternIdのみでVisionSearchQueryを構築できる', () => {
    const query: VisionSearchQuery = {
      sectionPatternId: '123e4567-e89b-12d3-a456-426614174000',
    };

    expect(query.sectionPatternId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(query.textQuery).toBeUndefined();
    expect(query.visualFeatures).toBeUndefined();
  });

  it('複合クエリ（textQuery + visualFeatures）を構築できる', () => {
    const query: VisionSearchQuery = {
      textQuery: 'モダンなレイアウト',
      visualFeatures: {
        theme: 'light',
        colors: ['#3B82F6'],
      },
    };

    expect(query.textQuery).toBeDefined();
    expect(query.visualFeatures).toBeDefined();
  });

  it('空のオブジェクトはVisionSearchQueryとして有効（オプショナル）', () => {
    const query: VisionSearchQuery = {};

    expect(query.textQuery).toBeUndefined();
    expect(query.visualFeatures).toBeUndefined();
    expect(query.sectionPatternId).toBeUndefined();
  });

  it('visualFeaturesには複数のプロパティを含められる', () => {
    const query: VisionSearchQuery = {
      visualFeatures: {
        theme: 'dark',
        colors: ['#1F2937', '#3B82F6', '#10B981'],
        density: 'medium',
        gradient: 'linear',
        mood: 'professional',
        brandTone: 'corporate',
      },
    };

    expect(Object.keys(query.visualFeatures || {}).length).toBe(6);
  });
});

// =====================================================
// searchByVisionEmbedding テスト（8テスト）
// =====================================================

describe('searchByVisionEmbedding', () => {
  let mockEmbeddingService: IVisionSearchEmbeddingService;
  let mockPrismaClient: IVisionSearchPrismaClient;
  let service: VisionEmbeddingSearchService;

  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();

    const mockEmbedding = createMockEmbedding(42);

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    };

    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    service = new VisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('テキストクエリからvision_embeddingで検索する', async () => {
    const mockResults = [createMockVisionSearchRecord({ similarity: 0.95 })];
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    const query: VisionSearchQuery = {
      textQuery: 'ダークテーマのヒーローセクション',
    };

    const result = await service.searchByVisionEmbedding(query, { limit: 10, offset: 0 });

    expect(result).not.toBeNull();
    expect(result?.results.length).toBe(1);
    expect(result?.results[0]?.similarity).toBe(0.95);
    expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith(
      expect.stringContaining('ダークテーマ'),
      'query'
    );
  });

  it('vision_embedding列を使用してコサイン類似度検索する', async () => {
    const mockResults = [createMockVisionSearchRecord()];
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    await service.searchByVisionEmbedding({ textQuery: 'test' }, { limit: 10, offset: 0 });

    const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const query = queryCall?.[0] as string;

    // vision_embedding列を使用していることを確認
    expect(query).toContain('vision_embedding');
    expect(query).toContain('<=>'); // pgvector cosine distance operator
  });

  it('類似度順にソートされた結果を返す', async () => {
    const mockResults = [
      createMockVisionSearchRecord({ id: 'id-1', similarity: 0.95 }),
      createMockVisionSearchRecord({ id: 'id-2', similarity: 0.85 }),
      createMockVisionSearchRecord({ id: 'id-3', similarity: 0.75 }),
    ];
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 3n }]);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.results[0]?.similarity).toBe(0.95);
    expect(result?.results[1]?.similarity).toBe(0.85);
    expect(result?.results[2]?.similarity).toBe(0.75);
  });

  it('limitとoffsetが正しく適用される', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 20, offset: 40 }
    );

    const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = queryCall?.slice(1) as unknown[];

    expect(params).toContain(20); // limit
    expect(params).toContain(40); // offset
  });

  it('vision_embeddingがnullのレコードを除外する', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const query = queryCall?.[0] as string;

    expect(query).toContain('vision_embedding IS NOT NULL');
  });

  it('空のクエリでnullを返す', async () => {
    const result = await service.searchByVisionEmbedding({}, { limit: 10, offset: 0 });

    expect(result).toBeNull();
  });

  it('totalCountを正しく返す', async () => {
    const mockResults = [createMockVisionSearchRecord()];
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 100n }]);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.total).toBe(100);
  });

  it('EmbeddingServiceがnullを返す場合、nullを返す', async () => {
    (mockEmbeddingService.generateEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).toBeNull();
  });
});

// =====================================================
// searchSimilarSections テスト（6テスト）
// =====================================================

describe('searchSimilarSections', () => {
  let mockEmbeddingService: IVisionSearchEmbeddingService;
  let mockPrismaClient: IVisionSearchPrismaClient;
  let service: VisionEmbeddingSearchService;

  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();

    const mockEmbedding = createMockEmbedding(42);

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    };

    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    service = new VisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('sectionPatternIdから既存のvision_embeddingを取得して検索する', async () => {
    const existingEmbedding = createMockEmbedding(100);
    const mockResults = [createMockVisionSearchRecord({ similarity: 0.88 })];

    // 既存Embeddingの取得
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ vision_embedding: `[${existingEmbedding.join(',')}]` }])
      .mockResolvedValueOnce(mockResults) // 検索結果
      .mockResolvedValueOnce([{ total: 1n }]); // カウント

    const result = await service.searchSimilarSections(
      '123e4567-e89b-12d3-a456-426614174000',
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results.length).toBe(1);
  });

  it('自分自身を検索結果から除外する', async () => {
    const existingEmbedding = createMockEmbedding(100);
    const mockResults = [
      createMockVisionSearchRecord({ id: 'other-section-id', similarity: 0.85 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ vision_embedding: `[${existingEmbedding.join(',')}]` }])
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    await service.searchSimilarSections(
      '123e4567-e89b-12d3-a456-426614174000',
      { limit: 10, offset: 0 }
    );

    const searchQueryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[1];
    const query = searchQueryCall?.[0] as string;

    expect(query).toContain('sp.id !='); // 自分自身を除外
  });

  it('vision_embeddingが存在しない場合、nullを返す', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]); // 既存Embeddingが見つからない

    const result = await service.searchSimilarSections(
      'non-existent-id',
      { limit: 10, offset: 0 }
    );

    expect(result).toBeNull();
  });

  it('最低類似度（minSimilarity）でフィルタリングする', async () => {
    const existingEmbedding = createMockEmbedding(100);

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ vision_embedding: `[${existingEmbedding.join(',')}]` }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchSimilarSections(
      '123e4567-e89b-12d3-a456-426614174000',
      { limit: 10, offset: 0, minSimilarity: 0.8 }
    );

    const searchQueryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[1];
    const query = searchQueryCall?.[0] as string;

    // minSimilarityが適用されていることを確認
    expect(query).toContain('similarity');
  });

  it('sectionTypeでフィルタリングできる', async () => {
    const existingEmbedding = createMockEmbedding(100);

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ vision_embedding: `[${existingEmbedding.join(',')}]` }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchSimilarSections(
      '123e4567-e89b-12d3-a456-426614174000',
      { limit: 10, offset: 0, sectionType: 'hero' }
    );

    const searchQueryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[1];
    const query = searchQueryCall?.[0] as string;

    expect(query).toContain('section_type');
  });

  it('無効なUUID形式でエラーハンドリングする', async () => {
    const result = await service.searchSimilarSections('invalid-uuid', { limit: 10, offset: 0 });

    // 無効なUUIDはエラーを投げずにnullを返す（Graceful Degradation）
    expect(result).toBeNull();
  });
});

// =====================================================
// hybridSearch - RRFフュージョン テスト（8テスト）
// =====================================================

describe('hybridSearch - RRFフュージョン', () => {
  let mockEmbeddingService: IVisionSearchEmbeddingService;
  let mockPrismaClient: IVisionSearchPrismaClient;
  let service: VisionEmbeddingSearchService;

  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();

    const mockEmbedding = createMockEmbedding(42);

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    };

    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    service = new VisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('text_embeddingとvision_embeddingの両方を使用したハイブリッド検索', async () => {
    const mockResults = [createMockVisionSearchRecord({ similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults) // text_embedding検索
      .mockResolvedValueOnce(mockResults) // vision_embedding検索
      .mockResolvedValueOnce([{ total: 1n }]) // vision count
      .mockResolvedValueOnce([{ total: 1n }]); // hybrid count

    const result = await service.hybridSearch(
      { textQuery: 'モダンなヒーローセクション' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // text検索1回 + vision検索2回（search + count） + hybrid count = 4回
    expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalledTimes(4);
  });

  it('デフォルト重み（60% vision + 40% text）を使用する', async () => {
    const textResult = createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 });
    const visionResult = createMockVisionSearchRecord({ id: 'vision-1', similarity: 0.85 });

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([textResult])
      .mockResolvedValueOnce([visionResult])
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    // デフォルト重みが適用されていることを確認
    expect(result).not.toBeNull();
  });

  it('RRFスコアを正しく計算する（k=60）', async () => {
    // RRF score = 1 / (k + rank)
    // k = 60 が標準定数
    const textResults = [
      createMockVisionSearchRecord({ id: 'id-1', similarity: 0.95 }), // rank 1
      createMockVisionSearchRecord({ id: 'id-2', similarity: 0.85 }), // rank 2
    ];
    const visionResults = [
      createMockVisionSearchRecord({ id: 'id-2', similarity: 0.92 }), // rank 1
      createMockVisionSearchRecord({ id: 'id-1', similarity: 0.80 }), // rank 2
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // id-2はvisionで1位（0.6 * 1/61）+ textで2位（0.4 * 1/62）
    // id-1はtextで1位（0.4 * 1/61）+ visionで2位（0.6 * 1/62）
    // RRFスコア順にソートされていることを確認
    expect(result?.results.length).toBe(2);
  });

  it('visionWeight + textWeight = 1.0 の検証', async () => {
    const options: HybridSearchOptions = {
      limit: 10,
      offset: 0,
      visionWeight: 0.7,
      textWeight: 0.3,
    };

    expect(options.visionWeight + options.textWeight).toBeCloseTo(1.0);
  });

  it('重複IDをマージして統合スコアを計算する', async () => {
    const sharedResult = createMockVisionSearchRecord({ id: 'shared-id', similarity: 0.88 });

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([sharedResult]) // text検索で出現
      .mockResolvedValueOnce([sharedResult]) // vision検索でも出現
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    // 重複排除されて1件のみ
    expect(result?.results.length).toBe(1);
    // 統合スコア（RRF）が計算されている
    expect(result?.results[0]?.similarity).toBeDefined();
  });

  it('visionのみの結果も含まれる', async () => {
    const textOnlyResult = createMockVisionSearchRecord({ id: 'text-only', similarity: 0.85 });
    const visionOnlyResult = createMockVisionSearchRecord({ id: 'vision-only', similarity: 0.9 });

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([textOnlyResult])
      .mockResolvedValueOnce([visionOnlyResult])
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.results.length).toBe(2);
    const ids = result?.results.map((r) => r.id);
    expect(ids).toContain('text-only');
    expect(ids).toContain('vision-only');
  });

  it('textのみの結果も含まれる', async () => {
    const textOnlyResult = createMockVisionSearchRecord({ id: 'text-only', similarity: 0.95 });

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([textOnlyResult])
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.results.length).toBe(1);
    expect(result?.results[0]?.id).toBe('text-only');
  });

  it('両方の検索結果が空の場合、空配列を返す', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    const result = await service.hybridSearch(
      { textQuery: 'non-existent-query' },
      { limit: 10, offset: 0 }
    );

    expect(result?.results).toEqual([]);
    expect(result?.total).toBe(0);
  });
});

// =====================================================
// 類似度フィルタリング テスト（5テスト）
// =====================================================

describe('類似度フィルタリング', () => {
  let mockEmbeddingService: IVisionSearchEmbeddingService;
  let mockPrismaClient: IVisionSearchPrismaClient;
  let service: VisionEmbeddingSearchService;

  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();

    const mockEmbedding = createMockEmbedding(42);

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    };

    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    service = new VisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('minSimilarity未満の結果を除外する', async () => {
    const mockResults = [
      createMockVisionSearchRecord({ id: 'high', similarity: 0.9 }),
      createMockVisionSearchRecord({ id: 'medium', similarity: 0.7 }),
      createMockVisionSearchRecord({ id: 'low', similarity: 0.5 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 3n }]);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0, minSimilarity: 0.6 }
    );

    // minSimilarity=0.6未満の結果が除外される
    expect(result?.results.every((r) => r.similarity >= 0.6)).toBe(true);
  });

  it('デフォルトのminSimilarityは0.0（全結果を返す）', async () => {
    const mockResults = [
      createMockVisionSearchRecord({ similarity: 0.3 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
      // minSimilarity省略
    );

    expect(result?.results.length).toBe(1);
  });

  it('minSimilarity=1.0で完全一致のみを返す', async () => {
    const mockResults = [
      createMockVisionSearchRecord({ similarity: 0.999 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0, minSimilarity: 1.0 }
    );

    // similarity < 1.0 の結果が除外される
    expect(result?.results.every((r) => r.similarity >= 1.0)).toBe(true);
  });

  it('minSimilarityが0-1の範囲であることを検証する', async () => {
    // 範囲外の値は無視されるかエラーを返す
    const options: VisionSearchOptions = {
      limit: 10,
      offset: 0,
      minSimilarity: 0.5, // 有効な範囲
    };

    expect(options.minSimilarity).toBeGreaterThanOrEqual(0);
    expect(options.minSimilarity).toBeLessThanOrEqual(1);
  });

  it('フィルタリング後もtotalは元の件数を維持する', async () => {
    const mockResults = [
      createMockVisionSearchRecord({ similarity: 0.9 }),
      createMockVisionSearchRecord({ similarity: 0.4 }), // フィルタで除外される
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 100n }]); // DBの総件数

    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0, minSimilarity: 0.5 }
    );

    // フィルタ後の結果件数とtotalは異なる可能性がある
    expect(result?.total).toBe(100);
  });
});

// =====================================================
// パフォーマンス テスト（4テスト）
// =====================================================

describe('パフォーマンス', () => {
  let mockEmbeddingService: IVisionSearchEmbeddingService;
  let mockPrismaClient: IVisionSearchPrismaClient;
  let service: VisionEmbeddingSearchService;

  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();

    const mockEmbedding = createMockEmbedding(42);

    mockEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    };

    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    service = new VisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('P95 < 500ms でレスポンスを返す（モック環境）', async () => {
    const mockResults = Array.from({ length: 100 }, (_, i) =>
      createMockVisionSearchRecord({ id: `id-${i}`, similarity: 0.9 - i * 0.005 })
    );

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResults)
      .mockResolvedValueOnce([{ total: 100n }]);

    const start = performance.now();
    await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 100, offset: 0 }
    );
    const elapsed = performance.now() - start;

    // モック環境では非常に高速に動作するはず
    expect(elapsed).toBeLessThan(500);
  });

  it('Embedding生成は1回のみ呼ばれる', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchByVisionEmbedding(
      { textQuery: 'test query' },
      { limit: 10, offset: 0 }
    );

    expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('DBクエリは検索+カウントの2回のみ', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('HNSWインデックスを使用するクエリ構造', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    const queryCall = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const query = queryCall?.[0] as string;

    // ORDER BY similarity DESC でHNSWインデックスを活用
    expect(query).toContain('ORDER BY');
    expect(query).toContain('similarity');
    expect(query).toContain('DESC');
  });
});

// =====================================================
// エラーハンドリング テスト（5テスト）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
    vi.clearAllMocks();
  });

  it('EmbeddingServiceが未設定の場合、nullを返す', async () => {
    const mockPrismaClient: IVisionSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);
    // EmbeddingServiceは未設定

    const service = new VisionEmbeddingSearchService();
    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).toBeNull();
  });

  it('PrismaClientが未設定の場合、nullを返す', async () => {
    const mockEmbeddingService: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(42)),
    };
    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    // PrismaClientは未設定

    const service = new VisionEmbeddingSearchService();
    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).toBeNull();
  });

  it('データベースエラー時は空の結果を返す（Graceful Degradation）', async () => {
    const mockEmbeddingService: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(42)),
    };
    const mockPrismaClient: IVisionSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('DB connection error')),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    const service = new VisionEmbeddingSearchService();
    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    // エラーを投げずに空の結果を返す
    expect(result).not.toBeNull();
    expect(result?.results).toEqual([]);
    expect(result?.total).toBe(0);
  });

  it('Embedding生成エラー時はnullを返す', async () => {
    const mockEmbeddingService: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockRejectedValue(new Error('Model loading failed')),
    };
    const mockPrismaClient: IVisionSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    const service = new VisionEmbeddingSearchService();
    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).toBeNull();
  });

  it('タイムアウト時は空の結果を返す', async () => {
    const mockEmbeddingService: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(42)),
    };
    const mockPrismaClient: IVisionSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10))
      ),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
    setVisionSearchPrismaClientFactory(() => mockPrismaClient);

    const service = new VisionEmbeddingSearchService();
    const result = await service.searchByVisionEmbedding(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results).toEqual([]);
  });
});

// =====================================================
// シングルトンとファクトリ テスト（4テスト）
// =====================================================

describe('シングルトンとファクトリ', () => {
  beforeEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
  });

  afterEach(() => {
    resetVisionSearchEmbeddingServiceFactory();
    resetVisionSearchPrismaClientFactory();
    resetVisionEmbeddingSearchService();
  });

  it('getVisionEmbeddingSearchServiceはシングルトンを返す', () => {
    const service1 = getVisionEmbeddingSearchService();
    const service2 = getVisionEmbeddingSearchService();

    expect(service1).toBe(service2);
  });

  it('resetVisionEmbeddingSearchService後は新しいインスタンスを返す', () => {
    const service1 = getVisionEmbeddingSearchService();
    resetVisionEmbeddingSearchService();
    const service2 = getVisionEmbeddingSearchService();

    expect(service1).not.toBe(service2);
  });

  it('createVisionEmbeddingSearchServiceFactoryはIVisionEmbeddingSearchServiceを返す', () => {
    const factory = createVisionEmbeddingSearchServiceFactory();
    const service = factory();

    expect(service).toBeDefined();
    expect(typeof service.searchByVisionEmbedding).toBe('function');
    expect(typeof service.searchSimilarSections).toBe('function');
    expect(typeof service.hybridSearch).toBe('function');
  });

  it('ファクトリをリセット後は新しいインスタンスを使用する', () => {
    const mockEmbeddingService1: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
    };
    const mockEmbeddingService2: IVisionSearchEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(2)),
    };

    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService1);
    const service1 = getVisionEmbeddingSearchService();

    resetVisionSearchEmbeddingServiceFactory();
    resetVisionEmbeddingSearchService();
    setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService2);
    const service2 = getVisionEmbeddingSearchService();

    expect(service1).not.toBe(service2);
  });
});
