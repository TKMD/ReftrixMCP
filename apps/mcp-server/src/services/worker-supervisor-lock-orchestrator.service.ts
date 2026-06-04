// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor — Lock Orchestrator Module (Module C)
 *
 * Redis active-worker lock orchestration extracted from `worker-supervisor.service.ts`
 * per CO-26 split design Phase 2 Step 5 (PR-V3-CO-26-SPLIT). Mechanical extraction —
 * zero behaviour change; preserves ADR-0011 INV-WORKER-LOCK-003 family contracts
 * (Redis dual-run lock + UUID nonce + 60s TTL + 30s heartbeat + Lua atomic
 * release/extend) and ADR-0011 Amendment 5 §A5.1 retry orchestration.
 *
 * Module C ownership (SEC FIND-M-02 + TDA + TPA 4-way unanimous):
 *   - `lockAcquired: Map<WorkerType, boolean>` — per-type acquired state
 *   - `lockHeartbeatTimers: Map<WorkerType, ReturnType<typeof setInterval>>` — per-type heartbeat timers
 *   - `lockAcquireInflight: Map<WorkerType, boolean>` — inflight flag (CWE-820 race window mitigation)
 *
 * Module C does NOT register `process.on('exit')` hooks (SEC L-03 advisory).
 * Module C MUST NOT directly import Module B (lifecycle); cross-module callables
 * traverse the Module A facade via `this.supervisor.getLifecycle()` indirect path
 * (TPA-01 explicit state-sharing accessor pattern).
 *
 * Module C は Module A の WorkerSupervisor facade を介してのみ Module B と通信する。
 * 直接 import は構造的に禁止 (INV-WORKER-LOCK-RESPONSIBILITY-001 AST gate)。
 *
 * @see  §3.1 Module C
 * @see ADR-0011 (Worker Dual-run Prevention) — INV-WORKER-LOCK-003 family
 * @see ADR-0011 Amendment 5 §A5.1 — discriminated union API + retry orchestration
 * @module services/worker-supervisor-lock-orchestrator
 */

import { LOCK_HEARTBEAT_INTERVAL_MS } from "./worker-active-lock.service";
import type { WorkerActiveLockService } from "./worker-active-lock.service";
import { runAcquireLockWithRetryOrchestrator } from "./worker-supervisor-helpers";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { logger, isDevelopment } from "../utils/logger";
import { WORKER_TYPES, type WorkerType } from "../types/worker-type";
// Type-only import to avoid runtime cycle (Module C → Module A is type-only).
// type-only import で runtime cycle を回避 (Module C → Module A は型のみ参照)。
import type { WorkerSupervisor } from "./worker-supervisor.service";

/**
 * Lock service factory accessor — abstracts Module A's DI factory boundary so
 * Module C does not import Module A's runtime symbols. The Module A facade
 * passes a closure that resolves `instantiateLockServiceForSupervisor()` at
 * call time, preserving the test-injection contract from
 * `setWorkerSupervisorLockServiceFactory`.
 *
 * Module A の DI factory 境界を抽象化するアクセサ。
 */
export type LockServiceInstantiator = () => WorkerActiveLockService;

/**
 * Per-type Redis lock orchestrator. Owns lock state Maps (acquired / inflight /
 * heartbeat timers) and provides the 4 lifecycle methods exposed to Module A:
 *
 *   - {@link ensureLockServiceInstance}  — lazy init (NODE_ENV=test short-circuit)
 *   - {@link acquireRedisLockBestEffort} — best-effort retry orchestration
 *   - {@link startLockHeartbeat}         — per-type heartbeat interval timer
 *   - {@link releaseRedisLockBestEffort} — selective service close on shutdown
 *
 * Mechanical extraction from `WorkerSupervisor` class (CO-26 design §2.2 group J).
 *
 * Per-type Redis lock orchestrator。`WorkerSupervisor` class の lock 関連
 * method group J を mechanical 抽出。
 */
