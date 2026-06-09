// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Category Processors (v0.4.0 PR7a-2)
 *
 * Strategy Pattern でカテゴリ別のバックフィル処理を表現する。`EmbeddingBackfillWorker`
 * の巨大 switch 分岐（TDA H-2）を解消し、カテゴリ追加時の影響を Processor 実装
 * だけに閉じ込める。
 *
 * SSOT は `embedding-backfill-queue.ts` の `EMBEDDING_BACKFILL_CATEGORIES`。
 * 本モジュールは `Record<EmbeddingBackfillCategory, BackfillCategoryProcessor>`
 * としてコンパイル時の exhaustiveness を保証する。
 *
 * Strategy Pattern representing per-category backfill logic. Replaces the
 * monolithic switch in `EmbeddingBackfillWorker` (TDA H-2) so adding a category
 * only touches the new processor.
 *
 * SSOT lives in `embedding-backfill-queue.ts` (`EMBEDDING_BACKFILL_CATEGORIES`).
 * This module guarantees compile-time exhaustiveness via
 * `Record<EmbeddingBackfillCategory, BackfillCategoryProcessor>`.
 *
 * @module queues/embedding-backfill-processors
 */

import path from "node:path";
import type { Job, Queue } from "bullmq";
import { prisma as sharedPrismaClient } from "@reftrixmcp/database";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import { AUDIT_LOG_CONSTANTS, getAuditLogService } from "../services/audit-log.service";
import {
  AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
  AUDIT_ACTION_WORKER_CONFIG_LEGACY_ENV_VAR_DETECTED,
  AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_ACQUIRED,
  AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_RACE_LOST,
  AUDIT_ACTION_WORKER_LOCK_SERVICE_UNREACHABLE,
  AUDIT_ACTION_WORKER_SUB_CHILD_SPAWN_RATE_LIMIT_VIOLATED,
  AUDIT_ACTOR_WORKER_CONFIG_VALIDATOR,
  AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER,
  getWorkerActorName,
} from "../audit/audit-actions";
import { resolveForkMode } from "./embedding-backfill-fork-mode";
import {
  WorkerActiveLockService,
  type PerJobAcquireLockResult,
} from "../services/worker-active-lock.service";
import { randomUUID } from "node:crypto";
import {
  backfillBackgroundsForPage,
  backfillJsAnimationsForPage,
  backfillMotionsForPage,
  backfillPartTextForPage,
  backfillResponsiveForPage,
  backfillSectionVisualsForPage,
  countMissingResponsiveEmbeddings,
  countPartVisualBackfillTargets,
  countSectionVisualBackfillTargets,
} from "../services/embedding-backfill.service";
import {
  runVisualEmbeddingSubPhases,
  markResidualBboxUnresolvableParts,
  emitSectionVisualPiiExcludedMarkersForPage,
  type EmbeddingPhasePrismaClient,
} from "../workers/phases/phase-5-embedding";
import { resolvePartBoundingBoxesWithFallback } from "../workers/phases/shared/bbox-resolution.helper";
import { BACKFILL_PARTS_LIMIT_DEFAULT } from "../workers/phases/embedding-backfill-ipc";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  addEmbeddingBackfillJobWithGuard,
  type EmbeddingBackfillCategory,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "./embedding-backfill-queue";

// v0.4.0 PR7e-β4 PR2d (HIGH-α): re-used across all 7 category Processors via
// `runForkOrFallback`. See ADR-0015 Amendment 8.
// PR2d (HIGH-α): 7 全 Processor で `runForkOrFallback` 経由で再利用。

// =====================================================
// Progress sentinel values — aligned with embedding-backfill-worker
// =====================================================

const PROGRESS_AFTER_FETCH = 10;
const PROGRESS_AFTER_EMBEDDING = 90;

/**
 * PR-G1 RC1 (SEC-05): backfill bbox scroll-sweep の lock 延長 duration (ms)。
 * `embedding-backfill-fork-orchestrator` の `BACKFILL_EXTEND_LOCK_DURATION_MS`
 * (60s) と同値だが、本ファイルで局所定義する。理由: fork orchestrator を
 * static import すると non-js_animation category の lazy-load 契約
 * (`tests/queues/embedding-backfill-processors.test.ts` T-new-03) を破壊するため。
 *
 * Lock-extension duration (ms) for the backfill bbox scroll sweep. Mirrors the
 * fork orchestrator's `BACKFILL_EXTEND_LOCK_DURATION_MS` (60s) but is defined
 * locally: a static import of the fork orchestrator would break the
 * non-js_animation lazy-load contract (T-new-03).
 */
const BBOX_SWEEP_EXTEND_LOCK_DURATION_MS = 60_000;

// =====================================================
// Types
// =====================================================

/**
 * Prisma client の最小サーフェス — countPartVisualBackfillTargets 等は
 * `prisma` シングルトン経由で呼び出すため、ここでは screenshot 参照用の最小限のみ定義。
 * Minimal Prisma surface — `countPartVisualBackfillTargets` uses the shared
 * singleton; here we only need the screenshot surface when required.
 */
export interface BackfillPrismaClientLike {
  webPage: {
    findUnique: (args: unknown) => Promise<{ screenshotStoragePath?: string | null } | null>;
  };
}

/**
 * Embedding service の最小サーフェス
 * Minimal embedding service surface
 */
export interface BackfillEmbeddingServiceLike {
  generateFromText: (text: string) => Promise<{ embedding: number[] }>;
  disposeEmbeddingPipeline: () => Promise<void>;
}

/**
 * Processor が受け取る context
 * Context passed to each processor
 */
export interface BackfillProcessContext {
  webPageId: string;
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /**
   * Screenshot の絶対パス（Worker 側で allowlist 検証済み）
   * Absolute path to the validated screenshot (allowlist-checked by the Worker)
   */
  screenshotStoragePath?: string | undefined;
  /**
   * Prisma client（DINOv2 等で必要な場合のみ使用）
   * Prisma client (used only when the processor requires DB access beyond helpers)
   */
  prisma?: EmbeddingPhasePrismaClient | undefined;
}

/**
 * Processor の戻り値
 * Processor return shape
 */
export interface BackfillCategoryResult {
  /** 対象カテゴリ / target category */
  category: EmbeddingBackfillCategory;
  /** 生成成功件数 / generated count */
  generated: number;
  /** 生成失敗件数 / failed count */
  failed: number;
  /** メモリ圧迫でスキップした回数 / memory-skip count */
  memorySkips: number;
  /** バックフィル中に蓄積したエラー詳細 / accumulated error messages */
  errors: string[];
  /**
   * スキップ理由 (Graceful Degradation 時のみセット)。
   *   - `ssrf_blocked_on_backfill` — Backfill 経路の SSRF 再検証でブロック (SEC HIGH-1 + PR7e-α bug⑦)
   *   - `bbox_unresolvable` — PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1
   *     Supplement S3): Playwright-residual catch-all。1st-pass + opt-in reload
   *     pass 共に失敗した residual parts。`bbox_invalid` と mutually exclusive。
   *
   * Skip reason (set only for Graceful Degradation skips):
   *   - `ssrf_blocked_on_backfill` — SSRF re-validation blocked
   *   - `bbox_unresolvable` — PR-D-9 Wave 4: Playwright-residual catch-all
   *
   * @see ADR-0018 §Decision 1 Supplement S3 (decision boundary table)
   */
  skipReason?: "ssrf_blocked_on_backfill" | "bbox_unresolvable";
}

// =====================================================
// PR-D-9 Wave 4 (C-16 / FIND-PLAN-TDA-06): classifyBboxFailure helper
// =====================================================

