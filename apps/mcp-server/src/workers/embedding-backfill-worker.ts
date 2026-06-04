// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingBackfillWorker — BullMQ Worker for Async Part Embedding Backfill
 *
 * v0.4.0 PR4: `embedding-backfill` Queue のジョブを消費し、Part text / visual
 * embedding をバックフィルする。page.analyze の Phase 5 で 100 件を超える
 * Part が存在する場合、最初の 100 件のみ同期処理し、残余を本 Worker が
 * 非同期に処理する（Queue-based Backfill）。
 *
 * v0.4.0 PR4: Consumes jobs from the `embedding-backfill` Queue and backfills
 * Part text / visual embeddings. When `page.analyze` Phase 5 has more than
 * 100 Parts, only the first 100 are processed synchronously and the
 * remainder is handled asynchronously by this Worker (Queue-based Backfill).
 *
 * Configuration:
 * - concurrency: 1 (OOM prevention; single ONNX / DINOv2 session per process)
 * - lockDuration: 600000ms (10 min, extended for DINOv2 inference)
 * - attempts: 3 (defined in queue — transient OOM recovery)
 * - autorun: false (explicit .run() call in start-workers.ts)
 *
 * Lifecycle:
 * 1. Receive job from Queue (jobId = `<webPageId>__<category>`)
 * 2. Validate webPageId exists and has pending embeddings
 * 3. For `part_text`: call `backfillPartTextForPage()` (DB self-discovery)
 * 4. For `part_visual`: use `runVisualEmbeddingSubPhases()` with persisted screenshot (PR1)
 * 5. After all pending categories complete → update `embeddingBackfillStatus = 'completed'`
 * 6. Still-pending categories → leave as `'in_progress'`
 *
 * @module workers/embedding-backfill-worker
 */

import { Worker, type Job, type Queue } from "bullmq";
import { prisma } from "@reftrixmcp/database";
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  EMBEDDING_BACKFILL_QUEUE_NAME,
  EmbeddingBackfillJobDataSchema,
  addEmbeddingBackfillJobWithGuard,
  createEmbeddingBackfillQueue,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillCategory,
  type EmbeddingBackfillFailureReason,
} from "../queues/embedding-backfill-queue";
// PR-BT-4 H-1 (ADR-0018 Amendment 10 Decision 10.1 + 10.4): analysis-status
// guard pure decision leaf helper. The DB-mutating CAS transitions live in this
// file (they need Prisma + Queue); the *decision* is the complexity-gated leaf.
import {
  decideAnalysisGuard,
  BACKFILL_ANALYSIS_GUARD_DELAY_MS,
} from "./phases/backfill-analysis-guard";
import { BACKFILL_RECOVERY_MAX_AUTO_RETRIES } from "../services/backfill-recovery-reconciliation.service";
import { AUDIT_LOG_CONSTANTS, getAuditLogService } from "../services/audit-log.service";
import { pickKnownKeys, detectCategoryDrift } from "../utils/pick-known-keys";
import {
  getBackfillProcessor,
  type BackfillProcessContext,
} from "../queues/embedding-backfill-processors";
import { getRedisConfig, type RedisConfig } from "../config/redis";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { safeParseInt } from "../utils/safe-parse-int";
import {
  computeRemainingStatusWithPrisma,
  verifyCategoryParity,
  type CategoryPendingSnapshot,
} from "../services/backfill-status.helper";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../services/layout-embedding.service";
// v0.4.0 PR7e-β3: motion backfill 経路用 DI
// MotionProcessor (embedding-backfill-processors.ts:497) が backfillMotionsForPage
// → saveMotionEmbedding を呼ぶ際に Frame Prisma factory が必要。
// これが未設定だと "PrismaClient not initialized" で motion backfill 全件 failed となる。
//
// v0.4.0 PR7e-β3: DI for the motion backfill path.
// MotionProcessor calls backfillMotionsForPage → saveMotionEmbedding, which
// requires the Frame Prisma factory. Without it, motion backfill throws
// "PrismaClient not initialized" for every row.
import { setFramePrismaClientFactory } from "../services/motion/frame-embedding.service";
import { validateScreenshotPath } from "../services/screenshot-persistence.service";
import {
  applyPostJobMemoryGate,
  registerCompletedListenerAndExit,
} from "./shared/post-job-lifecycle";
import type { EmbeddingPhasePrismaClient } from "./phases/phase-5-embedding";

// ============================================================================
// Constants
// ============================================================================

/** Default concurrency — 1 to prevent OOM (same as page-analyze-worker) */
const DEFAULT_CONCURRENCY = 1;

/** Default lock duration (10 min — enough for DINOv2 inference) */
const DEFAULT_LOCK_DURATION = 600_000;

/** Default stalled interval = lockDuration / 4 */
const DEFAULT_STALLED_INTERVAL = Math.floor(DEFAULT_LOCK_DURATION / 4);

/** Max stalled count before failing (allow 3 stalls for CPU-bound DINOv2) */
const DEFAULT_MAX_STALLED_COUNT = 3;

/**
 * Progress sentinel values — BullMQ UI displays these as percentages.
 * Progress センチネル値 — BullMQ UI が% として表示する。
 */
const PROGRESS_START = 0;
const PROGRESS_AFTER_FETCH = 10;
const PROGRESS_AFTER_EMBEDDING = 90;
const PROGRESS_COMPLETE = 100;

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingBackfillWorkerOptions {
  /** Optional Redis config overrides */
  redisConfig?: Partial<RedisConfig> | undefined;
  /** Worker concurrency (default: 1) */
  concurrency?: number;
  /** BullMQ lock duration (default: 600000ms) */
  lockDuration?: number;
  /** Enable verbose logging (default: isDevelopment()) */
  verbose?: boolean;
}

export interface EmbeddingBackfillWorkerInstance {
  worker: Worker<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  close: () => Promise<void>;
  pause: () => Promise<void>;
  isRunning: () => boolean;
}

// ============================================================================
// DI Setup
// ============================================================================

/**
 * Shared singleton LayoutEmbeddingService used across jobs to avoid ONNX
 * session re-allocation cost. Same pattern as page-analyze-worker.
 *
 * 全ジョブで共有する LayoutEmbeddingService シングルトン。ONNX セッション
 * 再確保コストを避けるため page-analyze-worker と同じパターンを採用。
 */
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);
// v0.4.0 PR7e-β3: motion backfill DI (上記 import コメント参照)
// v0.4.0 PR7e-β3: Motion backfill DI (see import)
setFramePrismaClientFactory(() => prisma as never);

// ============================================================================
// Post-Job Memory Gate — OOM prevention via planned restart
// ============================================================================
//
// v0.4.0 PR7e-β2 hotfix で pause/resume 経路は完全削除済み (ADR-0009)。
// v0.4.0 PR7e-β2 audit carryover で helper を `applyPostJobMemoryGate` に
// リネームし、未使用になった `_workerInstanceRef` モジュール変数も削除した。
// 残すのは `WORKER_MAX_JOBS_BEFORE_RESTART > 0` 判定フラグのみ。
//
// v0.4.0 PR7e-β2 hotfix removed the pause/resume path entirely (see ADR-0009).
// v0.4.0 PR7e-β2 audit carryover renamed the helper to `applyPostJobMemoryGate`
// and dropped the now-unused `_workerInstanceRef` module-level variable. Only
// the `WORKER_MAX_JOBS_BEFORE_RESTART > 0` flag remains.

