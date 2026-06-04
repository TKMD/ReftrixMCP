// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generic Enqueue-With-Collision-Guard Helper (PR-D-6 Phase 2)
 *
 * BullMQ jobId collision (RC-A) を single SSOT helper で防御する generic layer。
 * `embedding-backfill-queue.ts` / `page-analyze-queue.ts` の両 Queue SSOT が
 * 本 helper を呼び出し、以下 2 層の defense を統合する:
 *
 * Generic layer that defends BullMQ jobId collisions (RC-A) via a single SSOT
 * helper. Both `embedding-backfill-queue.ts` and `page-analyze-queue.ts` call
 * into this helper, unifying the 2-layer defense:
 *
 * - **Layer 1 — atomic SETNX Lua claim** (UP-3 binding, TOCTOU closure):
 *   `reftrix:<domain>:jobclaim:<jobId>` key を `SETNX` + `PEXPIRE` (5s TTL) で
 *   atomic に claim する。WorkerActiveLockService `tryAcquireLock` L212-234
 *   pattern を流用。claim 勝者のみ `queue.add` を実行、敗者は既存 incumbent job
 *   の state を probe し `reused_active` / `enqueued_retry` / `limbo_forced` の
 *   いずれかにルーティングする。
 *   Atomic `SETNX` + `PEXPIRE` claim closure for TOCTOU. Mirrors the
 *   WorkerActiveLockService `tryAcquireLock` pattern. Losers route through
 *   `dispatchLoserPath` and resolve to one of `reused_active` /
 *   `enqueued_retry` / `limbo_forced` based on the incumbent job state.
 *
 * - **Layer 2 — post-add `job.timestamp` delta check** (stale retention closure):
 *   `queue.add` 勝者が既存 terminal job (completed / failed) の返却を受けた場合
 *   (`job.timestamp < Date.now() - 100ms`)、`handleProbeTerminal` →
 *   `handleCollisionEnqueue` 経由で retry jobId を生成して re-enqueue する。
 *   Post-add timestamp check routes stale `completed` / `failed` retained jobs
 *   through the retry enqueue path.
 *
 * 5 sub-handler (UP-2 binding, CC ≤ 6 each, dispatcher CC ≤ 6):
 *   - `handleAtomicAdd`       — claim winner → `queue.add`
 *   - `handleProbeActive`     — existing active / waiting / delayed → trust
 *   - `handleProbeTerminal`   — existing completed / failed → retry
 *   - `handleCollisionEnqueue` — retry jobId 生成 + `queue.add` + audit emit
 *   - `handleFailOpen`        — Redis unreachable → fail-open fallback
 *
 * @module queues/enqueue-with-collision-guard
 */

import { randomUUID } from "node:crypto";
import type { Job, JobsOptions, Queue, RedisClient } from "bullmq";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";

// ============================================================================
// SSOT — BullMQ key-missing transient discrimination (CO-SAMEURL-02 D1)
// ============================================================================

/**
 * SSOT regex for the BullMQ "Missing key for job …" transient that can surface
 * inside the fail-open `queue.add` under a same-URL race (a loser racing ahead
 * to `handleFailOpen` re-adds the same jobId while the incumbent's BullMQ keys
 * are mid-lifecycle). This is a **transient** — same-URL dedup correctness is
 * still upheld by BullMQ jobId uniqueness (≤1 surviving job), so D1 only makes
 * the transient observable; it never changes the returned outcome.
 *
 * `^Missing key for job ` anchor + lazy `[\s\S]*?` (multi-line-safe, NOT `.*`)
 * to avoid over-matching unrelated / security-relevant errors (F-PLAN-L-01).
 *
 * CO-SAMEURL-02 D1 用の BullMQ "Missing key for job …" transient 判別 SSOT
 * regex。same-URL race の fail-open `queue.add` 内で発生しうる transient で、
 * dedup の正しさ (≤1 surviving job) は BullMQ jobId uniqueness で担保済。D1 は
 * transient を observable にするのみで returned outcome は不変。`^` anchor +
 * lazy `[\s\S]*?` で over-match (security-relevant error 誤分類) を防止する。
 *
 * @see  §Sub-item 4 / §UB-6
 */