/**
 * PR-D-9 Wave 4 (C-16 / FIND-PLAN-TDA-06): bbox failure 分類 helper。
 *
 * Plan §5.1.7 / §5.1.8: 4-way switch (`iframe` / `shadow_dom` / `dom_disposed`
 * / catch-all `bbox_unresolvable`) を private helper 関数に extract して、
 * `embedding-backfill-processors.ts` の cyclomatic complexity delta を
 * `≤ +2` に制限する。
 *
 * **PR-D-9 scope**: 1st-pass で classification 情報がまだ propagation されない
 * ため、本 helper は default branch (residual catch-all) のみを実装する。
 * `iframe` / `shadow_dom` / `dom_disposed` の細分化は future PR で `service` 層
 * から `BboxResolutionResult` に classification field を追加することを想定。
 * 現状 Phase 5 の bbox-resolution.helper は failure mode を保持しないため、
 * 4-way switch の structural shell を保持しつつ、3 case はすべて catch-all
 * (`bbox_unresolvable`) と同じ扱いにする (ADR-0018 §Decision 1 Supplement S3
 * `bbox_unresolvable` definition: "1st-pass resolution + optional reload pass
 * both fail" の包括的 catch-all)。
 *
 * Helper extracted to keep CC delta ≤ +2 per FIND-PLAN-TDA-06. Currently the
 * 4 cases all map to the residual `bbox_unresolvable` catch-all because the
 * service layer does not yet propagate per-failure classification (future PR
 * will subdivide).
 *
 * @see ADR-0018 §Decision 1 Supplement S3
 * @see Plan v1.1 §5.1.7 / §5.1.8 (helper extraction contract)
 */
type SkipReasonClassification = {
  skipReason: "bbox_unresolvable";
};

function classifyBboxFailure(reason: string): SkipReasonClassification {
  switch (reason) {
    case "iframe":
    case "shadow_dom":
    case "dom_disposed":
      // PR-D-9 scope: future PR will introduce iframe / shadow_dom /
      // dom_disposed-specific skipReason values; for now all classified
      // failures fold into the residual catch-all per ADR-0018 §Decision 1
      // Supplement S3 (`bbox_unresolvable` covers "1st-pass + reload both
      // fail").
      return { skipReason: "bbox_unresolvable" };
    default:
      return { skipReason: "bbox_unresolvable" };
  }
}

/**
 * Strategy Pattern: カテゴリ別の処理を表すインターフェース
 * Strategy Pattern interface for per-category processing
 */
export interface BackfillCategoryProcessor {
  /** 対象カテゴリ（`Record` キーと一致させる） / target category */
  readonly category: EmbeddingBackfillCategory;
  /**
   * Screenshot が必要か（`part_visual` / `section_visual` → true）
   * Whether a persisted screenshot is required (true for `part_visual` / `section_visual`)
   */
  requiresScreenshot(): boolean;
  /**
   * メイン処理 — 生成件数 / 失敗件数 / memorySkip を返す
   * Main processor — returns generated / failed / memorySkips
   */
  process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult>;
}

// =====================================================
// Progress helper — linear 10 → 90 interpolation
// =====================================================

function makeOnProgress(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): (type: string, done: number, total: number) => void {
  return (_type, done, total) => {
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    const pct =
      PROGRESS_AFTER_FETCH + Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
    job.updateProgress(pct).catch(() => {
      /* fire-and-forget — progress reporting is best-effort */
    });
  };
}

// =====================================================
// Fork-or-Fallback shared helper — PR7e-β4 PR2d (HIGH-α)
// =====================================================

/**
 * Shared fork-or-fallback helper used by every category Processor.
 *
 * v0.4.0 PR7e-β4 PR2d (HIGH-α): PR2b-β で `JsAnimationProcessor.processViaFork`
 * (~70 LOC) として canary 限定で実装されていたロジックを 7 全 category で
 * 再利用するために抽出。`EMBEDDING_BACKFILL_FORK_ENABLED=true` のときのみ
 * fork orchestrator 経由で `child_process.fork()` を起動し、ONNX Runtime を
 * isolate する (ADR-0015)。各 Processor は本 helper を 1 行呼び出すだけで、
 * SEC-M-3 fail-open / TPA-H-1 observability 対称性 / TPA-M-2 fallback 再帰
 * セマンティクスを継承する。
 *
 * PR2d (HIGH-α): Extracted from `JsAnimationProcessor.processViaFork` (~70
 * LOC, PR2b-β canary-only) so all 7 categories reuse it. Each Processor calls
 * the helper in a single line and inherits SEC-M-3 fail-open, TPA-H-1
 * observability symmetry, and TPA-M-2 fallback recursion semantics.
 *
 * ## Saved invariants / 継承不変条件
 *
 * - **SEC-M-3 fail-open**: dynamic import / orchestrator 読み込み / fork 実行時
 *   失敗 → `inProcessFallback()` 呼び出しで Job 完走 (ADR-0015 §SEC-M-3)。
 * - **TPA-H-1 observability**: fork child の `backfill.done` IPC から
 *   failedCount / memorySkipCount / errors を取得し BackfillCategoryResult に
 *   伝搬する (in-process 経路と対称化)。
 * - **TPA-M-2 fallback recursion**: `inProcessFallback()` が再度 throw した
 *   場合は BullMQ Worker へ伝搬し、`attempts=3` retry + DLQ (ADR-0007) に委譲。
 * - **PII protection invariant (ADR-0015 Amendment 8 LCC-H-1)**: catch 経路の
 *   `sanitizeErrorMessage(error)` は CWE-209 PII 漏洩を防止。新 category
 *   Processor は本 helper 経由で自動的に同 invariant を継承する。
 */
/**
 * Plan v4.5 PR3 Track 2 §4.2.2: resolve the supervisor boot epoch the Layer 2
 * worker shares with its parent supervisor (Layer 1). The supervisor injects a
 * per-type boot token UUID; we use the backfill boot token as the bootEpoch so
 * per-job locks store an own-origin marker that the supervisor's
 * `cleanupOrphanPerJobLocks()` can verify (CWE-367 double-verify). Falls back to
 * a fresh UUID when unset (manual-worker path), which is conservatively never
 * matched by the supervisor's own bootEpoch (so manual locks are never
 * auto-deleted by a foreign supervisor).
 *
 * Layer 2 worker が parent supervisor (Layer 1) と共有する boot epoch を解決する
 * (§4.2.2)。supervisor 注入の per-type boot token を bootEpoch として使う。
 */
function resolveSupervisorBootEpoch(): string {
  const injected =
    process.env["REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_BACKFILL"] ??
    process.env["REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN"];
  return injected !== undefined && injected !== "" ? injected : randomUUID();
}

/**
 * Plan v4.5 PR3 Track 2 §4.2.1: emit the appropriate audit_logs action for a
 * fail-closed per-job lock acquire result. Returns the lock nonce + bootEpoch
 * on success so the caller can release the lock after the sub-child exits.
 *
 * §4.2.1: per-job lock acquire 結果に応じた audit_logs を emit し、success 時は
 * release 用の nonce + bootEpoch を返す。
 *
 * @returns `{ ok: true, nonce, bootEpoch }` on acquire; `{ ok: false, failOpen }`
 *   otherwise (caller decides spawn vs retry vs fail-open per discriminated union).
 */
async function acquirePerJobLockWithAudit(
  jobId: string,
  category: EmbeddingBackfillCategory
): Promise<{ ok: true; nonce: string; bootEpoch: string } | { ok: false; failOpen: boolean }> {
  const nonce = randomUUID();
  const bootEpoch = resolveSupervisorBootEpoch();
  const lockService = new WorkerActiveLockService();
  const actor = getWorkerActorName("embedding-backfill");
  try {
    // Boot-time pin is idempotent (SCRIPT LOAD on an already-cached SHA is a
    // no-op); pinning here guarantees EVALSHA resolves on first acquire.
    await lockService.pinLuaScripts();
    const result: PerJobAcquireLockResult = await lockService.acquirePerJobSubChildLock(
      jobId,
      nonce,
      bootEpoch
    );
    switch (result.ok) {
      case true:
        await emitForkLockAudit(actor, AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_ACQUIRED, jobId, {
          category,
          result: "success",
        });
        return { ok: true, nonce, bootEpoch };
      case false:
        return await handleForkLockFailure(actor, result, jobId, category);
    }
  } catch (error) {
    // Defensive: pin / acquire threw unexpectedly → fail-open (SEC-M-3).
    logger.warn("[EmbeddingBackfill] per-job lock acquire threw (fail-open)", {
      jobId: truncateId(jobId),
      error: sanitizeErrorMessage(error),
    });
    return { ok: false, failOpen: true };
  } finally {
    void lockService.close().catch(() => {
      /* best-effort */
    });
  }
}

