// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor — Helper functions (extracted to keep
 * `worker-supervisor.service.ts` under the 1500-line ESLint cap).
 *
 * PR-D-8 Phase 2 re-implementation (TDA-V11-02):
 *   - `buildDefaultWorkerTypeConfigs` — per-type default configuration map
 *   - `cliFlagForWorkerType` — WorkerType → CLI flag derivation
 *   - `emitSupervisorAuditLog` — GDPR Art.30 audit_logs emission helper
 *   - `executeSelfChainedRespawn` — §3.2.5 3-layer respawn protocol (SEC-01 H 🚫)
 *   - `verifyWorkerIpcMessage` — §3.2.4 Rule 5 IPC verification (SEC-IMPL-01 🚫)
 *
 * @module services/worker-supervisor-helpers
 */

import { randomUUID } from "node:crypto";
import { getAuditLogService } from "./audit-log.service";
import { parseWorkerIpcStrict, type WorkerIpcMessage } from "../schemas/worker-ipc.schema";
import { assertNeverWorkerType, type WorkerType } from "../types/worker-type";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import type { AcquireLockResult, WorkerActiveLockService } from "./worker-active-lock.service";
import type { WorkerTypeConfig } from "./worker-supervisor.service";

// ============================================================================
// Item 3 (CO-31) — Acquire-side retry-with-backoff outcome (3-state)
// ============================================================================

/**
 * Discriminated outcome of {@link tryAcquireLockWithRetry}. Caller-facing
 * 3-state derived from {@link AcquireLockResult} `ok` / `already_held` /
 * `redis_unavailable` plus retry-budget exhaustion.
 *
 * - `acquired`   : lock acquired (possibly after one or more transient retries).
 *                  `nonce` is echoed back for downstream release / heartbeat.
 * - `held_by_other`: legitimate race-lost (`already_held` from underlying API),
 *                  no retry was performed.
 * - `exhausted`  : retry budget consumed on transient `redis_unavailable`.
 *                  Caller MUST treat as fail-open final (existing contract).
 *
 * `tryAcquireLockWithRetry` の 3-state caller-facing outcome。
 * `acquired` / `held_by_other` / `exhausted` の 3 値で
 * `AcquireLockResult` (`ok` / `already_held` / `redis_unavailable`) +
 * retry budget exhaustion を caller 視点に集約する。
 *
 * @see ADR-0011 Amendment 5 §A5.1 (Acquire-side retry-with-backoff contract)
 */
export type AcquireLockWithRetryOutcome =
  | { ok: true; reason: "acquired"; nonce: string }
  | { ok: false; reason: "held_by_other" }
  | { ok: false; reason: "exhausted" };

// ============================================================================
// Internal — env parser
// ============================================================================

/**
 * 環境変数を安全にパースする（SEC監査 Medium #1 対応）
 * NaN、0以下の値はデフォルトにフォールバックする。
 *
 * Internal duplicate of the supervisor's `safeParseInt`. Kept private to this
 * helper module to avoid circular imports back into `worker-supervisor.service`.
 *
 * `worker-supervisor.service` への循環 import を避けるため private 複製。
 */
function safeParseInt(value: string | undefined, defaultValue: number, min: number = 1): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return defaultValue;
  return parsed;
}

// ============================================================================
// PR-D-8 §3.2.3 — Per-type default config map
// ============================================================================

/**
 * Build the default per-{@link WorkerType} config map. Used at supervisor
 * construction when no explicit config is provided.
 *
 * Plan v1.1 §3.2.3 per-type defaults:
 *   - `page`: primary, `maxJobsBeforeRestart=1`, env `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE`
 *   - `embedding-backfill`: secondary, `maxJobsBeforeRestart=3` (env-tunable),
 *     env `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_BACKFILL`
 */
