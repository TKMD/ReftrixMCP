// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLAnimationEmbeddingService Unit Tests
 *
 * TDD Red Phase: テキスト表現生成とEmbedding生成のテスト
 *
 * WebGLアニメーションパターンからEmbeddingを生成するサービスのテスト。
 * フレーム画像解析で検出されたWebGLアニメーションの特徴を
 * セマンティック検索可能な形式に変換する。
 *
 * @module tests/unit/services/motion/webgl-animation-embedding.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateWebGLAnimationTextRepresentation,
  WebGLAnimationEmbeddingService,
  type WebGLAnimationPatternData,
  DEFAULT_MODEL_NAME,
  DEFAULT_EMBEDDING_DIMENSIONS,
  setWebGLAnimationEmbeddingServiceFactory,
  resetWebGLAnimationEmbeddingServiceFactory,
  setWebGLPrismaClientFactory,
  resetWebGLPrismaClientFactory,
} from '../../../../src/services/motion/webgl-animation-embedding.service';

// =====================================================
// テストデータ
// =====================================================

const mockThreeJSWavePattern: WebGLAnimationPatternData = {
  id: '019bcebe-0001-7321-b174-fa44bf1a5c9a',
  category: 'wave',
  libraries: ['Three.js'],
  description: 'Perlin noise-based smooth color transitions',
  periodicity: {
    isPeriodic: true,
    cycleSeconds: 2.0,
    confidence: 0.95,
  },
  avgChangeRatio: 0.12,
  peakChangeRatio: 0.35,
  visualFeatures: ['gradient-colors', 'geometry-based-rendering'],
  canvasDimensions: {
    width: 1920,
    height: 1080,
  },
  webglVersion: 2,
  framesAnalyzed: 100,
  durationMs: 3333,
};

const mockParticlePattern: WebGLAnimationPatternData = {
  id: '019bcebe-0002-7321-b174-fa44bf1a5c9b',
  category: 'particle-system',
  libraries: ['Three.js', 'GSAP'],
  description: 'Particle system with physics simulation',
  periodicity: {
    isPeriodic: false,
    cycleSeconds: null,
    confidence: 0.2,
  },
  avgChangeRatio: 0.45,
  peakChangeRatio: 0.85,
  visualFeatures: ['particles', 'bloom-effect', 'velocity-based-color'],
  canvasDimensions: {
    width: 1280,
    height: 720,
  },
  webglVersion: 2,
  framesAnalyzed: 150,
  durationMs: 5000,
};

const mockMorphingPattern: WebGLAnimationPatternData = {
  id: '019bcebe-0003-7321-b174-fa44bf1a5c9c',
  category: 'morphing',
  libraries: ['Babylon.js'],
  description: '3D mesh morphing animation',
  periodicity: {
    isPeriodic: true,
    cycleSeconds: 4.5,
    confidence: 0.88,
  },
  avgChangeRatio: 0.28,
  peakChangeRatio: 0.72,
  visualFeatures: ['mesh-deformation', 'vertex-animation', 'normal-mapping'],
  canvasDimensions: {
    width: 1920,
    height: 1080,
  },
  webglVersion: 2,
  framesAnalyzed: 200,
  durationMs: 6666,
};

const mockMinimalPattern: WebGLAnimationPatternData = {
  id: '019bcebe-0004-7321-b174-fa44bf1a5c9d',
  category: 'unknown',
  libraries: [],
  avgChangeRatio: 0.05,
  canvasDimensions: {
    width: 800,
    height: 600,
  },
  webglVersion: 1,
};

// =====================================================
// 定数テスト
// =====================================================

describe('WebGLAnimationEmbedding Constants', () => {
  it('should have correct default model name', () => {
    expect(DEFAULT_MODEL_NAME).toBe('multilingual-e5-base');
  });

  it('should have correct embedding dimensions', () => {
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768);
  });
});

// =====================================================
// テキスト表現生成テスト
// =====================================================

