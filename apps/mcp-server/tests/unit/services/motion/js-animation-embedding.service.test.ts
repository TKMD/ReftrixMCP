// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationEmbeddingService Unit Tests
 *
 * TDD: テキスト表現生成とEmbedding生成のテスト
 *
 * @module tests/unit/services/motion/js-animation-embedding.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateJSAnimationTextRepresentation,
  JSAnimationEmbeddingService,
  type JSAnimationPatternForEmbedding,
} from '../../../../src/services/motion/js-animation-embedding.service';

// =====================================================
// テストデータ
// =====================================================

const mockGSAPPattern: JSAnimationPatternForEmbedding = {
  id: '019b7fcb-b93b-7321-b174-fa44bf1a5c9a',
  libraryType: 'gsap',
  libraryVersion: '3.12.5',
  name: 'hero-slide-in',
  animationType: 'timeline',
  description: 'Hero section slide-in animation with stagger',
  targetSelector: '.hero-content > *',
  targetCount: 5,
  durationMs: 800,
  delayMs: 200,
  easing: 'power2.out',
  iterations: 1,
  direction: 'normal',
  keyframes: [
    { offset: 0, opacity: 0, transform: 'translateY(30px)' },
    { offset: 1, opacity: 1, transform: 'translateY(0)' },
  ],
  properties: ['opacity', 'transform'],
  triggerType: 'load',
  confidence: 0.95,
};

const mockFramerMotionPattern: JSAnimationPatternForEmbedding = {
  id: '019b7fcb-b93b-7321-b174-fa44bf1a5c9b',
  libraryType: 'framer_motion',
  name: 'card-hover-scale',
  animationType: 'spring',
  description: 'Card hover scale animation with spring physics',
  targetSelector: '.card',
  durationMs: 300,
  easing: 'spring(1, 80, 10, 0)',
  properties: ['scale', 'boxShadow'],
  triggerType: 'hover',
  confidence: 0.9,
};

const mockWebAnimationsAPIPattern: JSAnimationPatternForEmbedding = {
  id: '019b7fcb-b93b-7321-b174-fa44bf1a5c9c',
  libraryType: 'web_animations_api',
  name: 'fade-in-sequence',
  animationType: 'keyframe',
  targetSelector: '.fade-item',
  targetCount: 3,
  durationMs: 500,
  delayMs: 100,
  easing: 'ease-out',
  iterations: 1,
  direction: 'normal',
  fillMode: 'forwards',
  keyframes: [
    { offset: 0, opacity: 0 },
    { offset: 1, opacity: 1 },
  ],
  properties: ['opacity'],
  confidence: 0.92,
};

const mockMinimalPattern: JSAnimationPatternForEmbedding = {
  id: '019b7fcb-b93b-7321-b174-fa44bf1a5c9d',
  libraryType: 'unknown',
  name: 'unknown-animation',
  animationType: 'tween',
  properties: [],
};

// =====================================================
// テキスト表現生成テスト
// =====================================================

describe('generateJSAnimationTextRepresentation', () => {
  describe('GSAP pattern', () => {
    it('should include library type and version', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('gsap');
      expect(result).toContain('3.12.5');
    });

    it('should include animation type', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('timeline');
    });

    it('should include animation name', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('hero-slide-in');
    });

    it('should include target selector', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('.hero-content > *');
    });

    it('should include duration', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('800ms');
    });

    it('should include easing', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('power2.out');
    });

    it('should include properties', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('opacity');
      expect(result).toContain('transform');
    });

    it('should include trigger type', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('load');
    });

    it('should include description if provided', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toContain('Hero section slide-in animation with stagger');
    });
  });

  describe('Framer Motion pattern', () => {
    it('should handle spring animation type', () => {
      const result = generateJSAnimationTextRepresentation(mockFramerMotionPattern);

      expect(result).toContain('framer_motion');
      expect(result).toContain('spring');
    });

    it('should include hover trigger', () => {
      const result = generateJSAnimationTextRepresentation(mockFramerMotionPattern);

      expect(result).toContain('hover');
    });
  });

  describe('Web Animations API pattern', () => {
    it('should include keyframe information', () => {
      const result = generateJSAnimationTextRepresentation(mockWebAnimationsAPIPattern);

      expect(result).toContain('web_animations_api');
      expect(result).toContain('keyframe');
    });

    it('should include fill mode if provided', () => {
      const result = generateJSAnimationTextRepresentation(mockWebAnimationsAPIPattern);

      expect(result).toContain('forwards');
    });
  });

  describe('Minimal pattern', () => {
    it('should handle patterns with minimal data', () => {
      const result = generateJSAnimationTextRepresentation(mockMinimalPattern);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('unknown');
      expect(result).toContain('tween');
    });
  });

  describe('E5 model prefix', () => {
    it('should start with passage: prefix for indexing', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result).toMatch(/^passage:/);
    });
  });

  describe('Text representation format', () => {
    it('should produce consistent format for similar patterns', () => {
      const result1 = generateJSAnimationTextRepresentation(mockGSAPPattern);
      const result2 = generateJSAnimationTextRepresentation(mockGSAPPattern);

      expect(result1).toBe(result2);
    });

    it('should not exceed reasonable length', () => {
      const result = generateJSAnimationTextRepresentation(mockGSAPPattern);

      // 合理的な長さ（500文字以内）
      expect(result.length).toBeLessThan(500);
    });
  });
});

