#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standalone Worker Startup Script
 *
 * Starts BullMQ workers for async job processing:
 * - PageAnalyzeWorker: Handles page.analyze async jobs
 * - EmbeddingBackfillWorker (v0.4.0 PR4): Handles Part text / visual embedding
 *   backfill for pages with more than 100 Parts (Queue-based Backfill).
 *
 * Usage:
 *   pnpm worker:start              # Start all workers (page-analyze + embedding-backfill)
 *   pnpm worker:start --page       # Start only PageAnalyzeWorker
 *   pnpm worker:start --backfill   # Start only EmbeddingBackfillWorker (v0.4.0 PR4)
 *
 * Or run directly:
 *   NODE_ENV=development npx tsx apps/mcp-server/src/scripts/start-workers.ts
 *
 * Environment Variables:
 *   REDIS_HOST (default: localhost)
 *   REDIS_PORT (default: 27379)
 *   PAGE_WORKER_CONCURRENCY (default: 1 - singleton browser, avoid race condition)
 *   EMBEDDING_BACKFILL_CONCURRENCY (default: 1 - OOM防御 / OOM defense, v0.4.0 PR4)
 *
 * @module scripts/start-workers
 */

/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";
import { computeMemoryProfile, logMemoryProfile } from "../services/worker-memory-profile";
// v0.4.0 PR7d-2: Redis-based dual-run detection.
// v0.4.0 PR7d-2: Redis ベース二重起動検出。
import {
  WorkerActiveLockService,
  generateBootToken,
  LOCK_HEARTBEAT_INTERVAL_MS,
} from "../services/worker-active-lock.service";
import {
  createPageAnalyzeWorker,
  type PageAnalyzeWorkerInstance,
} from "../workers/page-analyze-worker";
// v0.4.0 PR4: Queue-based backfill worker for Part text / visual embeddings
// v0.4.0 PR4: 100 件超の Part embedding を非同期処理する Worker
import {
  createEmbeddingBackfillWorker,
  type EmbeddingBackfillWorkerInstance,
} from "../workers/embedding-backfill-worker";
// [REMOVED v0.3.0] batch-quality-worker — quality.batch_evaluate removed
import { checkRedisConnection, getRedisConfig } from "../config/redis";
import { embeddingService } from "@reftrixmcp/ml";
import { prisma } from "@reftrixmcp/database";
import { webPageService } from "../services/web-page.service";
import {
  initializeAllServices,
  type ServiceInitializerConfig,
} from "../services/service-initializer";
import { createPageAnalyzeQueue } from "../queues/page-analyze-queue";
import { createEmbeddingBackfillQueue } from "../queues/embedding-backfill-queue";
import { categorizeByProgress } from "../services/orphaned-job-utils";
// v0.4.0 PR6: Cron jobs for screenshot TTL + backfill reconciliation
// v0.4.0 PR6: Screenshot TTL + backfill reconciliation の定期タスク
import {
  scheduleScreenshotCleanupCron,
  type ScreenshotCleanupCronHandle,
} from "../cron/screenshot-cleanup-cron";
import {
  scheduleBackfillReconciliationCron,
  type BackfillReconciliationCronHandle,
} from "../cron/backfill-reconciliation-cron";
import { createScreenshotPersistenceService } from "../services/screenshot-persistence.service";
// v0.4.0 PR7d-3 (SEC L-1): sanitize error messages before logging.
// v0.4.0 PR7d-3 (SEC L-1): 生 error.message は出力せず必ず sanitize する。
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// NOTE: Startup embedding backfill was removed (caused 33GB RSS bloat blocking Worker init).
// Missing embeddings are repaired via:
//   1. Post-Embedding Backfill in page-analyze-worker.ts (per-job, after Phase 5)
//   2. CLI: pnpm backfill:embeddings (manual, separate process)

// ============================================================================
// Constants
// ============================================================================

const WORKER_TYPES = {
  PAGE_ANALYZE: "page-analyze",
  // v0.4.0 PR4: Embedding backfill worker
  EMBEDDING_BACKFILL: "embedding-backfill",
  ALL: "all",
} as const;

type WorkerType = (typeof WORKER_TYPES)[keyof typeof WORKER_TYPES];

// ============================================================================
// Worker Instances
// ============================================================================

let pageAnalyzeWorker: PageAnalyzeWorkerInstance | null = null;
// v0.4.0 PR4: Embedding backfill worker instance
// v0.4.0 PR4: Embedding バックフィルワーカーのインスタンス
let embeddingBackfillWorker: EmbeddingBackfillWorkerInstance | null = null;
// v0.4.0 PR6: Cron job handles
// v0.4.0 PR6: Cron タスクのハンドル
let screenshotCleanupCron: ScreenshotCleanupCronHandle | null = null;
let backfillReconciliationCron: BackfillReconciliationCronHandle | null = null;