/** §4.2.1: emit the fail-closed / fail-open audit for a non-ok acquire result. */
async function handleForkLockFailure(
  actor: string,
  result: Extract<PerJobAcquireLockResult, { ok: false }>,
  jobId: string,
  category: EmbeddingBackfillCategory
): Promise<{ ok: false; failOpen: boolean }> {
  switch (result.reason) {
    case "rate_limited":
      await emitForkLockAudit(
        actor,
        AUDIT_ACTION_WORKER_SUB_CHILD_SPAWN_RATE_LIMIT_VIOLATED,
        jobId,
        {
          category,
          retryAfterMs: result.retryAfterMs,
          result: "denied",
        }
      );
      return { ok: false, failOpen: false };
    case "race_lost":
      await emitForkLockAudit(actor, AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_RACE_LOST, jobId, {
        category,
        result: "denied",
      });
      return { ok: false, failOpen: false };
    case "redis_unreachable":
      await emitForkLockAudit(actor, AUDIT_ACTION_WORKER_LOCK_SERVICE_UNREACHABLE, jobId, {
        category,
        result: "failure",
      });
      return { ok: false, failOpen: true };
    default: {
      // Exhaustiveness gate (`never`): a new fail reason without a branch is a
      // compile-time error. Reaching here at runtime is impossible; fail-open.
      const _exhaustive: never = result;
      void _exhaustive;
      return { ok: false, failOpen: true };
    }
  }
}

/** Best-effort audit emit for per-job fork lock events (PII-safe targetId). */
async function emitForkLockAudit(
  actor: string,
  action: string,
  jobId: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    await getAuditLogService().log({
      action,
      actor,
      targetType: "worker",
      targetId: truncateId(jobId, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH),
      details,
      result: (details["result"] as "success" | "failure" | "denied" | undefined) ?? "success",
    });
  } catch {
    // AuditLogService.log() logs its own warn; best-effort emit.
  }
}

/** §5.3: emit `worker_config_legacy_env_var_detected` once on legacy-flag drift. */
async function emitLegacyEnvVarDetectedAudit(category: EmbeddingBackfillCategory): Promise<void> {
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_WORKER_CONFIG_LEGACY_ENV_VAR_DETECTED,
      actor: AUDIT_ACTOR_WORKER_CONFIG_VALIDATOR,
      targetType: "worker",
      targetId: "embedding-backfill",
      details: { category, result: "success" },
      result: "success",
    });
  } catch {
    // best-effort emit (observability of stale-config deployments).
  }
}

/**
 * Per-job lock handle returned by {@link resolvePerJobLockHandle} on success or
 * fail-open. `null` handle = no lock held (fail-open redis_unreachable path);
 * release is then a no-op.
 *
 * Plan v4.5 PR3 Track 2 §4.3 per-job lock handle。`null` は fail-open 経路。
 */
type PerJobLockHandle = { nonce: string; bootEpoch: string };

/**
 * Plan v4.5 PR3 Track 2 §4.3 / §4.2.1: acquire the per-job sub-child lock and
 * map the discriminated-union outcome to one of three caller dispositions.
 *
 * Extracted from `runForkOrFallback` (FIND-IMPL-TDA-PR3-CC) to keep the host
 * function's cyclomatic complexity ≤ 10. The outcome union below preserves the
 * exact fail-open / fail-closed contract:
 *   - `proceed` + non-null handle → lock acquired (release after sub-child exit)
 *   - `proceed` + null handle     → fail-open (redis_unreachable, SEC-M-3)
 *   - `fallback`                  → fail-closed (rate_limited / race_lost): do
 *                                   NOT spawn this dispatch; in-process completes
 *
 * §4.2.1: per-job lock acquire 結果を 3 disposition に map する helper。
 */
async function resolvePerJobLockHandle(
  jobId: string,
  category: EmbeddingBackfillCategory
): Promise<
  { disposition: "proceed"; handle: PerJobLockHandle | null } | { disposition: "fallback" }
> {
  const lockOutcome = await acquirePerJobLockWithAudit(jobId, category);
  if (lockOutcome.ok) {
    return {
      disposition: "proceed",
      handle: { nonce: lockOutcome.nonce, bootEpoch: lockOutcome.bootEpoch },
    };
  }
  if (lockOutcome.failOpen) {
    // failOpen (redis_unreachable) → proceed without a lock handle (no release).
    return { disposition: "proceed", handle: null };
  }
  // Fail-closed (rate_limited / race_lost): do NOT spawn a sub-child this
  // dispatch. In-process fallback keeps the job completing without violating
  // the rate-limit; BullMQ will redistribute subsequent jobs across the
  // interval window.
  return { disposition: "fallback" };
}

/**
 * Fix-2 (INFRA-EMBEDDING-MOTION-SIGABRT-001): dispose the parent Worker Thread's
 * ONNX session BEFORE fork() so the child does not inherit a mid-inference
 * native pthread state via copy-on-write. ONNX Runtime's pthread COW inheritance
 * is the same race that drives Fix-1; pre-fork dispose is the parent-side
 * complement that prevents SIGABRT during the fork-orchestrator handoff.
 *
 * Best-effort: dispose failure must never block the fork (SEC-M-3 fail-open
 * semantics; the in-process fallback path remains the safety net).
 *
 * Observability (TPA-MOTION-02 M): emit `pre_fork_dispose_duration_ms` so future
 * regressions where dispose stalls (>500ms warn threshold) surface in logs.
 *
 * Extracted from `runForkOrFallback` (FIND-IMPL-TDA-PR3-CC) to keep the host
 * function's cyclomatic complexity ≤ 10.
 *
 * Cross-ref: IO §13.16.4 Plan Decision (Fix-2 co-landing with Fix-1),
 *            ADR-0015 §SEC-M-3 fail-open.
 */
async function disposeParentOnnxBeforeFork(): Promise<void> {
  const preForkDisposeStart = Date.now();
  try {
    const { embeddingService: mlEmbeddingService } = await import("@reftrixmcp/ml");
    await mlEmbeddingService.dispose();
  } catch (error) {
    // Best-effort: do not block fork on dispose failure.
    logger.warn("[EmbeddingBackfill] pre-fork dispose failed (non-fatal)", {
      finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
      error: sanitizeErrorMessage(error),
    });
  }
  const preForkDisposeDurationMs = Date.now() - preForkDisposeStart;
  if (preForkDisposeDurationMs > 500) {
    // Slow-dispose sentinel (TPA-MOTION-02): >500ms warn for future regression
    // detection. Threshold derived from typical ONNX session teardown < 200ms;
    // 500ms suggests a stuck session (potential dispose-time race).
    logger.warn("[EmbeddingBackfill] pre-fork dispose slow", {
      finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
      pre_fork_dispose_duration_ms: preForkDisposeDurationMs,
      threshold_ms: 500,
    });
  }
}

/**
 * Execute the fork orchestrator and map its IPC result to a
 * {@link BackfillCategoryResult}. TPA-H-1 observability symmetry: propagate
 * failedCount / memorySkipCount / errors from the fork child's `backfill.done`
 * IPC into the in-process-shaped result.
 *
 * Extracted from `runForkOrFallback` (FIND-IMPL-TDA-PR3-CC) to keep the host
 * function's cyclomatic complexity ≤ 10. Throws on fork failure so the caller's
 * catch routes to in-process fallback (SEC-M-3 + TPA-M-2).
 */
async function executeForkAndMapResult(
  category: EmbeddingBackfillCategory,
  ctx: BackfillProcessContext
): Promise<BackfillCategoryResult> {
  const { runEmbeddingBackfillFork, BACKFILL_EXTEND_LOCK_DURATION_MS } =
    await import("../workers/phases/embedding-backfill-fork-orchestrator.js");
  const jobToken = ctx.job.token;
  const forkResult = await runEmbeddingBackfillFork({
    jobId: String(ctx.job.id),
    webPageId: ctx.webPageId,
    category,
    // TPA-M-1 (PR2b-β audit): Single source of truth — see
    // `BACKFILL_PARTS_LIMIT_DEFAULT` in embedding-backfill-ipc.ts.
    // TPA-M-1 (PR2b-β 監査): ADR-0007 head-100 contract の single source。
    partsLimit: BACKFILL_PARTS_LIMIT_DEFAULT,
    onProgress: async (processed: number, total: number): Promise<void> => {
      await ctx.job.updateProgress({ processed, total });
    },
    // BullMQ `job.extendLock(token, duration)` requires the worker's lock
    // token. When `ctx.job.token` is undefined (e.g. Job manufactured outside
    // a Worker context) we skip relay; orchestrator heartbeat + SIGKILL
    // escalation handles the stuck case.
    //
    // BullMQ の `job.extendLock(token, duration)` は Worker 由来の token が
    // 必要。`ctx.job.token` 未定義時は relay を skip する。stall 対応は
    // orchestrator 側 heartbeat / SIGKILL に委譲。
    extendLock: async (): Promise<void> => {
      if (jobToken) {
        await ctx.job.extendLock(jobToken, BACKFILL_EXTEND_LOCK_DURATION_MS);
      }
    },
  });
  return {
    category,
    generated: forkResult.processedCount,
    failed: forkResult.failedCount ?? 0,
    memorySkips: forkResult.memorySkipCount ?? 0,
    errors: forkResult.errors ?? [],
  };
}