export const BULLMQ_KEY_MISSING_TRANSIENT_RE =
  /^Missing key for job [\s\S]*?(?:updateProgress|moveToActive|lock)/i;

// ============================================================================
// Types — Public API
// ============================================================================

/**
 * BullMQ job state (subset surfaced through `Job.getState()`).
 * BullMQ の job state のうち collision guard が識別する subset。
 */
export type CollisionJobState = "active" | "waiting" | "delayed" | "completed" | "failed";

/**
 * `EnqueueResult` — 5-variant discriminated union (PR-D-7 Phase 2 Wave 2, Option Z-a).
 *
 * Plan v1.2 §3.1.3 に対応。各 variant は caller が outcome を explicit に
 * handle できるよう outcome / jobId / collision metadata を保持する。
 *
 * Per Plan v1.2 §3.1.3; each variant carries outcome + jobId + collision
 * metadata so callers can branch explicitly on the outcome.
 *
 * PR-D-7 Phase 2 Wave 2 (Option Z-a binding) で `race_lost_atomic` variant を
 * 削除。production emit path が 0 件の dead variant であり、SETNX claim 敗者は
 * `dispatchLoserPath` 経由で必ず `reused_active` / `enqueued_retry` /
 * `limbo_forced` のいずれかに resolve するため冗長だった。5-variant 化により
 * exhaustive match 保持しつつ dead branch を cleanup。詳細は ADR-0018
 * Amendment 6 §Implementation Notes 参照。
 *
 * PR-D-7 Phase 2 Wave 2 (Option Z-a) removes the `race_lost_atomic` variant:
 * it was a dead variant with 0 production emit paths because SETNX claim
 * losers always resolve through `dispatchLoserPath` to one of `reused_active`
 * / `enqueued_retry` / `limbo_forced`. The narrow to 5 variants preserves
 * exhaustive matching while eliminating dead branches. See ADR-0018
 * Amendment 6 §Implementation Notes for rationale.
 *
 * switch 文で `const _: never = result.outcome` を書く compile-time
 * exhaustive check に使う想定。
 */
export type EnqueueResult =
  | { outcome: "enqueued_new"; jobId: string; collision: null }
  | { outcome: "reused_active"; jobId: string; collision: "active" | "waiting" | "delayed" }
  | {
      outcome: "enqueued_retry";
      jobId: string;
      collision: "completed" | "failed";
      retryJobId: string;
    }
  | { outcome: "limbo_forced"; jobId: string; collision: "unknown" }
  | { outcome: "enqueued_fail_open"; jobId: string; collision: null };

/**
 * Callback invoked by `handleCollisionEnqueue` whenever a retry jobId is
 * actually enqueued. The caller is responsible for emitting the domain-
 * appropriate `audit_logs` row (e.g. `embedding_backfill_collision_resolved`).
 *
 * `handleCollisionEnqueue` が retry jobId を新規 enqueue したときに呼ばれる
 * callback。ドメイン固有の `audit_logs` 行 (例:
 * `embedding_backfill_collision_resolved`) を emit する責務を持つ。
 */
export interface CollisionAuditEmitter {
  (event: {
    webPageId: string;
    originalJobId: string;
    retryJobId: string;
    originalState: "completed" | "failed";
  }): Promise<void>;
}

/**
 * Options passed from the caller to `enqueueWithCollisionGuard`.
 *
 * 呼び出し側から generic helper へ渡すオプション一式。
 */
export interface EnqueueWithCollisionGuardOptions<TData, TResult> {
  /**
   * BullMQ Queue instance.
   *
   * 全 type parameter を明示的に固定することで、`queue.add(queueName: string, ...)`
   * の NameType narrow が generic context でも resolve される。BullMQ の
   * `Queue<DataTypeOrJob, DefaultResultType, DefaultNameType, DataType, ResultType, NameType>`
   * のうち `DataType` / `ResultType` / `NameType` まで明示する。
   *
   * Pinning all type parameters makes `queue.add(queueName: string, ...)`
   * resolve cleanly inside the generic helper.
   */
  queue: Queue<TData, TResult, string, TData, TResult, string>;
  /** Queue name (used both for `queue.add` and Redis key namespace). */
  queueName: string;
  /** Canonical jobId (idempotency key). */
  jobId: string;
  /** Job payload. */
  data: TData;
  /** BullMQ `JobsOptions` (priority / delay / attempts). `jobId` は helper が注入。 */
  jobOptions: Omit<JobsOptions, "jobId">;
  /** Redis key namespace for the SETNX claim, e.g. `"backfill"` / `"page-analyze"`. */
  claimKeyNamespace: string;
  /** webPageId (used only by the audit emitter, must be full-length UUID). */
  webPageId: string;
  /** Optional audit emitter — required only for domains that persist audit rows. */
  auditEmitter?: CollisionAuditEmitter;
}

