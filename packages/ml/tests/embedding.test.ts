// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Service Tests
 * TDD: Red Phase - Tests written before implementation
 *
 * Covers:
 * - Single text embedding generation
 * - Batch embedding generation
 * - E5 prefix handling (query: / passage:)
 * - 768-dimensional vector output
 * - L2 normalization
 * - Caching behavior
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Note: Import will be implemented in the Green phase
// import { EmbeddingService, embeddingService } from '../src/embeddings/service';

describe('EmbeddingService', () => {
  describe('initialization', () => {
    it('should initialize the model lazily on first use', async () => {
      // The model should not be loaded until generateEmbedding is called
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      expect(service.isInitialized()).toBe(false);

      await service.generateEmbedding('test query', 'query');

      expect(service.isInitialized()).toBe(true);
    });

    it('should be a singleton when using default export', async () => {
      const { embeddingService: service1 } = await import('../src/embeddings/service');
      const { embeddingService: service2 } = await import('../src/embeddings/service');

      expect(service1).toBe(service2);
    });
  });

  describe('generateEmbedding', () => {
    it('should generate a 768-dimensional embedding for a single text', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const embedding = await embeddingService.generateEmbedding('blue bird icon', 'query');

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);
      expect(embedding.every((v: number) => typeof v === 'number' && !isNaN(v))).toBe(true);
    });

    it('should apply "query:" prefix for query type', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      // Embeddings for the same text should differ based on prefix
      const queryEmbedding = await embeddingService.generateEmbedding('apple', 'query');
      const passageEmbedding = await embeddingService.generateEmbedding('apple', 'passage');

      // The embeddings should be different due to different prefixes
      const diff = queryEmbedding.reduce((sum: number, val: number, i: number) => {
        return sum + Math.abs(val - passageEmbedding[i]);
      }, 0);

      expect(diff).toBeGreaterThan(0.01);
    });

    it('should apply "passage:" prefix for passage type', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const embedding = await embeddingService.generateEmbedding('This is a test passage about birds.', 'passage');

      expect(embedding.length).toBe(768);
    });

    it('should produce L2 normalized embeddings', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const embedding = await embeddingService.generateEmbedding('test normalization', 'query');

      // Calculate L2 norm: sqrt(sum of squares)
      const l2Norm = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0));

      // L2 norm should be approximately 1.0 for normalized vectors
      expect(l2Norm).toBeCloseTo(1.0, 2);
    });

    it('should handle Japanese text correctly', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const embedding = await embeddingService.generateEmbedding('青い鳥のアイコン', 'query');

      expect(embedding.length).toBe(768);
      expect(embedding.every((v: number) => typeof v === 'number' && !isNaN(v))).toBe(true);
    });

    it('should handle empty string gracefully', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      // Empty string should still produce a valid embedding
      const embedding = await embeddingService.generateEmbedding('', 'query');

      expect(embedding.length).toBe(768);
    });
  });

  describe('generateBatchEmbeddings', () => {
    it('should generate embeddings for multiple texts', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const texts = ['red apple', 'blue bird', 'green tree'];
      const embeddings = await embeddingService.generateBatchEmbeddings(texts, 'passage');

      expect(embeddings.length).toBe(3);
      expect(embeddings.every((e: number[]) => e.length === 768)).toBe(true);
    });

    it('should handle large batch sizes', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const texts = Array.from({ length: 50 }, (_, i) => `test text ${i}`);
      const embeddings = await embeddingService.generateBatchEmbeddings(texts, 'passage');

      expect(embeddings.length).toBe(50);
    });

    it('should process batch within acceptable time (< 10s for 100 items)', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const texts = Array.from({ length: 100 }, (_, i) => `test text number ${i}`);

      const startTime = Date.now();
      await embeddingService.generateBatchEmbeddings(texts, 'passage');
      const elapsedTime = Date.now() - startTime;

      // Performance target: < 10s for batch of 100
      expect(elapsedTime).toBeLessThan(10000);
    }, 15000); // 15s timeout for this test

    it('should handle empty array', async () => {
      const { embeddingService } = await import('../src/embeddings/service');

      const embeddings = await embeddingService.generateBatchEmbeddings([], 'passage');

      expect(embeddings).toEqual([]);
    });
  });

  describe('caching', () => {
    it('should cache embeddings for repeated queries', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      const text = 'cached test query';

      // First call - cache miss
      const startTime1 = Date.now();
      const embedding1 = await service.generateEmbedding(text, 'query');
      const time1 = Date.now() - startTime1;

      // Second call - cache hit, should be faster
      const startTime2 = Date.now();
      const embedding2 = await service.generateEmbedding(text, 'query');
      const time2 = Date.now() - startTime2;

      // Results should be identical
      expect(embedding1).toEqual(embedding2);

      // Second call should be significantly faster (cache hit)
      // Allow for some variance in timing
      expect(time2).toBeLessThan(time1 * 0.5);
    });

    it('should differentiate cache by text type (query vs passage)', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      const text = 'test for cache differentiation';

      const queryEmbedding = await service.generateEmbedding(text, 'query');
      const passageEmbedding = await service.generateEmbedding(text, 'passage');

      // Should not return cached value for different type
      expect(queryEmbedding).not.toEqual(passageEmbedding);
    });

    it('should expose cache statistics', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      await service.generateEmbedding('stat test 1', 'query');
      await service.generateEmbedding('stat test 1', 'query'); // Cache hit
      await service.generateEmbedding('stat test 2', 'query');

      const stats = service.getCacheStats();

      expect(stats.hits).toBeGreaterThanOrEqual(1);
      expect(stats.misses).toBeGreaterThanOrEqual(2);
      expect(stats.size).toBeGreaterThanOrEqual(2);
    });

    it('should allow clearing the cache', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      await service.generateEmbedding('clear test', 'query');

      expect(service.getCacheStats().size).toBeGreaterThan(0);

      service.clearCache();

      expect(service.getCacheStats().size).toBe(0);
    });
  });

  describe('LRU cache with size limits', () => {
    it('should accept maxCacheSize in configuration', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService({ maxCacheSize: 100 });

      expect(service).toBeDefined();
    });

    it('should evict oldest entries when cache exceeds maxCacheSize', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const maxCacheSize = 3;
      const service = new EmbeddingService({ maxCacheSize });

      // Generate embeddings for 5 texts (exceeds maxCacheSize of 3)
      await service.generateEmbedding('text1', 'query');
      await service.generateEmbedding('text2', 'query');
      await service.generateEmbedding('text3', 'query');
      await service.generateEmbedding('text4', 'query');
      await service.generateEmbedding('text5', 'query');

      const stats = service.getCacheStats();

      // Cache size should not exceed maxCacheSize
      expect(stats.size).toBeLessThanOrEqual(maxCacheSize);
    });

    it('should evict least recently used entries first (LRU behavior)', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const maxCacheSize = 3;
      const service = new EmbeddingService({ maxCacheSize });

      // Add 3 entries
      await service.generateEmbedding('text1', 'query'); // oldest
      await service.generateEmbedding('text2', 'query');
      await service.generateEmbedding('text3', 'query'); // newest

      // Access text1 again to make it recently used
      await service.generateEmbedding('text1', 'query'); // now newest

      // Add a new entry, should evict text2 (now oldest)
      await service.generateEmbedding('text4', 'query');

      // text1 should still be in cache (recently used)
      const stats1 = service.getCacheStats();
      const startHits = stats1.hits;

      await service.generateEmbedding('text1', 'query'); // should be cache hit

      const stats2 = service.getCacheStats();
      expect(stats2.hits).toBeGreaterThan(startHits);
    });

    it('should use default maxCacheSize of 5000 when not specified', async () => {
      const { EmbeddingService, DEFAULT_MAX_CACHE_SIZE } = await import('../src/embeddings/service');
      const service = new EmbeddingService();

      // DEFAULT_MAX_CACHE_SIZE should be exported and equal to 5000
      expect(DEFAULT_MAX_CACHE_SIZE).toBe(5000);
    });

    it('should expose eviction count in cache statistics', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const maxCacheSize = 2;
      const service = new EmbeddingService({ maxCacheSize });

      // Generate 4 embeddings, should trigger 2 evictions
      await service.generateEmbedding('text1', 'query');
      await service.generateEmbedding('text2', 'query');
      await service.generateEmbedding('text3', 'query'); // evicts text1
      await service.generateEmbedding('text4', 'query'); // evicts text2

      const stats = service.getCacheStats();

      expect(stats.evictions).toBeGreaterThanOrEqual(2);
    });
  });

  describe('similarity computation', () => {
    it('should provide cosine similarity helper', async () => {
      const { embeddingService, cosineSimilarity } = await import('../src/embeddings/service');

      const embedding1 = await embeddingService.generateEmbedding('red apple fruit', 'passage');
      const embedding2 = await embeddingService.generateEmbedding('red apple food', 'passage');
      const embedding3 = await embeddingService.generateEmbedding('blue car vehicle', 'passage');

      const similarity12 = cosineSimilarity(embedding1, embedding2);
      const similarity13 = cosineSimilarity(embedding1, embedding3);

      // Similar concepts should have higher similarity
      expect(similarity12).toBeGreaterThan(similarity13);

      // Similarity should be between -1 and 1
      expect(similarity12).toBeGreaterThanOrEqual(-1);
      expect(similarity12).toBeLessThanOrEqual(1);
    });
  });

  describe('error handling', () => {
    it('should throw meaningful error when model fails to load', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service');
      const service = new EmbeddingService({ modelId: 'nonexistent/model' });

      await expect(service.generateEmbedding('test', 'query'))
        .rejects.toThrow(/model/i);
    });
  });
});
