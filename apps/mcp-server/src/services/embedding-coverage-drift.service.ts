// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Coverage Drift Service — PR-V3-T1a §3.3 V1-CO-04 closure
 *
 * Computes the drift between two `CoverageMetrics` snapshots (T1a-on vs.
 * T1a-off / chunked vs. unchunked baseline) for the canonical
 * `embedding_quality.coverage` <5% drift gate per Plan v3 V2 §17 R-1
 * mitigation. Used both by the staging A/B test protocol (design §3.3.3)
 * and by the standing regression suite (INV-COVERAGE-DRIFT-METHODOLOGY-001).
 *
 * Drift contract (per IO V0 §C-3 ruling, TPA winning contract; the旧案
 * `cosine ≥0.95` deterministic-equivalence contract is overruled and shall
 * not return):
 *
 *   - Drift unit = absolute percentage-point delta on the production-observed
 *     KPI `embedding_quality.coverage` (textCoveragePercent +
 *     visionCoveragePercent, both 0-100).
 *   - Drift gate = 5% absolute pp; exceeding the gate fails CI / blocks the
 *     production flip.
 *   - NaN / Infinity defense: input metrics outside [0, 100] are clamped to
 *     the nearest endpoint to avoid silent contract corruption (CWE-682
 *     incorrect-calculation defense).
 *
 * Pure / side-effect-free / deterministic. Reusable from the standing
 * Rules — H severity" requirement).
 *
 * @see  §3.3
 * @see  V1-CO-04
 * @see embedding-quality-monitor.service.ts (CoverageMetrics shape source)
 *
 * @module services/embedding-coverage-drift.service
 */

/**
 * Coverage drift band relative to the 5% absolute pp gate.
 *
 *   - `within_gate` — drift |Δtext| ≤ gate AND |Δvision| ≤ gate; production
 *     flip is allowed.
 *   - `exceeds_gate` — at least one axis exceeds the gate; rollback path
 *     activated per Plan v3 V2 §17 R-1 mitigation.
 *
 * Coverage drift band relative to the 5% gate.
 */
export type CoverageDriftBand = "within_gate" | "exceeds_gate";

/**
 * Default drift gate (absolute percentage points).
 *
 * Default drift gate (absolute pp).
 */
export const DEFAULT_COVERAGE_DRIFT_GATE_PP = 5;

/**
 * Coverage drift result. `textDriftPp` and `visionDriftPp` are signed deltas
 * (post − baseline); `band` is the canonical CI verdict against the gate.
 *
 * Coverage drift result. Signed pp deltas + canonical band verdict.
 */
export interface CoverageDriftResult {
  /** baseline `embedding_quality.coverage.textCoveragePercent` (clamped 0-100) */
  baselineTextPercent: number;
  /** baseline `embedding_quality.coverage.visionCoveragePercent` (clamped 0-100) */
  baselineVisionPercent: number;
  /** post-T1a `textCoveragePercent` (clamped 0-100) */
  postTextPercent: number;
  /** post-T1a `visionCoveragePercent` (clamped 0-100) */
  postVisionPercent: number;
  /** signed text drift in pp (post − baseline) */
  textDriftPp: number;
  /** signed vision drift in pp (post − baseline) */
  visionDriftPp: number;
  /** absolute max |Δ| across both axes */
  maxAbsoluteDriftPp: number;
  /** drift gate applied (defaults to DEFAULT_COVERAGE_DRIFT_GATE_PP) */
  gatePp: number;
  /** canonical band verdict */
  band: CoverageDriftBand;
}

/**
 * Coverage snapshot input. Mirrors `CoverageMetrics` from
 * `embedding-quality-monitor.service.ts` so existing callers can pass that
 * type directly without an adapter.
 *
 * Coverage snapshot input. Compatible with `CoverageMetrics`.
 */
export interface CoverageSnapshotInput {
  textCoveragePercent: number;
  visionCoveragePercent: number;
}

/**
 * Clamp a coverage percentage into [0, 100], guarding against NaN / Infinity
 * / out-of-band inputs (CWE-682 defense). Returns 0 on non-finite input.
 *
 * Clamp coverage percent into [0,100]; non-finite → 0.
 */
function clampCoveragePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Compute the coverage drift between baseline and post-T1a snapshots.
 *
 * Drift unit = absolute percentage-point delta on `embedding_quality.coverage`
 * (TPA winning contract per IO V0 §C-3 ruling). The旧案 `cosine ≥0.95`
 * deterministic-equivalence contract is overruled.
 *
 * @param baseline baseline coverage snapshot (control / unchunked)
 * @param post post-T1a coverage snapshot (chunked encoder hardened)
 * @param gatePp drift gate in absolute pp (default 5)
 * @returns canonical drift result with signed deltas + band verdict
 *
 * Compute coverage drift; TPA winning contract (NOT cosine equivalence).
 *
 * @see design §3.3.1 standing regression suite path
 * @see design §3.3.2 drift bound proof sketch
 */
export function computeCoverageDrift(
  baseline: CoverageSnapshotInput,
  post: CoverageSnapshotInput,
  gatePp: number = DEFAULT_COVERAGE_DRIFT_GATE_PP
): CoverageDriftResult {
  const baselineText = clampCoveragePercent(baseline.textCoveragePercent);
  const baselineVision = clampCoveragePercent(baseline.visionCoveragePercent);
  const postText = clampCoveragePercent(post.textCoveragePercent);
  const postVision = clampCoveragePercent(post.visionCoveragePercent);
  const textDrift = postText - baselineText;
  const visionDrift = postVision - baselineVision;
  const maxAbs = Math.max(Math.abs(textDrift), Math.abs(visionDrift));
  // Defensive: clamp gatePp into a sane band [0, 100] to prevent
  // gate=NaN / gate=-1 from silently flipping the verdict.
  const effectiveGate =
    Number.isFinite(gatePp) && gatePp >= 0 && gatePp <= 100
      ? gatePp
      : DEFAULT_COVERAGE_DRIFT_GATE_PP;
  return {
    baselineTextPercent: baselineText,
    baselineVisionPercent: baselineVision,
    postTextPercent: postText,
    postVisionPercent: postVision,
    textDriftPp: textDrift,
    visionDriftPp: visionDrift,
    maxAbsoluteDriftPp: maxAbs,
    gatePp: effectiveGate,
    band: maxAbs <= effectiveGate ? "within_gate" : "exceeds_gate",
  };
}

/**
 * Convenience helper: returns true iff the drift is within the gate.
 *
 * Convenience helper: drift within gate?
 */
export function isCoverageDriftWithinGate(
  baseline: CoverageSnapshotInput,
  post: CoverageSnapshotInput,
  gatePp: number = DEFAULT_COVERAGE_DRIFT_GATE_PP
): boolean {
  return computeCoverageDrift(baseline, post, gatePp).band === "within_gate";
}