// ============================================================================
// Constants (internal)
// ============================================================================

/**
 * `reftrix:<namespace>:jobclaim:<jobId>` Redis key は `SETNX + PEXPIRE (5s TTL)`
 * で atomic claim される。TTL は通常 `queue.add` round-trip より十分長い想定だが、
 * process crash 等で release が漏れた場合も 5 秒後に自然失効する。
 *
 * The `reftrix:<namespace>:jobclaim:<jobId>` Redis key is claimed atomically
 * via `SETNX + PEXPIRE (5s TTL)`. 5s comfortably covers `queue.add` round-trip
 * yet naturally expires if release leaks due to process crash.
 */
const CLAIM_TTL_MS = 5_000;

/**
 * `job.timestamp` が "now" より 100ms 以上古ければ terminal retained job と
 * 判定する (Plan v1.2 §3.1.2 Layer 2 binding)。
 *
 * A `job.timestamp` older than "now − 100ms" signals a terminal retained job
 * (per Plan v1.2 §3.1.2 Layer 2 binding).
 */
const STALE_JOB_TIMESTAMP_THRESHOLD_MS = 100;

/**
 * Atomic `SETNX + PEXPIRE` Lua script. WorkerActiveLockService
 * `RELEASE_LUA` と同じ pattern を流用した atomic claim.
 *
 * Returns `{1, "claimed"}` when claim succeeded, otherwise `{0, existing}`
 * where `existing` is the current nonce held by the incumbent claimant.
 *
 * Atomic `SETNX + PEXPIRE` Lua script patterned after WorkerActiveLockService.
 */
const JOBID_CLAIM_LUA = `
if redis.call('SETNX', KEYS[1], ARGV[1]) == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {1, 'claimed'}
else
  local existing = redis.call('GET', KEYS[1])
  return {0, existing or ''}
end
`;

/**
 * Lua-guarded release — delete claim key only if it still holds our nonce.
 * Mirrors `WorkerActiveLockService.RELEASE_LUA`.
 *
 * Lua 保護付き release — 自 nonce を保持している場合のみ claim key を削除する。
 */
const JOBID_CLAIM_RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// ============================================================================
// Retry jobId UUIDv7 binding (UP-5)
// ============================================================================

/**
 * Build `<origJobId>__retry_<uuidv7>` retry jobId suffix (UP-5 binding).
 *
 * Node.js 20.19+ stdlib `crypto.randomUUID({ version: 7 })` を採用。SBOM drift
 * 0、EU CRA 2026-09-11 compliance 維持。Node 20.19-21.x 環境で stdlib が
 * `{version:7}` を受け付けない場合は `randomUUID()` (version 4) にフォールバック
 * する (Plan v1.2 §3.1.5 Phase 2 Impl 確定事項)。
 *
 * Retry jobId suffix per UP-5 binding. Prefers stdlib UUIDv7; falls back to
 * v4 `randomUUID()` when v7 support is absent on Node 20.19-21.x.
 *
 * @internal exported for tests (Block B test #7 UP-3 Layer 2 + UP-5 form assertion).
 */
export function buildRetryJobId(origJobId: string): string {
  const uuid = generateRetryUuid();
  return `${origJobId}__retry_${uuid}`;
}

/**
 * Generate a UUIDv7 (preferred) or UUIDv4 (fallback) for retry jobId suffix.
 *
 * UUIDv7 を優先し、Node.js stdlib が v7 を受け付けない環境では v4 にフォール
 * バックする。いずれも 36-char hex + hyphen format で `RETRY_JOBID_TRUNCATED_REGEX`
 * (`[0-9a-f-]{36}`) に合致する。
 */
