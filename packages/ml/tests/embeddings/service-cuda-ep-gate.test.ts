// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingService in-process CUDA-EP-availability gate
 *
 * **PR-1 GPU-COORD H regression remediation — FIND-IMPL-PR1-H-NEW-01 (merge blocker)**
 *
 * ## Contract / 不変条件
 *
 * **The e5/text in-process init MUST resolve its execution provider through the
 * same `detectExecutionProvider` gate (which internally calls
 * `verifyCudaAvailability`) that the DINOv2 in-process path uses, so that on a
 * CUDA-EP-absent host (`libonnxruntime_providers_cuda.so` not installed) it
 * NEVER passes `device:"cuda"` to the transformers pipeline and NEVER raw-throws.
 * It MUST safely fall back to CPU and complete embedding generation.**
 *
 * ### Root cause (实机 GPU 检证, 164 text/e5 failures)
 *
 * Both e5(text) and DINOv2(visual) run in-process in the Phase 5 fork child
 * (`EMBEDDING_WORKER_THREAD=false` / `DINOV2_WORKER_THREAD=false`).
 *
 * - DINOv2 (`dinov2/worker-thread.ts:initializeSession`) calls
 *   `detectExecutionProvider("DINOv2Worker")` → `verifyCudaAvailability()` →
 *   `.so` absent → "cpu" → safe.
 * - e5 (`embeddings/service.ts:initializeInProcess`) previously trusted
 *   `this.config.device` (set to "cuda" in the constructor straight from
 *   `ONNX_EXECUTION_PROVIDER=cuda`, which the GPU probe wires when free VRAM is
 *   available) WITHOUT the `verifyCudaAvailability` gate, then passed
 *   `device:"cuda"` to transformers. The native CUDA-EP `.so` load failed and
 *   the JS catch-retry could not save it → embedding phase fully failed.
 *
 * directive ⑤ (no-fake-success): "probe intends CUDA" ≠ "ONNX can run CUDA".
 * This test simulates the CUDA-EP-absent host (`verifyCudaAvailability=false`)
 * AND a transformers pipeline that throws on `device:"cuda"` (mirroring the
 * native dlopen failure) — proving the gate prevents the crash, not the
 * downstream JS catch-retry.
 *
 * @module tests/embeddings/service-cuda-ep-gate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock setup
// ============================================================================

/**
 * Mock transformers pipeline that REJECTS when device==="cuda", mirroring the
 * native CUDA-EP `.so` dlopen failure on a CUDA-EP-absent host. Records every
 * device it was asked to create so the test can assert "cuda" was never passed.
 */
const seenDevices: string[] = [];

function createMockOutput(embeddings: number[][]): {
  tolist: () => number[][];
  dispose: () => void;
} {
  return { tolist: () => embeddings, dispose: vi.fn() };
}

const mockPipelineFn = vi.fn().mockImplementation((input: string | string[]) => {
  if (Array.isArray(input)) {
    return Promise.resolve(createMockOutput(input.map(() => [0.1, 0.2, 0.3])));
  }
  return Promise.resolve(createMockOutput([[0.1, 0.2, 0.3]]));
});
const mockCallablePipeline = Object.assign(mockPipelineFn, {
  dispose: vi.fn().mockResolvedValue([]),
});

// pipeline(task, model, { device }) — the factory the in-process init calls.
const pipelineFactory = vi
  .fn()
  .mockImplementation(
    async (_task: string, _model: string, opts: { device?: string }): Promise<unknown> => {
      seenDevices.push(opts?.device ?? "<undefined>");
      if (opts?.device === "cuda") {
        // Simulate native CUDA-EP `.so` dlopen failure (raw throw).
        throw new Error("LoadLibrary failed: libonnxruntime_providers_cuda.so not found");
      }
      return mockCallablePipeline;
    }
  );

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineFactory,
}));

// Worker thread disabled → force in-process path (also auto-disabled under VITEST).
vi.mock("node:worker_threads", () => ({
  Worker: vi.fn().mockImplementation(() => {
    throw new Error("Worker thread disabled in test");
  }),
}));

