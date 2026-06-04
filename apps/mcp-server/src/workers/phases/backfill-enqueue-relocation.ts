// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PR-C2 (Layer 2) — Backfill enqueue ↔ markComplete ordering relocation leaf.
 *
 * CPU "true 10/10" integration plan V1.1 §3.2 / §4.2, ADR-0007 Amendment 3 (V1).
 *
 * ## Root cause (Layer 2)
 *
 * The Phase 5 backfill enqueue calls (`dispatchBackfillJobsForPage` for the
 * sync_overflow path and `dispatchSkipRecoveryBackfill` for the skip_recovery
 * path) used to run BEFORE `markAnalysisCompleted`. Because the backfill worker
 * could pick a job up while `analysis_status='processing'`, the analysis guard
 * returned `re_enqueue` (a 30s delayed job). The planned-restart `once('completed')`
 * listener (`EMBEDDING_BACKFILL_MAX_JOBS_BEFORE_RESTART=3`) then exited the worker
 * unconditionally, so the delayed retry job's `delayed → waiting` promotion was
 * deferred across the respawn window — `retry_count` churn accumulated and the
 * page froze at `in_progress` / `re_enqueue` churn (never reaching `completed`).
 *
 * ## Fix (B — root cure)
 *
 * Relocate BOTH enqueue paths to AFTER `markAnalysisCompleted` (and before the
 * Phase 7.5 Post-Analysis Gate). By the time the backfill worker picks the job
 * up, `analysis_status` is already terminal (`completed` / `failed`), so the
 * guard returns `proceed` on the happy path — `re_enqueue` is removed from the
 * happy path entirely (the deadlock / re_enqueue guard remains only as a safety
 * net). The exit(0) lifecycle (memory-gate + planned-restart listener) is left
 * untouched (worker-lifecycle standing impact minimized).
 *
 * ## Why a dedicated leaf (TDA-RE-M-01 / plan §3.4)
 *
 * The relocation orchestration is extracted into this leaf so it can be added to
 * the scope-limited eslint `complexity: ["error", 10]` override
 * (`packages/config/eslint/index.js`) WITHOUT adding the 3470-LoC
 * `page-analyze-worker.ts` (which carries ~563 pre-existing CC>10 functions under
 * the base `complexity: "off"`, Q3-2026 successor issue). This makes `pnpm lint`
 * exit 0 a REAL complexity guarantee for the new ordering code path (closes the
 * misleading-exit-0 gap per FIND-IO-V0-M-06). Follows the canonical scope-limited
 * pattern (PR-D-6 / PR-D-8 / Plan v4.5 PR3 / GPU-COORD / PR-BT-4 / PR-BT-5 /
 * phase-5-chunked-text-loop.ts).
 *
 * The actual DB I/O and queue access live in the injected `dispatch*` callbacks
 * (which close over `prisma` / `getBackfillQueue` in `page-analyze-worker.ts`);
 * this leaf is a pure ordering orchestrator over those callbacks, so each
 * function here stays CC ≤ 10.
 *
 * @see  §3.2 / §4.2
 * @see  Amendment 3
 * @see  Amendment 1 (skip_recovery guard semantics)
 * @module workers/phases/backfill-enqueue-relocation
 */

import type { EmbeddingBackfillCategory } from "../../queues/embedding-backfill-queue";
import type { EmbeddingSkipReason } from "./types";

/**
 * Result envelope for the sync_overflow enqueue path. `enqueuedCategories` is
 * empty when nothing was enqueued; `backfillPending` is the MCP-response payload
 * (or `undefined` when no payload should be surfaced).
 */
export interface SyncOverflowEnqueueOutcome {
  enqueuedCategories: EmbeddingBackfillCategory[];
  backfillPending: unknown | undefined;
}

/**
 * Result envelope for the skip_recovery enqueue path. `skipRecoveryPending` is
 * the MCP-response payload (or `undefined` when 0 categories were enqueued / the
 * skip reason is not recovery-eligible).
 */
