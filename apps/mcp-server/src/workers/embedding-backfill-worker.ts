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

import { Worker, type Job } from "bullmq";
import { prisma } from "@reftrixmcp/database";
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
import {
  EMBEDDING_BACKFILL_QUEUE_NAME,
  EmbeddingBackfillJobDataSchema,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";
import {
  getBackfillProcessor,
  type BackfillProcessContext,
} from "../queues/embedding-backfill-processors";
import { getRedisConfig, type RedisConfig } from "../config/redis";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { safeParseInt } from "../utils/safe-parse-int";
import { countPartVisualBackfillTargets } from "../services/embedding-backfill.service";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../services/layout-embedding.service";
import { validateScreenshotPath } from "../services/screenshot-persistence.service";
import { applyPreReturnPauseAndMemoryGate } from "./shared/post-job-lifecycle";
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

// ============================================================================
// Pre-Return Pause — OOM prevention via planned restart
// ============================================================================

/**
 * Module-level reference to the BullMQ Worker instance.
 * Set by createEmbeddingBackfillWorker(), read by processBackfillJob().
 *
 * Pre-Return Pause パターンのための Worker 参照 — Processor 内で `worker.pause(true)`
 * を呼ぶことで BullMQ moveToCompleted の fetchNext=false を保証し、
 * WorkerSupervisor の 1-job 再起動と安全に協調する。
 *
 * Worker reference for the Pre-Return Pause pattern — calling `worker.pause(true)`
 * inside the processor guarantees fetchNext=false during BullMQ moveToCompleted,
 * safely cooperating with the WorkerSupervisor 1-job restart policy.
 */
let _workerInstanceRef: Worker<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null = null;

/**
 * Pre-return pause enabled when WORKER_MAX_JOBS_BEFORE_RESTART > 0 (default: 1).
 * Same env var as page-analyze-worker to keep restart policy aligned.
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

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
      webPageId: webPageId.slice(0, 8) + "...",
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
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to fetch screenshot path from DB", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, 8) + "...",
    });
  }
  return null;
}

/**
 * Determine the remaining backfill status for a webPage after a Worker run.
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA 申し送り): 全 7 カテゴリの残件を確認する。
 * いずれかのカテゴリで未完了行が残っていれば `in_progress` を維持。
 * PR5 Counter Reconciliation の 9 カテゴリ DB authoritative と同じカウント方法を採用。
 *
 * Categories checked (matching `EMBEDDING_BACKFILL_CATEGORIES`):
 *   - part_text: component_parts.embedding IS NULL
 *   - part_visual: component_part_embeddings.visual_embedding IS NULL (PII filtered)
 *   - section_visual: section_embeddings.text_embedding IS NOT NULL AND vision_embedding IS NULL
 *   - motion: motion_patterns without motion_embeddings row
 *   - background: background_designs without background_design_embeddings row
 *   - js_animation: js_animation_patterns without js_animation_embeddings row
 *   - responsive: responsive_analyses without responsive_analysis_embeddings row
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA carryover): Checks remaining items across all 7
 * categories. Any remaining row keeps the status as `in_progress`. Mirrors the
 * 9-category DB-authoritative counts from the PR5 Counter Reconciliation.
 */
async function computeRemainingStatus(webPageId: string): Promise<"completed" | "in_progress"> {
  const [
    partTextPending,
    partVisualPending,
    sectionVisualPending,
    motionPending,
    backgroundPending,
    jsAnimationPending,
    responsivePending,
  ] = await Promise.all([
    // part_text
    prisma.componentPart.count({
      where: {
        webPageId,
        piiRiskLevel: { not: "high" },
        embedding: { is: null },
      },
    }),
    // part_visual
    countPartVisualBackfillTargets(webPageId),
    // section_visual: text_embedding がある section のうち vision_embedding NULL
    // section_visual: sections with text_embedding but vision_embedding NULL
    prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
      `SELECT COUNT(*)::bigint AS count FROM section_embeddings se
       JOIN section_patterns sp ON se.section_pattern_id = sp.id
       WHERE sp.web_page_id = $1::uuid
         AND se.text_embedding IS NOT NULL
         AND se.vision_embedding IS NULL`,
      webPageId
    ),
    // motion: motion_patterns に対応する motion_embeddings 行が無い件数
    // motion: motion_patterns rows lacking a corresponding motion_embeddings row
    prisma.motionPattern.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // background: background_designs に対応する embedding 行が無い件数
    // background: background_designs lacking an embedding row
    prisma.backgroundDesign.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // js_animation
    prisma.jSAnimationPattern.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // responsive
    prisma.responsiveAnalysis.count({
      where: { webPageId, embedding: { is: null } },
    }),
  ]);

  const parseBigint = (rows: Array<{ count: bigint | string }>): number => {
    const raw = rows[0]?.count ?? 0;
    const n = typeof raw === "bigint" ? Number(raw) : Number.parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const sectionVisualCount = parseBigint(sectionVisualPending);

  const totalPending =
    partTextPending +
    partVisualPending.pendingCount +
    sectionVisualCount +
    motionPending +
    backgroundPending +
    jsAnimationPending +
    responsivePending;

  return totalPending === 0 ? "completed" : "in_progress";
}

/**
 * Safely update `web_pages.embeddingBackfillStatus`.
 * DB 更新失敗は致命的でないので warn のみ出力して続行する。
 */
async function updateEmbeddingBackfillStatus(
  webPageId: string,
  status: "in_progress" | "completed" | "failed"
): Promise<void> {
  try {
    await prisma.webPage.update({
      where: { id: webPageId },
      data: { embeddingBackfillStatus: status },
    });
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to update embeddingBackfillStatus", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, 8) + "...",
      status,
    });
  }
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
      webPageId: webPageId.slice(0, 8) + "...",
    });
  }
  return resolved ?? undefined;
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
 */
