// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingService Additional Coverage Tests
 *
 * Tests for coverage gaps in embeddings/service.ts, focusing on:
 * - Idle timer (setIdleTimeout, resetIdleTimer)
 * - terminate() lifecycle
 * - dispose() edge cases
 * - switchProvider and releaseGpu edge cases
 * - Cache eviction edge cases
 * - cosineSimilarity edge cases
 * - normalizeVector edge cases
 * - isInitialized / getRecycleCount / getInferencesSinceRecycle getters
 * - generateBatchEmbeddings with partial cache hits
 *
 * @module tests/embeddings/service-coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock setup
// ============================================================================

/**
 * Create a mock pipeline output that matches what extractSingleEmbedding
 * and extractBatchEmbeddings expect: objects with tolist() and dispose() methods.
 */
function createMockOutput(embeddings: number[] | number[][]): {
  tolist: () => number[] | number[][];
  dispose: () => void;
} {
  return {
    tolist: () => embeddings,
    dispose: vi.fn(),
  };
}

const mockPipelineFn = vi.fn().mockImplementation((input: string | string[]) => {
  if (Array.isArray(input)) {
    // Batch: return nested array of embeddings
    return Promise.resolve(createMockOutput(input.map(() => [0.1, 0.2, 0.3])));
  }
  // Single: return nested array (first element is embedding)
  return Promise.resolve(createMockOutput([[0.1, 0.2, 0.3]]));
});
const mockDispose = vi.fn().mockResolvedValue([]);
const mockPipeline = Object.assign(mockPipelineFn, {
  dispose: mockDispose,
});

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(mockPipeline),
}));

vi.mock("node:worker_threads", () => ({
  Worker: vi.fn().mockImplementation(() => {
    throw new Error("Worker thread disabled in test");
  }),
}));

// ============================================================================
// Tests
// ============================================================================

describe("EmbeddingService - idle timer", () => {
  let service: InstanceType<typeof import("../../src/embeddings/service.js").EmbeddingService>;

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../../src/embeddings/service.js");
    service = new mod.EmbeddingService();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.terminate();
  });

  it("should set idle timeout and clear existing timer", () => {
    service.setIdleTimeout(5000);
    // Set again to test clearing existing timer path
    service.setIdleTimeout(10000);
    // No error means clearing existing timer works
  });

  it("should disable idle timer when set to 0", () => {
    service.setIdleTimeout(5000);
    service.setIdleTimeout(0);
    // Timer disabled, no auto-dispose
  });

  it("should trigger dispose after idle timeout expires", async () => {
    vi.useRealTimers();
    service.setIdleTimeout(50);

    // Generate embedding to start the idle timer
    await service.generateEmbedding("test", "query");
    expect(service.isInitialized()).toBe(true);

    // Wait for idle timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // After timeout, pipeline should be disposed
    expect(service.isInitialized()).toBe(false);
  });

  it("should reset idle timer on cache hit", async () => {
    vi.useRealTimers();
    service.setIdleTimeout(200);

    // Generate embedding (will be cached)
    await service.generateEmbedding("test-cache-hit", "query");

    // Access cached embedding (should reset idle timer)
    await service.generateEmbedding("test-cache-hit", "query");

    const stats = service.getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });
});

describe("EmbeddingService - terminate", () => {
  it("should terminate cleanly when no worker or pipeline exists", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    // terminate without ever initializing
    await service.terminate();
    // Should not throw
  });

  it("should clear idle timer on terminate", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    service.setIdleTimeout(5000);
    await service.generateEmbedding("test", "query");

    await service.terminate();
    // No errors means idle timer was properly cleaned up
  });

  it("should dispose in-process pipeline on terminate", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    await service.generateEmbedding("test", "query");
    expect(service.isInitialized()).toBe(true);

    await service.terminate();
    expect(service.isInitialized()).toBe(false);
  });
});

describe("EmbeddingService - dispose", () => {
  it("should clear idle timer on dispose", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    service.setIdleTimeout(5000);
    await service.generateEmbedding("test", "query");

    await service.dispose();
    expect(service.isInitialized()).toBe(false);

    await service.terminate();
  });

  it("should reset inferencesSinceRecycle on dispose", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    await service.generateEmbedding("test", "query");
    expect(service.getInferencesSinceRecycle()).toBeGreaterThan(0);

    await service.dispose();
    expect(service.getInferencesSinceRecycle()).toBe(0);

    await service.terminate();
  });
});

describe("EmbeddingService - getters", () => {
  it("should return correct values from getRecycleCount and getInferencesSinceRecycle", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    expect(service.getRecycleCount()).toBe(0);
    expect(service.getInferencesSinceRecycle()).toBe(0);

    await service.generateEmbedding("test", "query");
    expect(service.getInferencesSinceRecycle()).toBe(1);

    await service.terminate();
  });

  it("should report worker thread mode correctly", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    // In Vitest, worker thread is disabled
    expect(service.isUsingWorkerThread()).toBe(false);
    expect(service.getCurrentProvider()).toBe("cpu");

    await service.terminate();
  });

  it("should return worker restart count", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    expect(service.getWorkerRestartCount()).toBe(0);

    await service.terminate();
  });
});

