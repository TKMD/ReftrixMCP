// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.getJobStatus - MCP Tool for checking batch quality evaluation job status
 *
 * Phase4: Allows clients to poll for async batch evaluation job status and results.
 *
 * Features:
 * - Returns job state (waiting, active, completed, failed)
 * - Returns progress percentage (0-100)
 * - Returns result summary when completed
 * - Returns error details when failed
 * - Graceful degradation: Falls back to LRU store when Redis is unavailable
 *
 * レスポンス形式:
 * - 成功: { success: true, data: {...}, metadata: { request_id, ... } }
 * - エラー: { success: false, error: { code, message }, metadata: { request_id, ... } }
 *
 * @module tools/quality/get-job-status.tool
 */

import { isRedisAvailable } from '../../config/redis';
import {
  createBatchQualityQueue,
  getBatchQualityJobStatus,
  closeBatchQualityQueue,
} from '../../queues/batch-quality-queue';
import {
  qualityGetJobStatusInputSchema,
  type QualityGetJobStatusInput,
  type QualityGetJobStatusOutput,
  type QualityGetJobStatusData,
  type QualityJobState,
} from './schemas';

// Re-export types for external use
export type { QualityGetJobStatusInput, QualityGetJobStatusOutput } from './schemas';
import { getBatchJob } from './batch-evaluate.tool';
import { logger, isDevelopment } from '../../utils/logger';
import {
  generateRequestId,
  createErrorResponseWithRequestId,
} from '../../utils/mcp-response';

// ============================================================================
// Constants
// ============================================================================

/**
 * Error codes for quality.getJobStatus
 */
export const GET_QUALITY_JOB_STATUS_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  REDIS_UNAVAILABLE: 'REDIS_UNAVAILABLE',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * Tool definition for MCP registration
 */