async function initiateBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<{
  generated: number;
  failed: number;
  finalStatus: "completed" | "in_progress";
  skipReason?: "ssrf_blocked_on_backfill";
}> {
  const { webPageId, category } = job.data;

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

  // 完了後の status 判定（残余があれば in_progress、無ければ completed）
  // Decide final status (in_progress if items remain, otherwise completed)
  const finalStatus = await computeRemainingStatus(webPageId);
  await updateEmbeddingBackfillStatus(webPageId, finalStatus);

  await job.updateProgress(PROGRESS_COMPLETE);
  await job.log(
    `[EmbeddingBackfill] Complete: generated=${processorResult.generated}, ` +
      `failed=${processorResult.failed}, status=${finalStatus}`
  );

  // v0.4.0 PR7e-α (bug⑦ observability): surface ssrf_blocked_on_backfill onto
  // the job result so MCP clients can distinguish SSRF-blocked Backfill skips
  // from generic "0 generated" results.
  const ret: {
    generated: number;
    failed: number;
    finalStatus: "completed" | "in_progress";
    skipReason?: "ssrf_blocked_on_backfill";
  } = {
    generated: processorResult.generated,
    failed: processorResult.failed,
    finalStatus,
  };
  if (processorResult.skipReason !== undefined) {
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
      await updateEmbeddingBackfillStatus(webPageId, "failed");
    }
  }

  // Pre-Return Pause + Memory-Gated Exit/Resume (v0.4.0 PR7c)
  // ---------------------------------------------------------------------
  // fetchNext=false を保証した上で、RSS が閾値超過なら `process.exit(0)` で
  // WorkerSupervisor に再起動を委ね、閾値未満なら `worker.resume()` で
  // 新規ジョブ取得を再開する。従来は exit 経路のみだったため RSS 軽量 Worker で
  // pause が永続化していた（PR7c バグ1）。
  //
  // Guarantees fetchNext=false; on RSS threshold breach `process.exit(0)` hands
  // control to WorkerSupervisor, otherwise `worker.resume()` restores job
  // acquisition. Legacy exit-only path left RSS-light workers permanently
  // paused (PR7c Bug 1).
  //
  // Note: failure path (error !== null) も同じ pause+gate を適用する。
  //       失敗時も fetchNext=false で BullMQ リトライ枠を保護する必要がある。
  // Note: the failure path (error !== null) also applies the same pause+gate.
  //       On failure we still want fetchNext=false to protect BullMQ retry semantics.
  await applyPreReturnPauseAndMemoryGate(
    _workerInstanceRef,
    _preReturnPauseEnabled,
    "[EmbeddingBackfillWorker]"
  );
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
      webPageId: webPageId.slice(0, 8) + "...",
      category,
    });
  }

  await job.updateProgress(PROGRESS_START);
  await job.log(
    `[EmbeddingBackfill] Started category=${category}, webPageId=${webPageId.slice(0, 8)}...`
  );

  let generatedCount = 0;
  let failedCount = 0;
  let errorMsg: string | undefined;
  let caughtError: unknown | null = null;
  let outcomeSkipReason: "ssrf_blocked_on_backfill" | undefined;

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
      webPageId: webPageId.slice(0, 8) + "...",
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

  // Set module-level reference for Processor→Worker bridge (pre-return pause)
  _workerInstanceRef = worker;

  // Event handlers for monitoring
  worker.on("completed", (job, result) => {
    if (verbose) {
      logger.info("[EmbeddingBackfillWorker] Job completed", {
        jobId: job.id,
        webPageId: result.webPageId.slice(0, 8) + "...",
        category: result.category,
        generatedCount: result.generatedCount,
      });
    }
    // Notify parent (WorkerSupervisor) via IPC for planned restart
    try {
      process.send?.({ type: "job-completed", jobId: job.id });
    } catch {
      /* non-fatal — IPC channel may be closed during shutdown */
    }
  });

  worker.on("failed", (job, error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[EmbeddingBackfillWorker] Job failed event", {
      jobId: job?.id,
      webPageId: job?.data.webPageId?.slice(0, 8) + "...",
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
      try {
        await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      } catch {
        /* non-fatal during shutdown */
      }
      await worker.close();
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
  type EmbeddingBackfillCategory,
};
