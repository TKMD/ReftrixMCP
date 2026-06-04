// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor — Lifecycle Module (Module B)
 *
 * Spawn / IPC dispatch / Exit handling / Initiated restart logic extracted
 * from `worker-supervisor.service.ts` per CO-26 split design Phase 2 Step 5
 * (PR-V3-CO-26-SPLIT). Mechanical extraction — zero behaviour change.
 *
 * PR-Bα-1 PR-D-8/D-9 lineage preserved structurally:
 *   - per-type boot tokens (`PAGE` / `BACKFILL`) IPC `verifyWorkerIpcMessage` Zod 再検証 (Rule 5)
 *   - self-chained respawn protocol (Layer 1 retry budget = Module C / Layer 2 fail-closed `probeExistingLock` = Module C)
 *   - 2 distinct `NODE_ENV==="test"` short-circuits (preserved byte-for-byte per SEC FIND-M-02 ruling, Module C own state Map)
 *   - SIGABRT respawn suppress threshold 3 + 60s extension (helper `processSigabrtSignal` / `scheduleSigabrtAwareRespawn`)
 *
 * Module B → Module C 直接 import 禁止 (forbidden edge per design §3.3、
 * INV-WORKER-LIFECYCLE-RESPONSIBILITY-001 AST gate で enforce)。Cross-module
 * callable は Module A facade 経由の indirect path で取得:
 *   `this.supervisor.getLockOrchestrator().acquireRedisLockBestEffort(workerType)`
 *
 * @see  §3.1 Module B + §3.2.1
 * @see ADR-0011 Amendment 5 §A5.3 — max-lines hard cap rationale
 * @see PR-D-8 §3.2.4 Rule 1-5 — per-type boot tokens / pid binding / IPC verification
 * @module services/worker-supervisor-lifecycle
 */

import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { logger, isDevelopment } from "../utils/logger";
import { computeMemoryProfile } from "./worker-memory-profile";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { WORKER_TYPES, type WorkerType } from "../types/worker-type";
// Plan v4.5 PR1 Track P0 (NEW-U-11 + LCC-H-01): stderr secondary file capture.
// Existing pipe + logger.warn route preserved; this adds the file-fd write
// route so abort-imminent raw libc/pthread/ONNX native messages flush to disk.
import { loadWorkerStderrConfigOrDefault } from "../config/worker-stderr-config";
import { openStderrFileWithPreflight, sanitizeStderrChunk } from "../utils/stderr-write-guard";
import {
  clearLockHeartbeatTimer,
  emitOrphanBackfillSkippedAudit,
  emitSupervisorAuditLog,
  emitWorkerRestartAudit,
  executeSelfChainedRespawn,
  processSigabrtSignal,
  scheduleSigabrtAwareRespawn,
  verifyWorkerIpcMessage,
} from "./worker-supervisor-helpers";
// Plan v3 Track T4 (PR-V3-T4) — Pre-Return Pause failure-path race closure
// Plan v3 Track T4 (PR-V3-T4) — supervisor backfill orchestrator
import { handleChildExitOrBackfill } from "./worker-supervisor-failure-path.service";
// Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-04 — Module B DI lift. Prisma client
// is consumed via Module A facade `this.supervisor.getPrismaClient()` instead
// of a direct `@reftrixmcp/database` import (test fixtures inject via
// `setPrismaClientForTesting`).
//
// UNBLOCK-T4-04 Module B DI lift: consume Prisma client via Module A facade.
import {
  verifyVisionUnloadPrecondition,
  VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS,
  VISION_UNLOAD_FINAL_TIMEOUT_MS,
} from "./vision/vision-unload-handshake";
// ADR-0011 Amendment 7 §A7.7: SSOT audit action for the deferred-spawn
// timeout + fallback-on-absence scan-based terminal transition. Imported as a
// constant (INV-AUDIT-EMIT-SSOT-IMPORT-001) — bare literal hardcode forbidden.
import {
  AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT,
  AUDIT_ACTION_VISION_PROBE_UNAVAILABLE,
  AUDIT_ACTOR_WORKER_SUPERVISOR,
} from "../audit/audit-actions";
import { getAuditLogService, truncateAuditTargetId } from "./audit-log.service";
// Plan v3 Track T4 (PR-V3-T4) UNBLOCK-V2-04 — TDA-FIND-01 string-literal env var
// coupling drift fix. Import the SSOT env var name constant from the schema
// module so the supervisor write side and the child read side
// (`readSupervisorInjectedSpawnTimeMs`) refer to the same identifier; renaming
// the env var in one place automatically propagates to both sides via
// TypeScript symbol resolution.
//
// UNBLOCK-V2-04 SSOT 同期化: child 側と同一の定数を参照する。
import { REFTRIX_WORKER_SPAWN_TIME_MS_ENV } from "../workers/worker-ipc-spawn-recorded.schema";
// Type-only import to avoid runtime cycle (Module B → Module A is type-only).
// type-only import で runtime cycle を回避 (Module B → Module A は型のみ参照)。
import type {
  WorkerChildState,
  WorkerState,
  WorkerSupervisor,
  WorkerSupervisorOptions,
  WorkerTypeConfig,
} from "./worker-supervisor.service";

// ============================================================================
// IPC_SHUTDOWN_GRACE_MS — Plan v2 §1 S1.1/S1.2 env-overridable constant
// ============================================================================

/**
 * IPC 'shutdown' メッセージ送信後、SIGTERM までの猶予 (ms)。Plan v2 §1 S1.1/S1.2:
 * 旧 hardcoded `2000` → env override + range-validated constant (default 30s /
 * range 1-120s)。INV-NEXT-JOB-RACE-001 sub 3 で CI gate。
 *
 * IPC 'shutdown' grace window before SIGTERM (ms). Plan v2 §1 S1.1/S1.2:
 * legacy hardcoded `2000` is replaced by env-overridable range-validated
 * constant (default 30s / range 1-120s).
 */
const IPC_SHUTDOWN_GRACE_MS_DEFAULT = 30_000;
const IPC_SHUTDOWN_GRACE_MS_MIN = 1_000;
const IPC_SHUTDOWN_GRACE_MS_MAX = 120_000;

export const IPC_SHUTDOWN_GRACE_MS: number = ((): number => {
  const fromEnv = process.env.WORKER_IPC_SHUTDOWN_GRACE_MS;
  if (fromEnv === undefined || fromEnv === "") return IPC_SHUTDOWN_GRACE_MS_DEFAULT;
  const parsed = Number.parseInt(fromEnv, 10);
  if (
    Number.isNaN(parsed) ||
    parsed < IPC_SHUTDOWN_GRACE_MS_MIN ||
    parsed > IPC_SHUTDOWN_GRACE_MS_MAX
  ) {
    logger.warn(
      `[WorkerSupervisor] Invalid WORKER_IPC_SHUTDOWN_GRACE_MS=${fromEnv}, using ${IPC_SHUTDOWN_GRACE_MS_DEFAULT}`
    );
    return IPC_SHUTDOWN_GRACE_MS_DEFAULT;
  }
  return parsed;
})();

/**
 * @internal Plan v2 §1 S1.2 grace bound test 用 export (INV-NEXT-JOB-RACE-001 sub 3).
 *
 * SEC FIND-M-03 (CWE-200) mitigation: marked `@internal` JSDoc + Finding Registry
 * tracking. Intended for test injection only; NOT part of the public API surface.
 *
 * Test-only export. Marked `@internal` per SEC FIND-M-03 CWE-200 mitigation.
 */
export const __IPC_SHUTDOWN_GRACE_MS_FOR_TEST = {
  current: IPC_SHUTDOWN_GRACE_MS,
  default: IPC_SHUTDOWN_GRACE_MS_DEFAULT,
  min: IPC_SHUTDOWN_GRACE_MS_MIN,
  max: IPC_SHUTDOWN_GRACE_MS_MAX,
} as const;

// ============================================================================
// Deferred-spawn bounded retry constants (ADR-0011 Amendment 7 §A7.5)
// ============================================================================

/**
 * Worker-spawn-level probe cadence for the deferred secondary-spawn retry
 * timer. Derived from the existing SSOT `VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS`
 * (30s) to avoid introducing a new magic number; the dedicated name resolves
 * the semantic overload (§A7.5, TPA-PLAN-06) — the source const's JSDoc
 * semantic is a BullMQ job-enqueue delay, not a supervisor probe cadence.
 *
 * deferred-spawn retry timer の probe cadence (30s)。既存 SSOT から derive。
 */