export function buildDefaultWorkerTypeConfigs(
  workerScript: string
): Record<WorkerType, WorkerTypeConfig> {
  return {
    page: {
      workerScript,
      workerArgs: ["--page"],
      maxJobsBeforeRestart: safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1),
      rssKillDeltaMB: safeParseInt(process.env.WORKER_RSS_KILL_DELTA_MB, 4096, 1),
      bootTokenEnv: "REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE",
      childTypeEnv: "REFTRIX_WORKER_CHILD_TYPE",
      schedulingPriority: "primary",
    },
    "embedding-backfill": {
      workerScript,
      workerArgs: ["--backfill"],
      maxJobsBeforeRestart: safeParseInt(process.env.EMBEDDING_BACKFILL_MAX_JOBS_BEFORE_RESTART, 3),
      rssKillDeltaMB: safeParseInt(process.env.WORKER_RSS_KILL_DELTA_MB, 4096, 1),
      bootTokenEnv: "REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_BACKFILL",
      childTypeEnv: "REFTRIX_WORKER_CHILD_TYPE",
      schedulingPriority: "secondary",
    },
  };
}

/**
 * Derive the CLI flag (`--page` / `--backfill`) from a WorkerType.
 *
 * WorkerType → CLI flag 変換。`assertNeverWorkerType` で新 WorkerType 追加時に
 * コンパイルエラー化する。
 */
export function cliFlagForWorkerType(workerType: WorkerType): string {
  switch (workerType) {
    case "page":
      return "--page";
    case "embedding-backfill":
      return "--backfill";
    default:
      return assertNeverWorkerType(workerType);
  }
}

// ============================================================================
// PR-D-8 §3.2.4 Rule 6 / SEC-V11-01 M — Boot-token log-prohibition contract
// (contract comment only; enforcement test in tests/regression/standing/).
// ============================================================================

/**
 * **CONTRACT (HARD INVARIANT)**: Boot tokens (raw UUID values generated via
 * `randomUUID()` and held in `bootToken` / `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_*`
 * env vars) MUST NEVER appear in any log line / `logger.*` output /
 * `console.*` output / `process.env` dump / `sanitizeErrorMessage` output.
 *
 * **WHY**: log aggregation platforms (Loki, Datadog, CloudWatch, ELK) often
 * ingest stdout/stderr. A leaked boot token enables replay attack:
 * an attacker who obtains a token can forge IPC messages that bypass
 * supervisor's `Map<pid, WorkerType>` binding check (§3.2.4 Rule 5)
 * because `randomUUID()` collision is infeasible — the token IS the
 * per-type authenticator. CWE-209 (Info exposure via error message) +
 * CWE-532 (Info exposure via log file).
 *
 * **ENFORCEMENT**: verified by standing-regression test case #12
 * (SEC-V11-01) which spies on `logger.*` and `console.*` at every code
 * path that touches boot-token env vars and asserts NO log line contains
 * `BOOT_TOKEN_` values.
 *
 * Boot token ログ禁止契約。ログ集約基盤に流出すると replay attack 可能。
 * Rule 5 の `Map<pid, WorkerType>` 検証が破られるリスクを回避するため。
 */
// NOTE: Intentionally empty — this is a contract comment.

// ============================================================================
// LCC-02 — GDPR Art.30 audit_logs emission helper
// ============================================================================

/**
 * LCC-02 GDPR Art.30 audit_logs emission for supervisor lifecycle events.
 *
 * Fire-and-forget; never throws. Audit log write failures are non-fatal
 * per AuditLogService's existing contract.
 *
 * @param action - audit log action (e.g. `worker_supervisor_restart`)
 * @param workerType - affected WorkerType
 * @param details - sanitized context (boot tokens MUST NOT appear here)
 * @param result - `success` | `failure` | `denied`
 */
export function emitSupervisorAuditLog(
  action: string,
  workerType: WorkerType,
  details: Record<string, unknown>,
  result: "success" | "failure" | "denied"
): void {
  try {
    void getAuditLogService()
      .log({
        action,
        actor: "system:worker-supervisor",
        targetType: "worker",
        targetId: workerType,
        details,
        result,
      })
      .catch(() => {
        // AuditLogService.log() already logs its own warn on failure.
      });
  } catch {
    // DI not yet wired (e.g. some test modes) — no-op.
  }
}

