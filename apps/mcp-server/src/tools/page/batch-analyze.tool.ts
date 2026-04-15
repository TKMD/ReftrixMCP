// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.batch_analyze MCPツール
 * 複数URLの一括分析（BullMQバッチジョブ）
 *
 * 設計:
 * - 親ジョブ(batch) → 子ジョブ(individual page.analyze)の依存関係
 * - 子ジョブ失敗時もバッチ全体は続行（Graceful Degradation）
 * - 同時1バッチ制限（AW-5）
 * - 全URLにSSRF事前検証（AW-6）
 * - analysis tier (10 RPM) のバッチ内レート制御
 *
 * @module tools/page/batch-analyze.tool
 */

import { v7 as uuidv7 } from "uuid";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { validateExternalUrl, normalizeUrlForValidation } from "../../utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
import { isRedisAvailable, getRedisClient } from "../../config/redis";
import {
  createPageAnalyzeQueue,
  addPageAnalyzeJob,
  closeQueue,
  type PageAnalyzeJobOptions,
  type PageAnalyzeJobData,
} from "../../queues/page-analyze-queue";
import { getWorkerSupervisor } from "../../services/worker-supervisor.service";
import { cleanupQueue, createQueueAdapter } from "../../services/queue-cleanup.service";
import {
  generateRequestId,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from "../../utils/mcp-response";
import {
  batchAnalyzeInputSchema,
  BATCH_ANALYZE_ERROR_CODES,
  BATCH_DEFAULT_TIMEOUT_MS,
  BATCH_KEY_PREFIX,
  type BatchAnalyzeInput,
  type BatchAnalyzeOutput,
  type BatchMetadata,
} from "./batch-analyze.schemas";

// ============================================================================
// Constants
// ============================================================================

/** 同時実行バッチ数の上限 / Max concurrent batches (AW-5) */
const MAX_CONCURRENT_BATCHES = 1;

/** バッチジョブのTTL（48時間）/ Batch job TTL */
const BATCH_TTL_SECONDS = 48 * 60 * 60;

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * page.batch_analyze ツール定義（MCP登録用）
 * Tool definition for MCP registration
 */
export const pageBatchAnalyzeToolDefinition = {
  name: "page.batch_analyze",
  description: `Batch analyze multiple URLs in parallel. Submits all URLs as async BullMQ jobs and returns immediately with a batch ID.

Features:
- Up to 50 URLs per batch
- Configurable concurrency (1-5, default: 3)
- SSRF validation for all URLs before submission
- Graceful degradation: individual failures don't affect the batch
- Progress tracking via page.getBatchStatus
- Rate limiting within analysis tier (10 RPM)

Use page.getBatchStatus to poll for results.`,
  annotations: {
    title: "Batch Page Analyzer",
    readOnlyHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      urls: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Target URLs to analyze (1-50)",
        minItems: 1,
        maxItems: 50,
      },
      concurrency: {
        type: "number" as const,
        description: "Parallel jobs within batch (1-5, default: 3)",
        minimum: 1,
        maximum: 5,
      },
      timeout: {
        type: "number" as const,
        description: "Batch-level timeout in ms (default: 1800000 = 30min)",
      },
      features: {
        type: "object" as const,
        properties: {
          layout: { type: "boolean" as const },
          motion: { type: "boolean" as const },
          quality: { type: "boolean" as const },
        },
        description: "Shared analysis features (default: all enabled)",
      },
      layoutOptions: {
        type: "object" as const,
        properties: {
          useVision: { type: "boolean" as const },
          saveToDb: { type: "boolean" as const },
          fullPage: { type: "boolean" as const },
        },
        description: "Shared layout options for all URLs",
      },
      respect_robots_txt: {
        type: "boolean" as const,
        description: "Respect robots.txt (default: true)",
      },
      on_error: {
        type: "string" as const,
        enum: ["skip", "abort"],
        description:
          "Behavior on individual job failure: 'skip' (continue) or 'abort' (stop batch)",
      },
    },
    required: ["urls"],
  },
};

// ============================================================================
// Handler
// ============================================================================

/**
 * page.batch_analyze ハンドラー
 * Batch analyze handler
 *
 * @param input - ツール入力パラメータ / Tool input parameters
 * @returns バッチジョブIDと投入結果 / Batch job ID and submission results
 */