function generateRetryUuid(): string {
  try {
    // Node.js stdlib typings do not yet model `{version:7}` (stabilized in Node 22+).
    // The cast is scoped narrowly so `pnpm typecheck` passes without `any` leak.
    const maybeV7 = (randomUUID as unknown as (options?: { version?: number }) => string)({
      version: 7,
    });
    if (typeof maybeV7 === "string" && maybeV7.length === 36) {
      return maybeV7;
    }
  } catch {
    // Fall through to v4 fallback below.
  }
  return randomUUID();
}

// ============================================================================
// Generic helper (public API)
// ============================================================================

/**
 * Generic SSOT helper: atomically enqueue a BullMQ job guarded against jobId
 * collisions. Routes through 5 sub-handler dispatch (UP-2) returning a
 * discriminated `EnqueueResult` (UP-3, 5 variants post PR-D-7 Phase 2 Wave 2
 * Option Z-a — see {@link EnqueueResult}).
 *
 * Generic SSOT helper — atomic claim + 5 sub-handler dispatch + 5-variant
 * discriminated return (PR-D-7 Phase 2 Wave 2 narrowed 6 → 5; dead
 * `race_lost_atomic` variant removed).
 *
 * Cyclomatic complexity: dispatcher ≤ 6, each handler ≤ 6. ESLint
 * `complexity: ["error", 10]` CI gate (Plan v1.2 §8.1 DoD binding).
 *
 * @template TData - BullMQ job data type
 * @template TResult - BullMQ job result type
 * @param options - {@link EnqueueWithCollisionGuardOptions}
 * @returns {@link EnqueueResult} discriminated by `outcome`
 */
export async function enqueueWithCollisionGuard<TData, TResult>(
  options: EnqueueWithCollisionGuardOptions<TData, TResult>
): Promise<EnqueueResult> {
  const { queue, jobId, claimKeyNamespace } = options;
  const nonce = randomUUID();
  const claimKey = buildClaimKey(claimKeyNamespace, jobId);

  let redis: RedisClient;
  try {
    redis = (await queue.client) as RedisClient;
  } catch (err) {
    return handleFailOpen(options, err);
  }

  try {
    return await dispatchAfterClaim(redis, claimKey, nonce, options);
  } catch (err) {
    return handleFailOpen(options, err);
  }
}

/**
 * Dispatcher (CC ≤ 6) — atomic claim → winner path / loser path.
 * Extracted as its own function so the top-level `enqueueWithCollisionGuard`
 * dispatcher stays below CC 6 including fail-open catch.
 */
async function dispatchAfterClaim<TData, TResult>(
  redis: RedisClient,
  claimKey: string,
  nonce: string,
  options: EnqueueWithCollisionGuardOptions<TData, TResult>
): Promise<EnqueueResult> {
  const claimed = await attemptAtomicClaim(redis, claimKey, nonce);
  if (claimed) {
    try {
      return await handleAtomicAdd(options);
    } finally {
      await releaseClaim(redis, claimKey, nonce);
    }
  }
  return await dispatchLoserPath(options);
}

/**
 * Loser-path dispatcher (CC ≤ 4) — inspect the incumbent job and route to
 * `handleProbeActive` / `handleProbeTerminal` / `handleCollisionEnqueue` or
 * fall back through `handleFailOpen` when the claim expired.
 */
async function dispatchLoserPath<TData, TResult>(
  options: EnqueueWithCollisionGuardOptions<TData, TResult>
): Promise<EnqueueResult> {
  const { queue, jobId } = options;
  const existing = (await queue.getJob(jobId)) as Job<TData, TResult> | undefined;
  if (!existing) {
    // Claim expired concurrently; fail-open rather than raise.
    return handleFailOpen(options, new Error("claim_expired"));
  }

  const state = (await existing.getState()) as CollisionJobState | "unknown";
  if (state === "active" || state === "waiting" || state === "delayed") {
    return handleProbeActive(existing, state);
  }
  if (state === "completed" || state === "failed") {
    return await handleProbeTerminal(existing, state, options);
  }
  // BullMQ returned a non-lifecycle state ("unknown" / future values).
  // PR-D-6 Registry v4 §15.1 (FIND-TPA-IMPL-01) binding: map `state === "unknown"`
  // to `limbo_forced` per ADR-0018 §Decision 4 case(c) "unknown → ADR-0017 limbo
  // として処理" contract. `limbo_forced` is the canonical semantic for a
  // non-lifecycle state encountered after the claim succeeded and the incumbent
  // job was probed.
  //
  // PR-D-7 Phase 2 Wave 2 (Option Z-a, removed per ADR-0018 Amendment 6):
  // the legacy `race_lost_atomic` variant was a dead emit path (0 production
  // references). SETNX claim losers land here via `dispatchLoserPath` and are
  // always mapped to `reused_active` / `enqueued_retry` / `limbo_forced` based
  // on incumbent state, so the 6th variant was redundant with `limbo_forced`
  // for non-lifecycle fallback. 5-variant union preserves exhaustive matching
  // while eliminating the dead branch.
  //
  // PR-D-6 Registry v4 §15.1 (FIND-TPA-IMPL-01): `state === "unknown"` → `limbo_forced`
  // restores the ADR-0018 §Decision 4 case(c) contract.
  return { outcome: "limbo_forced", jobId, collision: "unknown" };
}