// ============================================================================
// SEC-01 — Self-chained respawn protocol (3-layer defense)
// ============================================================================

/**
 * Sleep helper for backoff loops. Returns a Promise that resolves after
 * `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PR-D-8 §3.2.5 self-chained respawn protocol (SEC-01 H 🚫 resolution).
 *
 * 3-layer defense for the CWE-362 TOCTOU + CWE-667 race where a child's
 * `releaseLock()` fails transiently (Redis disconnect / race), leaving a
 * stale lock that would otherwise cause the child-N+1 spawn to falsely
 * report "another owner holds the lock".
 *
 * Protocol:
 *   Layer 1 — `releaseLock()` with 3-retry exponential backoff (100/200/400ms)
 *   Layer 2 — `probeExistingLock` absent-verification: if lock still present,
 *             check whether it's our own stale lock (nonce match → fall to
 *             Layer 3) or a foreign lock (fail-closed, abort respawn)
 *   Layer 3 — 60s TTL fallback: wait for natural expiry and emit
 *             `worker_lock_ttl_fallback` audit_logs entry
 *
 * @param lockService - Active lock service (must accept WorkerType)
 * @param workerType - WorkerType whose lock is being released
 * @param nonce - Lock nonce owned by the exiting child
 * @param retryBudget - Max releaseLock attempts (default 3, env-tunable)
 * @returns Discriminated outcome: `released` (OK to respawn immediately),
 *   `tll_fallback` (wait 60s then respawn), `foreign_lock` (abort respawn),
 *   `probe_failed` (delay respawn, Redis unreachable)
 */
export async function executeSelfChainedRespawn(
  lockService: WorkerActiveLockService,
  workerType: WorkerType,
  nonce: string,
  retryBudget: number = 3
): Promise<"released" | "ttl_fallback" | "foreign_lock" | "probe_failed"> {
  // Layer 1: releaseLock with exponential backoff (100/200/400ms).
  const released = await tryReleaseLockWithRetry(lockService, workerType, nonce, retryBudget);
  if (released) return "released";

  // Layer 2: probe to determine whether the lock is still held and by whom.
  const probe = await lockService.probeExistingLock(workerType);
  if (probe.unavailable) {
    logger.warn("[respawn] probe failed, delaying respawn", { workerType });
    return "probe_failed";
  }
  if (!probe.exists) {
    // Lock was released after our retries; safe to respawn.
    return "released";
  }
  // Lock still held — who owns it?
  if (probe.nonce === nonce) {
    // Our own stale lock — fall to Layer 3 TTL fallback.
    // Note: we do NOT log the raw nonce (SEC-V11-01 Rule 6); use a structured
    // sentinel event instead.
    logger.warn("[respawn] stale self-lock detected, falling back to TTL wait", {
      workerType,
    });
    emitSupervisorAuditLog(
      "worker_lock_ttl_fallback",
      workerType,
      { reason: "stale_self_lock" },
      "success"
    );
    return "ttl_fallback";
  }
  // Foreign lock — some other host / process now owns it. Fail-closed.
  logger.error("[respawn] foreign lock detected, aborting respawn", { workerType });
  return "foreign_lock";
}

/**
 * Layer 1 helper — release with bounded retries + exponential backoff.
 *
 * SEC-V11-01 Rule 6: nonce value is never included in log messages.
 * Only structured metadata (workerType, attempt, reason) is logged.
 */
export async function tryReleaseLockWithRetry(
  lockService: WorkerActiveLockService,
  workerType: WorkerType,
  nonce: string,
  retryBudget: number
): Promise<boolean> {
  for (let attempt = 1; attempt <= retryBudget; attempt++) {
    const ok = await lockService.releaseLock(workerType, nonce);
    if (ok) return true;
    logger.warn("[respawn] releaseLock attempt failed", {
      attempt,
      workerType,
      retryBudget,
    });
    if (attempt < retryBudget) {
      const backoffMs = 100 * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }
  }
  return false;
}

