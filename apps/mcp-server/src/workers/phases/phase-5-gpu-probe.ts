// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Fork-Child VRAM Probe (GPU-COORD, ADR-0038 Decision 1)
 *
 * Phase 5 の fork child は GpuResourceManager を持たない (ADR-0037 fork-only 境界)。
 * 本 module は fork child の **child-local** な VRAM probe を提供し、free VRAM が
 * 閾値以上か確認したうえで CUDA-vs-CPU を **意図選択** する。
 *
 * **配線先 (ADR-0038 §1.1) / Wiring point**:
 *   probe は DINOv2 / e5 init の **pre-flight** として child entrypoint
 *   (`phase-5-{text,visual}-embedding-child.ts`) で実行され、`detectExecutionProvider`
 *   (`packages/ml/.../onnx-provider-detect.ts`、`ONNX_EXECUTION_PROVIDER` env を読む)
 *   が CUDA を選べるよう `process.env.ONNX_EXECUTION_PROVIDER` を child-local に設定する。
 *   これにより probe 結果 (free VRAM 確認) が provider 選択を **実際に駆動** する
 *   (INV-GPU-PROBE-DRIVES-PROVIDER-001、directive ⑤ no-fake-success)。
 *
 *   The probe runs as a pre-flight to DINOv2/e5 init in the child entrypoint and
 *   sets `process.env.ONNX_EXECUTION_PROVIDER` child-locally so that
 *   `detectExecutionProvider` (which reads that env var) can select CUDA. The probe
 *   result (free-VRAM check) thus actually drives provider selection
 *   (INV-GPU-PROBE-DRIVES-PROVIDER-001, directive ⑤ no-fake-success).
 *
 * **新規 IPC type 0 (ADR-0038 §1.6, FIND-PLAN-M-01, SEC-M-2)**:
 *   probe は free VRAM 確認も provider 選択も fork child プロセス内で完結し、parent に
 *   問い合わせない。`phase-5-child-ipc.ts` に新規 schema を追加しない。degraded mode の
 *   可視化は parent 側の audit emit (DB write) で行い、IPC channel を経由しない。
 *
 * **ADR-0037 fork-only 境界保全 (INV-GPU-PROBE-LEAF-IMPORT-001)**:
 *   閾値定数は leaf module (`services/vision/vram-thresholds.ts`) から import する
 *   (in-process full `gpu-resource-manager.ts` を import しない)。VRAM query は
 *   leaf util (`services/vision/vram-utils.ts` の `queryVram`、execFile injection-safe)
 *   を再利用する。
 *
 * **rollback (ADR-0038 Decision 4)**:
 *   `PHASE5_FORK_GPU_PROBE_ENABLED=false` で旧 CPU 固定挙動に即復帰する。flag が
 *   false のとき probe は実行されず、`reason: "probe_disabled"` で CPU を返す。
 *
 * @see ADR-0038 §1.1 / §1.2 / §1.3 / §1.5 / §1.6 / Decision 4
 * @see ADR-0037 (per-job fork-only model)
 * @module workers/phases/phase-5-gpu-probe
 */

import { verifyCudaAvailability } from "@reftrixmcp/ml";
import { queryVram } from "../../services/vision/vram-utils.js";
import {
  DINOV2_MIN_VRAM_MB,
  EMBEDDING_MIN_VRAM_MB,
} from "../../services/vision/vram-thresholds.js";
import { parseBoolEnv } from "../../utils/env-validators.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Child-local provider selection mode (CUDA-vs-CPU).
 */
export type ChildExecutionProvider = "cuda" | "cpu";

/**
 * Reason enum for the child-local provider decision. Mirrors the audit
 * `embedding_cpu_fallback_degraded` reason enum (ADR-0038 Decision 2):
 *   - `cuda_selected`             — free VRAM ≥ threshold AND CUDA EP `.so` present, CUDA selected
 *   - `probe_disabled`           — `PHASE5_FORK_GPU_PROBE_ENABLED=false` (rollback)
 *   - `fork_child_below_threshold` — free VRAM < threshold, CPU selected
 *   - `vram_contention`          — probe returned null (nvidia-smi absent / query failed)
 *   - `cuda_ep_unavailable`      — free VRAM ≥ threshold BUT the CUDA EP shared
 *                                   library (`libonnxruntime_providers_cuda.so`)
 *                                   is absent, so CUDA cannot actually run; CPU
 *                                   selected (FIND-IMPL-PR1-H-NEW-01). "probe
 *                                   intends CUDA" ≠ "ONNX can run CUDA".
 */
export type ChildProviderReason =
  | "cuda_selected"
  | "probe_disabled"
  | "fork_child_below_threshold"
  | "vram_contention"
  | "cuda_ep_unavailable";

/**
 * Result of the child-local VRAM probe.
 */
export interface ChildProviderDecision {
  /** Resolved execution provider for the fork child. */
  provider: ChildExecutionProvider;
  /** Reason enum (drives degraded audit emit when provider === "cpu" and degraded). */
  reason: ChildProviderReason;
  /** Free VRAM (MB) observed by the probe, or null when probe was skipped / failed. */
  freeVramMb: number | null;
  /** Threshold (MB) the probe compared against. */
  thresholdMb: number;
}

/**
 * Which embedding workload the fork child runs (selects the VRAM threshold).
 */
export type ChildWorkload = "visual" | "text";

// ============================================================================
// Feature flag (ADR-0038 Decision 4, Zod boolean)
// ============================================================================