// ============================================================================
// Initialization
// ============================================================================

function loadEnvLocal(): void {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".env.local");
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, "utf8");
      raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
        const eqIndex = normalized.indexOf("=");
        if (eqIndex === -1) return;
        const key = normalized.slice(0, eqIndex).trim();
        let value = normalized.slice(eqIndex + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      });
      console.log(`[WorkerStartup] Loaded .env.local from ${candidate}`);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * Initialize services required by workers
 */
async function initializeServices(): Promise<void> {
  console.log("[WorkerStartup] Initializing services...");

  // Initialize all services (same as MCP server)
  const serviceConfig: ServiceInitializerConfig = {
    embeddingService,
    prisma,
    webPageService,
  };

  const initResult = initializeAllServices(serviceConfig);

  if (!initResult.success) {
    throw new Error(`Service initialization failed: ${initResult.error}`);
  }

  console.log("[WorkerStartup] Services initialized successfully");
}

/**
 * Check Redis connection
 */
async function checkRedis(): Promise<void> {
  const config = getRedisConfig();
  console.log(`[WorkerStartup] Checking Redis connection at ${config.host}:${config.port}...`);

  const status = await checkRedisConnection();

  if (!status.connected) {
    throw new Error(`Redis connection failed: ${status.error}`);
  }

  console.log(`[WorkerStartup] Redis connected (version: ${status.info?.version ?? "unknown"})`);
}

// ============================================================================
// Worker Management
// ============================================================================

/**
 * Start PageAnalyzeWorker
 */
function startPageAnalyzeWorker(): PageAnalyzeWorkerInstance {
  // Default concurrency = 1 to avoid race condition with singleton Playwright browser
  // BullMQ Worker + singleton browser causes "Target page, context or browser has been closed" errors
  const concurrency = parseInt(process.env.PAGE_WORKER_CONCURRENCY ?? "1", 10);

  console.log(`[WorkerStartup] Starting PageAnalyzeWorker (concurrency: ${concurrency})...`);

  const worker = createPageAnalyzeWorker({
    concurrency,
    verbose: true,
  });

  worker.worker.run().catch((error: Error) => {
    worker.worker.emit("error", error);
  });

  console.log("[WorkerStartup] PageAnalyzeWorker started successfully");
  return worker;
}

// [REMOVED v0.3.0] startBatchQualityWorker — quality.batch_evaluate removed

/**
 * Start EmbeddingBackfillWorker (v0.4.0 PR4)
 *
 * v0.4.0 PR4: `embedding-backfill` Queue を消費する Worker を起動する。
 * Part text / visual embedding の 100 件超バックフィル専用。
 * Page Analyze Worker と同じ WorkerSupervisor パターン (maxJobsBeforeRestart=1)
 * でスーパーバイズされる。
 *
 * v0.4.0 PR4: Starts the Worker that consumes the `embedding-backfill` Queue.
 * Dedicated to backfilling Part text / visual embeddings beyond the 100 limit.
 * Supervised using the same WorkerSupervisor pattern (maxJobsBeforeRestart=1)
 * as the Page Analyze Worker.
 */
function startEmbeddingBackfillWorker(): EmbeddingBackfillWorkerInstance {
  const concurrency = parseInt(process.env.EMBEDDING_BACKFILL_CONCURRENCY ?? "1", 10);

  console.log(`[WorkerStartup] Starting EmbeddingBackfillWorker (concurrency: ${concurrency})...`);

  const worker = createEmbeddingBackfillWorker({
    concurrency,
    verbose: true,
  });

  worker.worker.run().catch((error: Error) => {
    worker.worker.emit("error", error);
  });

  console.log("[WorkerStartup] EmbeddingBackfillWorker started successfully");
  return worker;
}

/**
 * Recover orphaned active jobs from the embedding-backfill Queue (v0.4.0 PR4)
 *
 * page-analyze-queue と同じ categorizeByProgress ベースの回復ロジックを使う。
 * 起動時 active のジョブはすべて孤立とみなし、progress に応じて failed / retry に振り分ける。
 *
 * Uses the same `categorizeByProgress` recovery logic as the page-analyze-queue.
 * All jobs active at startup are treated as orphans and routed to failed / retry
 * based on their progress value.
 */
