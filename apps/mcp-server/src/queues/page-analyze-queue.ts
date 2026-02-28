// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page Analyze Queue - BullMQ Queue for Async Web Analysis
 *
 * Handles async processing of heavy WebGL/Three.js sites that may timeout
 * in synchronous processing. Part of Phase3 implementation.
 *
 * Design decisions:
 * - attempts=1: WebGL heavy sites should not retry (would just timeout again)
 * - 24h job retention: Allows clients to poll for results
 * - 7d failed job retention: For debugging and analytics
 *
 * @module queues/page-analyze-queue
 */

import { Queue, QueueEvents, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisConfig, type RedisConfig } from '../config/redis';

/**
 * Queue name constant
 */
export const PAGE_ANALYZE_QUEUE_NAME = 'page-analyze';

/**
 * Job data for page analysis
 */
export interface PageAnalyzeJobData {
  /** WebPage ID (UUIDv7) - pre-created in DB before job submission */
  webPageId: string;
  /** Target URL to analyze */
  url: string;
  /** Analysis options */
  options: PageAnalyzeJobOptions;
  /** Job creation timestamp (ISO 8601) */
  createdAt: string;
  /** Optional request ID for tracing */
  requestId?: string;
}

/**
 * Analysis options for the job
 */
export interface PageAnalyzeJobOptions {
  /** Overall timeout in ms (default: 60000) */
  timeout?: number;
  /** Features to enable/disable */
  features?: {
    /** Enable layout analysis (default: true) */
    layout?: boolean;
    /** Enable motion detection (default: true) */
    motion?: boolean;
    /** Enable quality evaluation (default: true) */
    quality?: boolean;
  };
  /** Layout analysis specific options */
  layoutOptions?: {
    useVision?: boolean;
    saveToDb?: boolean;
    autoAnalyze?: boolean;
    fullPage?: boolean;
    viewport?: { width: number; height: number };
    /** Enable scroll-position smart capture + Vision analysis (default: true when useVision=true) */
    scrollVision?: boolean;
    /** Maximum number of scroll positions to capture (default: 10) */
    scrollVisionMaxCaptures?: number;
  };
  /** Motion detection specific options */
  motionOptions?: {
    detectJsAnimations?: boolean;
    detectWebglAnimations?: boolean;
    enableFrameCapture?: boolean;
    saveToDb?: boolean;
    maxPatterns?: number;
    /**
     * Motion detection timeout in milliseconds.
     * MCP Protocol has a 60-second tool call limit. In async worker mode,
     * this limit doesn't apply, allowing longer detection times for heavy sites.
     * @default 180000 (3 minutes)
     * @max 600000 (10 minutes)
     */
    timeout?: number;
  };
  /** Quality evaluation specific options */
  qualityOptions?: {
    strict?: boolean;
    weights?: {
      originality?: number;
      craftsmanship?: number;
      contextuality?: number;
    };
    targetIndustry?: string;
    targetAudience?: string;
  };
  /** Narrative analysis options */
  narrativeOptions?: {
    enabled?: boolean;
    saveToDb?: boolean;
    includeVision?: boolean;
    visionTimeoutMs?: number;
    generateEmbedding?: boolean;
  };
}

/**
 * Job result for page analysis
 */
export interface PageAnalyzeJobResult {
  /** WebPage ID */
  webPageId: string;
  /** Overall success status */
  success: boolean;
  /** Partial success (some phases completed) */
  partialSuccess: boolean;
  /** List of completed analysis phases */
  completedPhases: AnalysisPhase[];
  /** List of failed analysis phases */
  failedPhases: AnalysisPhase[];
  /** Phase-specific results (lightweight summary) */
  results?: {
    layout?: {
      sectionsDetected: number;
      visionUsed: boolean;
      /** Whether scroll vision analysis was performed */
      scrollVisionAnalyzed?: boolean;
      /** Number of scroll-triggered animations detected */
      scrollTriggeredAnimations?: number;
    };
    motion?: {
      patternsDetected: number;
      jsAnimationsDetected: number;
      webglAnimationsDetected?: number | undefined;
    };
    quality?: {
      overallScore: number;
      grade: string;
    };
    narrative?: {
      moodCategory: string;
      confidence: number;
      visionUsed: boolean;
    };
    embedding?: {
      sectionEmbeddingsGenerated?: number | undefined;
      motionEmbeddingsGenerated?: number | undefined;
      backgroundDesignEmbeddingsGenerated?: number | undefined;
      jsAnimationEmbeddingsGenerated?: number | undefined;
    };
  };
  /** Error message if failed */
  error?: string;
  /** Processing duration in ms */
  processingTimeMs?: number;
  /** Job completion timestamp */
  completedAt?: string;
}

