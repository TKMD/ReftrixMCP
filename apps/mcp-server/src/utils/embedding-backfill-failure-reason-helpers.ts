// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Failure Reason Helpers — Strategy dispatcher + audit emit wrappers
 *
 * Plan v3 T3-Backfill V1 §3.1 axis A / B / C / F shared helper module
 * (Wave 2 / 2026-05-10)。`embedding-backfill-worker.ts` (axis A failure_reason
 * setting on every status write) と `BackfillRecoveryReconciliationService`
 * (axis C per-reason recovery dispatcher) の両方が consume する。
 *
 * Plan v3 T3-Backfill V1 §3.1 axis A / B / C / F shared helper module.
 * Consumed by both `embedding-backfill-worker.ts` (axis A failure_reason
 * setting) and `BackfillRecoveryReconciliationService` (axis C per-reason
 * recovery dispatcher).
 *
 * 設計原則 / Design principles:
 *
 *   - **Strategy pattern (cyclomatic ≤5 per case, FIND-PLAN-TDA-T3B-04 M)**:
 *     `dispatchByReason()` は 12 reasons の per-reason handler を Record で
 *     mapping。各 case body は cyclomatic ≤5 を保つ (early return × N + final
 *     return)。新 reason 追加時は `EMBEDDING_BACKFILL_FAILURE_REASONS` SSOT
 *     を更新 → TS exhaustiveness check が compile 時に未対応 case を flag する。
 *
 *   - **INV-AUDIT-EMIT-SSOT-IMPORT-001 cross-cutting compliance**: 4 NEW
 *     audit_logs.action emit (`embedding_backfill_recovery_attempt` /
 *     `_resolved` / `screenshot_deletion_deferred` /
 *     `embedding_backfill_terminal_known_reason`) はすべて
 *     `getAuditLogService().log()` 経由 (audit-log.service.ts 内で
 *     `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` SSOT を使う)。
 *     hardcoded `slice(0, 8)` literal は禁止 (Wave 5 LCC drift detection)。
 *
 *   - **PII-safe**: `details` payload は `failureReason` (12-element enum
 *     SSOT) / `retryCount` (numeric) / `outcome` (string literal) のみ。
 *     URL / boot token / stack trace は出力禁止 (CWE-209)。
 *
 *   - **fail-open audit emit**: audit emit failure は recovery main path
 *     を block しない (Graceful Degradation)。`AuditLogService.log()` 内部の
 *     warn-only graceful-degrade pattern を継承する。
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis A / B / C
 * @see ADR-0007 Amendment 1 §A1.2.1 (C-1 winning contract)
 * @see ADR-0032 (truncateAuditTargetId SSOT — Wave 5 LCC canonical CWE-209)
 * @see INV-AUDIT-EMIT-SSOT-IMPORT-001 (NEW cross-cutting per IO U-CC-2)
 *
 * @module utils/embedding-backfill-failure-reason-helpers
 */

import { AUDIT_LOG_CONSTANTS, getAuditLogService } from "../services/audit-log.service";
import { logger } from "./logger";
import { sanitizeErrorMessage } from "./sanitize-error";

/**
 * Plan v3 T3-Backfill V1 §3.1 axis B / Wave 2 — INV-AUDIT-EMIT-SSOT-IMPORT-001
 * compliant PII-truncation for log fallback messages.
 *
 * SSOT-derived: reads `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` per
 * Wave 5 LCC canonical CWE-209 pattern (ADR-0032). Eliminates the hardcoded
 * length-`8` literal that the standing regression
 * `INV-AUDIT-EMIT-SSOT-IMPORT-001` flags as drift risk.
 *
 * **Wave 4 export expansion (COHERENCE-WAVE2-01 L tracked-issue closure,
 * 2026-05-11)**: exported so `backfill-recovery-reconciliation.service.ts`
 * (and any future consumer of the SLO_MARKER fallback log line pattern)
 * can derive `webPageId` truncation from the same SSOT length as the audit
 * service's internal `truncateAuditTargetId()`. Use this helper only for
 * **log fallback / SLO_MARKER lines**; for `audit_logs` write paths the
 * canonical entry point remains `getAuditLogService().log()` (which applies
 * truncation internally via `truncateAuditTargetId()` per ADR-0032).
 *
 * @see Wave 4 Finding Registry COHERENCE-WAVE2-01 (L) closure
 * @see ADR-0032 (Wave 5 LCC canonical CWE-209 SSOT pattern)
 */
