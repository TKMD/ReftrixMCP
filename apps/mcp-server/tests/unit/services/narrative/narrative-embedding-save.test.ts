// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * NarrativeAnalysisService - Embedding DB保存テスト
 *
 * TDD Red Phase: save() メソッドが DesignNarrativeEmbedding テーブルに
 * Embedding を保存することを検証するテスト。
 *
 * 問題: save() は designNarrative テーブルのみ upsert し、
 * designNarrativeEmbedding テーブルへの保存が欠落していた。
 *
 * @module tests/unit/services/narrative/narrative-embedding-save.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// Prisma モック
// =====================================================

const mockDesignNarrativeUpsert = vi.fn();
const mockDesignNarrativeEmbeddingUpsert = vi.fn();
const mockExecuteRawUnsafe = vi.fn();

vi.mock('@reftrix/database', () => ({
  prisma: {
    designNarrative: {
      upsert: (...args: unknown[]) => mockDesignNarrativeUpsert(...args),
    },
    designNarrativeEmbedding: {
      upsert: (...args: unknown[]) => mockDesignNarrativeEmbeddingUpsert(...args),
    },
    $executeRawUnsafe: (...args: unknown[]) => mockExecuteRawUnsafe(...args),
  },
}));

// EmbeddingService モック（generateEmbedding の依存）
vi.mock('../../../../src/services/layout-embedding.service', () => ({
  LayoutEmbeddingService: vi.fn().mockImplementation(() => ({
    generateFromText: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.01),
      modelName: 'multilingual-e5-base',
      dimensions: 768,
    }),
  })),
}));

import { NarrativeAnalysisService } from '../../../../src/services/narrative/narrative-analysis.service';
import type { NarrativeAnalysisResult } from '../../../../src/services/narrative/types/narrative.types';

// =====================================================
// テストデータ
// =====================================================

function createMockNarrativeResult(options?: {
  hasEmbedding?: boolean;
}): NarrativeAnalysisResult {
  const embedding = options?.hasEmbedding !== false
    ? new Array(768).fill(0.05)
    : undefined;

  const result: NarrativeAnalysisResult = {
    worldView: {
      moodCategory: 'elegant',
      moodDescription: 'Elegant and refined design with sophisticated color palette',
      colorImpression: {
        overall: 'warm and sophisticated',
        dominantEmotion: 'elegance',
        harmony: 'analogous' as const,
      },
      typographyPersonality: {
        style: 'serif',
        readability: 'high' as const,
        hierarchy: 'clear' as const,
      },
      overallTone: {
        primary: 'elegant',
        formality: 0.85,
        energy: 0.3,
      },
    },
    layoutStructure: {
      gridSystem: {
        type: 'css-grid' as const,
        columns: 12,
      },
      visualHierarchy: {
        primaryElements: ['hero-section'],
        secondaryElements: ['features'],
        tertiaryElements: ['footer'],
        sectionFlow: 'linear' as const,
        weightDistribution: { top: 0.5, middle: 0.35, bottom: 0.15 },
      },
      spacingRhythm: {
        baseUnit: '8px',
        scale: [1, 2, 3, 4, 6, 8],
        sectionGaps: { min: '24px', max: '80px', average: '48px' },
      },
      sectionRelationships: [],
      graphicElements: {
        imageLayout: {
          pattern: 'contained' as const,
          aspectRatios: ['16:9'],
          positions: ['hero'] as ('hero' | 'inline' | 'background' | 'decorative')[],
        },
        decorations: {
          hasGradients: false,
          hasShadows: true,
          hasBorders: false,
          hasIllustrations: false,
        },
        visualBalance: {
          symmetry: 'symmetric' as const,
          density: 'spacious' as const,
          whitespace: 0.55,
        },
      },
    },
    metadata: {
      textRepresentation: 'passage: Elegant design with sophisticated color palette and refined typography',
      confidence: {
        overall: 0.553,
        worldView: 0.6,
        layoutStructure: 0.5,
        breakdown: {
          visionAnalysis: 0.7,
          cssStaticAnalysis: 0.5,
          htmlStructureAnalysis: 0.4,
          motionAnalysis: 0.3,
        },
      },
      analysisTimeMs: 3000,
      visionUsed: true,
    },
  };

  if (embedding !== undefined) {
    result.metadata.embedding = embedding;
  }

  return result;
}

// =====================================================
// テスト
// =====================================================

