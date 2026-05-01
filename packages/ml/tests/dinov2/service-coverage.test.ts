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
 *
 * Background (DRIFT-U20-01 fix / Option A'' canonical pattern scope expansion):
 *   This file previously used `vi.doMock("onnxruntime-node", factory)` inside
 *   `beforeEach`. `vi.doMock` is **dynamic**: the factory is registered at
 *   runtime and applied to *future* `import()` calls only. This produced an
 *   intra-file flake under stress (directory pass^5 = 2/5 fail, isolation
 *   pass^5 = 1/5 fail). The race window was: a new test could begin its
 *   dynamic `await import("../../src/dinov2/service.js")` before Vitest had
 *   finished swapping in the next `vi.doMock` registration → ONNX Runtime
 *   tried to load the real model file `/tmp/test.onnx` → "Load model failed.
 *   File doesn't exist".
 *
 *   This conversion adopts the Option A'' canonical pattern (originally
 *   established in `service-mocked-onnx.test.ts` for U-18):
 *
 *   - `vi.mock(path, factory)` is **statically hoisted** by Vitest to the top
 *     of the module BEFORE any `import` statements are evaluated. The mock is
 *     installed at module-load time, deterministic, and persists for the
 *     lifetime of the file.
 *   - `vi.hoisted(() => ...)` lets us pre-construct a shared mutable
 *     `mockSession` (run / release vi.fn instances) and a shared
 *     `mockInferenceSessionCreate` vi.fn so the `vi.mock` factory can capture
 *     them. Per-test behaviour is set by mutating these fns via
 *     `mockResolvedValue` / `mockRejectedValueOnce`, which is purely
 *     synchronous and has no race window.
 *   - Static top-level `import` of `DINOv2Service` replaces all
 *     `await import("../../src/dinov2/service.js")` calls — vi.mock is
 *     hoisted, so the static import resolves against the mocked module.
 *
 *   Because every describe block in this file exercises mocked ONNX (no
 *   real-onnx test exists here), a file-level static mock is the
 *   semantically correct choice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Hoisted mock state (Option A'' canonical pattern)
// ============================================================================

// vi.hoisted(): pre-construct the shared mock objects at hoist time so the
// vi.mock factory below (also hoisted) can capture them. Each describe block
// resets behaviour in its beforeEach via mockReset / mockResolvedValue /
// mockRejectedValue on the captured vi.fn instances.
const { mockSession, mockInferenceSessionCreate } = vi.hoisted(() => {
  return {
    mockSession: {
      run: vi.fn(),
      release: vi.fn(),
    },
    mockInferenceSessionCreate: vi.fn(),
  };
});

// vi.mock is statically hoisted by Vitest above all imports. The factory
// captures the hoisted handles. This eliminates the `vi.doMock` race window
// where a future test's dynamic import could fire before the next beforeEach
// had finished registering the mock.
vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: mockInferenceSessionCreate,
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

// Static import is now safe: vi.mock is hoisted and resolves before this line.
// The dynamic `await import(...)` pattern from the vi.doMock era is no longer
// required; each test can construct DINOv2Service directly.
import {
  DINOv2Service,
  DINOV2_EMBEDDING_DIMENSION,
  DINOV2_INPUT_SIZE,
} from "../../src/dinov2/service.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Install the default mockSession.run success response: a 257×768 fake output
 * with the CLS token (first 768 values) populated with deterministic non-zero
 * data so L2 normalization produces a unit vector.
 */
function installDefaultRunResponse(): void {
  const fakeOutput = new Float32Array(257 * 768);
  for (let i = 0; i < 768; i++) {
    fakeOutput[i] = (i % 10) / 10.0 + 0.01; // Non-zero CLS token
  }
  mockSession.run.mockResolvedValue({
    last_hidden_state: {
      data: fakeOutput,
      dims: [1, 257, 768],
    },
  });
}

/**
 * Reset the shared mock state to a clean default:
 * - InferenceSession.create resolves to mockSession
 * - mockSession.run returns the standard 257×768 fake output
 * - mockSession.release resolves successfully
 *
 * Called from each describe block's beforeEach. Per-test overrides use
 * mockResolvedValueOnce / mockRejectedValueOnce / mockRejectedValue on the
 * already-captured fn references.
 */
function resetMocksToDefault(): void {
  mockInferenceSessionCreate.mockReset();
  mockSession.run.mockReset();
  mockSession.release.mockReset();

  mockInferenceSessionCreate.mockResolvedValue(mockSession);
  installDefaultRunResponse();
  mockSession.release.mockResolvedValue(undefined);
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
  beforeEach(() => {
    resetMocksToDefault();
  });

  afterEach(() => {
    // vi.mock is permanent (file-level static); do NOT call vi.doUnmock.
    // Only clear call history — implementations are reset in the next
    // beforeEach. We avoid vi.restoreAllMocks() because it would also
    // restore the file-level vi.mock factory, breaking subsequent tests.
    vi.clearAllMocks();
  });

  it("should not re-initialize when already initialized", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

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
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    // terminate without init should not throw
    await service.terminate();
    expect(service.initialized).toBe(false);
  });

  it("should handle dispose without prior initialization", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    // dispose without init should not throw
    await service.dispose();
    expect(service.initialized).toBe(false);
  });

  it("should handle dispose when session release throws", async () => {
    // Per-test override: make release reject for this test only. mockReset()
    // in the next beforeEach will clear this override.
    mockSession.release.mockReset();
    mockSession.release.mockRejectedValue(new Error("Release error"));

    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    // dispose should not throw even if release fails
    await service.dispose();
    expect(service.initialized).toBe(false);
  });

  it("should re-initialize after dispose on next generateEmbedding call", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

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
  beforeEach(() => {
    resetMocksToDefault();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should handle empty batch", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });
    await service.initialize();

    const result = await service.generateBatchEmbeddings([]);
    expect(result).toEqual([]);

    await service.terminate();
  });

  it("should process single-element batch", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });
    await service.initialize();

    const buffers = [Buffer.alloc(224 * 224 * 3, 128)];
    const result = await service.generateBatchEmbeddings(buffers);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);

    await service.terminate();
  });

  it("should process multiple buffers sequentially", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });
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
    resetMocksToDefault();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should throw descriptive error when model loading fails", async () => {
    // Per-test override: make InferenceSession.create reject. mockReset() in
    // the next beforeEach will restore the default (resolve to mockSession).
    mockInferenceSessionCreate.mockReset();
    mockInferenceSessionCreate.mockRejectedValue(new Error("Model not found"));

    const service = new DINOv2Service({ modelPath: "/nonexistent/model.onnx" });

    await expect(service.initialize()).rejects.toThrow("Model not found");
  });

  it("should throw on invalid buffer size with descriptive message", async () => {
    // Default mocks (resolve to mockSession) are sufficient — initialize()
    // will succeed, and the error is raised by the buffer-size validation
    // path inside generateEmbedding before run() is invoked.
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    const wrongSizeBuffer = Buffer.alloc(100);
    await expect(service.generateEmbedding(wrongSizeBuffer)).rejects.toThrow(
      "Invalid image buffer size"
    );

    await service.terminate();
  });
});