async function recoverOrphanedEmbeddingBackfillJobs(): Promise<void> {
  console.log("[WorkerStartup] Checking for orphaned embedding-backfill jobs...");

  try {
    const queue = createEmbeddingBackfillQueue();
    const activeJobs = await queue.getJobs(["active"], 0, 100);

    if (activeJobs.length === 0) {
      console.log("[WorkerStartup] No orphaned embedding-backfill jobs found");
      await queue.close();
      return;
    }

    console.log(
      `[WorkerStartup] Found ${activeJobs.length} active embedding-backfill job(s) at startup`
    );

    let recoveredCount = 0;
    let retriedCount = 0;

    for (const job of activeJobs) {
      if (job.id === undefined) continue;

      const progress = typeof job.progress === "number" ? job.progress : 0;
      const category = categorizeByProgress(progress, job.processedOn);

      console.log(
        `[WorkerStartup]   Backfill job ${job.id}: progress=${progress}%, category=${category}`
      );

      try {
        // Embedding backfill ジョブは BullMQ attempts=3 で retry 可能なので、
        // 未完了の場合はすべて failed → retry に遷移させる。
        // Since backfill jobs support BullMQ retries (attempts=3), all incomplete
        // orphans are routed to failed → retry.
        if (category === "db_saved_but_stuck") {
          // backfill ジョブで progress >= 90 は embedding 処理途中（DB 保存前）
          // のケースが多いため、再試行させる方が安全。
          // progress >= 90 on backfill jobs usually means mid-processing (not yet
          // DB-saved); safer to retry.
          await job.moveToFailed(
            new Error(
              `Worker restarted during backfill (progress: ${progress}%). ` +
                "Job orphaned at startup recovery."
            ),
            "0",
            false
          );
          try {
            await job.retry("failed");
            console.log(`[WorkerStartup]     -> retried (will be reprocessed)`);
            retriedCount++;
          } catch {
            console.log(`[WorkerStartup]     -> failed (retry attempt failed)`);
          }
          recoveredCount++;
        } else {
          await job.moveToFailed(
            new Error("Worker restarted before backfill completed. Retrying automatically."),
            "0",
            false
          );
          try {
            await job.retry("failed");
            console.log(`[WorkerStartup]     -> retried (will be reprocessed)`);
            retriedCount++;
          } catch {
            console.log(`[WorkerStartup]     -> failed (retry attempt failed)`);
          }
          recoveredCount++;
        }
      } catch (error) {
        console.warn(
          `[WorkerStartup]     -> recovery failed (non-fatal): ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }

    await queue.close();
    console.log(
      `[WorkerStartup] Embedding-backfill recovery complete: ${recoveredCount} recovered, ${retriedCount} retried`
    );
  } catch (error) {
    console.warn(
      "[WorkerStartup] Orphaned embedding-backfill recovery failed (non-fatal):",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Recover orphaned active jobs from previous worker crash/restart
 *
 * ワーカー起動時に前回のクラッシュで孤立したジョブを検出・回復する。
 *
 * **重要**: 起動時にはBullMQ Workerがまだ存在しないため、active状態の
 * ジョブはすべて孤立ジョブとみなす。時間ベースの閾値チェックは不要。
 *
 * BullMQの moveToCompleted Luaスクリプトが次のジョブをatomicに取得するため、
 * 計画的再起動の直前にactiveに移されたジョブも確実に回復する。
 *
 * カテゴリ別アクション:
 * - db_saved_but_stuck (progress >= 90): completedに遷移
 * - processing_interrupted (0 < progress < 90): failedに遷移
 * - never_started (progress = 0): waitingに戻す（failed → retry）
 */
async function recoverOrphanedPageAnalyzeJobs(): Promise<void> {
  console.log("[WorkerStartup] Checking for orphaned active jobs...");

  try {
    const queue = createPageAnalyzeQueue();
    const activeJobs = await queue.getJobs(["active"], 0, 100);

    if (activeJobs.length === 0) {
      console.log("[WorkerStartup] No orphaned jobs found");
      await queue.close();
      return;
    }

    // At startup, ALL active jobs are orphans (no BullMQ Worker exists yet)
    console.log(
      `[WorkerStartup] Found ${activeJobs.length} active job(s) at startup — all orphaned by definition`
    );

    let recoveredCount = 0;
    let retriedCount = 0;

    for (const job of activeJobs) {
      if (job.id === undefined) continue;

      const progress = typeof job.progress === "number" ? job.progress : 0;
      const category = categorizeByProgress(progress, job.processedOn);
      const url = job.data?.url ?? "unknown";

      console.log(
        `[WorkerStartup]   Job ${job.id}: progress=${progress}%, category=${category}, url=${url}`
      );

      try {
        switch (category) {
          case "db_saved_but_stuck": {
            // DB保存済み（progress >= 90%）: completedに遷移
            await job.moveToCompleted(
              {
                webPageId: job.data?.webPageId ?? "",
                success: true,
                partialSuccess: true,
                completedPhases: [],
                failedPhases: [],
                processingTimeMs: 0,
                completedAt: new Date().toISOString(),
              },
              "0",
              false
            );
            console.log(`[WorkerStartup]     -> completed (DB already saved)`);
            recoveredCount++;
            break;
          }

          case "processing_interrupted": {
            // 処理中断（0 < progress < 90%）: failedに遷移
            await job.moveToFailed(
              new Error(
                `Worker restarted during processing (progress: ${progress}%). ` +
                  "Job orphaned at startup recovery."
              ),
              "0",
              false
            );
            console.log(`[WorkerStartup]     -> failed (processing interrupted)`);
            recoveredCount++;
            break;
          }

          case "never_started": {
            // 未開始（progress = 0）: waitingに戻す
            // BullMQ API: active → failed → retry → waiting
            await job.moveToFailed(
              new Error(
                "Worker restarted before processing started. Job will be retried automatically."
              ),
              "0",
              false
            );
            try {
              await job.retry("failed");
              console.log(`[WorkerStartup]     -> waiting (retried, will be processed)`);
              retriedCount++;
            } catch (retryError) {
              // retry失敗してもfailedには残るので致命的ではない
              console.warn(
                `[WorkerStartup]     -> failed (retry to waiting failed: ${
                  retryError instanceof Error ? retryError.message : retryError
                })`
              );
            }
            recoveredCount++;
            break;
          }
        }
      } catch (error) {
        console.warn(
          `[WorkerStartup]     -> recovery failed (non-fatal): ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }

    await queue.close();
    console.log(
      `[WorkerStartup] Startup recovery complete: ${recoveredCount} recovered, ${retriedCount} retried to waiting`
    );
  } catch (error) {
    // 回復失敗はワーカー起動を妨げない（Graceful Degradation）
    console.warn(
      "[WorkerStartup] Orphaned job recovery failed (non-fatal):",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Setup IPC shutdown handler
 *
 * WorkerSupervisorからのIPC 'shutdown' メッセージを受信し、
 * BullMQ Worker.close() を先行実行してジョブのロックを正しく解放する。
 * close()完了後にプロセスを終了する。
 */
function setupIpcShutdownHandler(): void {
  process.on("message", async (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message) {
      const msgType = (message as { type: string }).type;

      // Note: Phase 0 (IPC pause) は削除済み。
      // Pre-return pause パターンにより、Processor内で worker.pause(true) が呼ばれ
      // BullMQ moveToCompleted の fetchNext=false が保証されている。

      // Phase 1: shutdown — BullMQ Worker.close() でロック解放後にプロセス終了
      if (msgType === "shutdown") {
        console.log("[WorkerStartup] Received IPC shutdown message, closing BullMQ workers...");

        try {
          await shutdownWorkers();
        } catch (error) {
          console.error(
            "[WorkerStartup] Error during IPC-triggered shutdown:",
            error instanceof Error ? error.message : error
          );
          process.exit(1);
        }
      }
    }
  });
}

/**
 * Start workers based on type
 */
async function startWorkers(type: WorkerType): Promise<void> {
  // Initialize services first
  await initializeServices();

  // Check Redis
  await checkRedis();

  // Recover orphaned jobs from previous crashes before starting new workers
  if (type === WORKER_TYPES.PAGE_ANALYZE || type === WORKER_TYPES.ALL) {
    await recoverOrphanedPageAnalyzeJobs();
  }
  if (type === WORKER_TYPES.EMBEDDING_BACKFILL || type === WORKER_TYPES.ALL) {
    await recoverOrphanedEmbeddingBackfillJobs();
  }

  // Start workers
  switch (type) {
    case WORKER_TYPES.PAGE_ANALYZE:
      pageAnalyzeWorker = startPageAnalyzeWorker();
      break;

    case WORKER_TYPES.EMBEDDING_BACKFILL:
      embeddingBackfillWorker = startEmbeddingBackfillWorker();
      break;

    case WORKER_TYPES.ALL:
    default:
      pageAnalyzeWorker = startPageAnalyzeWorker();
      // v0.4.0 PR4: 同一プロセスで両 Worker を起動する。concurrency=1 なので
      // BullMQ の active 取得は Queue 単位で独立し、互いに干渉しない。
      // v0.4.0 PR4: Start both workers in the same process. With concurrency=1,
      // BullMQ's active job acquisition is independent per Queue and they do
      // not interfere with each other.
      embeddingBackfillWorker = startEmbeddingBackfillWorker();
      break;
  }

  // v0.4.0 PR6: Schedule periodic maintenance cron jobs alongside workers.
  // v0.4.0 PR6: Worker と並行して定期メンテナンス cron を起動する。
  if (type === WORKER_TYPES.ALL || type === WORKER_TYPES.EMBEDDING_BACKFILL) {
    try {
      const screenshotService = createScreenshotPersistenceService({
        prisma: prisma as unknown as Parameters<
          typeof createScreenshotPersistenceService
        >[0]["prisma"],
      });
      // exactOptionalPropertyTypes: undefined の明示代入を避けるため、環境変数が
      // 有効値を持つときだけプロパティを追加する。
      // exactOptionalPropertyTypes: add each option only when the env var holds
      // a valid value, to avoid explicit-undefined assignment.
      // TPA R-2: 起動直後の orphan 回収を有効化（1h 待機せず即時実行）。
      //          SCREENSHOT_CLEANUP_RUN_ON_START=false で無効化可能。
      // TPA R-2: Enable orphan recovery immediately on startup (without waiting 1h).
      //          Disable via SCREENSHOT_CLEANUP_RUN_ON_START=false.
      const screenshotOpts: Parameters<typeof scheduleScreenshotCleanupCron>[0] = {
        service: screenshotService,
        runOnStart: process.env.SCREENSHOT_CLEANUP_RUN_ON_START !== "false",
      };
      const screenshotInterval = parseIntEnv(process.env.SCREENSHOT_CLEANUP_INTERVAL_MS);
      if (screenshotInterval !== undefined) screenshotOpts.intervalMs = screenshotInterval;
      const screenshotOlderThan = parseIntEnv(process.env.SCREENSHOT_CLEANUP_OLDER_THAN_MS);
      if (screenshotOlderThan !== undefined) screenshotOpts.olderThanMs = screenshotOlderThan;
      const screenshotBatch = parseIntEnv(process.env.SCREENSHOT_CLEANUP_MAX_BATCH_SIZE);
      if (screenshotBatch !== undefined) screenshotOpts.maxBatchSize = screenshotBatch;
      screenshotCleanupCron = scheduleScreenshotCleanupCron(screenshotOpts);
      console.log("[WorkerStartup] Screenshot TTL cleanup cron scheduled");
    } catch (error) {
      console.warn(
        "[WorkerStartup] Failed to schedule screenshot cleanup cron (non-fatal):",
        error instanceof Error ? error.message : error
      );
    }

    try {
      const reconcileQueue = createEmbeddingBackfillQueue();
      // TPA R-2: 起動直後の stale backfill job 回収を有効化（1h 待機せず即時実行）。
      //          BACKFILL_RECONCILIATION_RUN_ON_START=false で無効化可能。
      // TPA R-2: Enable stale backfill job recovery immediately on startup.
      //          Disable via BACKFILL_RECONCILIATION_RUN_ON_START=false.
      const reconcileOpts: Parameters<typeof scheduleBackfillReconciliationCron>[0] = {
        prisma: prisma as unknown as Parameters<
          typeof scheduleBackfillReconciliationCron
        >[0]["prisma"],
        queue: reconcileQueue,
        runOnStart: process.env.BACKFILL_RECONCILIATION_RUN_ON_START !== "false",
      };
      const reconcileInterval = parseIntEnv(process.env.BACKFILL_RECONCILIATION_INTERVAL_MS);
      if (reconcileInterval !== undefined) reconcileOpts.intervalMs = reconcileInterval;
      const reconcileStale = parseIntEnv(process.env.BACKFILL_RECONCILIATION_STALE_THRESHOLD_MS);
      if (reconcileStale !== undefined) reconcileOpts.staleThresholdMs = reconcileStale;
      const reconcileBatch = parseIntEnv(process.env.BACKFILL_RECONCILIATION_BATCH_LIMIT);
      if (reconcileBatch !== undefined) reconcileOpts.batchLimit = reconcileBatch;
      backfillReconciliationCron = scheduleBackfillReconciliationCron(reconcileOpts);
      console.log("[WorkerStartup] Backfill reconciliation cron scheduled");
    } catch (error) {
      console.warn(
        "[WorkerStartup] Failed to schedule reconciliation cron (non-fatal):",
        error instanceof Error ? error.message : error
      );
    }
  }

  // Setup IPC shutdown handler (for WorkerSupervisor graceful shutdown)
  setupIpcShutdownHandler();

  console.log("[WorkerStartup] All requested workers are running");
  console.log("[WorkerStartup] Press Ctrl+C to stop");
}

/**
 * Parse a numeric environment variable as integer.
 * Returns undefined for missing / non-numeric / non-positive values so callers
 * fall through to their defaults.
 *
 * 数値型環境変数のパース。未設定 / 非数値 / 非正値は undefined を返し、
 * 呼び出し側のデフォルトにフォールバックさせる。
 */
function parseIntEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Gracefully shutdown workers
 */
async function shutdownWorkers(): Promise<void> {
  console.log("\n[WorkerStartup] Shutting down workers...");

  // v0.4.0 PR6: Stop cron jobs first so they don't fire after worker close.
  // v0.4.0 PR6: Worker close 前に cron を停止して、close 後の発火を防ぐ。
  if (screenshotCleanupCron) {
    try {
      screenshotCleanupCron.stop();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error stopping screenshot cleanup cron:",
        error instanceof Error ? error.message : error
      );
    }
    screenshotCleanupCron = null;
  }
  if (backfillReconciliationCron) {
    try {
      backfillReconciliationCron.stop();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error stopping backfill reconciliation cron:",
        error instanceof Error ? error.message : error
      );
    }
    backfillReconciliationCron = null;
  }

  const shutdownPromises: Promise<void>[] = [];

  if (pageAnalyzeWorker) {
    shutdownPromises.push(pageAnalyzeWorker.close());
  }
  // v0.4.0 PR4: Embedding backfill worker も並列に close する
  // v0.4.0 PR4: Close the embedding-backfill worker in parallel
  if (embeddingBackfillWorker) {
    shutdownPromises.push(embeddingBackfillWorker.close());
  }

  await Promise.all(shutdownPromises);

  // v0.4.0 PR7d-2: Release standalone Redis lock so subsequent starts succeed.
  // v0.4.0 PR7d-2: standalone Redis lock を解放し、後続起動が成功するように
  // する。
  await releaseStandaloneLock();

  console.log("[WorkerStartup] Workers shutdown complete");
  process.exit(0);
}

// ============================================================================
// Dual-Run Detection (v0.4.0 PR7d-2)
// ============================================================================

/**
 * v0.4.0 PR7d-2: Standalone-process lock state. When this script is run
 * directly (not as a fork child and not with the manual opt-out), it acquires
 * a Redis-based active-worker lock so subsequent invocations refuse to start.
 *
 * v0.4.0 PR7d-2: スタンドアロン実行時の lock 状態。fork 子でもなく手動
 * opt-out でもない場合、Redis ベース active-worker lock を取得して後続起動を
 * 拒否する。
 */
let standaloneLockService: WorkerActiveLockService | null = null;
let standaloneLockToken: string | null = null;
let standaloneLockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check existing worker lock and either exit (dual-run detected) or acquire
 * the lock (clean startup). Never throws — on Redis failure, a warning is
 * emitted and startup continues (fail-open for Redis outage, matching
 * pre-PR7d-2 behaviour rather than trapping the operator).
 *
 * 既存 worker lock を確認し、検出時は exit、不在時は lock 取得する。
 * Redis 失敗時は warning のみで起動継続 (Redis 障害時に operator を締め出さない
 * ため fail-open; PR7d-2 以前と同等の挙動を維持)。
 */
async function evaluateDualRunGuard(): Promise<void> {
  // 1. Test mode — skip entirely to avoid Vitest's maxWorkers parallelism
  //    racing on the same Redis key across test processes.
  //    テストモード — Vitest 並列実行で同一 Redis key を奪い合わないよう skip。
  if (process.env.NODE_ENV === "test") {
    return;
  }

  // 2. Fork child — bypass. The MCP server's WorkerSupervisor owns the lock
  //    and injects REFTRIX_WORKER_IS_CHILD=1 into every fork env.
  //    fork 子 — MCP サーバー supervisor が lock を所有しており、fork env に
  //    REFTRIX_WORKER_IS_CHILD=1 が注入されているため bypass。
  if (process.env.REFTRIX_WORKER_IS_CHILD === "1") {
    if (process.env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN) {
      console.log(
        "[WorkerStartup] Detected fork-child mode (REFTRIX_WORKER_IS_CHILD=1), skipping dual-run guard"
      );
    }
    return;
  }

  // 3. Manual opt-out — warn loudly then continue. Used by batch scripts
  //    (analyze-50-award-sites.ts etc.) that explicitly own the Worker
  //    lifecycle.
  //    手動 opt-out — 警告を出して続行。バッチスクリプトが明示的に Worker
  //    ライフサイクルを所有するケース用。
  if (process.env.REFTRIX_ALLOW_MANUAL_WORKER === "true") {
    console.warn(
      "[WorkerStartup] REFTRIX_ALLOW_MANUAL_WORKER=true — bypassing dual-run guard. " +
        "Ensure no other Worker is consuming the page-analyze Queue."
    );
    return;
  }

  // 4. Default path — consult Redis via discriminated union APIs so that
  //    Redis-unreachable fails open (warn + continue), while a real dual-run
  //    (existing owner or race-lost acquire) fails closed (exit 1). This
  //    matches ADR-0011's documented intent: "On Redis failure, warn-and-
  //    continue (fail-open, preserves pre-PR7d-2 behaviour)".
  //
  //    v0.4.0 PR7d-3 (SEC M-1): 従来は `checkExistingLock()` が Redis 障害時に
  //    null を返していたため、outer try/catch が Redis 例外を捕捉できず常に
  //    fail-closed で `process.exit(1)` になっていた。discriminated union API
  //    で race-lost と Redis 不可到達を明示的に区別する。
  const lockService = new WorkerActiveLockService();
  try {
    const probe = await lockService.probeExistingLock("page");
    if (probe.unavailable) {
      // Redis unreachable — fail-open. Matches pre-PR7d-2 behaviour so that
      // a Redis outage doesn't block legitimate single-Worker operation.
      // Redis 不到達 — fail-open で起動継続 (Redis 障害時に正当な単一 Worker
      // 起動を妨げないため)。
      console.warn(`[WorkerStartup] Redis dual-run guard unavailable (non-fatal): ${probe.error}`);
      try {
        await lockService.close();
      } catch {
        /* best-effort */
      }
      return;
    }

    if (probe.exists) {
      console.error(
        "[WorkerStartup] DUAL-RUN DETECTED: another Worker process already holds the " +
          "page-analyze active-worker lock in Redis. This typically means the MCP server " +
          "is running and managing its own fork-supervised Worker."
      );
      console.error(
        "[WorkerStartup] Options:\n" +
          "  1. Stop the MCP server (recommended).\n" +
          "  2. Run this script with REFTRIX_ALLOW_MANUAL_WORKER=true to explicitly opt out\n" +
          "     of the dual-run guard (only if you know the existing Worker is idle)."
      );
      await lockService.close();
      process.exit(1);
    }

    // No existing lock — attempt to acquire one for this standalone process.
    const token = generateBootToken();
    const acquire = await lockService.tryAcquireLock("page", token);
    if (!acquire.ok) {
      if (acquire.reason === "redis_unavailable") {
        // Redis became unreachable between probe and acquire — fail-open.
        // probe 以降に Redis 障害が発生 — fail-open で起動継続。
        console.warn(
          `[WorkerStartup] Redis dual-run guard unavailable during acquireLock (non-fatal): ${acquire.error}`
        );
        try {
          await lockService.close();
        } catch {
          /* best-effort */
        }
        return;
      }
      // race-lost — another process acquired between probe and acquire.
      // race 敗北 — probe と acquire の間に他プロセスが取得 — 二重起動として扱う。
      console.error(
        "[WorkerStartup] DUAL-RUN DETECTED (race condition during acquireLock). Exiting."
      );
      await lockService.close();
      process.exit(1);
    }

    standaloneLockService = lockService;
    standaloneLockToken = token;
    console.log("[WorkerStartup] Acquired active-worker lock (standalone mode)");

    // Refresh lock TTL on a heartbeat so long-running standalone workers
    // don't lose ownership mid-job. v0.4.0 PR7d-3 (SEC L-2): wrap each
    // extendLock call in Promise.race with a 10s timeout so that a hung
    // Redis call doesn't block the heartbeat cadence.
    // long-running standalone worker が lock を失わないよう heartbeat で
    // TTL を延長する。SEC L-2: extendLock が hang した場合に heartbeat
    // setInterval 自体が詰まらないよう 10s タイムアウトで保護する。
    standaloneLockHeartbeatTimer = setInterval(() => {
      if (!standaloneLockService || !standaloneLockToken) return;
      const EXTEND_TIMEOUT_MS = 10_000;
      const extendPromise = standaloneLockService.extendLock("page", standaloneLockToken);
      void Promise.race([
        extendPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("extendLock timeout")), EXTEND_TIMEOUT_MS).unref?.()
        ),
      ]).catch((error: unknown) => {
        console.warn(
          `[WorkerStartup] extendLock heartbeat failed (non-fatal): ${sanitizeErrorMessage(error)}`
        );
      });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    standaloneLockHeartbeatTimer.unref?.();
  } catch (error) {
    // Unexpected error (not a Redis transport error — those are returned via
    // discriminated unions now). Log and fail-open — operator can inspect.
    // 予期しないエラー (Redis transport エラーは discriminated union で返る
    // ため、ここに到達するのは API 使用ミスや型不整合など)。fail-open。
    console.warn(
      `[WorkerStartup] Dual-run guard encountered unexpected error (non-fatal): ${sanitizeErrorMessage(error)}`
    );
    try {
      await lockService.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Release the standalone-mode Redis lock during shutdown. Best-effort.
 *
 * shutdown 時に standalone lock を解放する (ベストエフォート)。
 */
async function releaseStandaloneLock(): Promise<void> {
  if (standaloneLockHeartbeatTimer !== null) {
    clearInterval(standaloneLockHeartbeatTimer);
    standaloneLockHeartbeatTimer = null;
  }
  if (standaloneLockService && standaloneLockToken) {
    try {
      await standaloneLockService.releaseLock("page", standaloneLockToken);
      await standaloneLockService.close();
    } catch {
      /* best-effort */
    }
  }
  standaloneLockService = null;
  standaloneLockToken = null;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  loadEnvLocal();

  // Validate environment
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "development";
    console.warn("[WorkerStartup] NODE_ENV not set, defaulting to development");
  }

  console.log(`[WorkerStartup] Starting workers (NODE_ENV: ${process.env.NODE_ENV})`);

  // v0.4.0 PR7d-2: Check for dual-run BEFORE doing any heavy init work.
  // v0.4.0 PR7d-2: 重い初期化に入る前に二重起動チェックを実施する。
  await evaluateDualRunGuard();

  // Log memory profile at startup
  const memProfile = computeMemoryProfile();
  logMemoryProfile(memProfile);

  // Parse command line arguments
  const args = process.argv.slice(2);
  let workerType: WorkerType = WORKER_TYPES.ALL;

  if (args.includes("--page") || args.includes("-p")) {
    workerType = WORKER_TYPES.PAGE_ANALYZE;
  } else if (args.includes("--backfill") || args.includes("-b")) {
    // v0.4.0 PR4: Embedding backfill worker のみを起動するオプション
    // v0.4.0 PR4: option to start only the embedding-backfill worker
    workerType = WORKER_TYPES.EMBEDDING_BACKFILL;
  }

  // Setup signal handlers
  process.on("SIGINT", shutdownWorkers);
  process.on("SIGTERM", shutdownWorkers);

  // Common fatal error handler to prevent silent worker death.
  // v0.4.0 PR7d-3 (SEC L-1): sanitize error.message so internal stacks /
  // DB column names are not leaked to logs that may be ingested by external
  // observability platforms.
  function handleFatalError(label: string, error: unknown): void {
    const message = sanitizeErrorMessage(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[WorkerStartup] ${label}:`, message);
    if (stack) {
      console.error("[WorkerStartup] Stack:", stack);
    }
    // Attempt graceful shutdown with 10s timeout
    const shutdownTimeout = setTimeout(() => {
      console.error("[WorkerStartup] Graceful shutdown timed out after 10s, forcing exit");
      process.exit(1);
    }, 10000);
    shutdownTimeout.unref();
    shutdownWorkers()
      .catch(() => {
        // shutdown errors are non-fatal at this point
      })
      .finally(() => {
        clearTimeout(shutdownTimeout);
        process.exit(1);
      });
  }

  // Setup uncaught error handlers
  process.on("uncaughtException", (error: Error) => {
    handleFatalError("Uncaught exception", error);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    handleFatalError("Unhandled rejection", reason);
  });

  // v0.4.0 PR7d-3 (TPA LOW-3): best-effort release of the standalone Redis
  // lock on fatal exit so that a crashed Worker doesn't leak the lock until
  // its 60s TTL expires. `process.on('exit', ...)` handlers are synchronous,
  // so we fire-and-forget via releaseLock (no await).
  // v0.4.0 PR7d-3 (TPA LOW-3): crash 時の lock リーク防止。
  process.on("exit", () => {
    if (standaloneLockService && standaloneLockToken) {
      // fire-and-forget; exit handler is synchronous so we cannot await.
      standaloneLockService.releaseLock("page", standaloneLockToken).catch(() => {
        /* best-effort */
      });
    }
  });

  try {
    await startWorkers(workerType);
  } catch (error) {
    // v0.4.0 PR7d-3 (SEC L-1): sanitize error before logging.
    // v0.4.0 PR7d-3 (SEC L-1): 生 error.message を出力しないよう sanitize する。
    console.error("[WorkerStartup] Failed to start workers:", sanitizeErrorMessage(error));
    process.exit(1);
  }
}

// Entry point
main().catch((error) => {
  // v0.4.0 PR7d-3 (SEC L-1): sanitize error before logging.
  console.error("[WorkerStartup] Unhandled error:", sanitizeErrorMessage(error));
  process.exit(1);
});
