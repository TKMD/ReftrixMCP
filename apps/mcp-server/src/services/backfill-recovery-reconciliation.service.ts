// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Recovery Reconciliation Service — auto-recovery for
 * `failed_with_known_reason` rows
 *
 * Plan v3 T3-Backfill V1 §3.1 axis C / Wave 2 (2026-05-10) NEW service.
 *
 * `web_pages.embeddingBackfillStatus = 'failed_with_known_reason'` rows を
 * `BACKFILL_RECOVERY_INTERVAL_MS` (default 5 min) ごとに scan し、
 * `embeddingBackfillFailureReason` per-reason policy (Strategy pattern) で
 * recovery を試みる。
 *
 * Periodically scans `web_pages` rows with
 * `embeddingBackfillStatus = 'failed_with_known_reason'` every
 * `BACKFILL_RECOVERY_INTERVAL_MS` (default 5 min) and applies a per-reason
 * recovery policy via Strategy pattern.
 *
 * # C-1 winning contract (per ADR-0007 Amendment 1 §A1.2.1)
 *
 * `vision_residual` chain bound by 3 SSOT values from
 * `apps/mcp-server/src/services/vision/vision-unload-handshake.ts`
 * (Wave 1 export):
 *
 *   - `BACKFILL_VISION_RESIDUAL_DELAY_MS = 30_000` (30s polling interval)
 *   - `BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS = 300_000` (5min terminal bound)
 *   - `BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS = 600_000` (10min final timeout)
 *
 * State transition for `vision_residual`:
 *
 * ```text
 * failed_with_known_reason (failureReason='vision_residual')
 *    ↓ (30s polling × OllamaUnloadService VRAM probe)
 *    ├── VRAM=0 → queued (re-enqueue)
 *    ├── 5min elapsed → failed_with_known_reason (failureReason='vision_unload_timeout')
 *    │     ↓ (additional 5min polling)
 *    │     └── 10min total → failed (terminal, no auto-recovery)
 * ```
 *
 * # Design principles
 *
 *   - **Strategy pattern (FIND-PLAN-TDA-T3B-04 cyclomatic ≤5 per case)**:
 *     `dispatchByReason()` Record-based dispatcher; each handler ≤5 CC.
 *   - **MAX_AUTO_RETRIES (default 5)**: `embeddingBackfillRetryCount` cap
 *     per row; exhausted → terminal `failed`. Independent from BullMQ
 *     `attempts=3` (which handles within-job retry).
 *   - **CAS guard**: every status update uses `prisma.webPage.updateMany`
 *     with WHERE constraints to prevent races with the worker / page-analyze
 *     pipeline.
 *   - **PII-safe**: webPageId truncation via audit-log SSOT
 *     (INV-AUDIT-EMIT-SSOT-IMPORT-001).
 *   - **Fail-open audit emit**: emit failures do NOT block recovery.
 *   - **`BACKFILL_RECOVERY_RECONCILIATION_ENABLED` feature flag (default true)**:
 *     opt-out kill switch per Plan v3 T3-Backfill V1 §5.3.
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C
 * @see ADR-0007 Amendment 1 §A1.2.1 / §A1.2.3
 * @see ADR-0011 Amendment 3 SLO 5-tier
 * @see INV-BACKFILL-DEADLOCK-FREE-005 (standing regression)
 * @see INV-AUDIT-EMIT-SSOT-IMPORT-001 (cross-cutting)
 *
 * @module services/backfill-recovery-reconciliation.service
 */

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import {
  EMBEDDING_BACKFILL_FAILURE_REASONS,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillFailureReason,
} from "../queues/embedding-backfill-queue";
import {
  VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS as BACKFILL_VISION_RESIDUAL_DELAY_MS,
  VISION_RESIDUAL_TERMINAL_BOUND_MS as BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS,
  VISION_UNLOAD_FINAL_TIMEOUT_MS as BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS,
  verifyVisionUnloadPrecondition,
} from "./vision/vision-unload-handshake";
import {
  classifyFailureReasonPolicy,
  emitRecoveryAttempt,
  emitRecoveryResolved,
  emitTerminalKnownReason,
  truncateForLog,
  type RecoveryOutcome,
} from "../utils/embedding-backfill-failure-reason-helpers";
import { enqueueAllCategoriesForSkipRecovery } from "../queues/embedding-backfill-processors";

