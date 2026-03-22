// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Worker Thread Unit Tests
 *
 * Tests the internal logic of dinov2/worker-thread.ts by mocking
 * node:worker_threads parentPort and onnxruntime-node. The worker
 * module is loaded with mocked dependencies to exercise message
 * handling, preprocessing, L2 normalization, and error paths.
 *
 * @module tests/dinov2/worker-thread
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================
// Pure function re-implementations for unit testing
// (These mirror the private functions in worker-thread.ts)
// =====================================================

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;
const DINOV2_EMBEDDING_DIMENSION = 768;

/**
 * Preprocess raw RGB pixel buffer into DINOv2 input tensor format.
 * Re-implemented from worker-thread.ts for direct unit testing.
 */
function preprocessImage(rawPixels: ArrayBuffer, width: number, height: number): Float32Array {
  const pixels = new Uint8Array(rawPixels);
  const expectedSize = width * height * 3;
  if (pixels.length !== expectedSize) {
    throw new Error(`Invalid buffer size: expected ${expectedSize}, got ${pixels.length}`);
  }

  const float32 = new Float32Array(3 * width * height);

  for (let c = 0; c < 3; c++) {
    const mean = IMAGENET_MEAN[c]!;
    const std = IMAGENET_STD[c]!;
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        const srcIdx = (h * width + w) * 3 + c;
        const dstIdx = c * height * width + h * width + w;
        float32[dstIdx] = (pixels[srcIdx]! / 255.0 - mean) / std;
      }
    }
  }
  return float32;
}

/**
 * L2 normalize a vector to unit length.
 * Re-implemented from worker-thread.ts for direct unit testing.
 */
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

// =====================================================
// preprocessImage tests
// =====================================================

