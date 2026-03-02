// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Embedding Service Tests
 *
 * テスト対象:
 * 1. テキスト表現生成（各種レスポンシブ分析パターン）
 * 2. Embedding 生成 + DB 保存（DI パターン）
 * 3. Graceful Degradation（部分失敗時の挙動）
 *
 * @module tests/services/responsive/responsive-analysis-embedding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateResponsiveAnalysisTextRepresentation,
  generateResponsiveAnalysisEmbeddings,
  setResponsiveEmbeddingServiceFactory,
  resetResponsiveEmbeddingServiceFactory,
  setResponsivePrismaClientFactory,
  resetResponsivePrismaClientFactory,
  type ResponsiveAnalysisForText,
} from '../../../src/services/responsive/responsive-analysis-embedding.service';

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
  responsiveAnalysisEmbedding: {
    create: ReturnType<typeof vi.fn>;
  };
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
} {
  return {
    responsiveAnalysisEmbedding: {
      create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id-001' }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

function createFullAnalysis(overrides?: Partial<ResponsiveAnalysisForText>): ResponsiveAnalysisForText {
  return {
    id: 'ra-001',
    url: 'https://example.com',
    viewportsAnalyzed: [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 375, height: 667 },
    ],
    differences: [
      {
        category: 'layout',
        selector: '.grid',
        description: 'Grid columns change from 4 to 2',
        viewports: ['desktop', 'tablet'],
      },
      {
        category: 'navigation',
        selector: 'nav',
        description: 'Horizontal menu changes to hamburger',
        viewports: ['desktop', 'mobile'],
      },
    ],
    breakpoints: [
      { width: 768, type: 'major' },
      { width: 479, type: 'minor' },
    ],
    screenshotDiffs: [
      { viewport1: 'desktop', viewport2: 'tablet', diffPercentage: 45.1 },
      { viewport1: 'desktop', viewport2: 'mobile', diffPercentage: 67.3 },
    ],
    ...overrides,
  };
}

// =====================================================
// 1. Text Representation Generation Tests
// =====================================================

describe('generateResponsiveAnalysisTextRepresentation', () => {
  it('should include passage: prefix for E5 model', () => {
    const analysis = createFullAnalysis();
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toMatch(/^passage: /);
  });

  it('should include URL when provided', () => {
    const analysis = createFullAnalysis({ url: 'https://example.com/page' });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('https://example.com/page');
  });

  it('should handle missing URL', () => {
    const analysis = createFullAnalysis({ url: undefined });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('passage: Responsive analysis');
    expect(result).not.toContain('undefined');
  });

  it('should include viewport information', () => {
    const analysis = createFullAnalysis();
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('desktop(1920x1080)');
    expect(result).toContain('tablet(768x1024)');
    expect(result).toContain('mobile(375x667)');
  });

  it('should include difference categories and descriptions', () => {
    const analysis = createFullAnalysis();
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('[layout]');
    expect(result).toContain('.grid');
    expect(result).toContain('Grid columns change from 4 to 2');
    expect(result).toContain('[navigation]');
    expect(result).toContain('Horizontal menu changes to hamburger');
  });

  it('should include breakpoint values', () => {
    const analysis = createFullAnalysis();
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('768px');
    expect(result).toContain('479px');
  });

  it('should include screenshot diff percentages', () => {
    const analysis = createFullAnalysis();
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('desktop↔tablet 45.1%');
    expect(result).toContain('desktop↔mobile 67.3%');
  });

  it('should limit differences to 20 items', () => {
    const differences = Array.from({ length: 25 }, (_, i) => ({
      category: 'layout',
      selector: `.item-${i}`,
      description: `Change ${i}`,
    }));
    const analysis = createFullAnalysis({ differences });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);

    // 最初の20件は含まれる
    expect(result).toContain('.item-0');
    expect(result).toContain('.item-19');
    // 21件目以降は含まれない
    expect(result).not.toContain('.item-20');
    expect(result).not.toContain('.item-24');
  });

  it('should handle empty differences', () => {
    const analysis = createFullAnalysis({ differences: [] });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).not.toContain('Differences:');
  });

  it('should handle missing breakpoints', () => {
    const analysis = createFullAnalysis({ breakpoints: undefined });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).not.toContain('Breakpoints:');
  });

  it('should handle missing screenshot diffs', () => {
    const analysis = createFullAnalysis({ screenshotDiffs: undefined });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).not.toContain('Visual diff:');
  });

  it('should handle differences without selector', () => {
    const analysis = createFullAnalysis({
      differences: [
        { category: 'visibility', description: 'Sidebar hidden on mobile' },
      ],
    });
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toContain('[visibility]');
    expect(result).toContain('Sidebar hidden on mobile');
  });

  it('should handle minimal analysis data', () => {
    const analysis: ResponsiveAnalysisForText = {
      id: 'ra-minimal',
      viewportsAnalyzed: [],
      differences: [],
    };
    const result = generateResponsiveAnalysisTextRepresentation(analysis);
    expect(result).toMatch(/^passage: Responsive analysis$/);
  });
});