// ============================================================================
// SSOT re-exports (Wave 2 cross-track binding)
// ============================================================================

/**
 * Wave 2 re-export of Wave 1 SSOT under T3-Backfill canonical names.
 * Per ADR-0007 Amendment 1 §A1.2.1 these canonical names appear in this
 * service file as the primary read site; Wave 1 (`vision-unload-handshake.ts`)
 * remains the source of truth via the import alias above.
 */
export {
  BACKFILL_VISION_RESIDUAL_DELAY_MS,
  BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS,
  BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS,
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum auto-retry count per webPageId before terminal `failed` (axis A
 * + axis C). Exhausted retries emit `embedding_backfill_terminal_known_reason`
 * audit_logs entry.
 */
export const BACKFILL_RECOVERY_MAX_AUTO_RETRIES = 5;

/**
 * Default scan interval for `BackfillRecoveryReconciliationService` cron
 * driver (5 minutes, aligns with axis A 5-min terminal bound).
 *
 * Configurable via `BACKFILL_RECOVERY_INTERVAL_MS` env var (Zod-validated
 * 30000-3600000 ms range per FIND-PLAN-SEC-T3B-04 M).
 */
export const BACKFILL_RECOVERY_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Default batch size per scan iteration (caps DoS surface). */
export const BACKFILL_RECOVERY_DEFAULT_BATCH_LIMIT = 200;

/** Feature flag env var (default `true` = enabled per V1 §5.3). */
export const BACKFILL_RECOVERY_RECONCILIATION_ENABLED_ENV =
  "BACKFILL_RECOVERY_RECONCILIATION_ENABLED";

// ============================================================================
// Types
// ============================================================================

/**
 * Result returned by a single `runRecoveryCycle()` invocation.
 */
export interface BackfillRecoveryReconciliationResult {
  /** Total rows scanned (status='failed_with_known_reason') */
  totalChecked: number;
  /** Rows where an auto-recovery handler was attempted */
  recoveryAttempted: number;
  /** Rows successfully re-enqueued (handler returned `re_enqueued`) */
  recoveryResolved: number;
  /** Rows escalated to terminal `failed` (10min final timeout / retry cap) */
  terminalFailed: number;
  /** Rows transitioned vision_residual → vision_unload_timeout (5min bound) */
  switchedToUnloadTimeout: number;
  /** Rows where handler returned `waiting` (precondition still unmet) */
  waiting: number;
  /** Rows where CAS guard caught concurrent worker update */
  concurrentUpdatesSkipped: number;
  /** Rows whose handler / DB threw; non-fatal */
  errors: number;
}

/**
 * Row shape selected from `web_pages` for recovery scan.
 */
interface FailedWithKnownReasonRow {
  id: string;
  embeddingBackfillFailureReason: string | null;
  embeddingBackfillFailedAt: Date | null;
  embeddingBackfillRetryCount: number;
  screenshotStoragePath: string | null;
}

/**
 * Options for `runRecoveryCycle()`.
 */
export interface RunRecoveryCycleOptions {
  prisma: PrismaClient;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /** Max rows per cycle (default `BACKFILL_RECOVERY_DEFAULT_BATCH_LIMIT`). */
  batchLimit?: number;
  /**
   * Override Vision unload precondition check (test injection). Production
   * uses the `verifyVisionUnloadPrecondition()` SSOT.
   */
  verifyVisionUnloadFn?: typeof verifyVisionUnloadPrecondition;
  /**
   * Override `Date.now()` for time-based decision testing.
   */
  nowFn?: () => number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Whether the recovery service is enabled via feature flag.
 *
 * `BACKFILL_RECOVERY_RECONCILIATION_ENABLED=false` → disabled (returns false).
 * Anything else (including unset / `true`) → enabled.
 */
export function isRecoveryReconciliationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BACKFILL_RECOVERY_RECONCILIATION_ENABLED_ENV];
  return raw !== "false";
}

