// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025-2026 Reftrix contributors

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

import { Queue, QueueEvents, type ConnectionOptions } from "bullmq";
import { v5 as uuidv5 } from "uuid";
import { getRedisConfig, type RedisConfig } from "../config/redis";
import { getAuditLogService } from "../services/audit-log.service";
import { logger } from "../utils/logger";
import { sanitizeAnalysisErrorForClient, sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import { normalizeUrlForValidation } from "../utils/url-validator";
import { enqueueWithCollisionGuard, type EnqueueResult } from "./enqueue-with-collision-guard";

/**
 * Queue name constant
 */
export const PAGE_ANALYZE_QUEUE_NAME = "page-analyze";

/**
 * Predefined RFC 4122 URL namespace (`uuid` package `v5.URL`,
 * `6ba7b811-9dad-11d1-80b4-00c04fd430c8`) used as the fixed seed for the
 * page.analyze URL-stable jobId (ADR-0018 Amendment 11). No bespoke magic UUID
 * is fabricated; the RFC 4122 URL namespace is reused so the derived jobId is a
 * valid RFC 4122 v5 UUID that passes the existing `z.string().uuid()` schema
 * gates without relaxation (§Schema-Gate Blast-Radius).
 *
 * ページ解析 URL-stable jobId の固定 seed (ADR-0018 Amendment 11)。新規 magic
 * UUID を捏造せず RFC 4122 URL namespace を再利用するため、導出 jobId は
 * version=5 の valid UUID となり既存の `z.string().uuid()` gate を relaxation
 * 無しで通過する。
 */
const UUID_NAMESPACE_PAGE_ANALYZE_URL = uuidv5.URL;

/**
 * Build the URL-stable jobId for page.analyze (ADR-0018 Amendment 11, Strategy A).
 *
 * `buildUrlStableJobId(url) = uuidv5(normalizeUrlForValidation(url), v5.URL)`.
 * Same normalized URL → same UUIDv5 (deterministic), so near-concurrent
 * same-URL submits share one BullMQ jobId and the collision-guard helper
 * resolves losers to the incumbent (`reused_active`) instead of spawning
 * duplicate jobs. The result is a valid RFC 4122 v5 UUID (version field = 5),
 * so it passes `z.string().uuid()` / MCP `format:"uuid"` unchanged.
 *
 * `normalizeUrlForValidation` is re-derived here (single derivation point,
 * zero threading): `data.url` already reaches the helper, so callsites need no
 * signature change. The function is pure-deterministic (`url-validator.ts:367`),
 * so caller-precomputed and helper-rederived values are identical.
 *
 * ページ解析 BullMQ jobId を URL 派生 stable UUIDv5 に統一する helper。同一
 * 正規化 URL → 同一 UUIDv5 のため、近接多重 same-URL submit が単一 jobId を
 * 共有し collision-guard が敗者を incumbent (`reused_active`) に解決する。結果は
 * RFC 4122 version=5 の valid UUID で、既存 schema gate を無改変で通過する。
 *
 * @param url - Raw target URL (helper re-derives normalization internally).
 * @returns Deterministic RFC 4122 v5 UUID jobId.
 */
export function buildUrlStableJobId(url: string): string {
  return uuidv5(normalizeUrlForValidation(url), UUID_NAMESPACE_PAGE_ANALYZE_URL);
}

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
 * Valid `AnalysisPhase` enum values, used by {@link extractCurrentPhase} for
 * runtime validation. Mirror of the `AnalysisPhase` type union — kept inline
 * here (instead of `as const` re-export) to avoid widening the public surface.
 *
 * `AnalysisPhase` の有効値リスト。{@link extractCurrentPhase} が実行時検証に使用。
 */
const VALID_ANALYSIS_PHASES: readonly AnalysisPhase[] = [
  "ingest",
  "layout",
  "motion",
  "quality",
  "narrative",
  "responsive",
  "embedding",
];

/**
 * Pure helper: extract a validated `currentPhase` from BullMQ progress data.
 *
 * Defense-in-depth design (C-4 / Plan V1 §3.4):
 * 1. **Prototype pollution defense**: uses `Object.hasOwn()` rather than the
 *    `in` operator so that `__proto__` / `constructor` / `toString` etc. on
 *    the prototype chain are NOT treated as a `currentPhase` carrier. JSON
 *    parsers (BullMQ -> ioredis -> JSON.parse) already place `__proto__` as
 *    a regular own property, but `constructor` from a forged JSON like
 *    `{"constructor": "motion"}` would still satisfy the `in` operator on
 *    the inherited `Object.prototype.constructor` — `Object.hasOwn` closes
 *    that path.
 * 2. **Type-narrow without re-keying**: returns `undefined` when the value
 *    is not a known `AnalysisPhase`, so the caller can fold the result with
 *    a single optional assignment.
 * 3. **Null-safe**: returns `undefined` for non-object / null / array progress.
 *
 * Returns `undefined` (NOT throws) for any non-conforming input. The progress
 * payload originates from a trusted Worker (`job.updateProgress`), but we
 * harden the read path because Redis is a shared boundary.
 *
 * BullMQ progress データから validated な `currentPhase` を抽出する純粋関数。
 * `Object.hasOwn` で prototype 汚染攻撃を遮断、未知 phase 値や非 object 入力は
 * `undefined` を返す（throw しない）。Redis 境界の defense-in-depth。
 *
 * @param progress - `job.progress` value (number | object | null | undefined)
 * @returns Validated `AnalysisPhase` value, or `undefined` if absent/invalid.
 *
 * @example
 * extractCurrentPhase({ overallProgress: 35, currentPhase: "motion" })  // "motion"
 * extractCurrentPhase({ overallProgress: 50 })                          // undefined
 * extractCurrentPhase({ currentPhase: "nonexistent" })                  // undefined
 * extractCurrentPhase(50)                                                // undefined
 * extractCurrentPhase(null)                                              // undefined
 * extractCurrentPhase({ __proto__: { currentPhase: "motion" } })        // undefined
 * extractCurrentPhase({ constructor: "motion" })                        // undefined (constructor is on prototype)
 */
export function extractCurrentPhase(progress: unknown): AnalysisPhase | undefined {
  if (progress === null || progress === undefined || typeof progress !== "object") {
    return undefined;
  }
  // Reject arrays explicitly — `typeof [] === "object"` but arrays are not
  // valid progress carriers.
  if (Array.isArray(progress)) {
    return undefined;
  }
  // `Object.hasOwn` (ES2022) is the canonical own-property check. It does NOT
  // traverse the prototype chain, so `__proto__` / `constructor` injections
  // cannot trick the carrier check (Statement 1 / SEC S-2).
  if (!Object.hasOwn(progress as object, "currentPhase")) {
    return undefined;
  }
  const phaseValue = (progress as Record<string, unknown>)["currentPhase"];
  if (typeof phaseValue !== "string") {
    return undefined;
  }
  // Runtime allowlist check — narrows to AnalysisPhase only for known values.
  return (VALID_ANALYSIS_PHASES as readonly string[]).includes(phaseValue)
    ? (phaseValue as AnalysisPhase)
    : undefined;
}

/**
 * Get job status by ID
 *
 * @param queue - BullMQ Queue instance
 * @param jobId - Job ID (webPageId)
 * @returns Job status or null if not found
 */
// eslint-disable-next-line complexity -- Pre-existing CC=21, FIND-TDA-07 Q3-2026 backlog successor issue refactor (PR-D-6 IO spot decision 019db5a5-b84d-71cd-a198-95f9c8c1cbb7 Option A scope)
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
  // C-4 (Plan V1 §3.4): delegate to {@link extractCurrentPhase} which provides
  // prototype-pollution defense (Object.hasOwn, not `in`) + allowlist validation.
  // Worker から送られる progress object から currentPhase を抽出。
  // {@link extractCurrentPhase} は Object.hasOwn による prototype 汚染防御 + 許容値検証。
  const extractedPhase = extractCurrentPhase(job.progress);
  if (extractedPhase !== undefined) {
    status.currentPhase = extractedPhase;
  }
  if (state === "completed" && job.returnvalue) {
    status.result = job.returnvalue;
  }
  if (state === "failed" && job.failedReason) {
    // Plan v3 Track T4 SEC L-03 / CO-T4-02: sanitise BullMQ failedReason to
    // client-safe `analysis_pipeline_interrupted` for T4 reasons; pass-through
    // for non-T4 reasons. Defense-in-depth at queue boundary (in addition to
    // page.getJobStatus tool boundary). CWE-209 information exposure.
    // Plan v3 T4 SEC L-03: BullMQ `failedReason` 生暴露を queue 境界で sanitise。
    // T4 reason は client-safe literal に 1:1 mapping。非 T4 は pass-through。
    const sanitised = sanitizeAnalysisErrorForClient(job.failedReason);
    if (sanitised !== null) {
      status.error = sanitised;
    }
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

// ============================================================================
// PR-D-6 Phase 2: Collision-guarded enqueue (observability-only scope)
// ============================================================================

/**
 * Redis key namespace for the atomic SETNX jobId claim of the page-analyze
 * queue. Expands to `reftrix:page-analyze:jobclaim:<jobId>` where `<jobId>` is
 * the URL-stable UUIDv5 from `buildUrlStableJobId(data.url)` (ADR-0018
 * Amendment 11, Strategy A) — NOT the per-call `webPageId`.
 *
 * page-analyze queue の atomic SETNX jobId claim の Redis key namespace。
 * `<jobId>` は `buildUrlStableJobId(data.url)` 由来の URL-stable UUIDv5 で
 * あり、per-call `webPageId` ではない (ADR-0018 Amendment 11)。
 */
const PAGE_ANALYZE_CLAIM_KEY_NAMESPACE = "page-analyze";

/**
 * Observability-only audit emitter for page-analyze collisions (Registry v3
 * §3 FIND-TPA-02 binding: `addPageAnalyzeJobWithGuard` scope 縮退 = QueueEvents
 * duplicated listener + audit emit のみ、collision detection path は Plan §2
 * 未特定のため Option A full implementation 不要)。
 *
 * Writes a `page_analyze_collision_resolved` audit row for operational
 * visibility — **not** a schema drift trigger (schema-enum-sync standing
 * regression remains untouched per Registry §4 row 238 continuity).
 *
 * Observability-only audit emitter per Registry v3 §3 FIND-TPA-02 binding.
 * Writes a `page_analyze_collision_resolved` row for visibility only.
 */
async function emitPageAnalyzeCollisionAudit(event: {
  webPageId: string;
  originalJobId: string;
  retryJobId: string;
  originalState: "completed" | "failed";
}): Promise<void> {
  try {
    await getAuditLogService().log({
      action: "page_analyze_collision_resolved",
      actor: "system:page-analyze-queue",
      targetType: "web_page",
      targetId: event.webPageId,
      details: {
        // PII-safe: webPageId is truncated via `utils/truncate-id.ts:17 truncateId` SSOT.
        webPageId: truncateId(event.webPageId, 8),
        // ADR-0018 Amendment 11: the originalJobId is the URL-stable UUIDv5
        // (`buildUrlStableJobId`) and the retryJobId is `<uuidv5>__retry_<uuidv7>`.
        // Both are truncated through the same truncateId(8) SSOT so only a
        // 32-bit UUIDv5 fragment lands in details (no raw URL) — symmetric
        // PII guard (LCC-RV1-L-02 / SEC-RV2-L-03, GDPR Art.30 audit trail).
        originalJobId: truncateId(event.originalJobId, 8),
        retryJobId: truncateId(event.retryJobId.split("__retry_")[0] ?? event.retryJobId, 8),
        originalState: event.originalState,
        timestamp: new Date().toISOString(),
      },
      result: "success",
    });
  } catch (err) {
    // Observability-only path: audit failure never blocks the retry enqueue.
    logger.warn("[PageAnalyzeQueue] collision audit emit failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}

/**
 * Collision-guarded enqueue (observability-only scope) for page-analyze jobs.
 *
 * Registry v3 Binding 3 (secondary, FIND-TPA-02 observability-only scope):
 * atomic SETNX Lua claim + 5 sub-handler dispatch via the shared
 * {@link enqueueWithCollisionGuard} generic helper. Retry jobId = `<webPageId>__retry_<uuidv7>`;
 * observability-only audit emit via {@link emitPageAnalyzeCollisionAudit}.
 *
 * Call site migration (legacy addPageAnalyzeJob → this helper) is
 * owned by backend-api-developer per Registry v3 Binding 3 secondary scope
 * and is intentionally **not** performed here.
 *
 * Observability-scoped collision-guarded enqueue for page-analyze. Mirrors the
 * backfill helper but emits a dedicated `page_analyze_collision_resolved`
 * audit row for operational visibility.
 *
 * @param queue - BullMQ Queue instance
 * @param data - Job data (without createdAt — filled in here)
 * @param priority - Job priority (lower = higher priority, default 10)
 * @returns {@link EnqueueResult} discriminated by `outcome`
 */
export async function addPageAnalyzeJobWithGuard(
  queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult>,
  data: Omit<PageAnalyzeJobData, "createdAt">,
  priority: number = 10
): Promise<EnqueueResult> {
  const jobData: PageAnalyzeJobData = {
    ...data,
    createdAt: new Date().toISOString(),
  };

  // ADR-0018 Amendment 11 (Strategy A): the BullMQ jobId is the URL-stable
  // UUIDv5 (`buildUrlStableJobId(data.url)`), NOT the per-call `data.webPageId`.
  // This makes near-concurrent same-URL submits share one jobId so the
  // collision guard routes losers to the incumbent (`reused_active`). The
  // payload keeps `data.webPageId` as a per-call UUIDv7 — the worker reads
  // `job.data.webPageId` for the web_pages FK (`page-analyze-worker.ts:1508`),
  // so DB writes are unaffected by the jobId change.
  return await enqueueWithCollisionGuard<PageAnalyzeJobData, PageAnalyzeJobResult>({
    queue,
    queueName: PAGE_ANALYZE_QUEUE_NAME,
    jobId: buildUrlStableJobId(data.url),
    data: jobData,
    jobOptions: { priority },
    claimKeyNamespace: PAGE_ANALYZE_CLAIM_KEY_NAMESPACE,
    webPageId: data.webPageId,
    auditEmitter: emitPageAnalyzeCollisionAudit,
  });
}

/**
 * Register the observability-only `"duplicated"` event listener on a
 * page-analyze {@link QueueEvents} instance.
 *
 * Registry v3 FIND-TPA-02 binding (observability-only scope absorb from Plan
 * §3.3 Option C): emits a `logger.warn` for every duplicated-jobId event as a
 * secondary evidence stream correlated with `page_analyze_collision_resolved`
 * audit rows.
 *
 * Registers an observability-only `"duplicated"` listener on the page-analyze
 * QueueEvents instance. Emits `logger.warn` on each duplicated-jobId event as
 * correlated evidence for `page_analyze_collision_resolved` audit rows.
 *
 * @param queueEvents - BullMQ QueueEvents instance for the page-analyze queue
 * @returns The same QueueEvents instance for fluent chaining.
 */
export function registerPageAnalyzeDuplicatedListener(queueEvents: QueueEvents): QueueEvents {
  queueEvents.on("duplicated", ({ jobId }) => {
    logger.warn("[PageAnalyzeQueue] QueueEvents.duplicated fired", {
      // PII-safe: truncate webPageId-shaped jobId via `truncateId` SSOT.
      jobId: truncateId(jobId, 8),
    });
  });
  return queueEvents;
}