/**
 * Post-job memory gate enabled when WORKER_MAX_JOBS_BEFORE_RESTART > 0 (default: 1).
 * Same env var as page-analyze-worker to keep restart policy aligned.
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

/**
 * Plan v1.1 candidate B / ADR-0034 Amendment 5: the module-level
 * `_workerInstanceRef` was used solely by the removed
 * `applyPostJobLifecycleGate(worker, ...)` callsite (success path
 * Pre-Return Pause). Stage 2 `worker.pause(true)` is formally removed
 * (ADR-0034 Amendment 5 §Decision 2-4), so the ref is no longer needed
 * and has been removed from the module.
 *
 * Plan v1.1 candidate B / ADR-0034 Amendment 5: the module-level
 * `_workerInstanceRef` was used solely by the removed
 * `applyPostJobLifecycleGate(worker, ...)` callsite (success path
 * Pre-Return Pause). Stage 2 `worker.pause(true)` is formally removed
 * (Amendment 5 §Decision 2-4); the ref is no longer needed and has been
 * removed from this module.
 */

// ============================================================================
// Processor
// ============================================================================

/**
 * Resolve the screenshot path for a given webPageId.
 *
 * Prefers the `screenshotStoragePath` provided in job data (hot cache from
 * `page.analyze`), then falls back to the DB column (`web_pages.screenshotStoragePath`).
 * Both candidates pass through `validateScreenshotPath()` which enforces:
 *   1. allowlist (path must be inside `${REFTRIX_SCREENSHOT_ROOT}/phase5/`)
 *   2. symlink resolution via `fs.promises.realpath` (no TOCTOU)
 *   3. real-file check (rejects directories / special files)
 * Returns null when validation fails or no persisted screenshot exists.
 *
 * webPageId に紐づく screenshot の絶対パスを解決する。ジョブデータ内のヒント
 * を優先し、無ければ DB (`web_pages.screenshotStoragePath`) を参照する。
 * どちらの候補も `validateScreenshotPath()` で allowlist + realpath 検証を
 * 通し、Phase 5 ディレクトリ配下の実ファイルであることを保証する。
 * 検証失敗または永続化済み screenshot が無い場合は null を返す。
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): BullMQ Redis 越しに受信する
 * `screenshotStoragePath` は外部入力同等。旧実装 (`fs.existsSync` +
 * `path.resolve`) では `/etc/passwd.png` 等の任意パス読み取りが可能だったため、
 * allowlist + realpath ベースの検証を再適用した。
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): `screenshotStoragePath` received via
 * BullMQ Redis is treated as external input. The previous implementation
 * (`fs.existsSync` + `path.resolve`) allowed arbitrary path reads such as
 * `/etc/passwd.png`; the allowlist + realpath check is now re-applied.
 */
async function resolveScreenshotPath(
  webPageId: string,
  hint: string | undefined
): Promise<string | null> {
  // 1. ジョブデータ由来のヒント（BullMQ Redis 経由 → 外部入力同等）
  //    Hint from job data (via BullMQ Redis → treated as external input)
  if (hint) {
    const validated = await validateScreenshotPath(hint);
    if (validated !== null) {
      return validated;
    }
    logger.warn("[EmbeddingBackfillWorker] Rejected unsafe screenshot path from job hint", {
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    });
  }

  // 2. DB から取得（内部状態だが念のため allowlist 検証）
  //    Fetch from DB (internal state but re-validate via allowlist)
  try {
    const row = await prisma.webPage.findUnique({
      where: { id: webPageId },
      select: { screenshotStoragePath: true },
    });
    if (row?.screenshotStoragePath) {
      const validated = await validateScreenshotPath(row.screenshotStoragePath);
      if (validated !== null) {
        return validated;
      }
      logger.warn("[EmbeddingBackfillWorker] Rejected unsafe screenshot path from DB", {
        webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      });
    }
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to fetch screenshot path from DB", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    });
  }
  return null;
}

/**
 * Determine the remaining backfill status for a webPage after a Worker run.
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): `computeRemainingStatusWithPrisma`
 * helper に実装を委譲し、reconciliation service と SSOT を共有する。旧実装
 * (backfill-worker.ts 内に直接ロジックを記述) は drift 防止のため削除済み。
 * 公開 API 契約（戻り値型 / export 名）は維持する。
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): Delegates to
 * `computeRemainingStatusWithPrisma` helper so the worker and reconciliation
 * service share a single source of truth. The previous in-module
 * implementation was removed to prevent drift. Public API contract
 * (return type / export name) is preserved.
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA 申し送り): 全 7 カテゴリの残件を確認する。
 * いずれかのカテゴリで未完了行が残っていれば `in_progress` を維持。
 * PR5 Counter Reconciliation の 9 カテゴリ DB authoritative と同じカウント方法を採用。
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA carryover): Checks remaining items across all 7
 * categories. Any remaining row keeps the status as `in_progress`. Mirrors the
 * 9-category DB-authoritative counts from the PR5 Counter Reconciliation.
 */
async function computeRemainingStatus(webPageId: string): Promise<{
  finalStatus: "completed" | "in_progress";
  pendingSnapshot: CategoryPendingSnapshot;
}> {
  return computeRemainingStatusWithPrisma(webPageId, prisma);
}

/**
 * Safely update `web_pages.embeddingBackfillStatus`.
 * DB 更新失敗は致命的でないので warn のみ出力して続行する。
 *
 * v0.4.0 PR-D-4: `skipped_fork_error` が明示引数として許可される
 * (INV-EMBEDDING-INTEGRITY-003 parity-check failure の retry bucket 遷移用)。
 * v0.4.0 PR-D-4: `skipped_fork_error` is an allowed argument (used for the
 * INV-EMBEDDING-INTEGRITY-003 parity-check-failure retry-bucket transition).
 */
async function updateEmbeddingBackfillStatus(
  webPageId: string,
  status: "in_progress" | "completed" | "failed" | "skipped_fork_error"
): Promise<void> {
  try {
    await prisma.webPage.update({
      where: { id: webPageId },
      data: { embeddingBackfillStatus: status },
    });
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to update embeddingBackfillStatus", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      status,
    });
  }
}

/**
 * defect B fix (10-site CPU 検証で発見): job 例外時の terminal failure 遷移を
 * **plain `failed` ではなく** `failed_with_known_reason` + `failure_reason` +
 * `failed_at` に統一する helper。
 *
 * **root cause**: 旧 `finalizeBackfillJob` failure path は
 * `updateEmbeddingBackfillStatus(webPageId, "failed")` で plain `failed` のみを
 * 書き込み、`failure_reason` / `failed_at` を NULL のまま残していた。その結果:
 *   (1) `failure_reason=null` / `failed_at=null` の不整合 (observability 欠落)。
 *   (2) plain `failed` は recovery service (`runRecoveryCycle` →
 *       `fetchFailedWithKnownReasonRows`) の scan 対象外のため、後から DI 修正
 *       (e.g. motion) で再処理して DB が完全になっても **自動復帰しない**。
 *
 * `failed_with_known_reason` + `stall_timeout` reason に遷移させることで、
 * `BackfillRecoveryReconciliationService` が `auto_recoverable` policy で scan →
 * `re_enqueued` → 全 7 カテゴリ再投入 → DB 完全なら最終的に `completed` 到達、
 * という既存 Plan v3 T3-Backfill recovery 経路に正しく乗せる。
 *
 * **reason 選択根拠**: BullMQ job processor 内の例外は transient な処理失敗
 * (一時的な DI / ネットワーク / OOM 等) を表すため、`auto_recoverable` バケット
 * の `stall_timeout` を汎用 reason として採用する
 * (`classifyFailureReasonPolicy` で auto_recoverable、lifecycle-origin として
 * 単純 re-enqueue される)。
 *
 * defect B fix: unifies the job-exception terminal failure transition to
 * `failed_with_known_reason` + `failure_reason='stall_timeout'` + `failed_at`,
 * instead of plain `failed`. This (1) fills failure metadata (closing the
 * `failure_reason`/`failed_at` NULL observability gap) and (2) routes the row
 * into the recovery service's scan window so it can auto-recover (re_enqueue →
 * all 7 categories → terminal `completed`) once the DB becomes complete.
 */