/**
 * Plan v4.5 PR3 Track 2 §4.3: explicit per-job lock release after the sub-child
 * has exited (success OR fork-failure). A `null` handle (fail-open path) is a
 * no-op. Sub-child SIGKILL before release is covered by the 60s TTL
 * auto-release (§5.1). nonce + bootEpoch double-verify (§4.2.2) prevents
 * deleting a later owner's lock.
 *
 * Extracted from `runForkOrFallback` (FIND-IMPL-TDA-PR3-CC) to keep the host
 * function's cyclomatic complexity ≤ 10.
 */
async function releasePerJobLock(jobId: string, handle: PerJobLockHandle | null): Promise<void> {
  if (handle === null) {
    return;
  }
  const releaseService = new WorkerActiveLockService();
  try {
    await releaseService.releasePerJobSubChildLock(jobId, handle.nonce, handle.bootEpoch);
  } catch (releaseError) {
    logger.warn("[EmbeddingBackfill] per-job lock release failed (non-fatal, TTL covers)", {
      jobId: truncateId(jobId),
      error: sanitizeErrorMessage(releaseError),
    });
  } finally {
    void releaseService.close().catch(() => {
      /* best-effort */
    });
  }
}

async function runForkOrFallback(
  category: EmbeddingBackfillCategory,
  ctx: BackfillProcessContext,
  inProcessFallback: () => Promise<BackfillCategoryResult>,
  loggerLabel: string
): Promise<BackfillCategoryResult> {
  // Plan v4.5 PR3 Track 2 §5.3: resolve fork mode via SSOT resolver (new flag
  // wins; default true). Emit `worker_config_legacy_env_var_detected` when a
  // legacy deployment still sets `EMBEDDING_BACKFILL_FORK_ENABLED`.
  const forkMode = resolveForkMode(process.env);
  if (forkMode.shouldEmitLegacyDetected) {
    await emitLegacyEnvVarDetectedAudit(category);
  }

  if (!forkMode.forkOnlyMode) {
    // §4.2 LEGACY FALLBACK (new flag explicitly false): runtime guard. The
    // in-process path is obsoleted by Plan v4.5 PR3; we still preserve the
    // catch-block fallback for SEC-M-3 fail-open. Operators who explicitly opt
    // out get the legacy in-process path so rollback (L1) remains available.
    logger.warn(`[${loggerLabel}] fork-only mode disabled (legacy in-process fallback active)`, {
      finding: "PLAN-V4.5-PR3-TRACK2",
    });
    return inProcessFallback();
  }

  // Plan v4.5 PR3 Track 2 §4.3: acquire per-job sub-child lock (Lua atomic
  // ≥500ms server-side rate-limit) BEFORE forking. Discriminated union (§4.2.1)
  // is resolved in `resolvePerJobLockHandle`: `fallback` disposition → in-process
  // (fail-closed); `proceed` → spawn with an optional release handle.
  const jobId = String(ctx.job.id);
  const lockDecision = await resolvePerJobLockHandle(jobId, category);
  if (lockDecision.disposition === "fallback") {
    return inProcessFallback();
  }
  const lockHandle = lockDecision.handle;

  await disposeParentOnnxBeforeFork();

  try {
    return await executeForkAndMapResult(category, ctx);
  } catch (error) {
    // SEC-M-3 + TPA-M-2: fall back to in-process so the Job completes; no
    // further automatic fallback (errors propagate to BullMQ retry / DLQ).
    // SEC-M-3 + TPA-M-2: in-process fallback で Job を完走させる。さらなる
    // 自動 fallback は無し (BullMQ retry / DLQ に委譲)。
    // Canary runbook は本 warn の発火頻度を監視し、非ゼロ継続時は
    // fork-only mode を即 rollback すること (L1: EMBEDDING_BACKFILL_FORK_ONLY_MODE_ENABLED=false)。
    logger.warn(`[${loggerLabel}] Fork path unavailable, falling back to in-process`, {
      error: sanitizeErrorMessage(error),
    });
    return inProcessFallback();
  } finally {
    await releasePerJobLock(jobId, lockHandle);
  }
}

/**
 * PR-B (Plan §7.2 / §7.5): backfill section fallback re-capture URL を DB
 * (`web_pages.url`) から取得する。`url: ""` を `runVisualEmbeddingSubPhases` に渡すと
 * `captureSectionScreenshots` の SSRF 検証 (`validateExternalUrl("")`) で fallback が
 * 不能になるため、section_visual processor は本 helper で実 URL を解決する。
 * 失敗 (DB error / URL 未記録) 時は空文字を返し、fallback は事実上 inert になる
 * (Graceful Degradation — bounded budget で後続 terminal 収束)。
 *
 * PR-B (Plan §7.2 / §7.5): fetch the section-fallback re-capture URL from the DB
 * (`web_pages.url`). Passing `url: ""` would make `captureSectionScreenshots` SSRF-reject
 * and render the fallback inert, so the section_visual processor resolves the real URL via
 * this helper. On failure (DB error / no URL recorded) returns "" (fallback inert,
 * Graceful Degradation; the bounded budget converges to a terminal later).
 */
async function fetchWebPageUrlForFallback(webPageId: string): Promise<string> {
  try {
    const row = await sharedPrismaClient.webPage.findUnique({
      where: { id: webPageId },
      select: { url: true },
    });
    return row?.url ?? "";
  } catch (dbError) {
    logger.warn("[SectionVisualProcessor] Failed to fetch URL for section fallback", {
      error: sanitizeErrorMessage(dbError),
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    });
    return "";
  }
}

// =====================================================
// Processors — per-category implementations
// =====================================================

class PartTextProcessor implements BackfillCategoryProcessor {
  readonly category = "part_text" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "PartTextProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillPartTextForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class PartVisualProcessor implements BackfillCategoryProcessor {
  readonly category = "part_visual" as const;

  requiresScreenshot(): boolean {
    return true;
  }

