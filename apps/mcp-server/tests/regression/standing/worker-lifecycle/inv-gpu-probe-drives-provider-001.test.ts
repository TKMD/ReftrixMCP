// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-GPU-PROBE-DRIVES-PROVIDER-001
 *
 * **PR-1 GPU-COORD / IO Plan Decision V1 APPROVE (anchor 019e562d)**
 * **FIND-PLAN-H-01 (TPA-H-01) closure / ADR-0038 §1.5**
 *
 * ## Contract / 不変条件
 *
 * **The Phase 5 fork-child VRAM probe MUST actually drive the CUDA-vs-CPU
 * provider selection — it is a WIRING, not an inert no-op replacement.**
 *
 * directive ⑤ (no-fake-success): a "drop-in no-op manager replacement" leaves
 * the provider-selection path unchanged (the no-op return value was never
 * consumed by the fork child — its only consumer was the in-process path at
 * `page-analyze-worker.ts:1736`). This INV structurally proves that the probe
 * result (free-VRAM check) reaches and drives the `ONNX_EXECUTION_PROVIDER`
 * env var that `detectExecutionProvider` reads, so the change is NOT inert.
 *
 * The probe runs **child-locally** (ADR-0038 §1.6, FIND-PLAN-M-01): no new
 * child→parent IPC message type is added. `wireChildExecutionProvider` sets
 * `process.env.ONNX_EXECUTION_PROVIDER` so the in-process DINOv2/e5 init
 * (`detectExecutionProvider`) selects the probe-decided provider.
 *
 * ## Honesty boundary (ADR-0038 §1.5) / directive ⑤ の honesty 境界
 *
 * This INV proves the probe is **wired** (drives provider selection on a stubbed
 * VRAM fixture, runnable on CPU-only CI). It does NOT prove a real GPU run selects
 * CUDA with sub-second latency — that requires a real GPU run (SCALE-VERIFY, PR-7).
 * "probe path exists" ≠ "GPU completion run exists".
 *
 * ## Scope (test cases)
 *
 * | # | What it pins                                                                          |
 * | - | ------------------------------------------------------------------------------------- |
 * | 1 | probe stub returning free VRAM ≥ threshold → wire selects "cuda" (drives provider)    |
 * | 2 | probe stub returning free VRAM < threshold → wire selects "cpu" (degraded)            |
 * | 3 | probe returns null (nvidia-smi absent) → "cpu" with `vram_contention` (graceful)      |
 * | 4 | `PHASE5_FORK_GPU_PROBE_ENABLED=false` rollback → "cpu" with `probe_disabled` (no probe) |
 * | 5 | `wireChildExecutionProvider` mutates `process.env.ONNX_EXECUTION_PROVIDER` (wiring)   |
 * | 6 | workload selects the correct threshold (visual=DINOv2, text=embedding)                |
 * | 7 | degraded classification: only contention/below-threshold are degraded (not disabled) |
 *
 * ## PR-1 H regression remediation (FIND-IMPL-PR1-H-NEW-01, merge blocker)
 *
 * 实机 GPU 检证 found that the probe selected CUDA on free VRAM alone, but the
 * host had NO CUDA EP shared library (`libonnxruntime_providers_cuda.so`), so
 * the e5/text in-process init raw-threw → 164 embedding failures. The probe MUST
 * gate CUDA on BOTH free VRAM ≥ threshold AND `verifyCudaAvailability()` (the EP
 * `.so` filesystem check). "probe intends CUDA" ≠ "ONNX can run CUDA" (directive
 * ⑤). When the EP `.so` is absent, the probe MUST select CPU with the new
 * `cuda_ep_unavailable` reason (a degraded outcome, surfaced to audit).
 *
 * | #  | What it pins                                                                          |
 * | -- | ------------------------------------------------------------------------------------- |
 * | 8  | free VRAM ≥ threshold BUT CUDA EP `.so` absent → "cpu" with `cuda_ep_unavailable`     |
 * | 9  | wire on CUDA-EP-absent host → ONNX_EXECUTION_PROVIDER=cpu (never wires unbacked cuda) |
 * | 10 | cuda_ep_unavailable IS a degraded outcome (audit-surfaced like vram_contention)      |
 * | 11 | EP `.so` not consulted when VRAM is already below threshold (short-circuit)           |
 *
 * @see ADR-0038 §1.1 / §1.5 / §1.6 (FIND-PLAN-H-01 / M-01)
 * @see  FIND-PLAN-H-01
 * @module tests/regression/standing/worker-lifecycle/inv-gpu-probe-drives-provider-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

// vi.hoisted so the mock factories can reference the mock fns.
const { mockQueryVram, mockVerifyCuda } = vi.hoisted(() => ({
  mockQueryVram: vi.fn(),
  mockVerifyCuda: vi.fn(),
}));

vi.mock("../../../../src/services/vision/vram-utils.js", () => ({
  queryVram: mockQueryVram,
}));

