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

import { Queue, QueueEvents, type Job, type ConnectionOptions } from "bullmq";
import { getRedisConfig, type RedisConfig } from "../config/redis";

/**
 * Queue name constant
 */
export const PAGE_ANALYZE_QUEUE_NAME = "page-analyze";

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
    /** Enable frame image analysis (pixelmatch diff). Only effective when enableFrameCapture=true. @default false */
    analyzeFrames?: boolean;
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
  /** Responsive analysis options */
  responsiveOptions?: {
    enabled?: boolean;
    viewports?: Array<{ name: string; width: number; height: number }>;
    include_screenshots?: boolean;
    include_diff_images?: boolean;
    diff_threshold?: number;
    save_to_db?: boolean;
    detect_navigation?: boolean;
    detect_visibility?: boolean;
    detect_layout?: boolean;
  };
  /** Part extraction options (Phase 1.1) */
  partExtractionOptions?: {
    /** Enable part extraction (default: true) */
    enabled?: boolean;
    /** RSS memory limit in bytes. Skip if exceeded (default: 8GB) */
    rssLimitBytes?: number;
    /** Independent timeout in ms (default: 30000) */
    timeoutMs?: number;
  };
  /** Whether to respect robots.txt (default: true) */
  respectRobotsTxt?: boolean;
  /** Accessibility audit options (Phase 7.5a, opt-in, default: disabled) */
  accessibilityOptions?: {
    enabled?: boolean;
    level?: "A" | "AA" | "AAA";
    include_contrast?: boolean;
    save_to_db?: boolean;
  };
  /** Performance evaluation options (Phase 7.5b, opt-in, default: disabled) */
  performanceOptions?: {
    enabled?: boolean;
    include_screenshots?: boolean;
    budget?: Record<string, number>;
    save_to_db?: boolean;
  };
  /** Auto-create design snapshot after analysis completion (v0.3.0 T2-DCT, default: false) */
  autoSnapshot?: boolean;
}

/**
 * 非同期 backfill 残件情報 — `source` discriminated union（PR7b v0.4.0 / ADR-0008 #7）。
 * Pending counts for async backfill — discriminated by `source` (PR7b v0.4.0 / ADR-0008 #7).
 *
 * MCP response `results.embedding.backfillPending` に埋め込まれる。`source`
 * により意味が異なる:
 * - `sync_overflow` (PR5 v0.4.0): Phase 5 が `part_text` / `part_visual` の
 *   同期処理上限（100 件）を超えた際に、残余を `embedding-backfill` Queue に
 *   投入した場合。`partTextPending` / `partVisualPending` で残件数を示す。
 * - `skip_recovery` (PR7b v0.4.0): Phase 5 全体が memory pressure / fork 失敗で
 *   スキップされ、全 7 カテゴリ（part_text / part_visual / section_visual / motion /
 *   background / js_animation / responsive）を recovery enqueue した場合。
 *
 * ADR-0008 Semantics Table に基づき、`sync_overflow` と `skip_recovery` の
 * 両方が同時に立つことはない（Phase 5 が途中まで成功した場合は `sync_overflow`、
 * 全体 skip の場合は `skip_recovery`）。
 *
 * Embedded in MCP response `results.embedding.backfillPending`. Semantics vary
 * by `source`:
 * - `sync_overflow` (PR5 v0.4.0): When Phase 5 exceeded the sync cap (100) for
 *   `part_text` / `part_visual` and enqueued the tail onto `embedding-backfill`.
 * - `skip_recovery` (PR7b v0.4.0): When Phase 5 was entirely skipped (memory
 *   pressure / fork failure) and all 7 categories were enqueued for recovery.
 *
 * Per ADR-0008 Semantics Table, `sync_overflow` and `skip_recovery` are never
 * both present at the same time.
 */
export type EmbeddingBackfillPending =
  | EmbeddingBackfillPendingSyncOverflow
  | EmbeddingBackfillPendingSkipRecovery;

/**
 * `sync_overflow` ソース — Phase 5 が 100 件閾値を超過し、残余を async backfill
 * に回した場合（PR5 v0.4.0）。
 *
 * `sync_overflow` source — Phase 5 exceeded the 100-item sync cap and tailed
 * the remainder to async backfill (PR5 v0.4.0).
 */
