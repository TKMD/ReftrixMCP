// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-BUDGET-KILL-ORDER-012 (PR-C4 V1.1 §3 G / SEC-PLAN-04 → H promotion /
 * SEC CONDITIONAL U2 / NEW-SEC-C-L-01):
 *
 *   The per-chunk RSS budget (`PER_CHUNK_RSS_BUDGET_MB`, default 1536) MUST be
 *   strictly LESS THAN the Phase 5 fork-kill ceiling (`CHILD_RSS_KILL_DELTA_MB`
 *   / `PHASE5_CHILD_RSS_KILL_DELTA_MB`, default 4096). If the two are
 *   misconfigured into an inversion (`PER_CHUNK_RSS_BUDGET_MB >=
 *   CHILD_RSS_KILL_DELTA_MB`, e.g. `PER_CHUNK_RSS_BUDGET_MB=5000`), the per-chunk
 *   budget would fire AFTER the fork-kill backstop — the OOM defense loses its
 *   meaning (CWE-770 Allocation of Resources Without Limits adjacency).
 *
 *   Contract (`assertBudgetBelowKillThreshold(budgetMb?, killDeltaMb?)` boot-time
 *   guard, fail-closed, same shape as `assertNoTestOnlyEnvLeak` in
 *   config/test-env-guard.ts; the two MB values are injectable for fault
 *   injection and default to the resolved post-validation T1 constants):
 *     (a) THROW on inversion: `budget >= kill` makes the guard THROW → worker
 *         startup is rejected (fail-closed).
 *     (b) PASS on normal: the default range (1536 < 4096) and any valid
 *         `budget < kill` passes the guard → startup succeeds. This is the SEC
 *         CONDITIONAL U2 requirement (the guard MUST NOT mis-fire on a valid
 *         configuration — RISKS R5).
 *
 * # Test strategy
 *
 *   Pure leaf-guard contract (no testcontainer / Redis): the guard accepts two
 *   injectable MB args (default the resolved `PER_CHUNK_RSS_BUDGET_MB` /
 *   `CHILD_RSS_KILL_DELTA_MB` T1 constants) so CI can inject both the inversion
 *   (assert throw) and a normal config (assert pass) deterministically —
 *   mirroring `inv-sec-m1-env-guard` / `assertNoTestOnlyEnvLeak`.
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` / `describe.skip` are
 * FORBIDDEN (SEC-04 is H severity; Severity → Landing Rules require code + a
 * CI-failing test). Failure is a P0 incident handled by security-engineer +
 * pipeline-engineer.
 *
 * @see  §3 G / §4 / §6.1
 * @see  (G row, U2)
 * @see apps/mcp-server/src/config/budget-guard.ts (assertBudgetBelowKillThreshold)
 * @see apps/mcp-server/src/config/test-env-guard.ts (assertNoTestOnlyEnvLeak boot-guard precedent)
 * @see apps/mcp-server/src/workers/phases/types.ts (PER_CHUNK_RSS_BUDGET_MB, default 1536)
 * @see apps/mcp-server/src/workers/phases/phase-5-child-ipc.ts (CHILD_RSS_KILL_DELTA_MB, default 4096)
 * @see CONTRIBUTING.md (CWE-770 boundary)
 *
 * @module tests/regression/standing/large-page/inv-backfill-budget-kill-order-012
 */

import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { assertBudgetBelowKillThreshold } from "../../../../src/config/budget-guard";
import { PER_CHUNK_RSS_BUDGET_MB } from "../../../../src/workers/phases/types";
import { CHILD_RSS_KILL_DELTA_MB } from "../../../../src/workers/phases/phase-5-child-ipc";

describe("INV-BACKFILL-BUDGET-KILL-ORDER-012: PER_CHUNK_RSS_BUDGET_MB < CHILD_RSS_KILL_DELTA_MB boot guard", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-BUDGET-KILL-ORDER-012");
  });

  // --------------------------------------------------------------------------
  // (a) THROW on inversion (fail-closed startup rejection)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (a) inversion (budget=5000 >= kill=4096) → guard THROWS (fail-closed)", () => {
    expect(() => assertBudgetBelowKillThreshold(5000, 4096)).toThrow();
  });

  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (a) equality (budget == kill) is also an inversion → guard THROWS (strict <)", () => {
    // The invariant is STRICT (`budget < kill`); equality means the per-chunk
    // budget never wins the race against the fork-kill → guard must reject.
    expect(() => assertBudgetBelowKillThreshold(4096, 4096)).toThrow();
  });

  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (a) inversion error message names both budget env vars (operator actionability)", () => {
    // The fail-closed error must be actionable: it should reference the two
    // env vars so an operator can fix the misconfiguration without reading code.
    let caught: unknown;
    try {
      assertBudgetBelowKillThreshold(8192, 4096);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("PER_CHUNK_RSS_BUDGET_MB");
    expect(msg).toContain("PHASE5_CHILD_RSS_KILL_DELTA_MB");
  });

  // --------------------------------------------------------------------------
  // (b) PASS on normal config (SEC CONDITIONAL U2 — no mis-fire, RISKS R5)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (b) defaults (budget=1536 < kill=4096) → guard PASSES (no mis-fire, SEC CONDITIONAL U2)", () => {
    // Explicit default values.
    expect(() => assertBudgetBelowKillThreshold(1536, 4096)).not.toThrow();
  });

  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (b) valid non-default ordering (budget=2048 < kill=8192) → guard PASSES", () => {
    expect(() => assertBudgetBelowKillThreshold(2048, 8192)).not.toThrow();
  });

  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (b) resolved T1 defaults satisfy budget < kill (SSOT constants are correctly ordered)", () => {
    // The resolved post-validation T1 constants (the production defaults) MUST
    // already satisfy the invariant, so a no-arg boot call never trips.
    expect(PER_CHUNK_RSS_BUDGET_MB).toBeLessThan(CHILD_RSS_KILL_DELTA_MB);
    // Default values pinned to the documented SSOT (1536 / 4096); a change here is
    // a deliberate contract change that MUST be reviewed.
    expect(PER_CHUNK_RSS_BUDGET_MB).toBe(1536);
    expect(CHILD_RSS_KILL_DELTA_MB).toBe(4096);
  });

  it("INV-BACKFILL-BUDGET-KILL-ORDER-012: (b) no-arg boot call (production wiring, resolved T1 defaults) → guard PASSES", () => {
    // Production boot calls the guard with no arguments (it reads the resolved
    // PER_CHUNK_RSS_BUDGET_MB / CHILD_RSS_KILL_DELTA_MB defaults). The normal
    // configuration must not block startup out of the box.
    expect(() => assertBudgetBelowKillThreshold()).not.toThrow();
  });
});
