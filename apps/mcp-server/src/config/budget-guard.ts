// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 budget < kill-threshold boot-time guard / Phase 5 予算 < kill 閾値 起動時ガード
 *
 * PR-C4 §3 G (SEC-PLAN-04 / NEW-SEC-C-L-01) を実装する。INV-BACKFILL-BUDGET-KILL-ORDER-012。
 *
 * Implements PR-C4 §3 G (SEC-PLAN-04 / NEW-SEC-C-L-01). INV-BACKFILL-BUDGET-KILL-ORDER-012.
 *
 * ## 目的 / Purpose
 *
 * Phase 5 の per-chunk RSS 予算 `PER_CHUNK_RSS_BUDGET_MB` (default 1536) は、
 * fork-child の RSS delta kill 閾値 `PHASE5_CHILD_RSS_KILL_DELTA_MB` (default 4096)
 * より**厳密に小さく**なければならない。逆転すると per-chunk budget が
 * fork-kill より**後に**発火するため、OOM 防御の primary gate が意味を喪失する
 * (CWE-770 Allocation of Resources Without Limits 隣接)。
 *
 * env range validation (`safeParseInt` min/max) は各値の値域を保証するが、
 * **2 値の相対関係**は未保証。例えば `PER_CHUNK_RSS_BUDGET_MB=5000` は値域
 * (256-8192) 内で valid だが、kill 閾値 4096 を上回り逆転する。本 guard が
 * その silent misconfiguration を起動時に fail-closed で遮断する。
 *
 * The Phase 5 per-chunk RSS budget `PER_CHUNK_RSS_BUDGET_MB` (default 1536) MUST
 * be **strictly less** than the fork-child RSS delta kill threshold
 * `PHASE5_CHILD_RSS_KILL_DELTA_MB` (default 4096). If inverted, the per-chunk
 * budget would fire **after** the fork-kill, so the primary OOM-defense gate
 * loses meaning (CWE-770 adjacent). The env range validation guarantees each
 * value's range but NOT the relative ordering; this guard closes that gap at
 * boot, fail-closed.
 *
 * ## 設計 / Design
 *
 * - `PER_CHUNK_RSS_BUDGET_MB >= CHILD_RSS_KILL_DELTA_MB` → 起動時 throw (起動拒否)
 * - `assertNoTestOnlyEnvLeak()` (`config/test-env-guard.ts`) と同型の fail-closed
 *   boot-time guard。
 * - 正常 env (default 1536 < 4096) は throw せず通過する (G guard 誤発火防止、
 *   SEC CONDITIONAL U2 / INV-012 の正常 env pass assert 対象)。
 * - `CHILD_RSS_KILL_DELTA_MB` は `phase-5-child-ipc.ts` で `validateRssDeltaThresholds`
 *   を経た **post-validation** の T1 値を参照する (raw env を再 parse しない)。
 *
 * - On `PER_CHUNK_RSS_BUDGET_MB >= CHILD_RSS_KILL_DELTA_MB` → throw at boot.
 * - Same fail-closed boot-time pattern as `assertNoTestOnlyEnvLeak()`.
 * - The normal env (default 1536 < 4096) passes without throw (avoids G-guard
 *   misfire; INV-012 asserts both the inverted-throw and the normal-pass).
 * - Reads the post-validation T1 value `CHILD_RSS_KILL_DELTA_MB` from
 *   `phase-5-child-ipc.ts` (does NOT re-parse the raw env var).
 *
 * @module config/budget-guard
 * @see  §3 G
 * @see ADR-0018-Amendment-PR-C4-section-visual-pii-excluded-DRAFT.md
 */

import { PER_CHUNK_RSS_BUDGET_MB } from "../workers/phases/types";
import { CHILD_RSS_KILL_DELTA_MB } from "../workers/phases/phase-5-child-ipc";

/**
 * `PER_CHUNK_RSS_BUDGET_MB < CHILD_RSS_KILL_DELTA_MB` の相対順序を起動時に検証する。
 * 逆転 (budget >= kill) の場合は throw して起動を拒否する (fail-closed)。
 *
 * Verifies the relative ordering `PER_CHUNK_RSS_BUDGET_MB <
 * CHILD_RSS_KILL_DELTA_MB` at boot. Throws to refuse startup on inversion
 * (budget >= kill), fail-closed.
 *
 * @param budgetMb per-chunk RSS budget (MB). Defaults to the resolved
 *   `PER_CHUNK_RSS_BUDGET_MB` (injectable for INV-012 fault injection).
 * @param killDeltaMb fork-child RSS delta kill threshold (MB). Defaults to the
 *   resolved `CHILD_RSS_KILL_DELTA_MB` (injectable for INV-012 fault injection).
 * @throws Error when `budgetMb >= killDeltaMb` (inverted / equal misconfiguration).
 */
export function assertBudgetBelowKillThreshold(
  budgetMb: number = PER_CHUNK_RSS_BUDGET_MB,
  killDeltaMb: number = CHILD_RSS_KILL_DELTA_MB
): void {
  if (budgetMb >= killDeltaMb) {
    throw new Error(
      `[budget-guard] PER_CHUNK_RSS_BUDGET_MB (${budgetMb}MB) must be strictly less than ` +
        `PHASE5_CHILD_RSS_KILL_DELTA_MB (${killDeltaMb}MB). With the current configuration the ` +
        `per-chunk RSS budget would fire after the fork-kill backstop, defeating the primary ` +
        `OOM-defense gate (CWE-770 adjacent). Lower PER_CHUNK_RSS_BUDGET_MB or raise ` +
        `PHASE5_CHILD_RSS_KILL_DELTA_MB. This is enforced per PR-C4 §3 G ` +
        `(INV-BACKFILL-BUDGET-KILL-ORDER-012) to prevent silent OOM degradation.`
    );
  }
}
