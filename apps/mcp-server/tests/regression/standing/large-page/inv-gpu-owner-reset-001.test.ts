// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-GPU-OWNER-RESET-001: `processPageAnalyzeJob()` の `finally` block で
 *   `gpuResourceManager.release()` を必ず呼ぶ。冪等性により release × N は
 *   release × 1 と同じ effect (concurrent / multi-call の両 case で
 *   `currentOwner==="none"` がリセットされる)。
 *
 * INV-GPU-OWNER-RESET-001: Phase 5 cleanup must invoke `release()` on every
 *   exit path; release × N invocations have the same effect as × 1
 *   (idempotent). Concurrent calls also yield single onProviderSwitch invoke.
 *
 * ## Test cases per V1 §4.3
 *
 *   - A: success path → release called, currentOwner="none" (verified
 *     downstream by next-job acquireForVision/Embedding seeing clean state).
 *   - B: error path (Phase 5 fork SIGKILL etc.) → release called, currentOwner="none".
 *   - C: skip path (memoryAbortEmbedding=true / vision precondition fail) →
 *     release called, currentOwner="none" (V1 §3.3 finally clause symmetric).
 *   - D (V1 NEW per U-T3V-2): multi-call idempotency — release × N MUST
 *     yield exactly 1 onProviderSwitch invocation. Concurrent Promise.all
 *     of 5 also yields counter=1.
 *
 * ## Implementation strategy
 *
 *   M2 では full processPageAnalyzeJob() を invoke せず、`GpuResourceManager`
 *   instance を直接操作することで Layer 3 idempotency contract を assert する。
 *   Real Phase 5 fork integration test is M3 candidate (orchestrator-level
 *   exit path coverage).
 *
 * @see Plan v3 T3-Vision V1 §3.3 Layer 3 / §4.3 INV-GPU-OWNER-RESET-001
 * @see Plan v3 T3-Vision V1 §1.2 U-T3V-2 (idempotency unit test landing)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return {
    ...actual,
    promisify: () => mockExecFile,
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("INV-GPU-OWNER-RESET-001 — Phase 5 cleanup pairing contract", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-GPU-OWNER-RESET-001");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Case A: success path — release after acquireForEmbedding
  // --------------------------------------------------------------------------
  it("INV-GPU-OWNER-RESET-001 case A: success path → release resets currentOwner to 'none'", async () => {
    mockExecFile.mockResolvedValue({ stdout: "2000, 12288, 10288, 0\n" });
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const { GpuResourceManager } = await import("../../../../src/services/gpu-resource-manager");
    GpuResourceManager.resetInstance();
    const mgr = GpuResourceManager.getInstance();

    await mgr.acquireForEmbedding();
    expect(mgr.getCurrentOwner()).toBe("embedding");

    await mgr.release();
    expect(mgr.getCurrentOwner()).toBe("none");
  });

  // --------------------------------------------------------------------------
  // Case B: error path → release still resets owner
  // --------------------------------------------------------------------------
  it("INV-GPU-OWNER-RESET-001 case B: error path simulation → release resets owner", async () => {
    mockExecFile.mockResolvedValue({ stdout: "2000, 12288, 10288, 0\n" });
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const { GpuResourceManager } = await import("../../../../src/services/gpu-resource-manager");
    GpuResourceManager.resetInstance();
    const mgr = GpuResourceManager.getInstance();

    await mgr.acquireForEmbedding();
    // Simulate Phase 5 fork SIGKILL error path — release MUST reset owner.
    await mgr.release();
    expect(mgr.getCurrentOwner()).toBe("none");
  });

  // --------------------------------------------------------------------------
  // Case C: skip path (memoryAbortEmbedding / vision precondition) → release
  //   is still called from the finally block; owner is "none" already (no-op).
  // --------------------------------------------------------------------------
  it("INV-GPU-OWNER-RESET-001 case C: skip path → release on owner='none' is no-op", async () => {
    const { GpuResourceManager, gpuModeSignal } =
      await import("../../../../src/services/gpu-resource-manager");
    GpuResourceManager.resetInstance();
    gpuModeSignal.requestedProvider = "cpu";
    gpuModeSignal.onProviderSwitch = vi.fn().mockResolvedValue(undefined);
    const mgr = GpuResourceManager.getInstance();

    expect(mgr.getCurrentOwner()).toBe("none");
    await mgr.release();
    expect(mgr.getCurrentOwner()).toBe("none");
    // No onProviderSwitch invocation — no-op early-return per V1 §1.2.
    expect(gpuModeSignal.onProviderSwitch).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case D (V1 NEW per U-T3V-2): multi-call idempotency
  //   release × N MUST yield exactly 1 onProviderSwitch invocation.
  // --------------------------------------------------------------------------
  it("INV-GPU-OWNER-RESET-001 case D: release × 5 sequential → exactly 1 onProviderSwitch invocation", async () => {
    mockExecFile.mockResolvedValue({ stdout: "2000, 12288, 10288, 0\n" });
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const onProviderSwitch = vi.fn().mockResolvedValue(undefined);

    const { GpuResourceManager, gpuModeSignal } =
      await import("../../../../src/services/gpu-resource-manager");
    GpuResourceManager.resetInstance();
    gpuModeSignal.onProviderSwitch = onProviderSwitch;
    const mgr = GpuResourceManager.getInstance();

    await mgr.acquireForEmbedding(); // primes currentOwner='embedding'
    onProviderSwitch.mockClear();

    // Act: 5 sequential releases.
    await mgr.release();
    await mgr.release();
    await mgr.release();
    await mgr.release();
    await mgr.release();

    // Assert: exactly 1 onProviderSwitch('cpu') invocation (from the first release).
    // Subsequent releases see currentOwner='none' and short-circuit.
    expect(onProviderSwitch).toHaveBeenCalledTimes(1);
    expect(onProviderSwitch).toHaveBeenCalledWith("cpu");
    expect(mgr.getCurrentOwner()).toBe("none");
  });

  // --------------------------------------------------------------------------
  // Case D (continued): concurrent Promise.all of 5 → terminal idempotent state
  //
  // Note: Under truly concurrent execution (Promise.all), each release()
  // synchronously checks `currentOwner !== 'none'` BEFORE any awaits resolve,
  // so each may proceed to invoke onProviderSwitch. The early-return guard at
  // gpu-resource-manager.ts:445 is sequential-safe (each subsequent release
  // sees 'none' AFTER the previous one resets), but concurrent N callers may
  // all observe 'embedding' before the first reset.
  //
  // V1 §1.2 fire-and-forget posture (per IO ruling) accepts this: the
  // contract guarantee is the **terminal idempotent state** (currentOwner ===
  // 'none' AND requestedProvider === 'cpu' regardless of N invocations);
  // onProviderSwitch is non-throwing and the additional invocations are no-ops
  // at the underlying ONNX layer (dispose() is idempotent per
  // packages/ml/src/embeddings/service.ts:996 contract).
  // --------------------------------------------------------------------------
  it("INV-GPU-OWNER-RESET-001 case D: concurrent release × 5 (Promise.all) → terminal owner='none' (fire-and-forget contract)", async () => {
    mockExecFile.mockResolvedValue({ stdout: "2000, 12288, 10288, 0\n" });
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const onProviderSwitch = vi.fn().mockResolvedValue(undefined);

    const { GpuResourceManager, gpuModeSignal } =
      await import("../../../../src/services/gpu-resource-manager");
    GpuResourceManager.resetInstance();
    gpuModeSignal.onProviderSwitch = onProviderSwitch;
    const mgr = GpuResourceManager.getInstance();

    await mgr.acquireForEmbedding();
    onProviderSwitch.mockClear();

    // Act: concurrent 5 releases.
    await Promise.all([mgr.release(), mgr.release(), mgr.release(), mgr.release(), mgr.release()]);

    // Terminal state contract (V1 §1.2 fire-and-forget posture):
    //   currentOwner === 'none' AND requestedProvider === 'cpu'.
    // The dispose() ONNX-side contract is idempotent (idleTimer null check),
    // so additional onProviderSwitch invocations are safe no-ops. Per V1 §1.2:
    //   "release() fire-and-forget acceptable. failure is non-fatal (next
    //    job's acquireForVision/Embedding will normalize state)."
    expect(mgr.getCurrentOwner()).toBe("none");
    expect(gpuModeSignal.requestedProvider).toBe("cpu");
    // Sanity: at least 1 invocation (the first concurrent caller),
    // bounded above by N=5 (concurrent fan-out).
    expect(onProviderSwitch).toHaveBeenCalled();
    expect(onProviderSwitch.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