// ============================================================================
// Sub-handlers (each CC ≤ 6, Plan v1.2 §3.1.1 binding)
// ============================================================================

/**
 * `handleAtomicAdd` — claim 勝者の正常 path。
 * `queue.add` 直後に `job.timestamp` delta check (Layer 2, Plan §3.1.2) を行い
 * stale retention collision の場合は `handleProbeTerminal` に委譲する。
 *
 * Claim-winner happy path; post-add timestamp delta check (Layer 2) routes
 * stale retention hits through `handleProbeTerminal`.
 */
async function handleAtomicAdd<TData, TResult>(
  options: EnqueueWithCollisionGuardOptions<TData, TResult>
): Promise<EnqueueResult> {
  const { queue, queueName, jobId, data, jobOptions } = options;
  const job = (await queue.add(queueName, data, { ...jobOptions, jobId })) as Job<TData, TResult>;

  const jobTimestamp = typeof job.timestamp === "number" ? job.timestamp : Date.now();
  if (jobTimestamp < Date.now() - STALE_JOB_TIMESTAMP_THRESHOLD_MS) {
    // BullMQ returned the retained terminal job rather than a fresh insert.
    const state = (await job.getState()) as CollisionJobState | "unknown";
    if (state === "completed" || state === "failed") {
      return await handleProbeTerminal(job, state, options);
    }
    // Fall through to "enqueued_new" — timestamp is stale but state is fresh.
  }
  return { outcome: "enqueued_new", jobId, collision: null };
}

/**
 * `handleProbeActive` — 既存 active / waiting / delayed job を trust。
 *
 * Trust an active / waiting / delayed incumbent job.
 */
function handleProbeActive<TData, TResult>(
  job: Job<TData, TResult>,
  state: "active" | "waiting" | "delayed"
): EnqueueResult {
  const jobId = typeof job.id === "string" ? job.id : "";
  return { outcome: "reused_active", jobId, collision: state };
}

/**
 * `handleProbeTerminal` — 既存 completed / failed job → retry enqueue path。
 *
 * For a terminal (completed / failed) incumbent, route through the retry
 * enqueue path; preserve the original state on the returned collision marker.
 */
async function handleProbeTerminal<TData, TResult>(
  job: Job<TData, TResult>,
  state: "completed" | "failed",
  options: EnqueueWithCollisionGuardOptions<TData, TResult>
): Promise<EnqueueResult> {
  return await handleCollisionEnqueue(state, options, job);
}

/**
 * `handleCollisionEnqueue` — retry jobId 生成 + `queue.add` + audit emit。
 *
 * Generate retry jobId (`<origJobId>__retry_<uuidv7>`), enqueue, and invoke
 * the caller-supplied `auditEmitter` for domain-specific audit persistence.
 */