export const qualityGetJobStatusToolDefinition = {
  name: 'quality.getJobStatus',
  description: `Check the status of an async batch quality evaluation job.

Use this tool to poll for the status and results of a job that was submitted
with quality.batch_evaluate.

Returns:
- Job state (waiting, active, completed, failed)
- Progress percentage (0-100)
- Item counts (total, processed, success, failed)
- Result summary when completed
- Error details when failed

Note: When Redis is unavailable, falls back to LRU store (in-memory).
Jobs in LRU store are not persisted across server restarts.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      job_id: {
        type: 'string',
        format: 'uuid',
        description: 'The job ID returned by quality.batch_evaluate',
      },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Quality Get Job Status',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map BullMQ job state to QualityJobState
 */
function mapBullMQStateToQualityState(
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'
): QualityJobState {
  return state;
}

/**
 * Map LRU store status to QualityJobState
 */
function mapLRUStatusToQualityState(
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
): QualityJobState {
  switch (status) {
    case 'pending':
      return 'waiting';
    case 'processing':
      return 'active';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'failed';
    default:
      return 'unknown';
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle quality.getJobStatus tool invocation
 *
 * @param input - Raw input from MCP
 * @returns 統一レスポンス形式（success: true/false + data/error + metadata.request_id）
 */
export async function qualityGetJobStatusHandler(
  input: unknown
): Promise<QualityGetJobStatusOutput> {
  // router.tsから注入された_request_idを使用、フォールバックとして自動生成
  const requestId =
    (input as Record<string, unknown> | null)?._request_id as string | undefined ??
    generateRequestId();

  if (isDevelopment()) {
    logger.info('[MCP Tool] quality.getJobStatus called', {
      hasInput: input !== null && input !== undefined,
      requestId,
    });
  }

  // Validate input
  let validated: QualityGetJobStatusInput;
  try {
    validated = qualityGetJobStatusInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] quality.getJobStatus validation error', { error, requestId });
    }
    return createErrorResponseWithRequestId(
      GET_QUALITY_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR,
      error instanceof Error ? error.message : 'Invalid input',
      requestId
    );
  }

  const jobId = validated.job_id;

  // Check Redis availability
  const redisAvailable = await isRedisAvailable();

  if (redisAvailable) {
    // Try BullMQ queue first
    const queue = createBatchQualityQueue();

    try {
      const status = await getBatchQualityJobStatus(queue, jobId);

      if (status) {
        // Job found in BullMQ
        if (isDevelopment()) {
          logger.debug('[MCP Tool] quality.getJobStatus job found in BullMQ', {
            jobId,
            state: status.state,
            progress: status.progress,
            requestId,
          });
        }

        const data: QualityGetJobStatusData = {
          jobId: status.jobId,
          status: mapBullMQStateToQualityState(status.state),
          progress: status.progress,
          totalItems: status.totalItems,
          processedItems: status.processedItems,
          successItems: status.successItems,
          failedItems: status.failedItems,
          timestamps: status.timestamps,
        };

        // Add result if completed
        if (status.state === 'completed' && status.result) {
          data.result = {
            jobId: status.result.jobId,
            success: status.result.success,
            totalItems: status.result.totalItems,
            processedItems: status.result.processedItems,
            successItems: status.result.successItems,
            failedItems: status.result.failedItems,
            results: status.result.results.map((r) => ({
              index: r.index,
              success: r.success,
              data: r.data,
              error: r.error,
            })),
            processingTimeMs: status.result.processingTimeMs,
            completedAt: status.result.completedAt,
            error: status.result.error,
          };
        }

        // Add error if failed
        if (status.state === 'failed' && status.error) {
          data.failedReason = status.error;
        }

        return {
          success: true,
          data,
          metadata: {
            request_id: requestId,
            redis_used: true,
            lru_fallback: false,
          },
        };
      }

      // Job not found in BullMQ, try LRU store as fallback
      if (isDevelopment()) {
        logger.debug('[MCP Tool] quality.getJobStatus job not found in BullMQ, trying LRU store', {
          jobId,
          requestId,
        });
      }
    } finally {
      // Close queue connection
      await closeBatchQualityQueue(queue);
    }
  }

  // Try LRU store (either Redis unavailable or job not found in BullMQ)
  const lruJob = getBatchJob(jobId);

  if (lruJob) {
    // Job found in LRU store
    if (isDevelopment()) {
      logger.debug('[MCP Tool] quality.getJobStatus job found in LRU store', {
        jobId,
        status: lruJob.status,
        progress: lruJob.progress_percent,
        requestId,
      });
    }

    const data: QualityGetJobStatusData = {
      jobId: lruJob.job_id,
      status: mapLRUStatusToQualityState(lruJob.status),
      progress: lruJob.progress_percent,
      totalItems: lruJob.total_items,
      processedItems: lruJob.processed_items,
      successItems: lruJob.success_items,
      failedItems: lruJob.failed_items,
      timestamps: {
        created: new Date(lruJob.created_at).getTime(),
        completed: lruJob.completed_at ? new Date(lruJob.completed_at).getTime() : undefined,
      },
    };

    // Add result if completed
    if (lruJob.status === 'completed' && lruJob.results) {
      data.result = {
        jobId: lruJob.job_id,
        success: lruJob.failed_items === 0,
        totalItems: lruJob.total_items,
        processedItems: lruJob.processed_items,
        successItems: lruJob.success_items,
        failedItems: lruJob.failed_items,
        results: lruJob.results.map((r, index) => ({
          index,
          success: true,
          data: r,
        })),
        completedAt: lruJob.completed_at,
      };

      // Add errors if any
      if (lruJob.errors && lruJob.errors.length > 0) {
        data.result.results = [
          ...data.result.results ?? [],
          ...lruJob.errors.map((e) => ({
            index: e.index,
            success: false,
            error: e.error,
          })),
        ].sort((a, b) => a.index - b.index);
      }
    }

    // Add error if failed
    if (lruJob.status === 'failed' && lruJob.errors && lruJob.errors.length > 0) {
      data.failedReason = lruJob.errors[0]?.error?.message ?? 'Unknown error';
    }

    return {
      success: true,
      data,
      metadata: {
        request_id: requestId,
        redis_used: false,
        lru_fallback: true,
      },
    };
  }

  // Job not found in either BullMQ or LRU store
  if (isDevelopment()) {
    logger.debug('[MCP Tool] quality.getJobStatus job not found', { jobId, requestId });
  }

  return createErrorResponseWithRequestId(
    GET_QUALITY_JOB_STATUS_ERROR_CODES.JOB_NOT_FOUND,
    `Job with ID ${jobId} not found. It may have expired (jobs are retained for 24 hours) or never existed.`,
    requestId
  );
}