// =====================================================
// JSAnimationEmbeddingService テスト
// =====================================================

describe('JSAnimationEmbeddingService', () => {
  let service: JSAnimationEmbeddingService;

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

  beforeEach(() => {
    vi.clearAllMocks();
    service = new JSAnimationEmbeddingService({
      embeddingService: mockEmbeddingService,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateEmbedding', () => {
    it('should generate 768-dimensional embedding for a pattern', async () => {
      const result = await service.generateEmbedding(mockGSAPPattern);

      expect(result.embedding).toHaveLength(768);
      expect(result.textRepresentation).toBeDefined();
      expect(result.modelVersion).toBe('multilingual-e5-base');
    });

    it('should call embeddingService.generateEmbedding with passage prefix', async () => {
      await service.generateEmbedding(mockGSAPPattern);

      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledTimes(1);
      const callArg = mockEmbeddingService.generateEmbedding.mock.calls[0][0];
      expect(callArg).toMatch(/^passage:/);
    });

    it('should include textRepresentation in result', async () => {
      const result = await service.generateEmbedding(mockGSAPPattern);

      expect(result.textRepresentation).toContain('gsap');
      expect(result.textRepresentation).toContain('timeline');
    });

    it('should handle minimal patterns', async () => {
      const result = await service.generateEmbedding(mockMinimalPattern);

      expect(result.embedding).toHaveLength(768);
      expect(result.textRepresentation).toBeDefined();
    });
  });

  describe('generateBatchEmbeddings', () => {
    it('should generate embeddings for multiple patterns', async () => {
      const patterns = [mockGSAPPattern, mockFramerMotionPattern, mockWebAnimationsAPIPattern];

      const results = await service.generateBatchEmbeddings(patterns);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.embedding).toHaveLength(768);
        expect(result.textRepresentation).toBeDefined();
      });
    });

    it('should call embeddingService.generateBatchEmbeddings', async () => {
      const patterns = [mockGSAPPattern, mockFramerMotionPattern];

      await service.generateBatchEmbeddings(patterns);

      expect(mockEmbeddingService.generateBatchEmbeddings).toHaveBeenCalledTimes(1);
      const callArg = mockEmbeddingService.generateBatchEmbeddings.mock.calls[0][0];
      expect(callArg).toHaveLength(2);
    });

    it('should return empty array for empty input', async () => {
      const results = await service.generateBatchEmbeddings([]);

      expect(results).toHaveLength(0);
    });
  });

  describe('performance', () => {
    it('should complete single embedding generation within 200ms (mocked)', async () => {
      const startTime = Date.now();

      await service.generateEmbedding(mockGSAPPattern);

      const elapsed = Date.now() - startTime;
      // モックなので非常に速いはず
      expect(elapsed).toBeLessThan(200);
    });

    it('should complete batch of 100 embeddings within 10s (mocked)', async () => {
      const patterns = Array(100).fill(mockGSAPPattern);
      const startTime = Date.now();

      await service.generateBatchEmbeddings(patterns);

      const elapsed = Date.now() - startTime;
      // モックなので非常に速いはず
      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('error handling', () => {
    it('should throw error when embedding service fails', async () => {
      mockEmbeddingService.generateEmbedding.mockRejectedValueOnce(
        new Error('Embedding service error')
      );

      await expect(service.generateEmbedding(mockGSAPPattern)).rejects.toThrow(
        'Embedding service error'
      );
    });

    it('should handle invalid pattern gracefully', async () => {
      const invalidPattern = { id: 'invalid' } as unknown as JSAnimationPatternForEmbedding;

      // 最小限の情報でもエラーにならないことを確認
      // ただし、必須フィールドがない場合はエラーになる可能性
      await expect(service.generateEmbedding(invalidPattern)).rejects.toThrow();
    });
  });
});