export interface EmbeddingBackfillPendingSyncOverflow {
  /** Discriminator: sync_overflow = 100件閾値超過による async backfill */
  source: "sync_overflow";
  /** Number of part_text embeddings queued for async backfill */
  partTextPending: number;
  /** Number of part_visual embeddings queued for async backfill */
  partVisualPending: number;
  /**
   * v0.4.0 PR7e-α (バグ⑥): section_visual の backfill pending 件数。
   * Backward-compat のため optional。未 enqueue / count 不明時は undefined。
   *
   * v0.4.0 PR7e-α (bug ⑥): section_visual backfill pending count. Optional
   * for backward compatibility; undefined when not enqueued or unknown.
   */
  sectionVisualPending?: number;
  /**
   * BullMQ job IDs for tracking (`<webPageId>__<category>`).
   * 追跡用 BullMQ job ID 一覧。
   */
  jobIds: string[];
  /**
   * Estimated completion ISO timestamp (best-effort, 5s/item heuristic).
   * 推定完了時刻（ISO 8601、件数 × 平均 5 秒/件のベストエフォート）。
   */
  estimatedCompletionAt?: string;
}

/**
 * `skip_recovery` ソース — Phase 5 全体 skip 時の recovery backfill（PR7b v0.4.0 /
 * ADR-0008 #2）。
 *
 * `skip_recovery` source — recovery backfill for full Phase 5 skip (PR7b v0.4.0 /
 * ADR-0008 #2).
 */