export interface SkipRecoveryEnqueueOutcome {
  enqueuedCategories: EmbeddingBackfillCategory[];
  skipRecoveryPending: unknown | undefined;
}

/**
 * Injected dependencies for {@link enqueueBackfillAfterMarkComplete}. Each
 * callback closes over the worker-module state (`prisma`, queue, builders,
 * logger) in `page-analyze-worker.ts`, keeping this leaf a pure orchestrator.
 */
export interface BackfillEnqueueRelocationDeps {
  /**
   * True when the page has a valid persisted web_page id (i.e. analysis reached
   * a terminal state with a DB row). Both paths are gated on this.
   */
  hasWebPageId: boolean;
  /**
   * Runs the sync_overflow enqueue (`dispatchBackfillJobsForPage` + status→queued
   * + `buildBackfillPending`). Returns the enqueued categories and the optional
   * MCP-response payload. MUST be a no-op when nothing is enqueued.
   */
  runSyncOverflowEnqueue: () => Promise<SyncOverflowEnqueueOutcome>;
  /**
   * The recovery-eligible skip reason captured before markComplete, or
   * `undefined` when the skip reason is not recovery-eligible
   * (only `skipped_fork_error` / `skipped_memory_pressure` are eligible —
   * plan §3.2 / ADR-0008 Amendment 1). When `undefined`, skip_recovery is not run.
   */
  recoverySkipReason: EmbeddingSkipReason | undefined;
  /**
   * Runs the skip_recovery enqueue (`dispatchSkipRecoveryBackfill` +
   * `buildSkipRecoveryBackfillPending`). Only invoked when
   * `recoverySkipReason !== undefined`.
   */
  runSkipRecoveryEnqueue: () => Promise<SkipRecoveryEnqueueOutcome>;
}

/**
 * Aggregated outcome of running BOTH relocated enqueue paths after markComplete.
 * `*Pending` payloads are surfaced on the MCP response by the caller in
 * `page-analyze-worker.ts` (where `state.results` is mutated).
 */
export interface BackfillEnqueueRelocationResult {
  syncOverflow: SyncOverflowEnqueueOutcome;
  skipRecovery: SkipRecoveryEnqueueOutcome | undefined;
}

const EMPTY_SYNC_OVERFLOW: SyncOverflowEnqueueOutcome = {
  enqueuedCategories: [],
  backfillPending: undefined,
};

/**
 * Orchestrates the two relocated backfill enqueue paths in order:
 * (1) sync_overflow, then (2) skip_recovery (mutually exclusive at runtime per
 * the ADR-0008 semantics table, but both are gated here so the ordering contract
 * holds for either).
 *
 * Both inner enqueues are delegated to injected callbacks; this function only
 * decides WHETHER each path runs (the ordering / gating decision), keeping its
 * cyclomatic complexity ≤ 10 (machine-enforced via the scope-limited eslint
 * override on this leaf).
 *
 * @param deps - injected enqueue callbacks + gating predicates.
 * @returns the aggregated outcome whose payloads the caller attaches to the MCP
 *   response. When `hasWebPageId` is false, both paths are skipped (empty result).
 */
export async function enqueueBackfillAfterMarkComplete(
  deps: BackfillEnqueueRelocationDeps
): Promise<BackfillEnqueueRelocationResult> {
  if (!deps.hasWebPageId) {
    return { syncOverflow: EMPTY_SYNC_OVERFLOW, skipRecovery: undefined };
  }

  // (1) sync_overflow path — parts>100 overflow + parts≤100 partial-completion
  //     residual + the gate-less categories. Runs unconditionally for a valid
  //     web_page id; the callback itself preserves the per-category gates.
  const syncOverflow = await deps.runSyncOverflowEnqueue();

  // (2) skip_recovery path — only when the captured skip reason is
  //     recovery-eligible (skipped_fork_error / skipped_memory_pressure).
  let skipRecovery: SkipRecoveryEnqueueOutcome | undefined;
  if (deps.recoverySkipReason !== undefined) {
    skipRecovery = await deps.runSkipRecoveryEnqueue();
  }

  return { syncOverflow, skipRecovery };
}