export class WorkerSupervisorLockOrchestrator {
  /**
   * Live `WorkerActiveLockService` instance (lazy-init). Set on first
   * successful `ensureLockServiceInstance()` call; cleared on
   * `releaseRedisLockBestEffort` when last heartbeat closes.
   */
  private lockService: WorkerActiveLockService | null = null;

  /** Per-type acquired flag (true = caller owns the Redis lock). */
  private readonly lockAcquired: Map<WorkerType, boolean> = new Map();

  /** Per-type heartbeat interval timers (refresh Redis TTL). */
  private readonly lockHeartbeatTimers: Map<WorkerType, ReturnType<typeof setInterval>> = new Map();

  /**
   * Per-type inflight flag (CWE-820 race window mitigation per SEC FIND-M-02).
   * Module C owns this Map so set/check pair never crosses class boundary,
   * structurally eliminating the race window between `acquireLockInflight.get()`
   * and `acquireLockInflight.set(true)`.
   *
   * SEC FIND-M-02 (CWE-820) 軽減: Module C 自身が Map を保持することで
   * set/check pair の class boundary 越えを排除し race window を構造的に消滅。
   */
  private readonly lockAcquireInflight: Map<WorkerType, boolean> = new Map();

  /**
   * Per-type bootTokens reference (held as constructor parameter — Module A's
   * authoritative source). `lockNonce = bootToken` per PR-E-1 Option A
   * (ADR-0011 Amendment 4 §A) / INV-WORKER-RESPAWN-LOCK-NONCE-007.
   */
  private readonly bootTokens: Record<WorkerType, string>;

  /**
   * Lock service instantiator — closure injected by Module A facade to honour
   * the test-injection contract (`setWorkerSupervisorLockServiceFactory`).
   */
  private readonly instantiateLockService: LockServiceInstantiator;

  /**
   * Module A facade reference — used only for cross-module indirect path
   * (currently unused inside Module C but reserved for future B → A → C calls).
   *
   * @internal Reserved for explicit state-sharing accessor pattern (TPA-01).
   */
  // @ts-expect-error — supervisor reference reserved for future cross-module indirect path
  // (CO-26 design §3.2.1). Currently unused inside Module C to keep this PR mechanical.
  private readonly supervisor: WorkerSupervisor;

  constructor(
    supervisor: WorkerSupervisor,
    bootTokens: Record<WorkerType, string>,
    instantiateLockService: LockServiceInstantiator
  ) {
    this.supervisor = supervisor;
    this.bootTokens = bootTokens;
    this.instantiateLockService = instantiateLockService;
    for (const workerType of WORKER_TYPES) {
      this.lockAcquired.set(workerType, false);
      this.lockAcquireInflight.set(workerType, false);
    }
  }

  /**
   * @internal Test/diagnostic accessor for `lockHeartbeatTimers` Map. Used by
   * Module B's `handleUnexpectedExit` / `runSelfChainedRespawnAndSchedule`
   * crashed-entry paths via `clearLockHeartbeatTimer(workerType, timers)`
   * helper (PR-E-1 NF-6 / CWE-770 mitigation). Indirect path: Module B accesses
   * via `this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()`.
   *
   * Module B の crashed-entry 経路で `clearLockHeartbeatTimer` helper に渡す
   * ため Module A facade 経由で取得される。
   */
  getLockHeartbeatTimers(): Map<WorkerType, ReturnType<typeof setInterval>> {
    return this.lockHeartbeatTimers;
  }

