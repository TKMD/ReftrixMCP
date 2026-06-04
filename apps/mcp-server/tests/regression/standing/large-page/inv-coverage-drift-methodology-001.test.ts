// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-COVERAGE-DRIFT-METHODOLOGY-001
 *
 * PR-V3-T1a §3.3 V1-CO-04 closure target. Locks in the canonical drift gate
 * methodology (TPA winning contract per IO V0 §C-3 ruling) and explicitly
 * rejects re-introduction of the旧案 `cosine ≥0.95` deterministic-equivalence
 * contract.
 *
 * is a CI-failing executable invariant. `.skip()` / `.todo()` are forbidden.
 *
 * Methodology (canonical, locked-in):
 *   - Drift unit = absolute percentage-point delta on
 *     `embedding_quality.coverage` (textCoveragePercent + visionCoveragePercent).
 *   - Drift gate = 5% absolute pp.
 *   - NaN / Infinity defense via clampCoveragePercent (CWE-682).
 *   - Verdict = `within_gate` (production flip allowed) / `exceeds_gate`
 *     (rollback path per Plan v3 V2 §17 R-1).
 *
 * Standing regression locking the canonical
 * `embedding_quality.coverage <5% pp` drift gate per TPA winning contract.
 * The旧案 cosine ≥0.95 contract is overruled and shall not return.
 *
 * @see  §3.3
 * @see  V1-CO-04
 * @see services/embedding-coverage-drift.service.ts
 *
 * @module tests/regression/standing/large-page/inv-coverage-drift-methodology-001
 */

import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  computeCoverageDrift,
  isCoverageDriftWithinGate,
  DEFAULT_COVERAGE_DRIFT_GATE_PP,
} from "../../../../src/services/embedding-coverage-drift.service";