// ============================================================================
// Item 3 (CO-31) — Acquire-side retry-with-backoff helper
// ============================================================================

/**
 * Acquire-side retry-with-backoff helper that consumes the discriminated union
 * API {@link WorkerActiveLockService.tryAcquireLock} (PR7d-3 SEC M-1) and
 * surfaces a caller-facing 3-state {@link AcquireLockWithRetryOutcome}.
 *
 * Plan v0.2 §3.2.1 / ADR-0011 Amendment 5 §A5.1 contract:
 *   - retry trigger : `result.ok === false && result.reason === "redis_unavailable"`
 *   - no-retry path : `result.ok === false && result.reason === "already_held"`
 *                     → immediate `held_by_other` return
 *   - sequence      : 100ms / 200ms / 400ms (exponential, total 700ms bounded)
 *   - retryBudget   : default 3 (matches PR-D-8 §3.2.5 release-side shape)
 *   - on exhaustion : `exhausted` (caller preserves fail-open final contract)
 *
 * The CO-31 observed transient Redis failure (network jitter / connection
 * limit) surfaces explicitly as `redis_unavailable` (T1 evidence:
 * `worker-active-lock.service.ts:236-258`), so this retry path **actually
 * fires**. Plan v0.1 attempted to consume the legacy boolean
 * `acquireLock` wrapper, which collapsed transient failure into `false`
 * indistinguishable from race-lost — `tryAcquireLock` discriminated union
 * adoption (Plan v0.2 SEC-01 fix) is the only path that keeps the
 * "degradation window 14min+ → ≤700ms" SLO claim contract-true.
 *
 * SEC-V11-01 Rule 6 compliance: nonce value is NEVER logged.
 * Only structured metadata (workerType / attempt / retryBudget / error)
 * is logged. `result.error` is already sanitized at the
 * `WorkerActiveLockService` boundary
 * (`worker-active-lock.service.ts:251-256`); the unknown-reason fallback
 * defends in depth via {@link sanitizeErrorMessage} (CWE-209).
 *
 * Acquire 側 retry-with-backoff helper。
 * `tryAcquireLock` discriminated union API (PR7d-3 SEC M-1) を consume し、
 * caller 向けに 3-state outcome (`acquired` / `held_by_other` / `exhausted`)
 * を返す。`redis_unavailable` で retry、`already_held` は no-retry。
 * 700ms total bounded delay は heartbeat interval 30s に対し >= 42x の
 * safety margin を持つ (ADR-0011 Amendment 5 §A5.2)。
 *
 * @see ADR-0011 Amendment 5 §A5.1
 * @see PR-D-8 §3.2.5 Layer 1 (release-side shape inheritance)
 * @see worker-active-lock.service.ts:236-258 (`tryAcquireLock` T1 contract)
 *
 * @param lockService - Active lock service (must accept WorkerType)
 * @param workerType - WorkerType whose lock is being acquired
 * @param nonce - Unique boot token for the caller
 * @param retryBudget - Max attempts (default 3, env-tunable in callers)
 * @returns Discriminated outcome (`acquired` / `held_by_other` / `exhausted`)
 */
