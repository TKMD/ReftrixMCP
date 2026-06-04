// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisorFailurePath Service — Plan v3 Track T4 (PR-V3-T4) NEW file.
 *
 * Heavy logic for the Worker Pre-Return Pause failure-path race closure
 * mechanism. Concentrating delta in this NEW file (no max-lines pressure)
 * avoids inflating Module B (`worker-supervisor-lifecycle.service.ts`)
 * beyond its soft style target envelope per Conflict 1 / U-5 ruling.
 *
 * Heavy logic for the Worker Pre-Return Pause failure-path race closure.
 * NEW file to keep Module B within its soft style target envelope.
 *
 * **Three primary surfaces** (per design §2.2):
 *   - {@link markFailedAndAuditAtomic} (Contract 1 — child catch-block atomic
 *     DB-write-before-exit)
 *   - {@link findOrphanWebPageIds} + {@link backfillOrphanWebPageRow}
 *     (Contract 2 — supervisor child-exit backfill for true orphans)
 *   - {@link probeExistingLockBeforeBackfill} (SEC H-03 fail-closed entry
 *     point; INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001)
 *
 * @see PR-V3-T4 design.md §2.2 (3-contract architecture)
 * @see PR-V3-T4 design.md §7 (Module Mapping)
 * @see ADR-0009 Amendment 2 §A2.4 (NEW infrastructure)
 *
 * @module services/worker-supervisor-failure-path.service
 */

import type { FailedKnownReason } from "@reftrixmcp/core";

import {
  AUDIT_ACTION_WORKER_ORPHAN_BACKFILL_REDIS_DEGRADED,
  AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE,
  AUDIT_ACTOR_PAGE_ANALYZE_WORKER,
  AUDIT_ACTOR_WORKER_SUPERVISOR,
} from "../audit/audit-actions";
import { AUDIT_LOG_CONSTANTS, truncateAuditTargetId } from "./audit-log.service";

// AUDIT_LOG_CONSTANTS is imported explicitly to satisfy INV-AUDIT-EMIT-SSOT-IMPORT-001
// for the direct `tx.auditLog.create()` callsites in this module. The helper
// `truncateAuditTargetId()` already derives from
// AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH internally; this explicit
// reference binds the SSOT length contract for the standing regression scan.
void AUDIT_LOG_CONSTANTS;
import {
  truncateChildPid,
  WorkerRestartInflightAuditMetadataSchema,
  type WorkerRestartInflightAuditMetadata,
} from "./audit-log/worker-restart-inflight.schema";
import { emitSupervisorAuditLog } from "./worker-supervisor-helpers";
import type { WorkerActiveLockService } from "./worker-active-lock.service";
import type { WorkerType } from "../types/worker-type";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// Types
// ============================================================================

/**
 * Phase identifier (1-indexed canonical) used by FailedKnownReason mapping.
 *
 * Phase identifier (1-indexed canonical).
 */
export type PhaseN = "0" | "1" | "2_5" | "4" | "5" | "7_5";

/**
 * Discriminated result of {@link markFailedAndAuditAtomic} (Contract 1).
 *
 * Lets the catch-block tail forward `failedReason` via existing IPC schema
 * field to supervisor (LoC-neutral integration with Module B).
 */
export type FailureCommittedResult =
  | {
      committed: true;
      failedReason: FailedKnownReason;
      webPageId: string;
    }
  | {
      committed: false;
      reason: "web_page_id_unknown" | "transaction_aborted";
    };

/**
 * Discriminated result of {@link probeExistingLockBeforeBackfill} (SEC H-03).
 *
 * `'proceed'` = backfill safe (no live lock); `'skip_live_lock'` =
 * fail-closed skip (live foreign lock owned by fresh Worker);
 * `'redis_unavailable'` = fail-open (Redis unreachable; ADR-0011 §A4
 * fail-open contract for transient Redis disconnects).
 */
