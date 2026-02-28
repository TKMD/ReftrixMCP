// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionEmbeddingSearchService Fallback Tests
 *
 * vision_embeddingフォールバック検索のユニットテスト
 *
 * テストカバレッジ:
 * - Graceful Degradation: vision_embedding null時のフォールバック（6テスト）
 * - Partial Vision Embedding: 一部のみvision_embedding存在時のRRFウェイト調整（5テスト）
 * - フォールバック通知: warnings, actualSearchMode, fallbackReason（5テスト）
 * - 統合シナリオ（4テスト）
 *
 * @module tests/services/vision-embedding-search-fallback.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VisionEmbeddingSearchService,
  setVisionSearchEmbeddingServiceFactory,
  resetVisionSearchEmbeddingServiceFactory,
  setVisionSearchPrismaClientFactory,
  resetVisionSearchPrismaClientFactory,
  resetVisionEmbeddingSearchService,
  type VisionSearchQuery,
  type HybridSearchOptions,
  type IVisionSearchEmbeddingService,
  type IVisionSearchPrismaClient,
  type VisionSearchServiceResult,
} from '../../src/services/vision-embedding-search.service';

// =====================================================
// テストヘルパー
// =====================================================

/**
 * モック用の768次元ベクトル生成
 */
function createMockEmbedding(seed: number = 0): number[] {
  const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i + seed) * 0.1);
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
  has_vision_embedding: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'section-id-1',
    web_page_id: overrides.web_page_id ?? 'page-id-1',
    section_type: overrides.section_type ?? 'hero',
    section_name: overrides.section_name ?? 'Hero Section',
    layout_info: overrides.layout_info ?? { type: 'hero' },
    visual_features: overrides.visual_features ?? { theme: { type: 'light' } },
    html_snippet: overrides.html_snippet ?? '<section>...</section>',
    similarity: overrides.similarity ?? 0.92,
    wp_id: overrides.wp_id ?? 'page-id-1',
    wp_url: overrides.wp_url ?? 'https://example.com',
    wp_title: overrides.wp_title ?? 'Example Site',
    wp_source_type: overrides.wp_source_type ?? 'user_provided',
    wp_usage_scope: overrides.wp_usage_scope ?? 'inspiration_only',
    wp_screenshot_desktop_url: overrides.wp_screenshot_desktop_url ?? null,
    has_vision_embedding: overrides.has_vision_embedding ?? true,
  };
}

// =====================================================
// Graceful Degradation テスト（6テスト）
// =====================================================