export async function tryAcquireLockWithRetry(
  lockService: WorkerActiveLockService,
  workerType: WorkerType,
  nonce: string,
  retryBudget: number = 3
): Promise<AcquireLockWithRetryOutcome> {
  for (let attempt = 1; attempt <= retryBudget; attempt++) {
    const result: AcquireLockResult = await lockService.tryAcquireLock(workerType, nonce);
    if (result.ok === true) {
      return { ok: true, reason: "acquired", nonce };
    }
    // result.ok === false; result has discriminated `reason` field.
    if (result.reason === "already_held") {
      // Legitimate race-lost — do NOT retry; do NOT log warn (no log noise
      // for the expected fail-closed path).
      return { ok: false, reason: "held_by_other" };
    }
    if (result.reason === "redis_unavailable") {
      // Transient Redis failure surfaced explicitly — CO-31 retry trigger.
      // SEC-V11-01 Rule 6: structured metadata only, no nonce.
      // SEC-04 (CWE-209): result.error is already sanitized at the
      // WorkerActiveLockService boundary, reuse directly.
      logger.warn("[WorkerSupervisor] acquireLock attempt failed (transient redis_unavailable)", {
        attempt,
        workerType,
        retryBudget,
        error: result.error,
      });
      if (attempt < retryBudget) {
        const backoffMs = 100 * Math.pow(2, attempt - 1); // 100 / 200 / 400 ms
        await sleep(backoffMs);
        continue;
      }
      // Final attempt exhausted on redis_unavailable — fall through to
      // the `exhausted` return below.
      break;
    }
    // Unknown-reason fallback (defense-in-depth against future
    // `AcquireLockResult` extensions). TypeScript currently treats this as
    // unreachable, but a future union extension would silently fall through
    // without this guard. Treat as exhausted to preserve fail-open final.
    logger.warn("[WorkerSupervisor] acquireLock attempt failed (unknown reason fallback)", {
      attempt,
      workerType,
      retryBudget,
      error: sanitizeErrorMessage(
        new Error(
          `unknown AcquireLockResult.reason: ${String((result as { reason?: unknown }).reason)}`
        )
      ),
    });
    break;
  }
  return { ok: false, reason: "exhausted" };
}

/**
 * Callbacks injected into {@link runAcquireLockWithRetryOrchestrator} so the
 * Supervisor can mutate its own per-type state without exposing internal Maps
 * to the helper module.
 *
 * 各 outcome に対する Supervisor 側 callback。Supervisor 内部 Map を helper に
 * 露出させずに状態遷移させるための bridge。
 */
export interface AcquireLockOrchestratorCallbacks {
  onAcquired: () => void;
  onHeldByOther: () => void;
  onExhausted: () => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}

/**
 * Item 3 (CO-31) — orchestrator wiring {@link tryAcquireLockWithRetry} into a
 * `.then` / `.catch` / `.finally` chain with `switch + never` exhaustive
 * narrowing. Extracted to keep `worker-supervisor.service.ts` under the 1500
 * max-lines cap (TDA-01 L, `scripts/check-supervisor-lines.sh` commit gate).
 *
 * Supervisor 側 retry orchestration を helper へ移譲 (max-lines 1500 hard cap
 * 維持)。
 *
 * @see Plan v0.2 §3.2.2 (Supervisor `.then` shape)
 * @see ADR-0011 Amendment 5 §A5.3 (max-lines hard cap rationale)
 */
export function runAcquireLockWithRetryOrchestrator(
  lockService: WorkerActiveLockService,
  workerType: WorkerType,
  nonce: string,
  callbacks: AcquireLockOrchestratorCallbacks
): void {
  void tryAcquireLockWithRetry(lockService, workerType, nonce)
    .then((outcome) => {
      switch (outcome.reason) {
        case "acquired":
          callbacks.onAcquired();
          break;
        case "held_by_other":
          callbacks.onHeldByOther();
          break;
        case "exhausted":
          callbacks.onExhausted();
          break;
        default: {
          const exhaustive: never = outcome;
          throw new Error(`Unexpected AcquireLockWithRetryOutcome: ${JSON.stringify(exhaustive)}`);
        }
      }
    })
    .catch((error) => {
      callbacks.onError(error);
    })
    .finally(() => {
      callbacks.onSettled();
    });
}

// ============================================================================
// PR-D-8 §3.2.4 Rule 1 — per-type bootToken initialisation
// ============================================================================

/**
 * §3.2.4 Rule 1: independent per-type tokens via 2 separate `randomUUID()`.
 * Two distinct invocations prevent CWE-290 cross-type impersonation. Helper
 * extraction lets `worker-supervisor.service.ts` stay under the 1500 max-lines cap.
 *
 * §3.2.4 Rule 1: 独立した 2 回の randomUUID() 呼び出しで per-type token 生成。
 */