async function handleCollisionEnqueue<TData, TResult>(
  originalState: "completed" | "failed",
  options: EnqueueWithCollisionGuardOptions<TData, TResult>,
  _originalJob: Job<TData, TResult>
): Promise<EnqueueResult> {
  const { queue, queueName, jobId, data, jobOptions, webPageId, auditEmitter } = options;
  const retryJobId = buildRetryJobId(jobId);
  await queue.add(queueName, data, { ...jobOptions, jobId: retryJobId });

  if (auditEmitter) {
    try {
      await auditEmitter({
        webPageId,
        originalJobId: jobId,
        retryJobId,
        originalState,
      });
    } catch (err) {
      // Audit emission failures must not block the retry enqueue itself.
      logger.warn("[EnqueueWithCollisionGuard] audit emit failed (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    }
  }

  return {
    outcome: "enqueued_retry",
    jobId: retryJobId,
    collision: originalState,
    retryJobId,
  };
}

/**
 * `handleFailOpen` — Redis unreachable / unexpected error path。
 *
 * WorkerActiveLockService SEC M-1 precedent に倣い、Redis 到達不能時は
 * `fail-open` として `queue.add` を strict な collision guard なしで実行する。
 *
 * Redis-unreachable / unexpected-error fallback — mirrors the
 * WorkerActiveLockService fail-open precedent.
 */
async function handleFailOpen<TData, TResult>(
  options: EnqueueWithCollisionGuardOptions<TData, TResult>,
  error: unknown
): Promise<EnqueueResult> {
  const { queue, queueName, jobId, data, jobOptions } = options;
  logger.warn("[EnqueueWithCollisionGuard] atomic claim unavailable; falling back", {
    queueName,
    error: sanitizeErrorMessage(error),
  });

  try {
    await queue.add(queueName, data, { ...jobOptions, jobId });
  } catch (addErr) {
    // CO-SAMEURL-02 D1: discriminate the BullMQ key-missing transient (raised
    // under a same-URL race when a loser re-adds the same jobId mid-lifecycle)
    // from a generic fail-open add failure. Pure observability — the returned
    // outcome is `enqueued_fail_open` in BOTH branches (dedup logic unchanged;
    // this never flips fail-open → fail-closed). PII guard: jobId truncated
    // (CWE-209) + sanitized error message (no raw URL / full UUID).
    const rawMessage = addErr instanceof Error ? addErr.message : String(addErr);
    if (BULLMQ_KEY_MISSING_TRANSIENT_RE.test(rawMessage)) {
      logger.warn(
        "[EnqueueWithCollisionGuard] fail-open queue.add hit BullMQ key-missing transient (dedup intact via jobId uniqueness)",
        {
          queueName,
          jobId: truncateId(jobId, 8),
          error: sanitizeErrorMessage(addErr),
        }
      );
    } else {
      logger.warn("[EnqueueWithCollisionGuard] fail-open queue.add also failed", {
        queueName,
        jobId: truncateId(jobId, 8),
        error: sanitizeErrorMessage(addErr),
      });
    }
  }
  return { outcome: "enqueued_fail_open", jobId, collision: null };
}

// ============================================================================
// Internal — atomic claim primitives
// ============================================================================

/**
 * Build the `reftrix:<namespace>:jobclaim:<jobId>` Redis claim key.
 *
 * `reftrix:<namespace>:jobclaim:<jobId>` 形式の Redis claim key を生成する。
 */
function buildClaimKey(namespace: string, jobId: string): string {
  return `reftrix:${namespace}:jobclaim:${jobId}`;
}

/**
 * Attempt atomic `SETNX + PEXPIRE` claim via Lua. Returns `true` iff the
 * claim was granted to this nonce.
 *
 * Lua 経由で `SETNX + PEXPIRE` を atomic に実行する。claim 取得成功時のみ
 * `true` を返す。
 */
async function attemptAtomicClaim(
  redis: RedisClient,
  claimKey: string,
  nonce: string
): Promise<boolean> {
  const result = (await redis.eval(JOBID_CLAIM_LUA, 1, claimKey, nonce, String(CLAIM_TTL_MS))) as [
    number,
    string,
  ];
  return Array.isArray(result) && result[0] === 1;
}

/**
 * Release the claim (Lua-guarded: only if current nonce matches).
 *
 * claim key を Lua 保護付きで解放する (自 nonce の場合のみ削除)。
 */
async function releaseClaim(redis: RedisClient, claimKey: string, nonce: string): Promise<void> {
  try {
    await redis.eval(JOBID_CLAIM_RELEASE_LUA, 1, claimKey, nonce);
  } catch (err) {
    // Non-fatal: PEXPIRE (5s) will GC the key naturally.
    logger.warn("[EnqueueWithCollisionGuard] claim release failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}
