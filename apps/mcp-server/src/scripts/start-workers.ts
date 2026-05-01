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

import { loadEnvLocal as loadEnvLocalShared } from "@reftrixmcp/core";
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
import {
  createPageAnalyzeQueue,
  createQueueEvents as createPageAnalyzeQueueEvents,
  registerPageAnalyzeDuplicatedListener,
} from "../queues/page-analyze-queue";
import {
  createEmbeddingBackfillQueue,
  createEmbeddingBackfillQueueEvents,
  registerEmbeddingBackfillDuplicatedListener,
} from "../queues/embedding-backfill-queue";
import type { QueueEvents } from "bullmq";
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
// PR-B (v0.4.0 PR7e P4 / LCC-M3-03): Phase 0 stale row cleanup cron
// PR-B (v0.4.0 PR7e P4 / LCC-M3-03): Phase 0 stale 行 cleanup cron
import {
  schedulePhase0CleanupCron,
  type Phase0CleanupCronHandle,
} from "../cron/phase0-cleanup-cron";
import { createScreenshotPersistenceService } from "../services/screenshot-persistence.service";
import { createPhase0CleanupService } from "../services/phase0-cleanup.service";
// v0.4.0 PR7d-3 (SEC L-1): sanitize error messages before logging.
// v0.4.0 PR7d-3 (SEC L-1): 生 error.message は出力せず必ず sanitize する。
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// SEC-M1-02 (ADR-0016 § Test-only Env Var Guard, deadline 2026-05-15):
// worker entry point (3rd of 3 entry points) で test-only env var leak を遮断する。
// loadEnvLocal() 直後に呼ぶことで .env.local 経由のリーク (誤って
// EMBEDDING_MODEL_MOCK=true を本番 .env に書いた場合等) も検出可能。
// SEC-M1-02: enforce guard at the worker entry point right after loadEnvLocal()
// so that even leaks via .env.local are caught fail-fast.
import { assertNoTestOnlyEnvLeak } from "../config/test-env-guard";
// NOTE: Startup embedding backfill was removed (caused 33GB RSS bloat blocking Worker init).
// Missing embeddings are repaired via:
//   1. Post-Embedding Backfill in page-analyze-worker.ts (per-job, after Phase 5)
//   2. CLI: pnpm backfill:embeddings (manual, separate process)

// ============================================================================
// Constants
// ============================================================================

// PR-D-8 Phase 2 (§3.2.1 / TDA-01 H resolution): WorkerType SSOT migration.
// Pre-PR-D-8 start-workers.ts declared its own `WORKER_TYPES` const with
// legacy CLI flag name `"page-analyze"`. Post-migration, internal code uses
// the SSOT `WorkerType` union (`"page" | "embedding-backfill"`), the CLI
// boundary still accepts legacy `"page-analyze"` via `START_WORKERS_CLI_MAPPING`,
// and the `"all"` pseudo-value is represented via the orthogonal `StartMode`
// type.
// PR-D-8 Phase 2 (§3.2.1 / TDA-01 H): WorkerType SSOT へ統合。CLI 境界は
// legacy `"page-analyze"` flag を 1-cycle 互換維持 (START_WORKERS_CLI_MAPPING
// 経由) する。
import type { StartMode, WorkerType } from "../types/worker-type";
import { WORKER_TYPES as SSOT_WORKER_TYPES } from "../types/worker-type";

// ============================================================================
// Worker Instances
// ============================================================================

let pageAnalyzeWorker: PageAnalyzeWorkerInstance | null = null;
// v0.4.0 PR4: Embedding backfill worker instance
// v0.4.0 PR4: Embedding バックフィルワーカーのインスタンス
let embeddingBackfillWorker: EmbeddingBackfillWorkerInstance | null = null;
// PR-D-6 Registry v4 §15.2 Patch Binding B (FIND-TPA-IMPL-02): observability-only
// QueueEvents "duplicated" listener pair + detach callbacks + QueueEvents handles
// for shutdown lifecycle tear-down.
// PR-D-6 Registry v4 §15.2: `duplicated` listener の wiring と cleanup 用の状態。
let pageAnalyzeQueueEvents: QueueEvents | null = null;
let embeddingBackfillQueueEvents: QueueEvents | null = null;
let embeddingBackfillDuplicatedDetach: (() => void) | null = null;
// v0.4.0 PR6: Cron job handles
// v0.4.0 PR6: Cron タスクのハンドル
let screenshotCleanupCron: ScreenshotCleanupCronHandle | null = null;
let backfillReconciliationCron: BackfillReconciliationCronHandle | null = null;
// PR-B (v0.4.0 PR7e P4): Phase 0 stale row cleanup cron handle
let phase0CleanupCron: Phase0CleanupCronHandle | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Load .env.local via the shared `@reftrixmcp/core` helper.
 *
 * PR7e-β1: replaced the local implementation with the shared helper so that
 * start-workers / CLI scripts / repair scripts share identical semantics
 * (SEC-β-01 maxDepth, SEC-β-07 verbose=false, existing env preserved).
 */
