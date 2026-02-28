// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batch Quality Queue - BullMQ Queue for Batch Quality Evaluation
 *
 * Handles async batch processing of multiple page quality evaluations.
 * Part of Phase4 implementation (P2 task).
 *
 * Design decisions:
 * - attempts=2: Allow one retry for transient failures
 * - 24h job retention: Allows clients to poll for results
 * - 7d failed job retention: For debugging and analytics
 * - Graceful degradation: Falls back to LRU store when Redis unavailable
 *
 * @module queues/batch-quality-queue
 */

import type { Job, ConnectionOptions } from 'bullmq';
import { Queue, QueueEvents } from 'bullmq';
import type Redis from 'ioredis';
import type { RedisConfig } from '../config/redis';
import { getRedisConfig, getRedisClient, isRedisAvailable } from '../config/redis';
import type { Weights, QualityEvaluateData } from '../tools/quality/schemas';

/**
 * Queue name constant
 */
export const BATCH_QUALITY_QUEUE_NAME = 'batch-quality-evaluate';

/**
 * Job data for batch quality evaluation
 */
export interface BatchQualityJobData {
  /** Job ID (UUIDv7) */
  jobId: string;
  /** Items to evaluate */
  items: BatchQualityItem[];
  /** Batch size for processing */
  batchSize: number;
  /** Error handling mode */
  onError: 'skip' | 'abort';
  /** Evaluation weights */
  weights?: Weights;
  /** Strict mode for AI cliche detection */
  strict: boolean;
  /** Job creation timestamp (ISO 8601) */
  createdAt: string;
  /** Optional request ID for tracing */
  requestId?: string;
}

/**
 * Individual item for batch evaluation
 */
export interface BatchQualityItem {
  /** Page ID (UUID) - mutually exclusive with html */
  pageId?: string;
  /** HTML content - mutually exclusive with pageId */
  html?: string;
  /** Item index in original array */
  index: number;
}

/**
 * Individual item result
 */
export interface BatchQualityItemResult {
  /** Item index */
  index: number;
  /** Success status */
  success: boolean;
  /** Evaluation result (if success) */
  data?: QualityEvaluateData;
  /** Error info (if failed) */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Job result for batch quality evaluation
 */
export interface BatchQualityJobResult {
  /** Job ID */
  jobId: string;
  /** Overall success status */
  success: boolean;
  /** Total items count */
  totalItems: number;
  /** Processed items count */
  processedItems: number;
  /** Successful items count */
  successItems: number;
  /** Failed items count */
  failedItems: number;
  /** Individual results */
  results: BatchQualityItemResult[];
  /** Processing duration in ms */
  processingTimeMs?: number;
  /** Job completion timestamp */
  completedAt?: string;
  /** Error message if overall failed */
  error?: string;
}

/**
 * Job status for polling (compatible with page.getJobStatus pattern)
 */
export interface BatchQualityJobStatus {
  /** Job ID */
  jobId: string;
  /** Current state */
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  /** Progress percentage (0-100) */
  progress: number;
  /** Total items */
  totalItems: number;
  /** Processed items */
  processedItems: number;
  /** Successful items */
  successItems: number;
  /** Failed items */
  failedItems: number;
  /** Result (if completed) */
  result?: BatchQualityJobResult;
  /** Error (if failed) */
  error?: string;
  /** Timestamps */
  timestamps: {
    created?: number;
    started?: number;
    completed?: number;
    failed?: number;
  };
}

/**
 * Convert RedisConfig to BullMQ ConnectionOptions
 */
function toConnectionOptions(config: RedisConfig): ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
  };
}

/**
 * Create the batch quality queue
 *
 * @param configOverrides - Optional Redis configuration overrides
 * @returns BullMQ Queue instance
 */
export function createBatchQualityQueue(
  configOverrides?: Partial<RedisConfig>
): Queue<BatchQualityJobData, BatchQualityJobResult> {
  const config = getRedisConfig(configOverrides);

  return new Queue<BatchQualityJobData, BatchQualityJobResult>(BATCH_QUALITY_QUEUE_NAME, {
    connection: toConnectionOptions(config),
    defaultJobOptions: {
      // Allow one retry for transient failures
      attempts: 2,
      // Keep completed jobs for 24 hours (for client polling)
      removeOnComplete: {
        age: 24 * 60 * 60, // 24 hours in seconds
        count: 1000, // Keep max 1000 completed jobs
      },
      // Keep failed jobs for 7 days (for debugging)
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // 7 days in seconds
        count: 500, // Keep max 500 failed jobs
      },
      // Backoff strategy
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    },
  });
}

/**
 * Create queue events for monitoring
 *
 * @param configOverrides - Optional Redis configuration overrides
 * @returns BullMQ QueueEvents instance
 */