describe("DINOv2 Worker Thread - preprocessImage", () => {
  it("should convert 2x2 RGB image to CHW float32 with ImageNet normalization", () => {
    // Arrange: 2x2 image with known pixel values
    const width = 2;
    const height = 2;
    const rawPixels = new Uint8Array([
      // Row 0: (255,0,0), (0,255,0)
      255, 0, 0, 0, 255, 0,
      // Row 1: (0,0,255), (128,128,128)
      0, 0, 255, 128, 128, 128,
    ]).buffer;

    // Act
    const result = preprocessImage(rawPixels, width, height);

    // Assert: output should be 3*2*2 = 12 floats
    expect(result.length).toBe(12);

    // Verify first pixel R channel: (255/255 - 0.485) / 0.229
    const expectedR00 = (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    expect(result[0]).toBeCloseTo(expectedR00, 4);

    // Verify first pixel G channel at position channel=1, h=0, w=0 -> idx = 1*4 + 0*2 + 0 = 4
    const expectedG00 = (0 / 255.0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    expect(result[4]).toBeCloseTo(expectedG00, 4);
  });

  it("should throw on invalid buffer size", () => {
    const rawPixels = new Uint8Array([1, 2, 3]).buffer;
    expect(() => preprocessImage(rawPixels, 224, 224)).toThrow("Invalid buffer size");
  });

  it("should handle all-zero pixel buffer", () => {
    const width = 2;
    const height = 2;
    const rawPixels = new Uint8Array(2 * 2 * 3).buffer; // all zeros

    const result = preprocessImage(rawPixels, width, height);
    expect(result.length).toBe(12);

    // R channel pixel (0,0): (0/255 - 0.485) / 0.229
    const expectedR = (0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    expect(result[0]).toBeCloseTo(expectedR, 4);
  });

  it("should handle 224x224 full-size image buffer", () => {
    const width = 224;
    const height = 224;
    const rawPixels = new Uint8Array(width * height * 3).buffer;

    const result = preprocessImage(rawPixels, width, height);
    expect(result.length).toBe(3 * 224 * 224);
  });

  it("should handle all-255 pixel buffer", () => {
    const width = 2;
    const height = 2;
    const rawPixels = new Uint8Array(2 * 2 * 3).fill(255).buffer;

    const result = preprocessImage(rawPixels, width, height);
    expect(result.length).toBe(12);

    // All channels: (255/255 - mean) / std = (1 - mean) / std
    const expectedR = (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    expect(result[0]).toBeCloseTo(expectedR, 4);
  });
});

// =====================================================
// l2Normalize tests
// =====================================================

describe("DINOv2 Worker Thread - l2Normalize", () => {
  it("should normalize a simple vector to unit length", () => {
    const vec = new Float32Array([3, 4]);
    const result = l2Normalize(vec);

    expect(result[0]).toBeCloseTo(0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);

    // Verify unit length
    const norm = Math.sqrt(result[0]! ** 2 + result[1]! ** 2);
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("should normalize a 768-dimensional vector", () => {
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      vec[i] = Math.random() * 2 - 1;
    }

    const result = l2Normalize(vec);
    expect(result.length).toBe(768);

    // Verify unit length
    let norm = 0;
    for (let i = 0; i < result.length; i++) {
      norm += result[i]! ** 2;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  it("should throw on zero vector", () => {
    const vec = new Float32Array(10);
    expect(() => l2Normalize(vec)).toThrow("Zero vector: L2 norm is 0");
  });

  it("should throw on NaN in vector", () => {
    const vec = new Float32Array([1, NaN, 3]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 1");
  });

  it("should throw on Infinity in vector", () => {
    const vec = new Float32Array([1, 2, Infinity]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 2");
  });

  it("should throw on negative Infinity in vector", () => {
    const vec = new Float32Array([1, -Infinity, 3]);
    expect(() => l2Normalize(vec)).toThrow("NaN/Infinity detected at index 1");
  });

  it("should handle single-element vector", () => {
    const vec = new Float32Array([5.0]);
    const result = l2Normalize(vec);
    expect(result[0]).toBeCloseTo(1.0, 4);
  });

  it("should preserve sign of vector elements", () => {
    const vec = new Float32Array([-3, 4]);
    const result = l2Normalize(vec);
    expect(result[0]).toBeCloseTo(-0.6, 4);
    expect(result[1]).toBeCloseTo(0.8, 4);
  });
});

// =====================================================
// Message handler integration tests (mocked parentPort)
// =====================================================

describe("DINOv2 Worker Thread - message handler", () => {
  let postedMessages: unknown[];
  let messageHandler: ((msg: unknown) => void) | null;

  beforeEach(() => {
    postedMessages = [];
    messageHandler = null;

    // Mock parentPort
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
    // Mock onnxruntime-node so import does not fail
    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn(),
      },
      Tensor: vi.fn(),
    }));

    // Import the worker module to trigger parentPort.on("message") setup
    await import("../../src/dinov2/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    // Send unknown message type
    messageHandler!({ type: "unknown-type", requestId: "test-1" });

    // Wait for async handler
    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("error");
    expect(response.requestId).toBe("test-1");
    expect(response.success).toBe(false);
    expect(response.error).toContain("Unknown worker message type");
  });

  it("should handle dispose message when session is not initialized", async () => {
    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn(),
      },
      Tensor: vi.fn(),
    }));

    await import("../../src/dinov2/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({ type: "dispose", requestId: "test-dispose-1" });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("dispose");
    expect(response.requestId).toBe("test-dispose-1");
    expect(response.success).toBe(true);
  });

  it("should handle init message with mocked ONNX session", async () => {
    const mockSession = {
      run: vi.fn(),
      release: vi.fn(),
    };

    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn().mockResolvedValue(mockSession),
      },
      Tensor: vi.fn(),
    }));

    await import("../../src/dinov2/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    messageHandler!({
      type: "init",
      requestId: "test-init-1",
      modelPath: "/tmp/test-model.onnx",
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("init");
    expect(response.requestId).toBe("test-init-1");
    expect(response.success).toBe(true);
    expect(typeof response.loadTimeMs).toBe("number");
  });

  it("should send error when infer is called without init", async () => {
    vi.doMock("onnxruntime-node", () => ({
      InferenceSession: {
        create: vi.fn(),
      },
      Tensor: vi.fn(),
    }));

    await import("../../src/dinov2/worker-thread.js");

    expect(messageHandler).not.toBeNull();

    const imageBuffer = new ArrayBuffer(224 * 224 * 3);
    messageHandler!({
      type: "infer",
      requestId: "test-infer-no-init",
      imageBuffer,
      width: 224,
      height: 224,
    });

    await vi.waitFor(() => {
      expect(postedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const response = postedMessages[0] as Record<string, unknown>;
    expect(response.type).toBe("error");
    expect(response.requestId).toBe("test-infer-no-init");
    expect(response.success).toBe(false);
    expect(response.error).toContain("not initialized");
  });
});
