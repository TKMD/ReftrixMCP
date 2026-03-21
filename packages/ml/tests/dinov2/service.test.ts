// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Service Tests
 *
 * Tests preprocessing, L2 normalization, validation, and service lifecycle.
 * Worker Thread is disabled in Vitest (VITEST=true), so these test the
 * in-process fallback path and standalone utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DINOv2Service,
  DINOV2_EMBEDDING_DIMENSION,
  DINOV2_INPUT_SIZE,
} from "../../src/dinov2/service.js";

// =====================================================
// Preprocessing / L2 normalization tests (extracted logic)
// =====================================================

/**
 * Re-implement preprocessImage for unit testing.
 * (The actual function is private inside worker-thread.ts)
 */
function preprocessImage(rawPixels: ArrayBuffer, width: number, height: number): Float32Array {
  const pixels = new Uint8Array(rawPixels);
  const expectedSize = width * height * 3;
  if (pixels.length !== expectedSize) {
    throw new Error(`Invalid buffer size: expected ${expectedSize}, got ${pixels.length}`);
  }

  const mean = [0.485, 0.456, 0.406] as const;
  const std = [0.229, 0.224, 0.225] as const;
  const float32 = new Float32Array(3 * width * height);

  for (let c = 0; c < 3; c++) {
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        const srcIdx = (h * width + w) * 3 + c;
        const dstIdx = c * height * width + h * width + w;
        float32[dstIdx] = (pixels[srcIdx]! / 255.0 - mean[c]) / std[c];
      }
    }
  }
  return float32;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) {
      throw new Error(`NaN/Infinity detected at index ${i}`);
    }
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    throw new Error("Zero vector: L2 norm is 0");
  }
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i]! / norm;
  }
  return result;
}

describe("DINOv2 preprocessImage", () => {
  it("should convert HWC uint8 to CHW float32 with ImageNet normalization", () => {
    // 2x2 image, all pixels = [128, 128, 128]
    const width = 2;
    const height = 2;
    const pixels = new Uint8Array(width * height * 3).fill(128);
    const result = preprocessImage(pixels.buffer, width, height);

    // Expected: (128/255 - mean) / std for each channel
    const val128 = 128 / 255.0;
    const expectedR = (val128 - 0.485) / 0.229;
    const expectedG = (val128 - 0.456) / 0.224;
    const expectedB = (val128 - 0.406) / 0.225;

    // CHW layout: first 4 values are R channel, next 4 are G, last 4 are B
    expect(result.length).toBe(3 * width * height);
    expect(result[0]).toBeCloseTo(expectedR, 5);
    expect(result[4]).toBeCloseTo(expectedG, 5);
    expect(result[8]).toBeCloseTo(expectedB, 5);
  });

  it("should throw on invalid buffer size", () => {
    const smallBuffer = new ArrayBuffer(10);
    expect(() => preprocessImage(smallBuffer, 224, 224)).toThrow("Invalid buffer size");
  });

  it("should handle all-zero pixels (black image)", () => {
    const width = 2;
    const height = 2;
    const pixels = new Uint8Array(width * height * 3).fill(0);
    const result = preprocessImage(pixels.buffer, width, height);

    // (0/255 - mean) / std
    const expectedR = (0 - 0.485) / 0.229;
    expect(result[0]).toBeCloseTo(expectedR, 5);
  });

  it("should handle all-255 pixels (white image)", () => {
    const width = 2;
    const height = 2;
    const pixels = new Uint8Array(width * height * 3).fill(255);
    const result = preprocessImage(pixels.buffer, width, height);

    // (255/255 - mean) / std = (1 - mean) / std
    const expectedR = (1.0 - 0.485) / 0.229;
    expect(result[0]).toBeCloseTo(expectedR, 5);
  });
});