  /**
   * v0.4.0 PR7e-β4 PR2d (HIGH-β + LCC-M-2): fork-or-fallback dispatch.
   *
   * `EMBEDDING_BACKFILL_FORK_ENABLED=true` のときは `runForkOrFallback` 経由で
   * fork orchestrator を試行する。child 側 dispatch switch は `part_visual`
   * を意図的に throw する (DINOv2 + Playwright bbox flow を要するため、
   * service-layer wrapper `backfillPartVisualsForPage` 未実装、PR3b で対応予定)。
   * その結果 helper の catch 経路が `processInProcess` (既存ロジック) に
   * fallback し、Job は完走する。これにより future PR3b で service wrapper を
   * 実装した時点で fork 経路に乗り、本 Processor は再変更不要となる。
   *
   * PR2d (HIGH-β + LCC-M-2): When the flag is on, `runForkOrFallback` attempts
   * the fork path; the child dispatch deliberately throws for `part_visual`
   * (heavy DINOv2 + Playwright bbox flow not yet wrapped in the service layer
   * — tracked for PR3b). Helper catch routes to `processInProcess`, so the Job
   * still completes. PR3b's service-layer addition will then activate fork
   * automatically without further Processor changes.
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "PartVisualProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // Screenshot 無しは Graceful Degradation（0 件成功扱い）
    // No screenshot → Graceful Degradation (treat as 0 processed)
    if (!ctx.screenshotStoragePath) {
      return this.emptyResult();
    }

    // v0.4.0 PR7e-α (バグ② fix): requiresBboxResolution が true の場合、
    // Part bbox を Playwright で再解決してから Visual Embedding を生成する。
    // 従来は Phase 5 と IPC race で bbox 未解決のまま放置されており、
    // part_visual embedding 生成 silent skip の原因だった。
    //
    // v0.4.0 PR7e-α (bug ② fix): when requiresBboxResolution is true,
    // re-resolve Part bboxes via Playwright before generating visual
    // embeddings. Previously the bboxes were left unresolved due to an IPC
    // race with Phase 5, causing part_visual embeddings to be silently skipped.
    if (ctx.job.data.requiresBboxResolution === true) {
      const bboxOutcome = await this.resolveAndPersistBboxes(ctx);
      if (bboxOutcome !== null) {
        return bboxOutcome; // ssrf_blocked_on_backfill 等の早期リターン
      }
    }

    const { pendingCount } = await countPartVisualBackfillTargets(ctx.webPageId);
    if (pendingCount === 0) {
      return this.emptyResult();
    }

    if (!ctx.prisma) {
      return {
        category: this.category,
        generated: 0,
        failed: pendingCount,
        memorySkips: 0,
        errors: [`part_visual: prisma client unavailable`],
      };
    }

    // PR-B (Plan §7.2 / §7.5 / FIND-RE-LCC-01): backfill 経路で section fallback を
    // 有効化する。off-screen part は truncated-origin として `screenshot_truncated`
    // bounded-retryable に分類され、実 generation 手段は section 単位の Playwright
    // re-capture (part は所属 section の再capture で croppable になる) + bounded budget
    // 収束に束ねられる。再capture URL を DB から取得 (`url: ""` だと SSRF 検証で fallback
    // 不能) し、robots.txt 再評価を有効化する (FIND-RE-LCC-01: backfill は非同期別オペで
    // Phase 0 robots 検証が stale)。
    //
    // PR-B (Plan §7.2 / §7.5 / FIND-RE-LCC-01): enable the section fallback on the backfill
    // path. Fetch the re-capture URL from the DB (`url: ""` would fail SSRF validation and
    // make the fallback inert) and enable robots.txt re-evaluation.
    const pageUrlForFallback = (await this.fetchPageUrlForBboxResolve(ctx.webPageId)) ?? "";
    const dinov2ModelPath = resolveDinov2ModelPath();
    const subResult = await runVisualEmbeddingSubPhases({
      webPageId: ctx.webPageId,
      url: pageUrlForFallback,
      screenshotPngPath: ctx.screenshotStoragePath,
      sectionIdMapping: new Map<string, string>(),
      partsSavedCount: pendingCount,
      layoutResultJson: null,
      fallbackEnabled: true,
      recheckRobotsTxt: true,
      // backfill job data は respectRobotsTxt override を持たないため undefined を渡し、
      // env flag `REFTRIX_RESPECT_ROBOTS_TXT` (既定有効) に従う。backfill はデフォルトで
      // robots.txt を尊重する (FIND-RE-LCC-01 compliance default)。
      // The backfill job data carries no respectRobotsTxt override, so pass undefined and
      // follow the env flag `REFTRIX_RESPECT_ROBOTS_TXT` (default enabled) — backfill
      // respects robots.txt by default.
      respectRobotsTxt: undefined,
      dinov2ModelPath,
      prisma: ctx.prisma,
      onLockExtend: (_label: string) => {
        // Worker lockDuration が十分に長いので明示的な extendLock は不要
        // Lock duration is long enough — no explicit extension needed
      },
      onProgress: (completed: number, total: number) => {
        const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
        const pct =
          PROGRESS_AFTER_FETCH +
          Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
        ctx.job.updateProgress(pct).catch(() => {
          /* fire-and-forget */
        });
      },
    });

    return {
      category: this.category,
      generated: subResult.partVisualEmbeddingsGenerated,
      failed: subResult.embeddingFailedChunks,
      memorySkips: 0,
      errors: [],
    };
  }

  /**
   * Part bbox を Playwright で後付け解決する。
   *   - URL は DB (`web_pages.url`) から取得し、`resolvePartBoundingBoxesWithFallback`
   *     で SSRF 再検証 + LaunchSemaphore + 既存サービス delegate を実行する。
   *   - SSRF ブロック時は `skipReason=ssrf_blocked_on_backfill` で早期 return。
   *   - URL 取得失敗や bbox 解決失敗は non-fatal — null を返して呼び出し側で
   *     通常の visual embedding パスに進む (Graceful Degradation)。
   *
   * Returns a final BackfillCategoryResult on early-exit (SSRF block), or
   * null to indicate the caller should proceed with the standard visual
   * embedding path.
   */
  // Plan v2 PR-C (FIND-IMPL-TDA-PR3-CC-CARRYOVER closure, UB-4): refactored from
  // CC=17 to CC≤10 by extracting (1) the URL fetch + early-return branches into
  // `fetchPageUrlForBboxResolve` and (2) the residual audit-emit branch into
  // `emitResidualBboxSkipAudit` (mirrors the PR3 runForkOrFallback split). The
  // inline `eslint-disable complexity` is REMOVED so the file-scoped
  // `complexity: ["error", 10]` gate machine-enforces the bound.
  private async resolveAndPersistBboxes(
    ctx: BackfillProcessContext
  ): Promise<BackfillCategoryResult | null> {
    const pageUrl = await this.fetchPageUrlForBboxResolve(ctx.webPageId);
    if (!pageUrl) {
      return null; // fall through to standard path (no URL / DB error logged in helper)
    }

    // PR-G1 RC1 (SEC-05): scroll sweep の各 iteration 境界で backfill job の lock を
    // 延長する。`ctx.job.token` 未定義時 (Worker 外で manufacture された Job) は
    // relay を skip — stall 対応は Worker lockDuration / heartbeat に委譲 (既存の
    // executeForkAndMapResult の extendLock relay と同パターン)。
    // Extend the backfill job lock at each scroll-sweep iteration boundary.
    // Skips relay when `ctx.job.token` is undefined (mirrors the existing
    // executeForkAndMapResult extendLock relay).
    const bboxJobToken = ctx.job.token;
    const onBboxLockExtend = async (): Promise<void> => {
      if (bboxJobToken) {
        await ctx.job.extendLock(bboxJobToken, BBOX_SWEEP_EXTEND_LOCK_DURATION_MS);
      }
    };

    try {
      const bboxResult = await resolvePartBoundingBoxesWithFallback({
        webPageId: ctx.webPageId,
        url: pageUrl,
        prisma: sharedPrismaClient,
        sharedBrowser: null,
        onLockExtend: onBboxLockExtend,
        // validateUrl は default (再検証あり) — SEC HIGH-1 / PR7e-α
      });

      if (bboxResult.ssrfBlocked) {
        logger.warn("[PartVisualProcessor] SSRF re-validation blocked bbox resolution (backfill)", {
          webPageId: truncateId(ctx.webPageId, 8),
        });
        return {
          category: this.category,
          generated: 0,
          failed: 0,
          memorySkips: 0,
          errors: ["part_visual: SSRF re-validation blocked URL on backfill"],
          skipReason: "ssrf_blocked_on_backfill",
        };
      }

      logger.info("[PartVisualProcessor] Resolved Part bboxes on backfill", {
        webPageId: truncateId(ctx.webPageId, 8),
        resolvedCount: bboxResult.resolvedCount,
        skippedCount: bboxResult.skippedCount,
        reloadCount: bboxResult.reloadCount ?? 0,
        reloadTotalTimeMs: bboxResult.reloadTotalTimeMs ?? 0,
        reloadBudgetExhausted: bboxResult.reloadBudgetExhausted ?? false,
      });

      await this.emitResidualBboxSkipAudit(ctx.webPageId, bboxResult);

      // PR-BT-4 (ADR-0018 Amendment 10 Decision 10.2; design V1 §4.3.1) — gap B:
      // in addition to the GDPR Art.30 audit emit above, write the per-row
      // Layer-1 `visual_skip_reason='bbox_unresolvable'` marker for residual
      // bbox-zero pending parts so they leave the part_visual pending query and
      // the page can reach `completed`. Layer-2 NON-propagation (TPA-H-01 / U2):
      // this is a per-row marker ONLY — we deliberately do NOT set a run-level
      // `skipReason` here and STILL `return null` (fall-through to the standard
      // path), so the residual skip is never routed to the `skipped_fork_error`
      // retry bucket. The helper is data-driven + non-fatal (no-op when there are
      // no residual rows). Pinned by INV-BACKFILL-PART-RESIDUAL-MARKER-009.
      await this.markResidualBboxUnresolvableMarkers(ctx.webPageId);
    } catch (resolveError) {
      // Non-fatal — proceed to standard visual embedding path with whatever
      // bboxes are already in the DB.
      logger.warn("[PartVisualProcessor] bbox resolution failed (non-fatal)", {
        error: sanitizeErrorMessage(resolveError),
        webPageId: ctx.webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      });
    }
    return null;
  }

  /**
   * PR-BT-4 (ADR-0018 Amendment 10 Decision 10.2): write the Layer-1
   * `visual_skip_reason='bbox_unresolvable'` per-row markers for residual
   * bbox-zero pending parts, delegating to the SSOT writer in phase-5-embedding
   * (`markResidualBboxUnresolvableParts`). Layer-1 ONLY — the caller keeps the
   * `return null` fall-through so no run-level `skipReason` is propagated
   * (Layer-2 non-propagation, TPA-H-01 / U2). Failure is non-fatal (logged).
   */
  private async markResidualBboxUnresolvableMarkers(webPageId: string): Promise<void> {
    try {
      const marked = await markResidualBboxUnresolvableParts(sharedPrismaClient, webPageId);
      if (marked > 0) {
        logger.info("[PartVisualProcessor] wrote residual bbox_unresolvable markers (backfill)", {
          webPageId: truncateId(webPageId, 8),
          markedCount: marked,
        });
      }
    } catch (markerError) {
      logger.warn(
        "[PartVisualProcessor] residual bbox_unresolvable marker write failed (non-fatal)",
        {
          error: sanitizeErrorMessage(markerError),
          webPageId: truncateId(webPageId, 8),
        }
      );
    }
  }

  /**
   * Plan v2 PR-C (FIND-IMPL-TDA-PR3-CC-CARRYOVER): extract the URL fetch +
   * early-return branches from `resolveAndPersistBboxes` (CC reduction).
   *
   * @returns the page URL, or `null` when there is no URL recorded OR the DB
   *   read failed (both cases mean "skip bbox resolution, fall through to the
   *   standard path"). The DB error / no-URL log lines are emitted here.
   */
  private async fetchPageUrlForBboxResolve(webPageId: string): Promise<string | null> {
    let pageUrl: string | null = null;
    try {
      const row = await sharedPrismaClient.webPage.findUnique({
        where: { id: webPageId },
        select: { url: true },
      });
      pageUrl = row?.url ?? null;
    } catch (dbError) {
      logger.warn("[PartVisualProcessor] Failed to fetch URL for bbox resolution", {
        error: sanitizeErrorMessage(dbError),
        webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      });
      return null; // fall through to standard path
    }

    if (!pageUrl && process.env["NODE_ENV"] !== "production") {
      logger.info("[PartVisualProcessor] No URL recorded; skipping bbox resolution", {
        webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      });
    }
    return pageUrl;
  }

  /**
   * Plan v2 PR-C (FIND-IMPL-TDA-PR3-CC-CARRYOVER): extract the residual
   * `embedding_part_visual_skipped` audit-emit branch from
   * `resolveAndPersistBboxes` (CC reduction).
   *
   * PR-D-9 Wave 4 (C-04 + C-06 / ADR-0018 §Decision 1 Supplement S3 + S4): emit
   * one `embedding_part_visual_skipped` audit_logs entry per residual unresolved
   * part when (a) reload budget was exhausted, OR (b) the reload pass is disabled
   * but parts remain unresolved after the 1st pass. GDPR Art.30 audit trail:
   * action SSOT constant + `details.skipReason='bbox_unresolvable'`. PII:
   * `targetId` is `truncateTargetId()`-truncated by `AuditLogService.log()`.
   * Audit emit failure is non-fatal (logged, never halts backfill).
   */
  private async emitResidualBboxSkipAudit(
    webPageId: string,
    bboxResult: {
      skippedCount: number;
      resolvedCount: number;
      reloadCount?: number;
      reloadTotalTimeMs?: number;
      reloadBudgetExhausted?: boolean;
    }
  ): Promise<void> {
    if (bboxResult.skippedCount <= 0) return;

    const classification = classifyBboxFailure(
      bboxResult.reloadBudgetExhausted ? "dom_disposed" : "default"
    );
    try {
      await getAuditLogService().log({
        action: AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
        actor: AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER,
        targetType: "web_page",
        targetId: webPageId,
        details: {
          skipReason: classification.skipReason,
          skippedCount: bboxResult.skippedCount,
          resolvedCount: bboxResult.resolvedCount,
          reloadCount: bboxResult.reloadCount ?? 0,
          reloadTotalTimeMs: bboxResult.reloadTotalTimeMs ?? 0,
          reloadBudgetExhausted: bboxResult.reloadBudgetExhausted ?? false,
        },
        result: "failure",
      });
    } catch (auditError) {
      // Audit emit failure must NOT halt backfill. Logged only.
      logger.warn("[PartVisualProcessor] audit_logs emit failed (non-fatal)", {
        error: sanitizeErrorMessage(auditError),
        webPageId: truncateId(webPageId, 8),
      });
    }
  }

  /** 空結果 (Graceful Degradation) — 共通化で complexity 削減 */
  private emptyResult(): BackfillCategoryResult {
    return {
      category: this.category,
      generated: 0,
      failed: 0,
      memorySkips: 0,
      errors: [],
    };
  }
}