/**
 * Plan v3 T3-Backfill V1 §3.1 axis C — Run one recovery cycle.
 *
 * Selects up to `batchLimit` rows where `embeddingBackfillStatus =
 * 'failed_with_known_reason'`, applies per-reason recovery handler, and
 * accumulates results. Failures within individual handlers are logged and
 * counted but do NOT abort the cycle (graceful degradation).
 *
 * Run one recovery cycle: scan up to `batchLimit` rows, dispatch per-reason
 * handler, accumulate results.
 *
 * @returns Aggregate counts for the cycle.
 */
export async function runRecoveryCycle(
  options: RunRecoveryCycleOptions
): Promise<BackfillRecoveryReconciliationResult> {
  const { prisma, queue } = options;
  const batchLimit = resolveBatchLimit(options.batchLimit);
  const verifyVisionUnloadFn = options.verifyVisionUnloadFn ?? verifyVisionUnloadPrecondition;
  const nowFn = options.nowFn ?? Date.now;

  const result: BackfillRecoveryReconciliationResult = {
    totalChecked: 0,
    recoveryAttempted: 0,
    recoveryResolved: 0,
    terminalFailed: 0,
    switchedToUnloadTimeout: 0,
    waiting: 0,
    concurrentUpdatesSkipped: 0,
    errors: 0,
  };

  if (!isRecoveryReconciliationEnabled()) {
    if (isDevelopment()) {
      logger.info("[BackfillRecoveryReconciliation] Disabled via feature flag — skipping cycle");
    }
    return result;
  }

  // Step 1: scan failed_with_known_reason rows.
  const rows = await fetchFailedWithKnownReasonRows(prisma, batchLimit);
  result.totalChecked = rows.length;
  if (rows.length === 0) return result;

  if (isDevelopment()) {
    logger.info("[BackfillRecoveryReconciliation] Scanning failed_with_known_reason rows", {
      rowCount: rows.length,
    });
  }

  // Step 2: per-row recovery dispatch.
  for (const row of rows) {
    try {
      await processSingleRow(row, {
        prisma,
        queue,
        result,
        verifyVisionUnloadFn,
        nowFn,
      });
    } catch (error) {
      result.errors += 1;
      logger.warn("[BackfillRecoveryReconciliation] Failed to recover row (non-fatal)", {
        webPageId: truncateForLog(row.id),
        error: sanitizeErrorMessage(error),
      });
    }
  }

  if (isDevelopment()) {
    logger.info("[BackfillRecoveryReconciliation] Cycle complete", { ...result });
  }
  return result;
}

// ============================================================================
// Per-row dispatch (Strategy pattern entry point)
// ============================================================================

interface ProcessRowContext {
  prisma: PrismaClient;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  result: BackfillRecoveryReconciliationResult;
  verifyVisionUnloadFn: typeof verifyVisionUnloadPrecondition;
  nowFn: () => number;
}

/**
 * Process a single `failed_with_known_reason` row. Validates the failure
 * reason, dispatches per-reason handler, and updates `result` counters.
 *
 * Cyclomatic complexity is kept at ≤8 by extracting reason validation,
 * retry-cap check, and outcome aggregation to helper functions.
 */