export function truncateForLog(id: string): string {
  if (id.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) return id;
  return id.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
}
import {
  AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_ATTEMPT,
  AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_RESOLVED,
  AUDIT_ACTION_EMBEDDING_BACKFILL_TERMINAL_KNOWN_REASON,
} from "../audit/audit-actions";
import type { EmbeddingBackfillFailureReason } from "../queues/embedding-backfill-queue";

// ============================================================================
// Recovery outcome discriminated union
// ============================================================================

/**
 * Plan v3 T3-Backfill V1 §3.1 axis C — Per-reason recovery handler outcome.
 *
 * Discriminated union returned by `recover<Reason>` handlers. Consumer
 * (`BackfillRecoveryReconciliationService`) inspects `outcome` to drive
 * audit emit + DB state transition.
 *
 *   - `re_enqueued`: handler successfully transitioned the row back to
 *     `queued` (recovery succeeded for this attempt).
 *   - `waiting`: precondition still unmet within terminal bound; no state
 *     change in this tick (next 30s interval will re-check).
 *   - `switched_to_unload_timeout`: 5min terminal bound elapsed for
 *     `vision_residual`; row transitioned to `failed_with_known_reason`
 *     with `failureReason='vision_unload_timeout'`.
 *   - `terminal_failed`: 10min final timeout / retry cap exhausted /
 *     non-recoverable reason (e.g. `ssrf_blocked`); row transitioned to
 *     `failed` and recovery loop terminates for this row.
 *   - `noop`: handler is unimplemented / disabled; consumer should leave
 *     the row unchanged.
 */
export type RecoveryOutcome =
  | { outcome: "re_enqueued" }
  | { outcome: "waiting" }
  | { outcome: "switched_to_unload_timeout" }
  | { outcome: "terminal_failed"; finalReason: EmbeddingBackfillFailureReason }
  | { outcome: "noop" };

// ============================================================================
// Audit emit wrappers (INV-AUDIT-EMIT-SSOT-IMPORT-001 SSOT compliant)
// ============================================================================

/**
 * `embedding_backfill_recovery_attempt` emit wrapper (Plan v3 T3-Backfill V1
 * §3.1 axis C). Emitted on every recovery handler attempt regardless of
 * outcome (drives SLO "recovery attempt rate" metric).
 *
 * SSOT compliance per INV-AUDIT-EMIT-SSOT-IMPORT-001: routes via
 * `getAuditLogService().log()` which internally invokes
 * `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` for `targetId` PII
 * truncation (Wave 5 LCC canonical CWE-209 pattern, ADR-0032).
 *
 * Fail-open: emit failure is logged via SLO_MARKER and does NOT block the
 * recovery main path.
 *
 * @param webPageId      - Full UUID (truncated by audit-log service to 8 chars)
 * @param failureReason  - One of `EMBEDDING_BACKFILL_FAILURE_REASONS` SSOT enum
 * @param retryCount     - Numeric only (PII-safe)
 */
export async function emitRecoveryAttempt(
  webPageId: string,
  failureReason: EmbeddingBackfillFailureReason,
  retryCount: number
): Promise<void> {
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_ATTEMPT,
      actor: "system:embedding-backfill-recovery-service",
      targetType: "web_page",
      targetId: webPageId,
      result: "success",
      details: {
        failureReason,
        retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 0,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    // FIND-TPA-PLAN-03 (M, Wave 1 SLO_MARKER pattern): primary emit failure
    // is observable via L1.5 tier log-based metric.
    logger.warn(
      "[BackfillRecoveryReconciliation] [SLO_MARKER] backfill_recovery_audit_emit_failed",
      {
        action: AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_ATTEMPT,
        webPageId: truncateForLog(webPageId),
        error: sanitizeErrorMessage(error),
      }
    );
  }
}

/**
 * `embedding_backfill_recovery_resolved` emit wrapper. Emitted only on the
 * success path (handler successfully re-enqueued / re-transitioned the row).
 *
 * @param webPageId      - Full UUID
 * @param failureReason  - The reason the recovery resolved
 * @param retryCount     - Numeric only
 */
export async function emitRecoveryResolved(
  webPageId: string,
  failureReason: EmbeddingBackfillFailureReason,
  retryCount: number
): Promise<void> {
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_RESOLVED,
      actor: "system:embedding-backfill-recovery-service",
      targetType: "web_page",
      targetId: webPageId,
      result: "success",
      details: {
        failureReason,
        retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 0,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.warn(
      "[BackfillRecoveryReconciliation] [SLO_MARKER] backfill_recovery_audit_emit_failed",
      {
        action: AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_RESOLVED,
        webPageId: truncateForLog(webPageId),
        error: sanitizeErrorMessage(error),
      }
    );
  }
}

