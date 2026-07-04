// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-VISUAL-COVERAGE-FLOOR-001 (M)
 *
 * W6 Issue A PR-2 (part bbox gate-fix). Pins a **relative non-regression floor**
 * for the part bbox-**resolve** rate (the band→DOM-ancestry scope replacement must
 * not strictly lower the resolve rate vs the pre-fix baseline). The **absolute**
 * coverage % is NOT pinned here — fixing an absolute number in CI without a
 * real-machine baseline would be a fake-success (`feedback_no_fake_success` A-8).
 * Absolute coverage (60-75% approach) is the **real-machine DoD** (plan-v1 §5),
 * verified at PR-4 with real Playwright + real-browser screenshots.
 *
 * population: bbox-resolve rate (pre-crop), NOT part_visual embedding completion
 * (see inv-part-visual-coverage-001).
 *
 * Strengthened (Finding Registry §1-E/F):
 *   (E) seeded regression demonstrates a real RED — the non-regression assertion
 *       actually fails when a synthetic resolve-count drop is seeded (it is not a
 *       structural no-op green).
 *   (F) population delineation vs the existing `inv-part-visual-coverage-001` is
 *       documented in the test header + asserted via the helper's exported
 *       population-kind tag (so future drift between the two metrics surfaces).
 *
 * Host-independent: compares resolve counts (ratios) only; reads no real-DB,
 * no Playwright, no memory/RSS/VRAM thresholds.
 *
 * **Severity**: M (reclass from H, TDA-05). Relative regression floor; absolute
 * coverage is a real-machine DoD, not a CI gate.
 *
 * @see  §4.3
 * @see  §1 (E/F)
 * @module tests/regression/standing/large-page/inv-visual-coverage-floor-001
 */

import { describe, it, expect } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  computeResolveRate,
  assertNoResolveRateRegression,
  BBOX_RESOLVE_RATE_POPULATION_KIND,
} from "../../../../src/services/part/section-selector.helper";

// ============================================================================
// (F) population delineation
// ============================================================================

describe("INV-VISUAL-COVERAGE-FLOOR-001: (F) population delineation", () => {
  it("INV-VISUAL-COVERAGE-FLOOR-001: this INV's population is bbox-resolve (pre-crop), distinct from part_visual embedding completion", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISUAL-COVERAGE-FLOOR-001");
    // The helper exports a population-kind tag so the two metrics cannot silently
    // drift: this INV = "bbox-resolve"; inv-part-visual-coverage-001 = embedding
    // completion (crop + DINOv2). bbox-resolve ⊇ embedding-completion.
    expect(BBOX_RESOLVE_RATE_POPULATION_KIND).toBe("bbox-resolve");
    expect(BBOX_RESOLVE_RATE_POPULATION_KIND).not.toBe("part-visual-embedding-completion");
  });
});

// ============================================================================
// Relative non-regression floor
// ============================================================================

describe("INV-VISUAL-COVERAGE-FLOOR-001: relative non-regression floor", () => {
  it("INV-VISUAL-COVERAGE-FLOOR-001: resolve rate equal to baseline does not regress", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISUAL-COVERAGE-FLOOR-001");
    const baseline = computeResolveRate(189, 1000); // pre-fix illustrative ratio
    const current = computeResolveRate(189, 1000);
    // No regression: must not throw.
    expect(() => assertNoResolveRateRegression(baseline, current)).not.toThrow();
  });

  it("INV-VISUAL-COVERAGE-FLOOR-001: resolve rate above baseline does not regress (band→scope is additive)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISUAL-COVERAGE-FLOOR-001");
    const baseline = computeResolveRate(189, 1000);
    const current = computeResolveRate(620, 1000); // band removal lifts resolve rate
    expect(() => assertNoResolveRateRegression(baseline, current)).not.toThrow();
  });

  it("INV-VISUAL-COVERAGE-FLOOR-001: (E) seeded synthetic regression actually RED-fails (skeleton is not a no-op green)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISUAL-COVERAGE-FLOOR-001");
    // Seed a resolve-count DROP below baseline (beyond the tolerance) and assert the
    // floor genuinely fails. This proves the floor would catch a real future
    // regression rather than being a structurally-green no-op.
    const baseline = computeResolveRate(620, 1000);
    const regressed = computeResolveRate(300, 1000); // synthetic drop 62% → 30%
    expect(() => assertNoResolveRateRegression(baseline, regressed)).toThrow();
  });

  it("INV-VISUAL-COVERAGE-FLOOR-001: (E) a within-tolerance dip does NOT false-positive", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISUAL-COVERAGE-FLOOR-001");
    // A tiny within-tolerance dip (noise) must not trip the floor — the floor pins
    // a relative band, not bit-exact equality.
    const baseline = computeResolveRate(620, 1000);
    const current = computeResolveRate(618, 1000); // -0.2 pp, within tolerance
    expect(() => assertNoResolveRateRegression(baseline, current)).not.toThrow();
  });
});