function loadEnvLocal(): void {
  const result = loadEnvLocalShared({ verbose: false });
  if (result.loaded && result.path) {
    console.log(`[WorkerStartup] Loaded .env.local from ${result.path}`);
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
        // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
        // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
        console.warn(
          `[WorkerStartup]     -> recovery failed (non-fatal): ${sanitizeErrorMessage(error)}`
        );
      }
    }

    await queue.close();
    console.log(
      `[WorkerStartup] Embedding-backfill recovery complete: ${recoveredCount} recovered, ${retriedCount} retried`
    );
  } catch (error) {
    // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
    // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
    console.warn(
      "[WorkerStartup] Orphaned embedding-backfill recovery failed (non-fatal):",
      sanitizeErrorMessage(error)
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
        // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
        // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
        console.warn(
          `[WorkerStartup]     -> recovery failed (non-fatal): ${sanitizeErrorMessage(error)}`
        );
      }
    }

    await queue.close();
    console.log(
      `[WorkerStartup] Startup recovery complete: ${recoveredCount} recovered, ${retriedCount} retried to waiting`
    );
  } catch (error) {
    // 回復失敗はワーカー起動を妨げない（Graceful Degradation）
    // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
    // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
    console.warn(
      "[WorkerStartup] Orphaned job recovery failed (non-fatal):",
      sanitizeErrorMessage(error)
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
          // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
          // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
          console.error(
            "[WorkerStartup] Error during IPC-triggered shutdown:",
            sanitizeErrorMessage(error)
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
async function startWorkers(mode: StartMode): Promise<void> {
  // Initialize services first
  await initializeServices();

  // Check Redis
  await checkRedis();

  // Recover orphaned jobs from previous crashes before starting new workers.
  // PR-D-8 §3.2.1: StartMode semantics — "all" means every WorkerType,
  // specific WorkerType values target only that worker.
  const includesPage = mode === "page" || mode === "all";
  const includesBackfill = mode === "embedding-backfill" || mode === "all";

  if (includesPage) {
    await recoverOrphanedPageAnalyzeJobs();
  }
  if (includesBackfill) {
    await recoverOrphanedEmbeddingBackfillJobs();
  }

  // Start workers
  if (includesPage) {
    pageAnalyzeWorker = startPageAnalyzeWorker();
  }
  if (includesBackfill) {
    // v0.4.0 PR4: 同一プロセスで両 Worker を起動する場合、BullMQ の active 取得は
    // Queue 単位で独立し、互いに干渉しない (concurrency=1)。PR-D-8 ではこのヘルパー
    // は "all" および "embedding-backfill" 単独モードの両方で呼ばれる。
    // v0.4.0 PR4: When both workers run in the same process, BullMQ's active
    // acquisition is independent per Queue (concurrency=1). PR-D-8 invokes this
    // for both "all" and the dedicated "embedding-backfill" mode.
    embeddingBackfillWorker = startEmbeddingBackfillWorker();
  }

  // PR-D-6 Registry v4 §15.2 Patch Binding B (FIND-TPA-IMPL-02 +
  // FIND-SEC-04 co-close): wire observability-only `"duplicated"` listeners on
  // both Queue's QueueEvents instances so a BullMQ jobId collision (case (a)(b)
  // (c) in Plan §2.2) emits a correlated `logger.warn` in addition to the
  // `*_collision_resolved` audit_logs row. Register only for Queue types that
  // were actually started to avoid unnecessary Redis pubsub connections.
  // PR-D-6 Registry v4 §15.2: 両 Queue の "duplicated" listener を wire して
  // observability を確保する。起動していない Queue には register しない。
  try {
    if (includesPage) {
      pageAnalyzeQueueEvents = createPageAnalyzeQueueEvents();
      registerPageAnalyzeDuplicatedListener(pageAnalyzeQueueEvents);
      console.log("[WorkerStartup] page-analyze QueueEvents duplicated listener registered");
    }
    if (includesBackfill) {
      embeddingBackfillQueueEvents = createEmbeddingBackfillQueueEvents();
      embeddingBackfillDuplicatedDetach = registerEmbeddingBackfillDuplicatedListener(
        embeddingBackfillQueueEvents
      );
      console.log("[WorkerStartup] embedding-backfill QueueEvents duplicated listener registered");
    }
  } catch (error) {
    // Observability-only path: listener failure must not block Worker startup.
    // observability-only path: listener wiring の失敗は Worker 起動を妨げない。
    console.warn(
      "[WorkerStartup] Failed to register duplicated listener (non-fatal):",
      sanitizeErrorMessage(error)
    );
  }

  // v0.4.0 PR6: Schedule periodic maintenance cron jobs alongside workers.
  // v0.4.0 PR6: Worker と並行して定期メンテナンス cron を起動する。
  if (includesBackfill) {
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
      // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
      // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
      console.warn(
        "[WorkerStartup] Failed to schedule screenshot cleanup cron (non-fatal):",
        sanitizeErrorMessage(error)
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
      // Item 2 / CO-30: cron polling cadence default 5min (was 1h pre-CO-30 closure).
      // Override via BACKFILL_RECONCILIATION_INTERVAL_MS for ops tuning.
      // Note: effective reconciliation upper bound = max(staleThresholdMs=1h,
      // intervalMs=5min) = 1h+5min worst-tail. True 12x SLO improvement requires
      // staleThresholdMs reduction, deferred to CO-30-FOLLOWUP M 2026-Q4.
      //
      // Item 2 / CO-30: cron ポーリング間隔のデフォルトは 5min (CO-30 closure 前は 1h)。
      // 運用チューニングは BACKFILL_RECONCILIATION_INTERVAL_MS で override。
      // 注: 実 reconciliation 上限 = max(staleThresholdMs=1h, intervalMs=5min) = 1h+5min worst-tail。
      // 真の 12x SLO 改善は staleThresholdMs 短縮が必要、CO-30-FOLLOWUP M 2026-Q4 へ繰越。
      const reconcileStale = parseIntEnv(process.env.BACKFILL_RECONCILIATION_STALE_THRESHOLD_MS);
      if (reconcileStale !== undefined) reconcileOpts.staleThresholdMs = reconcileStale;
      const reconcileBatch = parseIntEnv(process.env.BACKFILL_RECONCILIATION_BATCH_LIMIT);
      if (reconcileBatch !== undefined) reconcileOpts.batchLimit = reconcileBatch;
      backfillReconciliationCron = scheduleBackfillReconciliationCron(reconcileOpts);
      console.log("[WorkerStartup] Backfill reconciliation cron scheduled");
    } catch (error) {
      // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
      // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
      console.warn(
        "[WorkerStartup] Failed to schedule reconciliation cron (non-fatal):",
        sanitizeErrorMessage(error)
      );
    }

    // PR-B (v0.4.0 PR7e P4 / LCC-M3-03): Phase 0 stale row cleanup cron.
    // PHASE0_EARLY_INSERT=true で生成される failed row (robots.txt / SSRF /
    // DNS fail 等) を TTL ベース (default 7d) で掃除する。screenshot cleanup
    // と同じ cadence (24h) で動作し、runOnStart は default false。
    //
    // PR-B (v0.4.0 PR7e P4 / LCC-M3-03): Phase 0 stale row cleanup. Deletes
    // failed rows generated by PHASE0_EARLY_INSERT=true (robots.txt / SSRF /
    // DNS failures) on a TTL basis (default 7d). Same cadence as screenshot
    // cleanup (24h); runOnStart defaults to false.
    try {
      const phase0Service = createPhase0CleanupService({
        prisma: prisma as unknown as Parameters<typeof createPhase0CleanupService>[0]["prisma"],
      });
      const phase0Opts: Parameters<typeof schedulePhase0CleanupCron>[0] = {
        service: phase0Service,
        runOnStart: process.env.PHASE0_CLEANUP_RUN_ON_START === "true",
      };
      const phase0Interval = parseIntEnv(process.env.PHASE0_CLEANUP_INTERVAL_MS);
      if (phase0Interval !== undefined) phase0Opts.intervalMs = phase0Interval;
      const phase0OlderThan = parseIntEnv(process.env.PHASE0_CLEANUP_OLDER_THAN_MS);
      if (phase0OlderThan !== undefined) phase0Opts.olderThanMs = phase0OlderThan;
      const phase0Batch = parseIntEnv(process.env.PHASE0_CLEANUP_MAX_BATCH_SIZE);
      if (phase0Batch !== undefined) phase0Opts.maxBatchSize = phase0Batch;
      phase0CleanupCron = schedulePhase0CleanupCron(phase0Opts);
      console.log("[WorkerStartup] Phase 0 stale row cleanup cron scheduled");
    } catch (error) {
      console.warn(
        "[WorkerStartup] Failed to schedule Phase 0 cleanup cron (non-fatal):",
        sanitizeErrorMessage(error)
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
      // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
      // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
      console.warn(
        "[WorkerStartup] Error stopping screenshot cleanup cron:",
        sanitizeErrorMessage(error)
      );
    }
    screenshotCleanupCron = null;
  }
  if (backfillReconciliationCron) {
    try {
      backfillReconciliationCron.stop();
    } catch (error) {
      // PR-D-7 Wave 4: sanitize error.message via SSOT mapping (CWE-209 closure).
      // PR-D-7 Wave 4: SSOT マッピング経由でサニタイズ（CWE-209 対応）。
      console.warn(
        "[WorkerStartup] Error stopping backfill reconciliation cron:",
        sanitizeErrorMessage(error)
      );
    }
    backfillReconciliationCron = null;
  }
  // PR-B (v0.4.0 PR7e P4): Stop Phase 0 cleanup cron alongside other cron handles.
  if (phase0CleanupCron) {
    try {
      phase0CleanupCron.stop();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error stopping Phase 0 cleanup cron:",
        sanitizeErrorMessage(error)
      );
    }
    phase0CleanupCron = null;
  }

  // PR-D-6 Registry v4 §15.2 Patch Binding B (FIND-TPA-IMPL-02 +
  // FIND-SEC-04 lifecycle closure): detach `"duplicated"` listeners and close
  // the QueueEvents instances BEFORE Worker.close() so no new Redis pubsub
  // events arrive mid-shutdown. Best-effort; failures never block shutdown.
  // PR-D-6 Registry v4 §15.2: Worker.close() 前に listener を detach + QueueEvents
  // を close して、shutdown 中の新規 pubsub event 到着を防ぐ。
  if (embeddingBackfillDuplicatedDetach) {
    try {
      embeddingBackfillDuplicatedDetach();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error detaching embedding-backfill duplicated listener:",
        sanitizeErrorMessage(error)
      );
    }
    embeddingBackfillDuplicatedDetach = null;
  }
  if (pageAnalyzeQueueEvents) {
    try {
      await pageAnalyzeQueueEvents.close();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error closing page-analyze QueueEvents:",
        sanitizeErrorMessage(error)
      );
    }
    pageAnalyzeQueueEvents = null;
  }
  if (embeddingBackfillQueueEvents) {
    try {
      await embeddingBackfillQueueEvents.close();
    } catch (error) {
      console.warn(
        "[WorkerStartup] Error closing embedding-backfill QueueEvents:",
        sanitizeErrorMessage(error)
      );
    }
    embeddingBackfillQueueEvents = null;
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
 * PR-D-8 Phase 2 MF-06: workerType currently held by the standalone lock.
 * Required so that {@link releaseStandaloneLock} releases the correct per-type
 * Redis key namespace.
 *
 * PR-D-8 Phase 2 MF-06: standalone lock を保持している workerType。release で
 * 正しい per-type Redis key を解放するために必要。
 */
let standaloneLockWorkerType: WorkerType | null = null;

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
async function evaluateDualRunGuard(workerType: WorkerType): Promise<void> {
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
        `[WorkerStartup] Detected fork-child mode (REFTRIX_WORKER_IS_CHILD=1, type=${workerType}), skipping dual-run guard`
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
      `[WorkerStartup] REFTRIX_ALLOW_MANUAL_WORKER=true — bypassing dual-run guard for ${workerType}. ` +
        "Ensure no other Worker is consuming the same Queue."
    );
    return;
  }

  // 4. Default path — consult Redis via discriminated union APIs so that
  //    Redis-unreachable fails open (warn + continue), while a real dual-run
  //    (existing owner or race-lost acquire) fails closed (exit 1).
  //
  //    PR-D-8 Phase 2 MF-06 (TPA-IMPL-V11-07): the `workerType` argument is
  //    now resolved from the parsed startMode (`--page` / `--backfill`) so
  //    that each worker type has its own independent dual-run guard. Pre
  //    PR-D-8 the call hardcoded `"page"` which made the embedding-backfill
  //    standalone mode collide with the page-analyze lock namespace.
  //    PR-D-8 Phase 2 MF-06: workerType を startMode から解決。
  const lockService = new WorkerActiveLockService();
  try {
    const probe = await lockService.probeExistingLock(workerType);
    if (probe.unavailable) {
      console.warn(
        `[WorkerStartup] Redis dual-run guard unavailable for ${workerType} (non-fatal): ${probe.error}`
      );
      try {
        await lockService.close();
      } catch {
        /* best-effort */
      }
      return;
    }

    if (probe.exists) {
      console.error(
        `[WorkerStartup] DUAL-RUN DETECTED: another Worker process already holds the ` +
          `${workerType} active-worker lock in Redis. This typically means the MCP server ` +
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

    const token = generateBootToken();
    const acquire = await lockService.tryAcquireLock(workerType, token);
    if (!acquire.ok) {
      if (acquire.reason === "redis_unavailable") {
        console.warn(
          `[WorkerStartup] Redis dual-run guard unavailable during acquireLock for ${workerType} (non-fatal): ${acquire.error}`
        );
        try {
          await lockService.close();
        } catch {
          /* best-effort */
        }
        return;
      }
      console.error(
        `[WorkerStartup] DUAL-RUN DETECTED for ${workerType} (race condition during acquireLock). Exiting.`
      );
      await lockService.close();
      process.exit(1);
    }

    standaloneLockService = lockService;
    standaloneLockToken = token;
    standaloneLockWorkerType = workerType;
    console.log(
      `[WorkerStartup] Acquired active-worker lock (standalone mode, type=${workerType})`
    );

    standaloneLockHeartbeatTimer = setInterval(() => {
      if (!standaloneLockService || !standaloneLockToken || !standaloneLockWorkerType) return;
      const EXTEND_TIMEOUT_MS = 10_000;
      const extendPromise = standaloneLockService.extendLock(
        standaloneLockWorkerType,
        standaloneLockToken
      );
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
    console.warn(
      `[WorkerStartup] Dual-run guard encountered unexpected error for ${workerType} (non-fatal): ${sanitizeErrorMessage(error)}`
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
  if (standaloneLockService && standaloneLockToken && standaloneLockWorkerType) {
    try {
      // PR-D-8 Phase 2 MF-06: release the per-type Redis key matching the
      // workerType we acquired. Pre-PR-D-8 always released `"page"` which
      // would silently no-op for embedding-backfill standalone runs.
      // PR-D-8 Phase 2 MF-06: 取得した workerType に対応する per-type Redis
      // key を解放する。pre-PR-D-8 は常に "page" を release していた。
      await standaloneLockService.releaseLock(standaloneLockWorkerType, standaloneLockToken);
      await standaloneLockService.close();
    } catch {
      /* best-effort */
    }
  }
  standaloneLockService = null;
  standaloneLockToken = null;
  standaloneLockWorkerType = null;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  loadEnvLocal();

  // SEC-M1-02 (ADR-0016 § Test-only Env Var Guard): enforce guard immediately
  // after loadEnvLocal() so that any test-only env var leaked via .env.local or
  // an inherited parent env fails fast before NODE_ENV defaulting / Worker spawn.
  // SEC-M1-02: loadEnvLocal() 直後に guard を呼び、.env.local 経由のリークや
  // 親プロセスから継承された test-only env var を fail-fast で検出する。
  assertNoTestOnlyEnvLeak();

  // Validate environment
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "development";
    console.warn("[WorkerStartup] NODE_ENV not set, defaulting to development");
  }

  console.log(`[WorkerStartup] Starting workers (NODE_ENV: ${process.env.NODE_ENV})`);

  // Parse command line arguments BEFORE the dual-run guard so we know which
  // workerType to consult (PR-D-8 Phase 2 MF-06 / TPA-IMPL-V11-07).
  // PR-D-8 §3.2.1: argv → StartMode (SSOT). Default "all" starts every
  // WorkerType; --page / --backfill target individual WorkerType values.
  // PR-D-8 Phase 2 MF-06: dual-run guard 前に startMode を parse し、
  // workerType ベースの per-type lock 取得を行う。
  const args = process.argv.slice(2);
  let startMode: StartMode = "all";

  if (args.includes("--page") || args.includes("-p")) {
    startMode = "page";
  } else if (args.includes("--backfill") || args.includes("-b")) {
    startMode = "embedding-backfill";
  }

  // PR-D-8 Phase 2 MF-06: dual-run guard now per-type. When startMode is
  // "all" we acquire the page lock as a placeholder so the standalone fail-
  // closed semantics still apply (manually starting both workers via "all"
  // would be unusual but not broken). embedding-backfill standalone now has
  // its own lock namespace and never collides with the page-analyze lock.
  // PR-D-8 Phase 2 MF-06: dual-run guard を per-type 化。`all` の場合は page
  // を代表として acquire する (現行運用の単一 worker pattern を尊重)。
  // backfill standalone は独立した lock namespace を持つ。
  const guardWorkerType: WorkerType =
    startMode === "embedding-backfill" ? "embedding-backfill" : "page";
  await evaluateDualRunGuard(guardWorkerType);

  // Log memory profile at startup
  const memProfile = computeMemoryProfile();
  logMemoryProfile(memProfile);

  // PR-D-8 §3.2.4 Rule 4 (SEC-02 H resolution): CHILD_TYPE argv-env match.
  // When the supervisor forks a child, it injects REFTRIX_WORKER_CHILD_TYPE
  // ∈ { "page", "embedding-backfill" } and the corresponding --page /
  // --backfill argv. If the two disagree, the child MUST refuse to start
  // BEFORE any BullMQ connection (prevents spoofing: a child launched with
  // --page env but CHILD_TYPE=embedding-backfill could otherwise consume
  // page-analyze jobs while presenting itself as embedding-backfill to the
  // supervisor). Fail-closed.
  // PR-D-8 §3.2.4 Rule 4 (SEC-02 H): CHILD_TYPE と argv が不一致の場合は
  // BullMQ 接続前に exit(1) で fail-closed 終了する。
  const childTypeEnv = process.env.REFTRIX_WORKER_CHILD_TYPE;
  if (childTypeEnv !== undefined && childTypeEnv !== "") {
    // Only enforce when set (fork children get it; standalone/batch do not).
    const knownChildType = SSOT_WORKER_TYPES.find((t) => t === childTypeEnv);
    if (knownChildType === undefined) {
      console.error(
        "[WorkerStartup] REFTRIX_WORKER_CHILD_TYPE set to unknown value; exiting fail-closed"
      );
      process.exit(1);
    }
    // startMode === "all" in a child is not allowed — children always run a
    // single WorkerType. startMode MUST equal CHILD_TYPE.
    if (startMode === "all" || startMode !== knownChildType) {
      console.error(
        "[WorkerStartup] REFTRIX_WORKER_CHILD_TYPE does not match argv; exiting fail-closed"
      );
      process.exit(1);
    }
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
    if (standaloneLockService && standaloneLockToken && standaloneLockWorkerType) {
      // fire-and-forget; exit handler is synchronous so we cannot await.
      // PR-D-8 Phase 2 MF-06: release the workerType-specific lock.
      // PR-D-8 Phase 2 MF-06: 取得した workerType の lock を解放する。
      standaloneLockService.releaseLock(standaloneLockWorkerType, standaloneLockToken).catch(() => {
        /* best-effort */
      });
    }
  });

  try {
    await startWorkers(startMode);
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
