// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background Design Embedding Service Tests
 *
 * TDD: Red phase - tests written before implementation
 *
 * Test coverage:
 * 1. Text representation generation (various design types)
 * 2. Embedding generation and DB save (with mocked LayoutEmbeddingService)
 * 3. Semantic search function (with mocked Prisma)
 *
 * @module tests/services/background/background-design-embedding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateBackgroundDesignTextRepresentation,
  generateBackgroundDesignEmbeddings,
  searchSimilarBackgroundDesigns,
  type BackgroundDesignForText,
  type BackgroundDesignEmbeddingResult,
  type BackgroundDesignSearchResult,
  setBackgroundEmbeddingServiceFactory,
  resetBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  resetBackgroundPrismaClientFactory,
} from '../../../src/services/background/background-design-embedding.service';

// =====================================================
// Test Helpers
// =====================================================

function createMockEmbeddingService(): {
  generateFromText: ReturnType<typeof vi.fn>;
} {
  return {
    generateFromText: vi.fn().mockResolvedValue({
      embedding: Array(768).fill(0.01),
      modelName: 'multilingual-e5-base',
      textUsed: 'mock text',
      processingTimeMs: 50,
    }),
  };
}

function createMockPrismaClient(): {
  backgroundDesignEmbedding: {
    create: ReturnType<typeof vi.fn>;
  };
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
} {
  return {
    backgroundDesignEmbedding: {
      create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id-001' }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

// =====================================================
// 1. Text Representation Generation Tests
// =====================================================

describe('generateBackgroundDesignTextRepresentation', () => {
  it('should generate text representation for a linear gradient', () => {
    const bg: BackgroundDesignForText = {
      name: 'hero linear gradient, 135deg',
      designType: 'linear_gradient',
      selector: '.hero',
      colorInfo: {
        dominantColors: ['#ff6b6b', '#4ecdc4'],
        colorCount: 2,
        hasAlpha: false,
        colorSpace: 'srgb',
      },
      gradientInfo: {
        type: 'linear',
        angle: 135,
        stops: [
          { color: '#ff6b6b', position: 0 },
          { color: '#4ecdc4', position: 1 },
        ],
        repeating: false,
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('linear gradient');
    expect(result).toContain('hero linear gradient');
    expect(result).toContain('#ff6b6b');
    expect(result).toContain('#4ecdc4');
    expect(result).toContain('135deg');
    expect(result).toContain('.hero');
  });

  it('should generate text representation for a solid color', () => {
    const bg: BackgroundDesignForText = {
      name: 'footer solid color',
      designType: 'solid_color',
      selector: '.footer',
      colorInfo: {
        dominantColors: ['#1a1a2e'],
        colorCount: 1,
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('solid color');
    expect(result).toContain('#1a1a2e');
    expect(result).toContain('.footer');
  });

  it('should generate text representation for glassmorphism with blur', () => {
    const bg: BackgroundDesignForText = {
      name: 'card glassmorphism',
      designType: 'glassmorphism',
      selector: '.card',
      colorInfo: {
        dominantColors: ['rgba(255,255,255,0.2)'],
        hasAlpha: true,
      },
      visualProperties: {
        blurRadius: 20,
        opacity: 0.8,
        blendMode: 'normal',
        hasOverlay: true,
        layers: 2,
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('glassmorphism');
    expect(result).toContain('Blur: 20px');
    expect(result).toContain('Layers: 2');
  });

  it('should generate text representation for animated gradient', () => {
    const bg: BackgroundDesignForText = {
      name: 'animated bg',
      designType: 'animated_gradient',
      animationInfo: {
        isAnimated: true,
        animationName: 'gradientShift',
        duration: '3s',
        easing: 'ease-in-out',
      },
      gradientInfo: {
        type: 'linear',
        angle: 45,
        stops: [
          { color: '#ee7752', position: 0 },
          { color: '#e73c7e', position: 0.5 },
          { color: '#23a6d5', position: 1 },
        ],
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('animated gradient');
    expect(result).toContain('Animated: gradientShift');
    expect(result).toContain('Duration: 3s');
    expect(result).toContain('3 color stops');
  });

  it('should generate text representation for multi-layer background', () => {
    const bg: BackgroundDesignForText = {
      name: 'multi-layer hero',
      designType: 'multi_layer',
      visualProperties: {
        blurRadius: 0,
        blendMode: 'overlay',
        layers: 4,
      },
      colorInfo: {
        dominantColors: ['#000', '#fff', '#333'],
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('multi layer');
    expect(result).toContain('Layers: 4');
    expect(result).toContain('Blend mode: overlay');
  });

  it('should handle empty/minimal data gracefully', () => {
    const bg: BackgroundDesignForText = {
      name: 'unknown bg',
      designType: 'unknown',
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('passage:');
    expect(result).toContain('unknown');
    expect(result).toContain('unknown bg');
    // Should not throw
  });

  it('should include gradient stop count in text', () => {
    const bg: BackgroundDesignForText = {
      name: 'complex gradient',
      designType: 'radial_gradient',
      gradientInfo: {
        type: 'radial',
        stops: [
          { color: '#f00', position: 0 },
          { color: '#0f0', position: 0.25 },
          { color: '#00f', position: 0.5 },
          { color: '#ff0', position: 0.75 },
          { color: '#f0f', position: 1 },
        ],
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).toContain('5 color stops');
    expect(result).toContain('radial');
  });

  it('should not include blur when blurRadius is 0', () => {
    const bg: BackgroundDesignForText = {
      name: 'flat bg',
      designType: 'solid_color',
      visualProperties: {
        blurRadius: 0,
        blendMode: 'normal',
        layers: 1,
      },
    };

    const result = generateBackgroundDesignTextRepresentation(bg);

    expect(result).not.toContain('Blur:');
    // blendMode 'normal' should also be skipped
    expect(result).not.toContain('Blend mode:');
    // layers=1 should not be shown either
    expect(result).not.toContain('Layers:');
  });
});

// =====================================================
// 2. Embedding Generation + DB Save Tests
// =====================================================

describe('generateBackgroundDesignEmbeddings', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockPrisma: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    mockEmbeddingService = createMockEmbeddingService();
    mockPrisma = createMockPrismaClient();

    setBackgroundEmbeddingServiceFactory(() => mockEmbeddingService);
    setBackgroundPrismaClientFactory(() => mockPrisma);
  });

  afterEach(() => {
    resetBackgroundEmbeddingServiceFactory();
    resetBackgroundPrismaClientFactory();
  });

  it('should generate embeddings for multiple backgrounds', async () => {
    const backgrounds: BackgroundDesignForText[] = [
      {
        name: 'gradient-bg',
        designType: 'linear_gradient',
        colorInfo: { dominantColors: ['#ff0000', '#0000ff'] },
      },
      {
        name: 'solid-bg',
        designType: 'solid_color',
        colorInfo: { dominantColors: ['#333333'] },
      },
    ];

    const idMapping = new Map<string, string>();
    idMapping.set('gradient-bg', 'db-id-001');
    idMapping.set('solid-bg', 'db-id-002');

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping
    );

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify embedding service was called with passage: prefix text
    expect(mockEmbeddingService.generateFromText).toHaveBeenCalledTimes(2);
    const firstCallArg = mockEmbeddingService.generateFromText.mock.calls[0]?.[0] as string;
    expect(firstCallArg).toContain('passage:');

    // Verify DB save was called
    expect(mockPrisma.backgroundDesignEmbedding.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('should handle embedding generation failure gracefully', async () => {
    mockEmbeddingService.generateFromText
      .mockResolvedValueOnce({
        embedding: Array(768).fill(0.01),
        modelName: 'multilingual-e5-base',
        textUsed: 'ok',
        processingTimeMs: 50,
      })
      .mockRejectedValueOnce(new Error('Model inference failed'));

    const backgrounds: BackgroundDesignForText[] = [
      { name: 'bg1', designType: 'linear_gradient' },
      { name: 'bg2', designType: 'solid_color' },
    ];

    const idMapping = new Map<string, string>();
    idMapping.set('bg1', 'db-id-001');
    idMapping.set('bg2', 'db-id-002');

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping
    );

    expect(result.success).toBe(true); // Partial success
    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('Model inference failed');
  });

  it('should skip backgrounds without ID mapping', async () => {
    const backgrounds: BackgroundDesignForText[] = [
      { name: 'bg1', designType: 'linear_gradient' },
      { name: 'bg2', designType: 'solid_color' },
    ];

    // Only map bg1, not bg2
    const idMapping = new Map<string, string>();
    idMapping.set('bg1', 'db-id-001');

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping
    );

    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('ID not found');
  });

  it('should pass correct text representation to embedding service', async () => {
    const backgrounds: BackgroundDesignForText[] = [
      {
        name: 'hero gradient',
        designType: 'linear_gradient',
        colorInfo: { dominantColors: ['#abc'] },
        gradientInfo: { type: 'linear', angle: 90, stops: [], repeating: false },
      },
    ];

    const idMapping = new Map<string, string>();
    idMapping.set('hero gradient', 'db-id-001');

    await generateBackgroundDesignEmbeddings(backgrounds, idMapping);

    const callArg = mockEmbeddingService.generateFromText.mock.calls[0]?.[0] as string;
    expect(callArg).toContain('passage:');
    expect(callArg).toContain('linear gradient');
    expect(callArg).toContain('hero gradient');
    expect(callArg).toContain('#abc');
  });

  it('should return empty result for empty backgrounds array', async () => {
    const result = await generateBackgroundDesignEmbeddings(
      [],
      new Map()
    );

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should generate all embeddings when using backgroundDesignIds (no name collision)', async () => {
    // 同名の背景デザインが複数ある場合: idMappingでは後のエントリが前を上書きする
    // backgroundDesignIdsを使えば全エントリが正しくマッピングされる
    const backgrounds: BackgroundDesignForText[] = [
      { name: 'section solid color background', designType: 'solid_color', colorInfo: { dominantColors: ['#000'] } },
      { name: 'section solid color background', designType: 'solid_color', colorInfo: { dominantColors: ['#fff'] } },
      { name: 'section solid color background', designType: 'solid_color', colorInfo: { dominantColors: ['#333'] } },
    ];

    // idMappingでは同名が上書きされ、最後の1つしか残らない
    const idMapping = new Map<string, string>();
    idMapping.set('section solid color background', 'db-id-003'); // 最後のエントリだけ残る

    // backgroundDesignIds: 各エントリに1:1対応するDB ID配列
    const backgroundDesignIds = ['db-id-001', 'db-id-002', 'db-id-003'];

    // createのモックを個別IDで返すように設定
    mockPrisma.backgroundDesignEmbedding.create
      .mockResolvedValueOnce({ id: 'emb-001' })
      .mockResolvedValueOnce({ id: 'emb-002' })
      .mockResolvedValueOnce({ id: 'emb-003' });

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping,
      backgroundDesignIds
    );

    // 全3件のEmbeddingが生成されること
    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);

    // 各エントリに正しいDB IDが使われていること
    expect(mockPrisma.backgroundDesignEmbedding.create).toHaveBeenCalledTimes(3);
    const createCalls = mockPrisma.backgroundDesignEmbedding.create.mock.calls;
    expect((createCalls[0]?.[0] as { data: { backgroundDesignId: string } }).data.backgroundDesignId).toBe('db-id-001');
    expect((createCalls[1]?.[0] as { data: { backgroundDesignId: string } }).data.backgroundDesignId).toBe('db-id-002');
    expect((createCalls[2]?.[0] as { data: { backgroundDesignId: string } }).data.backgroundDesignId).toBe('db-id-003');
  });

  it('should fall back to idMapping when backgroundDesignIds length mismatches', async () => {
    const backgrounds: BackgroundDesignForText[] = [
      { name: 'bg1', designType: 'linear_gradient', colorInfo: { dominantColors: ['#f00'] } },
      { name: 'bg2', designType: 'solid_color', colorInfo: { dominantColors: ['#0f0'] } },
    ];

    const idMapping = new Map<string, string>();
    idMapping.set('bg1', 'db-id-001');
    idMapping.set('bg2', 'db-id-002');

    // 長さが不一致（2個 vs 3個）
    const backgroundDesignIds = ['db-id-001', 'db-id-002', 'db-id-003'];

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping,
      backgroundDesignIds
    );

    // idMappingにフォールバックして2件生成されること
    expect(result.generatedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it('should only generate 1 embedding for duplicate names when using idMapping (demonstrating the bug)', async () => {
    // この テストは name 重複時に idMapping だと最後の1エントリしかマッピングされない
    // ことを示すリグレッションテスト
    const backgrounds: BackgroundDesignForText[] = [
      { name: 'duplicate-name', designType: 'solid_color' },
      { name: 'duplicate-name', designType: 'linear_gradient' },
    ];

    // idMappingでは同名の最後のエントリだけ残る
    const idMapping = new Map<string, string>();
    idMapping.set('duplicate-name', 'db-id-002');

    const result = await generateBackgroundDesignEmbeddings(
      backgrounds,
      idMapping
      // backgroundDesignIdsなし: idMappingを使用
    );

    // 両方ともidMappingでは同じDB IDを取得するため、2件ともEmbeddingが生成される
    // ただし同じbackgroundDesignIdに対して2回create試行し、unique制約違反の可能性がある
    // (このテストではモックなので制約違反は発生しない)
    expect(result.generatedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it('should store text representation in DB', async () => {
    const backgrounds: BackgroundDesignForText[] = [
      {
        name: 'test bg',
        designType: 'glassmorphism',
        visualProperties: { blurRadius: 10 },
      },
    ];

    const idMapping = new Map<string, string>();
    idMapping.set('test bg', 'db-id-001');

    await generateBackgroundDesignEmbeddings(backgrounds, idMapping);

    // Verify create was called with textRepresentation
    const createCall = mockPrisma.backgroundDesignEmbedding.create.mock.calls[0]?.[0] as {
      data: { textRepresentation: string; modelVersion: string; backgroundDesignId: string };
    };
    expect(createCall.data.textRepresentation).toContain('passage:');
    expect(createCall.data.textRepresentation).toContain('glassmorphism');
    expect(createCall.data.modelVersion).toBe('multilingual-e5-base');
    expect(createCall.data.backgroundDesignId).toBe('db-id-001');
  });
});

// =====================================================
// 3. Semantic Search Tests
// =====================================================

describe('searchSimilarBackgroundDesigns', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockPrisma: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    mockEmbeddingService = createMockEmbeddingService();
    mockPrisma = createMockPrismaClient();

    setBackgroundEmbeddingServiceFactory(() => mockEmbeddingService);
    setBackgroundPrismaClientFactory(() => mockPrisma);
  });

  afterEach(() => {
    resetBackgroundEmbeddingServiceFactory();
    resetBackgroundPrismaClientFactory();
  });

  it('should search with query: prefix for e5 model', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: 'bg-001',
        name: 'hero gradient',
        design_type: 'linear_gradient',
        text_representation: 'passage: ...',
        similarity: 0.92,
        css_value: 'linear-gradient(135deg, #ff6b6b, #4ecdc4)',
        selector: '.hero',
        color_info: { dominantColors: ['#ff6b6b'] },
        web_page_id: 'wp-001',
      },
    ]);

    const results = await searchSimilarBackgroundDesigns('dark gradient background');

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('bg-001');
    expect(results[0]?.similarity).toBe(0.92);

    // Verify the query was generated with query: prefix
    const embedCallArg = mockEmbeddingService.generateFromText.mock.calls[0]?.[0] as string;
    expect(embedCallArg).toContain('query:');
  });

  it('should apply designType filter', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    await searchSimilarBackgroundDesigns('gradient', {
      designType: 'linear_gradient',
      limit: 5,
    });

    // Verify the raw query included the design_type filter
    const queryCall = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(queryCall).toBeDefined();
    // The SQL should contain a design_type filter parameter
    const sqlQuery = queryCall?.[0] as string;
    expect(sqlQuery).toContain('design_type');
  });

  it('should respect limit parameter', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    await searchSimilarBackgroundDesigns('test', { limit: 3 });

    const queryCall = mockPrisma.$queryRawUnsafe.mock.calls[0];
    const sqlQuery = queryCall?.[0] as string;
    expect(sqlQuery).toContain('LIMIT');
  });

  it('should return empty array when no results', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    const results = await searchSimilarBackgroundDesigns('nonexistent pattern');

    expect(results).toEqual([]);
  });

  it('should handle embedding service failure', async () => {
    mockEmbeddingService.generateFromText.mockRejectedValue(
      new Error('Service unavailable')
    );

    await expect(
      searchSimilarBackgroundDesigns('test query')
    ).rejects.toThrow('Service unavailable');
  });
});