export function buildBootTokens(): Record<WorkerType, string> {
  return {
    page: randomUUID(),
    "embedding-backfill": randomUUID(),
  };
}

// ============================================================================
// PR-E-1 NF-6 (FIND-PLAN-SEC-PRE1-01 H, CWE-770) — heartbeat timer cleanup
// on `state="crashed"` entry (both `foreign_lock` and `crash_max_attempts`)
// ============================================================================

/**
 * PR-E-1 NF-6 (CWE-770 prevention) — clear the per-WorkerType lock heartbeat
 * timer when transitioning to `state="crashed"`.
 *
 * Both crashed-entry paths (`runSelfChainedRespawnAndSchedule` outcome
 * `foreign_lock` AND `handleUnexpectedExit` `crash_max_attempts`) MUST
 * invoke this helper. Failure to clear leaves `setInterval` refreshing the
 * Redis lock TTL every 60s, blocking manual recovery and downstream
 * supervisor instances from acquiring the lock — the CWE-770 (Allocation of
 * Resources Without Limits or Throttling) pattern that NF-6 closes.
 *
 * Called from:
 *   - `worker-supervisor.service.ts:runSelfChainedRespawnAndSchedule` `foreign_lock` branch
 *   - `worker-supervisor.service.ts:handleUnexpectedExit` `crash_max_attempts` branch
 *
 * `state="crashed"` 遷移時に lock heartbeat timer を必ず clear する helper。
 * NF-6 (CWE-770) 防御として、両 crashed-entry 経路 (foreign_lock + crash_max_attempts) で呼び出す。
 *
 * @param workerType - target WorkerType
 * @param lockHeartbeatTimers - the supervisor's per-WorkerType timer Map (mutated)
 * @returns true when a timer was actually cleared, false when no timer was registered
 */
export function clearLockHeartbeatTimer(
  workerType: WorkerType,
  lockHeartbeatTimers: Map<WorkerType, NodeJS.Timeout>
): boolean {
  const heartbeatTimer = lockHeartbeatTimers.get(workerType);
  if (heartbeatTimer === undefined) return false;
  clearInterval(heartbeatTimer);
  lockHeartbeatTimers.delete(workerType);
  return true;
}

// ============================================================================
// MF-02 / SEC-IMPL-01 — IPC verification helper (§3.2.4 Rule 5)
// ============================================================================

/**
 * PR-D-8 §3.2.4 Rule 5 — IPC dispatch with fail-closed path.
 *
 * Parent-side handler invoked on every IPC message from a child. Steps:
 *   1. Strict Zod parse via `parseWorkerIpcStrict`.
 *   2. `unknown-workerType` / `schema-invalid` → fail-closed: emit
 *      `worker_ipc_spoofing_detected` audit_logs (when sender pid is known
 *      via bindingTable). Caller `dispatchVerifiedIpc` then performs SIGTERM
 *      + 60s respawn suppress (Plan v1.1 §3.2.2 line 187).
 *   3. Cross-check `msg.workerType === bindingTable.get(senderPid)`.
 *      Mismatch → emit `worker_type_spoofing_detected` audit_logs (Plan
 *      §3.2.4 Rule 5). Caller performs same SIGTERM + 60s suppress escalation.
 *   4. Dispatch message `type` to appropriate handler (job-completed /
 *      heartbeat / planned-restart-request / fatal-error).
 *
 * @returns parsed & verified IPC message if OK, `null` if fail-closed /
 *   invalid (caller discards without dispatching).
 */
