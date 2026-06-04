// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Analysis-Status Guard — pure decision leaf helper (H-1).
 *
 * PR-BT-4 / ADR-0018 Amendment 10 Decision 10.1 (analysis-status guard) +
 * Decision 10.4 (deadlock guard).
 *
 * ## Why this is a dedicated leaf helper (U3 / FIND-PLAN-H-03 precedent)
 *
 * `embedding-backfill-worker.ts` carries pre-existing CC>10 functions under the
 * base ESLint `complexity: "off"`, so adding the guard branches there would not
 * be complexity-gated and `pnpm lint` exit 0 would NOT guarantee the new code's
 * complexity. The guard *decision* logic is therefore extracted here — a pure
 * module with no DB / no Queue / no I/O — so `packages/config/eslint/index.js`
 * can `complexity: ["error", 10]`-gate it (same pattern as the GPU-COORD leaf
 * helper `phase-5-gpu-probe.ts`). Every exported function is CC ≤ 10.
 *
 * ## Mechanism (U1 winning contract — retryCount-reuse, NOT BullMQ retry)
 *
 * The backfill worker must NOT process part categories until the owning
 * `web_pages.analysisStatus` reaches a terminal state. While the page is still
 * analyzing the job is bounded-re-enqueued using the
 * `embeddingBackfillRetryCount` CAS-increment mechanism (mirroring the recovery
 * service), NOT BullMQ `attempts: ≥2` / `moveToDelayed` / job-throw
 * (`INV-RETRY-AMPLIFICATION-001` gates `attempts: 1`). The retryCount cap
 * (`BACKFILL_RECOVERY_MAX_AUTO_RETRIES`) provides the deadlock guard: even if
 * `analysisStatus` is permanently stuck (Decision 10.4), the re-enqueue loop
 * terminates at the cap with terminal `failed` (finite, never infinite).
 *
 * This module owns only the *decision*; the DB-mutating CAS transitions
 * (`transitionAnalysisGuardReEnqueue` / `transitionAnalysisGuardTerminalFailed`)
 * live in `embedding-backfill-worker.ts` (they need the worker's Prisma + Queue).
 *
 * @module workers/phases/backfill-analysis-guard
 */

/**
 * Re-enqueue delay for the analysis-status guard path (ms).
 *
 * U6/U9 winning contract: a hardcoded constant (no new env var — config-surface
 * minimisation) at 30s, matching the recovery service's re-enqueue cadence
 * (`VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS`). 30_000 ms is well above the
 * SEC M-01 CWE-770 floor (min 500ms) shared with `WORKER_RESTART_DELAY_MS`.
 * A coarse 30s poll is appropriate — the guard waits for page.analyze to finish
 * finalizing, which is a multi-second-to-minutes operation.
 */
export const BACKFILL_ANALYSIS_GUARD_DELAY_MS = 30_000;

/**
 * `web_pages.analysisStatus` terminal states. When the owning page reaches one
 * of these the backfill worker may proceed to process part categories.
 *
 * SSOT-aligned with `schema.prisma` `analysisStatus String` documented domain
 * (`'pending' | 'processing' | 'completed' | 'failed'`).
 */
const ANALYSIS_TERMINAL_STATES: readonly string[] = ["completed", "failed"];

/**
 * Discriminated outcome of the analysis-status guard decision.
 *
 * - `proceed`        — page analysis is terminal → process part categories.
 * - `re_enqueue`     — page still analyzing AND retryCount < cap → bounded
 *                      retryCount-CAS re-enqueue (NOT BullMQ retry).
 * - `terminal_failed`— page still analyzing AND retryCount >= cap → deadlock
 *                      guard fires; transition to terminal `failed`
 *                      (Decision 10.4).
 */
export type AnalysisGuardOutcome =
  | { kind: "proceed" }
  | { kind: "re_enqueue" }
  | { kind: "terminal_failed" };

/**
 * Whether the owning page's analysis has reached a terminal state.
 *
 * @param analysisStatus - `web_pages.analysisStatus` raw string.
 * @returns true for `completed` / `failed`; false for `pending` / `processing`
 *          (and any unknown value — fail-safe to "not complete" so the guard
 *          waits rather than proceeding on an unrecognised status).
 */
export function isAnalysisComplete(analysisStatus: string): boolean {
  return ANALYSIS_TERMINAL_STATES.includes(analysisStatus);
}

/**
 * Decide the guard outcome for a backfill job receipt (pure; CC ≤ 10).
 *
 * @param analysisStatus - owning `web_pages.analysisStatus` raw string.
 * @param retryCount      - current `embeddingBackfillRetryCount` (CAS counter).
 * @param maxRetries      - cap (`BACKFILL_RECOVERY_MAX_AUTO_RETRIES`). NaN /
 *                          non-positive caps are clamped to 1 so the guard can
 *                          never produce an unbounded re-enqueue.
 * @returns `proceed` | `re_enqueue` | `terminal_failed`.
 */
export function decideAnalysisGuard(
  analysisStatus: string,
  retryCount: number,
  maxRetries: number
): AnalysisGuardOutcome {
  // Page analysis terminal → process normally (current behaviour).
  if (isAnalysisComplete(analysisStatus)) {
    return { kind: "proceed" };
  }

  // Page still analyzing. Bounded re-enqueue UNLESS retryCount cap reached.
  // Defensive clamp: a non-finite / non-positive cap collapses to 1 so the
  // deadlock guard always fires within a finite number of iterations.
  const safeCap = Number.isFinite(maxRetries) && maxRetries >= 1 ? Math.floor(maxRetries) : 1;
  const safeRetry = Number.isFinite(retryCount) && retryCount > 0 ? Math.floor(retryCount) : 0;

  if (safeRetry >= safeCap) {
    // Deadlock guard (Decision 10.4): cap reached → terminal failed.
    return { kind: "terminal_failed" };
  }
  return { kind: "re_enqueue" };
}