export async function pageBatchAnalyzeHandler(input: unknown): Promise<BatchAnalyzeOutput> {
  const requestId = generateRequestId();
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info("[MCP Tool] page.batch_analyze called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // ---------------------------------------------------------------
  // 1. 入力バリデーション / Input validation
  // ---------------------------------------------------------------
  let validated: BatchAnalyzeInput;
  try {
    if (input === null || input === undefined) {
      return createErrorResponseWithRequestId(
        BATCH_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
        "Input is required",
        requestId
      ) as BatchAnalyzeOutput;
    }
    validated = batchAnalyzeInputSchema.parse(input);
  } catch (error) {
    logger.warn("[MCP Tool] page.batch_analyze validation error", {
      error: (error as Error).message,
    });
    return createErrorResponseWithRequestId(
      BATCH_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
      sanitizeErrorMessage(error),
      requestId
    ) as BatchAnalyzeOutput;
  }

  // ---------------------------------------------------------------
  // 2. Redis可用性チェック / Redis availability check
  // ---------------------------------------------------------------
  const redisAvailable = await isRedisAvailable();
  if (!redisAvailable) {
    return createErrorResponseWithRequestId(
      BATCH_ANALYZE_ERROR_CODES.REDIS_UNAVAILABLE,
      "Batch analysis requires Redis. Please start Redis.",
      requestId
    ) as BatchAnalyzeOutput;
  }

  // ---------------------------------------------------------------
  // 3. 同時バッチ数制限チェック (AW-5) / Concurrent batch limit check
  // ---------------------------------------------------------------
  const queue = createPageAnalyzeQueue();
  try {
    const activeBatchCount = await getActiveBatchCount(queue);
    if (activeBatchCount >= MAX_CONCURRENT_BATCHES) {
      await closeQueue(queue);
      return createErrorResponseWithRequestId(
        BATCH_ANALYZE_ERROR_CODES.BATCH_ALREADY_RUNNING,
        `Maximum ${MAX_CONCURRENT_BATCHES} concurrent batch(es) allowed. Please wait for the current batch to complete.`,
        requestId
      ) as BatchAnalyzeOutput;
    }
  } catch (error) {
    logger.warn("[page.batch_analyze] Failed to check active batch count", {
      error: (error as Error).message,
    });
    // 確認失敗時は続行（Redis一時障害への Graceful Degradation）
  }

  // ---------------------------------------------------------------
  // 4. SSRF事前検証 (AW-6) / Pre-validate all URLs for SSRF
  // ---------------------------------------------------------------
  const validatedUrls: Array<{ url: string; normalizedUrl: string; webPageId: string }> = [];
  const skippedUrls: Array<{ url: string; reason: string }> = [];

  for (const url of validated.urls) {
    // SSRF検証
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      skippedUrls.push({ url, reason: urlValidation.error ?? "SSRF blocked" });
      continue;
    }

    // robots.txt チェック
    if (validated.respect_robots_txt) {
      const robotsResult = await isUrlAllowedByRobotsTxt(url, true);
      if (!robotsResult.allowed) {
        skippedUrls.push({ url, reason: `robots.txt: ${robotsResult.reason ?? "disallowed"}` });
        continue;
      }
    }

    const normalizedUrl = urlValidation.normalizedUrl ?? normalizeUrlForValidation(url);
    validatedUrls.push({
      url,
      normalizedUrl,
      webPageId: uuidv7(),
    });
  }

  // 全URLがスキップされた場合
  if (validatedUrls.length === 0) {
    await closeQueue(queue);
    return createErrorResponseWithRequestId(
      BATCH_ANALYZE_ERROR_CODES.SSRF_BLOCKED,
      `All ${validated.urls.length} URL(s) were blocked by security validation (SSRF/robots.txt).`,
      requestId
    ) as BatchAnalyzeOutput;
  }

  // ---------------------------------------------------------------
  // 5. ワーカー起動確認 / Ensure worker is running
  // ---------------------------------------------------------------
  getWorkerSupervisor().ensureWorkerRunning();

  // キュークリーンアップ
  const cleanupResult = await cleanupQueue(createQueueAdapter(queue));
  if (cleanupResult.strategy !== "skipped" && isDevelopment()) {
    logger.info("[page.batch_analyze] Queue cleanup before batch submission", {
      strategy: cleanupResult.strategy,
      totalCleaned: cleanupResult.totalCleaned,
    });
  }

  // ---------------------------------------------------------------
  // 6. バッチジョブ投入 / Submit batch jobs
  // ---------------------------------------------------------------
  const batchId = uuidv7();
  const jobIds: string[] = [];

  try {
    // 共通ジョブオプション構築
    const sharedJobOptions = buildSharedJobOptions(validated);

    // 子ジョブを一括投入（addBulkは使わず個別投入 — priority設定のため）
    for (const item of validatedUrls) {
      const jobData: Omit<PageAnalyzeJobData, "createdAt"> = {
        webPageId: item.webPageId,
        url: item.url,
        options: sharedJobOptions,
        requestId: `${batchId}:${item.webPageId}`,
      };

      const job = await addPageAnalyzeJob(queue, jobData, 10);
      jobIds.push(job.id ?? item.webPageId);
    }

    // バッチメタデータをRedisに保存（ステータス追跡用）
    await saveBatchMetadata(queue, batchId, {
      jobIds,
      urls: validatedUrls.map((v) => v.url),
      skippedUrls,
      concurrency: validated.concurrency,
      timeout: validated.timeout ?? BATCH_DEFAULT_TIMEOUT_MS,
      onError: validated.on_error ?? "skip",
      startedAt: new Date().toISOString(),
      webPageIds: validatedUrls.map((v) => v.webPageId),
    });

    if (isDevelopment()) {
      logger.info("[page.batch_analyze] Batch submitted", {
        batchId: batchId.slice(0, 8) + "...",
        totalUrls: validated.urls.length,
        validUrls: validatedUrls.length,
        skippedUrls: skippedUrls.length,
        jobCount: jobIds.length,
      });
    }

    await closeQueue(queue);

    return createSuccessResponseWithRequestId(
      {
        batchId,
        totalUrls: validatedUrls.length,
        skippedUrls: skippedUrls.length,
        jobIds,
        message:
          `Batch ${batchId.slice(0, 8)}... submitted: ${validatedUrls.length} URL(s) queued` +
          (skippedUrls.length > 0 ? `, ${skippedUrls.length} skipped (SSRF/robots.txt)` : "") +
          `. Use page.getBatchStatus with batch_id to check progress.`,
      },
      requestId,
      { processing_time_ms: Date.now() - startTime }
    ) as BatchAnalyzeOutput;
  } catch (error) {
    logger.warn("[page.batch_analyze] Failed to submit batch jobs", {
      error: (error as Error).message,
      batchId: batchId.slice(0, 8) + "...",
    });
    await closeQueue(queue);
    return createErrorResponseWithRequestId(
      BATCH_ANALYZE_ERROR_CODES.INTERNAL_ERROR,
      sanitizeErrorMessage(error),
      requestId
    ) as BatchAnalyzeOutput;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * 共通ジョブオプションを構築 / Build shared job options
 */
function buildSharedJobOptions(input: BatchAnalyzeInput): PageAnalyzeJobOptions {
  const opts: PageAnalyzeJobOptions = {
    features: {
      layout: input.features?.layout ?? true,
      motion: input.features?.motion ?? true,
      quality: input.features?.quality ?? true,
    },
  };

  // layoutOptions
  const src = input.layoutOptions;
  opts.layoutOptions = {
    useVision: src?.useVision ?? true,
    saveToDb: src?.saveToDb ?? true,
    autoAnalyze: true,
    fullPage: src?.fullPage ?? true,
    scrollVision: true,
    scrollVisionMaxCaptures: 10,
  };
  if (src?.viewport) {
    opts.layoutOptions.viewport = src.viewport;
  }

  // robots.txt
  if (input.respect_robots_txt !== undefined) {
    opts.respectRobotsTxt = input.respect_robots_txt;
  }

  return opts;
}

/**
 * アクティブバッチ数を取得 / Get active batch count
 */
async function getActiveBatchCount(
  _queue: ReturnType<typeof createPageAnalyzeQueue>
): Promise<number> {
  try {
    const redis = getRedisClient();

    const keys = await redis.keys(`${BATCH_KEY_PREFIX}*`);
    let activeCount = 0;

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        try {
          const meta = JSON.parse(data) as BatchMetadata;
          if (meta.state === "active" || meta.state === "waiting") {
            activeCount++;
          }
        } catch {
          // 不正データはスキップ
        }
      }
    }

    return activeCount;
  } catch {
    return 0;
  }
}

/**
 * バッチメタデータをRedisに保存 / Save batch metadata to Redis
 */
async function saveBatchMetadata(
  _queue: ReturnType<typeof createPageAnalyzeQueue>,
  batchId: string,
  data: Omit<BatchMetadata, "state">
): Promise<void> {
  try {
    const redis = getRedisClient();

    const metadata: BatchMetadata = {
      ...data,
      state: "active",
    };

    await redis.setex(`${BATCH_KEY_PREFIX}${batchId}`, BATCH_TTL_SECONDS, JSON.stringify(metadata));
  } catch (error) {
    logger.warn("[page.batch_analyze] Failed to save batch metadata", {
      error: (error as Error).message,
    });
  }
}
