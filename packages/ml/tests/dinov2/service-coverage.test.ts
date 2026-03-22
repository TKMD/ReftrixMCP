// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Service Additional Coverage Tests
 *
 * Tests for coverage gaps in dinov2/service.ts, focusing on:
 * - terminate() with cleanup of pending requests
 * - generateBatchEmbeddings edge cases
 * - Worker thread mode detection
 * - Re-initialization after dispose
 * - Constants export
 * - Error paths in generateEmbedding
 *
 * @module tests/dinov2/service-coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DINOv2Service,
  DINOV2_EMBEDDING_DIMENSION,
  DINOV2_INPUT_SIZE,
} from "../../src/dinov2/service.js";

// ============================================================================
// Mock setup for onnxruntime-node
// ============================================================================

function createMockSession(
  overrides?: Partial<{
    run: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }>
): { run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const fakeOutput = new Float32Array(257 * 768);
  for (let i = 0; i < 768; i++) {
    fakeOutput[i] = (i % 10) / 10.0 + 0.01; // Non-zero CLS token
  }

  return {
    run: vi.fn().mockResolvedValue({
      last_hidden_state: {
        data: fakeOutput,
        dims: [1, 257, 768],
      },
    }),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("DINOv2Service - constants", () => {
  it("should export DINOV2_EMBEDDING_DIMENSION as 768", () => {
    expect(DINOV2_EMBEDDING_DIMENSION).toBe(768);
  });

  it("should export DINOV2_INPUT_SIZE as 224", () => {
    expect(DINOV2_INPUT_SIZE).toBe(224);
  });
});

describe("DINOv2Service - lifecycle", () => {
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    mockSession = createMockSession();

    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue(mockSession),
      },
      Tensor: class MockTensor {
        type: string;
        data: Float32Array;
        dims: number[];
        constructor(type: string, data: Float32Array, dims: number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("onnxruntime-node");
    vi.restoreAllMocks();
  });

  it("should not re-initialize when already initialized", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    expect(service.initialized).toBe(true);

    // Second initialize should be a no-op
    await service.initialize();
    expect(service.initialized).toBe(true);

    await service.terminate();
  });

  it("should detect in-process mode in Vitest environment", () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });
    expect(service.isUsingWorkerThread()).toBe(false);
  });

  it("should report worker restart count as 0 for fresh service", () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });
    expect(service.getWorkerRestartCount()).toBe(0);
  });

  it("should handle terminate without prior initialization", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    // terminate without init should not throw
    await service.terminate();
    expect(service.initialized).toBe(false);
  });

  it("should handle dispose without prior initialization", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    // dispose without init should not throw
    await service.dispose();
    expect(service.initialized).toBe(false);
  });

  it("should handle dispose when session release throws", async () => {
    const failSession = createMockSession({
      release: vi.fn().mockRejectedValue(new Error("Release error")),
    });

    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue(failSession),
      },
      Tensor: class MockTensor {
        type: string;
        data: Float32Array;
        dims: number[];
        constructor(type: string, data: Float32Array, dims: number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
    }));

    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    // dispose should not throw even if release fails
    await service.dispose();
    expect(service.initialized).toBe(false);
  });

  it("should re-initialize after dispose on next generateEmbedding call", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    await service.dispose();
    expect(service.initialized).toBe(false);

    // Should auto re-initialize
    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    const embedding = await service.generateEmbedding(imageBuffer);
    expect(embedding).toHaveLength(768);
    expect(service.initialized).toBe(true);

    await service.terminate();
  });
});

describe("DINOv2Service - generateBatchEmbeddings", () => {
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    mockSession = createMockSession();

    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue(mockSession),
      },
      Tensor: class MockTensor {
        type: string;
        data: Float32Array;
        dims: number[];
        constructor(type: string, data: Float32Array, dims: number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("onnxruntime-node");
    vi.restoreAllMocks();
  });

  it("should handle empty batch", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });
    await service.initialize();

    const result = await service.generateBatchEmbeddings([]);
    expect(result).toEqual([]);

    await service.terminate();
  });

  it("should process single-element batch", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });
    await service.initialize();

    const buffers = [Buffer.alloc(224 * 224 * 3, 128)];
    const result = await service.generateBatchEmbeddings(buffers);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);

    await service.terminate();
  });

  it("should process multiple buffers sequentially", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });
    await service.initialize();

    const buffers = [
      Buffer.alloc(224 * 224 * 3, 50),
      Buffer.alloc(224 * 224 * 3, 100),
      Buffer.alloc(224 * 224 * 3, 200),
    ];
    const result = await service.generateBatchEmbeddings(buffers);

    expect(result).toHaveLength(3);
    expect(mockSession.run).toHaveBeenCalledTimes(3);

    // Each embedding should be L2 normalized
    for (const emb of result) {
      let norm = 0;
      for (const v of emb) {
        norm += v * v;
      }
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
    }

    await service.terminate();
  });
});

describe("DINOv2Service - error handling", () => {
  beforeEach(() => {
    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockRejectedValue(new Error("Model not found")),
      },
      Tensor: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.doUnmock("onnxruntime-node");
    vi.restoreAllMocks();
  });

  it("should throw descriptive error when model loading fails", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/nonexistent/model.onnx" });

    await expect(service.initialize()).rejects.toThrow("Model not found");
  });

  it("should throw on invalid buffer size with descriptive message", async () => {
    // Need a service that initializes successfully for buffer validation
    vi.doUnmock("onnxruntime-node");

    const fakeOutput = new Float32Array(257 * 768);
    for (let i = 0; i < 768; i++) fakeOutput[i] = 0.1;

    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue({
          run: vi.fn().mockResolvedValue({
            last_hidden_state: { data: fakeOutput, dims: [1, 257, 768] },
          }),
          release: vi.fn(),
        }),
      },
      Tensor: vi.fn(),
    }));

    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test.onnx" });

    const wrongSizeBuffer = Buffer.alloc(100);
    await expect(service.generateEmbedding(wrongSizeBuffer)).rejects.toThrow(
      "Invalid image buffer size"
    );

    await service.terminate();
  });
});