describe('NarrativeAnalysisService.save() - Embedding DB保存', () => {
  let service: NarrativeAnalysisService;

  const TEST_WEB_PAGE_ID = '019c2a92-0000-7f42-81a7-000000000002';
  const TEST_NARRATIVE_ID = '019c2a92-0000-7f42-81a7-000000000001';
  const TEST_EMBEDDING_ID = '019c2a92-0000-7f42-81a7-000000000003';

  beforeEach(() => {
    vi.clearAllMocks();

    // DesignNarrative upsert のモック結果
    mockDesignNarrativeUpsert.mockResolvedValue({
      id: TEST_NARRATIVE_ID,
      webPageId: TEST_WEB_PAGE_ID,
      moodCategory: 'elegant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // DesignNarrativeEmbedding upsert のモック結果
    mockDesignNarrativeEmbeddingUpsert.mockResolvedValue({
      id: TEST_EMBEDDING_ID,
      designNarrativeId: TEST_NARRATIVE_ID,
      modelVersion: 'multilingual-e5-base',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Raw SQL 実行のモック結果
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    service = new NarrativeAnalysisService({
      enableEmbedding: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------
  // Core Test: Embedding が DB に保存されること
  // -------------------------------------------------

  it('should save embedding to DesignNarrativeEmbedding table when embedding exists in result', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });

    await service.save(TEST_WEB_PAGE_ID, result);

    // DesignNarrative が保存されること
    expect(mockDesignNarrativeUpsert).toHaveBeenCalledTimes(1);

    // DesignNarrativeEmbedding が保存されること（本バグの修正対象）
    expect(mockDesignNarrativeEmbeddingUpsert).toHaveBeenCalledTimes(1);
    expect(mockDesignNarrativeEmbeddingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { designNarrativeId: TEST_NARRATIVE_ID },
        create: expect.objectContaining({
          designNarrativeId: TEST_NARRATIVE_ID,
          textRepresentation: result.metadata.textRepresentation,
          modelVersion: 'multilingual-e5-base',
        }),
        update: expect.objectContaining({
          textRepresentation: result.metadata.textRepresentation,
          modelVersion: 'multilingual-e5-base',
        }),
      })
    );
  });

  it('should store embedding vector via raw SQL using pgvector format', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });

    await service.save(TEST_WEB_PAGE_ID, result);

    // pgvector形式でEmbeddingベクトルが更新されること
    expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE design_narrative_embeddings SET embedding'),
      expect.stringContaining('['), // vector string format
      TEST_EMBEDDING_ID
    );
  });

  // -------------------------------------------------
  // Embedding がない場合はスキップ
  // -------------------------------------------------

  it('should NOT save embedding when no embedding exists in result', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: false });

    await service.save(TEST_WEB_PAGE_ID, result);

    // DesignNarrative は保存されること
    expect(mockDesignNarrativeUpsert).toHaveBeenCalledTimes(1);

    // DesignNarrativeEmbedding は保存されないこと
    expect(mockDesignNarrativeEmbeddingUpsert).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  // -------------------------------------------------
  // Embedding保存失敗時のGraceful Degradation
  // -------------------------------------------------

  it('should still return saved narrative when embedding save fails (graceful degradation)', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });

    // Embedding保存が失敗するようにモック
    mockDesignNarrativeEmbeddingUpsert.mockRejectedValue(
      new Error('DB connection error for embedding')
    );

    // save() 自体はエラーを投げずに成功すること（Graceful Degradation）
    const saved = await service.save(TEST_WEB_PAGE_ID, result);

    expect(saved.id).toBe(TEST_NARRATIVE_ID);
    expect(saved.webPageId).toBe(TEST_WEB_PAGE_ID);

    // DesignNarrative は保存されていること
    expect(mockDesignNarrativeUpsert).toHaveBeenCalledTimes(1);
  });

  it('should still return saved narrative when vector SQL update fails (graceful degradation)', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });

    // Raw SQL実行が失敗するようにモック
    mockExecuteRawUnsafe.mockRejectedValue(
      new Error('pgvector extension error')
    );

    const saved = await service.save(TEST_WEB_PAGE_ID, result);

    expect(saved.id).toBe(TEST_NARRATIVE_ID);
    expect(saved.webPageId).toBe(TEST_WEB_PAGE_ID);
  });

  // -------------------------------------------------
  // SavedNarrative の返り値にembeddingSavedが含まれること
  // -------------------------------------------------

  it('should return embeddingSaved=true when embedding is saved successfully', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });

    const saved = await service.save(TEST_WEB_PAGE_ID, result);

    expect(saved.embeddingSaved).toBe(true);
  });

  it('should return embeddingSaved=false when no embedding in result', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: false });

    const saved = await service.save(TEST_WEB_PAGE_ID, result);

    expect(saved.embeddingSaved).toBe(false);
  });

  it('should return embeddingSaved=false when embedding save fails', async () => {
    const result = createMockNarrativeResult({ hasEmbedding: true });
    mockDesignNarrativeEmbeddingUpsert.mockRejectedValue(new Error('DB error'));

    const saved = await service.save(TEST_WEB_PAGE_ID, result);

    expect(saved.embeddingSaved).toBe(false);
  });
});