// =====================================================
// 2. Embedding Generation + DB Save Tests
// =====================================================

describe('generateResponsiveAnalysisEmbeddings', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockPrisma: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    mockEmbeddingService = createMockEmbeddingService();
    mockPrisma = createMockPrismaClient();
    setResponsiveEmbeddingServiceFactory(() => mockEmbeddingService);
    setResponsivePrismaClientFactory(() => mockPrisma);
  });

  afterEach(() => {
    resetResponsiveEmbeddingServiceFactory();
    resetResponsivePrismaClientFactory();
  });

  it('should return empty result for empty input', async () => {
    const result = await generateResponsiveAnalysisEmbeddings([]);
    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should generate embedding and save to DB for single analysis', async () => {
    const analysis = createFullAnalysis();
    const result = await generateResponsiveAnalysisEmbeddings([analysis]);

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    // EmbeddingService called with passage: prefixed text
    expect(mockEmbeddingService.generateFromText).toHaveBeenCalledTimes(1);
    const callArg = mockEmbeddingService.generateFromText.mock.calls[0]![0] as string;
    expect(callArg).toMatch(/^passage: /);

    // Prisma create called
    expect(mockPrisma.responsiveAnalysisEmbedding.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.responsiveAnalysisEmbedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        responsiveAnalysisId: 'ra-001',
        modelVersion: 'multilingual-e5-base',
      }),
    });

    // Raw SQL vector update called
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const sqlCall = mockPrisma.$executeRawUnsafe.mock.calls[0] as unknown[];
    expect(sqlCall[0]).toContain('UPDATE responsive_analysis_embeddings');
    expect(sqlCall[0]).toContain('$1::vector');
  });

  it('should process multiple analyses', async () => {
    const analyses = [
      createFullAnalysis({ id: 'ra-001' }),
      createFullAnalysis({ id: 'ra-002', url: 'https://example.com/page2' }),
      createFullAnalysis({ id: 'ra-003', url: 'https://example.com/page3' }),
    ];

    const result = await generateResponsiveAnalysisEmbeddings(analyses);

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(mockEmbeddingService.generateFromText).toHaveBeenCalledTimes(3);
    expect(mockPrisma.responsiveAnalysisEmbedding.create).toHaveBeenCalledTimes(3);
  });

  it('should call progress callback', async () => {
    const analyses = [
      createFullAnalysis({ id: 'ra-001' }),
      createFullAnalysis({ id: 'ra-002' }),
    ];

    const onProgress = vi.fn();
    await generateResponsiveAnalysisEmbeddings(analyses, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('should handle graceful degradation on individual failure', async () => {
    mockEmbeddingService.generateFromText
      .mockResolvedValueOnce({
        embedding: Array(768).fill(0.01),
        modelName: 'multilingual-e5-base',
        textUsed: 'text',
        processingTimeMs: 50,
      })
      .mockRejectedValueOnce(new Error('Embedding generation timeout'))
      .mockResolvedValueOnce({
        embedding: Array(768).fill(0.02),
        modelName: 'multilingual-e5-base',
        textUsed: 'text',
        processingTimeMs: 60,
      });

    const analyses = [
      createFullAnalysis({ id: 'ra-001' }),
      createFullAnalysis({ id: 'ra-002' }),
      createFullAnalysis({ id: 'ra-003' }),
    ];

    const result = await generateResponsiveAnalysisEmbeddings(analyses);

    expect(result.success).toBe(true);
    expect(result.generatedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      id: 'ra-002',
      error: 'Embedding generation timeout',
    });
  });

  it('should throw if EmbeddingService factory not set', async () => {
    resetResponsiveEmbeddingServiceFactory();
    const analysis = createFullAnalysis();

    await expect(
      generateResponsiveAnalysisEmbeddings([analysis])
    ).rejects.toThrow('ResponsiveEmbeddingService not initialized');
  });

  it('should throw if PrismaClient factory not set', async () => {
    resetResponsivePrismaClientFactory();
    const analysis = createFullAnalysis();

    await expect(
      generateResponsiveAnalysisEmbeddings([analysis])
    ).rejects.toThrow('ResponsivePrismaClient not initialized');
  });
});