/**
 * `embedding_backfill_terminal_known_reason` emit wrapper. Emitted when a
 * `failed_with_known_reason` row escalates to terminal `failed` state (no
 * further auto-recovery).
 *
 * Triggers:
 *   - `vision_residual` / `vision_unload_timeout` chain reaches 10min final timeout
 *   - `retryCount >= MAX_AUTO_RETRIES`
 *   - Non-recoverable reason (e.g. `ssrf_blocked`)
 *
 * Drives SLO L1 WARN tier (terminal escalation rate).
 *
 * @param webPageId      - Full UUID
 * @param failureReason  - Final reason at terminal escalation
 * @param retryCount     - Numeric retry count
 */
export async function emitTerminalKnownReason(
  webPageId: string,
  failureReason: EmbeddingBackfillFailureReason,
  retryCount: number
): Promise<void> {
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_EMBEDDING_BACKFILL_TERMINAL_KNOWN_REASON,
      actor: "system:embedding-backfill-recovery-service",
      targetType: "web_page",
      targetId: webPageId,
      result: "failure",
      details: {
        failureReason,
        retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 0,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.warn(
      "[BackfillRecoveryReconciliation] [SLO_MARKER] backfill_recovery_audit_emit_failed",
      {
        action: AUDIT_ACTION_EMBEDDING_BACKFILL_TERMINAL_KNOWN_REASON,
        webPageId: truncateForLog(webPageId),
        error: sanitizeErrorMessage(error),
      }
    );
  }
}

// ============================================================================
// Per-reason policy classification (FIND-PLAN-TDA-T3B-04 cyclomatic ≤5)
// ============================================================================

/**
 * Plan v3 T3-Backfill V1 §3.1 axis C — Per-reason policy classification.
 *
 * Returns the auto-retry policy hint for a given failure reason. Used by
 * `BackfillRecoveryReconciliationService` to skip non-recoverable reasons
 * before invoking the per-reason recovery handler.
 *
 *   - `auto_recoverable`: handler exists and may succeed (e.g.
 *     `vision_residual` / `memory_pressure`)
 *   - `terminal_unrecoverable`: row should be transitioned directly to
 *     `failed` with the same reason (e.g. `ssrf_blocked`)
 *   - `legacy_existing_path`: row is already routed via existing
 *     `skipped_*` retry bucket; recovery service is a no-op (e.g.
 *     `parity_check_failed` / `bbox_unresolvable` / `fork_error`)
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C per-reason policy table (line 199-212)
 */
export type FailureReasonPolicy =
  | "auto_recoverable"
  | "terminal_unrecoverable"
  | "legacy_existing_path";

/**
 * Classify a failure reason into auto-recovery policy bucket. Strategy
 * pattern dispatcher — exhaustive switch over all 12 SSOT enum values.
 *
 * Cyclomatic complexity: ≤5 per case (single switch, no branches per case).
 * Total CC for the function: 12 (one per case + 1 default) — accepted because
 * it is purely a classification table and passes the
 * "no nested decisions per case" contract.
 *
 * @param reason - Failure reason from `EMBEDDING_BACKFILL_FAILURE_REASONS` SSOT
 * @returns Policy bucket
 */
export function classifyFailureReasonPolicy(
  reason: EmbeddingBackfillFailureReason
): FailureReasonPolicy {
  switch (reason) {
    // Auto-recoverable: BackfillRecoveryReconciliationService handles
    case "vision_residual":
    case "vision_unload_timeout":
    case "memory_pressure":
    case "stall_timeout":
    case "lock_lost":
    case "supervisor_restart_orphan":
    case "dual_run_race":
      return "auto_recoverable";

    // Terminal unrecoverable: SEC contract — never retry
    case "ssrf_blocked":
      return "terminal_unrecoverable";

    // Legacy existing path: already covered by skipped_* retry bucket
    case "parity_check_failed":
    case "bbox_unresolvable":
    case "screenshot_missing":
    case "fork_error":
      return "legacy_existing_path";

    default: {
      // Exhaustiveness check — adding a new EmbeddingBackfillFailureReason
      // requires updating this switch. TS compiler enforces.
      const _exhaustive: never = reason;
      void _exhaustive;
      return "terminal_unrecoverable";
    }
  }
}