/**
 * Resolve the `PHASE5_FORK_GPU_PROBE_ENABLED` feature flag (default true).
 *
 * Uses the canonical strict boolean env parser (`parseBoolEnv`, CWE-1188
 * "Insecure Default Initialization" mitigation): accepts only `"true"` /
 * `"false"` (case-sensitive); non-canonical values throw at boot rather than
 * silently mis-resolving. `undefined` / `""` returns the default (`true`,
 * opt-out). `PHASE5_FORK_GPU_PROBE_ENABLED=false` is the structural rollback
 * path — it immediately restores the legacy CPU-pinned fork-child behaviour
 * (ADR-0038 Decision 4).
 */
export function isForkGpuProbeEnabled(): boolean {
  return parseBoolEnv(process.env.PHASE5_FORK_GPU_PROBE_ENABLED, true);
}

// ============================================================================
// Threshold selection
// ============================================================================

/**
 * Select the free-VRAM threshold (MB) for the given workload.
 */
function thresholdForWorkload(workload: ChildWorkload): number {
  return workload === "visual" ? DINOV2_MIN_VRAM_MB : EMBEDDING_MIN_VRAM_MB;
}

// ============================================================================
// Child-local probe
// ============================================================================

/**
 * Run the child-local VRAM probe and decide CUDA-vs-CPU for the fork child.
 *
 * Pure decision function (no env mutation). `wireChildExecutionProvider` applies
 * the decision to `process.env`. Kept separate for testability (CC ≤ 10).
 *
 * @param workload  which embedding workload the child runs (selects threshold)
 * @returns the provider decision + reason + observed free VRAM
 */
export async function probeChildExecutionProvider(
  workload: ChildWorkload
): Promise<ChildProviderDecision> {
  const thresholdMb = thresholdForWorkload(workload);

  if (!isForkGpuProbeEnabled()) {
    return { provider: "cpu", reason: "probe_disabled", freeVramMb: null, thresholdMb };
  }

  const vram = await queryVram();
  if (vram === null) {
    // nvidia-smi absent / query failed — CPU (graceful, existing behaviour).
    return { provider: "cpu", reason: "vram_contention", freeVramMb: null, thresholdMb };
  }

  if (vram.freeMb < thresholdMb) {
    // Below threshold short-circuits BEFORE the EP `.so` check (cheaper).
    return {
      provider: "cpu",
      reason: "fork_child_below_threshold",
      freeVramMb: vram.freeMb,
      thresholdMb,
    };
  }

  // Free VRAM is sufficient — but CUDA can only actually run if the CUDA EP
  // shared library (`libonnxruntime_providers_cuda.so`) is installed. The 实机
  // GPU 检证 host had free VRAM but no EP `.so`, and the e5/text in-process init
  // raw-threw → 164 failures (FIND-IMPL-PR1-H-NEW-01). Gate CUDA on BOTH free
  // VRAM AND EP availability. "probe intends CUDA" ≠ "ONNX can run CUDA"
  // (directive ⑤, no-fake-success). `verifyCudaAvailability` is a pure
  // filesystem check (no GPU/native init), safe in the fork-child leaf path.
  if (!verifyCudaAvailability("Phase5GpuProbe")) {
    return {
      provider: "cpu",
      reason: "cuda_ep_unavailable",
      freeVramMb: vram.freeMb,
      thresholdMb,
    };
  }

  return {
    provider: "cuda",
    reason: "cuda_selected",
    freeVramMb: vram.freeMb,
    thresholdMb,
  };
}

/**
 * Run the probe and **wire the decision into provider selection** by setting
 * `process.env.ONNX_EXECUTION_PROVIDER` child-locally.
 *
 * This is the actual wiring (ADR-0038 §1.1): the in-process DINOv2/e5 init reads
 * `ONNX_EXECUTION_PROVIDER` via `detectExecutionProvider`, so setting it here
 * drives whether the child intends CUDA or CPU. When the decision is CUDA the
 * parent's CPU-pinning (`buildChildEnv` forced `cpu`) has been omitted (probe
 * enabled), so this set lets CUDA be selected. When the decision is CPU we keep
 * `cpu` explicitly (idempotent with the parent's forced value).
 *
 * @param workload  which embedding workload the child runs
 * @returns the provider decision (caller relays degraded reason to parent for audit)
 */
export async function wireChildExecutionProvider(
  workload: ChildWorkload
): Promise<ChildProviderDecision> {
  const decision = await probeChildExecutionProvider(workload);
  // Drive `detectExecutionProvider` (reads ONNX_EXECUTION_PROVIDER) child-locally.
  process.env.ONNX_EXECUTION_PROVIDER = decision.provider;
  return decision;
}

/**
 * Whether the decision represents a degraded (CPU-fallback) outcome that should
 * be surfaced via the `embedding_cpu_fallback_degraded` audit emit.
 *
 * `probe_disabled` is NOT degraded — it is an explicit operator rollback choice,
 * not a VRAM-contention degradation. `cuda_selected` is the healthy path.
 * `cuda_ep_unavailable` IS degraded: free VRAM was available but the CUDA EP
 * `.so` was missing, so the run silently dropped to CPU (FIND-IMPL-PR1-H-NEW-01)
 * — operators should see this to fix the host's CUDA EP installation.
 */
export function isDegradedDecision(decision: ChildProviderDecision): boolean {
  return (
    decision.reason === "fork_child_below_threshold" ||
    decision.reason === "vram_contention" ||
    decision.reason === "cuda_ep_unavailable"
  );
}