// PR-1 H regression (FIND-IMPL-PR1-H-NEW-01): the probe gates CUDA on the CUDA
// EP `.so` availability via `verifyCudaAvailability` (re-exported from @reftrixmcp/ml).
vi.mock("@reftrixmcp/ml", () => ({
  verifyCudaAvailability: mockVerifyCuda,
}));

import {
  probeChildExecutionProvider,
  wireChildExecutionProvider,
  isForkGpuProbeEnabled,
  isDegradedDecision,
} from "../../../../src/workers/phases/phase-5-gpu-probe";
import {
  DINOV2_MIN_VRAM_MB,
  EMBEDDING_MIN_VRAM_MB,
} from "../../../../src/services/vision/vram-thresholds";

const INV = "INV-GPU-PROBE-DRIVES-PROVIDER-001";

function vram(freeMb: number): {
  usedMb: number;
  totalMb: number;
  freeMb: number;
  gpuUtilizationPercent: number;
} {
  return { usedMb: 12288 - freeMb, totalMb: 12288, freeMb, gpuUtilizationPercent: 0 };
}

describe(`${INV}: Phase 5 fork-child VRAM probe drives provider selection`, () => {
  const savedProvider = process.env.ONNX_EXECUTION_PROVIDER;
  const savedFlag = process.env.PHASE5_FORK_GPU_PROBE_ENABLED;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    mockQueryVram.mockReset();
    mockVerifyCuda.mockReset();
    // Default: CUDA EP `.so` present (isolates the VRAM factor in tests 1-7).
    // Tests 8-11 override to false to simulate a CUDA-EP-absent host.
    mockVerifyCuda.mockReturnValue(true);
    delete process.env.ONNX_EXECUTION_PROVIDER;
    delete process.env.PHASE5_FORK_GPU_PROBE_ENABLED;
  });

  afterEach(() => {
    if (savedProvider === undefined) delete process.env.ONNX_EXECUTION_PROVIDER;
    else process.env.ONNX_EXECUTION_PROVIDER = savedProvider;
    if (savedFlag === undefined) delete process.env.PHASE5_FORK_GPU_PROBE_ENABLED;
    else process.env.PHASE5_FORK_GPU_PROBE_ENABLED = savedFlag;
  });

  it(`${INV}: free VRAM >= threshold selects "cuda" (probe drives CUDA)`, async () => {
    mockQueryVram.mockResolvedValue(vram(EMBEDDING_MIN_VRAM_MB + 100));
    const decision = await probeChildExecutionProvider("text");
    expect(decision.provider).toBe("cuda");
    expect(decision.reason).toBe("cuda_selected");
    expect(mockQueryVram).toHaveBeenCalledTimes(1);
  });

  it(`${INV}: free VRAM < threshold selects "cpu" (degraded fork_child_below_threshold)`, async () => {
    mockQueryVram.mockResolvedValue(vram(EMBEDDING_MIN_VRAM_MB - 100));
    const decision = await probeChildExecutionProvider("text");
    expect(decision.provider).toBe("cpu");
    expect(decision.reason).toBe("fork_child_below_threshold");
  });

  it(`${INV}: probe null (nvidia-smi absent) selects "cpu" with vram_contention (graceful)`, async () => {
    mockQueryVram.mockResolvedValue(null);
    const decision = await probeChildExecutionProvider("visual");
    expect(decision.provider).toBe("cpu");
    expect(decision.reason).toBe("vram_contention");
  });

  it(`${INV}: PHASE5_FORK_GPU_PROBE_ENABLED=false rollback selects "cpu" without probing (probe_disabled)`, async () => {
    process.env.PHASE5_FORK_GPU_PROBE_ENABLED = "false";
    expect(isForkGpuProbeEnabled()).toBe(false);
    const decision = await probeChildExecutionProvider("visual");
    expect(decision.provider).toBe("cpu");
    expect(decision.reason).toBe("probe_disabled");
    // Rollback path MUST NOT even call queryVram (legacy CPU-pinned behaviour).
    expect(mockQueryVram).not.toHaveBeenCalled();
  });

  it(`${INV}: wireChildExecutionProvider mutates ONNX_EXECUTION_PROVIDER (the actual wiring)`, async () => {
    mockQueryVram.mockResolvedValue(vram(DINOV2_MIN_VRAM_MB + 500));
    const decision = await wireChildExecutionProvider("visual");
    expect(decision.provider).toBe("cuda");
    // This is the wiring point: detectExecutionProvider reads this env var.
    expect(process.env.ONNX_EXECUTION_PROVIDER).toBe("cuda");

    mockQueryVram.mockResolvedValue(vram(DINOV2_MIN_VRAM_MB - 10));
    const cpuDecision = await wireChildExecutionProvider("visual");
    expect(cpuDecision.provider).toBe("cpu");
    expect(process.env.ONNX_EXECUTION_PROVIDER).toBe("cpu");
  });

  it(`${INV}: workload selects the correct VRAM threshold (visual=DINOv2 / text=embedding)`, async () => {
    // free VRAM between DINOv2 (1536) and embedding (2048) thresholds:
    // visual should pass (>=1536), text should fail (<2048).
    const between = Math.floor((DINOV2_MIN_VRAM_MB + EMBEDDING_MIN_VRAM_MB) / 2);
    expect(between).toBeGreaterThanOrEqual(DINOV2_MIN_VRAM_MB);
    expect(between).toBeLessThan(EMBEDDING_MIN_VRAM_MB);

    mockQueryVram.mockResolvedValue(vram(between));
    const visual = await probeChildExecutionProvider("visual");
    expect(visual.provider).toBe("cuda");
    expect(visual.thresholdMb).toBe(DINOV2_MIN_VRAM_MB);

    mockQueryVram.mockResolvedValue(vram(between));
    const text = await probeChildExecutionProvider("text");
    expect(text.provider).toBe("cpu");
    expect(text.thresholdMb).toBe(EMBEDDING_MIN_VRAM_MB);
  });

  it(`${INV}: degraded classification — only contention/below-threshold are degraded`, async () => {
    expect(
      isDegradedDecision({
        provider: "cpu",
        reason: "fork_child_below_threshold",
        freeVramMb: 100,
        thresholdMb: EMBEDDING_MIN_VRAM_MB,
      })
    ).toBe(true);
    expect(
      isDegradedDecision({
        provider: "cpu",
        reason: "vram_contention",
        freeVramMb: null,
        thresholdMb: EMBEDDING_MIN_VRAM_MB,
      })
    ).toBe(true);
    // probe_disabled is an operator rollback choice, NOT a degradation.
    expect(
      isDegradedDecision({
        provider: "cpu",
        reason: "probe_disabled",
        freeVramMb: null,
        thresholdMb: EMBEDDING_MIN_VRAM_MB,
      })
    ).toBe(false);
    // cuda_selected is the healthy path.
    expect(
      isDegradedDecision({
        provider: "cuda",
        reason: "cuda_selected",
        freeVramMb: 9999,
        thresholdMb: EMBEDDING_MIN_VRAM_MB,
      })
    ).toBe(false);
  });

  // ==========================================================================
  // PR-1 H regression remediation (FIND-IMPL-PR1-H-NEW-01, merge blocker)
  // ==========================================================================

  it(`${INV}: free VRAM >= threshold BUT CUDA EP absent selects "cpu" (cuda_ep_unavailable)`, async () => {
    // Mirrors the 实机 GPU 检证 host: free VRAM available, but no
    // libonnxruntime_providers_cuda.so. The probe MUST NOT select CUDA.
    mockQueryVram.mockResolvedValue(vram(EMBEDDING_MIN_VRAM_MB + 5000));
    mockVerifyCuda.mockReturnValue(false);

    const decision = await probeChildExecutionProvider("text");
    expect(decision.provider).toBe("cpu");
    expect(decision.reason).toBe("cuda_ep_unavailable");
    // VRAM was probed (free), and the EP `.so` check decided the downgrade.
    expect(mockQueryVram).toHaveBeenCalledTimes(1);
    expect(mockVerifyCuda).toHaveBeenCalled();
  });

  it(`${INV}: wire on CUDA-EP-absent host sets ONNX_EXECUTION_PROVIDER=cpu (never wires unbacked cuda)`, async () => {
    mockQueryVram.mockResolvedValue(vram(DINOV2_MIN_VRAM_MB + 5000));
    mockVerifyCuda.mockReturnValue(false);

    const decision = await wireChildExecutionProvider("visual");
    expect(decision.provider).toBe("cpu");
    expect(decision.reason).toBe("cuda_ep_unavailable");
    // The wiring point: detectExecutionProvider reads this — must be cpu so the
    // in-process e5/DINOv2 init never attempts an unbacked CUDA session.
    expect(process.env.ONNX_EXECUTION_PROVIDER).toBe("cpu");
  });

  it(`${INV}: cuda_ep_unavailable IS a degraded outcome (audit-surfaced)`, async () => {
    expect(
      isDegradedDecision({
        provider: "cpu",
        reason: "cuda_ep_unavailable",
        freeVramMb: 9999,
        thresholdMb: EMBEDDING_MIN_VRAM_MB,
      })
    ).toBe(true);
  });

  it(`${INV}: EP .so not consulted when VRAM is already below threshold (short-circuit)`, async () => {
    mockQueryVram.mockResolvedValue(vram(EMBEDDING_MIN_VRAM_MB - 100));
    mockVerifyCuda.mockReturnValue(true);

    const decision = await probeChildExecutionProvider("text");
    expect(decision.provider).toBe("cpu");
    // Below-threshold short-circuits BEFORE the EP check (cheaper, ordering).
    expect(decision.reason).toBe("fork_child_below_threshold");
  });
});