describe("EmbeddingService - cosineSimilarity", () => {
  it("should calculate similarity between identical vectors as 1", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const vec = [0.6, 0.8];
    const similarity = mod.cosineSimilarity(vec, vec);
    expect(similarity).toBeCloseTo(1.0, 4);
  });

  it("should calculate similarity between orthogonal vectors as 0", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const similarity = mod.cosineSimilarity([1, 0], [0, 1]);
    expect(similarity).toBeCloseTo(0, 4);
  });

  it("should throw for vectors of different dimensions", async () => {
    const mod = await import("../../src/embeddings/service.js");
    expect(() => mod.cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      "Vectors must have the same dimension"
    );
  });

  it("should return 0 for zero vectors", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const similarity = mod.cosineSimilarity([0, 0], [1, 2]);
    expect(similarity).toBe(0);
  });

  it("should handle negative vector values", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const similarity = mod.cosineSimilarity([1, 0], [-1, 0]);
    expect(similarity).toBeCloseTo(-1.0, 4);
  });
});

describe("EmbeddingService - cache", () => {
  it("should clear cache and reset stats", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    await service.generateEmbedding("test", "query");
    await service.generateEmbedding("test", "query"); // cache hit

    let stats = service.getCacheStats();
    expect(stats.size).toBeGreaterThan(0);
    expect(stats.hits).toBeGreaterThan(0);

    service.clearCache();
    stats = service.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);

    await service.terminate();
  });

  it("should evict oldest entry when cache is full", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService({ maxCacheSize: 2 });

    await service.generateEmbedding("first", "query");
    await service.generateEmbedding("second", "query");
    await service.generateEmbedding("third", "query"); // should evict "first"

    const stats = service.getCacheStats();
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.size).toBe(2);

    await service.terminate();
  });
});

describe("EmbeddingService - generateBatchEmbeddings", () => {
  it("should return empty array for empty input", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    const result = await service.generateBatchEmbeddings([], "query");
    expect(result).toEqual([]);

    await service.terminate();
  });

  it("should use cache for repeated texts in batch", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    // Pre-cache one text
    await service.generateEmbedding("cached-text", "query");

    // Batch with mix of cached and uncached
    const result = await service.generateBatchEmbeddings(["cached-text", "new-text"], "query");

    expect(result.length).toBe(2);

    const stats = service.getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);

    await service.terminate();
  });

  it("should generate batch embeddings with reset idle timer", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    service.setIdleTimeout(5000);

    const result = await service.generateBatchEmbeddings(["text1", "text2"], "passage");
    expect(result.length).toBe(2);

    await service.terminate();
  });
});

describe("EmbeddingService - switchProvider in-process", () => {
  it("should return true when switching to same provider", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    // Already CPU, switching to CPU should return true
    const result = await service.switchProvider("cpu");
    expect(result).toBe(true);

    await service.terminate();
  });

  it("should attempt CUDA switch and return boolean based on availability", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    const result = await service.switchProvider("cuda");
    // Result depends on whether CUDA provider .so exists in test env
    expect(typeof result).toBe("boolean");

    // If CUDA not available, provider should remain CPU
    if (!result) {
      expect(service.getCurrentProvider()).toBe("cpu");
    }

    await service.terminate();
  });
});

describe("EmbeddingService - releaseGpu", () => {
  it("should release GPU and set provider to CPU", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    await service.generateEmbedding("test", "query");
    await service.releaseGpu();

    expect(service.getCurrentProvider()).toBe("cpu");
    expect(service.isInitialized()).toBe(false);

    await service.terminate();
  });

  it("should be safe to call releaseGpu when already on CPU", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    expect(service.getCurrentProvider()).toBe("cpu");
    await service.releaseGpu();
    expect(service.getCurrentProvider()).toBe("cpu");

    await service.terminate();
  });
});

describe("EmbeddingService - pipeline recycle", () => {
  it("should recycle pipeline when threshold is reached", async () => {
    const mod = await import("../../src/embeddings/service.js");
    // Set very low threshold to trigger recycle
    const service = new mod.EmbeddingService({ pipelineRecycleThreshold: 2 });

    await service.generateEmbedding("text1", "query");
    await service.generateEmbedding("text2", "passage"); // new cache key (different type)

    // After 2 inferences, pipeline should recycle
    // getRecycleCount increments after threshold is met
    expect(service.getRecycleCount()).toBeGreaterThanOrEqual(1);

    await service.terminate();
  });

  it("should not recycle when threshold is 0 (disabled)", async () => {
    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService({ pipelineRecycleThreshold: 0 });

    await service.generateEmbedding("text1", "query");
    await service.generateEmbedding("text2", "passage");

    expect(service.getRecycleCount()).toBe(0);

    await service.terminate();
  });
});

describe("EmbeddingService - constants", () => {
  it("should export DEFAULT_MAX_CACHE_SIZE", async () => {
    const mod = await import("../../src/embeddings/service.js");
    expect(mod.DEFAULT_MAX_CACHE_SIZE).toBe(5000);
  });

  it("should export DEFAULT_PIPELINE_RECYCLE_THRESHOLD", async () => {
    const mod = await import("../../src/embeddings/service.js");
    expect(mod.DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBe(30);
  });
});
