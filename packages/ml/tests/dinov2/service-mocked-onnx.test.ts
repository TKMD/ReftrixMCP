// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Service Tests — Mocked ONNX Runtime
 *
 * This file is intentionally separated from `service.test.ts` to provide
 * **structural isolation** of the mocked-ONNX describe block.
 *
 * Background (IO Decision #4 / U-18 Option A''):
 *   Earlier iterations used `vi.doMock("onnxruntime-node", factory)` inside
 *   `beforeEach`. `vi.doMock` is **dynamic**: the factory is registered at
 *   runtime and applied to *future* `import()` calls only. When tests in the
 *   same process executed in sequence, a race window existed where a new test
 *   could begin its dynamic `import("../../src/dinov2/service.js")` before
 *   Vitest had finished swapping in the next `vi.doMock` registration. This
 *   produced a residual ~10% intra-file flake even after Path B' file split
 *   eliminated the cross-file ESM module cache leak (U-16).
 *
 *   Path B' resolved INTER-file isolation (separate process per file). Option
 *   A'' resolves INTRA-file determinism by switching to `vi.mock` + `vi.hoisted`:
 *
 *   - `vi.mock(path, factory)` is **statically hoisted** by Vitest to the top
 *     of the module BEFORE any `import` statements are evaluated. The mock is
 *     installed at module-load time, deterministic, and persists for the
 *     lifetime of the file.
 *   - `vi.hoisted(() => ...)` lets us pre-construct the shared `mockSession`
 *     object at hoist time so the `vi.mock` factory can reference it.
 *   - Per-test state cleanup happens via `mockReset()` / `mockClear()` on the
 *     individual `vi.fn()` instances inside the hoisted `mockSession`. This
 *     is purely synchronous and has no race window.
 *
 *   Because this entire file is dedicated to the mocked-ONNX scenario, a
 *   file-level static mock is the semantically correct choice — there is no
 *   describe block in this file that needs the real `onnxruntime-node`.
 *
 * Path B' structural argument (still applies):
 *   - `packages/ml/vitest.config.ts` uses `pool: "forks"` → each test file
 *     runs in an OS-level **separate process**.
 *   - Forked processes have **physically isolated memory** (no shared heap).
 *   - Node.js `require.cache`, ESM module registry, and Vitest mock state
 *     cannot leak across processes.
 *   - Combined with Option A'' static `vi.mock`, both inter-file and
 *     intra-file determinism are now structurally guaranteed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted(): pre-construct the shared mock session at hoist time so the
// vi.mock factory below (also hoisted) can capture it. The returned object
// reference is stable for the lifetime of the file; only the individual
// vi.fn() implementations are mutated per-test via mockReset / mockClear.
const { mockSession } = vi.hoisted(() => {
  return {
    mockSession: {
      run: vi.fn(),
      release: vi.fn(),
    },
  };
});

// vi.mock is statically hoisted by Vitest above all imports. The factory
// captures `mockSession` from the hoisted scope. This eliminates the
// `vi.doMock` race window where a future test's dynamic import could fire
// before the next `beforeEach` had finished registering the mock.
vi.mock("onnxruntime-node", () => ({
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

// Static import is now safe: vi.mock is hoisted and resolves before this line.
// The dynamic `await import(...)` pattern from the vi.doMock era is no longer
// required; each test can construct DINOv2Service directly.
import { DINOv2Service } from "../../src/dinov2/service.js";

describe("DINOv2Service with mocked ONNX", () => {
  beforeEach(() => {
    // Reset call history AND implementations on the shared mockSession fns.
    // mockReset() (vs mockClear()) also clears any per-test mockResolvedValueOnce
    // / mockRejectedValueOnce queues left over from a previous test, ensuring
    // each test starts from a clean default state.
    mockSession.run.mockReset();
    mockSession.release.mockReset();

    // Install the default success response for run(): a 257×768 fake output
    // with the CLS token (first 768 values) populated with deterministic data.
    const fakeOutput = new Float32Array(257 * 768);
    for (let i = 0; i < 768; i++) {
      fakeOutput[i] = (i % 10) / 10.0; // 0.0, 0.1, 0.2, ..., 0.9, 0.0, ...
    }
    mockSession.run.mockResolvedValue({
      last_hidden_state: {
        data: fakeOutput,
        dims: [1, 257, 768],
      },
    });

    // Install the default success response for release().
    mockSession.release.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // vi.mock is permanent (file-level static); do NOT call vi.doUnmock.
    // Only clear call history — implementations are reset in the next
    // beforeEach. We avoid vi.restoreAllMocks() because it would also
    // restore the InferenceSession.create / Tensor mocks installed by
    // the file-level vi.mock factory, breaking subsequent tests.
    vi.clearAllMocks();
  });

  it("should initialize and generate embedding", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });

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
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
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

  // U-12 reshape (preserved through Option A''): 1 test = 1 mock cycle. The
  // dispose-and-re-initialize transition is split into two it() blocks so
  // each gets a fresh `beforeEach` mock-state reset. With Option A''s static
  // vi.mock there is no race condition, but the 1:1 split is retained for
  // semantic clarity (each test exercises one transition).
  it("should dispose service and free resources", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });

    await service.initialize();
    expect(service.initialized).toBe(true);

    await service.dispose();
    expect(service.initialized).toBe(false);
    expect(mockSession.release).toHaveBeenCalled();

    await service.terminate();
  });

  it("should re-initialize after dispose", async () => {
    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });

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
    // Override the default success response for this single test only.
    mockSession.run.mockResolvedValueOnce({ some_other_output: {} });

    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
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

    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
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

    const service = new DINOv2Service({ modelPath: "/tmp/test-model.onnx" });
    await service.initialize();

    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    await expect(service.generateEmbedding(imageBuffer)).rejects.toThrow(
      "Zero vector: L2 norm is 0"
    );

    await service.terminate();
  });
});