export interface EmbeddingBackfillPendingSkipRecovery {
  /** Discriminator: skip_recovery = Phase 5 全体 skip からの recovery */
  source: "skip_recovery";
  /**
   * Phase 5 がスキップされた原因（`EmbeddingSkipReason` の値）。
   * memory pressure / fork 失敗などを MCP client に提示し、運用判断に用いる。
   *
   * Cause of Phase 5 skip (value from `EmbeddingSkipReason`). Surfaces
   * memory pressure / fork failures to MCP clients for ops decisions.
   */
  skipReason: string;
  /**
   * 実際に enqueue したカテゴリ一覧。screenshot 不在時は screenshot 必須の
   * カテゴリ（part_visual / section_visual）が除外されるため、最大 7 / 最小 0。
   *
   * Categories actually enqueued. When no screenshot exists, screenshot-required
   * categories (part_visual / section_visual) are excluded — so range is 0..7.
   */
  enqueuedCategories: string[];
  /**
   * この recovery 試行後の retry count（CAS guard で increment 済み）。
   * `SKIP_RECOVERY_RETRY_CAP`（5）を超えた場合 backfillStatus=failed に遷移し、
   * `backfillPending` は返されない。
   *
   * Retry count after this recovery attempt (incremented by the CAS guard).
   * Once it exceeds `SKIP_RECOVERY_RETRY_CAP` (5), backfillStatus → failed and
   * no `backfillPending` is surfaced.
   */
  retryCount: number;
  /**
   * recovery enqueue 時刻（ISO 8601）。
   * Timestamp of recovery enqueue (ISO 8601).
   */
  enqueuedAt: string;
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
      /** DINOv2 section visual embedding生成数 / DINOv2 section visual embeddings generated */
      sectionVisualEmbeddingsGenerated?: number | undefined;
      motionEmbeddingsGenerated?: number | undefined;
      backgroundDesignEmbeddingsGenerated?: number | undefined;
      jsAnimationEmbeddingsGenerated?: number | undefined;
      responsiveEmbeddingsGenerated?: number | undefined;
      partEmbeddingsGenerated?: number | undefined;
      /** DINOv2 part visual embedding生成数 / DINOv2 part visual embeddings generated */
      partVisualEmbeddingsGenerated?: number | undefined;
      /**
       * Phase 5 がスキップされた理由（PR2 v0.4.0）。`EmbeddingSkipReason` enum 値。
       * v0.4.0 PR2 審査 (TDA LOW 3): 内部型 `EmbeddingPhaseResult.skipReason` と
       * MCP response 側の命名を `skipReason` に統一する（旧 `skippedReason` は廃止）。
       *
       * Reason Phase 5 was skipped (PR2 v0.4.0). One of the `EmbeddingSkipReason`
       * values. v0.4.0 PR2 audit (TDA LOW 3): unified naming — internal
       * `EmbeddingPhaseResult.skipReason` and the MCP response field both use
       * `skipReason` (legacy `skippedReason` removed).
       * MCP クライアントはこの値を監視することでサイレント skip を検知できる。
       * MCP clients can watch this field to detect silent skips.
       */
      skipReason?: string | undefined;
      /**
       * `skipReason` の補足情報（閾値・数値のみ、PII 含まず）。
       * 最大長は `SKIP_DETAIL_MAX_LENGTH` (200 文字) で保証される。
       * Additional context for `skipReason` (thresholds/numbers only, no PII).
       * Length is bounded by `SKIP_DETAIL_MAX_LENGTH` (200 chars).
       */
      skipDetail?: string | undefined;
      /**
       * 非同期 backfill に回された残件情報（PR5 v0.4.0）。
       * Async backfill pending info (PR5 v0.4.0).
       *
       * 100 件閾値超過で `embedding-backfill` Queue に投入された場合のみ
       * 設定される。100 件以下では undefined（従来通り同期完了）。
       * Populated only when the 100-item threshold triggered a backfill
       * enqueue; undefined otherwise (sync-complete happy path).
       */
      backfillPending?: EmbeddingBackfillPending | undefined;
    };
    partExtraction?: {
      sectionsProcessed: number;
      totalPartsExtracted: number;
      totalPartsSaved: number;
      durationMs: number;
    };
    responsive?: {
      differencesDetected: number;
      breakpointsDetected: number;
      viewportsAnalyzed: Array<{ name: string; width: number; height: number }>;
      analysisTimeMs: number;
      responsiveAnalysisId?: string;
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
export type AnalysisPhase =
  | "ingest"
  | "layout"
  | "motion"
  | "quality"
  | "narrative"
  | "responsive"
  | "embedding";

/**
 * Job status for polling
 */
export interface PageAnalyzeJobStatus {
  /** Job ID */
  jobId: string;
  /** Current state */
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
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
 * Convert RedisConfig to BullMQ ConnectionOptions for Queue / QueueEvents.
 *
 * BullMQ requires `maxRetriesPerRequest: null` for Queue / QueueEvents /
 * Worker connections (per https://docs.bullmq.io/guide/connections and
 * taskforcesh/bullmq#2466). We override unconditionally to null here so that
 * a misconfigured `REDIS_MAX_RETRIES_PER_REQUEST` env var cannot silently
 * break delayed-job pickup for the page-analyze queue.
 *
 * BullMQ は Queue/QueueEvents/Worker 接続で `maxRetriesPerRequest: null` を公式必須
 * とする。env var が誤設定されても delayed job pickup が停止しないよう、ここでは
 * 無条件に null を強制する。
 */
function toConnectionOptions(config: RedisConfig): ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: null,
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
        type: "exponential",
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
export function createQueueEvents(configOverrides?: Partial<RedisConfig>): QueueEvents {
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
  data: Omit<PageAnalyzeJobData, "createdAt">,
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
  const progress =
    typeof job.progress === "number"
      ? job.progress
      : typeof job.progress === "object" &&
          job.progress !== null &&
          "overallProgress" in job.progress
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
  if (state === "completed" && job.finishedOn !== undefined) {
    timestamps.completed = job.finishedOn;
  }
  if (state === "failed" && job.finishedOn !== undefined) {
    timestamps.failed = job.finishedOn;
  }

  // Build result object, only including defined optional properties
  const status: PageAnalyzeJobStatus = {
    jobId: job.id || jobId,
    state: state as PageAnalyzeJobStatus["state"],
    progress,
    timestamps,
  };

  // Determine currentPhase from job progress data (set by Worker via job.updateProgress)
  // The Worker sends an object with { overallProgress, currentPhase, phases, ... }
  if (typeof job.progress === "object" && job.progress !== null && "currentPhase" in job.progress) {
    const phaseFromProgress = (job.progress as { currentPhase: string }).currentPhase;
    // Validate that it's a known AnalysisPhase
    const validPhases: readonly string[] = [
      "ingest",
      "layout",
      "motion",
      "quality",
      "narrative",
      "responsive",
      "embedding",
    ];
    if (validPhases.includes(phaseFromProgress)) {
      status.currentPhase = phaseFromProgress as AnalysisPhase;
    }
  }
  if (state === "completed" && job.returnvalue) {
    status.result = job.returnvalue;
  }
  if (state === "failed" && job.failedReason) {
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