describe("DINOv2 l2Normalize", () => {
  it("should normalize a vector to unit length", () => {
    const vec = new Float32Array([3, 4]);
    const result = l2Normalize(vec);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);

    // Verify L2 norm is 1
    const norm = Math.sqrt(result[0]! ** 2 + result[1]! ** 2);
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("should throw on zero vector", () => {
    const vec = new Float32Array([0, 0, 0]);
    expect(() => l2Normalize(vec)).toThrow("Zero vector: L2 norm is 0");
  });

  it("should throw on NaN values", () => {
    const vec = new Float32Array([1, NaN, 3]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 1");
  });

  it("should throw on Infinity values", () => {
    const vec = new Float32Array([1, Infinity, 3]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 1");
  });

  it("should throw on -Infinity values", () => {
    const vec = new Float32Array([1, -Infinity, 3]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 1");
  });

  it("should produce unit-length 768D vector", () => {
    // Simulate a realistic 768D vector
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      vec[i] = Math.random() * 2 - 1; // random values between -1 and 1
    }
    const result = l2Normalize(vec);

    // Verify dimension
    expect(result.length).toBe(768);

    // Verify L2 norm is 1
    let norm = 0;
    for (let i = 0; i < result.length; i++) {
      norm += result[i]! ** 2;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });
});

// =====================================================
// Service configuration and lifecycle tests
// =====================================================

describe("DINOv2Service", () => {
  it("should export correct embedding dimension", () => {
    expect(DINOV2_EMBEDDING_DIMENSION).toBe(768);
  });

  it("should export correct input size", () => {
    expect(DINOV2_INPUT_SIZE).toBe(224);
  });

  it("should create service with config", () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
    expect(service.initialized).toBe(false);
    expect(service.getWorkerRestartCount()).toBe(0);
  });

  it("should reject invalid buffer size in generateEmbedding", async () => {
    // Mock onnxruntime-node to avoid model loading
    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue({
          run: vi.fn(),
          release: vi.fn(),
        }),
      },
      Tensor: vi.fn(),
    }));

    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });

    // Force in-process mode (VITEST=true already does this)
    const tooSmall = Buffer.alloc(100);
    await expect(service.generateEmbedding(tooSmall)).rejects.toThrow("Invalid image buffer size");

    vi.doUnmock("onnxruntime-node");
  });

  it("should use in-process mode when VITEST=true", () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
    // In test environment, worker thread should be disabled
    expect(service.isUsingWorkerThread()).toBe(false);
  });
});

describe("DINOv2Service with mocked ONNX", () => {
  let mockSession: {
    run: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Create a fake 768D output for CLS token
    const fakeOutput = new Float32Array(257 * 768);
    // Fill CLS token (first 768 values) with known values
    for (let i = 0; i < 768; i++) {
      fakeOutput[i] = (i % 10) / 10.0; // 0.0, 0.1, 0.2, ..., 0.9, 0.0, ...
    }

    mockSession = {
      run: vi.fn().mockResolvedValue({
        last_hidden_state: {
          data: fakeOutput,
          dims: [1, 257, 768],
        },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };

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

  it("should initialize and generate embedding", async () => {
    // Re-import to pick up mocked module
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });

    await service.initialize();
    expect(service.initialized).toBe(true);

    // Create valid 224x224x3 buffer
    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    const embedding = await service.generateEmbedding(imageBuffer);

    expect(embedding).toHaveLength(768);

    // Verify L2 normalized (unit length)
    let norm = 0;
    for (const v of embedding) {
      norm += v * v;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);

    await service.dispose();
    expect(mockSession.release).toHaveBeenCalled();
  });

  it("should generate batch embeddings sequentially", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });
    await service.initialize();

    const buffers = [
      Buffer.alloc(224 * 224 * 3, 100),
      Buffer.alloc(224 * 224 * 3, 150),
      Buffer.alloc(224 * 224 * 3, 200),
    ];

    const embeddings = await service.generateBatchEmbeddings(buffers);

    expect(embeddings).toHaveLength(3);
    expect(mockSession.run).toHaveBeenCalledTimes(3);

    for (const emb of embeddings) {
      expect(emb).toHaveLength(768);
    }

    await service.terminate();
  });

  it("should handle dispose and re-initialize", async () => {
    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });

    await service.initialize();
    expect(service.initialized).toBe(true);

    await service.dispose();
    expect(service.initialized).toBe(false);

    // Should re-initialize on next call
    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    const embedding = await service.generateEmbedding(imageBuffer);
    expect(embedding).toHaveLength(768);
    expect(service.initialized).toBe(true);

    await service.terminate();
  });

  it("should throw when model output is missing last_hidden_state", async () => {
    mockSession.run.mockResolvedValueOnce({ some_other_output: {} });

    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });
    await service.initialize();

    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    await expect(service.generateEmbedding(imageBuffer)).rejects.toThrow(
      "Model output missing last_hidden_state"
    );

    await service.terminate();
  });

  it("should throw on NaN in model output", async () => {
    const nanOutput = new Float32Array(257 * 768);
    nanOutput[0] = NaN; // CLS token first element is NaN

    mockSession.run.mockResolvedValueOnce({
      last_hidden_state: {
        data: nanOutput,
        dims: [1, 257, 768],
      },
    });

    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });
    await service.initialize();

    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    await expect(service.generateEmbedding(imageBuffer)).rejects.toThrow("NaN/Infinity detected");

    await service.terminate();
  });

  it("should throw on zero vector output", async () => {
    // All zeros in CLS token
    const zeroOutput = new Float32Array(257 * 768).fill(0);

    mockSession.run.mockResolvedValueOnce({
      last_hidden_state: {
        data: zeroOutput,
        dims: [1, 257, 768],
      },
    });

    const { DINOv2Service: MockedService } = await import("../../src/dinov2/service.js");
    const service = new MockedService({ modelPath: "/tmp/test-model.onnx" });
    await service.initialize();

    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    await expect(service.generateEmbedding(imageBuffer)).rejects.toThrow(
      "Zero vector: L2 norm is 0"
    );

    await service.terminate();
  });
});
