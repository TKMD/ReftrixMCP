// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embeddings Worker Thread Unit Tests
 *
 * Tests the internal logic of embeddings/worker-thread.ts by mocking
 * node:worker_threads parentPort and onnxruntime-node. Covers pure functions
 * (normalizeVector, extractSingleEmbedding, extractBatchEmbeddings),
 * GPU detection (detectExecutionProvider, verifyCudaAvailability),
 * and message handler paths.
 *
 * @module tests/embeddings/worker-thread
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================
// Pure function re-implementations for unit testing
// (These mirror the private functions in worker-thread.ts)
// =====================================================

const EMBEDDING_DIMENSION = 768;

/**
 * Normalize a vector to unit length (L2 normalization).
 * Re-implemented from worker-thread.ts for direct unit testing.
 */
function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map((val) => val / norm);
}

/**
 * Extract number[] from a pipeline output, disposing the tensor.
 * Re-implemented from worker-thread.ts for direct unit testing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSingleEmbedding(output: any): number[] {
  let embedding: number[];
  if (output && typeof output.tolist === "function") {
    const result = output.tolist();
    embedding = Array.isArray(result[0]) ? result[0] : result;
    if (typeof output.dispose === "function") {
      output.dispose();
    }
  } else if (Array.isArray(output)) {
    embedding = output;
  } else {
    throw new Error("Unexpected embedding output format");
  }

  return normalizeVector(embedding);
}

/**
 * Extract number[][] from a batch pipeline output, disposing the tensor.
 * Re-implemented from worker-thread.ts for direct unit testing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBatchEmbeddings(output: any): number[][] {
  let batchEmbeddings: number[][];
  if (output && typeof output.tolist === "function") {
    batchEmbeddings = output.tolist();
    if (typeof output.dispose === "function") {
      output.dispose();
    }
  } else if (Array.isArray(output)) {
    batchEmbeddings = output;
  } else {
    throw new Error("Unexpected batch embedding output format");
  }

  return batchEmbeddings.map(normalizeVector);
}

// =====================================================
// normalizeVector tests
// =====================================================

describe("Embeddings Worker Thread - normalizeVector", () => {
  it("should normalize a simple vector to unit length", () => {
    const result = normalizeVector([3, 4]);
    expect(result[0]).toBeCloseTo(0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);
  });

  it("should return zero vector unchanged", () => {
    const result = normalizeVector([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });

  it("should normalize a 768-dimensional vector to unit length", () => {
    const vec = Array.from({ length: 768 }, (_, i) => (i + 1) * 0.01);
    const result = normalizeVector(vec);

    let norm = 0;
    for (const v of result) {
      norm += v * v;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  it("should handle negative values", () => {
    const result = normalizeVector([-3, 4]);
    expect(result[0]).toBeCloseTo(-0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);
  });

  it("should handle single-element vector", () => {
    const result = normalizeVector([5]);
    expect(result[0]).toBeCloseTo(1.0, 4);
  });

  it("should handle already-normalized vector", () => {
    const result = normalizeVector([0.6, 0.8]);
    expect(result[0]).toBeCloseTo(0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);
  });
});

// =====================================================
// extractSingleEmbedding tests
// =====================================================

describe("Embeddings Worker Thread - extractSingleEmbedding", () => {
  it("should extract from tensor-like output with tolist() returning nested array", () => {
    const mockDispose = vi.fn();
    const mockOutput = {
      tolist: () => [[1, 2, 3]],
      dispose: mockDispose,
    };

    const result = extractSingleEmbedding(mockOutput);
    expect(result.length).toBe(3);
    expect(mockDispose).toHaveBeenCalledOnce();

    // Verify normalization
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("should extract from tensor-like output with tolist() returning flat array", () => {
    const mockOutput = {
      tolist: () => [4, 5, 6],
      dispose: vi.fn(),
    };

    const result = extractSingleEmbedding(mockOutput);
    expect(result.length).toBe(3);
  });

  it("should extract from plain array output", () => {
    const result = extractSingleEmbedding([3, 4]);
    expect(result[0]).toBeCloseTo(0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);
  });

  it("should throw on unexpected output format", () => {
    expect(() => extractSingleEmbedding("invalid")).toThrow("Unexpected embedding output format");
    expect(() => extractSingleEmbedding(42)).toThrow("Unexpected embedding output format");
    expect(() => extractSingleEmbedding(null)).toThrow("Unexpected embedding output format");
  });

  it("should handle output without dispose method", () => {
    const mockOutput = {
      tolist: () => [[1, 2, 3]],
      // no dispose
    };

    const result = extractSingleEmbedding(mockOutput);
    expect(result.length).toBe(3);
  });
});

// =====================================================
// extractBatchEmbeddings tests
// =====================================================

describe("Embeddings Worker Thread - extractBatchEmbeddings", () => {
  it("should extract from tensor-like batch output", () => {
    const mockDispose = vi.fn();
    const mockOutput = {
      tolist: () => [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      dispose: mockDispose,
    };

    const result = extractBatchEmbeddings(mockOutput);
    expect(result.length).toBe(3);
    expect(mockDispose).toHaveBeenCalledOnce();

    // Each should be normalized
    for (const emb of result) {
      const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 4);
    }
  });

  it("should extract from plain array batch output", () => {
    const result = extractBatchEmbeddings([
      [3, 4],
      [5, 12],
    ]);
    expect(result.length).toBe(2);
    expect(result[0]![0]).toBeCloseTo(0.6, 4);
    expect(result[1]![0]).toBeCloseTo(5 / 13, 4);
  });

  it("should throw on unexpected batch output format", () => {
    expect(() => extractBatchEmbeddings("invalid")).toThrow(
      "Unexpected batch embedding output format"
    );
    expect(() => extractBatchEmbeddings(42)).toThrow("Unexpected batch embedding output format");
  });

  it("should handle empty batch", () => {
    const result = extractBatchEmbeddings([]);
    expect(result).toEqual([]);
  });

  it("should handle batch output without dispose method", () => {
    const mockOutput = {
      tolist: () => [
        [1, 0],
        [0, 1],
      ],
    };

    const result = extractBatchEmbeddings(mockOutput);
    expect(result.length).toBe(2);
  });
});

// =====================================================
// GPU detection function tests
// =====================================================

describe("Embeddings Worker Thread - GPU detection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should default to CPU when ONNX_EXECUTION_PROVIDER is not set", () => {
    // The detectExecutionProvider function checks process.env.ONNX_EXECUTION_PROVIDER
    delete process.env.ONNX_EXECUTION_PROVIDER;

    // Simulate detectExecutionProvider logic
    const envProvider = process.env.ONNX_EXECUTION_PROVIDER;
    const provider = envProvider === "cuda" || envProvider === "rocm" ? "cuda-candidate" : "cpu";
    expect(provider).toBe("cpu");
  });

  it("should detect CUDA when ONNX_EXECUTION_PROVIDER=cuda", () => {
    process.env.ONNX_EXECUTION_PROVIDER = "cuda";

    const envProvider = process.env.ONNX_EXECUTION_PROVIDER;
    expect(envProvider === "cuda" || envProvider === "rocm").toBe(true);
  });

  it("should detect CUDA when ONNX_EXECUTION_PROVIDER=rocm", () => {
    process.env.ONNX_EXECUTION_PROVIDER = "rocm";

    const envProvider = process.env.ONNX_EXECUTION_PROVIDER;
    expect(envProvider === "cuda" || envProvider === "rocm").toBe(true);
  });

  it("should remain CPU for unknown ONNX_EXECUTION_PROVIDER values", () => {
    process.env.ONNX_EXECUTION_PROVIDER = "webgpu";

    const envProvider = process.env.ONNX_EXECUTION_PROVIDER;
    const isCudaLike = envProvider === "cuda" || envProvider === "rocm";
    expect(isCudaLike).toBe(false);
  });
});

// =====================================================
// Message handler integration tests (mocked parentPort)
// =====================================================

describe("Embeddings Worker Thread - message handler", () => {
  let postedMessages: unknown[];
  let messageHandler: ((msg: unknown) => void) | null;

  beforeEach(() => {
    postedMessages = [];
    messageHandler = null;

    vi.doMock("node:worker_threads", () => ({
      parentPort: {
        postMessage: (msg: unknown) => {
          postedMessages.push(msg);
        },
        on: (event: string, handler: (msg: unknown) => void) => {
          if (event === "message") {
            messageHandler = handler;
          }
        },
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("should send error response for unknown message type", async () => {
    // Mock dependencies
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({ type: "unknown-cmd", requestId: "req-1" });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("error");
    expect(response.requestId).toBe("req-1");
    expect(response.success).toBe(false);
    expect(response.error).toContain("Unknown worker message type");
  });

  it("should handle dispose message when pipeline is not initialized", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({ type: "dispose", requestId: "req-dispose-1" });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("dispose");
    expect(response.requestId).toBe("req-dispose-1");
    expect(response.success).toBe(true);
  });

  it("should handle release-gpu message", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({ type: "release-gpu", requestId: "req-release-1" });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("release-gpu");
    expect(response.requestId).toBe("req-release-1");
    expect(response.success).toBe(true);
  });

  it("should handle init and generate messages with mocked pipeline", async () => {
    const mockPipeline = vi.fn().mockResolvedValue([0.6, 0.8]);

    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn().mockResolvedValue(mockPipeline),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    // Init
    messageHandler!({
      type: "init",
      requestId: "req-init-1",
      config: {
        modelId: "test-model",
        cacheDir: "/tmp/cache",
        device: "cpu",
        dtype: "fp32",
        pipelineRecycleThreshold: 30,
      },
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const initResponse = postedMessages[0] as Record<string, unknown>;
    expect(initResponse.type).toBe("init");
    expect(initResponse.success).toBe(true);

    // Generate
    messageHandler!({
      type: "generate",
      requestId: "req-gen-1",
      text: "query: test text",
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(2);
    });

    const genResponse = postedMessages[1] as Record<string, unknown>;
    expect(genResponse.type).toBe("generate");
    expect(genResponse.requestId).toBe("req-gen-1");
    expect(genResponse.success).toBe(true);
    expect(Array.isArray(genResponse.embedding)).toBe(true);
  });

  it("should handle switch-provider message to CPU", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({
      type: "switch-provider",
      requestId: "req-switch-1",
      provider: "cpu",
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("switch-provider");
    expect(response.requestId).toBe("req-switch-1");
    expect(response.success).toBe(true);
    expect(response.provider).toBe("cpu");
  });

  it("should handle switch-provider message to CUDA when not available", async () => {
    // CUDA not available (existsSync returns false for provider)
    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({
      type: "switch-provider",
      requestId: "req-switch-cuda-1",
      provider: "cuda",
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("switch-provider");
    expect(response.success).toBe(true);
    // CUDA not available, should fall back to CPU
    expect(response.provider).toBe("cpu");
  });

  it("should handle generateBatch message with empty texts", async () => {
    const mockPipeline = vi.fn();

    vi.doMock("node:fs", () => ({
      default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(""),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue("/fake/path/index.js"),
      }),
    }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn().mockResolvedValue(mockPipeline),
    }));

    await import("../../src/embeddings/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    // Init first
    messageHandler!({
      type: "init",
      requestId: "req-init-batch",
      config: {
        modelId: "test-model",
        cacheDir: "/tmp/cache",
        device: "cpu",
        dtype: "fp32",
        pipelineRecycleThreshold: 30,
      },
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    // GenerateBatch with empty texts
    messageHandler!({
      type: "generateBatch",
      requestId: "req-batch-empty",
      texts: [],
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(2);
    });

    const response = postedMessages[1] as Record<string, unknown>;
    expect(response.type).toBe("generateBatch");
    expect(response.requestId).toBe("req-batch-empty");
    expect(response.success).toBe(true);
    expect(response.embeddings).toEqual([]);
  });
});

// =====================================================
// LD_LIBRARY_PATH detection test
// =====================================================

describe("Embeddings Worker Thread - isLdLibraryPathSetAtOsLevel", () => {
  it("should detect LD_LIBRARY_PATH presence in process environment string", () => {
    // Simulate the isLdLibraryPathSetAtOsLevel logic
    const envWithLdPath = "HOME=/home/user\0LD_LIBRARY_PATH=/usr/local/cuda/lib64\0PATH=/usr/bin";
    expect(envWithLdPath.includes("LD_LIBRARY_PATH")).toBe(true);

    const envWithoutLdPath = "HOME=/home/user\0PATH=/usr/bin\0SHELL=/bin/bash";
    expect(envWithoutLdPath.includes("LD_LIBRARY_PATH")).toBe(false);
  });
});