describe('generateWebGLAnimationTextRepresentation', () => {
  describe('Three.js wave pattern', () => {
    it('should include category', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toContain('wave');
    });

    it('should include libraries', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toContain('Three.js');
    });

    it('should include description', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toContain('Perlin noise');
      expect(result).toContain('color transitions');
    });

    it('should include periodicity info for periodic animations', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toContain('periodic');
      expect(result).toMatch(/2.*second.*cycle|2-second cycle/i);
    });

    it('should include motion intensity', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toMatch(/0\.12|12%|moderate.*intensity/i);
    });

    it('should include visual features', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toContain('gradient');
      expect(result).toContain('geometry');
    });

    it('should include canvas dimensions', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toMatch(/1920.*1080|1920x1080/);
    });

    it('should include WebGL version', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toMatch(/WebGL.*2|WebGL2/i);
    });
  });

  describe('Particle system pattern', () => {
    it('should handle multiple libraries', () => {
      const result = generateWebGLAnimationTextRepresentation(mockParticlePattern);

      expect(result).toContain('Three.js');
      expect(result).toContain('GSAP');
    });

    it('should indicate non-periodic animation', () => {
      const result = generateWebGLAnimationTextRepresentation(mockParticlePattern);

      // non-periodicの場合は周期情報を含まないか、「非周期的」と表記
      expect(result).not.toMatch(/\d+.*second.*cycle/i);
    });

    it('should indicate high motion intensity', () => {
      const result = generateWebGLAnimationTextRepresentation(mockParticlePattern);

      // avgChangeRatio 0.45は高い
      expect(result).toMatch(/0\.45|45%|high.*intensity/i);
    });
  });

  describe('Morphing pattern', () => {
    it('should handle Babylon.js', () => {
      const result = generateWebGLAnimationTextRepresentation(mockMorphingPattern);

      expect(result).toContain('Babylon.js');
    });

    it('should include mesh-related features', () => {
      const result = generateWebGLAnimationTextRepresentation(mockMorphingPattern);

      expect(result).toContain('mesh');
      expect(result).toContain('vertex');
    });
  });

  describe('Minimal pattern', () => {
    it('should handle patterns with minimal data', () => {
      const result = generateWebGLAnimationTextRepresentation(mockMinimalPattern);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should indicate WebGL version 1', () => {
      const result = generateWebGLAnimationTextRepresentation(mockMinimalPattern);

      expect(result).toMatch(/WebGL.*1|WebGL1/i);
    });
  });

  describe('E5 model prefix', () => {
    it('should start with passage: prefix for indexing', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result).toMatch(/^passage:/);
    });
  });

  describe('Text representation format', () => {
    it('should produce consistent format for same input', () => {
      const result1 = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);
      const result2 = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result1).toBe(result2);
    });

    it('should not exceed reasonable length (500 chars)', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result.length).toBeLessThan(500);
    });

    it('should end with period', () => {
      const result = generateWebGLAnimationTextRepresentation(mockThreeJSWavePattern);

      expect(result.trimEnd()).toMatch(/\.$/);
    });
  });
});

// =====================================================
// WebGLAnimationEmbeddingService テスト
// =====================================================