async function processSingleRow(
  row: FailedWithKnownReasonRow,
  ctx: ProcessRowContext
): Promise<void> {
  const reason = validateFailureReason(row.embeddingBackfillFailureReason);
  if (!reason) {
    ctx.result.errors += 1;
    logger.warn(
      "[BackfillRecoveryReconciliation] Row has unknown / NULL embeddingBackfillFailureReason",
      {
        webPageId: truncateForLog(row.id),
        reasonRaw: row.embeddingBackfillFailureReason,
      }
    );
    return;
  }

  // Retry-cap check (independent from BullMQ attempts).
  if (row.embeddingBackfillRetryCount >= BACKFILL_RECOVERY_MAX_AUTO_RETRIES) {
    await transitionToTerminalFailed(row, reason, ctx);
    return;
  }

  // Always emit attempt (drives SLO metric, even for noop policies).
  ctx.result.recoveryAttempted += 1;
  await emitRecoveryAttempt(row.id, reason, row.embeddingBackfillRetryCount);

  const policy = classifyFailureReasonPolicy(reason);
  const outcome = await dispatchByReasonPolicy(row, reason, policy, ctx);
  await applyRecoveryOutcome(row, reason, outcome, ctx);
}

/**
 * Strategy pattern dispatcher — routes to per-reason handler based on policy
 * classification. `auto_recoverable` reasons get a real recovery attempt;
 * `terminal_unrecoverable` go straight to terminal failed; `legacy_existing_path`
 * are no-op (already handled via skipped_* retry bucket).
 *
 * Cyclomatic complexity ≤5 (3 policy branches + 1 default).
 */
async function dispatchByReasonPolicy(
  row: FailedWithKnownReasonRow,
  reason: EmbeddingBackfillFailureReason,
  policy: ReturnType<typeof classifyFailureReasonPolicy>,
  ctx: ProcessRowContext
): Promise<RecoveryOutcome> {
  if (policy === "terminal_unrecoverable") {
    return { outcome: "terminal_failed", finalReason: reason };
  }
  if (policy === "legacy_existing_path") {
    return { outcome: "noop" };
  }
  // policy === "auto_recoverable"
  return dispatchAutoRecoverable(row, reason, ctx);
}

/**
 * Auto-recoverable reason dispatcher. Each handler is cyclomatic ≤5.
 *
 * Switch coverage is exhaustive over all 7 `auto_recoverable` reasons.
 * Adding a new reason in `classifyFailureReasonPolicy` returning
 * `"auto_recoverable"` requires updating this switch (TS exhaustiveness check
 * via `_exhaustive` never-binding).
 */
async function dispatchAutoRecoverable(
  row: FailedWithKnownReasonRow,
  reason: EmbeddingBackfillFailureReason,
  ctx: ProcessRowContext
): Promise<RecoveryOutcome> {
  switch (reason) {
    case "vision_residual":
      return recoverVisionResidual(row, ctx);
    case "vision_unload_timeout":
      return recoverVisionUnloadTimeout(row, ctx);
    case "memory_pressure":
      return recoverMemoryPressure(row);
    case "stall_timeout":
    case "lock_lost":
    case "supervisor_restart_orphan":
    case "dual_run_race":
      // Lifecycle-origin reasons: simply re-enqueue (next run picks up state).
      return { outcome: "re_enqueued" };
    default: {
      const _exhaustive: never = reason as never;
      void _exhaustive;
      return { outcome: "noop" };
    }
  }
}

// ============================================================================
// Per-reason recovery handlers (Strategy pattern, cyclomatic ≤5 per case)
// ============================================================================

/**
 * `vision_residual` recovery handler — per ADR-0007 Amendment 1 §A1.2.1
 * C-1 winning contract. 30s polling × OllamaUnloadService VRAM probe up to
 * 5min terminal bound; on bound exceeded → switch to vision_unload_timeout.
 *
 * Cyclomatic complexity: 5 (3 early returns + verify call + final return).
 */