export function verifyWorkerIpcMessage(
  raw: unknown,
  senderPid: number | undefined,
  bindingTable: Map<number, WorkerType>
): WorkerIpcMessage | null {
  const parsed = parseWorkerIpcStrict(raw);
  if (!parsed.ok) {
    // SEC-V11-01: never log raw payload (it may contain tokens if
    // a bug causes echo-back). Log only the reason.
    // Plan v1.1 §3.2.2 line 187: emit `worker_ipc_spoofing_detected` audit
    // entry when parse fails (unknown-workerType / schema-invalid). Caller
    // (`dispatchVerifiedIpc` in worker-supervisor.service.ts) escalates to
    // SIGTERM + 60s suppress when sender pid is in bindingTable.
    const expectedWorkerType = senderPid !== undefined ? bindingTable.get(senderPid) : undefined;
    if (expectedWorkerType !== undefined) {
      emitSupervisorAuditLog(
        "worker_ipc_spoofing_detected",
        expectedWorkerType,
        { pid: senderPid, reason: parsed.reason },
        "denied"
      );
    }
    logger.warn("[WorkerSupervisor] IPC parse failed", { reason: parsed.reason });
    return null;
  }
  // Rule 5: cross-check against pid → WorkerType binding table.
  if (senderPid === undefined) {
    logger.warn("[WorkerSupervisor] IPC senderPid undefined, rejecting");
    return null;
  }
  const expected = bindingTable.get(senderPid);
  if (expected === undefined) {
    logger.warn("[WorkerSupervisor] IPC from unknown pid", { pid: senderPid });
    return null;
  }
  if (parsed.data.workerType !== expected) {
    // SEC-02: spoofing detected — emit audit_logs entry (Rule 5).
    logger.error("[WorkerSupervisor] IPC workerType mismatch — spoofing detected", {
      pid: senderPid,
      expected,
      actual: parsed.data.workerType,
    });
    emitSupervisorAuditLog(
      "worker_type_spoofing_detected",
      expected,
      {
        pid: senderPid,
        actual_workerType: parsed.data.workerType,
      },
      "denied"
    );
    return null;
  }
  return parsed.data;
}

// ============================================================================
// Fix-3 (INFRA-EMBEDDING-MOTION-SIGABRT-001) — SIGABRT detection + suppress
// ============================================================================

/**
 * Audit emit rate-limit window (CWE-770 DoS-via-log-flood defense): at most
 * 1 `worker_sigabrt_detected` entry per worker type per minute.
 *
 * 監査 emit のレート制限: per-worker-type 1 件 / 60s。
 */
export const SIGABRT_AUDIT_RATE_LIMIT_MS = 60_000;

/**
 * Consecutive SIGABRT threshold above which respawn is suppressed for an
 * extended window. Three consecutive SIGABRTs strongly imply a deterministic
 * native-pthread bug, so further immediate respawns are wasted work.
 *
 * 連続 SIGABRT で respawn を suppress する閾値。N=3 で deterministic native bug
 * とみなし、追加の即時 respawn を抑止する。
 */
export const SIGABRT_RESPAWN_SUPPRESS_THRESHOLD = 3;

/**
 * Suppress extension applied on top of the standard respawn delay when the
 * SIGABRT consecutive count crosses the threshold.
 *
 * 連続 SIGABRT 時に通常 respawn delay に追加で待機する 60s。
 */
export const SIGABRT_RESPAWN_SUPPRESS_EXTENSION_MS = 60_000;

/**
 * Fix-3 helper: structured SIGABRT signal detection with per-worker-type
 * rate-limited audit emit. Returns `true` when the consecutive SIGABRT count
 * crosses the suppress threshold so the caller can extend the respawn delay.
 *
 * Counter reset: any non-SIGABRT exit (planned restart exitCode=0, OOM
 * SIGKILL, voluntary exit) clears the per-type counter.
 *
 * Audit rate limit: at most 1 `worker_sigabrt_detected` entry per worker
 * type per minute, defending against CWE-770 DoS-via-log-flood when a
 * pathological binary panics in a tight loop.
 *
 * SIGABRT 構造化検出 + per-worker-type rate-limited audit emit + N 連続検出時
 * の suppress 判定。non-SIGABRT exit でカウンタリセット。
 *
 * @param workerType - exited child の WorkerType
 * @param signal - exit signal (null = exit code 由来)
 * @param exitedPid - exited child の pid (audit details 用)
 * @param sigabrtCountByWorkerType - 連続 SIGABRT 件数 Map (mutated)
 * @param lastSigabrtAuditByWorkerType - 最終 audit emit 時刻 Map (mutated)
 * @returns suppression を発火させるか
 */