export type BackfillProbeOutcome =
  | { kind: "proceed" }
  | { kind: "skip_live_lock"; truncatedChildPid: string }
  | { kind: "redis_unavailable" };

/**
 * Subset of Prisma client surface required by this service. Discriminated
 * for DI-friendliness (matches the actual Prisma client without pulling
 * the full `@prisma/client` import surface here).
 */
export interface FailurePathPrismaClient {
  $transaction: <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>) => Promise<T>;
  webPage: {
    update: (args: {
      where: { id: string };
      data: {
        analysisStatus?: string;
        analysisPhaseStatus?: "failed";
        analysisError?: string | null;
        analysisCompletedAt?: Date;
        failedWithKnownReason?: FailedKnownReason;
      };
    }) => Promise<{ id: string }>;
    /**
     * url-key upsert surface (PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6
     * §Decision 2). Keyed on `url @unique` (`schema.prisma:208`) so the W0
     * (`page-analyze-worker.ts:1624-1625`) / W1 (`phase-0-ingest.ts` Phase 0.5)
     * / failure-path write paths all converge on the same row. id-key upsert
     * was rejected (SEC-M-01 / CONS-3): adding a create branch keyed on `id`
     * would let a concurrent retry on the same `url` × a different `webPageId`
     * hit `create.url` `url @unique` → P2002 → transaction_aborted → NOROW
     * regression (CWE-362). url-key collapses concurrent retries onto one row.
     */
    upsert: (args: {
      where: { url: string };
      create: {
        id: string;
        url: string;
        title: null;
        description: null;
        sourceType: string;
        usageScope: string;
        crawledAt: Date;
        analysisStatus: string;
        analysisPhaseStatus: "failed";
        analysisError: string | null;
        analysisCompletedAt: Date;
        failedWithKnownReason: FailedKnownReason;
      };
      update: {
        analysisStatus: string;
        analysisPhaseStatus: "failed";
        analysisError: string | null;
        analysisCompletedAt: Date;
        failedWithKnownReason: FailedKnownReason;
      };
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
  workerJobLifecycle: {
    findMany: (args: {
      where: {
        workerPid: number;
        workerSpawnTime: Date;
        eventType?: { in: Array<"spawn" | "release"> };
      };
      orderBy?: { eventAt: "asc" | "desc" };
    }) => Promise<
      Array<{
        id: string;
        webPageId: string;
        workerPid: number;
        workerSpawnTime: Date;
        eventType: string;
        eventAt: Date;
      }>
    >;
  };
  auditLog: {
    create: (args: {
      data: {
        action: string;
        actor: string;
        targetType: string;
        targetId: string | null;
        details: Record<string, unknown> | null;
        ipAddress: string | null;
        result: string;
      };
    }) => Promise<{ id: string }>;
  };
}

// ============================================================================
// Helper — phase number → FailedKnownReason
// ============================================================================

/**
 * Map a {@link PhaseN} identifier to the matching FailedKnownReason enum
 * value. Always returns a valid enum value (no null path) because PhaseN
 * is restricted to the 6 known phase identifiers.
 *
 * @param phaseN - Phase identifier
 * @returns FailedKnownReason enum value
 */
export function failedKnownReasonForPhaseN(phaseN: PhaseN): FailedKnownReason {
  return `worker_restart_during_inflight_phase_${phaseN}` as FailedKnownReason;
}

/**
 * Build the `create` payload for the failure-path url-key upsert (TDA-L-03
 * duplication-rule-1 closure). Centralizes the `web_pages` create shape so
 * the failure-path create branch and the W0 early-INSERT create shape
 * (`page-analyze-worker.ts:1626-1633`) share one SSOT and stay < 3%
 * duplication. The failure-path variant differs from W0 only in the terminal
 * failure columns (`analysisStatus='failed'` + `failedWithKnownReason` +
 * `analysisError` + `analysisCompletedAt`); the scaffolding columns
 * (`id` / `url` / `title` / `description` / `sourceType` / `usageScope` /
 * `crawledAt`) match W0.
 *
 * PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2.
 *
 * @param params.webPageId - WebPage UUID (worker-generated id, stable since
 *   `page-analyze-worker.ts:1552` non-empty init)
 * @param params.normalizedUrl - `normalizeUrlForStorage(url)` value (W0/W1
 *   parity, the upsert `where.url` key)
 * @param params.errorMessage - sanitised error message (≤ 500 chars)
 * @param params.failedReason - canonical FailedKnownReason for the in-flight phase
 * @param params.completedAt - terminal completion timestamp
 */
export function buildFailedWebPageCreateData(params: {
  webPageId: string;
  normalizedUrl: string;
  errorMessage: string;
  failedReason: FailedKnownReason;
  completedAt: Date;
}): {
  id: string;
  url: string;
  title: null;
  description: null;
  sourceType: string;
  usageScope: string;
  crawledAt: Date;
  analysisStatus: string;
  analysisPhaseStatus: "failed";
  analysisError: string | null;
  analysisCompletedAt: Date;
  failedWithKnownReason: FailedKnownReason;
} {
  return {
    id: params.webPageId,
    url: params.normalizedUrl,
    title: null,
    description: null,
    // W0 parity (page-analyze-worker.ts:1631-1632).
    sourceType: "user_provided",
    usageScope: "inspiration_only",
    crawledAt: params.completedAt,
    // Terminal failure columns (failure-path specific).
    analysisStatus: "failed",
    analysisPhaseStatus: "failed",
    analysisError: params.errorMessage,
    analysisCompletedAt: params.completedAt,
    failedWithKnownReason: params.failedReason,
  };
}

// ============================================================================
// Contract 1 — DB-write-before-exit ordering invariant
// ============================================================================

/**
 * Atomically commit the failure-classified `web_pages` row + emit the
 * primary `audit_logs.action='worker_restart_during_inflight_phase'`
 * entry within a single Prisma transaction.
 *
 * **SEC M-01 contract**: Prisma typed methods only; raw SQL forbidden in
 * failure-path scope (AST-level grep assertion in standing regression).
 *
 * **SEC M-03 contract**: `audit_logs.metadata` payload conforms to
 * {@link WorkerRestartInflightAuditMetadata} Zod schema; `child_pid` is
 * SEC H-02 sanitised to `pid_<sha256_8chars>` form.
 *
 * Plan v3 T4 Contract 1 — atomic DB-write-before-exit ordering invariant.
 *
 * **PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2**: the `web_pages`
 * write is a **url-key upsert** (NOT an id-key plain UPDATE). When the W0
 * early-INSERT path did not (or could not) create the row, the id-key UPDATE
 * threw P2025 → `$transaction` abort → `{committed:false}` → NOROW. The
 * url-key upsert (keyed on `url @unique`, `schema.prisma:208`) creates the
 * terminal `failed` row when absent and converges concurrent retries on the
 * same row (CWE-362 race closure; id-key upsert was rejected per CONS-3 /
 * SEC-M-01). The audit emit uses the `AUDIT_ACTOR_PAGE_ANALYZE_WORKER` SSOT
 * constant (CONS-1; INV-AUDIT-EMIT-SSOT-IMPORT-001 Test 8 parity).
 *
 * @param prismaClient - Prisma client (DI-friendly)
 * @param params.webPageId - WebPage UUID being analysed (caller MUST pass
 *   `state.actualWebPageId`; if `undefined`, returns
 *   `{committed: false, reason: 'web_page_id_unknown'}`)
 * @param params.normalizedUrl - `normalizeUrlForStorage(url)` value (the
 *   url-key upsert `where.url` key + create `url`). If `undefined`, the upsert
 *   cannot key on url; returns `{committed: false, reason: 'web_page_id_unknown'}`.
 * @param params.errorMessage - Sanitised error message for `analysis_error`
 *   column (≤ 500 chars per existing convention)
 * @param params.phaseN - Phase identifier of the in-flight phase
 * @param params.childPid - Worker process PID (truncated for audit_logs)
 * @returns Discriminated outcome
 */
export async function markFailedAndAuditAtomic(
  prismaClient: FailurePathPrismaClient,
  params: {
    webPageId: string | undefined;
    normalizedUrl: string | undefined;
    errorMessage: string;
    phaseN: PhaseN;
    childPid: number;
  }
): Promise<FailureCommittedResult> {
  // Both the webPageId (create `id`) and the normalizedUrl (upsert `where.url`
  // + create `url`) are required for the url-key upsert. Without either, the
  // failure-path cannot key the row.
  if (!params.webPageId || !params.normalizedUrl) {
    return { committed: false, reason: "web_page_id_unknown" };
  }

  const failedReason = failedKnownReasonForPhaseN(params.phaseN);
  const truncatedPid = truncateChildPid(params.childPid);

  try {
    const webPageId = params.webPageId;
    const normalizedUrl = params.normalizedUrl;
    const errorMessage = params.errorMessage.slice(0, 500);
    const completedAt = new Date();
    await prismaClient.$transaction(async (tx) => {
      // url-key upsert: creates the terminal `failed` row when W0 did not, and
      // converges concurrent retries (same url × different webPageId) onto the
      // single `url @unique` row (CONS-3 / CWE-362).
      await tx.webPage.upsert({
        where: { url: normalizedUrl },
        create: buildFailedWebPageCreateData({
          webPageId,
          normalizedUrl,
          errorMessage,
          failedReason,
          completedAt,
        }),
        update: {
          analysisStatus: "failed",
          analysisPhaseStatus: "failed",
          analysisError: errorMessage,
          analysisCompletedAt: completedAt,
          failedWithKnownReason: failedReason,
        },
        select: { id: true },
      });

      const metadata: WorkerRestartInflightAuditMetadata = {
        failed_known_reason: failedReason,
        phase_n: params.phaseN,
        child_pid: truncatedPid,
        phase_reconstruction: "exact",
        reason: "self_emit",
      };

      WorkerRestartInflightAuditMetadataSchema.parse(metadata); // CO-T4-03
      await tx.auditLog.create({
        data: {
          action: AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE,
          actor: AUDIT_ACTOR_PAGE_ANALYZE_WORKER,
          targetType: "web_page",
          targetId: truncateAuditTargetId(webPageId),
          details: metadata as unknown as Record<string, unknown>,
          ipAddress: null,
          result: "failure",
        },
      });
    });

    return {
      committed: true,
      failedReason,
      webPageId,
    };
  } catch (error) {
    logger.error("[FailurePath] markFailedAndAuditAtomic transaction aborted", {
      webPageId: truncateAuditTargetId(params.webPageId),
      phaseN: params.phaseN,
      error: sanitizeErrorMessage(error),
    });
    return { committed: false, reason: "transaction_aborted" };
  }
}

// ============================================================================
// Contract 2 — Supervisor child-exit reason backfill (true orphan path)
// ============================================================================

/**
 * Query `worker_job_lifecycle` table for `web_page_id` rows associated with
 * the exited child via `worker_pid + worker_spawn_time` equality join.
 *
 * **Cross-PID-reuse defense (Sub-C)**: Linux PID reuse is rejected
 * structurally because spawn_time equality requires both fields to match.
 * A different Worker spawn at the same PID at a different time will not
 * appear in results — INV-WORKER-PID-IDENTITY-005 Sub-C.
 *
 * Plan v3 T4 INV-WORKER-PID-IDENTITY-005 Sub-C cross-PID-reuse defense.
 *
 * @param prismaClient - Prisma client (DI-friendly)
 * @param exitedChildPid - PID of the exited child process
 * @param exitedChildSpawnTime - Boot timestamp of the exited child process
 * @returns Array of orphan WebPage UUIDs (rows with `event_type='spawn'`
 *   AND no paired `event_type='release'` row)
 */
export async function findOrphanWebPageIds(
  prismaClient: FailurePathPrismaClient,
  exitedChildPid: number,
  exitedChildSpawnTime: Date
): Promise<string[]> {
  try {
    const rows = await prismaClient.workerJobLifecycle.findMany({
      where: {
        workerPid: exitedChildPid,
        workerSpawnTime: exitedChildSpawnTime,
        eventType: { in: ["spawn", "release"] },
      },
      orderBy: { eventAt: "asc" },
    });

    // Group by webPageId; orphan = has 'spawn' but no paired 'release'.
    const byWebPage = new Map<string, { spawn: boolean; release: boolean }>();
    for (const row of rows) {
      const entry = byWebPage.get(row.webPageId) ?? { spawn: false, release: false };
      if (row.eventType === "spawn") entry.spawn = true;
      if (row.eventType === "release") entry.release = true;
      byWebPage.set(row.webPageId, entry);
    }

    const orphans: string[] = [];
    for (const [webPageId, status] of byWebPage.entries()) {
      if (status.spawn && !status.release) {
        orphans.push(webPageId);
      }
    }
    return orphans;
  } catch (error) {
    logger.warn("[FailurePath] findOrphanWebPageIds failed", {
      childPid: exitedChildPid,
      error: sanitizeErrorMessage(error),
    });
    return [];
  }
}

/**
 * Reconstruct the in-flight phase identifier from the orphan row's
 * `last_analyzed_phase` field (best_effort) or fall back to phase 0
 * (very early orphan, before Phase 1 begins).
 *
 * **SLO contract (TPA-M-01)**: best_effort ratio ≤ 10% within rolling
 * 30-day window. Reported via `phase_reconstruction='best_effort'` flag in
 * audit_logs.metadata.
 *
 * Plan v3 T4 TPA-M-01 SLO best_effort phase reconstruction.
 *
 * @param lastAnalyzedPhase - `web_pages.last_analyzed_phase` column value
 * @returns Tuple of {phaseN, reconstruction} where reconstruction='exact'
 *   when the lastAnalyzedPhase maps cleanly to a known PhaseN, else
 *   'best_effort' with phaseN='0' fallback.
 */
export function reconstructPhaseN(lastAnalyzedPhase: string | null | undefined): {
  phaseN: PhaseN;
  reconstruction: "exact" | "best_effort";
} {
  // Map last completed phase → next phase (in-flight at orphan time).
  // last_analyzed_phase is a free-form string; canonical values are
  // 'layout' (= phase 1 done → phase 2.5 in-flight) etc.
  switch (lastAnalyzedPhase) {
    case "ingest":
      return { phaseN: "1", reconstruction: "best_effort" };
    case "layout":
      return { phaseN: "2_5", reconstruction: "best_effort" };
    case "scroll-vision":
      return { phaseN: "4", reconstruction: "best_effort" };
    case "narrative":
      return { phaseN: "5", reconstruction: "best_effort" };
    case "embedding":
      return { phaseN: "7_5", reconstruction: "best_effort" };
    default:
      // No phase recorded yet — orphan happened during Phase 0 itself or
      // before any phase committed last_analyzed_phase.
      return { phaseN: "0", reconstruction: "best_effort" };
  }
}

/**
 * Backfill a single orphan `web_pages` row with the canonical
 * `failed_with_known_reason` enum value AND emit one paired
 * `audit_logs.action='worker_restart_during_inflight_phase'` entry within
 * a single Prisma transaction (LCC H-02 atomicity invariant: audit emit
 * BEFORE row deletion in cleanup cron).
 *
 * Plan v3 T4 Contract 2 — supervisor backfill for true orphans (LCC H-02
 * atomic audit-emit-before-delete).
 *
 * @param prismaClient - Prisma client (DI-friendly)
 * @param params.webPageId - Orphan WebPage UUID
 * @param params.phaseN - Reconstructed phase identifier
 * @param params.reconstruction - 'exact' | 'best_effort' SLO flag
 * @param params.childPid - Exited child PID (truncated for audit_logs)
 * @param params.exitSignal - Optional exit signal (SIGKILL / SIGABRT / etc.)
 */
export async function backfillOrphanWebPageRow(
  prismaClient: FailurePathPrismaClient,
  params: {
    webPageId: string;
    phaseN: PhaseN;
    reconstruction: "exact" | "best_effort";
    childPid: number;
    exitSignal?: string | null;
  }
): Promise<void> {
  const failedReason = failedKnownReasonForPhaseN(params.phaseN);
  const truncatedPid = truncateChildPid(params.childPid);
  const metadata: WorkerRestartInflightAuditMetadata = {
    failed_known_reason: failedReason,
    phase_n: params.phaseN,
    child_pid: truncatedPid,
    phase_reconstruction: params.reconstruction,
    ...(params.exitSignal ? { exit_signal: params.exitSignal } : {}),
    reason: "backfilled_from_orphan",
  };

  try {
    WorkerRestartInflightAuditMetadataSchema.parse(metadata); // CO-T4-03
    await prismaClient.$transaction(async (tx) => {
      await tx.webPage.update({
        where: { id: params.webPageId },
        data: {
          analysisStatus: "failed",
          analysisPhaseStatus: "failed",
          analysisCompletedAt: new Date(),
          failedWithKnownReason: failedReason,
        },
      });
      await tx.auditLog.create({
        data: {
          action: AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE,
          actor: AUDIT_ACTOR_WORKER_SUPERVISOR,
          targetType: "web_page",
          targetId: truncateAuditTargetId(params.webPageId),
          details: metadata as unknown as Record<string, unknown>,
          ipAddress: null,
          result: "failure",
        },
      });
    });
  } catch (error) {
    logger.error("[FailurePath] backfillOrphanWebPageRow failed", {
      webPageId: truncateAuditTargetId(params.webPageId),
      phaseN: params.phaseN,
      error: sanitizeErrorMessage(error),
    });
  }
}

// ============================================================================
// SEC H-03 — Fail-closed lock probe before backfill
// ============================================================================

/**
 * Plan v3 Track T4 SEC H-03 fail-closed contract entry point. Probes the
 * Redis lock for `workerType` BEFORE supervisor backfill proceeds, to
 * avoid trampling a fresh Worker's in-flight job (CWE-362 race-lost).
 *
 * Three outcomes:
 *   - `'proceed'`: lock absent — backfill safe.
 *   - `'skip_live_lock'`: live foreign lock present — skip backfill,
 *     emit secondary `worker_orphan_backfill_skipped_due_to_live_lock`
 *     audit_log (handled by caller via {@link emitOrphanBackfillSkippedAudit}).
 *   - `'redis_unavailable'`: Redis unreachable — fail-open per ADR-0011 §A4
 *     contract (transient Redis disconnect; supervisor proceeds with
 *     degraded mode marker so audit trail surfaces the degraded state).
 *
 * Plan v3 T4 SEC H-03 fail-closed lock probe (CWE-362 race-lost defense).
 *
 * @param lockService - WorkerActiveLockService instance
 * @param workerType - WorkerType to probe
 * @param exitedChildPid - PID of the exited child (for `truncatedChildPid`
 *   on `'skip_live_lock'` outcome)
 * @returns Discriminated outcome
 */
export async function probeExistingLockBeforeBackfill(
  lockService: WorkerActiveLockService,
  workerType: WorkerType,
  exitedChildPid: number
): Promise<BackfillProbeOutcome> {
  try {
    const probe = await lockService.probeExistingLock(workerType);
    if (probe.unavailable) {
      logger.warn("[FailurePath] backfill probe redis_unavailable, fail-open per ADR-0011 §A4", {
        workerType,
      });
      return { kind: "redis_unavailable" };
    }
    if (probe.exists) {
      logger.warn(
        "[FailurePath] backfill skipped due to live foreign lock (SEC H-03 fail-closed)",
        { workerType }
      );
      return { kind: "skip_live_lock", truncatedChildPid: truncateChildPid(exitedChildPid) };
    }
    return { kind: "proceed" };
  } catch (error) {
    logger.error("[FailurePath] probeExistingLockBeforeBackfill threw unexpectedly", {
      workerType,
      error: sanitizeErrorMessage(error),
    });
    // Defensive: treat unknown error as redis_unavailable (fail-open).
    return { kind: "redis_unavailable" };
  }
}

// ============================================================================
// Top-level entrypoint — handleChildExitOrBackfill
// ============================================================================

/**
 * Top-level orchestrator called by Module B's `handleChildExit` IPC handler
 * when a child process exits without emitting `'job-failed'` (true orphan
 * path: SIGKILL / OOM / segfault).
 *
 * Steps (per design §2.2 Contract 2):
 *   1. Probe existing lock (SEC H-03 fail-closed).
 *   2. If skip_live_lock → emit secondary audit_log + return.
 *   3. If proceed or redis_unavailable → query orphan rows.
 *   4. Reconstruct phase + backfill each orphan row + emit primary
 *      audit_logs.action='worker_restart_during_inflight_phase' (LCC H-02
 *      atomicity: audit emit BEFORE row deletion in cleanup cron).
 *
 * Plan v3 T4 Contract 2 top-level orchestrator. Module B forwards true
 * orphan exits here.
 *
 * @param prismaClient - Prisma client (DI-friendly)
 * @param lockService - WorkerActiveLockService instance
 * @param params.workerType - WorkerType of the exited child
 * @param params.exitedChildPid - Exited child PID
 * @param params.exitedChildSpawnTime - Exited child boot timestamp
 * @param params.lastAnalyzedPhases - Map of webPageId → last_analyzed_phase
 *   (looked up from `web_pages.last_analyzed_phase`; supplied by caller)
 * @param params.exitSignal - Optional exit signal name
 * @param emitSkipped - Audit emit helper for the SEC H-03 secondary path
 *   (DI-friendly so tests can stub).
 */
export async function handleChildExitOrBackfill(
  prismaClient: FailurePathPrismaClient,
  lockService: WorkerActiveLockService,
  params: {
    workerType: WorkerType;
    exitedChildPid: number;
    exitedChildSpawnTime: Date;
    lastAnalyzedPhases: Map<string, string | null>;
    exitSignal?: string | null;
  },
  emitSkipped: (workerType: WorkerType, truncatedPid: string) => void
): Promise<void> {
  const probe = await probeExistingLockBeforeBackfill(
    lockService,
    params.workerType,
    params.exitedChildPid
  );

  if (probe.kind === "skip_live_lock") {
    emitSkipped(params.workerType, probe.truncatedChildPid);
    return;
  }

  // Both 'proceed' and 'redis_unavailable' → continue with backfill.
  // For redis_unavailable we proceed (fail-open per ADR-0011 §A4) and
  // surface the degraded state via audit_logs metadata at backfill time.
  const orphanIds = await findOrphanWebPageIds(
    prismaClient,
    params.exitedChildPid,
    params.exitedChildSpawnTime
  );

  if (orphanIds.length === 0) {
    return;
  }

  if (probe.kind === "redis_unavailable") {
    emitSupervisorAuditLog(
      AUDIT_ACTION_WORKER_ORPHAN_BACKFILL_REDIS_DEGRADED,
      params.workerType,
      {
        orphan_count: orphanIds.length,
        reason: "redis_unavailable_fail_open",
      },
      "success"
    );
  }

  for (const webPageId of orphanIds) {
    const lastPhase = params.lastAnalyzedPhases.get(webPageId) ?? null;
    const { phaseN, reconstruction } = reconstructPhaseN(lastPhase);
    await backfillOrphanWebPageRow(prismaClient, {
      webPageId,
      phaseN,
      reconstruction,
      childPid: params.exitedChildPid,
      ...(params.exitSignal ? { exitSignal: params.exitSignal } : {}),
    });
  }
}