  /**
   * Lazy `WorkerActiveLockService` initialisation. Returns null on
   * NODE_ENV=test short-circuit (preserved byte-for-byte from legacy
   * `worker-supervisor.service.ts` per SEC FIND-M-02 ruling) or on
   * instantiation failure (best-effort).
   *
   * 遅延初期化。NODE_ENV=test では null を返す (legacy 挙動を完全保持)。
   */
  ensureLockServiceInstance(): WorkerActiveLockService | null {
    if (this.lockService) return this.lockService;
    if (process.env.NODE_ENV === "test") return null;
    try {
      this.lockService = this.instantiateLockService();
      return this.lockService;
    } catch (error) {
      logger.warn("[WorkerSupervisor] Lock service init failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Per-type Redis lock acquisition. Best-effort. Item 3 (CO-31) / ADR-0011
   * Amendment 5 §A5.1: retry orchestration is delegated to
   * {@link runAcquireLockWithRetryOrchestrator} which consumes
   * `tryAcquireLock` discriminated union and retries `redis_unavailable` on
   * 100/200/400ms backoff (max 3, 700ms total).
   *
   * Best-effort 取得。retry は helper に委譲 (ADR-0011 Amendment 5 §A5.1)。
   */
  acquireRedisLockBestEffort(workerType: WorkerType): void {
    if (this.lockAcquired.get(workerType)) return;
    if (this.lockAcquireInflight.get(workerType)) return;
    if (process.env.NODE_ENV === "test") return;
    const lockService = this.ensureLockServiceInstance();
    if (!lockService) return;
    this.lockAcquireInflight.set(workerType, true);
    runAcquireLockWithRetryOrchestrator(lockService, workerType, this.bootTokens[workerType], {
      onAcquired: () => {
        this.lockAcquired.set(workerType, true);
        this.startLockHeartbeat(workerType);
        if (isDevelopment()) {
          logger.info("[WorkerSupervisor] Published active-worker lock to Redis", { workerType });
        }
      },
      onHeldByOther: () => {
        logger.warn("[WorkerSupervisor] active-worker lock held by another owner", { workerType });
      },
      onExhausted: () => {
        logger.warn("[WorkerSupervisor] acquireLock exhausted (fail-open final)", { workerType });
      },
      onError: (error) => {
        logger.warn("[WorkerSupervisor] acquireLock failed (non-fatal)", {
          workerType,
          error: sanitizeErrorMessage(error),
        });
      },
      onSettled: () => this.lockAcquireInflight.set(workerType, false),
    });
  }

  /**
   * Per-type heartbeat to refresh the Redis TTL (LOCK_HEARTBEAT_INTERVAL_MS,
   * 30s default per ADR-0011). Idempotent — no-op when timer already
   * registered or `lockService` not yet initialised.
   *
   * Per-type heartbeat (Redis TTL 延長)。冪等。
   */
  startLockHeartbeat(workerType: WorkerType): void {
    if (this.lockHeartbeatTimers.has(workerType) || !this.lockService) return;
    const timer = setInterval(() => {
      if (!this.lockService) return;
      void this.lockService.extendLock(workerType, this.bootTokens[workerType]).catch(() => {
        /* non-fatal */
      });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.lockHeartbeatTimers.set(workerType, timer);
  }

  /**
   * Per-type Redis lock release on shutdown. Best-effort: error path emits
   * structured log + metric (A5 anti-pattern compliance — never silently
   * swallow). Selective service close: only close shared `WorkerActiveLockService`
   * instance when no other type still owns a heartbeat (multi-type tenant safety).
   *
   * Per-type Redis lock release (shutdown 時)。他 type が heartbeat 継続中なら
   * service close しない (multi-type tenant safety)。
   */
  async releaseRedisLockBestEffort(workerType: WorkerType): Promise<void> {
    const heartbeatTimer = this.lockHeartbeatTimers.get(workerType);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      this.lockHeartbeatTimers.delete(workerType);
    }
    if (!this.lockService) return;
    try {
      if (this.lockAcquired.get(workerType)) {
        await this.lockService.releaseLock(workerType, this.bootTokens[workerType]);
      }
    } catch {
      /* best-effort */
    }
    this.lockAcquired.set(workerType, false);

    // Close service only when no other type still owns a heartbeat.
    // 他 type が heartbeat 継続中なら service close しない。
    if (this.lockHeartbeatTimers.size === 0) {
      try {
        await this.lockService.close();
      } catch {
        /* best-effort */
      }
      this.lockService = null;
    }
  }
}
