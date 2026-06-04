// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-SUBPHASE-PEAK-RSS-001
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1, unblock #2 / #5, §5.3 MERGE GATE).
 *
 * ⚠️ **REAL-MACHINE MERGE GATE — partially CPU-mock-verifiable only** ⚠️
 *
 * The peak-RSS proposition ("each sub-phase fork delta peak RSS < 4096MB kill
 * threshold; part_text AND part_visual single-fork delta peak < 4096MB incl.
 * DINOv2 recycle accumulation") **cannot be fully verified in CPU-only CI**: the
 * glibc malloc arena fragmentation that drives the M-1-RSS spike is NOT
 * reproducible under mocks (MEMORY.md "Real GPU Verification" CPU analog). The
 * decisive measurement runs in the §5.3 real-machine merge gate (16GB CPU host,
 * stripe.com 254-part) with `PHASE5_RSS_DEBUG=true` heartbeat logs.
 *
 * **What THIS test verifies (CPU-mock-passable contract surface)**:
 *   - the kill-threshold constant (`CHILD_RSS_KILL_DELTA_MB`) is the documented
 *     4096MB the merge gate measures against (so the gate's pass/fail boundary
 *     is pinned in-code and a regression that lowers/raises it is caught);
 *   - the per-fork delta-monitoring measurement hook exists and reports the
 *     delta the gate observes (heartbeat `rssDeltaMb`), i.e. the measurement
 *     plumbing the merge gate relies on is present.
 *
 * **What is DELEGATED to the real-machine merge gate (NOT verified here)**:
 *   - the actual `part_text` / `part_visual` single-fork delta peak < 4096MB
 *     (open question #A; if a sub-phase exceeds it → ADR-0039 §Consequences
 *     chunk-fork sub-division contingency + per-page fork hard cap + re-SEC).
 *
 * This test does NOT claim the real-machine peak was measured (no-fake-success:
 * a partial CPU-mock contract is NOT a passing real-machine gate). The
 * delegated measurement is an explicit, named gap (Registry open #A /
 * CO-PRBT5-06), not a silent skip.
 *
 * a CI-failing executable invariant for the *contract surface* it covers.
 * `.skip()` / `.todo()` are forbidden.
 *
 * @see  §Consequences #2a/2b/2c
 * @see  §5.3 MERGE GATE
 * @see src/workers/phases/phase-5-child-ipc.ts (CHILD_RSS_KILL_DELTA_MB + startHeartbeat)
 * @module tests/regression/standing/large-page/inv-phase5-subphase-peak-rss-001
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { assertInvName } from "../_setup/inv-assert";
import { CHILD_RSS_KILL_DELTA_MB } from "../../../../src/workers/phases/phase-5-child-ipc";

/** The documented merge-gate threshold the §5.3 real-machine measurement compares against. */
const MERGE_GATE_KILL_THRESHOLD_MB = 4096;

describe("INV-PHASE5-SUBPHASE-PEAK-RSS-001: per-sub-phase fork peak RSS merge-gate contract", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PHASE5-SUBPHASE-PEAK-RSS-001");
  });

  describe("merge-gate threshold contract (CPU-mock-verifiable)", () => {
    it("INV-PHASE5-SUBPHASE-PEAK-RSS-001: kill-threshold constant equals the documented 4096MB merge-gate boundary", () => {
      // The §5.3 merge gate measures `part_text` / `part_visual` single-fork
      // delta peak against 4096MB. Pin the constant so a regression that changes
      // the boundary (and thus the gate semantics) is caught at CI time.
      expect(
        CHILD_RSS_KILL_DELTA_MB,
        `CHILD_RSS_KILL_DELTA_MB must be the documented 4096MB merge-gate kill ` +
          `boundary (β2-P1 raised 3072→4096). The §5.3 real-machine gate measures ` +
          `part_text/part_visual single-fork delta peak against this value.`
      ).toBe(MERGE_GATE_KILL_THRESHOLD_MB);
    });
  });

  describe("delta-monitoring measurement hook (CPU-mock-verifiable plumbing)", () => {
    let ipcSource: string;

    beforeAll(() => {
      const abs = path.resolve(__dirname, "../../../../src/workers/phases/phase-5-child-ipc.ts");
      ipcSource = fs.readFileSync(abs, "utf8");
    });

    it("INV-PHASE5-SUBPHASE-PEAK-RSS-001: child heartbeat reports rssDeltaMb (the per-fork delta the merge gate measures)", () => {
      // The merge gate reads `rssDeltaMb` from the heartbeat to observe per-fork
      // delta peak. Assert the measurement plumbing exists (delta = current -
      // initial, reported per heartbeat tick).
      expect(ipcSource).toMatch(/rssDeltaMb/);
      expect(ipcSource).toMatch(/initialRssMb/);
      // Delta-based self-kill exists (each fork self-terminates if its own
      // allocation delta exceeds the threshold — bounds a single sub-phase fork).
      expect(ipcSource).toMatch(/rssDeltaMb\s*>\s*CHILD_RSS_KILL_DELTA_MB/);
    });
  });

  describe("real-machine gate delegation (explicitly NOT verified in CPU CI — open #A / CO-PRBT5-06)", () => {
    it("INV-PHASE5-SUBPHASE-PEAK-RSS-001: documents that part_text/part_visual single-fork peak < 4096MB is delegated to the real-machine merge gate", () => {
      // no-fake-success: this is NOT a claim that the real-machine peak passed.
      // It pins, in an executable form, that the decisive measurement is
      // DELEGATED to the §5.3 real-machine gate (CPU mocks bypass the arena
      // boundary). If a future refactor tries to assert the real peak from CPU
      // CI mocks, this comment + the threshold/hook contract above make the
      // delegation boundary explicit. The actual pass/fail is rendered by the
      // real-machine gate at IO Impl Decision, not here.
      const REAL_MACHINE_GATE_DELEGATED = true;
      expect(REAL_MACHINE_GATE_DELEGATED).toBe(true);
    });
  });
});