export function createBatchQualityQueueEvents(
  configOverrides?: Partial<RedisConfig>
): QueueEvents {
  const config = getRedisConfig(configOverrides);

  return new QueueEvents(BATCH_QUALITY_QUEUE_NAME, {
    connection: toConnectionOptions(config),
  });
}

/**
 * Add a batch quality job to the queue
 *
 * @param queue - BullMQ Queue instance
 * @param data - Job data (without createdAt, will be added automatically)
 * @param priority - Job priority (lower = higher priority, default: 10)
 * @returns Job instance
 */
export async function addBatchQualityJob(
  queue: Queue<BatchQualityJobData, BatchQualityJobResult>,
  data: Omit<BatchQualityJobData, 'createdAt'>,
  priority: number = 10
): Promise<Job<BatchQualityJobData, BatchQualityJobResult>> {
  const jobData: BatchQualityJobData = {
    ...data,
    createdAt: new Date().toISOString(),
  };

  // Use jobId as BullMQ job ID for easy lookup
  return queue.add(BATCH_QUALITY_QUEUE_NAME, jobData, {
    jobId: data.jobId,
    priority,
  });
}

/**
 * Get job status by ID
 *
 * MCP-RESP-04: Retrieves accurate progress from Redis or LRU store fallback.
 *
 * @param queue - BullMQ Queue instance
 * @param jobId - Job ID
 * @returns Job status or null if not found
 */
export async function getBatchQualityJobStatus(
  queue: Queue<BatchQualityJobData, BatchQualityJobResult>,
  jobId: string
): Promise<BatchQualityJobStatus | null> {
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();
  const totalItems = job.data.items.length;

  // MCP-RESP-04: Get accurate progress from Redis/LRU store
  const storedProgress = await getBatchQualityProgress(jobId);

  // Use stored progress if available, otherwise fall back to BullMQ progress percentage
  let processedItems: number;
  let successItems: number;
  let failedItems: number;
  let progress: number;

  if (storedProgress) {
    processedItems = storedProgress.processedItems;
    successItems = storedProgress.successItems;
    failedItems = storedProgress.failedItems;
    progress = totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0;
  } else {
    // Fallback to BullMQ progress (percentage only, no detailed counts)
    processedItems = 0;
    successItems = 0;
    failedItems = 0;
    progress = typeof job.progress === 'number' ? job.progress : 0;
  }

  // Build timestamps object, only including defined values
  const timestamps: {
    created?: number;
    started?: number;
    completed?: number;
    failed?: number;
  } = {};

  if (job.timestamp !== undefined) {
    timestamps.created = job.timestamp;
  }
  if (job.processedOn !== undefined) {
    timestamps.started = job.processedOn;
  }
  if (state === 'completed' && job.finishedOn !== undefined) {
    timestamps.completed = job.finishedOn;
  }
  if (state === 'failed' && job.finishedOn !== undefined) {
    timestamps.failed = job.finishedOn;
  }

  // Build result object
  const status: BatchQualityJobStatus = {
    jobId: job.id || jobId,
    state: state as BatchQualityJobStatus['state'],
    progress,
    totalItems,
    processedItems,
    successItems,
    failedItems,
    timestamps,
  };

  // Add result if completed
  if (state === 'completed' && job.returnvalue) {
    status.result = job.returnvalue;
  }

  // Add error if failed
  if (state === 'failed' && job.failedReason) {
    status.error = job.failedReason;
  }

  return status;
}

/**
 * Update job progress
 *
 * Stores progress in both BullMQ job and Redis for accurate retrieval.
 * Also syncs to LRU store for fallback support.
 *
 * @param job - BullMQ Job instance
 * @param processedItems - Number of processed items
 * @param successItems - Number of successful items
 * @param failedItems - Number of failed items
 */
export async function updateBatchQualityJobProgress(
  job: Job<BatchQualityJobData, BatchQualityJobResult>,
  processedItems: number,
  successItems: number,
  failedItems: number
): Promise<void> {
  const totalItems = job.data.items.length;
  const progressPercent = totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0;

  // Update BullMQ job progress with percentage
  await job.updateProgress(progressPercent);

  // Log progress for debugging
  await job.log(`Progress: ${processedItems}/${totalItems} (${successItems} success, ${failedItems} failed)`);

  // Store detailed progress in Redis and sync to LRU store
  await saveBatchQualityProgress(job.data.jobId, {
    processedItems,
    successItems,
    failedItems,
    totalItems,
  });
}

/**
 * Gracefully close the queue
 *
 * @param queue - BullMQ Queue instance
 */
export async function closeBatchQualityQueue(
  queue: Queue<BatchQualityJobData, BatchQualityJobResult>
): Promise<void> {
  await queue.close();
}

/**
 * Check if queue is healthy
 *
 * @param queue - BullMQ Queue instance
 * @returns Health status
 */