class SectionVisualProcessor implements BackfillCategoryProcessor {
  readonly category = "section_visual" as const;

  requiresScreenshot(): boolean {
    // Section vision embedding は DINOv2 を使うため screenshot 必須（PR7b で
    // DINOv2 再生成パスを統合）。Worker は `web_pages.screenshotStoragePath`
    // から allowlist + realpath 検証済みパスを ctx に伝搬する。
    //
    // Section vision embeddings require DINOv2 → screenshot mandatory (PR7b
    // integrates the DINOv2 regeneration path). The Worker propagates the
    // allowlist + realpath-validated screenshot path via ctx.
    return true;
  }

  /**
   * v0.4.0 PR-BT-3 (FIND 019e5a11): fork-or-fallback dispatch, symmetric with
   * `PartVisualProcessor`. When fork-only mode is active, `runForkOrFallback`
   * attempts the fork path; the child dispatch deliberately THROWS for
   * `section_visual` (the heavy DINOv2 + `writeSectionVisionSkipReason` terminal-
   * skip marker flow is not yet wrapped in the service layer — tracked for PR3b).
   * The helper's catch routes to `processInProcess`, which runs the DINOv2 path
   * (`runVisualEmbeddingSubPhases({ fallbackEnabled: false })`) and writes the
   * PR-BT-2 terminal-skip marker — so a page with uncroppable/duplicate sections
   * reaches `section_visual` pending=0 and the Job completes.
   *
   * Pre-PR-BT-3 the child returned a text-only `backfillSectionVisualsForPage`
   * SUCCESS, so the fork result short-circuited the catch-fallback and the
   * in-process marker path was NEVER reached in production fork-only mode (the
   * PR-BT-2 goal 未達 root cause). PR3b's service-layer wrapper will then activate
   * fork automatically without further Processor changes.
   *
   * PR-BT-3 (FIND 019e5a11): `PartVisualProcessor` と対称。fork 経路では child
   * dispatch が `section_visual` を意図的に throw し (DINOv2 + 終端 marker flow が
   * service layer 未実装、PR3b で対応)、helper catch が `processInProcess` に
   * fallback して in-process DINOv2 + PR-BT-2 marker path を走らせる。pre-PR-BT-3
   * は text-only success を返し marker path に未到達だった (PR-BT-2 goal 未達)。
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "SectionVisualProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // 1) Text-side recovery（既存パス）
    //    section_embeddings レコードそのものが存在しない section の text embedding
    //    を補完する。0 件の場合でも非エラー（後続の DINOv2 パスへ進む）。
    //
    // 1) Text-side recovery (existing path)
    //    Backfill text embeddings for sections that have no `section_embeddings`
    //    row at all. Returning 0 here is non-error — we still proceed to DINOv2.
    const textResult = await backfillSectionVisualsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });

    // 2) Screenshot 無しは DINOv2 パスを Graceful Degradation でスキップ
    //    text 側の生成数のみ返す。
    //
    // 2) Skip the DINOv2 path with Graceful Degradation when no screenshot.
    //    Return only the text-side count.
    if (!ctx.screenshotStoragePath) {
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed,
        memorySkips: textResult.memorySkips,
        errors: textResult.errors,
      };
    }

    // 3) DINOv2 で vision_embedding を再生成する対象を集計
    //    text_embedding が既に存在し vision_embedding が NULL の section が対象。
    //    PII フィルタ（piiRiskLevel='high' を含む section の除外）は
    //    `runVisualEmbeddingSubPhases` 内で適用される。
    //
    // 3) Count DINOv2 regeneration candidates.
    //    Sections with text_embedding present and vision_embedding NULL.
    //    PII filter (excluding sections containing piiRiskLevel='high' parts)
    //    is applied inside `runVisualEmbeddingSubPhases`.
    const { pendingCount } = await countSectionVisualBackfillTargets(ctx.webPageId);
    if (pendingCount === 0) {
      // PR-C4 B6 (TPA-RV2-01 hoist closure): even when the SSOT pending count is
      // 0 (every non-high-PII section is already terminal), a page whose ONLY
      // pending sections are high-PII (e.g. w3.org navigation) must still emit
      // the `section_visual_pii_excluded` terminal marker + GDPR Art.30 audit
      // trail. The SSOT pending predicate excludes high-PII rows, so they never
      // count toward `pendingCount` and `runVisualEmbeddingSubPhases` (which
      // carries the hoisted marker write) is not invoked on this branch. Fire
      // the marker here via the single SSOT entry point. No double-emit: the
      // marker terminalizes the rows, so the work-loop path / next run sees the
      // empty set. Requires `ctx.prisma` (DINOv2 path is not reached, but the
      // marker write needs a client); skip gracefully when absent.
      if (ctx.prisma) {
        await emitSectionVisualPiiExcludedMarkersForPage(ctx.prisma, ctx.webPageId);
      }
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed,
        memorySkips: textResult.memorySkips,
        errors: textResult.errors,
      };
    }

    if (!ctx.prisma) {
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed + pendingCount,
        memorySkips: textResult.memorySkips,
        errors: [...textResult.errors, "section_visual: prisma client unavailable"],
      };
    }

    // 4) DINOv2 で section vision embedding を再生成
    //    `runVisualEmbeddingSubPhases` は `sectionIdMapping.size > 0` をエントリ条件と
    //    し、内部で `vision_embedding IS NULL` の section を DB から再取得する。
    //    backfill 文脈ではセンチネルとして 1 件入りの Map を渡す（実際のキー値は使われない）。
    //    `partsSavedCount: 0` で Part visual パスはスキップする。
    //
    // 4) Regenerate section vision embeddings via DINOv2.
    //    `runVisualEmbeddingSubPhases` keys off `sectionIdMapping.size > 0` and
    //    re-fetches `vision_embedding IS NULL` sections internally. We pass a
    //    1-entry sentinel map (the key is unused). `partsSavedCount: 0` keeps
    //    the Part visual path inert.
    const dinov2ModelPath = resolveDinov2ModelPath();
    const sentinelMap = new Map<string, string>([
      ["__backfill_sentinel__", "__backfill_sentinel__"],
    ]);
    // PR-B (Plan §7.2 / §7.5 / FIND-RE-LCC-01): backfill 経路で Section Screenshot Fallback
    // (Playwright 個別 re-capture) を有効化する。truncated screenshot サイトの off-screen
    // section を Playwright で per-section 再capture → DINOv2 で実 visual embedding を生成する
    // (`screenshot_truncated` retryable 分類の genuine 再生成手段、2A' 単独着地禁止充足)。
    // 再capture URL を DB から取得 (`url: ""` だと SSRF 検証で fallback 不能) し、robots.txt
    // 再評価を有効化する (backfill は元 ingest から数日後の非同期別オペで Phase 0 robots
    // 検証が stale)。
    //
    // PR-B (Plan §7.2 / §7.5 / FIND-RE-LCC-01): enable the Section Screenshot Fallback
    // (Playwright per-section re-capture) on the backfill path so off-screen sections of a
    // truncated-screenshot site are re-captured → DINOv2 generates the actual visual
    // embedding (the genuine regeneration means for the `screenshot_truncated` retryable
    // classification, satisfying the 2A' standalone-landing prohibition). Fetch the URL from
    // the DB (`url: ""` would SSRF-reject) and enable robots.txt re-evaluation (backfill is an
    // async separate op days after ingest, so Phase 0's robots check is stale).
    const pageUrlForFallback = await fetchWebPageUrlForFallback(ctx.webPageId);
    const subResult = await runVisualEmbeddingSubPhases({
      webPageId: ctx.webPageId,
      url: pageUrlForFallback,
      screenshotPngPath: ctx.screenshotStoragePath,
      sectionIdMapping: sentinelMap,
      partsSavedCount: 0,
      layoutResultJson: null,
      fallbackEnabled: true,
      recheckRobotsTxt: true,
      // backfill job data は respectRobotsTxt override を持たないため undefined を渡し、
      // env flag `REFTRIX_RESPECT_ROBOTS_TXT` (既定有効) に従う (FIND-RE-LCC-01 default)。
      // The backfill job data carries no respectRobotsTxt override; pass undefined and follow
      // env flag `REFTRIX_RESPECT_ROBOTS_TXT` (default enabled).
      respectRobotsTxt: undefined,
      dinov2ModelPath,
      prisma: ctx.prisma,
      onLockExtend: (_label: string) => {
        // Worker lockDuration が十分に長いので明示的な extendLock は不要
        // Lock duration is long enough — no explicit extension needed
      },
      onProgress: (completed: number, total: number) => {
        const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
        const pct =
          PROGRESS_AFTER_FETCH +
          Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
        ctx.job.updateProgress(pct).catch(() => {
          /* fire-and-forget */
        });
      },
    });

    // 5) 集計: text 側 + DINOv2 側を合算。embeddingFailedChunks はチャンク単位の
    //    失敗回数なので「失敗 section 数」とは厳密一致しないが、観測性のため
    //    failed に加算する（PartVisualProcessor と同じ扱い）。
    //
    // 5) Aggregate: text-side + DINOv2-side. `embeddingFailedChunks` is a
    //    chunk-level failure count (not strict section count), but added to
    //    `failed` for observability — same convention as PartVisualProcessor.
    return {
      category: this.category,
      generated: textResult.generated + subResult.sectionVisualEmbeddingsGenerated,
      failed: textResult.failed + subResult.embeddingFailedChunks,
      memorySkips: textResult.memorySkips,
      errors: textResult.errors,
    };
  }
}