export const SECONDARY_SPAWN_RETRY_CADENCE_MS = VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS;

/**
 * Worker-spawn-level timeout bound for the deferred secondary-spawn retry.
 * Shares the value of `VISION_UNLOAD_FINAL_TIMEOUT_MS` (10min) but is a
 * distinct responsibility (job-level terminal bound vs. worker-spawn-level
 * timeout) — derived for semantic separation (§A7.5).
 *
 * deferred-spawn retry の timeout bound (10min)。job-level terminal bound と
 * 同値だが意味的に別責務として derive。
 */
export const SECONDARY_SPAWN_RETRY_TIMEOUT_MS = VISION_UNLOAD_FINAL_TIMEOUT_MS;

/**
 * Bounded attempt counter for the deferred secondary-spawn retry (CWE-770,
 * SEC-PLAN-01). Derived as `ceil(timeout / cadence)` = `ceil(600000 / 30000)`
 * = **20**. No new magic number — derived from the two SSOT constants above so
 * a change to either propagates automatically.
 *
 * bounded attempt counter `ceil(10min/30s)` = 20 (CWE-770 cap)。
 */
export const SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS = Math.ceil(
  SECONDARY_SPAWN_RETRY_TIMEOUT_MS / SECONDARY_SPAWN_RETRY_CADENCE_MS
);

/**
 * probe_failed 3-strike threshold (§A7.6, converges with Amendment 2 §A2.4:550
 * "3-strike block" contract). After 3 consecutive `probe_failed` outcomes the
 * retry is blocked (no infinite retry under a persistently failing probe).
 *
 * probe_failed が 3 回連続したら retry を block する (§A7.6)。
 */
export const SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT = 3;

// ============================================================================
// L3 auto-failover runtime efficacy (U-V45-PR1-07 closure)
// ============================================================================

/**
 * Module-level registry of live secondary stderr file descriptors keyed by
 * child PID. Maintained additively by `attachChildEventHandlers` and pruned
 * on child `exit` events.
 *
 * Required by `closeStderrFilesForAllChildren()` so that L3 disk-pressure
 * auto-failover can close the file descriptor of currently-running child
 * workers **at runtime** (without waiting for the next spawn). Avoids
 * extending `WorkerChildState` schema or threading state through the
 * cross-class supervisor facade.
 *
 * U-V45-PR1-07 closure (M severity): `process.env.REFTRIX_WORKER_STDERR_REDIRECT_ENABLED = "false"`
 * alone only affects subsequent spawns. Closing the live secondaryFd here
 * structurally guarantees the running child stops appending to the file
 * (subsequent `fs.writeSync` calls become EBADF no-ops via the existing
 * non-fatal catch in the data handler).
 *
 * @internal Plan v4.5 PR1 P0.5.runtime / IO V0 unblock U-V45-PR1-07
 */
const activeChildStderrFds: Map<number, number> = new Map();

/**
 * Close all live secondary stderr file descriptors registered by
 * `attachChildEventHandlers`. Used by `worker-stderr-cleanup-cron.ts` L3
 * disk-pressure auto-failover path so that running child processes stop
 * appending to stderr files immediately (Option (b) chosen over IPC signal
 * to avoid cross-module IPC surface introduction).
 *
 * Idempotent: each fd is removed from the registry after `closeSync` so a
 * second invocation in the same degraded window is a no-op. Errors during
 * close are swallowed (best-effort runtime degradation, observability via
 * pipe + logger.warn route is unaffected).
 *
 * @returns Number of file descriptors closed (for audit / observability).
 *
 * @see Plan v4.5 V3 §P0.5.runtime (L3 4-layer 防御 runtime efficacy)
 * @see ADR-0036 §D4.1 L3 disk space monitoring spec
 */
export function closeStderrFilesForAllChildren(): { closedCount: number } {
  let closedCount = 0;
  for (const [pid, fd] of activeChildStderrFds.entries()) {
    try {
      fs.closeSync(fd);
      closedCount++;
    } catch {
      // best-effort — pipe + logger.warn observability route remains intact
    }
    activeChildStderrFds.delete(pid);
  }
  return { closedCount };
}

/**
 * @internal Test-only inspection of the live registry.
 */
export const __ACTIVE_CHILD_STDERR_FDS_FOR_TEST = {
  size: (): number => activeChildStderrFds.size,
  has: (pid: number): boolean => activeChildStderrFds.has(pid),
  clear: (): void => activeChildStderrFds.clear(),
} as const;

// ============================================================================
// Lifecycle class
// ============================================================================

/**
 * Per-type lifecycle orchestration class. Owns the spawn / IPC dispatch /
 * exit handling / initiated-restart pipeline. Delegates lock-related
 * operations to Module C via the Module A facade indirect path
 * (`this.supervisor.getLockOrchestrator()`).
 *
 * Per-type lifecycle 制御 class。Spawn / IPC / Exit / Initiated restart の
 * pipeline を担当し、lock 関連は Module C へ Module A facade 経由で委譲する。
 */
export class WorkerSupervisorLifecycle {
  /**
   * Module A facade reference — used for cross-module indirect path
   * (`this.supervisor.getLockOrchestrator().X()`) per TPA-01 explicit
   * state-sharing accessor pattern. Direct import of Module C is forbidden.
   */
  private readonly supervisor: WorkerSupervisor;

  /**
   * DI seam for the Vision-unload precondition probe (ADR-0011 Amendment 7
   * §A7.1, canonical precedent `backfill-recovery-reconciliation.service.ts:184`).
   * Production uses the `verifyVisionUnloadPrecondition()` SSOT; tests inject a
   * deterministic function to drive the `vision_residual → vision_unloaded`
   * transition without a live Ollama probe (INV-011 (e)).
   *
   * Vision unload probe の DI seam (テスト注入用、production は SSOT default)。
   */
  private verifyVisionUnloadFn: typeof verifyVisionUnloadPrecondition =
    verifyVisionUnloadPrecondition;

  /**
   * DI seam for `Date.now()` so the fallback-scan time-anchor and the
   * elapsed-time computation are deterministic under fake timers (INV-013).
   */
  private nowFn: () => number = () => Date.now();

  /**
   * Per-supervisor singleton retry timer for the deferred secondary spawn.
   * Non-null while a retry loop is active; the re-entry guard (§A7.x /
   * INV-011 (c)) skips scheduling when this is already set.
   */
  private secondarySpawnRetryTimer: ReturnType<typeof setInterval> | null = null;

  /** Bounded attempt counter for the active retry loop (CWE-770). */
  private secondarySpawnRetryAttempts = 0;

  /** Consecutive `probe_failed` counter for the 3-strike block (§A7.6). */
  private secondarySpawnProbeFailedStreak = 0;

  /** `nowFn()` timestamp captured when the secondary spawn was first deferred. */
  private secondarySpawnDeferredAtMs: number | null = null;

  constructor(supervisor: WorkerSupervisor) {
    this.supervisor = supervisor;
  }

  /**
   * @internal Test-only DI injection of the Vision-unload probe + `nowFn`.
   * Mirrors `RunRecoveryCycleOptions.verifyVisionUnloadFn` / `nowFn`
   * (canonical precedent). Production callers never invoke this.
   */
  setSecondarySpawnRetryDepsForTesting(deps: {
    verifyVisionUnloadFn?: typeof verifyVisionUnloadPrecondition;
    nowFn?: () => number;
  }): void {
    if (deps.verifyVisionUnloadFn) this.verifyVisionUnloadFn = deps.verifyVisionUnloadFn;
    if (deps.nowFn) this.nowFn = deps.nowFn;
  }

  // ==========================================================================
  // Public API — staggered multi-type spawn (PR-D-8 MF-07)
  // ==========================================================================

