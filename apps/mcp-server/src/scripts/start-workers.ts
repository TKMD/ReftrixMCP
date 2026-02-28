#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standalone Worker Startup Script
 *
 * Starts BullMQ workers for async job processing:
 * - PageAnalyzeWorker: Handles page.analyze async jobs
 * - BatchQualityWorker: Handles quality.batch_evaluate jobs
 *
 * Usage:
 *   pnpm worker:start           # Start all workers
 *   pnpm worker:start:page      # Start only PageAnalyzeWorker
 *   pnpm worker:start:quality   # Start only BatchQualityWorker
 *
 * Or run directly:
 *   NODE_ENV=development npx tsx apps/mcp-server/src/scripts/start-workers.ts
 *
 * Environment Variables:
 *   REDIS_HOST (default: localhost)
 *   REDIS_PORT (default: 27379)
 *   PAGE_WORKER_CONCURRENCY (default: 1 - singleton browser, avoid race condition)
 *   WORKER_CONCURRENCY (default: 3 for quality worker)
 *
 * @module scripts/start-workers
 */

/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import { computeMemoryProfile, logMemoryProfile } from '../services/worker-memory-profile';
import { createPageAnalyzeWorker, type PageAnalyzeWorkerInstance } from '../workers/page-analyze-worker';
import { createBatchQualityWorker, setQualityEvaluatorService, type BatchQualityWorkerInstance } from '../workers/batch-quality-worker';
import { checkRedisConnection, getRedisConfig } from '../config/redis';
import { embeddingService } from '@reftrix/ml';
import { prisma } from '@reftrix/database';
import { webPageService } from '../services/web-page.service';
import { initializeAllServices, type ServiceInitializerConfig } from '../services/service-initializer';
import { executeQualityEvaluate } from '../services';
import type { Grade } from '../tools/quality/schemas';
import { createPageAnalyzeQueue } from '../queues/page-analyze-queue';
import { categorizeByProgress } from '../services/orphaned-job-utils';
// NOTE: Startup embedding backfill was removed (caused 33GB RSS bloat blocking Worker init).
// Missing embeddings are repaired via:
//   1. Post-Embedding Backfill in page-analyze-worker.ts (per-job, after Phase 5)
//   2. CLI: pnpm backfill:embeddings (manual, separate process)

// ============================================================================
// Constants
// ============================================================================

const WORKER_TYPES = {
  PAGE_ANALYZE: 'page-analyze',
  BATCH_QUALITY: 'batch-quality',
  ALL: 'all',
} as const;

type WorkerType = typeof WORKER_TYPES[keyof typeof WORKER_TYPES];

// ============================================================================
// Worker Instances
// ============================================================================

let pageAnalyzeWorker: PageAnalyzeWorkerInstance | null = null;
let batchQualityWorker: BatchQualityWorkerInstance | null = null;

// ============================================================================
// Initialization
// ============================================================================