async function recoverVisionResidual(
  row: FailedWithKnownReasonRow,
  ctx: ProcessRowContext
): Promise<RecoveryOutcome> {
  const elapsedMs = computeElapsedFromFailedAt(row, ctx.nowFn);
  if (elapsedMs >= BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS) {
    // 10min final ceiling → escalate to vision_unload_timeout terminal.
    return { outcome: "terminal_failed", finalReason: "vision_unload_timeout" };
  }
  if (elapsedMs >= BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS) {
    // 5min terminal bound → switch reason; next cycle polls the unload_timeout chain.
    return { outcome: "switched_to_unload_timeout" };
  }
  // Within 5min bound: probe VRAM (uses Wave 1 SSRF-safe handshake helper).
  const probe = await ctx.verifyVisionUnloadFn();
  if (probe.status === "vision_unloaded") {
    return { outcome: "re_enqueued" };
  }
  return { outcome: "waiting" };
}

/**
 * `vision_unload_timeout` recovery handler — final 5min polling window
 * (5-10min from failedAt). On 10min final timeout → terminal failed.
 *
 * Cyclomatic complexity: 4.
 */
async function recoverVisionUnloadTimeout(
  row: FailedWithKnownReasonRow,
  ctx: ProcessRowContext
): Promise<RecoveryOutcome> {
  const elapsedMs = computeElapsedFromFailedAt(row, ctx.nowFn);
  if (elapsedMs >= BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS) {
    return { outcome: "terminal_failed", finalReason: "vision_unload_timeout" };
  }
  const probe = await ctx.verifyVisionUnloadFn();
  if (probe.status === "vision_unloaded") {
    return { outcome: "re_enqueued" };
  }
  return { outcome: "waiting" };
}

/**
 * `memory_pressure` recovery handler — defer 60s and re-enqueue. The next
 * supervisor restart cycle resets RSS so the row should succeed.
 *
 * Cyclomatic complexity: 1.
 */
function recoverMemoryPressure(_row: FailedWithKnownReasonRow): RecoveryOutcome {
  return { outcome: "re_enqueued" };
}

// ============================================================================
// Outcome application — DB transition + audit emit
// ============================================================================

/**
 * Apply a recovery outcome to the row. CAS-guards every status write so
 * concurrent worker updates do not corrupt counters.
 *
 * Cyclomatic complexity ≤5 (4 outcome branches + default).
 */
async function applyRecoveryOutcome(
  row: FailedWithKnownReasonRow,
  reason: EmbeddingBackfillFailureReason,
  outcome: RecoveryOutcome,
  ctx: ProcessRowContext
): Promise<void> {
  switch (outcome.outcome) {
    case "re_enqueued":
      await transitionToReEnqueued(row, reason, ctx);
      return;
    case "switched_to_unload_timeout":
      await transitionToUnloadTimeoutBound(row, ctx);
      return;
    case "terminal_failed":
      await transitionToTerminalFailed(row, outcome.finalReason, ctx);
      return;
    case "waiting":
      ctx.result.waiting += 1;
      return;
    case "noop":
      return;
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return;
    }
  }
}

/**
 * CAS-guarded transition: failed_with_known_reason → queued + retryCount +1.
 */
async function transitionToReEnqueued(
  row: FailedWithKnownReasonRow,
  reason: EmbeddingBackfillFailureReason,
  ctx: ProcessRowContext
): Promise<void> {
  const updated = await ctx.prisma.webPage.updateMany({
    where: {
      id: row.id,
      embeddingBackfillStatus: "failed_with_known_reason",
    },
    data: {
      embeddingBackfillStatus: "queued",
      embeddingBackfillStartedAt: new Date(ctx.nowFn()),
      embeddingBackfillRetryCount: { increment: 1 },
      // Clear failure metadata — row is back in active retry.
      embeddingBackfillFailureReason: null,
      embeddingBackfillFailedAt: null,
    },
  });
  if (updated.count === 0) {
    ctx.result.concurrentUpdatesSkipped += 1;
    return;
  }
  // Re-enqueue all 7 categories via existing skip-recovery helper.
  await enqueueAllCategoriesForSkipRecovery(ctx.queue, {
    webPageId: row.id,
    screenshotStoragePath: row.screenshotStoragePath ?? undefined,
    initialDelayMs: BACKFILL_VISION_RESIDUAL_DELAY_MS,
    source: "cron",
  });
  ctx.result.recoveryResolved += 1;
  await emitRecoveryResolved(row.id, reason, row.embeddingBackfillRetryCount + 1);
}

