// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Embedding Service Tests
 * TDD: Red Phase - Tests written before implementation
 *
 * Vision Embedding生成ロジック追加
 *
 * 視覚特徴量（VisionFeatures）からテキスト表現を生成し、
 * multilingual-e5-baseモデルで768次元の埋め込みベクトルを生成するサービスのテスト
 *
 * Covers:
 * - VisionFeatures型の定義と検証
 * - テキスト表現への変換（visionFeaturesToText）
 * - 768次元ベクトル出力
 * - L2正規化
 * - パフォーマンス要件（<200ms single, 10 items/sec batch）
 * - キャッシュ動作
 * - オプショナルフィールド（mood, brandTone）の処理
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Note: These imports will be implemented in the Green phase
import type { VisionFeatures } from '../src/embeddings/vision-embedding.types';
import {
  VisionEmbeddingService,
  visionEmbeddingService,
  createVisionEmbedding,
  createBatchVisionEmbeddings,
  visionFeaturesToText,
} from '../src/embeddings/vision-embedding.service';

describe('VisionEmbeddingService', () => {
  let service: VisionEmbeddingService;

  beforeAll(() => {
    service = new VisionEmbeddingService();
  });

  // ==========================================================================
  // VisionFeatures型の検証
  // ==========================================================================
  describe('VisionFeatures type validation', () => {
    it('should accept valid VisionFeatures with all required fields', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.3,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      expect(features.rhythm).toBe('regular');
      expect(features.whitespaceRatio).toBe(0.3);
      expect(features.density).toBe('moderate');
      expect(features.gravity).toBe('center');
      expect(features.theme).toBe('light');
    });

    it('should accept VisionFeatures with optional mood and brandTone', () => {
      const features: VisionFeatures = {
        rhythm: 'varied',
        whitespaceRatio: 0.5,
        density: 'sparse',
        gravity: 'top',
        theme: 'dark',
        mood: 'professional',
        brandTone: 'corporate',
      };

      expect(features.mood).toBe('professional');
      expect(features.brandTone).toBe('corporate');
    });

    it('should accept all rhythm values', () => {
      const rhythms: VisionFeatures['rhythm'][] = ['regular', 'varied', 'asymmetric'];

      rhythms.forEach((rhythm) => {
        const features: VisionFeatures = {
          rhythm,
          whitespaceRatio: 0.5,
          density: 'moderate',
          gravity: 'center',
          theme: 'light',
        };
        expect(features.rhythm).toBe(rhythm);
      });
    });

    it('should accept all density values', () => {
      const densities: VisionFeatures['density'][] = ['sparse', 'moderate', 'dense'];

      densities.forEach((density) => {
        const features: VisionFeatures = {
          rhythm: 'regular',
          whitespaceRatio: 0.5,
          density,
          gravity: 'center',
          theme: 'light',
        };
        expect(features.density).toBe(density);
      });
    });

    it('should accept all gravity values', () => {
      const gravities: VisionFeatures['gravity'][] = ['top', 'center', 'bottom', 'left', 'right'];

      gravities.forEach((gravity) => {
        const features: VisionFeatures = {
          rhythm: 'regular',
          whitespaceRatio: 0.5,
          density: 'moderate',
          gravity,
          theme: 'light',
        };
        expect(features.gravity).toBe(gravity);
      });
    });

    it('should accept all theme values', () => {
      const themes: VisionFeatures['theme'][] = ['light', 'dark', 'mixed'];

      themes.forEach((theme) => {
        const features: VisionFeatures = {
          rhythm: 'regular',
          whitespaceRatio: 0.5,
          density: 'moderate',
          gravity: 'center',
          theme,
        };
        expect(features.theme).toBe(theme);
      });
    });

    it('should accept whitespaceRatio in range 0-1', () => {
      const ratios = [0, 0.25, 0.5, 0.75, 1];

      ratios.forEach((ratio) => {
        const features: VisionFeatures = {
          rhythm: 'regular',
          whitespaceRatio: ratio,
          density: 'moderate',
          gravity: 'center',
          theme: 'light',
        };
        expect(features.whitespaceRatio).toBe(ratio);
      });
    });
  });

  // ==========================================================================
  // テキスト表現への変換
  // ==========================================================================
  describe('visionFeaturesToText', () => {
    it('should convert VisionFeatures to text representation', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.35,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const text = visionFeaturesToText(features);

      expect(text).toContain('visual_rhythm: regular');
      expect(text).toContain('whitespace_ratio: 0.35');
      expect(text).toContain('content_density: moderate');
      expect(text).toContain('visual_gravity: center');
      expect(text).toContain('color_theme: light');
    });

    it('should include mood when provided', () => {
      const features: VisionFeatures = {
        rhythm: 'varied',
        whitespaceRatio: 0.5,
        density: 'sparse',
        gravity: 'top',
        theme: 'dark',
        mood: 'professional',
      };

      const text = visionFeaturesToText(features);

      expect(text).toContain('mood: professional');
    });

    it('should include brandTone when provided', () => {
      const features: VisionFeatures = {
        rhythm: 'asymmetric',
        whitespaceRatio: 0.7,
        density: 'dense',
        gravity: 'bottom',
        theme: 'mixed',
        brandTone: 'playful',
      };

      const text = visionFeaturesToText(features);

      expect(text).toContain('brandTone: playful');
    });

    it('should include both mood and brandTone when provided', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.4,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        mood: 'elegant',
        brandTone: 'luxury',
      };

      const text = visionFeaturesToText(features);

      expect(text).toContain('mood: elegant');
      expect(text).toContain('brandTone: luxury');
    });

    it('should handle undefined mood gracefully', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        mood: undefined,
      };

      const text = visionFeaturesToText(features);

      // Should not include "mood: undefined" or "mood: null"
      expect(text).not.toContain('mood: undefined');
      expect(text).not.toContain('mood: null');
    });

    it('should handle undefined brandTone gracefully', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        brandTone: undefined,
      };

      const text = visionFeaturesToText(features);

      expect(text).not.toContain('brandTone: undefined');
      expect(text).not.toContain('brandTone: null');
    });

    it('should produce consistent text format', () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        mood: 'professional',
        brandTone: 'corporate',
      };

      const text = visionFeaturesToText(features);

      // Expected format (order may vary but should be comma-separated)
      expect(text).toMatch(/visual_rhythm:\s*regular/);
      expect(text).toMatch(/whitespace_ratio:\s*0\.5/);
      expect(text).toMatch(/content_density:\s*moderate/);
      expect(text).toMatch(/visual_gravity:\s*center/);
      expect(text).toMatch(/color_theme:\s*light/);
      expect(text).toMatch(/mood:\s*professional/);
      expect(text).toMatch(/brandTone:\s*corporate/);
    });
  });

  // ==========================================================================
  // 初期化
  // ==========================================================================
  describe('initialization', () => {
    it('should initialize successfully', () => {
      expect(service).toBeDefined();
    });

    it('should be a singleton when using default export', async () => {
      const { visionEmbeddingService: service1 } = await import(
        '../src/embeddings/vision-embedding.service'
      );
      const { visionEmbeddingService: service2 } = await import(
        '../src/embeddings/vision-embedding.service'
      );

      expect(service1).toBe(service2);
    });
  });

  // ==========================================================================
  // 単一埋め込み生成
  // ==========================================================================
  describe('generateVisionEmbedding', () => {
    it('should generate a 768-dimensional embedding from VisionFeatures', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.35,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding = await service.generateVisionEmbedding(features);

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);
      expect(embedding.every((v) => typeof v === 'number' && !isNaN(v))).toBe(true);
    });

    it('should produce L2 normalized embeddings', async () => {
      const features: VisionFeatures = {
        rhythm: 'varied',
        whitespaceRatio: 0.5,
        density: 'sparse',
        gravity: 'top',
        theme: 'dark',
      };

      const embedding = await service.generateVisionEmbedding(features);

      // Calculate L2 norm: sqrt(sum of squares)
      const l2Norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));

      // L2 norm should be approximately 1.0
      expect(l2Norm).toBeCloseTo(1.0, 4);
    });

    it('should generate embedding with optional mood', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.4,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        mood: 'professional',
      };

      const embedding = await service.generateVisionEmbedding(features);

      expect(embedding.length).toBe(768);
    });

    it('should generate embedding with optional brandTone', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.4,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
        brandTone: 'corporate',
      };

      const embedding = await service.generateVisionEmbedding(features);

      expect(embedding.length).toBe(768);
    });

    it('should generate different embeddings for different features', async () => {
      const features1: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.2,
        density: 'dense',
        gravity: 'top',
        theme: 'dark',
      };

      const features2: VisionFeatures = {
        rhythm: 'asymmetric',
        whitespaceRatio: 0.8,
        density: 'sparse',
        gravity: 'bottom',
        theme: 'light',
      };

      const embedding1 = await service.generateVisionEmbedding(features1);
      const embedding2 = await service.generateVisionEmbedding(features2);

      // Embeddings should be different
      const diff = embedding1.reduce((sum, val, i) => {
        return sum + Math.abs(val - (embedding2[i] ?? 0));
      }, 0);

      expect(diff).toBeGreaterThan(0.01);
    });

    it('should generate similar embeddings for similar features', async () => {
      const features1: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const features2: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.52, // slightly different
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding1 = await service.generateVisionEmbedding(features1);
      const embedding2 = await service.generateVisionEmbedding(features2);

      // Calculate cosine similarity
      const similarity = cosineSimilarity(embedding1, embedding2);

      // Similar features should have high similarity (> 0.9)
      expect(similarity).toBeGreaterThan(0.9);
    });
  });

  // ==========================================================================
  // パフォーマンス要件
  // ==========================================================================
  describe('performance', () => {
    it('should generate single embedding in under 200ms (after initialization)', async () => {
      // First call to ensure model is initialized
      const warmupFeatures: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };
      await service.generateVisionEmbedding(warmupFeatures);

      // Actual performance test with unique features (no cache)
      const testFeatures: VisionFeatures = {
        rhythm: 'varied',
        whitespaceRatio: 0.333,
        density: 'sparse',
        gravity: 'left',
        theme: 'dark',
        mood: 'unique-test-mood-' + Date.now(),
      };

      const startTime = performance.now();
      await service.generateVisionEmbedding(testFeatures);
      const elapsed = performance.now() - startTime;

      // Performance target: < 200ms for single embedding
      expect(elapsed).toBeLessThan(200);
    });

    it('should generate cached embedding in under 10ms', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      // First call to populate cache
      await service.generateVisionEmbedding(features);

      // Second call should be cached
      const startTime = performance.now();
      await service.generateVisionEmbedding(features);
      const elapsed = performance.now() - startTime;

      expect(elapsed).toBeLessThan(10);
    });
  });

  // ==========================================================================
  // バッチ埋め込み生成
  // ==========================================================================
  describe('generateBatchVisionEmbeddings', () => {
    it('should generate embeddings for multiple VisionFeatures', async () => {
      const featuresArray: VisionFeatures[] = [
        {
          rhythm: 'regular',
          whitespaceRatio: 0.3,
          density: 'moderate',
          gravity: 'center',
          theme: 'light',
        },
        {
          rhythm: 'varied',
          whitespaceRatio: 0.5,
          density: 'sparse',
          gravity: 'top',
          theme: 'dark',
        },
        {
          rhythm: 'asymmetric',
          whitespaceRatio: 0.7,
          density: 'dense',
          gravity: 'bottom',
          theme: 'mixed',
        },
      ];

      const embeddings = await service.generateBatchVisionEmbeddings(featuresArray);

      expect(embeddings.length).toBe(3);
      embeddings.forEach((embedding) => {
        expect(embedding.length).toBe(768);
      });
    });

    it('should handle empty array', async () => {
      const embeddings = await service.generateBatchVisionEmbeddings([]);

      expect(embeddings).toEqual([]);
    });

    it('should process batch at rate of 10 items/sec or better', async () => {
      // Generate 10 different features
      const featuresArray: VisionFeatures[] = Array.from({ length: 10 }, (_, i) => ({
        rhythm: (['regular', 'varied', 'asymmetric'] as const)[i % 3],
        whitespaceRatio: (i + 1) / 11,
        density: (['sparse', 'moderate', 'dense'] as const)[i % 3],
        gravity: (['top', 'center', 'bottom', 'left', 'right'] as const)[i % 5],
        theme: (['light', 'dark', 'mixed'] as const)[i % 3],
        mood: `mood-${i}`,
        brandTone: `brandTone-${i}`,
      }));

      const startTime = performance.now();
      const embeddings = await service.generateBatchVisionEmbeddings(featuresArray);
      const elapsed = performance.now() - startTime;

      expect(embeddings.length).toBe(10);
      // Performance target: 10 items/sec = 1000ms for 10 items
      // Allow 2x margin for test stability
      expect(elapsed).toBeLessThan(2000);
    }, 10000); // 10s timeout

    it('should process batch of 100 items in under 10 seconds', async () => {
      const featuresArray: VisionFeatures[] = Array.from({ length: 100 }, (_, i) => ({
        rhythm: (['regular', 'varied', 'asymmetric'] as const)[i % 3],
        whitespaceRatio: (i + 1) / 101,
        density: (['sparse', 'moderate', 'dense'] as const)[i % 3],
        gravity: (['top', 'center', 'bottom', 'left', 'right'] as const)[i % 5],
        theme: (['light', 'dark', 'mixed'] as const)[i % 3],
      }));

      const startTime = performance.now();
      const embeddings = await service.generateBatchVisionEmbeddings(featuresArray);
      const elapsed = performance.now() - startTime;

      expect(embeddings.length).toBe(100);
      expect(elapsed).toBeLessThan(10000);
    }, 15000); // 15s timeout
  });

  // ==========================================================================
  // キャッシュ
  // ==========================================================================
  describe('cache', () => {
    it('should cache embeddings and return same result', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding1 = await service.generateVisionEmbedding(features);
      const embedding2 = await service.generateVisionEmbedding(features);

      expect(embedding1).toEqual(embedding2);
    });

    it('should differentiate cache by features', async () => {
      const features1: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const features2: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'dark', // Different
      };

      const embedding1 = await service.generateVisionEmbedding(features1);
      const embedding2 = await service.generateVisionEmbedding(features2);

      // Different features should produce different embeddings (not from cache)
      expect(embedding1).not.toEqual(embedding2);
    });

    it('should report cache statistics', async () => {
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('size');
    });

    it('should allow clearing the cache', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      await service.generateVisionEmbedding(features);
      expect(service.getCacheStats().size).toBeGreaterThan(0);

      service.clearCache();
      expect(service.getCacheStats().size).toBe(0);
    });
  });

  // ==========================================================================
  // ヘルパー関数
  // ==========================================================================
  describe('helper functions', () => {
    it('createVisionEmbedding should be a convenience function', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0.5,
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding = await createVisionEmbedding(features);

      expect(embedding.length).toBe(768);
    });

    it('createBatchVisionEmbeddings should be a convenience function', async () => {
      const featuresArray: VisionFeatures[] = [
        {
          rhythm: 'regular',
          whitespaceRatio: 0.3,
          density: 'moderate',
          gravity: 'center',
          theme: 'light',
        },
        {
          rhythm: 'varied',
          whitespaceRatio: 0.7,
          density: 'sparse',
          gravity: 'top',
          theme: 'dark',
        },
      ];

      const embeddings = await createBatchVisionEmbeddings(featuresArray);

      expect(embeddings.length).toBe(2);
    });
  });

  // ==========================================================================
  // エラーハンドリング
  // ==========================================================================
  describe('error handling', () => {
    it('should handle extreme whitespaceRatio values gracefully', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 0, // edge case
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding = await service.generateVisionEmbedding(features);

      expect(embedding.length).toBe(768);
    });

    it('should handle whitespaceRatio of 1 gracefully', async () => {
      const features: VisionFeatures = {
        rhythm: 'regular',
        whitespaceRatio: 1, // edge case
        density: 'moderate',
        gravity: 'center',
        theme: 'light',
      };

      const embedding = await service.generateVisionEmbedding(features);

      expect(embedding.length).toBe(768);
    });
  });
});

// =============================================================================
// テストユーティリティ
// =============================================================================

/**
 * コサイン類似度を計算
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (normA * normB);
}
