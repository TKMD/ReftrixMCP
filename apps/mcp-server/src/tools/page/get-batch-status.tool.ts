// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Batch status lookup used by page.getJobStatus(batch_id)
 *
 * バッチジョブの進捗確認・結果取得。2026-11-04 に MCP ツール page.getBatchStatus を
 * page.getJobStatus へ統合し、本ファイルはその batch_id 経路の実装になった。
 * Implements the batch_id path of page.getJobStatus; the standalone page.getBatchStatus
 * tool was merged into page.getJobStatus on 2026-11-04.
 *
 * @module tools/page/get-batch-status.tool
 */

import { isRedisAvailable, getRedisClient } from "../../config/redis";
import { createPageAnalyzeQueue, getJobStatus, closeQueue } from "../../queues/page-analyze-queue";
import {
  getBatchStatusInputSchema,
  GET_BATCH_STATUS_ERROR_CODES,
  BATCH_KEY_PREFIX,
  type GetBatchStatusInput,
  type GetBatchStatusCombinedOutput,
  type BatchJobItem,
  type BatchSummary,
  type BatchMetadata,
} from "./batch-analyze.schemas";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  generateRequestId,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from "../../utils/mcp-response";

// ============================================================================
// Handler
// ============================================================================

/**
 * batch_id 経路のハンドラー（page.getJobStatus から呼ばれる） / batch_id path handler
 */
export async function pageGetBatchStatusHandler(
  input: unknown
): Promise<GetBatchStatusCombinedOutput> {
  // page.getJobStatus から渡された router の _request_id を引き継ぐ / keep the router's request id
  const requestId =
    ((input as Record<string, unknown> | null)?._request_id as string | undefined) ??
    generateRequestId();
  const startTime = Date.now();

  // 入力バリデーション
  let validated: GetBatchStatusInput;
  try {
    if (input === null || input === undefined) {
      return createErrorResponseWithRequestId(
        GET_BATCH_STATUS_ERROR_CODES.VALIDATION_ERROR,
        "Input is required",
        requestId
      ) as GetBatchStatusCombinedOutput;
    }
    validated = getBatchStatusInputSchema.parse(input);
  } catch (error) {
    return createErrorResponseWithRequestId(
      GET_BATCH_STATUS_ERROR_CODES.VALIDATION_ERROR,
      sanitizeErrorMessage(error),
      requestId
    ) as GetBatchStatusCombinedOutput;
  }

  // Redis可用性チェック
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    return createErrorResponseWithRequestId(
      GET_BATCH_STATUS_ERROR_CODES.REDIS_UNAVAILABLE,
      "Redis is unavailable. Cannot check batch status.",
      requestId
    ) as GetBatchStatusCombinedOutput;
  }

  // バッチメタデータ取得
  const redis = getRedisClient();
  const batchKey = `${BATCH_KEY_PREFIX}${validated.batch_id}`;
  const raw = await redis.get(batchKey);

  if (!raw) {
    return createErrorResponseWithRequestId(
      GET_BATCH_STATUS_ERROR_CODES.BATCH_NOT_FOUND,
      `Batch ${validated.batch_id.slice(0, 8)}... not found. It may have expired (48h TTL).`,
      requestId
    ) as GetBatchStatusCombinedOutput;
  }

  let metadata: BatchMetadata;
  try {
    metadata = JSON.parse(raw) as BatchMetadata;
  } catch {
    return createErrorResponseWithRequestId(
      GET_BATCH_STATUS_ERROR_CODES.INTERNAL_ERROR,
      "Failed to parse batch metadata",
      requestId
    ) as GetBatchStatusCombinedOutput;
  }

  // 各子ジョブの状態を照会
  const queue = createPageAnalyzeQueue();
  const jobs: BatchJobItem[] = [];
  const summary: BatchSummary = {
    total: metadata.urls.length + metadata.skippedUrls.length,
    completed: 0,
    failed: 0,
    skipped: metadata.skippedUrls.length,
    active: 0,
    waiting: 0,
  };

  try {
    for (let i = 0; i < metadata.jobIds.length; i++) {
      const jobId = metadata.jobIds[i] ?? "";
      const url = metadata.urls[i] ?? "unknown";
      const webPageId = metadata.webPageIds[i] ?? "";

      if (!jobId) continue;

      const status = await getJobStatus(queue, jobId);

      if (!status) {
        jobs.push({
          url,
          jobId,
          state: "waiting",
          webPageId,
        });
        summary.waiting++;
        continue;
      }

      switch (status.state) {
        case "completed":
          jobs.push({
            url,
            jobId,
            state: "completed",
            webPageId,
            processingTimeMs: status.result?.processingTimeMs,
          });
          summary.completed++;
          break;
        case "failed":
          jobs.push({
            url,
            jobId,
            state: "failed",
            webPageId,
            error: status.error ?? "Unknown error",
          });
          summary.failed++;
          break;
        case "active":
          jobs.push({
            url,
            jobId,
            state: "active",
            webPageId,
          });
          summary.active++;
          break;
        default:
          jobs.push({
            url,
            jobId,
            state: "waiting",
            webPageId,
          });
          summary.waiting++;
          break;
      }
    }

    // スキップされたURLも追加
    for (const skipped of metadata.skippedUrls) {
      jobs.push({
        url: skipped.url,
        jobId: "",
        state: "skipped",
        error: skipped.reason,
      });
    }

    // バッチ全体の状態を判定
    const allJobsDone = summary.active === 0 && summary.waiting === 0;
    let batchState: "waiting" | "active" | "completed" | "failed" | "partial";

    if (!allJobsDone) {
      batchState = summary.active > 0 ? "active" : "waiting";
    } else if (summary.failed === 0) {
      batchState = "completed";
    } else if (summary.completed > 0) {
      batchState = "partial";
    } else {
      batchState = "failed";
    }

    // 完了時にメタデータを更新
    if (allJobsDone && metadata.state !== batchState) {
      metadata.state = batchState;
      metadata.completedAt = new Date().toISOString();
      await redis.setex(batchKey, 48 * 60 * 60, JSON.stringify(metadata));
    }

    // 進捗率計算
    const totalJobs = metadata.jobIds.length;
    const doneJobs = summary.completed + summary.failed;
    const progress = totalJobs > 0 ? Math.round((doneJobs / totalJobs) * 100) : 0;

    await closeQueue(queue);

    return createSuccessResponseWithRequestId(
      {
        batchId: validated.batch_id,
        state: batchState,
        progress,
        summary,
        jobs,
        startedAt: metadata.startedAt,
        completedAt: metadata.completedAt,
        elapsedMs: Date.now() - new Date(metadata.startedAt).getTime(),
      },
      requestId,
      { processing_time_ms: Date.now() - startTime }
    ) as GetBatchStatusCombinedOutput;
  } catch (error) {
    logger.warn("[page.getJobStatus:batch] Failed to query job statuses", {
      error: (error as Error).message,
    });
    await closeQueue(queue);
    return createErrorResponseWithRequestId(
      GET_BATCH_STATUS_ERROR_CODES.INTERNAL_ERROR,
      sanitizeErrorMessage(error),
      requestId
    ) as GetBatchStatusCombinedOutput;
  }
}
