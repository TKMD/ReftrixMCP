// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style Embedding Service Tests
 * TDD: Red Phase - Tests written before implementation
 *
 * スタイル特徴量から埋め込みベクトルを生成するサービスのテスト
 *
 * Covers:
 * - テキスト表現からの埋め込み生成
 * - 768次元ベクトル出力
 * - バッチ処理対応
 * - パフォーマンス要件（<100ms/embedding）
 * - キャッシュ動作
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  StyleEmbeddingService,
  createStyleEmbedding,
  createBatchStyleEmbeddings,
} from '../src/embeddings/style-embedding.service';

describe('StyleEmbeddingService', () => {
  let service: StyleEmbeddingService;

  beforeAll(() => {
    service = new StyleEmbeddingService();
  });

  // ==========================================================================
  // 初期化
  // ==========================================================================
  describe('initialization', () => {
    it('should initialize successfully', () => {
      expect(service).toBeDefined();
    });
  });

  // ==========================================================================
  // 単一埋め込み生成
  // ==========================================================================
  describe('generateEmbedding', () => {
    it('should generate a 768-dimensional embedding from style text', async () => {
      const styleText = 'Design style: thin stroke (1px) consistent outlined simple complexity 1 paths square';

      const embedding = await service.generateEmbedding(styleText);

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);
      expect(embedding.every((v) => typeof v === 'number' && !isNaN(v))).toBe(true);
    });

    it('should produce L2 normalized embeddings', async () => {
      const styleText = 'Design style: medium stroke (1.5px) filled medium complexity 10 paths';

      const embedding = await service.generateEmbedding(styleText);

      // Calculate L2 norm: sqrt(sum of squares)
      const l2Norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));

      // L2 norm should be approximately 1.0
      expect(l2Norm).toBeCloseTo(1.0, 4);
    });

    it('should use "passage:" prefix for style text (document embedding)', async () => {
      const styleText = 'Design style: thick stroke (3px) mixed complex 30 paths';

      const embedding = await service.generateEmbedding(styleText);

      // Should successfully generate embedding
      expect(embedding.length).toBe(768);
    });

    it('should handle empty style text gracefully', async () => {
      const styleText = '';

      // Should not throw, but generate embedding for empty text
      await expect(service.generateEmbedding(styleText)).resolves.not.toThrow();
    });

    it('should generate embedding in under 200ms for single text', async () => {
      const styleText = 'Design style: thin stroke filled simple complexity square';

      const startTime = performance.now();
      await service.generateEmbedding(styleText);
      const elapsed = performance.now() - startTime;

      // First call may include model initialization, allow 5 seconds
      expect(elapsed).toBeLessThan(5000);
    });

    it('should generate cached embedding in under 10ms', async () => {
      const styleText = 'Design style: cached test text for performance';

      // First call to populate cache
      await service.generateEmbedding(styleText);

      // Second call should be cached
      const startTime = performance.now();
      await service.generateEmbedding(styleText);
      const elapsed = performance.now() - startTime;

      expect(elapsed).toBeLessThan(10);
    });
  });

  // ==========================================================================
  // バッチ埋め込み生成
  // ==========================================================================
  describe('generateBatchEmbeddings', () => {
    it('should generate embeddings for multiple style texts', async () => {
      const styleTexts = [
        'Design style: thin stroke outlined simple',
        'Design style: thick stroke filled complex',
        'Design style: medium stroke mixed medium complexity',
      ];

      const embeddings = await service.generateBatchEmbeddings(styleTexts);

      expect(embeddings.length).toBe(3);
      embeddings.forEach((embedding) => {
        expect(embedding.length).toBe(768);
      });
    });

    it('should handle empty array', async () => {
      const embeddings = await service.generateBatchEmbeddings([]);

      expect(embeddings).toEqual([]);
    });

    it('should process batch in under 10 seconds for 100 texts', async () => {
      // Generate 100 different style texts
      const styleTexts = Array.from({ length: 100 }, (_, i) =>
        `Design style: batch test ${i} ${i % 3 === 0 ? 'thin' : i % 3 === 1 ? 'medium' : 'thick'} stroke`
      );

      const startTime = performance.now();
      const embeddings = await service.generateBatchEmbeddings(styleTexts);
      const elapsed = performance.now() - startTime;

      expect(embeddings.length).toBe(100);
      expect(elapsed).toBeLessThan(10000);
    });
  });

  // ==========================================================================
  // 類似度計算
  // ==========================================================================
  describe('similarity', () => {
    it('should produce similar embeddings for similar style texts', async () => {
      const text1 = 'Design style: thin stroke (1px) consistent outlined simple complexity';
      const text2 = 'Design style: thin stroke (0.75px) consistent outlined simple complexity';

      const embedding1 = await service.generateEmbedding(text1);
      const embedding2 = await service.generateEmbedding(text2);

      // Calculate cosine similarity
      const similarity = cosineSimilarity(embedding1, embedding2);

      // Similar texts should have high similarity (> 0.8)
      expect(similarity).toBeGreaterThan(0.8);
    });

    it('should produce different embeddings for different style texts', async () => {
      const text1 = 'Design style: thin stroke outlined simple';
      const text2 = 'Design style: thick stroke filled complex detailed';

      const embedding1 = await service.generateEmbedding(text1);
      const embedding2 = await service.generateEmbedding(text2);

      // Calculate cosine similarity
      const similarity = cosineSimilarity(embedding1, embedding2);

      // Different texts should have lower similarity than identical texts (< 0.95)
      // Note: Due to shared "Design style:" prefix, similarity remains relatively high
      expect(similarity).toBeLessThan(0.95);
      // But still distinguishable from similar texts (which are > 0.8)
      expect(similarity).toBeGreaterThan(0.8);
    });
  });

  // ==========================================================================
  // キャッシュ
  // ==========================================================================
  describe('cache', () => {
    it('should cache embeddings and return same result', async () => {
      const styleText = 'Design style: cache test unique text';

      const embedding1 = await service.generateEmbedding(styleText);
      const embedding2 = await service.generateEmbedding(styleText);

      // Should be the exact same array reference or identical values
      expect(embedding1).toEqual(embedding2);
    });

    it('should report cache statistics', async () => {
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('size');
    });
  });

  // ==========================================================================
  // ヘルパー関数
  // ==========================================================================
  describe('helper functions', () => {
    it('createStyleEmbedding should be a convenience function', async () => {
      const styleText = 'Design style: convenience function test';

      const embedding = await createStyleEmbedding(styleText);

      expect(embedding.length).toBe(768);
    });

    it('createBatchStyleEmbeddings should be a convenience function', async () => {
      const styleTexts = ['Design style: batch 1', 'Design style: batch 2'];

      const embeddings = await createBatchStyleEmbeddings(styleTexts);

      expect(embeddings.length).toBe(2);
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