describe("INV-COVERAGE-DRIFT-METHODOLOGY-001: PR-V3-T1a §3.3 drift gate methodology", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-COVERAGE-DRIFT-METHODOLOGY-001");
  });

  describe("Canonical drift gate constant", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: gate is 5 percentage points (absolute)", () => {
      // Locks the gate constant at 5pp per TPA winning contract. Any change
      // requires an ADR + documented user-visible rationale.
      expect(DEFAULT_COVERAGE_DRIFT_GATE_PP).toBe(5);
    });
  });

  describe("Within-gate baseline regression", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: identical coverage = 0pp drift = within_gate", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: 92.0, visionCoveragePercent: 69.5 },
        { textCoveragePercent: 92.0, visionCoveragePercent: 69.5 }
      );
      expect(result.textDriftPp).toBe(0);
      expect(result.visionDriftPp).toBe(0);
      expect(result.maxAbsoluteDriftPp).toBe(0);
      expect(result.band).toBe("within_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: small positive drift (within gate) = within_gate", () => {
      // Predicted A/B test outcome per design §3.3.2 drift bound proof:
      // expected drift ≪ 5pp; FP32 rounding produces << 1pp delta.
      const result = computeCoverageDrift(
        { textCoveragePercent: 90.0, visionCoveragePercent: 70.0 },
        { textCoveragePercent: 90.5, visionCoveragePercent: 71.2 }
      );
      expect(result.textDriftPp).toBeCloseTo(0.5, 5);
      expect(result.visionDriftPp).toBeCloseTo(1.2, 5);
      expect(result.band).toBe("within_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: drift at exactly 5pp = within_gate (inclusive)", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: 80.0, visionCoveragePercent: 60.0 },
        { textCoveragePercent: 85.0, visionCoveragePercent: 60.0 }
      );
      expect(result.textDriftPp).toBe(5);
      expect(result.band).toBe("within_gate");
    });
  });

  describe("Exceeds-gate failure path", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: drift just above gate (5.01pp) = exceeds_gate", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: 80.0, visionCoveragePercent: 60.0 },
        { textCoveragePercent: 85.01, visionCoveragePercent: 60.0 }
      );
      expect(result.textDriftPp).toBeCloseTo(5.01, 5);
      expect(result.band).toBe("exceeds_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: large drift (10pp) = exceeds_gate (rollback path)", () => {
      // Plan v3 V2 §17 R-1 mitigation: gate failure → feature flag off rollback.
      const result = computeCoverageDrift(
        { textCoveragePercent: 90.0, visionCoveragePercent: 70.0 },
        { textCoveragePercent: 80.0, visionCoveragePercent: 65.0 }
      );
      expect(result.maxAbsoluteDriftPp).toBe(10);
      expect(result.band).toBe("exceeds_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: signed drift respects sign convention (post − baseline)", () => {
      // Coverage REGRESSION (post < baseline) → signed delta is negative.
      const result = computeCoverageDrift(
        { textCoveragePercent: 90.0, visionCoveragePercent: 70.0 },
        { textCoveragePercent: 87.0, visionCoveragePercent: 64.0 }
      );
      expect(result.textDriftPp).toBe(-3);
      expect(result.visionDriftPp).toBe(-6);
      expect(result.maxAbsoluteDriftPp).toBe(6);
      expect(result.band).toBe("exceeds_gate");
    });
  });

  describe("CWE-682 NaN/Infinity defense", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: NaN coverage value clamps to 0 (no silent contract corruption)", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: NaN, visionCoveragePercent: 70 },
        { textCoveragePercent: 90, visionCoveragePercent: 70 }
      );
      expect(result.baselineTextPercent).toBe(0);
      expect(result.textDriftPp).toBe(90);
      expect(result.band).toBe("exceeds_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: Infinity coverage value clamps to 0", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: Number.POSITIVE_INFINITY, visionCoveragePercent: 70 },
        { textCoveragePercent: 90, visionCoveragePercent: 70 }
      );
      expect(result.baselineTextPercent).toBe(0);
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: out-of-band coverage value clamped to 0/100", () => {
      const result = computeCoverageDrift(
        { textCoveragePercent: -50, visionCoveragePercent: 250 },
        { textCoveragePercent: 0, visionCoveragePercent: 100 }
      );
      expect(result.baselineTextPercent).toBe(0);
      expect(result.baselineVisionPercent).toBe(100);
      expect(result.textDriftPp).toBe(0);
      expect(result.visionDriftPp).toBe(0);
      expect(result.band).toBe("within_gate");
    });

    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: gate NaN falls back to canonical default", () => {
      // Defensive: gate NaN must not silently flip the verdict.
      const result = computeCoverageDrift(
        { textCoveragePercent: 90, visionCoveragePercent: 70 },
        { textCoveragePercent: 95, visionCoveragePercent: 70 },
        Number.NaN
      );
      expect(result.gatePp).toBe(DEFAULT_COVERAGE_DRIFT_GATE_PP);
      expect(result.band).toBe("within_gate"); // 5pp ≤ default 5pp gate
    });
  });

  describe("Convenience helper", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: isCoverageDriftWithinGate matches band verdict", () => {
      expect(
        isCoverageDriftWithinGate(
          { textCoveragePercent: 90, visionCoveragePercent: 70 },
          { textCoveragePercent: 92, visionCoveragePercent: 71 }
        )
      ).toBe(true);
      expect(
        isCoverageDriftWithinGate(
          { textCoveragePercent: 90, visionCoveragePercent: 70 },
          { textCoveragePercent: 80, visionCoveragePercent: 65 }
        )
      ).toBe(false);
    });
  });

  describe("Cosine ≥0.95 anti-pattern guard (TPA winning contract preservation)", () => {
    it("INV-COVERAGE-DRIFT-METHODOLOGY-001: drift contract operates on percentage-point unit, NOT cosine similarity", () => {
      // Locks: the methodology measures absolute pp delta on coverage, not
      // cosine similarity between embeddings. The旧案 `cosine ≥0.95`
      // contract was overruled by IO V0 §C-3 ruling and shall not return.
      // This test fails (and the file is unbuildable) if a future regression
      // tries to repurpose this drift gate to cosine semantic.
      const result = computeCoverageDrift(
        { textCoveragePercent: 100, visionCoveragePercent: 100 },
        { textCoveragePercent: 95, visionCoveragePercent: 95 }
      );
      // Cosine semantic (1.0 − 5e-7) would be "within tolerance" of 0.95;
      // pp semantic (5pp drift) is at the gate boundary (within_gate).
      // The verdict is shaped by pp, not cosine.
      expect(result.maxAbsoluteDriftPp).toBe(5);
      expect(result.band).toBe("within_gate");
    });
  });
});