async function markBackfillFailedWithKnownReason(
  webPageId: string,
  failureReason: EmbeddingBackfillFailureReason
): Promise<void> {
  try {
    await prisma.webPage.update({
      where: { id: webPageId },
      data: {
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: failureReason,
        embeddingBackfillFailedAt: new Date(),
      },
    });
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to mark failed_with_known_reason", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      failureReason,
    });
  }
}

// ============================================================================
// PR-BT-4 H-1 — analysis-status guard CAS transitions
// (ADR-0018 Amendment 10 Decision 10.1 + 10.4)
// ============================================================================

/**
 * Minimal Prisma surface required by the analysis-status guard transitions.
 * Lets tests inject a mock without the full `PrismaClient` type (mirrors the
 * recovery service's `runRecoveryCycle` Prisma typing).
 */
export interface AnalysisGuardPrisma {
  webPage: {
    findUnique: (args: { where: { id: string }; select?: Record<string, boolean> }) => Promise<{
      analysisStatus: string;
      embeddingBackfillRetryCount: number;
      screenshotStoragePath: string | null;
    } | null>;
    updateMany: (args: {
      where: { id: string; embeddingBackfillStatus?: { in?: string[] } | string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

/**
 * Result of a single analysis-guard re-enqueue transition.
 *
 * - `re_enqueued`        — CAS won; retryCount incremented; job re-added.
 * - `concurrent_skipped` — CAS lost (another actor already transitioned the
 *                          row out of the `in_progress`/`queued` window).
 */
export type AnalysisGuardReEnqueueResult = { kind: "re_enqueued" } | { kind: "concurrent_skipped" };

/**
 * Lazily-cached Queue for the guard re-enqueue path (matches the
 * page-analyze-worker `_backfillQueue` lazy-init pattern). A re-enqueued job is
 * the SAME single category — the guard fires per-job, and each per-category job
 * re-adds itself (idempotent via the jobId collision guard).
 */
let _guardReEnqueueQueue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null = null;

function getGuardReEnqueueQueue(): Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
  if (_guardReEnqueueQueue === null) {
    _guardReEnqueueQueue = createEmbeddingBackfillQueue();
  }
  return _guardReEnqueueQueue;
}

/**
 * SEC-V1-01 winning contract — same-shape CAS re-enqueue for the
 * analysis-status guard (H-1). Mirrors `transitionToReEnqueued` from the
 * recovery service BUT with a DISTINCT CAS gate:
 * `embeddingBackfillStatus IN ('in_progress','queued')` (the guard fires while
 * the row is in_progress, NOT `failed_with_known_reason`). The recovery-service
 * helper literally cannot be called for this path because its CAS where-clause
 * gates `failed_with_known_reason → queued`.
 *
 * Transitions `in_progress`/`queued` → `queued` + `embeddingBackfillRetryCount`
 * CAS-increment, then re-adds the SAME single-category job with a bounded delay
 * (`BACKFILL_ANALYSIS_GUARD_DELAY_MS`). NOT BullMQ retry (`moveToDelayed` /
 * `attempts: ≥2`) — `INV-RETRY-AMPLIFICATION-001` keeps `attempts: 1`.
 *
 * @returns `re_enqueued` when the CAS won, `concurrent_skipped` otherwise.
 */
export async function transitionAnalysisGuardReEnqueue(args: {
  prisma: AnalysisGuardPrisma;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  webPageId: string;
  category: EmbeddingBackfillCategory;
  retryCount: number;
  screenshotStoragePath: string | null;
}): Promise<AnalysisGuardReEnqueueResult> {
  const { prisma: db, queue, webPageId, category, retryCount, screenshotStoragePath } = args;

  // CAS gate: only transition while the row is still in the active window
  // (in_progress / queued). Distinct from the recovery service's
  // `failed_with_known_reason` gate (SEC-V1-01).
  const updated = await db.webPage.updateMany({
    where: { id: webPageId, embeddingBackfillStatus: { in: ["in_progress", "queued"] } },
    data: {
      embeddingBackfillStatus: "queued",
      embeddingBackfillRetryCount: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    return { kind: "concurrent_skipped" };
  }

  // Re-add the SAME single-category job with bounded delay. Idempotent via the
  // jobId collision guard. requiresBboxResolution mirrors the skip-recovery
  // enqueue contract for part_visual.
  const jobData: Omit<EmbeddingBackfillJobData, "createdAt"> =
    category === "part_visual" && screenshotStoragePath
      ? { webPageId, category, screenshotStoragePath, requiresBboxResolution: true }
      : screenshotStoragePath
        ? { webPageId, category, screenshotStoragePath }
        : { webPageId, category };

  await addEmbeddingBackfillJobWithGuard(queue, jobData, {
    priority: 10,
    delay: BACKFILL_ANALYSIS_GUARD_DELAY_MS,
  });

  logger.info(
    "[EmbeddingBackfillWorker] Analysis-status guard re-enqueued (page still analyzing)",
    {
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      category,
      retryCount: retryCount + 1,
    }
  );
  return { kind: "re_enqueued" };
}

/**
 * Deadlock guard (Decision 10.4) — terminal `failed` when the retryCount cap is
 * reached while `analysisStatus` is permanently stuck (e.g. `markAnalysisCompleted`
 * non-fatal failure leaving `processing`). CAS-guarded on the active window so a
 * concurrent transition is a no-op. Finite-terminating; never an infinite loop.
 */
export async function transitionAnalysisGuardTerminalFailed(args: {
  prisma: AnalysisGuardPrisma;
  webPageId: string;
}): Promise<void> {
  const { prisma: db, webPageId } = args;
  const updated = await db.webPage.updateMany({
    where: { id: webPageId, embeddingBackfillStatus: { in: ["in_progress", "queued"] } },
    data: { embeddingBackfillStatus: "failed" },
  });
  if (updated.count > 0) {
    logger.warn(
      "[EmbeddingBackfillWorker] Analysis-status guard deadlock cap reached → terminal failed",
      {
        webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
        retryCap: BACKFILL_RECOVERY_MAX_AUTO_RETRIES,
      }
    );
  }
}

/**
 * Evaluate the analysis-status guard for a backfill job receipt (H-1).
 *
 * Reads `analysisStatus` + `embeddingBackfillRetryCount`, delegates the decision
 * to the complexity-gated leaf helper `decideAnalysisGuard`, then performs the
 * matching CAS transition. Returns `true` when the worker should PROCEED to
 * process part categories, `false` when it must skip (re-enqueued or terminated).
 *
 * **fail-open** (C-vertex / Decision 10.1): a DB error reading the status returns
 * `true` (proceed) — the guard only shortens the race window; H-2/H-3 are the
 * final terminal-reach guarantee, so a guard read failure must not block completion.
 */
async function evaluateAnalysisGuard(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<boolean> {
  const { webPageId, category } = job.data;

  let row: {
    analysisStatus: string;
    embeddingBackfillRetryCount: number;
    screenshotStoragePath: string | null;
  } | null;
  try {
    row = await prisma.webPage.findUnique({
      where: { id: webPageId },
      select: {
        analysisStatus: true,
        embeddingBackfillRetryCount: true,
        screenshotStoragePath: true,
      },
    });
  } catch (error) {
    // fail-open: never block completion on a guard read failure.
    logger.warn(
      "[EmbeddingBackfillWorker] Analysis-status guard read failed — fail-open (proceed)",
      {
        error: sanitizeErrorMessage(error),
        webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
        category,
      }
    );
    return true;
  }

  // Missing row → proceed (Zod re-validation / downstream processor handles it).
  if (row === null) {
    return true;
  }

  const outcome = decideAnalysisGuard(
    row.analysisStatus,
    row.embeddingBackfillRetryCount,
    BACKFILL_RECOVERY_MAX_AUTO_RETRIES
  );

  if (outcome.kind === "proceed") {
    return true;
  }

  if (outcome.kind === "terminal_failed") {
    await transitionAnalysisGuardTerminalFailed({
      prisma: prisma as unknown as AnalysisGuardPrisma,
      webPageId,
    });
    return false;
  }

  // re_enqueue
  await transitionAnalysisGuardReEnqueue({
    prisma: prisma as unknown as AnalysisGuardPrisma,
    queue: getGuardReEnqueueQueue(),
    webPageId,
    category,
    retryCount: row.embeddingBackfillRetryCount,
    screenshotStoragePath: row.screenshotStoragePath,
  });
  return false;
}

/**
 * Zod re-validation at the Worker receipt boundary (SEC M-1 defense-in-depth).
 * Throws a sanitized Error when validation fails so BullMQ marks the job failed
 * immediately (retries would reproduce the same error).
 *
 * Worker 受信境界での Zod 再検証（SEC M-1 defense-in-depth）。検証失敗時は
 * サニタイズしたエラーを throw して即時 failed 扱いにする。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2.
 */
function validateJobData(job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>): void {
  // SEC M-1 (v0.4.0 PR4 audit): Zod re-validation at worker receipt boundary.
  // BullMQ Redis 越しに受信するジョブデータを defense in depth として再検証し、
  // キュー投入後に改竄された payload / 旧バージョンの Worker で投入された不正
  // データを拒否する。失敗時はサニタイズしたエラーでジョブを failed 扱いにする
  // （BullMQ の attempts=3 リトライでも検証失敗は再現するため即時失敗とする）。
  //
  // SEC M-1 (v0.4.0 PR4 audit): Zod re-validation at the worker receipt
  // boundary for defense in depth. Rejects payloads tampered with after
  // enqueue or enqueued by older worker versions. Validation failures are
  // terminal (BullMQ retries would re-hit the same error).
  try {
    EmbeddingBackfillJobDataSchema.parse(job.data);
  } catch (validationError) {
    const msg = sanitizeErrorMessage(validationError);
    logger.error("[EmbeddingBackfillWorker] Rejecting job with invalid data (Zod)", {
      jobId: job.id,
      error: msg,
    });
    throw new Error(`[EmbeddingBackfillWorker] Invalid job data: ${msg}`);
  }
}

/**
 * Resolve the screenshot path for the processor only when required.
 * Processor が要求する場合のみ検証済み screenshot パスを解決する。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2.
 */
async function resolveScreenshotForProcessor(
  processor: ReturnType<typeof getBackfillProcessor>,
  webPageId: string,
  category: EmbeddingBackfillCategory,
  hint: string | undefined
): Promise<string | undefined> {
  if (!processor.requiresScreenshot()) {
    return undefined;
  }
  const resolved = await resolveScreenshotPath(webPageId, hint);
  if (!resolved && category === "part_visual") {
    logger.warn("[EmbeddingBackfillWorker] No persisted screenshot; skipping part_visual", {
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    });
  }
  return resolved ?? undefined;
}

/**
 * v0.4.0 PR-D-5 (FIND-PLAN-IO-07 M → resolved):
 * Emit `parity_check_failed` via audit_logs DB write (primary evidence) +
 * logger.warn (observability / alert routing). Dual-emit design: if either
 * path fails, the other still executes.
 *
 * **Dual-emit rationale**: `audit_logs` は GDPR Art.30 Record of Processing
 * Activity として persist される primary evidence。`logger.warn` は real-time
 * observability / alert routing (SLO §3.4) のため維持される。片方が失敗しても
 * 他方は実行される (fail-independent, defense in depth)。
 *
 * **5-field contract (pinned via test + JSDoc, PR-D-4 Amendment 4 binding)**:
 * `auditLogService.log` payload には必ず以下を含む:
 *   - action: literal `"embedding_parity_check_failed"`
 *   - actor: literal `"system:embedding-backfill-worker"`
 *   - targetType: literal `"web_page"`
 *   - targetId: webPageId (audit-log.service 側で 8-char truncate される)
 *   - details: { category, unexpectedKeys, pendingSnapshot, skipReason, timestamp }
 *
 * **Set-equality enforcement (FIND-IMPL-IO-13)**: write 前に `category` map の
 * keys が `EMBEDDING_BACKFILL_CATEGORIES` と Set-equal であることを runtime
 * assert。drift 検出時は sentinel entry を追加で emit した上で primary emit
 * を継続 (best evidence preservation, Option C per IO Binding Q2).
 *
 * **FIND-TPA-PLAN-05 (M)**: primary emit payload は `pickKnownKeys` filter を
 * 適用することで、drift 時も schema-strict downstream consumer (Grafana /
 * audit parser) への contract violation を回避。未知 category key は
 * `unexpectedKeys` array に分離して persist (sentinel との cross-correlation)。
 *
 * **FIND-TPA-PLAN-03 (M)**: audit_logs primary emit failure 時は
 * `[SLO_MARKER] audit_log_emit_failed` log line を出力し、log-based metric
 * で L1.5 tier (primary emit failure rate) として監視可能にする。
 * fail-open による L0 OK 偽陽性化を systemic に検知する役割。
 *
 * **PII safety (FIND-PLAN-IO-10)**: `pendingSnapshot` / `category` は numeric-only。
 * No IDs, hashes, URLs, or user identifiers.
 *
 * @param webPageId       - full UUID (will be truncated internally)
 * @param pendingSnapshot - category → pending count map (numeric-only)
 */
async function emitParityCheckFailedIfEnabled(
  webPageId: string,
  pendingSnapshot: CategoryPendingSnapshot
): Promise<void> {
  const timestamp = new Date().toISOString();

  // (i) Set-equality enforcement (FIND-IMPL-IO-13). drift detection MUST NOT
  //     swallow the primary emit — sentinel entry is additive, not replacing.
  const drift = detectCategoryDrift(pendingSnapshot, EMBEDDING_BACKFILL_CATEGORIES);
  if (drift !== null) {
    await emitCategoryDriftSentinel(webPageId, drift, timestamp);
    // Continue with primary emit anyway (best evidence preservation).
  }

  // (ii) FIND-TPA-PLAN-05 (M): primary emit payload sanitization.
  //      schema-strict downstream consumer との contract 保護のため、
  //      `category` map は EMBEDDING_BACKFILL_CATEGORIES SSOT に含まれる
  //      key のみに filter する。未知 key は unexpectedKeys に分離。
  const filteredCategory = pickKnownKeys(pendingSnapshot, EMBEDDING_BACKFILL_CATEGORIES);
  const unexpectedKeys = drift?.unexpected ?? [];

  // (iii) Primary emit — audit_logs DB write.
  try {
    await getAuditLogService().log({
      action: "embedding_parity_check_failed",
      actor: "system:embedding-backfill-worker",
      targetType: "web_page",
      targetId: webPageId, // 8-char truncated inside audit-log.service
      result: "failure",
      details: {
        category: filteredCategory,
        unexpectedKeys,
        pendingSnapshot: filteredCategory,
        skipReason: "parity_check_failed" as const,
        timestamp,
      },
    });
  } catch (error) {
    // AuditLogService は内部で graceful-degrade (warn-only) するが、DI 未登録
    // 等の早期 throw 経路もあるため明示 catch。primary emit failure は
    // logger.warn で継続伝達する (defense in depth)。
    // FIND-TPA-PLAN-03 (M): SLO_MARKER tag により L1.5 tier
    // (primary emit failure rate) として log-based metric 監視可能にする。
    logger.warn("[EmbeddingBackfillWorker] [SLO_MARKER] audit_log_emit_failed", {
      action: "embedding_parity_check_failed",
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      error: sanitizeErrorMessage(error),
      timestamp,
    });
  }

  // (iv) Dual-emit — observability / alert routing.
  logger.warn("[EmbeddingBackfillWorker] parity_check_failed emitted", {
    webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    category: filteredCategory,
    unexpectedKeys,
    pendingSnapshot: filteredCategory,
    skipReason: "parity_check_failed" as const,
    timestamp,
  });
}

/**
 * v0.4.0 PR-D-5 (FIND-IMPL-IO-13 + FIND-TPA-PLAN-05):
 * Sentinel entry for `category` map schema drift — write_time check caught
 * keys that are not in `EMBEDDING_BACKFILL_CATEGORIES` SSOT.
 *
 * Emitted with a **separate action string** (`embedding_parity_schema_drift`)
 * so SLO L3 CRIT alerts can fire independently of the primary emit. Payload
 * schema is drift-specific (does NOT persist raw pendingSnapshot); cross-
 * correlation with primary emit is via `unexpectedKeys`.
 *
 * Sentinel failure is non-fatal — primary emit must proceed regardless.
 */
async function emitCategoryDriftSentinel(
  webPageId: string,
  drift: NonNullable<ReturnType<typeof detectCategoryDrift>>,
  timestamp: string
): Promise<void> {
  try {
    await getAuditLogService().log({
      action: "embedding_parity_schema_drift",
      actor: "system:embedding-backfill-worker",
      targetType: "web_page",
      targetId: webPageId,
      result: "failure",
      details: {
        expected: [...EMBEDDING_BACKFILL_CATEGORIES],
        missing: drift.missing,
        unexpected: drift.unexpected,
        unexpectedKeys: drift.unexpected,
        timestamp,
      },
    });
  } catch (error) {
    // FIND-TPA-PLAN-03 (M): SLO_MARKER tag for L1.5 tier monitoring.
    logger.warn("[EmbeddingBackfillWorker] [SLO_MARKER] audit_log_emit_failed", {
      action: "embedding_parity_schema_drift",
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      error: sanitizeErrorMessage(error),
      timestamp,
    });
  }
  logger.error("[EmbeddingBackfillWorker] CRITICAL: category schema drift detected", {
    webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
    missing: drift.missing,
    unexpected: drift.unexpected,
  });
}

/**
 * Outcome of the terminal parity gate.
 *
 * `parityFailed === true` の場合、DB row は `skipped_fork_error` (retry bucket) に
 * 遷移済で、呼び出し側は BullMQ job を成功扱いで完了させる。`finalStatus` union
 * は Option A (FIND-PLAN-IO-03) により `skipped_fork_error` を含む形に拡張されている。
 *
 * When `parityFailed === true`, the DB row has already transitioned to
 * `skipped_fork_error` (retry bucket) while the BullMQ job completes
 * successfully. `finalStatus` union expanded via FIND-PLAN-IO-03 Option A.
 */
type ParityGateOutcome = {
  parityFailed: boolean;
  finalStatus: "completed" | "in_progress" | "skipped_fork_error";
};

/**
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003): Terminal parity gate.
 *
 * `finalStatus === "completed"` への遷移直前に `verifyCategoryParity` を実行し、
 * parity 失敗時は `parity_check_failed` を emit した上で DB row を
 * `skipped_fork_error` (retry bucket) に遷移させる。BullMQ job 自体は完了扱い
 * (parity 失敗は DB status を retry に回すだけで job 実行は成功と見なす設計)。
 *
 * Sub-function extraction is mandatory per FIND-PLAN-IO-08 to keep the parent
 * `initiateBackfillJob` cyclomatic complexity ≤ 10.
 *
 * Runs `verifyCategoryParity` immediately before transitioning to `completed`.
 * On parity failure, emits `parity_check_failed` and transitions the DB row
 * to `skipped_fork_error` (retry bucket). The BullMQ job itself still
 * completes successfully (parity failure only redirects DB status to retry).
 *
 * **Invocation-ordering contract (FIND-PLAN-IO-10)**: `verifyCategoryParity`
 * MUST be called before any `updateEmbeddingBackfillStatus(..., "completed")`.
 *
 * @param webPageId       - target web page UUID
 * @param finalStatus     - the status computed by `computeRemainingStatus`
 * @param processorResult - processor outcome (generated / failed counts)
 * @param pendingSnapshot - snapshot from `computeRemainingStatus` (single round-trip)
 * @returns `{parityFailed, finalStatus}` — `finalStatus` matches the DB write
 */
async function handleTerminalParityGate(
  webPageId: string,
  finalStatus: "completed" | "in_progress",
  processorResult: { generated: number; failed: number },
  pendingSnapshot: CategoryPendingSnapshot
): Promise<ParityGateOutcome> {
  void processorResult;
  // Only run the parity gate on the "completed" transition attempt. An
  // `in_progress` verdict means there is still work left and cannot conflict
  // with the INV-003 "completed == all pending=0" contract.
  if (finalStatus !== "completed") {
    return { parityFailed: false, finalStatus };
  }

  const parityResult = verifyCategoryParity(pendingSnapshot);
  if (parityResult.ok) {
    return { parityFailed: false, finalStatus };
  }

  // Parity failed. Emit before DB write so the evidence survives even if the
  // subsequent DB write fails. logger.warn is the sole evidence source until
  // PR-D-5 lands `audit_logs` (FIND-PLAN-IO-07).
  await emitParityCheckFailedIfEnabled(webPageId, parityResult.pendingSnapshot);
  await updateEmbeddingBackfillStatus(webPageId, "skipped_fork_error");
  return { parityFailed: true, finalStatus: "skipped_fork_error" };
}

/**
 * Initiate the backfill job: status transition (queued → in_progress) + Strategy
 * Pattern dispatch. Returns the processor result for the orchestrator to finalize.
 *
 * ジョブ initiation: status 遷移（queued → in_progress）＋ Strategy Pattern dispatch。
 * Processor 結果を orchestrator に返して finalize する。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出（complexity < 10）。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2 (complexity < 10).
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing):
 * - `computeRemainingStatus` を single-query refactor 版に更新 (`{finalStatus, pendingSnapshot}` 返却)。
 * - `handleTerminalParityGate` sub-function を抽出し、terminal transition 直前に
 *   parity gate を挿入。親関数の cyclomatic complexity ≤ 10 を維持 (FIND-PLAN-IO-08)。
 * - Return type `finalStatus` union に `"skipped_fork_error"` を追加 (Option A per FIND-PLAN-IO-03)。
 *   JSDoc 契約: "BullMQ job completes successfully while DB row is in retry bucket".
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing):
 * - Upgraded to single-query-refactor `computeRemainingStatus` returning
 *   `{finalStatus, pendingSnapshot}`.
 * - Extracted `handleTerminalParityGate` sub-function to insert the parity
 *   gate immediately before the terminal transition. Keeps parent cyclomatic
 *   complexity ≤ 10 (FIND-PLAN-IO-08).
 * - Return-type `finalStatus` union extended with `"skipped_fork_error"`
 *   (Option A per FIND-PLAN-IO-03). JSDoc contract: "BullMQ job completes
 *   successfully while DB row is in retry bucket".
 */
async function initiateBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<{
  generated: number;
  failed: number;
  /**
   * Final status returned to `processBackfillJob`. `"skipped_fork_error"`
   * indicates the INV-003 parity gate failed: the BullMQ job completes
   * successfully while the DB row is routed to the retry bucket
   * (see `handleTerminalParityGate` + FIND-PLAN-IO-03 Option A).
   */
  finalStatus: "completed" | "in_progress" | "skipped_fork_error";
  /**
   * PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1 Supplement S3):
   * `bbox_unresolvable` added (Playwright-residual catch-all from
   * `PartVisualProcessor`; mutually exclusive with `bbox_invalid`).
   */
  skipReason?: "ssrf_blocked_on_backfill" | "parity_check_failed" | "bbox_unresolvable";
}> {
  const { webPageId, category } = job.data;

  // PR-BT-4 H-1 (ADR-0018 Amendment 10 Decision 10.1 + 10.4): analysis-status
  // guard. The backfill worker is forked separately from page-analyze and can
  // run BEFORE page.analyze finalizes `analysisStatus='completed'`. Processing a
  // part category before the owning page is terminal causes the part-visual loop
  // to snapshot before concurrently-created parts exist, leaving them unmarked
  // (permanent pending → reconciliation force-`failed`). When the page is still
  // analyzing we bounded-re-enqueue via the retryCount-reuse mechanism (NOT
  // BullMQ retry) and skip processing; the retryCount cap is the deadlock guard.
  const shouldProceed = await evaluateAnalysisGuard(job);
  if (!shouldProceed) {
    // Re-enqueued (retryCount-bounded) or terminal-failed (cap reached). Do NOT
    // process the category and do NOT write a terminal `completed`/`in_progress`
    // — `transitionAnalysisGuard*` already set the row status (queued / failed).
    await job.updateProgress(PROGRESS_COMPLETE);
    return { generated: 0, failed: 0, finalStatus: "in_progress" };
  }

  // ジョブ開始直後に in_progress へ遷移（status 観測性）
  // Transition to in_progress immediately for observability
  await updateEmbeddingBackfillStatus(webPageId, "in_progress");

  // v0.4.0 PR7a-2: Strategy Pattern dispatch（exhaustiveness は Record で保証）
  // v0.4.0 PR7a-2: Strategy Pattern dispatch — exhaustiveness enforced by the Record
  await job.updateProgress(PROGRESS_AFTER_FETCH);
  const processor = getBackfillProcessor(category);

  const screenshotStoragePath = await resolveScreenshotForProcessor(
    processor,
    webPageId,
    category,
    job.data.screenshotStoragePath
  );

  const ctx: BackfillProcessContext = {
    webPageId,
    job,
    screenshotStoragePath,
    prisma: prisma as unknown as EmbeddingPhasePrismaClient,
  };
  const processorResult = await processor.process(ctx);
  await job.updateProgress(PROGRESS_AFTER_EMBEDDING);

  // 完了後の status 判定（残余があれば in_progress、無ければ completed）+ parity snapshot
  // Decide final status (in_progress if items remain, otherwise completed) + parity snapshot
  const { finalStatus: remainingStatus, pendingSnapshot } = await computeRemainingStatus(webPageId);

  // v0.4.0 PR-D-4: INV-EMBEDDING-INTEGRITY-003 terminal parity gate.
  // On parity failure the DB row transitions to `skipped_fork_error` (retry bucket)
  // and the caller-facing `finalStatus` matches the DB write (FIND-PLAN-IO-03
  // Option A). Parent cyclomatic complexity stays ≤ 10 via the extracted
  // `handleTerminalParityGate` sub-function (FIND-PLAN-IO-08).
  const parityOutcome = await handleTerminalParityGate(
    webPageId,
    remainingStatus,
    { generated: processorResult.generated, failed: processorResult.failed },
    pendingSnapshot
  );

  // Non-parity-failure path writes the computed finalStatus as usual.
  // parityFailed path already wrote `skipped_fork_error` in handleTerminalParityGate.
  if (!parityOutcome.parityFailed) {
    await updateEmbeddingBackfillStatus(webPageId, remainingStatus);
  }

  await job.updateProgress(PROGRESS_COMPLETE);
  await job.log(
    `[EmbeddingBackfill] Complete: generated=${processorResult.generated}, ` +
      `failed=${processorResult.failed}, status=${parityOutcome.finalStatus}`
  );

  // v0.4.0 PR7e-α (bug⑦ observability): surface ssrf_blocked_on_backfill onto
  // the job result so MCP clients can distinguish SSRF-blocked Backfill skips
  // from generic "0 generated" results.
  //
  // v0.4.0 PR-D-4: `skipReason: "parity_check_failed"` is also surfaced on
  // parity-failure so MCP clients observe the retry-bucket transition.
  //
  // PR-D-9 Wave 4 (C-02 + C-04): added `bbox_unresolvable` to the union to
  // accept Playwright-residual catch-all from `PartVisualProcessor` per
  // ADR-0018 §Decision 1 Supplement S3 (mutually exclusive with `bbox_invalid`,
  // mapped to `skipped_fork_error` retry bucket via `skipReasonToBackfillStatus`).
  const ret: {
    generated: number;
    failed: number;
    finalStatus: "completed" | "in_progress" | "skipped_fork_error";
    skipReason?: "ssrf_blocked_on_backfill" | "parity_check_failed" | "bbox_unresolvable";
  } = {
    generated: processorResult.generated,
    failed: processorResult.failed,
    finalStatus: parityOutcome.finalStatus,
  };
  if (parityOutcome.parityFailed) {
    ret.skipReason = "parity_check_failed";
  } else if (processorResult.skipReason !== undefined) {
    ret.skipReason = processorResult.skipReason;
  }
  return ret;
}

/**
 * Finalize the backfill job: failure-path status update (only on final attempt)
 * + Pre-Return Pause + post-job memory check.
 *
 * ジョブ finalization: 失敗時 status 更新（最終 attempt のみ）＋ Pre-Return Pause
 * ＋ post-job memory check。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出（complexity < 10）。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2 (complexity < 10).
 */
async function finalizeBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  error: unknown | null
): Promise<void> {
  const { webPageId } = job.data;

  // 失敗時のみ: 最終 attempt で failed 遷移
  // Failure path: transition to failed only on the final attempt
  if (error !== null) {
    // BullMQ の attempts=3 でリトライされるため、failed への更新は最終試行後のみ行う。
    // attemptsMade は 1-origin, job.opts.attempts は最大試行回数。
    //
    // Update to `failed` only on the final attempt — BullMQ will retry up to
    // `attempts=3` times. attemptsMade is 1-origin; opts.attempts is the cap.
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      // defect B fix (10-site CPU 検証で発見): plain `failed` ではなく
      // `failed_with_known_reason` + `failure_reason='stall_timeout'` + `failed_at`
      // に遷移させ、(1) failure metadata NULL の不整合を解消し、(2) recovery service
      // の scan window に乗せて DB 完全時に自動復帰可能にする
      // (`markBackfillFailedWithKnownReason` の JSDoc 参照)。
      // defect B fix: route to `failed_with_known_reason` + metadata instead of
      // plain `failed` so the row is auto-recoverable once the DB becomes complete.
      await markBackfillFailedWithKnownReason(webPageId, "stall_timeout");
    }
  }

  // Post-job Memory Gate (unified success + failure path, Plan v1.1 candidate B)
  // ---------------------------------------------------------------------
  // Plan v1.1 candidate B / ADR-0034 Amendment 5: Stage 2 `worker.pause(true)`
  // formal removal。success path / failure path 双方で `applyPostJobMemoryGate`
  // のみを呼び、`worker.pause` callsite は production code 全域で 0 件
  // (INV-WORKER-NO-PAUSE-001、AST gate `verify-no-worker-pause.mjs` で enforce、
  // exempt scope = BullMQ `pause:` event handler L1388 + test files)。
  //
  // 計画的再起動 (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) は constructor 段階で
  // pre-register された `worker.once('completed', listener)` (callback-based
  // exit、ADR-0034 §Decision 1) のみで担保される: processor return →
  // moveToCompleted Lua → emit('completed') → listener fire → process.exit(0)。
  //
  // H2 (moveToCompleted paused 評価 race) + H3 (event-loop starvation 下の
  // emit 遅延、BullMQ #359 indirect evidence) は本 candidate B で構造的消滅。
  // H1 (dispose ceiling 5s microtask race、ADR-0035 §Decision 1) は本 PR
  // scope 外、`registerCompletedListenerAndExit` 内で active 維持 (直交)。
  //
  // Plan v1.1 candidate B / ADR-0034 Amendment 5: Stage 2 `worker.pause(true)`
  // is formally removed. Both success and failure paths now call only
  // `applyPostJobMemoryGate`. `worker.pause` callsites in production code are
  // 0 (INV-WORKER-NO-PAUSE-001 enforced by AST gate `verify-no-worker-pause.mjs`;
  // exempt scope = BullMQ `pause:` event handler L1388 + test files). Planned
  // restart (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) is now exclusively driven by
  // the constructor-pre-registered `worker.once('completed', listener)`
  // (callback-based exit, ADR-0034 §Decision 1). H2 + H3 races are
  // structurally eliminated; H1 (dispose ceiling 5s, ADR-0035 §Decision 1)
  // remains active inside `registerCompletedListenerAndExit` (orthogonal).
  await applyPostJobMemoryGate(_preReturnPauseEnabled, "[EmbeddingBackfillWorker]");

  // Plan v4.2 callback-based exit: BullMQ native flow に制御を返し
  // worker.once('completed') listener が process.exit(0) を発火する
  // (ADR-0034 §Decision 1 Stage 5-8、Amendment 5 で Stage 2 pause 廃止後の
  // 7-stage に縮退)。
  // Plan v4.2 callback-based exit: yield control back to BullMQ native flow;
  // the worker.once('completed') listener fires process.exit(0).
}

/**
 * Main processor function for embedding backfill jobs.
 * Embedding バックフィルジョブのメイン Processor 関数。
 *
 * v0.4.0 PR7a-2: Strategy Pattern (`PROCESSORS` in `embedding-backfill-processors.ts`)
 * にカテゴリ別処理を委譲。`part_text` / `part_visual` 以外の 5 カテゴリも SSOT 上は
 * valid だが、runtime に enqueue されるのは現状 `part_text` / `part_visual` のみ
 * （PR7b で Skip recovery enqueue パス実装時に他カテゴリも runtime 活性化）。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `initiateBackfillJob` + `finalizeBackfillJob`
 * + `validateJobData` に分割。本関数は薄い orchestrator として残し、各関数の
 * cyclomatic complexity は < 10 に収まる。
 *
 * v0.4.0 PR7a-2: Delegates per-category logic to the Strategy Pattern
 * (`PROCESSORS` in `embedding-backfill-processors.ts`). The 5 non-part categories
 * are SSOT-valid but currently unreachable at runtime — only `part_text` /
 * `part_visual` are enqueued today. PR7b activates the rest via the skip-recovery
 * enqueue path.
 *
 * v0.4.0 PR7a-3: Split into `initiateBackfillJob` + `finalizeBackfillJob` +
 * `validateJobData` per TDA High-2. This function is now a thin orchestrator;
 * each helper keeps cyclomatic complexity < 10.
 */
async function processBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<EmbeddingBackfillJobResult> {
  const startTime = Date.now();

  validateJobData(job);

  const { webPageId, category } = job.data;

  if (isDevelopment()) {
    logger.info("[EmbeddingBackfillWorker] Processing job", {
      jobId: job.id,
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      category,
    });
  }

  await job.updateProgress(PROGRESS_START);
  // Wave 5 LCC canonical CWE-209 PII protection pattern (FIND-IMPL-LCC-PATCH-W5-02
  // anchor 019df7ab-2f5a): derive truncation length from
  // `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` SSOT rather than a hardcoded
  // `slice(0, 8)` literal. CO-21 carryover closure (Wave 4 V4).
  await job.log(
    `[EmbeddingBackfill] Started category=${category}, webPageId=${webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH)}...`
  );

  let generatedCount = 0;
  let failedCount = 0;
  let errorMsg: string | undefined;
  let caughtError: unknown | null = null;
  // PR-D-9 Wave 4 (C-02 + C-04): added `bbox_unresolvable` per ADR-0018
  // §Decision 1 Supplement S3 (Playwright-residual catch-all).
  let outcomeSkipReason:
    | "ssrf_blocked_on_backfill"
    | "parity_check_failed"
    | "bbox_unresolvable"
    | undefined;

  try {
    const outcome = await initiateBackfillJob(job);
    generatedCount = outcome.generated;
    failedCount = outcome.failed;
    if (outcome.skipReason !== undefined) {
      outcomeSkipReason = outcome.skipReason;
    }
  } catch (error) {
    caughtError = error;
    errorMsg = sanitizeErrorMessage(error);
    logger.error("[EmbeddingBackfillWorker] Job failed", {
      jobId: job.id,
      webPageId: webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      category,
      error: errorMsg,
    });
  } finally {
    await finalizeBackfillJob(job, caughtError);
  }

  if (caughtError !== null) {
    throw caughtError;
  }

  const processingTimeMs = Date.now() - startTime;
  const result: EmbeddingBackfillJobResult = {
    webPageId,
    category,
    generatedCount,
    failedCount,
    processingTimeMs,
    completedAt: new Date().toISOString(),
  };
  if (errorMsg !== undefined) {
    result.error = errorMsg;
  }
  if (outcomeSkipReason !== undefined) {
    result.skipReason = outcomeSkipReason;
  }
  return result;
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create an EmbeddingBackfillWorker instance
 *
 * EmbeddingBackfillWorker インスタンスを作成する
 *
 * @param options - Worker configuration
 * @returns Worker instance with lifecycle methods
 */
export function createEmbeddingBackfillWorker(
  options: EmbeddingBackfillWorkerOptions = {}
): EmbeddingBackfillWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info("[EmbeddingBackfillWorker] Creating worker", {
      queueName: EMBEDDING_BACKFILL_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>(
    EMBEDDING_BACKFILL_QUEUE_NAME,
    processBackfillJob,
    {
      // BullMQ 公式必須: Worker 接続では `maxRetriesPerRequest: null` を強制する
      // (BZPOPMIN blocking command が N 回失敗で中断されるのを防ぐ)。
      // https://docs.bullmq.io/guide/connections / taskforcesh/bullmq#2466
      // BullMQ requires `maxRetriesPerRequest: null` for Worker connections
      // so that BZPOPMIN does not abort after N retries.
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: null,
      },
      // Explicit start from start-workers.ts after local initialization is complete.
      autorun: false,
      concurrency,
      lockDuration,
      stalledInterval: Math.max(60_000, DEFAULT_STALLED_INTERVAL),
      maxStalledCount: DEFAULT_MAX_STALLED_COUNT,
    }
  );

  // Plan v1.1 candidate B / ADR-0034 Amendment 5: the success path no longer
  // needs a module-level worker ref because `applyPostJobLifecycleGate` is a
  // no-op stub and the canonical post-job gate (`applyPostJobMemoryGate`) is
  // worker-instance-free. The module-level `_workerInstanceRef` has been
  // removed.

  // Event handlers for monitoring
  worker.on("completed", (job, result) => {
    if (verbose) {
      logger.info("[EmbeddingBackfillWorker] Job completed", {
        jobId: job.id,
        webPageId: result.webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
        category: result.category,
        generatedCount: result.generatedCount,
      });
    }
    // Notify parent (WorkerSupervisor) via IPC for planned restart.
    //
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload now conforms to the
    // `WorkerIpcMessageSchema` SSOT. supervisor's `verifyWorkerIpcMessage`
    // rejects payloads lacking `workerType` or `timestamp`.
    // PR-D-8 Phase 2: IPC payload は SSOT スキーマ準拠で emit する。
    try {
      process.send?.({
        type: "job-completed",
        workerType: "embedding-backfill",
        jobId: job.id,
        timestamp: Date.now(),
      });
    } catch {
      /* non-fatal — IPC channel may be closed during shutdown */
    }
  });

  // Plan v4.2 PR-A: callback-based exit responsibility 集約 (TPA-V42-M-03 Option A
  // single-shot)。Worker constructor 内、既存 worker.on('completed', ...) IPC send
  // handler の **後** に register することで、Node.js EventEmitter の register 順
  // listener invoke 規約により IPC send → process.exit(0) の順序が deterministic
  // となる (parent への job-completed 通知が exit より先に flush される)。
  //
  // Plan v4.2 PR-L closure (TDA-V42-L-02): boilerplate を
  // `registerCompletedListenerAndExit` helper に集約。Helper 内 listener body は
  // SEC M-NEW-1 mandate (synchronous-only) を継承し、AST gate
  // `scripts/verify-completed-listener-sync.mjs` が helper file を含む
  // TARGETS list で synchronous-only を CI で enforce する。
  //
  // Cross-ref: ADR-0034 §Decision 1 Step C, Plan v4.2 §3.2 Step 4 + PR-L
  // closure (TDA-V42-L-02 helper extraction, SEC-V42-L-NEW-4 mandate).
  //
  // Plan v4.2 PR-A + PR-L (TDA-V42-L-02): callback-based exit listener is
  // registered via the shared helper `registerCompletedListenerAndExit`,
  // which retains SEC M-NEW-1 synchronous-only listener body contract.
  //
  // Plan v4.3 PR-M-B (FIND-PLAN-V43-H-01 closure / ADR-0035 §Decision 1):
  // bind `disposeFn` so the helper races dispose teardown against the
  // EMBEDDING_DISPOSE_CEILING_MS ceiling before forcing `process.exit(0)`,
  // restoring ADR-0019 close-before-dispose ordering on the planned-restart
  // path. The `disposeEmbeddingPipeline()` invocation is idempotent under
  // concurrent calls (PR-M-B `inFlightDispose` mutex) so racing with the
  // shutdown `close()` handler (line ~1056 below) executes the underlying
  // ONNX `service.dispose()` exactly once.
  //
  // Plan v4.3 PR-M-B (FIND-PLAN-V43-H-01 closure / ADR-0035 §Decision 1):
  // binds `disposeFn` to race ONNX teardown against the dispose ceiling on
  // the planned-restart path; underlying `disposeEmbeddingPipeline()` is
  // idempotent via the PR-M-B `inFlightDispose` mutex.
  registerCompletedListenerAndExit(worker, "embedding-backfill", {
    disposeFn: () => sharedLayoutEmbeddingService.disposeEmbeddingPipeline(),
  });

  worker.on("failed", (job, error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[EmbeddingBackfillWorker] Job failed event", {
      jobId: job?.id,
      webPageId:
        job?.data.webPageId?.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...",
      error: sanitizeErrorMessage(error),
    });
  });

  worker.on("error", (error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[EmbeddingBackfillWorker] Worker error", {
      error: sanitizeErrorMessage(error),
    });
  });

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info("[EmbeddingBackfillWorker] Closing worker");
      }
      isRunning = false;
      // Fix-1 (INFRA-EMBEDDING-MOTION-SIGABRT-001): close BullMQ Worker FIRST so
      // any in-flight job completes (and its lock releases) before we tear down
      // the ONNX Runtime pipeline. The previous order (`dispose → close`) raced
      // with motion-category batches whose final ONNX inference was still
      // running on the parent Worker Thread; tearing down the ONNX session
      // mid-inference triggered a native pthread abort (SIGABRT) due to ONNX
      // Runtime's COW pthread inheritance with the still-active inference.
      //
      // 修正: BullMQ Worker を先に close → in-flight job 完了と lock release を
      // 待つ → ONNX disposeEmbeddingPipeline() で安全に session 解放。
      // motion category 処理中に dispose が ONNX 推論と race して native
      // pthread abort (SIGABRT) を起こす問題を解消。
      //
      // Cross-ref: ADR-0019 "Embedding Worker Close-Before-Dispose Ordering",
      //            IO §13.16.4 Plan Decision (Fix-1 Option A).
      await worker.close();
      try {
        await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      } catch {
        /* non-fatal during shutdown */
      }
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info("[EmbeddingBackfillWorker] Pausing worker (no new jobs will be accepted)");
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports — for tests
// ============================================================================

// Exported only for unit tests. Not part of the public contract.
// 単体テスト用のみ。公開契約ではない。
export {
  processBackfillJob,
  initiateBackfillJob,
  finalizeBackfillJob,
  validateJobData,
  resolveScreenshotForProcessor,
  resolveScreenshotPath,
  computeRemainingStatus,
  updateEmbeddingBackfillStatus,
  // v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003): exposed for standing regression.
  emitParityCheckFailedIfEnabled,
  // v0.4.0 PR-D-5 (FIND-IMPL-IO-13 + FIND-TPA-PLAN-05): exposed for unit tests.
  emitCategoryDriftSentinel,
  handleTerminalParityGate,
  type ParityGateOutcome,
  type EmbeddingBackfillCategory,
};