/**
 * Analysis phases
 */
export type AnalysisPhase = 'ingest' | 'layout' | 'motion' | 'quality' | 'narrative' | 'embedding';

/**
 * Job status for polling
 */
export interface PageAnalyzeJobStatus {
  /** Job ID */
  jobId: string;
  /** Current state */
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  /** Progress percentage (0-100) */
  progress: number;
  /** Current phase being processed */
  currentPhase?: AnalysisPhase;
  /** Result (if completed) */
  result?: PageAnalyzeJobResult;
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
 * Create the page analyze queue
 *
 * @param configOverrides - Optional Redis configuration overrides
 * @returns BullMQ Queue instance
 */
export function createPageAnalyzeQueue(
  configOverrides?: Partial<RedisConfig>
): Queue<PageAnalyzeJobData, PageAnalyzeJobResult> {
  const config = getRedisConfig(configOverrides);

  return new Queue<PageAnalyzeJobData, PageAnalyzeJobResult>(PAGE_ANALYZE_QUEUE_NAME, {
    connection: toConnectionOptions(config),
    defaultJobOptions: {
      // No retries for WebGL heavy sites (would just timeout again)
      attempts: 1,
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
      // Backoff strategy (only relevant if attempts > 1)
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
export function createQueueEvents(
  configOverrides?: Partial<RedisConfig>
): QueueEvents {
  const config = getRedisConfig(configOverrides);

  return new QueueEvents(PAGE_ANALYZE_QUEUE_NAME, {
    connection: toConnectionOptions(config),
  });
}

/**
 * Add a page analyze job to the queue
 *
 * @param queue - BullMQ Queue instance
 * @param data - Job data
 * @param priority - Job priority (lower = higher priority, default: 10)
 * @returns Job instance
 */
export async function addPageAnalyzeJob(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>,
  data: Omit<PageAnalyzeJobData, 'createdAt'>,
  priority: number = 10
): Promise<Job<PageAnalyzeJobData, PageAnalyzeJobResult>> {
  const jobData: PageAnalyzeJobData = {
    ...data,
    createdAt: new Date().toISOString(),
  };

  // Use webPageId as job ID for easy lookup
  return queue.add(PAGE_ANALYZE_QUEUE_NAME, jobData, {
    jobId: data.webPageId,
    priority,
  });
}

/**
 * Get job status by ID
 *
 * @param queue - BullMQ Queue instance
 * @param jobId - Job ID (webPageId)
 * @returns Job status or null if not found
 */
export async function getJobStatus(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>,
  jobId: string
): Promise<PageAnalyzeJobStatus | null> {
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();
  // Support both numeric progress (granular per-phase) and object progress (ExecutionStatusTrackerV2)
  const progress = typeof job.progress === 'number'
    ? job.progress
    : (typeof job.progress === 'object' && job.progress !== null && 'overallProgress' in job.progress)
      ? (job.progress as { overallProgress: number }).overallProgress
      : 0;

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

  // Build result object, only including defined optional properties
  const status: PageAnalyzeJobStatus = {
    jobId: job.id || jobId,
    state: state as PageAnalyzeJobStatus['state'],
    progress,
    timestamps,
  };

  // Add optional properties only if they have values
  if (job.data.options?.features?.layout) {
    status.currentPhase = 'layout';
  }
  if (state === 'completed' && job.returnvalue) {
    status.result = job.returnvalue;
  }
  if (state === 'failed' && job.failedReason) {
    status.error = job.failedReason;
  }

  return status;
}

/**
 * Gracefully close the queue
 *
 * @param queue - BullMQ Queue instance
 */
export async function closeQueue(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>
): Promise<void> {
  await queue.close();
}

/**
 * Check if queue is healthy
 *
 * @param queue - BullMQ Queue instance
 * @returns Health status
 */
export async function checkQueueHealth(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>
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