export function processSigabrtSignal(
  workerType: WorkerType,
  signal: string | null,
  exitedPid: number | undefined,
  sigabrtCountByWorkerType: Map<WorkerType, number>,
  lastSigabrtAuditByWorkerType: Map<WorkerType, number>
): boolean {
  if (signal !== "SIGABRT") {
    // Reset on any non-SIGABRT exit (planned restart, voluntary exit, etc.)
    sigabrtCountByWorkerType.set(workerType, 0);
    return false;
  }
  const currentCount = (sigabrtCountByWorkerType.get(workerType) ?? 0) + 1;
  sigabrtCountByWorkerType.set(workerType, currentCount);
  const suppressionTriggered = currentCount >= SIGABRT_RESPAWN_SUPPRESS_THRESHOLD;

  // Rate-limited audit_logs emit (FIND-PLAN-SEC-D1b-03 L).
  const now = Date.now();
  const lastEmit = lastSigabrtAuditByWorkerType.get(workerType) ?? 0;
  if (now - lastEmit >= SIGABRT_AUDIT_RATE_LIMIT_MS) {
    emitSupervisorAuditLog(
      "worker_sigabrt_detected",
      workerType,
      {
        consecutiveCount: currentCount,
        suppressionTriggered,
        finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
        pid: exitedPid,
      },
      suppressionTriggered ? "denied" : "success"
    );
    lastSigabrtAuditByWorkerType.set(workerType, now);
  }

  if (suppressionTriggered) {
    logger.error("[WorkerSupervisor] SIGABRT respawn suppress threshold reached", {
      workerType,
      consecutiveCount: currentCount,
      suppressDurationMs: SIGABRT_RESPAWN_SUPPRESS_EXTENSION_MS,
      finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
    });
  }
  return suppressionTriggered;
}

/**
 * Compact wrapper around `emitSupervisorAuditLog` for the
 * `worker_supervisor_restart` action — collapses the repeated `restartReason
 * + jobsProcessed + exitCode + signal + pid + respawnCount` payload that
 * `handleUnexpectedExit` / `handlePlannedRestart` build identically.
 *
 * `worker_supervisor_restart` audit emit を payload 統一して line 数を削減。
 */
export function emitWorkerRestartAudit(
  workerType: WorkerType,
  restartReason: "planned" | "unexpected_exit" | "crash_max_attempts",
  jobsProcessed: number,
  code: number | null,
  signal: string | null,
  exitedPid: number | undefined,
  respawnCount: number,
  result: "success" | "failure" | "denied"
): void {
  emitSupervisorAuditLog(
    "worker_supervisor_restart",
    workerType,
    { restartReason, jobsProcessed, exitCode: code, signal, pid: exitedPid, respawnCount },
    result
  );
}

/**
 * Fix-3 helper: schedule the self-chained respawn with optional SIGABRT
 * suppress delay. When `sigabrtSuppress` is `true`, the respawn is gated
 * behind a 60s suppress timer so consecutive SIGABRTs cannot tight-loop the
 * supervisor.
 *
 * SIGABRT 連続検出時に通常 respawn を 60s 遅延させるスケジューラ helper。
 *
 * @param sigabrtSuppress - `processSigabrtSignal` の戻り値
 * @param isShuttingDownGetter - shutdown 判定 (timer firing 時の guard)
 * @param scheduleRespawn - 実 respawn を起動する callback
 */
export function scheduleSigabrtAwareRespawn(
  sigabrtSuppress: boolean,
  isShuttingDownGetter: () => boolean,
  scheduleRespawn: () => void
): void {
  const delay = sigabrtSuppress ? SIGABRT_RESPAWN_SUPPRESS_EXTENSION_MS : 0;
  setTimeout(() => {
    if (isShuttingDownGetter()) return;
    scheduleRespawn();
  }, delay).unref?.();
}