describe('Graceful Degradation: vision_embedding null時のフォールバック', () => {
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

  it('vision_embeddingがすべてnullの場合、fallbackToTextOnly: trueを返す', async () => {
    // vision検索結果が空（vision_embeddingがすべてnull）
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults) // text検索結果
      .mockResolvedValueOnce([]) // vision検索結果（空 = すべてnull）
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.fallbackToTextOnly).toBe(true);
    expect(result?.fallbackReason).toContain('vision_embedding');
  });

  it('combined検索要求時にvision_embeddingがない場合、text_onlyにフォールバック', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.85 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults) // text検索結果
      .mockResolvedValueOnce([]) // vision検索結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'modern hero section' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // text_onlyにフォールバックしたことを示す
    expect(result?.fallbackToTextOnly).toBe(true);
    // 結果はtext検索のみから得られる
    expect(result?.results.length).toBe(1);
    expect(result?.results[0]?.id).toBe('text-1');
  });

  it('フォールバック時にfallbackReasonが設定される', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.fallbackReason).toBeDefined();
    expect(result?.fallbackReason).toMatch(/vision_embedding.*not available|no vision_embedding/i);
  });

  it('vision_only検索でvision_embeddingがない場合、fallbackToTextOnly: trueを返す', async () => {
    // vision_only検索を模擬（visionWeight=1.0, textWeight=0）
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // text検索（weight=0でも実行される可能性）
      .mockResolvedValueOnce([]) // vision検索結果なし
      .mockResolvedValueOnce([{ total: 0n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 1.0, textWeight: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.fallbackToTextOnly).toBe(true);
    expect(result?.results).toEqual([]);
  });

  it('フォールバック時でも結果の形式は正常に維持される', async () => {
    const textResults = [
      createMockVisionSearchRecord({ id: 'text-1', similarity: 0.95 }),
      createMockVisionSearchRecord({ id: 'text-2', similarity: 0.85 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results).toHaveLength(2);
    expect(result?.total).toBe(2);
    // 各結果の必須フィールドが存在
    result?.results.forEach((r) => {
      expect(r.id).toBeDefined();
      expect(r.similarity).toBeDefined();
      expect(r.webPageId).toBeDefined();
    });
  });

  it('text検索もvision検索も結果がない場合、空配列を返す', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // text検索結果なし
      .mockResolvedValueOnce([]) // vision検索結果なし
      .mockResolvedValueOnce([{ total: 0n }]);

    const result = await service.hybridSearch(
      { textQuery: 'non-existent' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results).toEqual([]);
    expect(result?.total).toBe(0);
    // 結果がない場合でもfallbackは適切に設定される
    expect(result?.fallbackToTextOnly).toBe(true);
  });
});

// =====================================================
// Partial Vision Embedding テスト（5テスト）
// =====================================================

describe('Partial Vision Embedding: 一部のみvision_embedding存在時のRRFウェイト調整', () => {
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

  it('一部のセクションのみvision_embedding存在時、その割合に基づきRRFウェイトを調整する', async () => {
    // 10件中3件のみvision_embeddingあり（30%）
    const textResults = Array.from({ length: 10 }, (_, i) =>
      createMockVisionSearchRecord({ id: `section-${i}`, similarity: 0.9 - i * 0.02 })
    );
    const visionResults = [
      createMockVisionSearchRecord({ id: 'section-0', similarity: 0.95 }),
      createMockVisionSearchRecord({ id: 'section-3', similarity: 0.88 }),
      createMockVisionSearchRecord({ id: 'section-5', similarity: 0.82 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 10n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // vision_embeddingカバー率に関する情報が含まれる
    expect(result?.visionCoverageRatio).toBeDefined();
    expect(result?.visionCoverageRatio).toBeCloseTo(0.3, 1);
  });

  it('vision_embeddingカバー率が低い場合（<50%）、textWeightを増加させる', async () => {
    const textResults = Array.from({ length: 10 }, (_, i) =>
      createMockVisionSearchRecord({ id: `section-${i}`, similarity: 0.9 - i * 0.01 })
    );
    // 20%のみvision_embedding存在
    const visionResults = [
      createMockVisionSearchRecord({ id: 'section-0', similarity: 0.92 }),
      createMockVisionSearchRecord({ id: 'section-5', similarity: 0.85 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 10n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // 調整後のウェイトが返される
    expect(result?.adjustedWeights).toBeDefined();
    // textWeightが増加している
    expect(result?.adjustedWeights?.textWeight).toBeGreaterThan(0.4);
    // visionWeightが減少している
    expect(result?.adjustedWeights?.visionWeight).toBeLessThan(0.6);
  });

  it('vision_embeddingカバー率が高い場合（>=80%）、ウェイト調整なし', async () => {
    const textResults = Array.from({ length: 10 }, (_, i) =>
      createMockVisionSearchRecord({ id: `section-${i}`, similarity: 0.9 - i * 0.01 })
    );
    // 90%がvision_embedding存在
    const visionResults = Array.from({ length: 9 }, (_, i) =>
      createMockVisionSearchRecord({ id: `section-${i}`, similarity: 0.95 - i * 0.02 })
    );

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 10n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result).not.toBeNull();
    // ウェイト調整なし（または元の値のまま）
    if (result?.adjustedWeights) {
      expect(result.adjustedWeights.visionWeight).toBeCloseTo(0.6, 1);
      expect(result.adjustedWeights.textWeight).toBeCloseTo(0.4, 1);
    }
  });

  it('ウェイト調整後もRRFスコア計算が正しく行われる', async () => {
    const textResults = [
      createMockVisionSearchRecord({ id: 'id-1', similarity: 0.95 }), // textで1位
      createMockVisionSearchRecord({ id: 'id-2', similarity: 0.85 }), // textで2位
    ];
    const visionResults = [
      createMockVisionSearchRecord({ id: 'id-2', similarity: 0.92 }), // visionで1位
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
    expect(result?.results.length).toBe(2);
    // id-2はvisionで1位なので、調整後もRRFスコアに反映されるべき
    const id2Result = result?.results.find((r) => r.id === 'id-2');
    expect(id2Result).toBeDefined();
  });

  it('adjustedWeightsが常にtextWeight + visionWeight = 1.0を維持する', async () => {
    const textResults = Array.from({ length: 5 }, (_, i) =>
      createMockVisionSearchRecord({ id: `section-${i}`, similarity: 0.9 - i * 0.05 })
    );
    const visionResults = [
      createMockVisionSearchRecord({ id: 'section-0', similarity: 0.95 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 5n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    if (result?.adjustedWeights) {
      const sum = result.adjustedWeights.textWeight + result.adjustedWeights.visionWeight;
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });
});

// =====================================================
// フォールバック通知テスト（5テスト）
// =====================================================

describe('フォールバック通知: warnings, actualSearchMode, fallbackReason', () => {
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

  it('フォールバック時にwarnings配列に警告メッセージが追加される', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.warnings).toBeDefined();
    expect(Array.isArray(result?.warnings)).toBe(true);
    expect(result?.warnings?.length).toBeGreaterThan(0);
    expect(result?.warnings?.some((w) => w.includes('fallback') || w.includes('vision'))).toBe(true);
  });

  it('フォールバックなしの場合、warningsは空配列', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'shared-1', similarity: 0.9 })];
    const visionResults = [createMockVisionSearchRecord({ id: 'shared-1', similarity: 0.88 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.fallbackToTextOnly).toBeFalsy();
    expect(result?.warnings).toEqual([]);
  });

  it('actualSearchModeがフォールバック時にtext_onlyを返す', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0, visionWeight: 0.6, textWeight: 0.4 }
    );

    expect(result?.actualSearchMode).toBe('text_only');
  });

  it('フォールバックなしの場合、actualSearchModeがcombinedを返す', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'shared-1', similarity: 0.9 })];
    const visionResults = [createMockVisionSearchRecord({ id: 'shared-1', similarity: 0.92 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.actualSearchMode).toBe('combined');
  });

  it('fallbackReasonに具体的な理由が含まれる', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result?.fallbackReason).toBeDefined();
    // 具体的な理由が含まれている
    expect(result?.fallbackReason).toMatch(
      /vision_embedding.*null|no.*vision.*results|vision.*not.*available/i
    );
  });
});

// =====================================================
// 統合シナリオテスト（4テスト）
// =====================================================

describe('統合シナリオ', () => {
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

  it('新規インジェスト直後（vision_embeddingなし）のセクションを検索できる', async () => {
    // 新規インジェスト直後はtext_embeddingのみ存在
    const textResults = [
      createMockVisionSearchRecord({ id: 'new-section-1', similarity: 0.88 }),
      createMockVisionSearchRecord({ id: 'new-section-2', similarity: 0.82 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([]) // vision結果なし（まだ生成されていない）
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'モダンなヒーローセクション' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results.length).toBe(2);
    expect(result?.fallbackToTextOnly).toBe(true);
    expect(result?.warnings).toBeDefined();
  });

  it('古いデータ（vision_embeddingなし）と新しいデータ（vision_embeddingあり）の混在検索', async () => {
    const textResults = [
      createMockVisionSearchRecord({ id: 'old-section', similarity: 0.9 }),
      createMockVisionSearchRecord({ id: 'new-section', similarity: 0.85 }),
    ];
    const visionResults = [
      // 新しいセクションのみvision_embeddingあり
      createMockVisionSearchRecord({ id: 'new-section', similarity: 0.92 }),
    ];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce(visionResults)
      .mockResolvedValueOnce([{ total: 2n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results.length).toBe(2);
    // 両方のセクションが結果に含まれる
    const ids = result?.results.map((r) => r.id);
    expect(ids).toContain('old-section');
    expect(ids).toContain('new-section');
    // カバー率が50%であることを確認
    expect(result?.visionCoverageRatio).toBeCloseTo(0.5, 1);
  });

  it('DBエラー発生時でもGraceful Degradationで空結果を返す', async () => {
    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockRejectedValueOnce(new Error('Connection timeout'));

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    expect(result).not.toBeNull();
    expect(result?.results).toEqual([]);
    expect(result?.total).toBe(0);
  });

  it('レスポンス形式がVisionSearchServiceResult型に準拠する', async () => {
    const textResults = [createMockVisionSearchRecord({ id: 'text-1', similarity: 0.9 })];

    (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(textResults)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 1n }]);

    const result = await service.hybridSearch(
      { textQuery: 'test' },
      { limit: 10, offset: 0 }
    );

    // VisionSearchServiceResultの必須フィールド
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('total');

    // フォールバック関連フィールド
    expect(result).toHaveProperty('fallbackToTextOnly');
    expect(result).toHaveProperty('fallbackReason');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('actualSearchMode');
    expect(result).toHaveProperty('visionCoverageRatio');
    expect(result).toHaveProperty('adjustedWeights');
  });
});