function loadEnvLocal(): void {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
        const eqIndex = normalized.indexOf('=');
        if (eqIndex === -1) return;
        const key = normalized.slice(0, eqIndex).trim();
        let value = normalized.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
  console.log('[WorkerStartup] Initializing services...');

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

  // Setup quality evaluator service for BatchQualityWorker
  setQualityEvaluatorService({
    evaluatePage: async (html, options) => {
      const result = await executeQualityEvaluate({
        html,
        options: {
          strict: options?.strict,
          weights: options?.weights,
          includeRecommendations: false, // Reduce response size for batch
        },
      });

      if (!result.success || !result.data) {
        throw new Error(result.error?.message ?? 'Quality evaluation failed');
      }

      // Transform service-export format to schemas.ts QualityEvaluateData format
      const data = result.data;
      return {
        overall: data.overallScore,
        grade: data.grade as Grade,
        originality: {
          score: data.axisScores.originality,
          grade: (data.axisGrades?.originality ?? data.grade) as Grade,
        },
        craftsmanship: {
          score: data.axisScores.craftsmanship,
          grade: (data.axisGrades?.craftsmanship ?? data.grade) as Grade,
        },
        contextuality: {
          score: data.axisScores.contextuality,
          grade: (data.axisGrades?.contextuality ?? data.grade) as Grade,
        },
        evaluatedAt: new Date().toISOString(),
        clicheDetection: data.clicheCount !== undefined ? {
          count: data.clicheCount,
          detected: data.clicheCount > 0,
          patterns: [],
        } : undefined,
      };
    },
    getPageById: async (pageId) => {
      const page = await prisma.webPage.findUnique({
        where: { id: pageId },
        select: { htmlContent: true },
      });
      return page?.htmlContent ?? null;
    },
  });

  console.log('[WorkerStartup] Services initialized successfully');
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

  console.log(`[WorkerStartup] Redis connected (version: ${status.info?.version ?? 'unknown'})`);
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
  const concurrency = parseInt(process.env.PAGE_WORKER_CONCURRENCY ?? '1', 10);

  console.log(`[WorkerStartup] Starting PageAnalyzeWorker (concurrency: ${concurrency})...`);

  const worker = createPageAnalyzeWorker({
    concurrency,
    verbose: true,
  });

  console.log('[WorkerStartup] PageAnalyzeWorker started successfully');
  return worker;
}

/**
 * Start BatchQualityWorker
 */