export async function checkBatchQualityQueueHealth(
  queue: Queue<BatchQualityJobData, BatchQualityJobResult>
): Promise<{
  healthy: boolean;
  stats: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  error?: string;
}> {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      healthy: true,
      stats: {
        waiting,
        active,
        completed,
        failed,
        delayed,
      },
    };
  } catch (err) {
    return {
      healthy: false,
      stats: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Progress Storage (MCP-RESP-04)
// ============================================================================

/**
 * Redis key prefix for batch quality progress data
 */
const BATCH_QUALITY_PROGRESS_KEY_PREFIX = 'reftrix:batch-quality:progress:';

/**
 * Progress TTL: 24 hours (same as job retention)
 */
const PROGRESS_TTL_SECONDS = 24 * 60 * 60;

/**
 * Progress data structure stored in Redis
 */
export interface BatchQualityProgressData {
  processedItems: number;
  successItems: number;
  failedItems: number;
  totalItems: number;
}

/**
 * Lazy-initialized Redis client for progress storage
 */
let progressRedisClient: Redis | null = null;

/**
 * Get or create Redis client for progress storage
 */
function getProgressRedisClient(): Redis {
  if (!progressRedisClient) {
    progressRedisClient = getRedisClient();
  }
  return progressRedisClient;
}

/**
 * Save batch quality progress to Redis
 *
 * Also syncs to LRU store for fallback support.
 *
 * @param jobId - Job ID
 * @param progress - Progress data
 */
export async function saveBatchQualityProgress(
  jobId: string,
  progress: BatchQualityProgressData
): Promise<void> {
  const key = `${BATCH_QUALITY_PROGRESS_KEY_PREFIX}${jobId}`;

  try {
    const redisAvailable = await isRedisAvailable();

    if (redisAvailable) {
      const client = getProgressRedisClient();
      const data = JSON.stringify(progress);
      await client.setex(key, PROGRESS_TTL_SECONDS, data);
    }
  } catch (error) {
    // Log error but don't throw - graceful degradation
    if (process.env.NODE_ENV === 'development') {
      console.warn('[BatchQualityQueue] Failed to save progress to Redis:', error);
    }
  }

  // Always sync to LRU store for fallback
  try {
    // Dynamic import to avoid circular dependency
    const { updateBatchJob, getBatchJob } = await import('../tools/quality/batch-evaluate.tool.js');
    const existingJob = getBatchJob(jobId);

    if (existingJob) {
      updateBatchJob(jobId, {
        processed_items: progress.processedItems,
        success_items: progress.successItems,
        failed_items: progress.failedItems,
        progress_percent: progress.totalItems > 0
          ? Math.round((progress.processedItems / progress.totalItems) * 100)
          : 0,
      });
    }
  } catch (error) {
    // Log error but don't throw
    if (process.env.NODE_ENV === 'development') {
      console.warn('[BatchQualityQueue] Failed to sync progress to LRU store:', error);
    }
  }
}

/**
 * Get batch quality progress from Redis
 *
 * @param jobId - Job ID
 * @returns Progress data or null if not found
 */
export async function getBatchQualityProgress(
  jobId: string
): Promise<BatchQualityProgressData | null> {
  const key = `${BATCH_QUALITY_PROGRESS_KEY_PREFIX}${jobId}`;

  try {
    const redisAvailable = await isRedisAvailable();

    if (redisAvailable) {
      const client = getProgressRedisClient();
      const data = await client.get(key);

      if (data) {
        return JSON.parse(data) as BatchQualityProgressData;
      }
    }
  } catch (error) {
    // Log error but don't throw - fallback to LRU
    if (process.env.NODE_ENV === 'development') {
      console.warn('[BatchQualityQueue] Failed to get progress from Redis:', error);
    }
  }

  // Fallback to LRU store
  try {
    const { getBatchJob } = await import('../tools/quality/batch-evaluate.tool.js');
    const lruJob = getBatchJob(jobId);

    if (lruJob) {
      return {
        processedItems: lruJob.processed_items,
        successItems: lruJob.success_items,
        failedItems: lruJob.failed_items,
        totalItems: lruJob.total_items,
      };
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[BatchQualityQueue] Failed to get progress from LRU store:', error);
    }
  }

  return null;
}

/**
 * Delete batch quality progress from Redis
 *
 * @param jobId - Job ID
 */
export async function deleteBatchQualityProgress(jobId: string): Promise<void> {
  const key = `${BATCH_QUALITY_PROGRESS_KEY_PREFIX}${jobId}`;

  try {
    const redisAvailable = await isRedisAvailable();

    if (redisAvailable) {
      const client = getProgressRedisClient();
      await client.del(key);
    }
  } catch (error) {
    // Log error but don't throw
    if (process.env.NODE_ENV === 'development') {
      console.warn('[BatchQualityQueue] Failed to delete progress from Redis:', error);
    }
  }
}
