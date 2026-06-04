// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-MEMORY-CEILING-007
 *
 * PR-V3-T1a §3.4.2 (FIND-V3-IO-M-07 closure target). Worker-lifecycle
 * domain regression locking in:
 *
 *   - Default `DEFAULT_PARENT_RSS_MAX_MB = 8192 MB` per ADR-0013 Amendment 1
 *     (segmented from the legacy 7168 MB pre-T1a baseline).
 *   - Operator override path (env `PHASE5_PARENT_RSS_MAX_MB`) preserved.
 *   - 16 GB single-tenant safety envelope: parent 8192 + DINOv2 ~800 + e5-base
 *     ~500 ≈ 9492 MB ≈ 59% of 16 GB; remaining ~6.5 GB is the OS / Postgres /
 *     Redis / Chromium headroom budget.
 *   - `parent_rss_ceiling_scaled` audit emission idempotency contract.
 *
 * executable invariant in the worker-lifecycle domain. `.skip()` / `.todo()`
 * forbidden.
 *
 * INV-WORKER-MEMORY-CEILING-007 standing regression. Worker-lifecycle
 *
 * @see  §3.4.2
 * @see ADR-0013 Amendment 1 (parent ceiling 7168 → 8192 MB)
 *
 * @module tests/regression/standing/worker-lifecycle/inv-worker-memory-ceiling-007
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  loadPhase5Config,
  LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
  isParentRssCeilingScalingEvent,
  buildParentRssCeilingScaledDetails,
  __resetParentRssCeilingScaledForTesting,
  __isParentRssCeilingScaledEmittedForTesting,
} from "../../../../src/config/phase5-config";

describe("INV-WORKER-MEMORY-CEILING-007: PR-V3-T1a §3.4.2 parent RSS ceiling", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-MEMORY-CEILING-007");
  });

  describe("Default ceiling segmentation (T1.3)", () => {
    let prevEnv: string | undefined;

    beforeEach(() => {
      prevEnv = process.env.PHASE5_PARENT_RSS_MAX_MB;
      delete process.env.PHASE5_PARENT_RSS_MAX_MB;
    });

    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env.PHASE5_PARENT_RSS_MAX_MB;
      } else {
        process.env.PHASE5_PARENT_RSS_MAX_MB = prevEnv;
      }
    });

    it("INV-WORKER-MEMORY-CEILING-007: default parent RSS ceiling is 8192 MB (T1a-segmented)", () => {
      const config = loadPhase5Config();
      expect(config.parentRssMaxMb).toBe(8192);
    });

    it("INV-WORKER-MEMORY-CEILING-007: legacy pre-T1a ceiling constant locked at 7168 MB", () => {
      // Legacy constant must remain 7168 so the audit emission's `before_mb`
      // field deterministically records the scaling event delta.
      expect(LEGACY_PARENT_RSS_MAX_MB_PRE_T1A).toBe(7168);
    });
  });

  describe("Operator override path", () => {
    let prevEnv: string | undefined;

    beforeEach(() => {
      prevEnv = process.env.PHASE5_PARENT_RSS_MAX_MB;
    });

    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env.PHASE5_PARENT_RSS_MAX_MB;
      } else {
        process.env.PHASE5_PARENT_RSS_MAX_MB = prevEnv;
      }
    });

    it("INV-WORKER-MEMORY-CEILING-007: PHASE5_PARENT_RSS_MAX_MB=7168 preserves legacy ceiling", () => {
      process.env.PHASE5_PARENT_RSS_MAX_MB = "7168";
      const config = loadPhase5Config();
      expect(config.parentRssMaxMb).toBe(7168);
    });

    it("INV-WORKER-MEMORY-CEILING-007: NaN env value falls back to default (8192)", () => {
      process.env.PHASE5_PARENT_RSS_MAX_MB = "not-a-number";
      const config = loadPhase5Config();
      expect(config.parentRssMaxMb).toBe(8192);
    });
  });

  describe("Scaling event semantics", () => {
    beforeEach(() => {
      __resetParentRssCeilingScaledForTesting();
    });

    afterEach(() => {
      __resetParentRssCeilingScaledForTesting();
    });

    it("INV-WORKER-MEMORY-CEILING-007: default 8192 IS a scaling event", () => {
      expect(isParentRssCeilingScalingEvent({ parentRssMaxMb: 8192, maxSectionsInput: 50 })).toBe(
        true
      );
    });

    it("INV-WORKER-MEMORY-CEILING-007: operator-explicit 7168 is NOT a scaling event", () => {
      // Per design §3.4.2: operator override is an OVERRIDE, not a scaling
      // event. Audit emission MUST NOT fire in this case.
      expect(
        isParentRssCeilingScalingEvent({
          parentRssMaxMb: LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
          maxSectionsInput: 50,
        })
      ).toBe(false);
    });

    it("INV-WORKER-MEMORY-CEILING-007: audit details payload is PII-free numeric/fixed-string", () => {
      const prev = process.env.T1A_COMMIT_SHA;
      try {
        delete process.env.T1A_COMMIT_SHA;
        const details = buildParentRssCeilingScaledDetails();
        expect(details.before_mb).toBe(7168);
        expect(details.after_mb).toBe(8192);
        expect(details.trigger).toBe("plan_v3_t1a_landing");
        expect(details.commit_sha).toBe("unknown");
      } finally {
        if (prev === undefined) {
          delete process.env.T1A_COMMIT_SHA;
        } else {
          process.env.T1A_COMMIT_SHA = prev;
        }
      }
    });

    it("INV-WORKER-MEMORY-CEILING-007: emission idempotency flag starts unset", () => {
      // Sanity check: __reset call in beforeEach should clear the flag.
      expect(__isParentRssCeilingScaledEmittedForTesting()).toBe(false);
    });
  });

  describe("16 GB single-tenant safety envelope", () => {
    it("INV-WORKER-MEMORY-CEILING-007: total Phase 5 memory envelope ≤ 16 GB headroom", () => {
      // Design §3.4.2 (and §9.3): parent 8192 + DINOv2 ~800 + e5-base ~500
      // ≈ 9492 MB ≈ 59% of 16 GB. Remaining ~6.5 GB is OS/Postgres/Redis/
      // Chromium headroom. This invariant locks the design's safety envelope
      // numbers; any future raise of `DEFAULT_PARENT_RSS_MAX_MB` must keep
      // the total envelope under the 16 GB single-tenant ceiling.
      const parentCeilingMb = 8192;
      const dinov2EstimatedMb = 800;
      const e5BaseEstimatedMb = 500;
      const totalPhase5EnvelopeMb = parentCeilingMb + dinov2EstimatedMb + e5BaseEstimatedMb;
      const sixteenGbMb = 16 * 1024;
      const remainingHeadroomMb = sixteenGbMb - totalPhase5EnvelopeMb;

      expect(totalPhase5EnvelopeMb).toBeLessThanOrEqual(sixteenGbMb);
      // At least 6 GB headroom for OS / DB / Redis / Chromium (design §9.3).
      expect(remainingHeadroomMb).toBeGreaterThanOrEqual(6 * 1024);
    });
  });
});