// Mock the provider detection to simulate CUDA-EP presence/absence.
//
// The production gate (`resolveInProcessDevice`) calls `detectExecutionProvider`
// (which internally calls `verifyCudaAvailability` for the EP `.so` filesystem
// check) and `isLdLibraryPathSetAtOsLevel`. We mock these two exported entry
// points directly — `detectExecutionProvider` is the exact gate the production
// code invokes, so this faithfully simulates a CUDA-EP-absent vs -present host.
const { mockDetectProvider, mockIsLdPath } = vi.hoisted(() => ({
  mockDetectProvider: vi.fn(),
  mockIsLdPath: vi.fn(),
}));

vi.mock("../../src/onnx-provider-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/onnx-provider-detect.js")>();
  return {
    ...actual,
    detectExecutionProvider: mockDetectProvider,
    isLdLibraryPathSetAtOsLevel: mockIsLdPath,
  };
});

// ============================================================================
// Tests
// ============================================================================

describe("EmbeddingService in-process CUDA-EP gate (FIND-IMPL-PR1-H-NEW-01)", () => {
  const savedProvider = process.env.ONNX_EXECUTION_PROVIDER;

  beforeEach(() => {
    seenDevices.length = 0;
    pipelineFactory.mockClear();
    mockDetectProvider.mockReset();
    mockIsLdPath.mockReset();
    mockIsLdPath.mockReturnValue(true); // LD_LIBRARY_PATH present (isolate the EP-absent factor)
  });

  afterEach(async () => {
    if (savedProvider === undefined) delete process.env.ONNX_EXECUTION_PROVIDER;
    else process.env.ONNX_EXECUTION_PROVIDER = savedProvider;
  });

  it("CUDA-EP-absent host: ONNX_EXECUTION_PROVIDER=cuda must NOT pass device:cuda and must NOT raw-throw", async () => {
    // Probe wired ONNX_EXECUTION_PROVIDER=cuda (free VRAM), but the host has no
    // CUDA EP `.so`, so verifyCudaAvailability returns false.
    process.env.ONNX_EXECUTION_PROVIDER = "cuda";
    // CUDA-EP-absent host: detectExecutionProvider (verifyCudaAvailability) resolves CPU.
    mockDetectProvider.mockReturnValue("cpu");

    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    // BEFORE the fix this raw-throws (device:"cuda" reaches the pipeline factory).
    // AFTER the fix it resolves to CPU via detectExecutionProvider and completes.
    const embedding = await service.generateEmbedding("hello world", "query");

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
    // The gate MUST prevent "cuda" from ever reaching the pipeline factory.
    expect(seenDevices).not.toContain("cuda");
    expect(seenDevices).toContain("cpu");

    await service.terminate();
  });

  it("CUDA-EP-present host: ONNX_EXECUTION_PROVIDER=cuda resolves to cuda (gate does not over-restrict)", async () => {
    process.env.ONNX_EXECUTION_PROVIDER = "cuda";
    mockDetectProvider.mockReturnValue("cuda"); // EP `.so` present on this host

    // On an EP-present host the factory must NOT throw for cuda.
    pipelineFactory.mockImplementationOnce(
      async (_task: string, _model: string, opts: { device?: string }): Promise<unknown> => {
        seenDevices.push(opts?.device ?? "<undefined>");
        return mockCallablePipeline;
      }
    );

    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    const embedding = await service.generateEmbedding("hello world", "query");
    expect(Array.isArray(embedding)).toBe(true);
    // Gate allows cuda when the EP is genuinely available.
    expect(seenDevices).toContain("cuda");

    await service.terminate();
  });

  it("default (no ONNX_EXECUTION_PROVIDER): resolves to cpu without consulting verifyCudaAvailability for cuda", async () => {
    delete process.env.ONNX_EXECUTION_PROVIDER;
    mockDetectProvider.mockReturnValue("cpu");

    const mod = await import("../../src/embeddings/service.js");
    const service = new mod.EmbeddingService();

    const embedding = await service.generateEmbedding("hello world", "query");
    expect(Array.isArray(embedding)).toBe(true);
    expect(seenDevices).not.toContain("cuda");
    expect(seenDevices).toContain("cpu");
    // device is undefined (CPU) — the gate short-circuits and never consults
    // detectExecutionProvider for the CUDA EP `.so`.
    expect(mockDetectProvider).not.toHaveBeenCalled();

    await service.terminate();
  });
});
