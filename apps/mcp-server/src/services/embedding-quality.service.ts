// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Quality Service — re-export façade
 *
 * PR-V3-T1a Phase 2 Step 5 disambiguates the historical naming drift between
 * `embedding-quality.service.ts` (cited in T1a design / registry / audits) and
 * the actual canonical implementation `embedding-quality-monitor.service.ts`.
 * This file is a thin re-export façade so historical citations continue to
 * resolve while the canonical SSOT remains the monitor service.
 *
 * The drift gate methodology added by PR-V3-T1a §3.3 (V1-CO-04 closure) lives
 * in `embedding-coverage-drift.service.ts` (separate file because the drift
 * gate is a stateless pure function, distinct from the monitor's stateful
 * baseline tracking).
 *
 * Re-export façade so historical T1a citations of `embedding-quality.service.ts`
 * resolve to the canonical `embedding-quality-monitor.service.ts`. Drift gate
 * methodology lives in `embedding-coverage-drift.service.ts`.
 *
 * @see services/embedding-quality-monitor.service.ts (canonical implementation)
 * @see services/embedding-coverage-drift.service.ts (PR-V3-T1a drift gate)
 *
 * @module services/embedding-quality.service
 */

export {
  L2_NORM_LOWER_THRESHOLD,
  L2_NORM_UPPER_THRESHOLD,
  DRIFT_WARNING_THRESHOLD,
  QUALITY_SCORE_ALERT_THRESHOLD,
  VISION_COVERAGE_ALERT_THRESHOLD,
  TEXT_COVERAGE_ALERT_THRESHOLD,
  EXPECTED_DIMENSIONS,
} from "./embedding-quality-monitor.service";
export type {
  EmbeddingDistribution,
  DriftResult,
  AnomalyResult,
} from "./embedding-quality-monitor.service";

// PR-V3-T1a §3.3 drift gate methodology (V1-CO-04 closure)
export {
  computeCoverageDrift,
  isCoverageDriftWithinGate,
  DEFAULT_COVERAGE_DRIFT_GATE_PP,
} from "./embedding-coverage-drift.service";
export type {
  CoverageDriftBand,
  CoverageDriftResult,
  CoverageSnapshotInput,
} from "./embedding-coverage-drift.service";
