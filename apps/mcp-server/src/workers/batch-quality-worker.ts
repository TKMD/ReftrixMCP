// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BatchQualityWorker - BullMQ Worker for Batch Quality Evaluation
 *
 * Phase4: Handles batch quality evaluation jobs asynchronously.
 * Processes multiple pages in batches with configurable batch size.
 *
 * Configuration:
 * - concurrency: 3 (balance between throughput and resource usage)
 * - lockDuration: 600000ms (aligned with MCP 600s limit)
 * - attempts: 2 (allow one retry for transient failures)
 *
 * @module workers/batch-quality-worker
 */

import { Worker, type Job } from 'bullmq';
import { getRedisConfig, type RedisConfig } from '../config/redis';
import {
  BATCH_QUALITY_QUEUE_NAME,
  type BatchQualityJobData,
  type BatchQualityJobResult,
  type BatchQualityItemResult,
  updateBatchQualityJobProgress,
} from '../queues/batch-quality-queue';
import { logger, isDevelopment } from '../utils/logger';
import type { QualityEvaluateData } from '../tools/quality/schemas';

// ============================================================================
// Types
// ============================================================================

/**
 * Worker configuration options
 */
export interface BatchQualityWorkerOptions {
  /** Redis configuration overrides */
  redisConfig?: Partial<RedisConfig>;
  /** Worker concurrency (default: 3) */
  concurrency?: number;
  /** Lock duration in ms (default: 600000) */
  lockDuration?: number;
  /** Enable verbose logging (default: isDevelopment()) */
  verbose?: boolean;
}

/**
 * Worker instance with lifecycle methods
 */
export interface BatchQualityWorkerInstance {
  /** BullMQ Worker instance */
  worker: Worker<BatchQualityJobData, BatchQualityJobResult>;
  /** Gracefully close the worker */
  close: () => Promise<void>;
  /** Pause the worker (stop accepting new jobs, current job continues) */
  pause: () => Promise<void>;
  /** Check if worker is running */
  isRunning: () => boolean;
}

/**
 * Service interface for evaluating pages
 * Injected via setQualityEvaluatorService
 */
export interface IQualityEvaluatorService {
  evaluatePage: (html: string, options?: EvaluatePageOptions) => Promise<QualityEvaluateData>;
  getPageById?: (pageId: string) => Promise<string | null>;
}

/**
 * Options for page evaluation
 */
export interface EvaluatePageOptions {
  strict?: boolean;
  weights?: {
    originality?: number;
    craftsmanship?: number;
    contextuality?: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Default worker concurrency */
const DEFAULT_CONCURRENCY = 3;

/** Default lock duration (600 seconds = 10 minutes, aligned with MCP limit) */
const DEFAULT_LOCK_DURATION = 600000;

// ============================================================================
// Service Injection
// ============================================================================

let qualityEvaluatorService: IQualityEvaluatorService | null = null;

/**
 * Set the quality evaluator service (dependency injection)
 * Must be called before worker starts processing jobs.
 */
export function setQualityEvaluatorService(service: IQualityEvaluatorService): void {
  qualityEvaluatorService = service;
}

/**
 * Reset the quality evaluator service (for testing)
 */
export function resetQualityEvaluatorService(): void {
  qualityEvaluatorService = null;
}

// ============================================================================
// Worker Process Function
// ============================================================================

/**
 * Process a batch quality evaluation job
 *
 * @param job - BullMQ Job instance
 * @returns Job result
 */
async function processBatchQualityJob(
  job: Job<BatchQualityJobData, BatchQualityJobResult>
): Promise<BatchQualityJobResult> {
  const startTime = Date.now();
  const { jobId, items, batchSize, onError, weights, strict } = job.data;

  if (isDevelopment()) {
    logger.info('[BatchQualityWorker] Processing job', {
      jobId: job.id,
      batchJobId: jobId,
      totalItems: items.length,
      batchSize,
      onError,
    });
  }

  // Validate service injection
  if (!qualityEvaluatorService) {
    throw new Error('Quality evaluator service not configured. Call setQualityEvaluatorService() before processing.');
  }

  const results: BatchQualityItemResult[] = [];
  let processedItems = 0;
  let successItems = 0;
  let failedItems = 0;

  // Process items in batches
  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, items.length);
    const batch = items.slice(batchStart, batchEnd);

    if (isDevelopment()) {
      logger.debug('[BatchQualityWorker] Processing batch', {
        batchJobId: jobId,
        batchStart,
        batchEnd,
        batchSize: batch.length,
      });
    }

    // Process each item in the batch concurrently
    const batchPromises = batch.map(async (item) => {
      try {
        let html: string | null = null;

        // Resolve HTML content
        if (item.html) {
          html = item.html;
        } else if (item.pageId && qualityEvaluatorService?.getPageById) {
          html = await qualityEvaluatorService.getPageById(item.pageId);
        }

        if (!html) {
          throw new Error(`Cannot resolve HTML for item at index ${item.index}`);
        }

        // Evaluate the page
        const evalOptions: EvaluatePageOptions = {
          strict,
        };
        if (weights) {
          evalOptions.weights = weights;
        }

        const data = await qualityEvaluatorService!.evaluatePage(html, evalOptions);

        return {
          index: item.index,
          success: true,
          data,
        } as BatchQualityItemResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isDevelopment()) {
          logger.warn('[BatchQualityWorker] Item evaluation failed', {
            batchJobId: jobId,
            itemIndex: item.index,
            error: errorMessage,
          });
        }

        return {
          index: item.index,
          success: false,
          error: {
            code: 'EVALUATION_ERROR',
            message: errorMessage,
          },
        } as BatchQualityItemResult;
      }
    });

