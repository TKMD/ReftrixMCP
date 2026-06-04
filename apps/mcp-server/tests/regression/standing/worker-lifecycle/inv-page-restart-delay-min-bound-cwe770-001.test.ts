// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001
 *
 * **Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5 / SEC M-01**
 *
 * IO Plan Decision V1 anchor: `019e34c5-4480-76e5-8fcf-5e465a149fce`
 *
 * ## Contract / 不変条件
 *
 * **The `page` workerType restart cooldown lower bound MUST be 500ms (Plan
 * v4.1 CWE-770 41.67h/day DoS boundary preservation). Values below 500ms
 * MUST be rejected and fall back to the canonical default
 * (`DEFAULT_PAGE_RESTART_DELAY_MS = 3000`). The boundary value 500ms MUST
 * be accepted.**
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * Plan v4.4 PR-N-A raised `PAGE_RESTART_DELAY_MS_MIN` from `1` → `500` per
 * SEC M-01 CWE-770 boundary preservation. Without an enforcement test, a
 * future regression could silently re-lower the boundary (e.g. by
 * reverting to `PAGE_RESTART_DELAY_MS_MIN = 1` or by removing the `min`
 * argument from the `safeParseInt(...)` call inside
 * `getRestartDelayMsForType("page")`), reopening the CWE-770 41.67h/day
 * DoS upper-bound regression that Plan v4.1 closed.
 *
 * ## Why under worker-lifecycle domain / なぜ worker-lifecycle ドメインか
 *
 * The page workerType restart cooldown lower bound is a worker-lifecycle
 * integrity contract paired with INV-WORKER-RESTART-DELAY-SSOT-001 (which
 * guards the SSOT migration AST gate). Both INVs are part of the
 * worker-lifecycle standing regression set per Plan v4.4 PR-N-A.
 *
 * ## Scope (3 boundary-value test cases) / スコープ (3 boundary value ケース)
 *
 * | # | env value | Expected behaviour                                                              |
 * | - | --------- | ------------------------------------------------------------------------------- |
 * | 1 | `100`     | REJECT → fallback to `DEFAULT_PAGE_RESTART_DELAY_MS = 3000` (below boundary)    |
 * | 2 | `499`     | REJECT → fallback to `DEFAULT_PAGE_RESTART_DELAY_MS = 3000` (1ms below boundary)|
 * | 3 | `500`     | ACCEPT → returns `500` (boundary value)                                         |
 *
 * ## CWE-770 boundary preservation rationale
 *
 * Plan v4.1 closed the original CWE-770 41.67h/day DoS regression by
 * establishing 500ms as the lower bound of `WORKER_RESTART_DELAY_MS`. A
 * malicious operator setting the env var to (say) `1ms` could otherwise
 * cause the supervisor to respawn workers ~3,600,000 times per hour
 * (1ms × 3,600,000 = 3,600s = 1h), exceeding any reasonable rate cap and
 * effectively reproducing the original DoS vector. The 500ms boundary
 * caps respawn at ~7,200 per hour (≤ 41.67h/day worst-case if every cycle
 * crashes immediately). This INV pins the boundary value at the
 * structural level so the test catches any silent regression.
 *
 * @see internal anchor `019e34c5-4480-76e5` (IO Plan Decision V1)
 * @see Plan v4.1 CWE-770 41.67h/day DoS upper-bound closure
 * @see ADR-0035 Amendment 1 §Decision 5 / SEC M-01
 * @see `apps/mcp-server/src/services/worker-supervisor.service.ts` (PAGE_RESTART_DELAY_MS_MIN = 500)
 * @module tests/regression/standing/worker-lifecycle/inv-page-restart-delay-min-bound-cwe770-001
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