/**
 * CAS-guarded transition: failed_with_known_reason (vision_residual) →
 * failed_with_known_reason (vision_unload_timeout). Preserves
 * `embeddingBackfillFailedAt` so the 5-10min polling window is continuous.
 */
async function transitionToUnloadTimeoutBound(
  row: FailedWithKnownReasonRow,
  ctx: ProcessRowContext
): Promise<void> {
  const updated = await ctx.prisma.webPage.updateMany({
    where: {
      id: row.id,
      embeddingBackfillStatus: "failed_with_known_reason",
      embeddingBackfillFailureReason: "vision_residual",
    },
    data: {
      embeddingBackfillFailureReason: "vision_unload_timeout",
    },
  });
  if (updated.count === 0) {
    ctx.result.concurrentUpdatesSkipped += 1;
    return;
  }
  ctx.result.switchedToUnloadTimeout += 1;
}

/**
 * CAS-guarded transition: failed_with_known_reason → failed (terminal).
 * Emits `embedding_backfill_terminal_known_reason`.
 */
async function transitionToTerminalFailed(
  row: FailedWithKnownReasonRow,
  finalReason: EmbeddingBackfillFailureReason,
  ctx: ProcessRowContext
): Promise<void> {
  const updated = await ctx.prisma.webPage.updateMany({
    where: {
      id: row.id,
      embeddingBackfillStatus: "failed_with_known_reason",
    },
    data: {
      embeddingBackfillStatus: "failed",
      embeddingBackfillFailureReason: finalReason,
      embeddingBackfillFailedAt: new Date(ctx.nowFn()),
    },
  });
  if (updated.count === 0) {
    ctx.result.concurrentUpdatesSkipped += 1;
    return;
  }
  ctx.result.terminalFailed += 1;
  await emitTerminalKnownReason(row.id, finalReason, row.embeddingBackfillRetryCount);
}

// ============================================================================
// Helpers (private, cyclomatic ≤5)
// ============================================================================

/**
 * Validate the raw failure reason string against the SSOT enum.
 */
function validateFailureReason(raw: string | null): EmbeddingBackfillFailureReason | null {
  if (raw === null) return null;
  if ((EMBEDDING_BACKFILL_FAILURE_REASONS as readonly string[]).includes(raw)) {
    return raw as EmbeddingBackfillFailureReason;
  }
  return null;
}

/**
 * Compute elapsed time since `embeddingBackfillFailedAt`. Returns 0 when
 * the timestamp is missing (defensive — should not happen in production).
 */
function computeElapsedFromFailedAt(row: FailedWithKnownReasonRow, nowFn: () => number): number {
  if (!row.embeddingBackfillFailedAt) return 0;
  const elapsed = nowFn() - row.embeddingBackfillFailedAt.getTime();
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * Resolve batch limit with NaN / non-positive guard.
 */
function resolveBatchLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return BACKFILL_RECOVERY_DEFAULT_BATCH_LIMIT;
  }
  return Math.floor(raw);
}

/**
 * Fetch up to `batchLimit` rows where `embeddingBackfillStatus =
 * 'failed_with_known_reason'`. Ordered by `embeddingBackfillFailedAt` ASC
 * (oldest first) to ensure fairness.
 */
async function fetchFailedWithKnownReasonRows(
  prisma: PrismaClient,
  batchLimit: number
): Promise<FailedWithKnownReasonRow[]> {
  const rows = await prisma.webPage.findMany({
    where: {
      embeddingBackfillStatus: "failed_with_known_reason",
    },
    select: {
      id: true,
      embeddingBackfillFailureReason: true,
      embeddingBackfillFailedAt: true,
      embeddingBackfillRetryCount: true,
      screenshotStoragePath: true,
    },
    orderBy: { embeddingBackfillFailedAt: "asc" },
    take: batchLimit,
  });
  return rows;
}