describe('WebGLAnimationEmbeddingService', () => {
  let service: WebGLAnimationEmbeddingService;

  // モックEmbeddingService
  const mockEmbedding = new Array(768).fill(0).map(() => Math.random() * 2 - 1);
  const mockEmbeddingService = {
    generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => [...mockEmbedding]))
    ),
    getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
    clearCache: vi.fn(),
  };

  // モックPrismaClient
  const mockPrismaClient = {
    webGLAnimationEmbedding: {
      upsert: vi.fn().mockResolvedValue({ id: '019bcebe-emb1-7321-b174-fa44bf1a5c9a' }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setWebGLAnimationEmbeddingServiceFactory(() => mockEmbeddingService);
    setWebGLPrismaClientFactory(() => mockPrismaClient as never);
    service = new WebGLAnimationEmbeddingService({
      embeddingService: mockEmbeddingService,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWebGLAnimationEmbeddingServiceFactory();
    resetWebGLPrismaClientFactory();
  });

  describe('generateTextRepresentation', () => {
    it('should generate text representation for a pattern', () => {
      const result = service.generateTextRepresentation(mockThreeJSWavePattern);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('wave');
      expect(result).toContain('Three.js');
    });
  });

  describe('generateAndSave', () => {
    it('should generate 768-dimensional embedding', async () => {
      const result = await service.generateAndSave(
        mockThreeJSWavePattern,
        mockThreeJSWavePattern.id
      );

      expect(result.embedding).toHaveLength(768);
      expect(result.textRepresentation).toBeDefined();
      expect(result.modelVersion).toBe('multilingual-e5-base');
    });

    it('should call embeddingService.generateEmbedding with passage prefix', async () => {
      await service.generateAndSave(mockThreeJSWavePattern, mockThreeJSWavePattern.id);

      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledTimes(1);
      const callArg = mockEmbeddingService.generateEmbedding.mock.calls[0][0];
      expect(callArg).toMatch(/^passage:/);
    });

    it('should include textRepresentation in result', async () => {
      const result = await service.generateAndSave(
        mockThreeJSWavePattern,
        mockThreeJSWavePattern.id
      );

      expect(result.textRepresentation).toContain('wave');
      expect(result.textRepresentation).toContain('Three.js');
    });

    it('should include processingTimeMs in result', async () => {
      const result = await service.generateAndSave(
        mockThreeJSWavePattern,
        mockThreeJSWavePattern.id
      );

      expect(result.processingTimeMs).toBeDefined();
      expect(typeof result.processingTimeMs).toBe('number');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle minimal patterns', async () => {
      const result = await service.generateAndSave(
        mockMinimalPattern,
        mockMinimalPattern.id
      );

      expect(result.embedding).toHaveLength(768);
      expect(result.textRepresentation).toBeDefined();
    });
  });

  describe('findSimilar', () => {
    const mockSimilarResults = [
      { id: 'pattern-1', similarity: 0.95 },
      { id: 'pattern-2', similarity: 0.88 },
      { id: 'pattern-3', similarity: 0.72 },
    ];

    beforeEach(() => {
      // Mock the vector search query
      mockPrismaClient.$executeRawUnsafe.mockResolvedValue(mockSimilarResults);
    });

    it('should return similar patterns', async () => {
      const results = await service.findSimilar(mockEmbedding, { limit: 10 });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should respect limit option', async () => {
      await service.findSimilar(mockEmbedding, { limit: 5 });

      // Verify limit was passed to query
      expect(mockPrismaClient.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('should respect minSimilarity option', async () => {
      await service.findSimilar(mockEmbedding, { limit: 10, minSimilarity: 0.8 });

      // Verify minSimilarity filtering
      expect(mockPrismaClient.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('should handle empty results', async () => {
      mockPrismaClient.$executeRawUnsafe.mockResolvedValueOnce([]);

      const results = await service.findSimilar(mockEmbedding, { limit: 10 });

      expect(results).toHaveLength(0);
    });
  });

  describe('performance', () => {
    it('should complete single embedding generation within 200ms (mocked)', async () => {
      const startTime = Date.now();

      await service.generateAndSave(mockThreeJSWavePattern, mockThreeJSWavePattern.id);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(200);
    });

    it('should complete batch of 100 embeddings within 10s (mocked)', async () => {
      const patterns = Array(100).fill(mockThreeJSWavePattern).map((p, i) => ({
        ...p,
        id: `pattern-${i}`,
      }));
      const startTime = Date.now();

      for (const pattern of patterns) {
        await service.generateAndSave(pattern, pattern.id);
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('error handling', () => {
    it('should throw error when embedding service fails', async () => {
      mockEmbeddingService.generateEmbedding.mockRejectedValueOnce(
        new Error('Embedding service error')
      );

      await expect(
        service.generateAndSave(mockThreeJSWavePattern, mockThreeJSWavePattern.id)
      ).rejects.toThrow('Embedding service error');
    });

    it('should throw error for invalid pattern', async () => {
      const invalidPattern = { id: 'invalid' } as unknown as WebGLAnimationPatternData;

      await expect(
        service.generateAndSave(invalidPattern, 'invalid')
      ).rejects.toThrow();
    });

    it('should throw error for null pattern', async () => {
      await expect(
        service.generateAndSave(null as unknown as WebGLAnimationPatternData, 'test')
      ).rejects.toThrow('Invalid pattern');
    });
  });

  describe('L2 normalization', () => {
    it('should produce L2 normalized embeddings', async () => {
      const result = await service.generateAndSave(
        mockThreeJSWavePattern,
        mockThreeJSWavePattern.id
      );

      // L2ノルムが1に近いことを確認
      const norm = Math.sqrt(
        result.embedding.reduce((sum, val) => sum + val * val, 0)
      );
      expect(norm).toBeCloseTo(1.0, 1);
    });
  });
});

// =====================================================
// 統合テスト（DI Factory）
// =====================================================

describe('WebGLAnimationEmbeddingService DI Factory', () => {
  afterEach(() => {
    resetWebGLAnimationEmbeddingServiceFactory();
    resetWebGLPrismaClientFactory();
  });

  it('should use factory-provided embedding service', async () => {
    const customMockEmbedding = new Array(768).fill(0.5);
    const customEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(customMockEmbedding),
      generateBatchEmbeddings: vi.fn(),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    };

    setWebGLAnimationEmbeddingServiceFactory(() => customEmbeddingService);

    const service = new WebGLAnimationEmbeddingService();
    const result = await service.generateAndSave(
      mockThreeJSWavePattern,
      mockThreeJSWavePattern.id
    );

    expect(customEmbeddingService.generateEmbedding).toHaveBeenCalled();
    expect(result.embedding).toHaveLength(768);
  });

  it('should throw error when factory not set', async () => {
    resetWebGLAnimationEmbeddingServiceFactory();

    const service = new WebGLAnimationEmbeddingService();

    await expect(
      service.generateAndSave(mockThreeJSWavePattern, mockThreeJSWavePattern.id)
    ).rejects.toThrow('EmbeddingService not initialized');
  });
});