describe("INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001: page workerType restart cooldown 500ms lower bound — Plan v4.1 CWE-770 41.67h/day DoS boundary preservation (Plan v4.4 PR-N-A / SEC M-01)", () => {
  const ORIGINAL_WORKER_RESTART_DELAY_MS = process.env.WORKER_RESTART_DELAY_MS;
  const ORIGINAL_EMBEDDING_BACKFILL_RESTART_DELAY_MS =
    process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;

  beforeEach(() => {
    // INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001"
    );
    delete process.env.WORKER_RESTART_DELAY_MS;
    delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
  });

  afterEach(() => {
    if (ORIGINAL_WORKER_RESTART_DELAY_MS !== undefined) {
      process.env.WORKER_RESTART_DELAY_MS = ORIGINAL_WORKER_RESTART_DELAY_MS;
    } else {
      delete process.env.WORKER_RESTART_DELAY_MS;
    }
    if (ORIGINAL_EMBEDDING_BACKFILL_RESTART_DELAY_MS !== undefined) {
      process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS =
        ORIGINAL_EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    } else {
      delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    }
  });

  // ==========================================================================
  // Test 1 — Below-boundary REJECT: WORKER_RESTART_DELAY_MS=100 → fallback
  // ==========================================================================

  it("INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001: WORKER_RESTART_DELAY_MS=100 (below 500ms boundary) is REJECTED → fallback to DEFAULT_PAGE_RESTART_DELAY_MS=3000 (CWE-770 41.67h/day DoS boundary preservation)", async () => {
    // INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001
    process.env.WORKER_RESTART_DELAY_MS = "100";

    // Dynamic import so the helper picks up the test env value.
    const supervisorModule = await import("../../../../src/services/worker-supervisor.service");
    const getRestartDelayMsForType = (
      supervisorModule as unknown as Record<string, ((workerType: string) => number) | undefined>
    ).getRestartDelayMsForType;

    if (typeof getRestartDelayMsForType !== "function") {
      expect.fail(
        "ADR-0035 §Decision 3 contract violation: " +
          "`getRestartDelayMsForType` is not exported from worker-supervisor.service.ts."
      );
    }

    // 100 < 500 (PAGE_RESTART_DELAY_MS_MIN) → safeParseInt rejects → fallback 3000.
    expect(
      getRestartDelayMsForType("page"),
      "WORKER_RESTART_DELAY_MS=100 is below the 500ms CWE-770 boundary; must be rejected and fall back to DEFAULT_PAGE_RESTART_DELAY_MS=3000"
    ).toBe(3000);
  });

  // ==========================================================================
  // Test 2 — Just-below-boundary REJECT: WORKER_RESTART_DELAY_MS=499 → fallback
  // ==========================================================================

  it("INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001: WORKER_RESTART_DELAY_MS=499 (1ms below 500ms boundary) is REJECTED → fallback to DEFAULT_PAGE_RESTART_DELAY_MS=3000 (boundary off-by-one regression guard)", async () => {
    // INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001
    process.env.WORKER_RESTART_DELAY_MS = "499";

    const supervisorModule = await import("../../../../src/services/worker-supervisor.service");
    const getRestartDelayMsForType = (
      supervisorModule as unknown as Record<string, ((workerType: string) => number) | undefined>
    ).getRestartDelayMsForType;

    if (typeof getRestartDelayMsForType !== "function") {
      expect.fail(
        "ADR-0035 §Decision 3 contract violation: " +
          "`getRestartDelayMsForType` is not exported from worker-supervisor.service.ts."
      );
    }

    // 499 < 500 (strict `parsed < min` check in safeParseInt) → fallback 3000.
    expect(
      getRestartDelayMsForType("page"),
      "WORKER_RESTART_DELAY_MS=499 is 1ms below the 500ms CWE-770 boundary; must be rejected (off-by-one guard)"
    ).toBe(3000);
  });

  // ==========================================================================
  // Test 3 — Boundary-value ACCEPT: WORKER_RESTART_DELAY_MS=500 → accept
  // ==========================================================================

  it("INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001: WORKER_RESTART_DELAY_MS=500 (boundary value, inclusive lower bound) is ACCEPTED → returns 500 (CWE-770 boundary value preservation)", async () => {
    // INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001
    process.env.WORKER_RESTART_DELAY_MS = "500";

    const supervisorModule = await import("../../../../src/services/worker-supervisor.service");
    const getRestartDelayMsForType = (
      supervisorModule as unknown as Record<string, ((workerType: string) => number) | undefined>
    ).getRestartDelayMsForType;

    if (typeof getRestartDelayMsForType !== "function") {
      expect.fail(
        "ADR-0035 §Decision 3 contract violation: " +
          "`getRestartDelayMsForType` is not exported from worker-supervisor.service.ts."
      );
    }

    // 500 >= 500 (inclusive lower bound) → accepted → returns 500.
    expect(
      getRestartDelayMsForType("page"),
      "WORKER_RESTART_DELAY_MS=500 is the inclusive boundary value; must be accepted and returned as-is"
    ).toBe(500);
  });
});
