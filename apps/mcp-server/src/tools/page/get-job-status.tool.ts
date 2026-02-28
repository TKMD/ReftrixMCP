// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.getJobStatus - MCP Tool for checking async job status
 *
 * Phase3-2: Allows clients to poll for async job status and results.
 *
 * Features:
 * - Returns job state (waiting, active, completed, failed)
 * - Returns progress percentage (0-100)
 * - Returns result summary when completed
 * - Returns error details when failed
 * - Graceful degradation when Redis is unavailable
 *
 * レスポンス形式:
 * - 成功: { success: true, data: {...}, metadata: { request_id, ... } }
 * - エラー: { success: false, error: { code, message }, metadata: { request_id, ... } }
 *
 * @module tools/page/get-job-status.tool
 */

import { isRedisAvailable } from '../../config/redis';
import {
  createPageAnalyzeQueue,
  getJobStatus,
  closeQueue,
} from '../../queues/page-analyze-queue';
import {
  pageGetJobStatusInputSchema,
  type PageGetJobStatusInput,
  type PageGetJobStatusOutput,
  type PageGetJobStatusData,
} from './schemas';
import { logger, isDevelopment } from '../../utils/logger';
import {
  generateRequestId,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from '../../utils/mcp-response';

// ============================================================================
// Constants
// ============================================================================

/**
 * Error codes for page.getJobStatus
 */
export const GET_JOB_STATUS_ERROR_CODES = {
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
export const pageGetJobStatusToolDefinition = {
  name: 'page.getJobStatus',
  description: `Check the status of an async page analysis job.

Use this tool to poll for the status and results of a job that was submitted
with page.analyze(async=true).

Returns:
- Job state (waiting, active, completed, failed)
- Progress percentage (0-100)
- Result summary when completed
- Error details when failed

Note: Requires Redis to be running. Jobs are retained for 24 hours after completion.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      job_id: {
        type: 'string',
        format: 'uuid',
        description: 'The job ID returned by page.analyze(async=true)',
      },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Page Get Job Status',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle page.getJobStatus tool invocation
 *
 * @param input - Raw input from MCP
 * @returns 統一レスポンス形式（success: true/false + data/error + metadata.request_id）
 */
export async function pageGetJobStatusHandler(
  input: unknown
): Promise<PageGetJobStatusOutput> {
  // router.tsから注入された_request_idを使用、フォールバックとして自動生成
  const requestId =
    (input as Record<string, unknown> | null)?._request_id as string | undefined ??
    generateRequestId();

  if (isDevelopment()) {
    logger.info('[MCP Tool] page.getJobStatus called', {
      hasInput: input !== null && input !== undefined,
      requestId,
    });
  }

  // Validate input
  let validated: PageGetJobStatusInput;
  try {
    validated = pageGetJobStatusInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] page.getJobStatus validation error', { error, requestId });
    }
    return createErrorResponseWithRequestId(
      GET_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR,
      error instanceof Error ? error.message : 'Invalid input',
      requestId
    );
  }

  const jobId = validated.job_id;

  // Check Redis availability
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] page.getJobStatus Redis unavailable', { requestId });
    }
    return createErrorResponseWithRequestId(
      GET_JOB_STATUS_ERROR_CODES.REDIS_UNAVAILABLE,
      'Redis is not available. Cannot check job status without Redis.',
      requestId
    );
  }

  // Create queue connection and get job status
  const queue = createPageAnalyzeQueue();

  try {
    const status = await getJobStatus(queue, jobId);

    if (!status) {
      // Job not found
      if (isDevelopment()) {
        logger.debug('[MCP Tool] page.getJobStatus job not found', { jobId, requestId });
      }
      return createErrorResponseWithRequestId(
        GET_JOB_STATUS_ERROR_CODES.JOB_NOT_FOUND,
        `Job with ID ${jobId} not found. It may have expired (jobs are retained for 24 hours) or never existed.`,
        requestId
      );
    }

    // Job found - build response data
    if (isDevelopment()) {
      logger.debug('[MCP Tool] page.getJobStatus job found', {
        jobId,
        state: status.state,
        progress: status.progress,
        requestId,
      });
    }

    // Build data object
    const data: PageGetJobStatusData = {
      jobId: status.jobId,
      status: status.state,
      progress: status.progress,
      timestamps: status.timestamps,
    };

    // Add optional fields based on state
    if (status.currentPhase) {
      data.currentPhase = status.currentPhase;
    }

    if (status.state === 'completed' && status.result) {
      data.result = status.result;
    }

    if (status.state === 'failed' && status.error) {
      data.failedReason = status.error;
    }

    return createSuccessResponseWithRequestId(data, requestId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[MCP Tool] page.getJobStatus error', {
      jobId,
      error: errorMessage,
      requestId,
    });
    // SEC監査指摘: 本番環境では詳細エラーメッセージを隠蔽
    // 開発環境のみ詳細を表示、本番では一般的なメッセージ
    const userMessage = isDevelopment()
      ? `Failed to get job status: ${errorMessage}`
      : 'Failed to get job status';
    return createErrorResponseWithRequestId(
      GET_JOB_STATUS_ERROR_CODES.INTERNAL_ERROR,
      userMessage,
      requestId
    );
  } finally {
    // Close queue connection
    await closeQueue(queue);
  }
}