function startBatchQualityWorker(): BatchQualityWorkerInstance {
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);

  console.log(`[WorkerStartup] Starting BatchQualityWorker (concurrency: ${concurrency})...`);

  const worker = createBatchQualityWorker({
    concurrency,
    verbose: true,
  });

  console.log('[WorkerStartup] BatchQualityWorker started successfully');
  return worker;
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
  console.log('[WorkerStartup] Checking for orphaned active jobs...');

  try {
    const queue = createPageAnalyzeQueue();
    const activeJobs = await queue.getJobs(['active'], 0, 100);

    if (activeJobs.length === 0) {
      console.log('[WorkerStartup] No orphaned jobs found');
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

      const progress = typeof job.progress === 'number' ? job.progress : 0;
      const category = categorizeByProgress(progress, job.processedOn);
      const url = job.data?.url ?? 'unknown';

      console.log(
        `[WorkerStartup]   Job ${job.id}: progress=${progress}%, category=${category}, url=${url}`
      );

      try {
        switch (category) {
          case 'db_saved_but_stuck': {
            // DB保存済み（progress >= 90%）: completedに遷移
            await job.moveToCompleted(
              {
                webPageId: job.data?.webPageId ?? '',
                success: true,
                partialSuccess: true,
                completedPhases: [],
                failedPhases: [],
                processingTimeMs: 0,
                completedAt: new Date().toISOString(),
              },
              '0',
              true
            );
            console.log(`[WorkerStartup]     -> completed (DB already saved)`);
            recoveredCount++;
            break;
          }

          case 'processing_interrupted': {
            // 処理中断（0 < progress < 90%）: failedに遷移
            await job.moveToFailed(
              new Error(
                `Worker restarted during processing (progress: ${progress}%). ` +
                'Job orphaned at startup recovery.'
              ),
              '0',
              true
            );
            console.log(`[WorkerStartup]     -> failed (processing interrupted)`);
            recoveredCount++;
            break;
          }

          case 'never_started': {
            // 未開始（progress = 0）: waitingに戻す
            // BullMQ API: active → failed → retry → waiting
            await job.moveToFailed(
              new Error(
                'Worker restarted before processing started. Job will be retried automatically.'
              ),
              '0',
              true
            );
            try {
              await job.retry('failed');
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
      '[WorkerStartup] Orphaned job recovery failed (non-fatal):',
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
  process.on('message', async (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message
    ) {
      const msgType = (message as { type: string }).type;

      // Note: Phase 0 (IPC pause) は削除済み。
      // Pre-return pause パターンにより、Processor内で worker.pause(true) が呼ばれ
      // BullMQ moveToCompleted の fetchNext=false が保証されている。

      // Phase 1: shutdown — BullMQ Worker.close() でロック解放後にプロセス終了
      if (msgType === 'shutdown') {
        console.log('[WorkerStartup] Received IPC shutdown message, closing BullMQ workers...');

        try {
          await shutdownWorkers();
        } catch (error) {
          console.error(
            '[WorkerStartup] Error during IPC-triggered shutdown:',
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

  // Start workers
  switch (type) {
    case WORKER_TYPES.PAGE_ANALYZE:
      pageAnalyzeWorker = startPageAnalyzeWorker();
      break;

    case WORKER_TYPES.BATCH_QUALITY:
      batchQualityWorker = startBatchQualityWorker();
      break;

    case WORKER_TYPES.ALL:
    default:
      pageAnalyzeWorker = startPageAnalyzeWorker();
      batchQualityWorker = startBatchQualityWorker();
      break;
  }

  // Setup IPC shutdown handler (for WorkerSupervisor graceful shutdown)
  setupIpcShutdownHandler();

  console.log('[WorkerStartup] All requested workers are running');
  console.log('[WorkerStartup] Press Ctrl+C to stop');
}

/**
 * Gracefully shutdown workers
 */
async function shutdownWorkers(): Promise<void> {
  console.log('\n[WorkerStartup] Shutting down workers...');

  const shutdownPromises: Promise<void>[] = [];

  if (pageAnalyzeWorker) {
    shutdownPromises.push(pageAnalyzeWorker.close());
  }

  if (batchQualityWorker) {
    shutdownPromises.push(batchQualityWorker.close());
  }

  await Promise.all(shutdownPromises);

  console.log('[WorkerStartup] Workers shutdown complete');
  process.exit(0);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  loadEnvLocal();

  // Validate environment
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
    console.warn('[WorkerStartup] NODE_ENV not set, defaulting to development');
  }

  console.log(`[WorkerStartup] Starting workers (NODE_ENV: ${process.env.NODE_ENV})`);

  // Log memory profile at startup
  const memProfile = computeMemoryProfile();
  logMemoryProfile(memProfile);

  // Parse command line arguments
  const args = process.argv.slice(2);
  let workerType: WorkerType = WORKER_TYPES.ALL;

  if (args.includes('--page') || args.includes('-p')) {
    workerType = WORKER_TYPES.PAGE_ANALYZE;
  } else if (args.includes('--quality') || args.includes('-q')) {
    workerType = WORKER_TYPES.BATCH_QUALITY;
  }

  // Setup signal handlers
  process.on('SIGINT', shutdownWorkers);
  process.on('SIGTERM', shutdownWorkers);

  // Common fatal error handler to prevent silent worker death
  function handleFatalError(label: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[WorkerStartup] ${label}:`, message);
    if (stack) {
      console.error('[WorkerStartup] Stack:', stack);
    }
    // Attempt graceful shutdown with 10s timeout
    const shutdownTimeout = setTimeout(() => {
      console.error('[WorkerStartup] Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10000);
    shutdownTimeout.unref();
    shutdownWorkers().catch(() => {
      // shutdown errors are non-fatal at this point
    }).finally(() => {
      clearTimeout(shutdownTimeout);
      process.exit(1);
    });
  }

  // Setup uncaught error handlers
  process.on('uncaughtException', (error: Error) => {
    handleFatalError('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    handleFatalError('Unhandled rejection', reason);
  });

  try {
    await startWorkers(workerType);
  } catch (error) {
    console.error('[WorkerStartup] Failed to start workers:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Entry point
main().catch((error) => {
  console.error('[WorkerStartup] Unhandled error:', error);
  process.exit(1);
});