  /**
   * Spawn primary first, await first heartbeat (or `heartbeatTimeoutMs`),
   * then spawn secondary. Prevents allocation spike from concurrent DINOv2 +
   * e5-base ONNX init (Plan v1.1 §3.3).
   *
   * Multi-type 起動 API。primary heartbeat (最大 timeoutMs) 受信後に secondary 起動。
   *
   * @param heartbeatTimeoutMs Override default 10s heartbeat wait
   */
  async ensureAllWorkersRunningStaggered(heartbeatTimeoutMs: number = 10_000): Promise<void> {
    const primary = this.supervisor.firstWorkerTypeOfPriority("primary");
    const secondary = this.supervisor.firstWorkerTypeOfPriority("secondary");
    if (!primary || !secondary) {
      logger.warn("[WorkerSupervisor] ensureAllWorkersRunningStaggered: missing priority", {
        primary,
        secondary,
      });
      return;
    }
    this.supervisor.ensureWorkerRunningForType(primary);
    await this.waitForFirstHeartbeat(primary, heartbeatTimeoutMs);
    // ADR-0011 Amendment 2 §A2.2.3: fail-closed Vision unload precondition
    // (routed through the DI seam per Amendment 7 §A7.1 / INV-011 (e)).
    if ((await this.verifyVisionUnloadFn()).status === "vision_unloaded") {
      this.supervisor.ensureWorkerRunningForType(secondary);
      return;
    }
    // ADR-0011 Amendment 7 §A7.2/§A7.4: Vision residual / probe failure deferred
    // the secondary spawn. Schedule a bounded retry timer that re-probes on a
    // 30s cadence and spawns once Vision unloads, falling back to a scan-based
    // terminal transition if the worker stays absent for the full 10min bound.
    this.scheduleSecondarySpawnRetry(secondary);
  }

  // ==========================================================================
  // Deferred secondary-spawn bounded retry (ADR-0011 Amendment 7 §A7.2-§A7.6)
  // ==========================================================================

  /**
   * Schedule (or no-op if already scheduled) the bounded deferred-spawn retry
   * loop for the secondary `embedding-backfill` worker. Per-supervisor
   * singleton (re-entry guard, §A7.x / INV-011 (c)): if a retry timer is
   * already active, scheduling is skipped.
   *
   * Each tick re-probes Vision via the DI seam:
   *   - `vision_unloaded` → spawn the secondary (idempotent) + clear the timer.
   *   - `vision_residual` → keep retrying (reset the probe_failed streak).
   *   - `probe_failed`    → increment the 3-strike streak; on the 3rd
   *                          consecutive failure, block + clear the timer.
   * On reaching `SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS` (= 20 = ceil(10min/30s))
   * while the worker is still absent → emit `backfill_secondary_spawn_timeout`
   * + run the fallback-on-absence scan-based terminal transition (§A7.4).
   *
   * deferred secondary spawn の bounded retry を schedule する (singleton)。
   *
   * @param secondary The secondary WorkerType to spawn (`embedding-backfill`).
   */
  scheduleSecondarySpawnRetry(secondary: WorkerType): void {
    // Re-entry guard (§A7.x / INV-011 (c)): per-supervisor singleton.
    if (this.secondarySpawnRetryTimer !== null) return;
    this.secondarySpawnRetryAttempts = 0;
    this.secondarySpawnProbeFailedStreak = 0;
    this.secondarySpawnDeferredAtMs = this.nowFn();

    const timer = setInterval(() => {
      void this.runSecondarySpawnRetryTick(secondary);
    }, SECONDARY_SPAWN_RETRY_CADENCE_MS);
    // Do not keep the event loop alive solely for this timer (CWE-400 leak
    // defense layer 1; the facade shutdown clearInterval is layer 2).
    timer.unref();
    this.secondarySpawnRetryTimer = timer;
  }

  /**
   * One tick of the deferred secondary-spawn retry loop. Extracted to keep
   * {@link scheduleSecondarySpawnRetry} at CC≤10 and to be directly testable.
   *
   * retry loop の 1 tick (§A7.2-§A7.6)。
   */
  private async runSecondarySpawnRetryTick(secondary: WorkerType): Promise<void> {
    // Callback-head shutdown guard (CWE-400 leak defense, INV-011 (d)).
    if (this.supervisor.isShuttingDownNow()) {
      this.clearSecondarySpawnRetryTimer();
      return;
    }
    // If the worker became running by another path, stop retrying.
    if (this.supervisor.getStateForType(secondary) === "running") {
      this.clearSecondarySpawnRetryTimer();
      return;
    }

    this.secondarySpawnRetryAttempts += 1;

    let status: "vision_unloaded" | "vision_residual" | "probe_failed";
    try {
      status = (await this.verifyVisionUnloadFn()).status;
    } catch {
      // Probe threw — treat as a probe failure (fail-closed).
      status = "probe_failed";
    }

    if (status === "vision_unloaded") {
      // Spawn exactly once; ensureWorkerRunningForType is idempotent.
      this.supervisor.ensureWorkerRunningForType(secondary);
      this.clearSecondarySpawnRetryTimer();
      return;
    }

    if (status === "probe_failed") {
      this.secondarySpawnProbeFailedStreak += 1;
      if (this.secondarySpawnProbeFailedStreak >= SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT) {
        // §A7.6 3-strike block: emit vision_probe_unavailable + stop retrying.
        // SSOT 定数経由 (INV-AUDIT-EMIT-SSOT-IMPORT-001、bare literal hardcode 禁止)。
        // Via SSOT constant (INV-AUDIT-EMIT-SSOT-IMPORT-001; bare literal forbidden).
        emitSupervisorAuditLog(
          AUDIT_ACTION_VISION_PROBE_UNAVAILABLE,
          secondary,
          {
            attemptCount: this.secondarySpawnRetryAttempts,
            probeFailedStreak: this.secondarySpawnProbeFailedStreak,
          },
          "failure"
        );
        this.clearSecondarySpawnRetryTimer();
        return;
      }
    } else {
      // vision_residual — keep retrying; reset the probe_failed streak.
      this.secondarySpawnProbeFailedStreak = 0;
    }

    // Bounded attempt cap (CWE-770). On exhaustion with the worker still
    // absent, fail-loud + fallback-on-absence scan-based terminal (§A7.4).
    if (this.secondarySpawnRetryAttempts >= SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS) {
      await this.handleSecondarySpawnTimeout(status);
      this.clearSecondarySpawnRetryTimer();
    }
  }