class MotionProcessor implements BackfillCategoryProcessor {
  readonly category = "motion" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "MotionProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillMotionsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class BackgroundProcessor implements BackfillCategoryProcessor {
  readonly category = "background" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "BackgroundProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillBackgroundsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class JsAnimationProcessor implements BackfillCategoryProcessor {
  readonly category = "js_animation" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  /**
   * v0.4.0 PR7e-β4 PR2d (HIGH-α): fork-or-fallback dispatch via shared helper.
   *
   * PR2b-β で本 Processor 限定で実装されていた `processViaFork` (~70 LOC) は
   * `runForkOrFallback` ヘルパーに抽出され、6 他 Processor と共有される。
   * 本 Processor は helper 1 行呼び出しのみで SEC-M-3 fail-open / TPA-H-1
   * observability / TPA-M-2 fallback recursion を継承する。
   *
   * PR2d (HIGH-α): The `processViaFork` (~70 LOC) previously implemented in
   * this Processor is now extracted to `runForkOrFallback` and shared with
   * the other 6 Processors. This Processor inherits SEC-M-3 / TPA-H-1 / TPA-
   * M-2 invariants via a single helper call.
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "JsAnimationProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillJsAnimationsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class ResponsiveProcessor implements BackfillCategoryProcessor {
  readonly category = "responsive" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "ResponsiveProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13 PII): diagnostic probe BEFORE the
    // backfill call to compute `expectedCount` (rows in `responsive_analyses`
    // missing `responsive_analysis_embeddings`). When `expectedCount > 0` but
    // `result.generated === 0`, emit a structured warn log so silent stalls
    // become observable. PII: `webPageId` is truncated via `truncateId(..., 8)`
    // per `.claude/rules/security.md` CWE-532 PII-in-log policy.
    //
    // PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13 PII): probe expectedCount before
    // the backfill so silent stalls (expected > 0 yet generated === 0) emit a
    // structured warn log. PII: `webPageId` truncated per CWE-532.
    let expectedCount = 0;
    try {
      expectedCount = await countMissingResponsiveEmbeddings(ctx.webPageId);
    } catch (probeError) {
      // Probe failure is non-fatal — proceed with backfill. The diagnostic log
      // simply omits the assertion check.
      logger.warn("[ResponsiveProcessor] expectedCount probe failed (non-fatal)", {
        error: sanitizeErrorMessage(probeError),
        webPageId: truncateId(ctx.webPageId, 8),
      });
    }

    const result = await backfillResponsiveForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });

    // Diagnostic log: only when expectedCount > 0 but no rows were generated.
    // This is the silent-stall signature documented in PR-D-7 §32.2 (responsive
    // generatedCount:0 despite missing rows existing).
    if (expectedCount > 0 && result.generated === 0) {
      logger.warn("[ResponsiveProcessor] generatedCount mismatch (expected > 0, generated 0)", {
        webPageId: truncateId(ctx.webPageId, 8),
        expectedCount,
        generatedCount: result.generated,
        failedCount: result.failed,
        memorySkips: result.memorySkips,
      });
    }

    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

// =====================================================
// Helpers
// =====================================================

/**
 * DINOv2 モデルパスを解決する（`phase-5-embedding.ts` の dispatchEmbeddingPhase と
 * `embedding-backfill-worker.ts` の resolveDinov2ModelPath と同一ロジック）。
 * Resolve the DINOv2 model path (mirrors the helpers in `phase-5-embedding.ts`
 * dispatchEmbeddingPhase and `embedding-backfill-worker.ts`).
 */
function resolveDinov2ModelPath(): string {
  if (process.env["DINOV2_MODEL_PATH"]) {
    return process.env["DINOV2_MODEL_PATH"];
  }
  const mlMainPath = require.resolve("@reftrixmcp/ml");
  const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
  return path.join(mlRoot, "models", "dinov2-base", "model.onnx");
}

// =====================================================
// SSOT Registry — `Record` guarantees compile-time exhaustiveness
// =====================================================

/**
 * Processor レジストリ — `Record<EmbeddingBackfillCategory, ...>` で全カテゴリの
 * Processor 実装を強制する。SSOT の配列にカテゴリを追加すると本 Record も
 * コンパイルエラーになるため、Processor の追加忘れを防ぐ。
 *
 * Processor registry — `Record<EmbeddingBackfillCategory, ...>` makes the compiler
 * enforce that every category has an implementation. Adding a new category to
 * the SSOT array causes a compile error here if the processor is missing.
 */
export const PROCESSORS: Record<EmbeddingBackfillCategory, BackfillCategoryProcessor> = {
  part_text: new PartTextProcessor(),
  part_visual: new PartVisualProcessor(),
  section_visual: new SectionVisualProcessor(),
  motion: new MotionProcessor(),
  background: new BackgroundProcessor(),
  js_animation: new JsAnimationProcessor(),
  responsive: new ResponsiveProcessor(),
};

/**
 * カテゴリから Processor を取得する type-safe ヘルパー
 * Type-safe helper for fetching a processor by category
 */
export function getBackfillProcessor(
  category: EmbeddingBackfillCategory
): BackfillCategoryProcessor {
  return PROCESSORS[category];
}

// =====================================================
// Skip Recovery Helper (PR7b-convergence TDA H-1 / H-2 / M-2)
// =====================================================

/**
 * Skip recovery 経路で全 7 カテゴリを一括 enqueue するヘルパー
 * （PR7b-convergence TDA H-1 / H-2 / M-2）。
 *
 * 元々 Worker (`page-analyze-worker.ts` の `dispatchSkipRecoveryBackfill`) と
 * Cron (`backfill-reconciliation.service.ts` の `reconcileSkippedRows`) に
 * 30 行 × 2 で重複していた enqueue ループを SSOT 化する。
 * 複雑度 14 → 10 以下への収束にも寄与する。
 *
 * 挙動 / Behaviour:
 *   - `screenshot` が必須のカテゴリ (`part_visual` / `section_visual`) は
 *     `screenshotStoragePath` が undefined の場合スキップ（Graceful Degradation）
 *   - 各 enqueue 失敗は warn log のみで continue（一部失敗しても他カテゴリは enqueue 続行）
 *   - 成功カテゴリと失敗カテゴリを分離して返す
 *
 * Bulk-enqueues all 7 categories for the skip-recovery path. Replaces the
 * duplicated enqueue loops (~30 lines × 2) in the Worker
 * (`page-analyze-worker.ts` `dispatchSkipRecoveryBackfill`) and the Cron
 * (`backfill-reconciliation.service.ts` `reconcileSkippedRows`) with a shared
 * SSOT. Also drives the host functions' complexity from 14 to ≤10.
 *
 * Behaviour:
 *   - Screenshot-required categories (`part_visual` / `section_visual`) are
 *     skipped when `screenshotStoragePath` is undefined (Graceful Degradation)
 *   - Each enqueue failure only emits a warn log and continues (partial
 *     failure does not halt the remaining categories)
 *   - Returns enqueued and failed categories separately
 *
 * @param queue - BullMQ Queue
 * @param params - Enqueue 条件
 * @returns enqueued / failed カテゴリ一覧
 */
export async function enqueueAllCategoriesForSkipRecovery(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  params: {
    /** 対象ページ ID / Target page ID */
    webPageId: string;
    /** 永続化済み screenshot パス（screenshot 必須カテゴリで使用） / Persisted screenshot path */
    screenshotStoragePath?: string | undefined;
    /** `skipped_memory_pressure` 経路の初期 delay (ms)。`skipped_fork_error` は 0。 */
    initialDelayMs: number;
    /** 呼び出し元（ログ用） / Caller for logging */
    source: "worker" | "cron";
  }
): Promise<{
  enqueued: EmbeddingBackfillCategory[];
  failed: EmbeddingBackfillCategory[];
}> {
  const { webPageId, screenshotStoragePath, initialDelayMs, source } = params;
  const enqueued: EmbeddingBackfillCategory[] = [];
  const failed: EmbeddingBackfillCategory[] = [];

  for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
    const processor = getBackfillProcessor(category);

    // screenshot 必須カテゴリで screenshot 無し → スキップ（Graceful Degradation）
    // Screenshot-required category without screenshot → skip (Graceful Degradation)
    if (processor.requiresScreenshot() && !screenshotStoragePath) {
      continue;
    }

    const jobData: Omit<EmbeddingBackfillJobData, "createdAt"> = {
      webPageId,
      category,
      ...(processor.requiresScreenshot() && screenshotStoragePath
        ? {
            screenshotStoragePath,
            requiresBboxResolution: category === "part_visual",
          }
        : {}),
    };

    const opts: { priority: number; delay?: number } = { priority: 10 };
    if (initialDelayMs > 0) {
      opts.delay = initialDelayMs;
    }

    try {
      // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
      // PR-D-6 Phase 2: legacy API → with-guard. outcome is observed for
      // skip-recovery telemetry; successful variants (enqueued_* / reused_*)
      // all count as "category successfully enqueued".
      const result = await addEmbeddingBackfillJobWithGuard(queue, jobData, opts);
      enqueued.push(category);
      if (result.outcome !== "enqueued_new") {
        logger.info(`[EmbeddingBackfillProcessors] Skip-recovery enqueue outcome (${source})`, {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
          category,
          source,
        });
      }
    } catch (enqueueError) {
      failed.push(category);
      logger.warn(
        `[EmbeddingBackfillProcessors] Failed to enqueue skip-recovery category (${source}, non-fatal)`,
        {
          error: sanitizeErrorMessage(enqueueError),
          webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
          category,
          source,
        }
      );
    }
  }

  return { enqueued, failed };
}

// =====================================================
// Test-only exports
// =====================================================

// テスト用にクラスを export（本番コードからは `PROCESSORS` のみ使用する想定）
// Classes exported for tests only — production code should go through `PROCESSORS`.
export {
  PartTextProcessor,
  PartVisualProcessor,
  SectionVisualProcessor,
  MotionProcessor,
  BackgroundProcessor,
  JsAnimationProcessor,
  ResponsiveProcessor,
};