    // Wait for all items in batch to complete
    const batchResults = await Promise.all(batchPromises);

    // Check for abort condition
    for (const result of batchResults) {
      results.push(result);
      processedItems++;

      if (result.success) {
        successItems++;
      } else {
        failedItems++;

        // Abort on first error if onError === 'abort'
        if (onError === 'abort') {
          if (isDevelopment()) {
            logger.info('[BatchQualityWorker] Aborting due to error', {
              batchJobId: jobId,
              failedIndex: result.index,
            });
          }

          const processingTimeMs = Date.now() - startTime;

          return {
            jobId,
            success: false,
            totalItems: items.length,
            processedItems,
            successItems,
            failedItems,
            results: results.sort((a, b) => a.index - b.index),
            processingTimeMs,
            completedAt: new Date().toISOString(),
            error: `Aborted due to error at index ${result.index}: ${result.error?.message}`,
          };
        }
      }
    }

    // Update progress with detailed counts (MCP-RESP-04: accurate progress tracking)
    await updateBatchQualityJobProgress(job, processedItems, successItems, failedItems);

    if (isDevelopment()) {
      const progress = Math.round((processedItems / items.length) * 100);
      logger.debug('[BatchQualityWorker] Batch completed', {
        batchJobId: jobId,
        processedItems,
        successItems,
        failedItems,
        progress,
      });
    }
  }

  // Final result
  const processingTimeMs = Date.now() - startTime;
  const success = failedItems === 0;

  const result: BatchQualityJobResult = {
    jobId,
    success,
    totalItems: items.length,
    processedItems,
    successItems,
    failedItems,
    results: results.sort((a, b) => a.index - b.index),
    processingTimeMs,
    completedAt: new Date().toISOString(),
  };

  if (isDevelopment()) {
    logger.info('[BatchQualityWorker] Job completed', {
      jobId: job.id,
      batchJobId: jobId,
      success,
      totalItems: items.length,
      successItems,
      failedItems,
      processingTimeMs,
    });
  }

  return result;
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create a BatchQualityWorker instance
 *
 * @param options - Worker configuration options
 * @returns Worker instance with lifecycle methods
 */
export function createBatchQualityWorker(
  options: BatchQualityWorkerOptions = {}
): BatchQualityWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info('[BatchQualityWorker] Creating worker', {
      queueName: BATCH_QUALITY_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<BatchQualityJobData, BatchQualityJobResult>(
    BATCH_QUALITY_QUEUE_NAME,
    processBatchQualityJob,
    {
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
      },
      concurrency,
      lockDuration,
      // Stalled job settings (detect stuck jobs)
      // stalledInterval = lockDuration/4 to avoid false stall detection during legitimate long processing
      stalledInterval: Math.max(60000, Math.floor(lockDuration / 4)),
      maxStalledCount: 2, // Allow 2 stalls before failing
    }
  );

  // Event handlers for monitoring
  worker.on('completed', (job, result) => {
    if (verbose) {
      logger.info('[BatchQualityWorker] Job completed event', {
        jobId: job.id,
        batchJobId: result.jobId,
        success: result.success,
        successItems: result.successItems,
        failedItems: result.failedItems,
      });
    }
  });

  worker.on('failed', (job, error) => {
    logger.error('[BatchQualityWorker] Job failed event', {
      jobId: job?.id,
      error: error.message,
    });
  });

  worker.on('error', (error) => {
    logger.error('[BatchQualityWorker] Worker error', {
      error: error.message,
    });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('[BatchQualityWorker] Job stalled', { jobId });
  });

  worker.on('progress', (job, progress) => {
    if (verbose) {
      logger.debug('[BatchQualityWorker] Job progress', {
        jobId: job.id,
        progress,
      });
    }
  });

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info('[BatchQualityWorker] Closing worker');
      }
      isRunning = false;
      await worker.close();
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info('[BatchQualityWorker] Pausing worker (no new jobs will be accepted)');
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports
// ============================================================================

export { processBatchQualityJob };