  /**
   * Fallback-on-absence handling at the deferred-spawn timeout (§A7.4): emit
   * the `backfill_secondary_spawn_timeout` audit (fail-loud) and CAS-guard
   * `updateMany` all stranded overflow rows to terminal. The timer holds no
   * `webPageId` (SEC-REAUDIT-01) so the transition is a scan, not a single-row
   * update.
   *
   * **from-status 2-branch (Plan v3 §V2.1 ruling (a)-narrowed)**: the terminal
   * write is split by from-status because the recovery handler is governed by
   * the *reason value*, not just the status:
   *   - `queued`-origin (stranded by worker-absence, the verified-rescuable
   *     population) → `failed_with_known_reason` + `supervisor_restart_orphan`
   *     (recovery-IN; its handler re-enqueues unconditionally → `completed`).
   *   - `in_progress`-origin (stranded by a real vision-unload timeout) →
   *     UNCHANGED bare `failed` + `vision_unload_timeout` (recovery-OUT;
   *     SEC-REAUDIT-02 race-window cover semantics preserved).
   *
   * The time-anchor `embeddingBackfillStartedAt < now - 10min` excludes
   * in-flight (<10min) normal backfill rows from false terminalization. The two
   * branches are mutually exclusive by from-status (a row is `queued` XOR
   * `in_progress`), and the aggregate `backfill_secondary_spawn_timeout` audit
   * still records `terminalizedCount` = `queued` + `in_progress` counts.
   *
   * timeout 時の fail-loud emit + from-status 2分岐 scan-based terminal (§A7.4)。
   *
   * @param finalProbeStatus Last observed probe status (for observability).
   */
  private async handleSecondarySpawnTimeout(
    finalProbeStatus: "vision_residual" | "probe_failed"
  ): Promise<void> {
    const deferredAt = this.secondarySpawnDeferredAtMs ?? this.nowFn();
    const elapsedMs = this.nowFn() - deferredAt;
    let terminalizedCount = 0;

    try {
      const prisma = this.supervisor.getPrismaClient();
      const cutoff = new Date(this.nowFn() - VISION_UNLOAD_FINAL_TIMEOUT_MS);
      // Fallback-on-absence scan: CAS-guard updateMany split by from-status
      // (Plan v3 §V2.1 ruling (a)-narrowed). The WHERE status precondition makes
      // each branch first-writer-wins idempotent — a row already advanced by
      // child recovery drops out of the from-status set (count=0, §A7.4.2). The
      // from-status branches are mutually exclusive, so the two updateMany never
      // touch the same row; observability order is fixed (queued → in_progress).
      //
      // (1) queued-origin orphan: stranded by worker-absence (NOT vision-unload).
      //     Its true blocker is worker-absence, so the correct recovery semantics
      //     is "unconditional re-enqueue after worker recovery" — exactly the
      //     `supervisor_restart_orphan` reason whose recovery handler re-enqueues
      //     unconditionally (`backfill-recovery-reconciliation.service.ts:380-381`),
      //     driving the `completed` path. Transition to `failed_with_known_reason`
      //     (recovery-IN) so the recovery cron scan gate (status-only) picks it up.
      //     `embeddingBackfillFailedAt=now` aligns with the recovery cron's
      //     fairness ordering (`computeElapsedFromFailedAt` / `orderBy failedAt asc`).
      //
      // queued 起源の orphan は worker-absence で stranded (vision-unload ではない)。
      // 正しい recovery semantics は worker 復帰後の無条件 re-enqueue = まさに
      // `supervisor_restart_orphan` (handler が無条件 re-enqueue)。recovery cron が
      // scan する `failed_with_known_reason` に遷移させ completed 経路に乗せる。
      const queuedResult = await prisma.webPage.updateMany({
        where: {
          embeddingBackfillStatus: "queued",
          embeddingBackfillStartedAt: { lt: cutoff },
        },
        data: {
          embeddingBackfillStatus: "failed_with_known_reason",
          embeddingBackfillFailureReason: "supervisor_restart_orphan",
          embeddingBackfillFailedAt: new Date(this.nowFn()),
        },
      });

      // (2) in_progress-origin: stranded by a genuine vision-unload timeout.
      //     UNCHANGED — bare `failed` + `vision_unload_timeout` preserves the
      //     existing SEC-REAUDIT-02 race-window cover semantics (the row really
      //     did time out on vision-unload, so the reason is accurate). NOT routed
      //     into recovery (recovery-OUT), which is correct for this origin.
      //
      // in_progress 起源は真の vision-unload timeout で stranded。bare `failed` +
      // `vision_unload_timeout` を温存 (SEC-REAUDIT-02 契約不変、recovery-OUT)。
      const inProgressResult = await prisma.webPage.updateMany({
        where: {
          embeddingBackfillStatus: "in_progress",
          embeddingBackfillStartedAt: { lt: cutoff },
        },
        data: {
          embeddingBackfillStatus: "failed",
          embeddingBackfillFailureReason: "vision_unload_timeout",
        },
      });

      terminalizedCount = queuedResult.count + inProgressResult.count;
    } catch (error) {
      logger.warn("[WorkerSupervisor] secondary-spawn fallback terminal scan failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
    }

    // fail-loud emit (§A7.4.1 step 1, §A7.7). targetType=web_page, targetId is
    // null because the scan terminalizes multiple rows (not bound to one
    // webPageId). AuditLogService applies truncateAuditTargetId + sanitizeDetails.
    this.emitSecondarySpawnTimeoutAudit({
      attemptCount: this.secondarySpawnRetryAttempts,
      elapsedMs,
      finalProbeStatus,
      terminalizedCount,
    });
  }

  /**
   * Emit the `backfill_secondary_spawn_timeout` audit_logs entry via the SSOT
   * action constant (§A7.7, INV-AUDIT-EMIT-SSOT-IMPORT-001). actor =
   * `system:worker-supervisor`, targetType = `web_page`, PII-free numeric/enum
   * details only. Fire-and-forget; never throws.
   *
   * @param details PII-free numeric/enum observability details.
   */
  private emitSecondarySpawnTimeoutAudit(details: {
    attemptCount: number;
    elapsedMs: number;
    finalProbeStatus: "vision_residual" | "probe_failed";
    terminalizedCount: number;
  }): void {
    try {
      void getAuditLogService()
        .log({
          action: AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT,
          actor: AUDIT_ACTOR_WORKER_SUPERVISOR,
          targetType: "web_page",
          // Scan terminalizes multiple rows → no single webPageId. The SSOT
          // truncateAuditTargetId is applied here for the CWE-209 PII contract
          // (null → null, coalesced to undefined so the field is omitted).
          targetId: truncateAuditTargetId(null) ?? undefined,
          details,
          result: "failure",
        })
        .catch(() => {
          // AuditLogService.log() already logs its own warn on failure.
        });
    } catch {
      // DI not yet wired (some test modes) — no-op.
    }
  }

  /**
   * Clear the deferred secondary-spawn retry timer and reset its state. Layer
   * 2 of the CWE-400 timer-leak defense is the facade `shutdown()` calling
   * this; layer 1 is the callback-head `isShuttingDownNow()` guard. Idempotent.
   *
   * retry timer を clear し state を reset する (CWE-400 二重防御 layer 2)。
   */
  clearSecondarySpawnRetryTimer(): void {
    if (this.secondarySpawnRetryTimer !== null) {
      clearInterval(this.secondarySpawnRetryTimer);
      this.secondarySpawnRetryTimer = null;
    }
    this.secondarySpawnRetryAttempts = 0;
    this.secondarySpawnProbeFailedStreak = 0;
    this.secondarySpawnDeferredAtMs = null;
  }

  /**
   * Wait until the live child for `workerType` reports its first heartbeat,
   * or `timeoutMs` elapses. Resolves silently on timeout (non-fatal).
   * 子の first heartbeat 待機 — timeout 時は静かに resolve。
   */
  async waitForFirstHeartbeat(workerType: WorkerType, timeoutMs: number): Promise<void> {
    const childState = this.supervisor.getChildState(workerType);
    if (!childState) return;
    const startedAt = childState.startedAt;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.supervisor.getChildState(workerType);
      // first heartbeat = lastHeartbeatAt が startedAt から進んだ瞬間。
      if (current && current.lastHeartbeatAt > startedAt) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.warn("[WorkerSupervisor] First heartbeat timeout (continuing)", {
      workerType,
      timeoutMs,
    });
  }

  // ==========================================================================
  // Public API — graceful shutdown (3-Phase Protocol)
  // ==========================================================================

  /**
   * Per-type child shutdown — 3-Phase Protocol: IPC 'shutdown' → SIGTERM
   * (after IPC_SHUTDOWN_GRACE_MS) → SIGKILL escalation (after shutdownTimeoutMs).
   *
   * 3-Phase Protocol: IPC → SIGTERM → SIGKILL escalation per child.
   */
  async shutdownChild(workerType: WorkerType): Promise<void> {
    const childState = this.supervisor.getChildState(workerType);
    if (!childState) {
      this.supervisor.markWorkerStopped(workerType);
      return;
    }
    const workerToKill = childState.child;
    const childPid = childState.pid;
    const shutdownTimeoutMs = this.supervisor.getShutdownTimeoutMs();

    return new Promise<void>((resolve) => {
      let killTimerId: ReturnType<typeof setTimeout> | null = null;
      let sigTermTimerId: ReturnType<typeof setTimeout> | null = null;
      const onExit = (): void => {
        if (killTimerId !== null) clearTimeout(killTimerId);
        if (sigTermTimerId !== null) clearTimeout(sigTermTimerId);
        killTimerId = null;
        sigTermTimerId = null;
        this.supervisor.removeChild(workerType, childPid);
        this.supervisor.markWorkerStopped(workerType);
        resolve();
      };
      workerToKill.once("exit", onExit);
      try {
        if (workerToKill.connected && workerToKill.send) {
          workerToKill.send({ type: "shutdown" });
        }
      } catch {
        logger.warn("[WorkerSupervisor] IPC shutdown message failed (non-fatal)", { workerType });
      }
      sigTermTimerId = setTimeout(() => {
        try {
          workerToKill.kill("SIGTERM");
        } catch {
          onExit();
        }
      }, IPC_SHUTDOWN_GRACE_MS);
      killTimerId = setTimeout(() => {
        if (isDevelopment()) {
          logger.warn("[WorkerSupervisor] Shutdown timeout, sending SIGKILL", {
            workerType,
            pid: childPid,
          });
        }
        try {
          workerToKill.kill("SIGKILL");
        } catch {
          onExit();
        }
      }, shutdownTimeoutMs);
    });
  }

  // ==========================================================================
  // Spawn lifecycle (PR-D-8 §3.2.3 MF-01)
  // ==========================================================================

  /**
   * Per-type fork. PR-D-8 §3.2.3 MF-01. Establishes:
   *   - per-type env injection (`bootTokenEnv`, `childTypeEnv`) per §3.2.4 MF-03
   *   - `bindingTable` entry **before** the child can possibly send IPC
   *   - `children.set(workerType, ...)` with a fresh `WorkerChildState`
   *
   * Per-type fork (PR-D-8 §3.2.3 MF-01)。
   */
  spawnWorker(workerType: WorkerType): void {
    const config = this.supervisor.getTypeConfig(workerType);
    const bootToken = this.supervisor.getBootTokenForType(workerType);
    // PR-E-1 Option A (ADR-0011 Amendment 4 §A): lockNonce = bootToken (per-supervisor immutable). INV-007.
    const lockNonce = bootToken;
    const restartCount = this.supervisor.getRestartCountForType(workerType);

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Spawning worker", {
        workerType,
        script: config.workerScript,
        args: config.workerArgs,
        restartCount,
      });
    }

    // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — single spawn-time SSOT.
    // Capture the spawn-time ONCE here so the env var injected via
    // `buildSpawnEnv` and the `WorkerChildState.startedAt` are byte-identical.
    // The child reads the env var to use the parent's view of its spawn-time
    // when writing `worker_job_lifecycle.worker_spawn_time`, and the parent
    // uses `WorkerChildState.startedAt` when querying for orphans on exit
    // (`findOrphanWebPageIds(pid, spawnTime)`).
    //
    // UNBLOCK-T4-02 spawn-time SSOT: single capture used by both env injection
    // and parent-side state.
    const spawnTimeMs = Date.now();
    const env = this.buildSpawnEnv(workerType, spawnTimeMs);
    const maxOldSpace =
      env.WORKER_MAX_OLD_SPACE_MB ?? String(computeMemoryProfile().maxOldSpaceSizeMb);
    const execArgv = [`--max-old-space-size=${maxOldSpace}`, "--expose-gc"];

    const child = fork(config.workerScript, config.workerArgs, {
      execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      cwd: path.resolve(__dirname, "../.."),
    });

    // Establish bindingTable entry SYNCHRONOUSLY so Rule 5 IPC verification
    // never races with first-message arrival. fork() returns synchronously
    // and the child cannot have sent any IPC before we register here.
    if (child.pid !== undefined) {
      this.supervisor.bindPidToWorkerType(child.pid, workerType);
    }

    const childState: WorkerChildState = {
      child,
      workerType,
      pid: child.pid ?? -1,
      lockNonce,
      bootToken,
      jobsProcessed: 0,
      startedAt: spawnTimeMs,
      lastHeartbeatAt: spawnTimeMs,
      restartSuppressUntil: null,
    };
    this.supervisor.setChildState(workerType, childState);
    this.supervisor.markWorkerRunning(workerType);

    this.attachChildEventHandlers(workerType, child);

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Worker spawned", {
        workerType,
        pid: child.pid,
        state: "running",
      });
    }
  }

  /**
   * Build the env block for `fork()` per WorkerType. Centralises the per-type
   * env injection (PR-D-8 §3.2.4 MF-03).
   *
   * Plan v3 T4 UNBLOCK-T4-02: caller-supplied `spawnTimeMs` is injected as
   * `REFTRIX_WORKER_SPAWN_TIME_MS` so the supervisor and child share a single
   * SSOT spawn-time value (used as `worker_job_lifecycle` join key).
   *
   * Per-type env 構築 (PR-D-8 §3.2.4 MF-03)。Plan v3 T4 UNBLOCK-T4-02 で
   * `spawnTimeMs` を受取り SSOT env var として注入する。
   */
  private buildSpawnEnv(
    workerType: WorkerType,
    spawnTimeMs: number
  ): Record<string, string | undefined> {
    const config = this.supervisor.getTypeConfig(workerType);
    const env: Record<string, string | undefined> = { ...process.env };
    const legacyWorkerEnv = this.supervisor.getLegacyWorkerEnv();
    const allTypeConfigs = this.supervisor.getAllTypeConfigs();
    const allBootTokens = this.supervisor.getAllBootTokens();

    if (legacyWorkerEnv && workerType === "page") {
      // Legacy `workerEnv` only applies to the `page` WorkerType to preserve
      // pre-PR-D-8 behaviour.
      for (const [key, value] of Object.entries(legacyWorkerEnv)) {
        env[key] = value;
      }
    }

    // PR7d-2: identify fork children. PR-D-8 §3.2.4 Rule 3: legacy env var
    // continues to be set for 1-cycle backward compatibility.
    env.REFTRIX_WORKER_IS_CHILD = "1";
    env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN = allBootTokens[workerType];

    // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — spawn-time SSOT injection.
    // Supervisor captures `spawnTimeMs` once at `spawnWorker()` and injects it
    // as `REFTRIX_WORKER_SPAWN_TIME_MS` so the child uses the parent's view of
    // its own spawn-time when writing `worker_job_lifecycle.worker_spawn_time`.
    // This guarantees byte-identical join keys between the write hook
    // (`recordWorkerSpawn`) and the supervisor backfill query
    // (`findOrphanWebPageIds`) on `[workerPid, workerSpawnTime]`.
    //
    // UNBLOCK-T4-02 spawn-time SSOT env var. Supervisor view propagated to
    // child via env injection (single capture; `WorkerChildState.startedAt`
    // mirrors this value).
    //
    // UNBLOCK-V2-04 (TDA-FIND-01): use SSOT constant
    // {@link REFTRIX_WORKER_SPAWN_TIME_MS_ENV} (imported from
    // `worker-ipc-spawn-recorded.schema`) instead of a string literal so the
    // write side and the child read side share a single source of truth.
    env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV] = String(spawnTimeMs);

    // PR-D-8 §3.2.4 Rule 2 (MF-03): per-type env vars.
    // Both vars are written so `start-workers.ts` can read either depending
    // on the resolved WorkerType — harmless because each child only USES the
    // var matching its own type.
    env[allTypeConfigs.page.bootTokenEnv] = allBootTokens.page;
    env[allTypeConfigs["embedding-backfill"].bootTokenEnv] = allBootTokens["embedding-backfill"];

    // Rule 4 (MF-03): CHILD_TYPE で自己識別。
    env[config.childTypeEnv] = workerType;

    // OOM-1: glibc malloc arena 断片化を防止。
    if (!env.MALLOC_ARENA_MAX) {
      env.MALLOC_ARENA_MAX = "2";
    }
    return env;
  }

  /**
   * Attach exit / message / error / stdio handlers for a freshly forked child.
   *
   * Plan v4.5 PR3 U-5 / FIND-PLAN-TDA-PR3-01 (path-a MANDATORY): the prior
   * monolithic body (cyclomatic ~17-20) is decomposed into 3 private helpers
   * (`attachStdoutHandler` / `attachStderrHandler` / `attachExitHandler`) so
   * this orchestrating method drops to ≤10 cyclomatic. Behaviour is preserved
   * byte-for-byte — only the structure is extracted (TDA helper-extract
   * contract). `attachStderrHandler` returns the opened secondary fd so
   * `attachExitHandler` can close it on exit.
   *
   * fork 直後の子に各種 event handler を付ける helper。U-5 で 3 helper に分解
   * し cyclomatic を ≤10 に削減する (path-a MANDATORY)。
   */
  private attachChildEventHandlers(workerType: WorkerType, child: ChildProcess): void {
    this.attachStdoutHandler(workerType, child);
    const secondaryFd = this.attachStderrHandler(workerType, child);
    this.attachExitHandler(workerType, child, secondaryFd);

    // PR-D-8 §3.2.4 Rule 5 (MF-02 / SEC-IMPL-01 / SEC-IMPL-04): IPC dispatch
    // via {@link verifyWorkerIpcMessage}. Rejects schema-invalid messages,
    // workerType mismatches, and unknown senderPid; on spoofing emits
    // `worker_type_spoofing_detected` audit_logs and SIGTERMs the child.
    child.on("message", (raw: unknown) => {
      this.dispatchVerifiedIpc(raw, child.pid);
    });

    // MF-09 SEC-IMPL-05: sanitizeErrorMessage SSOT used to prevent CWE-209
    // leakage of internal stacks / token-adjacent context.
    child.on("error", (error: Error) => {
      logger.error("[WorkerSupervisor] Worker process error", {
        workerType,
        error: sanitizeErrorMessage(error),
        pid: child.pid,
      });
    });
  }

  /**
   * U-5 helper (extracted): attach the child stdout `data` handler. Logs at
   * debug level in development only. Pure side-effect, no return.
   *
   * U-5 抽出 helper: child stdout `data` handler を付ける。
   */
  private attachStdoutHandler(workerType: WorkerType, child: ChildProcess): void {
    if (!child.stdout) return;
    child.stdout.on("data", (data: Buffer) => {
      if (isDevelopment()) {
        logger.debug(`[WorkerSupervisor:${workerType}:stdout] ${data.toString().trimEnd()}`);
      }
    });
  }

  /**
   * U-5 helper (extracted): open the secondary stderr capture file (Plan v4.5
   * PR1 P0.1) and attach the child stderr `data` handler (pipe + logger.warn
   * route PRESERVED, file-fd route additive). Returns the opened fd (or null
   * when redirect is disabled / open fails) so {@link attachExitHandler} can
   * close it on exit.
   *
   * U-5 抽出 helper: secondary stderr capture を開き stderr handler を付ける。
   * 開いた fd を返し {@link attachExitHandler} が exit 時に閉じる。
   *
   * @returns The opened secondary file descriptor, or `null`.
   */
  private attachStderrHandler(workerType: WorkerType, child: ChildProcess): number | null {
    // Plan v4.5 PR1 P0.1 (Option b): secondary stderr capture via file
    // descriptor. Existing pipe + logger.warn route is PRESERVED. LCC-H-01 PII
    // sanitisation + Δ10 whitelist applied via `sanitizeStderrChunk` +
    // `openStderrFileWithPreflight`.
    const stderrConfig = loadWorkerStderrConfigOrDefault();
    let secondaryFd: number | null = null;
    if (stderrConfig.redirectEnabled && child.pid !== undefined) {
      try {
        const opened = openStderrFileWithPreflight({
          dir: stderrConfig.dir,
          workerType,
          pid: child.pid,
        });
        secondaryFd = opened.fd;
        // U-V45-PR1-07 closure: register live fd so L3 disk-pressure auto-
        // failover can close it at runtime via `closeStderrFilesForAllChildren`.
        activeChildStderrFds.set(child.pid, secondaryFd);
        if (isDevelopment() && opened.rotated) {
          logger.info("[WorkerSupervisor] stderr file rotated (L2 preflight)", {
            workerType,
            pid: child.pid,
            filePath: opened.filePath,
          });
        }
      } catch (err) {
        // Δ10 whitelist violation or unrecoverable IO — degrade gracefully to
        // pipe-only mode. Secondary capture is observability, not a hard dep.
        logger.warn("[WorkerSupervisor] stderr secondary capture disabled (non-fatal)", {
          workerType,
          error: sanitizeErrorMessage(err),
        });
        secondaryFd = null;
      }
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const message = data.toString().trimEnd();
        // Existing route (V0 prevailed): logger.warn pipe.
        logger.warn(`[WorkerSupervisor:${workerType}:stderr] ${message}`);
        // Secondary file capture (Plan v4.5 PR1 P0.1 + LCC-H-01 PII redact).
        if (secondaryFd !== null) {
          try {
            const sanitised = sanitizeStderrChunk(message);
            // Append newline so multi-event accumulation is parseable.
            fs.writeSync(secondaryFd, `${sanitised}\n`);
          } catch (err) {
            // Single-chunk write failure is non-fatal; the pipe + logger.warn
            // route still carries the same content for observability.
            if (isDevelopment()) {
              logger.warn("[WorkerSupervisor] stderr file write failed (non-fatal)", {
                workerType,
                error: sanitizeErrorMessage(err),
              });
            }
          }
        }
      });
    }
    return secondaryFd;
  }

  /**
   * U-5 helper (extracted): attach the child `exit` handlers. Closes the
   * secondary stderr fd on exit (CWE-400 resource exhaustion defense) and
   * routes the lifecycle exit into {@link handleWorkerExit}.
   *
   * U-5 抽出 helper: child `exit` handler を付ける。secondary fd を閉じ
   * exit を {@link handleWorkerExit} へ転送する。
   *
   * @param secondaryFd - Opened stderr fd (from {@link attachStderrHandler}) or null
   */
  private attachExitHandler(
    workerType: WorkerType,
    child: ChildProcess,
    secondaryFd: number | null
  ): void {
    if (secondaryFd !== null) {
      const capturedFd = secondaryFd;
      const capturedPid = child.pid;
      child.once("exit", () => {
        // U-V45-PR1-07 closure: prune registry first so
        // closeStderrFilesForAllChildren does not re-close a stale fd.
        if (capturedPid !== undefined && activeChildStderrFds.get(capturedPid) === capturedFd) {
          activeChildStderrFds.delete(capturedPid);
        }
        try {
          fs.closeSync(capturedFd);
        } catch {
          // best-effort — fd may have been closed by L3 auto-failover already;
          // EBADF on double-close is benign.
        }
      });
    }

    child.on("exit", (code: number | null, signal: string | null) => {
      this.handleWorkerExit(workerType, code, signal);
    });
  }

  // ==========================================================================
  // IPC dispatch (Rule 5)
  // ==========================================================================

  /**
   * IPC dispatch entry — verifies the message via {@link verifyWorkerIpcMessage}
   * (Rule 5 / MF-02), then routes to the appropriate per-message handler.
   *
   * Verifier failure paths emit audit_logs and on known pid escalate via
   * SIGTERM + 60s respawn suppress.
   *
   * IPC dispatch エントリ — verifier 失敗時は audit emit + SIGTERM + 60s suppress。
   */
  private dispatchVerifiedIpc(raw: unknown, senderPid: number | undefined): void {
    // verifyWorkerIpcMessage expects Map<number, WorkerType> for binding table.
    // Module A returns ReadonlyMap snapshot for callsite safety; cast preserves
    // legacy contract since verifier only reads from the map.
    const bindingTable = this.supervisor.getBindingTableSnapshot() as Map<number, WorkerType>;
    const verified = verifyWorkerIpcMessage(raw, senderPid, bindingTable);
    if (verified === null) {
      if (senderPid !== undefined && this.supervisor.getBindingTableSnapshot().has(senderPid)) {
        this.escalateSpoofing(senderPid);
      }
      return;
    }
    if (verified.type === "job-completed") {
      this.supervisor.notifyJobCompletedForType(verified.workerType);
    } else if (verified.type === "heartbeat") {
      const childState = this.supervisor.getChildState(verified.workerType);
      if (childState) childState.lastHeartbeatAt = Date.now();
    } else if (verified.type === "planned-restart-request") {
      this.initiateRestart(verified.workerType, "child_request");
    } else if (verified.type === "fatal-error") {
      logger.error("[WorkerSupervisor] Child reported fatal error", {
        workerType: verified.workerType,
        jobId: verified.jobId,
      });
      this.initiateRestart(verified.workerType, "fatal_error");
    }
  }

  /**
   * SEC-02 spoofing escalation: SIGTERM offending child + 60s respawn suppress.
   *
   * SEC-02: SIGTERM + 60s 再起動抑制 (audit_logs は verifier 側)。
   */
  private escalateSpoofing(senderPid: number): void {
    const workerType = this.supervisor.getBindingTableSnapshot().get(senderPid);
    if (!workerType) return;
    const childState = this.supervisor.getChildState(workerType);
    if (!childState) return;
    try {
      childState.child.kill("SIGTERM");
    } catch {
      /* child already gone */
    }
    childState.restartSuppressUntil = Date.now() + 60_000;
    logger.error("[WorkerSupervisor] Spoofing detected — SIGTERM + 60s suppress", {
      workerType,
      pid: senderPid,
    });
  }

  // ==========================================================================
  // Exit handling + self-chained respawn protocol
  // ==========================================================================

  /**
   * Per-type exit handler. PR-D-8 MF-04: invokes {@link executeSelfChainedRespawn}
   * before re-spawning, ensuring the exiting child's lock has been released
   * (or detected as foreign / stale).
   *
   * Per-type exit handler。`executeSelfChainedRespawn` を call し lock release
   * 完了後に respawn する。
   */
  // Plan v2 PR-C (FIND-IMPL-TDA-PR3-CC-CARRYOVER closure, UB-4): refactored to
  // CC≤10 by extracting the exited-child optional-chain reads into
  // `captureExitedChildSnapshot`. The inline `eslint-disable complexity` is
  // REMOVED so the file-scoped `complexity: ["error", 10]` gate machine-enforces
  // the bound (CI fails on regression).
  handleWorkerExit(workerType: WorkerType, code: number | null, signal: string | null): void {
    const childState = this.supervisor.getChildState(workerType);
    this.logExitEvent(workerType, code, signal);
    this.cleanupExitedChild(workerType, childState?.pid);

    if (this.supervisor.isShuttingDownNow()) {
      this.supervisor.markWorkerStopped(workerType);
      return;
    }

    // §3.2.4 Rule 5: spoofing suppression window — refuse to respawn until
    // restartSuppressUntil has elapsed.
    // childState is `WorkerChildState | null` from supervisor; coerce to `undefined`
    // to match shouldSuppressRespawn signature.
    if (this.shouldSuppressRespawn(workerType, childState ?? undefined)) {
      this.supervisor.markWorkerCrashed(workerType);
      return;
    }

    // Snapshot the exited child's identity BEFORE the respawn branch (the
    // optional-chain reads are extracted to keep this method at CC≤10).
    const snap = this.captureExitedChildSnapshot(childState);

    if (this.supervisor.isPendingRestart(workerType)) {
      this.handlePlannedRestart(
        workerType,
        code,
        signal,
        snap.exitedPid,
        snap.jobsProcessed,
        snap.exitedNonce
      );
      return;
    }
    this.handleUnexpectedExit(
      workerType,
      code,
      signal,
      snap.exitedPid,
      snap.jobsProcessed,
      snap.exitedNonce,
      snap.exitedSpawnTimeMs
    );
  }

  /**
   * Plan v2 PR-C (FIND-IMPL-TDA-PR3-CC-CARRYOVER): extract the exited-child
   * optional-chain reads from `handleWorkerExit` so the latter stays at CC≤10.
   *
   * Plan v3 T4 UNBLOCK-T4-02: `exitedSpawnTimeMs` is the spawn-time captured for
   * the `triggerOrphanBackfill` join key (`worker_pid + worker_spawn_time`) and
   * MUST be read BEFORE `cleanupExitedChild` clears the `children` Map (the
   * caller passes the pre-cleanup `childState` reference).
   */
  private captureExitedChildSnapshot(childState: WorkerChildState | null): {
    exitedPid: number | undefined;
    exitedNonce: string | undefined;
    jobsProcessed: number;
    exitedSpawnTimeMs: number | undefined;
  } {
    return {
      exitedPid: childState?.pid,
      exitedNonce: childState?.lockNonce,
      jobsProcessed: childState?.jobsProcessed ?? 0,
      exitedSpawnTimeMs: childState?.startedAt,
    };
  }

  /**
   * Emit dev-only structured log of the exit event.
   */
  private logExitEvent(workerType: WorkerType, code: number | null, signal: string | null): void {
    if (!isDevelopment()) return;
    logger.info("[WorkerSupervisor] Worker exited", {
      workerType,
      code,
      signal,
      isShuttingDown: this.supervisor.isShuttingDownNow(),
      restartCount: this.supervisor.getRestartCountForType(workerType),
      pendingRestart: this.supervisor.isPendingRestart(workerType),
    });
  }

  /**
   * Drop the exited child from `children` and `bindingTable`.
   */
  private cleanupExitedChild(workerType: WorkerType, exitedPid: number | undefined): void {
    this.supervisor.removeChild(workerType, exitedPid);
  }

  /**
   * Spoofing suppression window check.
   */
  private shouldSuppressRespawn(
    workerType: WorkerType,
    childState: WorkerChildState | undefined
  ): boolean {
    const suppressUntil = childState?.restartSuppressUntil ?? null;
    if (suppressUntil === null) return false;
    const now = Date.now();
    if (now >= suppressUntil) return false;
    logger.warn("[WorkerSupervisor] Restart suppressed due to spoofing window", {
      workerType,
      suppressRemainingMs: suppressUntil - now,
    });
    return true;
  }

  /**
   * Planned-restart path — emits audit_logs and chains into self-chained
   * respawn protocol.
   */
  private handlePlannedRestart(
    workerType: WorkerType,
    code: number | null,
    signal: string | null,
    exitedPid: number | undefined,
    jobsProcessed: number,
    exitedNonce: string | undefined
  ): void {
    this.supervisor.clearPendingRestart(workerType);
    this.supervisor.resetRestartCount(workerType);
    // MF-08 LCC-IMPL-01: audit_logs emit for planned restart.
    emitWorkerRestartAudit(
      workerType,
      "planned",
      jobsProcessed,
      code,
      signal,
      exitedPid,
      this.supervisor.getRestartCountForType(workerType),
      "success"
    );
    void this.runSelfChainedRespawnAndSchedule(workerType, exitedNonce);
  }

  /**
   * Unexpected-exit path — applies maxRestartAttempts gate and emits the
   * matching audit_logs entry (success vs failure).
   *
   * Plan v3 Track T4 (PR-V3-T4) Contract 2: forward `code + signal + pid` to
   * the failure-path service via {@link triggerOrphanBackfill} for the true
   * orphan path (SIGKILL / OOM / segfault) so `web_pages.failed_with_known_reason`
   * gets backfilled and one paired audit_log entry committed before any
   * cleanup cron deletes the row (LCC H-02 atomicity invariant).
   */
  private handleUnexpectedExit(
    workerType: WorkerType,
    code: number | null,
    signal: string | null,
    exitedPid: number | undefined,
    jobsProcessed: number,
    exitedNonce: string | undefined,
    exitedSpawnTimeMs: number | undefined
  ): void {
    // Plan v3 T4 Contract 2: trigger supervisor backfill for true orphans.
    // Fire-and-forget; failure-path service is fully fail-tolerant and never
    // throws. Re-uses Module B → Module A → Module C indirect path policy.
    //
    // UNBLOCK-T4-02 closure: forward exitedSpawnTimeMs (from WorkerChildState
    // .startedAt) so the supervisor backfill query joins on the correct
    // `worker_pid + worker_spawn_time` pair (INV-WORKER-PID-IDENTITY-005 Sub-C).
    void this.triggerOrphanBackfill(workerType, exitedPid, signal, exitedSpawnTimeMs);
    // Fix-3 (INFRA-EMBEDDING-MOTION-SIGABRT-001): SIGABRT detection + suppress.
    const sigabrtSuppress = processSigabrtSignal(
      workerType,
      signal,
      exitedPid,
      this.supervisor.getSigabrtCountByWorkerType(),
      this.supervisor.getLastSigabrtAuditByWorkerType()
    );
    const restartCount = this.supervisor.getRestartCountForType(workerType);
    const maxRestartAttempts = this.supervisor.getMaxRestartAttempts();
    if (restartCount >= maxRestartAttempts) {
      logger.error("[WorkerSupervisor] Max restart attempts reached, giving up", {
        workerType,
        restartCount,
        maxRestartAttempts,
        lastExitCode: code,
        lastSignal: signal,
      });
      this.supervisor.markWorkerCrashed(workerType);
      // PR-E-1 NF-6 (CWE-770): clear lock heartbeat timer on crashed entry.
      // Module B → Module A → Module C indirect path (no direct Module C import).
      clearLockHeartbeatTimer(
        workerType,
        this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()
      );
      emitWorkerRestartAudit(
        workerType,
        "crash_max_attempts",
        jobsProcessed,
        code,
        signal,
        exitedPid,
        restartCount,
        "failure"
      );
      return;
    }
    this.supervisor.incrementRestartCount(workerType);
    emitWorkerRestartAudit(
      workerType,
      "unexpected_exit",
      jobsProcessed,
      code,
      signal,
      exitedPid,
      this.supervisor.getRestartCountForType(workerType),
      "success"
    );
    // Fix-3: gate respawn behind a 60s suppress timer on N consecutive SIGABRTs.
    scheduleSigabrtAwareRespawn(
      sigabrtSuppress,
      () => this.supervisor.isShuttingDownNow(),
      () => void this.runSelfChainedRespawnAndSchedule(workerType, exitedNonce)
    );
  }

  /**
   * Run the self-chained respawn protocol (MF-04 / SEC-IMPL-03) and schedule
   * the actual respawn based on its outcome.
   */
  private async runSelfChainedRespawnAndSchedule(
    workerType: WorkerType,
    exitedNonce: string | undefined
  ): Promise<void> {
    this.supervisor.markWorkerRestarting(workerType);
    this.supervisor.resetCompletedJobCount(workerType);

    // If we never had a valid nonce (child died before WorkerChildState was
    // populated) we cannot run release; just delegate to the per-type delay.
    // Plan v4.3 PR-M-A: `embedding-backfill` uses 8000ms cooldown (env
    // overridable via `EMBEDDING_BACKFILL_RESTART_DELAY_MS`); `page` retains
    // legacy 3000ms (Plan v4.1 CWE-770 boundary).
    if (!exitedNonce) {
      this.scheduleRespawn(workerType, this.supervisor.getRestartDelayMs(workerType));
      return;
    }

    // Module B → Module A → Module C indirect path for lock service access.
    const lockService = this.supervisor.getLockOrchestrator().ensureLockServiceInstance();
    if (!lockService) {
      this.scheduleRespawn(workerType, this.supervisor.getRestartDelayMs(workerType));
      return;
    }

    let outcome: Awaited<ReturnType<typeof executeSelfChainedRespawn>>;
    try {
      outcome = await executeSelfChainedRespawn(lockService, workerType, exitedNonce);
    } catch (error) {
      logger.warn("[WorkerSupervisor] executeSelfChainedRespawn threw (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      outcome = "probe_failed";
    }

    switch (outcome) {
      case "released":
      case "probe_failed":
        // Plan v4.3 PR-M-A: per-type cooldown via instance method
        // `getRestartDelayMs(workerType)`, which delegates to the module-level
        // canonical helper `getRestartDelayMsForType(workerType)` (ADR-0035
        // §Decision 3). Module B preserves the type-only import boundary by
        // routing through the Module A facade rather than importing the helper
        // directly (PR-M Phase 2 Step 6 refinement preserves the design edge).
        this.scheduleRespawn(workerType, this.supervisor.getRestartDelayMs(workerType));
        break;
      case "ttl_fallback":
        // 60s natural expiry wait (TTL_FALLBACK_MS in plan §3.2.5).
        // Plan v4.3 PR-M-A: TTL-fallback path is invariant (60_000ms hardcoded)
        // — per-type cooldown does NOT apply here because the 60s window is the
        // natural Redis lock TTL expiry, not a configurable restart delay.
        this.scheduleRespawn(workerType, 60_000);
        break;
      case "foreign_lock":
        // Foreign owner — fail-closed; do not respawn this type.
        logger.error("[WorkerSupervisor] Foreign lock detected — refusing respawn", { workerType });
        this.supervisor.markWorkerCrashed(workerType);
        clearLockHeartbeatTimer(
          workerType,
          this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()
        );
        break;
      default:
        // Unreachable; fall back to per-type delay.
        // Plan v4.3 PR-M-A: per-type cooldown via instance method
        // `getRestartDelayMs(workerType)`, which delegates to the module-level
        // canonical helper `getRestartDelayMsForType(workerType)` (ADR-0035
        // §Decision 3). Module B preserves the type-only import boundary by
        // routing through the Module A facade rather than importing the helper
        // directly (PR-M Phase 2 Step 6 refinement preserves the design edge).
        this.scheduleRespawn(workerType, this.supervisor.getRestartDelayMs(workerType));
    }
  }

  /**
   * Calculate restart delay deterministically per-type and re-spawn after the
   * timeout. shutdown 中なら respawn しない。
   */
  private scheduleRespawn(workerType: WorkerType, delayMs: number): void {
    this.supervisor.markWorkerRestarting(workerType);
    setTimeout(() => {
      if (this.supervisor.isShuttingDownNow()) {
        this.supervisor.markWorkerStopped(workerType);
        return;
      }
      this.spawnWorker(workerType);
    }, delayMs);
  }

  // ==========================================================================
  // Initiated restart (3-Phase IPC → SIGTERM → SIGKILL)
  // ==========================================================================

  /**
   * Per-type initiateRestart. PR-D-8 MF-08: emits `worker_supervisor_restart`
   * audit_log indirectly via {@link handleWorkerExit} after the actual exit
   * arrives; here we only set `pendingRestart` + send IPC shutdown.
   *
   * Per-type initiateRestart。`pendingRestart` フラグをセットし IPC shutdown 送信。
   */
  initiateRestart(workerType: WorkerType, reason: string): void {
    const childState = this.supervisor.getChildState(workerType);
    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Initiating restart", {
        workerType,
        reason,
        completedJobCount: this.supervisor.getCompletedJobCountForType(workerType),
      });
    }
    if (!childState) return;

    this.supervisor.markWorkerRestarting(workerType);
    this.supervisor.setPendingRestart(workerType);
    const workerToRestart = childState.child;
    const childPid = childState.pid;
    const shutdownTimeoutMs = this.supervisor.getShutdownTimeoutMs();

    try {
      if (workerToRestart.connected && workerToRestart.send) {
        workerToRestart.send({ type: "shutdown" });
      }
    } catch {
      logger.warn("[WorkerSupervisor] IPC shutdown message failed during restart (non-fatal)", {
        workerType,
      });
    }

    const sigTermTimerId = setTimeout(() => {
      try {
        workerToRestart.kill("SIGTERM");
      } catch {
        /* exit handler will handle */
      }
    }, IPC_SHUTDOWN_GRACE_MS);

    const killTimerId = setTimeout(() => {
      if (isDevelopment()) {
        logger.warn("[WorkerSupervisor] Restart shutdown timeout, sending SIGKILL", {
          workerType,
          pid: childPid,
        });
      }
      try {
        workerToRestart.kill("SIGKILL");
      } catch {
        /* exit handler will handle */
      }
    }, shutdownTimeoutMs);

    workerToRestart.once("exit", () => {
      clearTimeout(sigTermTimerId);
      clearTimeout(killTimerId);
    });
  }

  // ==========================================================================
  // Plan v3 Track T4 (PR-V3-T4) — Contract 2: supervisor orphan backfill
  // ==========================================================================

  /**
   * Trigger supervisor orphan backfill for the failure-path service. Called
   * from {@link handleUnexpectedExit} when a child exits unexpectedly. Lazy
   * imports the failure-path service + Prisma client to avoid the runtime
   * cycle that the Module B → Module A type-only import boundary
   * structurally rejects (INV-WORKER-LIFECYCLE-RESPONSIBILITY-001 AST gate).
   *
   * Fire-and-forget; never throws. The failure-path service is fully
   * fail-tolerant and degrades to a no-op when Prisma / Redis is unavailable.
   *
   * Plan v3 T4 Contract 2 — fire-and-forget supervisor backfill trigger.
   *
   * @param workerType - Exited child's WorkerType
   * @param exitedPid - Exited child's PID (undefined when state already cleaned)
   * @param exitSignal - Exit signal name (SIGKILL / SIGABRT / etc.) or null
   */
  private async triggerOrphanBackfill(
    workerType: WorkerType,
    exitedPid: number | undefined,
    exitSignal: string | null,
    exitedSpawnTimeMs: number | undefined
  ): Promise<void> {
    if (exitedPid === undefined) return;

    try {
      // Module B → Module A → Module C indirect path for lock service.
      const lockService = this.supervisor.getLockOrchestrator().ensureLockServiceInstance();
      if (!lockService) {
        if (isDevelopment()) {
          logger.warn("[WorkerSupervisor] orphan backfill skipped — lock service unavailable", {
            workerType,
          });
        }
        return;
      }

      // Plan v3 T4 UNBLOCK-T4-02: spawnTime is now the supervisor's recorded
      // `WorkerChildState.startedAt` value (forwarded by `handleUnexpectedExit`).
      // The legacy `new Date()` placeholder has been removed — orphan rows
      // recorded by `recordWorkerSpawn` (Module B `spawnWorker()`) resolve via
      // the index `[workerPid, workerSpawnTime]` join key. When the supervisor
      // does not have the spawn-time (childState already cleaned), we skip the
      // backfill rather than emit a wrong join key.
      //
      // UNBLOCK-T4-02 closure: spawnTime SSOT = WorkerChildState.startedAt
      // forwarded from handleUnexpectedExit; no `new Date()` placeholder.
      if (exitedSpawnTimeMs === undefined) {
        if (isDevelopment()) {
          logger.warn(
            "[WorkerSupervisor] orphan backfill skipped — exited spawn-time unavailable",
            { workerType, exitedPid }
          );
        }
        return;
      }
      const exitedSpawnTime = new Date(exitedSpawnTimeMs);

      // UNBLOCK-T4-04 DI lift: consume Prisma via Module A facade accessor.
      const prismaClient = this.supervisor.getPrismaClient();

      await handleChildExitOrBackfill(
        prismaClient as never,
        lockService,
        {
          workerType,
          exitedChildPid: exitedPid,
          exitedChildSpawnTime: exitedSpawnTime,
          lastAnalyzedPhases: new Map(),
          ...(exitSignal !== null ? { exitSignal } : {}),
        },
        emitOrphanBackfillSkippedAudit
      );
    } catch (error) {
      logger.warn("[WorkerSupervisor] triggerOrphanBackfill failed (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
    }
  }
}

// ============================================================================
// Re-exports retained for completeness (consumed by Module A facade)
// ============================================================================

export type {
  WorkerChildState,
  WorkerState,
  WorkerSupervisorOptions,
  WorkerTypeConfig,
  WorkerType,
};
export { WORKER_TYPES };
