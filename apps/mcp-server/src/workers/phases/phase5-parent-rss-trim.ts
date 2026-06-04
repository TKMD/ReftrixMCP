// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 parent-RSS trim + ceiling fallback (PR-C3 / 系統B).
 *
 * CPU "true 10/10" integration plan V1.1 §3.3 / ADR-0008 Amendment 1.
 *
 * Root cause (系統B): on heavy CPU sites (e.g. linear.app) the parent process
 * RSS exceeds `PHASE5_PARENT_RSS_MAX_MB` (default 8192, T1 SSOT
 * `apps/mcp-server/src/config/phase5-config.ts:83`) **before** the Phase 5 fork,
 * so Phase 5 is skipped entirely (`aps=pending / ptext=0`). The RSS comes from
 * glibc malloc arena residue retained in the long-lived parent process (Phase
 * 0-4 Playwright + Ollama Vision); `MALLOC_ARENA_MAX=2` caps new arenas but does
 * not force-return existing ones, and `--max-old-space-size` only bounds the V8
 * heap, not native/arena RSS.
 *
 * PR-C3 fix (B3 + bounded B1, plan §3.3):
 *  1. **trim + re-measure**: immediately BEFORE the parent-RSS ceiling check, run
 *     `global.gc()` (via `tryGarbageCollect`, requires `--expose-gc`) and
 *     re-measure RSS so the ceiling decision uses the post-GC value (arena/heap
 *     returned by GC is reclaimed before the gate).
 *  2. **graceful degradation on no-op (SEC L-SEC-3 / FIND-IO-V0-L-05)**: when
 *     `global.gc` is unavailable (`--expose-gc` absent) the trim is a no-op; this
 *     MUST be surfaced via `logger.warn` in ALL environments (no `isDevelopment()`
 *     guard — catch-path silent absorption is forbidden) so the missing flag is
 *     observable, and the flow falls through to the ceiling fallback (NOT skip).
 *  3. **deterministic ceiling fallback (FIND-IO-V0-H-02)**: when the post-trim RSS
 *     STILL exceeds the ceiling, do NOT skip Phase 5 — proceed with the fork
 *     anyway (the ADR-0013 ceiling is treated as a soft envelope; the per-chunk
 *     RSS budget + the fork-kill 4096 backstop remain the hard OOM defences). This
 *     is a confirmed fallback, not an Open Question.
 *
 * The decision logic here is a PURE function (GC + RSS-measure injected) so the
 * leaf stays CC ≤ 10 and is machine-enforced via the eslint `complexity` override
 * (`packages/config/eslint/index.js`), keeping the large
 * `page-analyze-worker.ts` (base `complexity: "off"`) out of scope per the
 * canonical leaf-extraction pattern (plan §3.4 / TDA-RE-M-01).
 *
 * @see  §3.3 / §4.3
 * @see  Amendment 1
 * @see apps/mcp-server/src/config/phase5-config.ts (DEFAULT_PARENT_RSS_MAX_MB = 8192)
 * @module workers/phases/phase5-parent-rss-trim
 */

/**
 * Outcome of the trim-and-recompute decision.
 *
 * - `proceed: true` always means "continue into the Phase 5 fork".
 *   - `ceilingFallback: false` — post-trim RSS is within the ceiling (normal proceed).
 *   - `ceilingFallback: true` — post-trim RSS still exceeds the ceiling, but we
 *     deterministically proceed anyway (ADR-0013 soft envelope, H-02 fallback).
 */
export interface ParentRssTrimDecision {
  /** Always true for this helper — PR-C3 never skips on the parent-RSS gate. */
  proceed: true;
  /** RSS (MB) measured BEFORE the trim. */
  preTrimRssMb: number;
  /** RSS (MB) re-measured AFTER the trim. */
  postTrimRssMb: number;
  /** The active parent-RSS ceiling (MB). */
  ceilingMb: number;
  /** Whether `global.gc()` actually ran (false = `--expose-gc` absent → no-op). */
  gcTriggered: boolean;
  /** True when post-trim RSS still exceeds the ceiling (deterministic fallback). */
  ceilingFallback: boolean;
}

/**
 * Logger surface (subset of the project logger) used for graceful-degradation
 * warnings. Kept minimal so the helper has no hard dependency on the concrete
 * logger and is trivially testable.
 */
export interface TrimLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Trim parent RSS (GC + re-measure) then decide whether to proceed past the
 * Phase 5 parent-RSS ceiling. ALWAYS proceeds (never skips) — see module doc:
 * within-ceiling → normal proceed; over-ceiling → deterministic ceiling fallback.
 *
 * @param ceilingMb     Active parent-RSS ceiling (MB).
 * @param tryGc         GC trigger (returns true if `global.gc()` ran). Injected
 *                      for testability; production passes `tryGarbageCollect`.
 * @param measureRssMb  Current parent RSS in MB. Injected for testability.
 * @param logger        Logger for graceful-degradation warnings.
 */
export function trimParentRssAndDecide(
  ceilingMb: number,
  tryGc: () => boolean,
  measureRssMb: () => number,
  logger: TrimLogger
): ParentRssTrimDecision {
  const preTrimRssMb = measureRssMb();

  // (1) trim — run GC if `--expose-gc` is available.
  const gcTriggered = tryGc();
  if (!gcTriggered) {
    // (2) graceful degradation (SEC L-SEC-3): surface the no-op in ALL
    // environments so a missing `--expose-gc` flag is observable. No
    // `isDevelopment()` guard — silent absorption is forbidden.
    logger.warn(
      "[PageAnalyzeWorker] [PR-C3] global.gc() unavailable (--expose-gc absent) — parent RSS trim is a no-op; relying on ceiling fallback",
      { ceilingMb }
    );
  }

  // (3) re-measure AFTER the trim so the ceiling decision uses the post-GC value.
  const postTrimRssMb = measureRssMb();
  const ceilingFallback = postTrimRssMb > ceilingMb;

  if (ceilingFallback) {
    // Deterministic fallback (FIND-IO-V0-H-02): post-trim RSS still over the
    // ceiling → proceed anyway (do NOT skip Phase 5). The per-chunk RSS budget
    // and the fork-kill 4096 backstop remain the hard OOM defences.
    logger.warn(
      "[PageAnalyzeWorker] [PR-C3] parent RSS still exceeds ceiling after trim — proceeding via deterministic ceiling fallback (Phase 5 fork NOT skipped)",
      { preTrimRssMb, postTrimRssMb, ceilingMb, gcTriggered }
    );
  }

  return {
    proceed: true,
    preTrimRssMb,
    postTrimRssMb,
    ceilingMb,
    gcTriggered,
    ceilingFallback,
  };
}
