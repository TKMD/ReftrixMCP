// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - BullMQ Worker for Async Page Analysis
 *
 * Phase3-2: Handles heavy page analysis jobs asynchronously.
 * Designed for WebGL-heavy sites (Linear, Vercel, Notion) that may timeout
 * in synchronous processing.
 *
 * Configuration:
 * - concurrency: 1 (singleton browser, avoid race condition)
 * - lockDuration: 2400000ms (40 min, extended for CPU-bound embedding phase), configurable via BULLMQ_LOCK_DURATION
 * - attempts: 1 (no retries for WebGL sites)
 *
 * Lock Extension Strategy (Hybrid Approach):
 * BullMQ v5.x provides automatic lock renewal via lockRenewTime (default: lockDuration/2).
 * However, CPU-bound processing (e.g., Ollama Vision 10.7B) may block the event loop,
 * preventing timer-based renewal. This module adds:
 * 1. createLockExtender: setInterval-based periodic lock extension (secondary protection)
 * 2. extendJobLock: explicit lock extension at async phase boundaries
 * Together they provide dual-layer stall prevention for long-running jobs (30+ minutes).
 *
 * Architecture (v0.3.0+, Phase 1/3 sequential):
 * This file is a thin orchestrator. Phase logic lives in ./phases/:
 *   phase-0-ingest.ts  — HTML ingest + WebPage DB save
 *   phase-1-layout.ts  — Layout Analysis + Part Extraction        ┐ sequential
 *   phase-3-quality.ts — Quality Evaluation                       ┘ (Layout → Quality)
 *   phase-2-motion.ts  — Scroll Vision + Motion Detection + Scroll Vision Analysis
 *   phase-4-narrative.ts — Narrative Analysis + Responsive Analysis
 *   phase-5-embedding.ts — Embedding Generation (text + visual)
 * Shared types/constants/helpers are in ./phases/types.ts.
 *
 * Note: Phase 1/3 were parallelized via Promise.all in v0.2.0, but changed to
 * sequential execution in v0.3.0. Quality P50=0.02ms makes parallelism pointless,
 * and sequential execution improves memory efficiency by avoiding dual allocation.
 *
 * Environment Variables:
 * - BULLMQ_LOCK_DURATION: Lock duration in ms (default: 2400000)
 * - BULLMQ_LOCK_EXTEND_INTERVAL_MS: Lock extend interval in ms (default: 300000)
 *
 * @module workers/page-analyze-worker
 */

import { Worker, type Job } from "bullmq";
import { getRedisConfig } from "../config/redis";
import {
  PAGE_ANALYZE_QUEUE_NAME,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type AnalysisPhase,
} from "../queues/page-analyze-queue";
import { ExecutionStatusTrackerV2 } from "../tools/page/handlers/execution-status-tracker";
import { logger, isDevelopment } from "../utils/logger";
import { prisma } from "@reftrixmcp/database";

// Service handlers (same as used in page.analyze synchronous mode)
import { defaultAnalyzeLayout } from "../tools/page/handlers/layout-handler";
import { defaultDetectMotion } from "../tools/page/handlers/motion-handler";
import { defaultEvaluateQuality } from "../tools/page/handlers/quality-handler";
import { pageIngestAdapter } from "../services/page-ingest-adapter";
import { saveBackgroundDesigns } from "../services/background/background-design-db.service";
import { handleNarrativeAnalysis } from "../tools/page/handlers/narrative-handler";
import { createSnapshot as createDesignSnapshot } from "../services/design-change-tracker.service";
// Phase 7.5: Accessibility + Performance (v0.3.0)
import {
  handleAccessibilityPhase,
  handlePerformancePhase,
} from "../tools/page/handlers/sync-phase-handlers-tier2";
// Scroll Vision Smart Capture
import { captureScrollPositions } from "../services/vision/scroll-vision-capture.service";
import { analyzeScrollCaptures } from "../services/vision/scroll-vision.analyzer";
import { saveScrollVisionResults } from "../services/vision/scroll-vision-persistence.service";
// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え
import { GpuResourceManager, gpuModeSignal } from "../services/gpu-resource-manager";
// Responsive Analysis
import { responsiveAnalysisService, responsivePersistenceService } from "../services/responsive";
import { validateExternalUrl } from "../utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
// EmbeddingService singleton for GPU provider switching (switchProvider/releaseGpu)
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
// DB保存ロジック（SectionPattern, MotionPattern, QualityEvaluation, JSAnimationPattern）
import {
  saveSectionPatterns,
  saveMotionPatterns,
  saveQualityEvaluation,
  saveQualityBenchmarks,
  buildQualityBenchmarkInputs,
  saveJsAnimationPatterns,
} from "../services/worker-db-save.service";
// Section Merge/Split Post-Processor（過剰分割修正 + 巨大セクション再分割）
import { postProcessSections } from "../services/page/section-postprocessor.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// Embedding generation (reuse from synchronous flow)
import {
  setBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  setMotionLayoutEmbeddingServiceFactory,
} from "../tools/page/handlers/embedding-handler";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../services/layout-embedding.service";
import { setFramePrismaClientFactory } from "../services/motion/frame-embedding.service";

// Worker Memory Self-Monitoring（OOM防止用）
// v0.4.0 PR7c: applyPostJobMemoryGate が memory check を内包するため
// performMemoryCheckAndExit の直接参照は削除。
// v0.4.0 PR7c: Direct import removed — memory check is now performed inside
// applyPostJobMemoryGate.
// Part Extraction (Phase 1.1)
import { extractPartsFromSection } from "../services/part/part-extraction.service";
import { saveExtractedParts } from "../services/part/part-db.service";
// Dynamic memory thresholds: lazy initialization via initMemoryConstants()
// Stall recovery: BullMQ stalled event handler + periodic check
import {
  handleStalledJob,
  recoverOrphanedJobs,
  createPeriodicStallCheck,
  type OrphanedJobInfo,
  type StalledJobAccessor,
} from "../services/worker-stall-recovery.service";
import { createPageAnalyzeQueue } from "../queues/page-analyze-queue";
// SEC-M2: 安全な環境変数パース
import { safeParseInt } from "../utils/safe-parse-int";
// Frame Analysis DB保存ヘルパー（同期/非同期モード共有）
import { saveFrameAnalysisToDb } from "../services/motion/frame-analysis-save.helper";
// PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged)
// W0 で URL を正規化するため同じ util を再利用する。
// PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged).
// W0 uses the same URL normalizer as W1 for deterministic upsert keys.
import { normalizeUrlForStorage } from "../utils/url-normalizer";

// ============================================================================
// Phase Module Imports (TDA-C1 refactoring)
// ============================================================================
import {
  type PipelineState,
  type PhaseContext,
  type PageAnalyzeWorkerOptions,
  type PageAnalyzeWorkerInstance,
  type EmbeddingSkipReason,
  PHASE_PROGRESS,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_EXTEND_INTERVAL,
  DEFAULT_CONCURRENCY,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  EMBEDDING_CHUNK_SIZE,
  initMemoryConstants,
  checkMemoryPressure,
  tryGarbageCollect,
  createLockExtender,
  extendJobLock,
  createPhaseProgressInterpolator,
  generateJsAnimationTextRepresentation,
  unloadOllamaVisionModel,
  truncateSkipDetail,
} from "./phases/types";
import { processIngestPhase } from "./phases/phase-0-ingest";
// v0.4.0 PR7e-α (バグ④ fix): PhasedDbHandler で analysisPhaseStatus /
// analysisStartedAt を遷移させる。従来は page-analyze-worker が直接
// analysisStatus 等を update していたため、Product API が必要とする
// `analysis_phase_status` / `analysis_started_at` カラムが常に pending /
// null のままだった。
// v0.4.0 PR7e-α (bug ④ fix): integrate PhasedDbHandler so
// `analysis_phase_status` / `analysis_started_at` advance correctly (they
// used to remain `pending` / NULL forever because the inline update path
// only touched `analysis_status` / `analysis_completed_at`).
import { PhasedDbHandler } from "../tools/page/handlers/phased-db-handler";
import { createScreenshotPersistenceService } from "../services/screenshot-persistence.service";
import { applyPostJobMemoryGate } from "./shared/post-job-lifecycle";
import { processLayoutPhase } from "./phases/phase-1-layout";
import { processMotionPhase } from "./phases/phase-2-motion";
import { processQualityPhase } from "./phases/phase-3-quality";
import { processNarrativePhase } from "./phases/phase-4-narrative";
import { dispatchEmbeddingPhase } from "./phases/phase-5-embedding";

// v0.4.0 PR4: Queue-based backfill for Part text / visual embedding overflow
// v0.4.0 PR4: 100 件を超える Part embedding をキュー経由で非同期バックフィル
//
// v0.4.0 PR7b: Skip recovery 経路で全 7 カテゴリを enqueue するため SSOT 配列
// `EMBEDDING_BACKFILL_CATEGORIES` と back-pressure / memory_pressure delay の
// ヘルパーを追加 import する。
//
// v0.4.0 PR7b: Adds the SSOT array `EMBEDDING_BACKFILL_CATEGORIES`,
// back-pressure check, and memory-pressure delay resolver for the skip-recovery
// path that enqueues all 7 categories.
import {
  createEmbeddingBackfillQueue,
  addEmbeddingBackfillJobWithGuard,
  checkBackfillQueueBackPressure,
  resolveMemoryPressureDelayMs,
  EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
  SKIP_RECOVERY_RETRY_CAP,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";
import { enqueueAllCategoriesForSkipRecovery } from "../queues/embedding-backfill-processors";
import type { Queue } from "bullmq";

// v0.4.0 PR6 TDA TD-1/TD-3: raw count util と backfillPending builder を抽出
// v0.4.0 PR6 TDA TD-1/TD-3: extracted raw count util and backfillPending builder
// v0.4.0 PR7b (ADR-0008 #7): skip_recovery variant の builder も追加
// v0.4.0 PR7b (ADR-0008 #7): also import skip_recovery variant builder
import { countNonNullVector } from "../utils/prisma-raw-count";
import {
  buildBackfillPending,
  buildSkipRecoveryBackfillPending,
  isBackfillPendingSourceConflict,
} from "../services/backfill-pending.builder";

// v0.4.0 PR7b: Phase 5 親 RSS upstream guard
// v0.4.0 PR7b: Phase 5 parent RSS upstream guard
import { loadPhase5Config } from "../config/phase5-config";

// v0.4.0 PR7b: retry cap 超過時の audit log
// v0.4.0 PR7b: audit log when retry cap is exceeded
import { getAuditLogService } from "../services/audit-log.service";

// ============================================================================
// Embedding DI factories initialization
// ============================================================================
// Worker runs in a separate process; factories must be set before use
// Single shared ONNX session to prevent memory leak from repeated LayoutEmbeddingService creation
// P0-1: All embedding sub-phases (Section, Motion, Background, JSAnimation) share this singleton
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);

// v0.4.0: Screenshot 永続化サービスのワーカー内シングルトン
// v0.4.0: Worker-local singleton of the screenshot persistence service
//
// Phase 0（保存）と Phase 5 fork orchestrator（cleanup）の両方から参照される。
// 環境変数 `REFTRIX_SCREENSHOT_ROOT` を内部で解決するため、ここでは prisma のみを注入する。
//
// Shared by Phase 0 (save) and Phase 5 fork orchestrator (cleanup).
// Resolves `REFTRIX_SCREENSHOT_ROOT` internally, so only prisma is injected here.
const screenshotPersistenceService = createScreenshotPersistenceService({
  prisma: prisma as never,
});
setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setBackgroundPrismaClientFactory(() => prisma as never);
setFramePrismaClientFactory(() => prisma as never);

// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え (singleton)
const gpuResourceManager = GpuResourceManager.getInstance();

// ============================================================================
// Post-Job Memory Gate: WORKER_MAX_JOBS_BEFORE_RESTART 駆動の RSS ゲート
// ============================================================================
//
// v0.4.0 PR7e-β2 hotfix で pause/resume 経路は完全削除され、post-job ライフ
// サイクルは「RSS 閾値超過 → process.exit(0)」のみを残した（ADR-0009 参照）。
// `fetchNext=false` の保証は BullMQ 側の `moveToCompleted` Lua スクリプトが
// 担うため、Worker 側で pause を呼ぶ必要はなく、本 gate は concurrency 非依存。
//
// v0.4.0 PR7e-β2 audit carryover: helper を
// `applyPostJobMemoryGate(enabled, loggerPrefix)` にリネームし、使われなくなった
// `workerRef` 引数とモジュール変数 `_workerInstanceRef` を削除した。
//
// v0.4.0 PR7e-β2 hotfix removed the pause/resume path entirely; the post-job
// lifecycle now keeps only the RSS gate ("RSS exceeds threshold → process.exit(0)").
// `fetchNext=false` is already guaranteed by BullMQ's `moveToCompleted` Lua
// script, so no Worker-side pause is needed and this gate is concurrency-neutral.
//
// v0.4.0 PR7e-β2 audit carryover: the helper was renamed to
// `applyPostJobMemoryGate(enabled, loggerPrefix)` and the obsolete `workerRef`
// argument plus the module-level `_workerInstanceRef` variable were removed.
// ============================================================================

/**
 * Whether the post-job memory gate is enabled (maxJobsBeforeRestart > 0).
 * Read from WORKER_MAX_JOBS_BEFORE_RESTART env var (default: 1).
 * When 0, the gate is disabled (unlimited jobs per process).
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

/**
 * PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT feature flag.
 *
 * When `PHASE0_EARLY_INSERT=true`, the orchestrator upserts a minimal
 * `web_pages` row **before** calling `processIngestPhase`. This guarantees
 * that early failures during Phase 0 (robots.txt block / SSRF validation /
 * DNS NXDOMAIN etc.) still produce a DB row, so the failure-path
 * `markAnalysisFailed` → `prisma.webPage.update({where: {id: actualWebPageId}})`
 * does not hit P2025 on a missing row.
 *
 * Default: `false` (opt-in). Legacy behavior: the first DB write is the W1
 * upsert inside `processIngestPhase`, which never runs if Phase 0 throws.
 *
 * `PHASE0_EARLY_INSERT=true` の場合、オーケストレーターは `processIngestPhase`
 * を呼ぶ前に `web_pages` の最小行を upsert する (W0)。これにより Phase 0 の
 * 早期失敗 (robots.txt block / SSRF / DNS NXDOMAIN 等) でも DB 行が残り、
 * failure-path の `markAnalysisFailed` が P2025 で空振りしなくなる。
 *
 * デフォルト: `false` (opt-in)。
 */
function isPhase0EarlyInsertEnabled(): boolean {
  return process.env.PHASE0_EARLY_INSERT === "true";
}

// Connect gpuModeSignal to the @reftrixmcp/ml EmbeddingService singleton.
// When GpuResourceManager requests a provider switch, the ONNX pipeline is
// disposed and re-initialized with the new execution provider (CPU/CUDA).
// We use mlEmbeddingService directly because LayoutEmbeddingService wraps
// IEmbeddingService which doesn't expose switchProvider/releaseGpu.
gpuModeSignal.onProviderSwitch = async (provider: "cpu" | "cuda"): Promise<void> => {
  if (provider === "cuda") {
    await mlEmbeddingService.switchProvider("cuda");
  } else {
    await mlEmbeddingService.releaseGpu();
  }
};

// ============================================================================
// Dynamic Memory Configuration (lazy initialization via initMemoryConstants)
// ============================================================================
// L-3 fix: moved from module-level resolveMemoryConfig() to lazy init.
// Constants in types.ts are updated on first call to initMemoryConstants().
initMemoryConstants();

// ============================================================================
// v0.4.0 PR4: Queue-based Backfill Dispatch
// ============================================================================

/**
 * Part text / visual embedding の同期処理閾値（件数）。
 * これを超えたページでは Phase 5 は先頭 `PART_SYNC_THRESHOLD` 件のみ処理し、
 * 残りは `embedding-backfill` Queue に投入する。
 *
 * Synchronous processing threshold (number of Parts) for Part text / visual
 * embedding. When a page exceeds this, Phase 5 processes only the first
 * `PART_SYNC_THRESHOLD` items and enqueues the remainder on the
 * `embedding-backfill` Queue.
 *
 * 環境変数 `EMBEDDING_SYNC_PART_LIMIT` で上書き可能（10〜1000 の範囲で clamp、
 * デフォルト 100）。TPA #1 (v0.4.0 PR4 audit) によりハードコードから env var
 * 化した。大型ページで同期 100 件を待たずに全件バックフィルへ回したい場合は
 * 10 程度に、オフラインバッチで全件同期処理したい場合は 1000 に設定する。
 *
 * Configurable via `EMBEDDING_SYNC_PART_LIMIT` env var (clamped to 10–1000,
 * default 100). Promoted from hardcoded constant to env var per TPA #1
 * (v0.4.0 PR4 audit). Set to ~10 to push most work to the backfill queue for
 * large pages, or 1000 to keep everything inline in offline batch runs.
 */
const PART_SYNC_THRESHOLD = safeParseInt(process.env["EMBEDDING_SYNC_PART_LIMIT"], 100, {
  min: 10,
  max: 1000,
});

/**
 * PR5 (v0.4.0): MCP response `backfillPending.estimatedCompletionAt` 算出用の
 * 1 件あたり平均処理時間（ms）。実測ではなく best-effort のヒューリスティック。
 *
 * Average per-item processing time (ms) used to estimate
 * `backfillPending.estimatedCompletionAt` in the MCP response (PR5 v0.4.0).
 * Best-effort heuristic — not a measured value.
 *
 * `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` で上書き可能（100〜60000ms で clamp、
 * デフォルト 5000ms）。MCP client がポーリング間隔を決める際の参考値。
 * Configurable via `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` (clamped to
 * 100–60000ms, default 5000ms). Intended as a polling-interval hint for
 * MCP clients.
 */
const BACKFILL_AVG_MS_PER_ITEM = safeParseInt(
  process.env["EMBEDDING_BACKFILL_AVG_MS_PER_ITEM"],
  5000,
  { min: 100, max: 60000 }
);

/**
 * Module-level lazy-initialized backfill queue.
 * Keeping it lazy avoids Redis connections when Queue-based Backfill is not needed.
 *
 * モジュールレベルで遅延初期化するバックフィル Queue。
 * バックフィルが不要な場合は Redis 接続を避けるため lazy にする。
 */
let _backfillQueue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null = null;

function getBackfillQueue(): Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
  if (_backfillQueue === null) {
    _backfillQueue = createEmbeddingBackfillQueue();
  }
  return _backfillQueue;
}

/**
 * Enqueue backfill jobs for the Part categories that exceed the sync threshold.
 *
 * v0.4.0 PR4: Phase 5 完了後に呼ばれ、残余 Part を `embedding-backfill` Queue
 * に投入する。`part_text` と `part_visual` の両方を独立ジョブとして投入し、
 * それぞれ BullMQ の jobId 一意化 (`<webPageId>__<category>`) で重複投入を防ぐ。
 *
 * v0.4.0 PR4: Called after Phase 5 to enqueue remaining Part backfill jobs on
 * the `embedding-backfill` Queue. `part_text` and `part_visual` are enqueued
 * as independent jobs; BullMQ jobId uniqueness (`<webPageId>__<category>`)
 * prevents duplicate enqueue.
 *
 * Graceful Degradation: Queue 投入失敗はメインのジョブ結果に影響させない
 * （warn ログのみ）。
 *
 * @returns 投入したカテゴリのリスト / The list of categories enqueued
 */
async function dispatchBackfillJobsForPage(params: {
  webPageId: string;
  url: string;
  partsSavedCount: number;
  sectionsSavedCount: number;
  screenshotStoragePath?: string | undefined;
}): Promise<EmbeddingBackfillCategory[]> {
  const { webPageId, partsSavedCount, sectionsSavedCount, screenshotStoragePath } = params;
  const enqueued: EmbeddingBackfillCategory[] = [];

  // v0.4.0 PR7e-α (バグ⑥): part_* しか救出できなかった制約を解除し、
  // section_visual も backfill 対象に加える。partsSavedCount<=threshold でも
  // section_visual は独立条件 (sectionsSavedCount>0 + screenshotStoragePath) で
  // 投入する。従来は partsSavedCount <= PART_SYNC_THRESHOLD で早期 return
  // していたため section_visual backfill が起動できなかった。
  //
  // v0.4.0 PR7e-α (bug ⑥): expand beyond part_* by also enqueuing
  // `section_visual` under its own condition (sectionsSavedCount > 0 +
  // persisted screenshot). Previously the early-return on partsSavedCount
  // blocked section_visual enqueue entirely.
  const shouldEnqueueParts = partsSavedCount > PART_SYNC_THRESHOLD;
  const shouldEnqueueSectionVisual = sectionsSavedCount > 0 && screenshotStoragePath !== undefined;
  if (!shouldEnqueueParts && !shouldEnqueueSectionVisual) {
    return enqueued;
  }

  const queue = getBackfillQueue();

  if (shouldEnqueueParts) {
    // part_text は screenshot 不要 — 常に投入可能
    // part_text does not require a screenshot — always enqueue
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    try {
      const result = await addEmbeddingBackfillJobWithGuard(queue, {
        webPageId,
        category: "part_text",
      });
      enqueued.push("part_text");
      if (result.outcome !== "enqueued_new") {
        logger.info("[PageAnalyzeWorker] part_text backfill enqueue outcome", {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: webPageId.slice(0, 8) + "...",
        });
      }
    } catch (error) {
      logger.warn("[PageAnalyzeWorker] Failed to enqueue part_text backfill (non-fatal)", {
        error: sanitizeErrorMessage(error),
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }

    // part_visual は persisted screenshot が必須
    // part_visual requires a persisted screenshot
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    if (screenshotStoragePath) {
      try {
        const result = await addEmbeddingBackfillJobWithGuard(queue, {
          webPageId,
          category: "part_visual",
          screenshotStoragePath,
          requiresBboxResolution: true,
        });
        enqueued.push("part_visual");
        if (result.outcome !== "enqueued_new") {
          logger.info("[PageAnalyzeWorker] part_visual backfill enqueue outcome", {
            outcome: result.outcome,
            collision: result.collision,
            webPageId: webPageId.slice(0, 8) + "...",
          });
        }
      } catch (error) {
        logger.warn("[PageAnalyzeWorker] Failed to enqueue part_visual backfill (non-fatal)", {
          error: sanitizeErrorMessage(error),
          webPageId: webPageId.slice(0, 8) + "...",
        });
      }
    } else if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] No persisted screenshot; skipping part_visual backfill", {
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
  }

  // v0.4.0 PR7e-α (バグ⑥): section_visual を backfill 対象に追加。
  // Queue-based Backfill Worker の SectionVisualProcessor が DINOv2 で
  // vision_embedding を再生成する (PR7b の section_visual 統合を活用)。
  //
  // v0.4.0 PR7e-α (bug ⑥): enqueue section_visual so Queue-based Backfill
  // (SectionVisualProcessor) can regenerate DINOv2 vision_embeddings — the
  // PR7b section_visual integration is leveraged here.
  if (shouldEnqueueSectionVisual && screenshotStoragePath) {
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    try {
      const result = await addEmbeddingBackfillJobWithGuard(queue, {
        webPageId,
        category: "section_visual",
        screenshotStoragePath,
      });
      enqueued.push("section_visual");
      if (result.outcome !== "enqueued_new") {
        logger.info("[PageAnalyzeWorker] section_visual backfill enqueue outcome", {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: webPageId.slice(0, 8) + "...",
        });
      }
    } catch (error) {
      logger.warn("[PageAnalyzeWorker] Failed to enqueue section_visual backfill (non-fatal)", {
        error: sanitizeErrorMessage(error),
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
  }

  // v0.4.0 PR7e-α (TDA 最小 observability): dispatched categories を常時ログ。
  // isDevelopment() ガードは使わない — 本番でも backfill 観測に必要。
  //
  // v0.4.0 PR7e-α (TDA minimum observability): log dispatched categories
  // unconditionally — required for production backfill observability.
  logger.info("[PageAnalyzeWorker] Dispatched backfill categories", {
    webPageId: webPageId.slice(0, 8) + "...",
    categories: enqueued,
    partsSavedCount,
    sectionsSavedCount,
    hasScreenshot: screenshotStoragePath !== undefined,
  });

  return enqueued;
}

// ============================================================================
// v0.4.0 PR7b: Skip Recovery — All-Category Backfill Enqueue
// ============================================================================

/**
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` は
 * `queues/embedding-backfill-queue.ts` の SSOT から import する。
 * 以前はローカル定数として重複していたが、MCP response の
 * `backfillPendingSkipRecoverySchema.retryCount.max` と不整合になるリスクが
 * あったため SSOT 化した。
 *
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` is now imported from
 * the SSOT in `queues/embedding-backfill-queue.ts`. Previously duplicated as a
 * local constant, which created a drift risk against
 * `backfillPendingSkipRecoverySchema.retryCount.max` in the MCP response.
 */

/**
 * Skip recovery 経路 (ADR-0008 #2) — Phase 5 全体 skip 検出時に全 7 カテゴリを
 * `embedding-backfill` Queue へ一括 enqueue する。
 *
 * 流れ / Flow:
 *   1. retry cap (`SKIP_RECOVERY_RETRY_CAP`) 確認 — 超過なら `failed` 固定 + audit log
 *   2. back-pressure (`checkBackfillQueueBackPressure`) 確認 — 超過なら `skipped_*` のまま残し cron 補完
 *   3. CAS guard (`updateMany` WHERE `skipped_*` / `in_progress`) で `queued` 遷移 +
 *      `embeddingBackfillRetryCount` インクリメント
 *   4. 全 7 カテゴリ enqueue（screenshot 必須カテゴリは screenshot path 存在確認）
 *   5. memory_pressure 経路は初期 `delay` を付与（BullMQ exponential backoff は retry 時に独立適用）
 *
 * Skip recovery path (ADR-0008 #2) — bulk-enqueues all 7 categories on the
 * `embedding-backfill` Queue when full Phase 5 skip is detected.
 *
 * Steps:
 *   1. Check retry cap; pin to `failed` + audit log if exceeded
 *   2. Check back-pressure; leave `skipped_*` for cron recovery if exceeded
 *   3. CAS guard transitions to `queued` and increments retry count
 *   4. Enqueue all 7 categories (screenshot-required categories check path)
 *   5. memory_pressure path adds initial `delay`; exponential backoff is applied
 *      independently on retry
 *
 * 戻り値 / Returns:
 * - `enqueuedCategories`: 実際に enqueue したカテゴリ一覧（CAS 失敗 / cap 超過時は空配列）
 *   Categories actually enqueued (empty on CAS failure / retry cap exceeded).
 * - `reason`: 非 enqueue パスの原因（`retry_cap_exceeded` / `cas_failed` 等）。enqueue 成功時は null。
 *   Non-enqueue reason (`retry_cap_exceeded` / `cas_failed` / etc). null on enqueue success.
 * - `retryCountAfter`: CAS increment 後の retry count（enqueue パスのみ有効、それ以外は undefined）。
 *   PR7b (ADR-0008 #7): `backfillPending.skip_recovery.retryCount` に露出するため返却。
 *   Retry count after CAS increment (enqueue path only). PR7b (ADR-0008 #7): returned
 *   so it can be surfaced via `backfillPending.skip_recovery.retryCount`.
 * - `enqueuedAt`: 実際に Queue に投入した時刻（enqueue パスのみ）。
 *   PR7b: response の `enqueuedAt` 用。`memory_pressure` 遅延込みの Queue 投入
 *   トランザクション開始時刻を使う。
 *   Timestamp when enqueue actually occurred (enqueue path only). PR7b: used for
 *   response `enqueuedAt`. Uses the start-of-transaction time including any
 *   memory_pressure initial delay window.
 */
async function dispatchSkipRecoveryBackfill(params: {
  webPageId: string;
  url: string;
  skipReason: EmbeddingSkipReason;
  backfillStatus: "skipped_fork_error" | "skipped_memory_pressure";
  screenshotStoragePath?: string | undefined;
}): Promise<{
  enqueuedCategories: EmbeddingBackfillCategory[];
  reason: string | null;
  retryCountAfter?: number;
  enqueuedAt?: Date;
}> {
  const { webPageId, skipReason, backfillStatus, screenshotStoragePath } = params;

  // -- Step 1: Retry cap (SEC HIGH-1) ----------------------------------------
  let currentRetryCount = 0;
  try {
    const row = await prisma.webPage.findUnique({
      where: { id: webPageId },
      select: { embeddingBackfillRetryCount: true },
    });
    currentRetryCount = row?.embeddingBackfillRetryCount ?? 0;
  } catch (fetchError) {
    logger.warn("[PageAnalyzeWorker] Failed to fetch embeddingBackfillRetryCount", {
      error: sanitizeErrorMessage(fetchError),
      webPageId: webPageId.slice(0, 8) + "...",
    });
    return { enqueuedCategories: [], reason: "retry_count_fetch_failed" };
  }

  if (currentRetryCount >= SKIP_RECOVERY_RETRY_CAP) {
    // 5 回超過: failed 固定 + audit log
    // Exceeded 5 retries: pin to failed + audit log
    try {
      await prisma.webPage.updateMany({
        where: { id: webPageId, embeddingBackfillStatus: { in: [backfillStatus] } },
        data: { embeddingBackfillStatus: "failed", embeddingBackfillStartedAt: null },
      });
    } catch (updateError) {
      logger.warn("[PageAnalyzeWorker] Failed to pin embeddingBackfillStatus to failed", {
        error: sanitizeErrorMessage(updateError),
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
    try {
      await getAuditLogService().log({
        action: "backfill_retry_exhausted",
        actor: "page-analyze-worker",
        targetType: "web_page",
        targetId: webPageId,
        details: {
          retryCount: currentRetryCount,
          retryCap: SKIP_RECOVERY_RETRY_CAP,
          skipReason,
          backfillStatus,
        },
        result: "denied",
      });
    } catch {
      /* audit log 失敗は致命的でない / non-fatal */
    }
    logger.warn("[PageAnalyzeWorker] Skip recovery retry cap exceeded — pinned to failed", {
      webPageId: webPageId.slice(0, 8) + "...",
      retryCount: currentRetryCount,
      retryCap: SKIP_RECOVERY_RETRY_CAP,
    });
    return { enqueuedCategories: [], reason: "retry_cap_exceeded" };
  }

  // -- Step 2: Back-pressure (SEC HIGH-2) ------------------------------------
  const queue = getBackfillQueue();
  const backPressure = await checkBackfillQueueBackPressure(queue);
  if (!backPressure.allowEnqueue) {
    logger.warn("[PageAnalyzeWorker] Back-pressure exceeded; leaving skipped_* for cron recovery", {
      webPageId: webPageId.slice(0, 8) + "...",
      waitingCount: backPressure.waitingCount,
      cap: EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
    });
    return { enqueuedCategories: [], reason: "back_pressure_exceeded" };
  }

  // -- Step 3: CAS guard — skipped_* → queued + retry count increment --------
  // ADR-0008 #9: WHERE で skipped_fork_error / skipped_memory_pressure / in_progress
  // を許可。Worker 即時 enqueue と cron 補完の race を optimistic concurrency で解決。
  // ADR-0008 #9: WHERE permits skipped_* and in_progress; resolves race between
  // immediate Worker enqueue and cron recovery via optimistic concurrency.
  let casOk = false;
  try {
    const updated = await prisma.webPage.updateMany({
      where: {
        id: webPageId,
        embeddingBackfillStatus: {
          in: ["skipped_fork_error", "skipped_memory_pressure", "in_progress"],
        },
      },
      data: {
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: new Date(),
        embeddingBackfillRetryCount: { increment: 1 },
      },
    });
    casOk = updated.count > 0;
  } catch (casError) {
    logger.warn("[PageAnalyzeWorker] CAS guard failed for skip recovery transition", {
      error: sanitizeErrorMessage(casError),
      webPageId: webPageId.slice(0, 8) + "...",
    });
    return { enqueuedCategories: [], reason: "cas_failed" };
  }

  if (!casOk) {
    // 別 worker / cron が先に遷移済み（skipped_* → queued/in_progress）。
    // Another worker / cron already transitioned (skipped_* → queued/in_progress).
    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] CAS guard skipped — concurrent transition detected", {
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
    return { enqueuedCategories: [], reason: "concurrent_transition" };
  }

  // -- Step 4: Enqueue all 7 categories --------------------------------------
  // memory_pressure 経路は初期 delay を付与（OS にメモリ回収猶予を与える）
  // memory_pressure path adds initial delay (gives OS time to reclaim memory)
  const initialDelayMs =
    backfillStatus === "skipped_memory_pressure" ? resolveMemoryPressureDelayMs() : 0;

  // PR7b-convergence (SEC MEDIUM-2): enqueue transaction 開始時刻をループ**前**に
  // 記録する。これは「enqueue を試行開始した時点」を意味し、BullMQ 内部の
  // `delay` (memory_pressure 初期遅延) や exponential backoff の経過時間は
  // 含まない。呼び出し元 (MCP response の `backfillPending.skip_recovery.enqueuedAt`)
  // はこの値を使って skip recovery のタイミング分析を行う。
  //
  // PR7b-convergence (SEC MEDIUM-2): Record the enqueue-transaction start time
  // **before** the loop. This timestamp represents "when we started attempting
  // enqueue" and does NOT include BullMQ-internal `delay` (memory_pressure
  // initial delay) or exponential backoff elapsed time. Callers (MCP response
  // `backfillPending.skip_recovery.enqueuedAt`) rely on this semantic for
  // skip-recovery timing analysis.
  const enqueueTransactionStartAt = new Date();

  // PR7b-convergence (TDA H-1 / H-2 / M-2): ヘルパーに集約。Worker/Cron の
  // 30 行 × 2 の重複コードを一箇所に統合し、`dispatchSkipRecoveryBackfill` の
  // 複雑度を 14 → ≤10 に収束。
  //
  // PR7b-convergence (TDA H-1 / H-2 / M-2): Consolidated into the helper.
  // Unifies ~30 lines × 2 Worker/Cron duplication and drives
  // `dispatchSkipRecoveryBackfill` complexity from 14 to ≤10.
  const { enqueued, failed } = await enqueueAllCategoriesForSkipRecovery(queue, {
    webPageId,
    screenshotStoragePath,
    initialDelayMs,
    source: "worker",
  });

  if (enqueued.length > 0) {
    logger.info("[PageAnalyzeWorker] Skip recovery: enqueued backfill jobs", {
      webPageId: webPageId.slice(0, 8) + "...",
      categories: enqueued,
      failedCategories: failed,
      skipReason,
      backfillStatus,
      retryCountAfter: currentRetryCount + 1,
      initialDelayMs,
    });
  } else {
    // すべて enqueue に失敗 — CAS で queued に遷移済みなので、cron が再回収する。
    // All enqueues failed — already transitioned to queued via CAS, cron will recover.
    logger.warn(
      "[PageAnalyzeWorker] Skip recovery: 0 categories enqueued (all failed); cron will retry",
      {
        webPageId: webPageId.slice(0, 8) + "...",
        failedCategories: failed,
      }
    );
  }

  // PR7b (ADR-0008 #7): MCP response `backfillPending.skip_recovery` 用に
  // post-increment retry count と enqueue 時刻を返却。
  // PR7b (ADR-0008 #7): return post-increment retry count and enqueue timestamp
  // for MCP response `backfillPending.skip_recovery`.
  return {
    enqueuedCategories: enqueued,
    reason: null,
    retryCountAfter: currentRetryCount + 1,
    enqueuedAt: enqueueTransactionStartAt,
  };
}

/**
 * Phase 4 完了後の選択的メモリ解放 (v0.4.0 PR7e-β2 P0-2)。
 *
 * 設計の歴史 / Design history:
 *   - PR7b (ADR-0008 #5): `state.layoutResultForNarrative` 等 4 つを null 化
 *     して Phase 5 fork 前の親 RSS を削減していた。
 *   - PR7e-α Revert: その null 化が「全ページ embedding 0 件」バグの真因
 *     （Phase 5 が入力を受け取れず）と判明し撤回。dispose は GC hint のみに退化。
 *   - PR7e-β2 P0-2 (本実装): Phase 5 が **使う** reference は維持しつつ、
 *     Phase 5 が **使わない** 中間データを選択的に破棄する。これにより
 *     reftrix.io / Stripe で観測された Phase 5 entry RSS=5028-5528MB を
 *     圧縮し、parent RSS guard 6144MB ceiling 内に収める。
 *
 *   - PR7b (ADR-0008 #5): nulled out 4 state references to reduce parent RSS
 *     before Phase 5 fork.
 *   - PR7e-α Revert: that null-out was the root cause of the "zero embeddings
 *     DB-wide" bug (Phase 5 starved of its inputs) and was reverted; dispose
 *     degraded to a GC hint only.
 *   - PR7e-β2 P0-2 (this revision): Keep references that Phase 5 **uses**;
 *     selectively drop the intermediate fields that Phase 5 **does not use**.
 *     This compresses the observed Phase 5 entry RSS=5028-5528MB on
 *     reftrix.io / Stripe so it fits within the 6144MB parent-RSS guard.
 *
 * 保持必須 (Phase 5 が使う) / Must preserve (used by Phase 5):
 *   - state.layoutResultForNarrative.sections (capped 50 in phase-4-narrative.ts)
 *   - state.motionResultForEmbedding.patterns
 *   - state.jsAnimationsForEmbedding (cdpAnimations / webAnimations / libraries)
 *   - state.scrollVisionResultForEmbedding.scrollTriggeredAnimations
 *   - state.sectionSaveResult, motionSaveResult, jsSaveResult, bgSaveResult,
 *     scrollVisionSaveResult, screenshotPngPath
 *
 * 破棄対象 (Phase 5 が使わない) / Drop targets (unused by Phase 5):
 *   - MotionServiceResult: frame_capture / frame_analysis (frame buffers, MB単位),
 *     webgl_animations (Canvas data), video_info / runtime_info, warnings,
 *     js_animation_summary, js_animations (jsAnimationsForEmbedding が独立保持)
 *   - ScrollVisionResult: analyses (per-capture Vision raw response, KB-MB単位)
 *
 *   - Note: jsAnimationsForEmbedding は分離保持なので motionResultForEmbedding 側の
 *     js_animations / js_animation_summary は冗長 → 破棄して安全。
 *   - Note: jsAnimationsForEmbedding is preserved separately, so
 *     motionResultForEmbedding's js_animations / js_animation_summary are
 *     redundant → safe to drop.
 *
 * 戻り値 / Returns: dispose 前後の RSS 平均 (MB)。`afterRssMb` が 3 回平均で測定される
 * ことを保証するため、`tryGarbageCollect()` + 100ms 待機後に 3 回サンプリングする。
 *
 * Returns pre/post RSS averages (MB). `afterRssMb` is measured as the mean of
 * 3 samples after `tryGarbageCollect()` + 100ms wait, to ensure the GC effect
 * is captured deterministically.
 */
async function disposePhase4Memory(state: PipelineState): Promise<{
  beforeRssMb: number;
  afterRssMb: number;
  reclaimedMb: number;
}> {
  const beforeRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // ============================================================
  // PR7e-β2 P0-2: 選択的破棄 / Selective disposal
  //
  // 履歴 / History:
  //   - PR7b は state.layoutResultForNarrative 等を null 化していた。
  //   - PR7e-α Revert (ADR-0012): その null 代入が「全 embedding 0 件」バグの
  //     真因と判明し撤回。state.* references は Phase 5 入力として保持。
  //   - PR7e-β2 P0-2: Phase 5 が使う reference は保持しつつ、Phase 5 不使用の
  //     中間フィールドのみを選択的に破棄する。
  //
  //   - PR7b nulled out state.layoutResultForNarrative et al.
  //   - PR7e-α Revert (ADR-0012): that null assignment was the root cause of
  //     the "zero embeddings DB-wide" bug and was reverted; state.* refs are
  //     preserved as Phase 5 inputs.
  //   - PR7e-β2 P0-2: Keep refs Phase 5 uses; selectively drop only the
  //     intermediate fields Phase 5 does not consume.
  // ============================================================

  // MotionServiceResult: keep only `patterns`; drop heavy intermediates.
  // 破棄対象: frame_capture (5-30MB), frame_analysis, webgl_animations,
  //   video_info, runtime_info, warnings, js_animation_summary,
  //   js_animations (jsAnimationsForEmbedding が独立保持)
  // Cast via `unknown` — MotionServiceResult lacks an index signature so a
  // direct `as Record<string, unknown>` cast is rejected by strict TS, but
  // optional fields are safe to `delete` at runtime.
  if (state.motionResultForEmbedding) {
    const m = state.motionResultForEmbedding as unknown as Record<string, unknown>;
    delete m["frame_capture"];
    delete m["frame_analysis"];
    delete m["frame_capture_error"];
    delete m["frame_analysis_error"];
    delete m["webgl_animations"];
    delete m["webgl_animation_summary"];
    delete m["webgl_animation_error"];
    delete m["video_info"];
    delete m["runtime_info"];
    delete m["warnings"];
    delete m["js_animation_summary"];
    delete m["js_animations"];
    delete m["js_animation_error"];
  }

  // ScrollVisionResult: keep only `scrollTriggeredAnimations`; drop per-capture
  // raw Vision analyses.
  // 破棄対象: analyses (per-capture Ollama Vision raw response, KB-MB単位)
  if (state.scrollVisionResultForEmbedding) {
    const sv = state.scrollVisionResultForEmbedding as unknown as Record<string, unknown>;
    delete sv["analyses"];
  }

  // ============================================================
  // GC + 3-sample RSS measurement (existing behavior preserved)
  // ============================================================
  tryGarbageCollect();

  // GC 完了待ち — 100ms wait + 3 samples で測定ノイズを抑制
  // Wait for GC — 100ms + 3 samples to suppress measurement noise
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    samples.push(process.memoryUsage().rss);
    if (i < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const avgRss = samples.reduce((a, b) => a + b, 0) / samples.length;
  const afterRssMb = Math.round(avgRss / 1024 / 1024);

  return {
    beforeRssMb,
    afterRssMb,
    reclaimedMb: beforeRssMb - afterRssMb,
  };
}

// ============================================================================
// processPageAnalyzeJob — Thin Orchestrator
// ============================================================================

/**
 * Process a page analysis job by orchestrating phase modules.
 *
 * This function creates the pipeline state and context, then delegates
 * to extracted phase modules (phase-0 through phase-5) in sequence.
 * Phase 5 (Embedding) and post-embedding backfill remain inline because
 * they reference module-level singletons (gpuResourceManager) and have a
 * different API signature (EmbeddingPhaseParams + EmbeddingPhaseDeps).
 *
 * @param job - BullMQ job instance
 * @param token - BullMQ worker token for lock management
 * @returns Job result with completed/failed phases and analysis results
 */

/**
 * Prisma schema enum `EmbeddingBackfillStatus` の値。
 * Valid values of the Prisma `EmbeddingBackfillStatus` enum.
 *
 * Kept as a string-literal union (not imported from `@prisma/client`) so that
 * this worker module stays free of a runtime dependency on the generated
 * client type when used from tests / fork children.
 *
 * 生成された `@prisma/client` 型への実行時依存を避けるため、あえて文字列
 * リテラル合併型として定義する（テスト / fork 子プロセスからも利用可能）。
 *
 * INV-SCHEMA-ENUM-004-B (standing regression): この literal union は Prisma
 * schema の `EmbeddingBackfillStatus` enum (現在 8 値) と完全一致しなければ
 * ならない。`skipped_screenshot_missing` は PR7d-1 で追加された repair 用
 * 終端状態 (`repair-orphaned-backfill-records.ts` 専用)。
 *
 * INV-SCHEMA-ENUM-004-B (standing regression): this literal union must match
 * Prisma's `EmbeddingBackfillStatus` enum (currently 8 values). The
 * `skipped_screenshot_missing` value was added in PR7d-1 as a repair-only
 * terminal state (used exclusively by `repair-orphaned-backfill-records.ts`).
 */
type EmbeddingBackfillStatusValue =
  | "not_required"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped_memory_pressure"
  | "skipped_fork_error"
  | "skipped_screenshot_missing";

/**
 * EmbeddingSkipReason → EmbeddingBackfillStatus へのマッピング（PR2 v0.4.0）。
 * Maps {@link EmbeddingSkipReason} to {@link EmbeddingBackfillStatusValue}.
 *
 * `v8_heap_headroom_low` / `system_memavailable_low` はメモリ圧迫に分類、
 * fork/child 由来は `skipped_fork_error`、`no_embeddable_items` は対象ゼロ
 * のため `not_required` に戻す。
 *
 * `v8_heap_headroom_low` / `system_memavailable_low` map to memory pressure;
 * fork/child-originated reasons map to `skipped_fork_error`; and
 * `no_embeddable_items` collapses back to `not_required` (no work to backfill).
 */
function skipReasonToBackfillStatus(reason: EmbeddingSkipReason): EmbeddingBackfillStatusValue {
  switch (reason) {
    case "v8_heap_headroom_low":
    case "system_memavailable_low":
      return "skipped_memory_pressure";
    case "text_fork_failed":
    case "text_child_error":
    case "text_child_abnormal_exit":
    case "text_ipc_race":
    case "visual_fork_failed":
    case "visual_child_error":
    case "visual_child_abnormal_exit":
    case "visual_ipc_race":
    case "dispatch_phase_failed":
    case "fork_terminated_before_done":
    case "parity_check_failed":
    case "bbox_invalid":
    case "bbox_unresolvable":
      // TDA MEDIUM 1 (v0.4.0 PR2 監査): `dispatch_phase_failed` は
      // `dispatchEmbeddingPhase` 全体の予期せぬ例外に対応する汎用分類で、
      // fork / child 系と同じ backfill queue 経路で再試行させる。
      // TDA MEDIUM 1 (v0.4.0 PR2 audit): `dispatch_phase_failed` is the
      // catch-all classification for unexpected exceptions thrown by
      // `dispatchEmbeddingPhase`; it is funneled through the same
      // backfill-queue retry path as fork/child-originated skips.
      //
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): `fork_terminated_before_done`
      // (fork child `done` 送信前終了) と `parity_check_failed` (terminal
      // transition 直前の COUNT(*) parity check 失敗) も同じ `skipped_fork_error`
      // ルートにマップし、backfill queue 経由で retry → 最終 state `failed`
      // (INV-EMBEDDING-INTEGRITY-001/004 契約)。
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): `fork_terminated_before_done`
      // (fork child terminated before sending `done`) and `parity_check_failed`
      // (COUNT(*) parity-check failed before terminal transition) also map to
      // `skipped_fork_error`, retrying via backfill queue and ultimately
      // transitioning to `failed` (INV-EMBEDDING-INTEGRITY-001/004 contracts).
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // `bbox_invalid` (Part visual embedding loop が boundingBox invalid で
      // skip) も同じ `skipped_fork_error` ルートにマップする。`skipped_fork_error`
      // は `backfill-reconciliation.service.ts` の retry bucket 対象
      // (L283/559/621/758) で、5 retry 後に `failed` 永続化。semantic-stretch:
      // `skipped_fork_error` は既に 11 種類の skip reason (fork系/child系/
      // ipc系/dispatch系) を集約する general-purpose retry-bucket mapping
      // として機能しており、`bbox_invalid` の "Phase 5 part visual embedding
      // 生成失敗" は自然な拡張。当初検討された `skipped_screenshot_missing`
      // は retry 対象外のため GDPR Art.5(1)(d) accuracy 原則違反として
      // 撤回 (IO Registry UC-01 Option B → Option D)。
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // `bbox_invalid` (Part visual embedding loop skip due to invalid
      // boundingBox) also maps to `skipped_fork_error`. `skipped_fork_error`
      // is the retry bucket in `backfill-reconciliation.service.ts`
      // (L283/559/621/758), persisting to `failed` after 5 retries.
      // Semantic-stretch: `skipped_fork_error` already aggregates 11 skip
      // reasons (fork/child/ipc/dispatch) as a general-purpose retry-bucket
      // mapping, so `bbox_invalid`'s "Phase 5 part visual embedding generation
      // failure" is a natural extension. The initially-considered
      // `skipped_screenshot_missing` was withdrawn (IO Registry UC-01 Option B
      // → Option D) because it is retry-excluded, violating GDPR Art.5(1)(d)
      // accuracy principle.
      //
      // PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1 Supplement S3):
      // `bbox_unresolvable` (Playwright-residual catch-all post-1st-pass +
      // post-reload-budget exhaustion) shares the same `skipped_fork_error`
      // retry bucket. Per Supplement S3 mapping rationale: same accuracy-
      // preserving retry path; downstream `backfill-reconciliation.service.ts`
      // re-enqueues via skip recovery (5 retries, then terminal `failed`).
      // Mutually exclusive with `bbox_invalid` (JSDOM-origin vs Playwright-
      // residual) by Supplement S3 decision-boundary contract.
      return "skipped_fork_error";
    case "no_embeddable_items":
      return "not_required";
    default: {
      // Exhaustiveness check — adding a new EmbeddingSkipReason requires
      // updating this switch.
      const _exhaustive: never = reason;
      void _exhaustive;
      return "skipped_fork_error";
    }
  }
}

/**
 * `web_pages.embeddingBackfillStatus` を安全に更新する（PR2 v0.4.0）。
 * Safely updates `web_pages.embeddingBackfillStatus` (PR2 v0.4.0).
 *
 * DB エラーは致命的でないため、warn ログのみ出力して続行する。
 * DB errors are non-fatal; logs a warning and continues.
 *
 * PR6 TPA #2: `queued` / `in_progress` 遷移時に `embeddingBackfillStartedAt`
 * を同時に設定し、後続の stale 判定を専用列ベースで行えるようにする。
 * `completed` / `failed` / `not_required` 等の終端状態に遷移する場合は
 * `embeddingBackfillStartedAt` を NULL に戻して index を小さく保つ。
 *
 * PR6 TPA #2: Also sets `embeddingBackfillStartedAt` when transitioning to
 * `queued` / `in_progress` so stale detection can rely on a dedicated column.
 * Clears `embeddingBackfillStartedAt` back to NULL on terminal transitions
 * (completed / failed / not_required / skipped_*) to keep the partial index
 * compact.
 *
 * PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): `skipped_fork_error` /
 * `skipped_memory_pressure` 遷移時に `embeddingBackfillSkippedAt` を書き込む。
 * これが NULL のままだと `fetchStaleSkippedPages()` の WHERE が常に空配列を返し、
 * cron Section B + 7d TTL が dead code となるため、ADR-0008 の「最終防衛線」が
 * 破綻する。skipped_* 以外の状態に遷移する場合は NULL に戻す。
 *
 * PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): Writes
 * `embeddingBackfillSkippedAt` when transitioning to `skipped_fork_error` /
 * `skipped_memory_pressure`. Leaving it NULL would make the WHERE clause of
 * `fetchStaleSkippedPages()` match nothing, rendering cron Section B + 7d TTL
 * dead code and breaking ADR-0008's "last line of defense". Cleared back to
 * NULL on transitions to any non-skipped_* state.
 */
async function updateEmbeddingBackfillStatus(
  webPageId: string,
  status: EmbeddingBackfillStatusValue,
  context: { url: string; reason?: EmbeddingSkipReason | undefined }
): Promise<void> {
  try {
    const isActive = status === "queued" || status === "in_progress";
    const isSkipped = status === "skipped_fork_error" || status === "skipped_memory_pressure";
    await prisma.webPage.update({
      where: { id: webPageId },
      data: {
        embeddingBackfillStatus: status,
        embeddingBackfillStartedAt: isActive ? new Date() : null,
        embeddingBackfillSkippedAt: isSkipped ? new Date() : null,
      },
    });
  } catch (updateError) {
    logger.warn("[PageAnalyzeWorker] Failed to update embeddingBackfillStatus", {
      error: sanitizeErrorMessage(updateError),
      webPageId: webPageId.slice(0, 8) + "...",
      status,
      reason: context.reason,
      url: context.url,
    });
  }
}

async function processPageAnalyzeJob(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token?: string
): Promise<PageAnalyzeJobResult> {
  const startTime = Date.now();
  const { webPageId, url, options } = job.data;

  // Lock extension: Create periodic lock extender as secondary protection
  // BullMQ's built-in lockRenewTime (lockDuration/2) handles the primary case,
  // but CPU-bound phases (Ollama Vision) may block the event loop.
  const effectiveToken = token ?? job.token ?? "";
  const effectiveLockDuration = DEFAULT_LOCK_DURATION;
  const lockExtender = createLockExtender(
    job,
    effectiveToken,
    effectiveLockDuration,
    DEFAULT_LOCK_EXTEND_INTERVAL
  );

  // Start lock extender before processing phases
  lockExtender.start();

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] Processing job", {
      jobId: job.id,
      webPageId,
      url,
      options,
      lockExtension: {
        lockDuration: effectiveLockDuration,
        extendInterval: DEFAULT_LOCK_EXTEND_INTERVAL,
        hasToken: !!effectiveToken,
      },
    });
  }

  // Initialize status tracker for progress reporting
  // Send detailed progress data including currentPhase and phases for SSE clients
  const statusTracker = new ExecutionStatusTrackerV2({
    webPageId,
    url,
    onStatusChange: (status): void => {
      // Bull Board requires numeric progress (0-100) for the progress bar.
      // Send overallProgress as number, and log phase details via job.log().
      const progress =
        typeof status.overallProgress === "number" && Number.isFinite(status.overallProgress)
          ? Math.round(status.overallProgress)
          : 0;

      // PR-B (v0.4.0 PR7e P5 / SEC-M2-04): 以下 2 点を同時に解消する。
      //   (1) raw `err.message` を `sanitizeErrorMessage()` で汎用メッセージ化
      //       (CWE-209 内部構造漏洩防止 — "Missing key for job <id>" や
      //       Redis internal path 等がログに載る経路を断つ)
      //   (2) `updateProgress` はジョブがアクティブでない場合 (lock 喪失 /
      //       stall 再試行直後 / BullMQ Redis hash 不在) に throw する。
      //       catch 内で err を再 throw しないため、二次 crash への波及は
      //       ない。sanitize されたメッセージを warn ログのみ記録して
      //       fire-and-forget を維持する。
      //
      // PR-B (v0.4.0 PR7e P5 / SEC-M2-04): Addresses two issues at once:
      //   (1) raw `err.message` → `sanitizeErrorMessage()` (CWE-209 leakage
      //       prevention; redacts "Missing key for job <id>" and Redis
      //       internals that would otherwise land in logs).
      //   (2) `updateProgress` may throw when the job is no longer active
      //       (lock lost / post-stall retry / missing BullMQ Redis hash).
      //       The catch does not rethrow, so this stays fire-and-forget —
      //       only the sanitized warn log is recorded.
      job.updateProgress(progress).catch((err: unknown) => {
        logger.warn("[PageAnalyzeWorker] Failed to update job progress", {
          jobId: job.id,
          error: sanitizeErrorMessage(err),
        });
      });

      // Write phase transition to Bull Board Logs tab
      job
        .log(`[${new Date().toISOString()}] Phase: ${status.currentPhase} | Progress: ${progress}%`)
        .catch(() => {
          /* fire-and-forget */
        });
    },
  });

  statusTracker.initialize();

  // Create PhaseContext (immutable across phases)
  const ctx: PhaseContext = {
    job,
    options,
    url,
    webPageId,
    effectiveToken,
    effectiveLockDuration,
    statusTracker,
  };

  // Create PipelineState (mutable, shared across phases)
  const state: PipelineState = {
    actualWebPageId: webPageId,
    completedPhases: [],
    failedPhases: [],
    results: {},
    layoutResultForNarrative: null,
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    motionResultForEmbedding: null,
    jsAnimationsForEmbedding: null,
    scrollVisionSaveResult: null,
    scrollVisionResultForEmbedding: null,
    scrollVisionCapturesForDeferred: null,
    html: null,
    screenshotBase64: undefined,
    narrativePreDisabled: false,
    visionPreDisabled: false,
    memoryAborted: false,
  };

  // v0.4.0 PR7e-α (バグ④): PhasedDbHandler は `actualWebPageId` が確定する
  // Phase 0 の後にインスタンス化する。例外時も lock は WorkerActiveLockService
  // の TTL に任せ、ここでは fail-open（warn + 続行）で扱う。
  // v0.4.0 PR7e-α (bug ④): PhasedDbHandler is instantiated after Phase 0 so
  // `actualWebPageId` is stable. On failure we log+warn and continue (fail-
  // open); worker-level lock TTL handles cleanup.
  let phasedDb: PhasedDbHandler | null = null;

  // =====================================================
  // PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged, default OFF)
  // =====================================================
  // `PHASE0_EARLY_INSERT=true` の場合、`processIngestPhase` を呼ぶ前に
  // `web_pages` の最小行を upsert する (W0)。これにより Phase 0 の早期
  // 失敗 (robots.txt block / SSRF / DNS NXDOMAIN 等) でも DB 行が残り、
  // failure-path の `markAnalysisFailed` / inline update が P2025 で空振り
  // しなくなる。W0 の本旨は `actualWebPageId` を確定することであり、
  // `htmlContent` / `htmlHash` は Phase 0.5 (W1) まで書き込まない。
  //
  // When `PHASE0_EARLY_INSERT=true`, upsert a minimal `web_pages` row BEFORE
  // `processIngestPhase` starts (W0). This ensures that early Phase 0
  // failures (robots.txt / SSRF / DNS) still leave a DB row, so the
  // failure-path `markAnalysisFailed` / inline update no longer no-ops on
  // P2025. W0 only resolves `actualWebPageId`; html content is still
  // written later by Phase 0.5 (W1).
  //
  // =============================================================
  // SAVETODB SEMANTICS — UNIFIED CONTRACT (FIND-PR-B-009)
  // =============================================================
  // `options.layoutOptions?.saveToDb !== false` is the canonical gate for
  // ALL `web_pages` upsert writes in the ingest path. This condition is
  // intentionally symmetric at two call sites:
  //   - W0: page-analyze-worker.ts (this block) — early INSERT under
  //         `PHASE0_EARLY_INSERT=true`, writes `analysisStatus='pending'`.
  //   - W1: phase-0-ingest.ts:~201 — html/hash/crawledAt upsert after
  //         `processIngestPhase` succeeds (does NOT overwrite
  //         `analysisStatus` when W0 already set it).
  //
  // Contract:
  //   - `saveToDb === undefined` (default) → PERSIST (treated as enabled).
  //   - `saveToDb === true` → PERSIST.
  //   - `saveToDb === false` → SKIP (explicit opt-out; transient analysis).
  //
  // Both sites MUST use `!== false` (not `=== true`) to preserve the default
  // behavior. Flipping one site to `=== true` will desynchronize W0/W1 and
  // break INV-PAGE-QUEUE-001-C (PHASE0_EARLY_INSERT failure-path persistence).
  // Any future change to this semantics requires an ADR amendment.
  // =============================================================
  const phase0EarlyInsertEnabled = isPhase0EarlyInsertEnabled();
  if (phase0EarlyInsertEnabled && options.layoutOptions?.saveToDb !== false) {
    try {
      const normalizedUrlForEarlyInsert = normalizeUrlForStorage(url);
      const earlyUpsert = await prisma.webPage.upsert({
        where: { url: normalizedUrlForEarlyInsert },
        create: {
          id: webPageId,
          url: normalizedUrlForEarlyInsert,
          title: null,
          description: null,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
          crawledAt: new Date(),
          analysisStatus: "pending",
        },
        update: {
          // 既存行は `analysisStatus='pending'` に戻すだけ (retry 想定)。
          // `htmlContent` / `htmlHash` は Phase 0.5 (W1) で書き換える。
          // Existing row: reset `analysisStatus='pending'` only (retry flow).
          // `htmlContent` / `htmlHash` are refreshed later by Phase 0.5 (W1).
          analysisStatus: "pending",
          analysisError: null,
          analysisCompletedAt: null,
          lastAnalyzedPhase: null,
        },
        select: { id: true },
      });
      state.actualWebPageId = earlyUpsert.id;
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Phase 0 Early INSERT complete", {
          requestedWebPageId: webPageId.slice(0, 8) + "...",
          actualWebPageId: state.actualWebPageId.slice(0, 8) + "...",
          url,
        });
      }
    } catch (earlyUpsertError) {
      // fail-open: Early INSERT 失敗は non-fatal で続行する。
      // 後続の Phase 0.5 (W1) が通常経路で行を作る想定。
      //
      // fail-open: Early INSERT failure is non-fatal; continue so Phase 0.5
      // (W1) can create the row along the legacy path.
      logger.warn("[PageAnalyzeWorker] Phase 0 Early INSERT failed (non-fatal, continuing)", {
        error: sanitizeErrorMessage(earlyUpsertError),
        webPageId: webPageId.slice(0, 8) + "...",
        url,
      });
    }
  }

  try {
    // =====================================================
    // Phase 0: Ingest (HTML取得) + Phase 0.5: WebPage DB Save
    // =====================================================
    const sharedBrowser = await processIngestPhase(state, ctx, {
      pageIngestAdapter,
      prisma,
      screenshotPersistenceService,
      phase0EarlyInsertEnabled,
    });

    // v0.4.0 PR7e-α (バグ④ fix): Phase 0 完了直後に PhasedDbHandler を起動し、
    // analysis_phase_status='pending' + analysis_started_at=NOW を書き込む。
    // 失敗は non-fatal — TPA 指摘 "例外パス trans" 対応で fail-open とする。
    //
    // PR-B (v0.4.0 PR7e P4): `phase0EarlyInsertEnabled=true` でも
    // `markAnalysisStarted` は呼ぶ。理由: このメソッドは `analysisPhaseStatus`
    // と `analysisStartedAt` も更新する (W0 は `analysisStatus` のみ)。
    // 重複書き込みは冪等 (同一値の上書き) なので safe。
    //
    // v0.4.0 PR7e-α (bug ④ fix): Instantiate PhasedDbHandler right after
    // Phase 0 so it writes analysis_phase_status='pending' +
    // analysis_started_at=NOW. Treat failure as non-fatal (TPA "exception
    // path trans" fail-open guidance).
    //
    // PR-B (v0.4.0 PR7e P4): Even with `phase0EarlyInsertEnabled=true` we
    // still call `markAnalysisStarted` because it also advances
    // `analysisPhaseStatus` / `analysisStartedAt` (W0 only touches
    // `analysisStatus`). Duplicate writes are idempotent.
    try {
      phasedDb = new PhasedDbHandler({
        prisma,
        webPageId: state.actualWebPageId,
      });
      await phasedDb.markAnalysisStarted();
    } catch (phasedDbError) {
      logger.warn("[PageAnalyzeWorker] PhasedDbHandler.markAnalysisStarted failed (non-fatal)", {
        error: sanitizeErrorMessage(phasedDbError),
        webPageId: state.actualWebPageId.slice(0, 8) + "...",
      });
      phasedDb = null;
    }

    // =====================================================
    // Phase 1 → Phase 3 逐次実行 / Sequential Phase 1 → Phase 3
    // =====================================================
    // v0.3.0: Promise.all 並列実行から逐次実行に変更。
    // Quality P50=0.02ms で並列実行のメリットはほぼゼロ。
    // 逐次実行によりメモリの二重保持を回避し、メモリ効率を改善。
    // 両フェーズは内部で try-catch による Graceful Degradation を実装しており、
    // Phase 1 が失敗しても Phase 3 は実行される。
    //
    // v0.3.0: Changed from Promise.all parallel to sequential execution.
    // Quality P50=0.02ms makes parallelism pointless.
    // Sequential execution avoids dual memory allocation, improving efficiency.
    // Both phases implement internal try-catch Graceful Degradation,
    // so Phase 3 executes even if Phase 1 fails.
    await processLayoutPhase(state, ctx, {
      defaultAnalyzeLayout: defaultAnalyzeLayout as never,
      saveBackgroundDesigns,
      saveSectionPatterns,
      postProcessSections,
      extractPartsFromSection: extractPartsFromSection as never,
      saveExtractedParts: saveExtractedParts as never,
      prisma,
    });
    await processQualityPhase(state, ctx, {
      defaultEvaluateQuality: defaultEvaluateQuality as never,
      saveQualityEvaluation,
      saveQualityBenchmarks,
      buildQualityBenchmarkInputs,
      prisma,
    });

    // =====================================================
    // Ollama Vision Unload (1st point): After Phase 1 / before Phase 1.5
    // Ollama VisionがVRAMにロードされたまま残る。
    // Phase 1.5 (Scroll Capture) のChromium VRAM確保 + Phase 2.5 (Scroll Vision Analysis) の
    // OllamaReadinessProbe VRAM閾値(8192MB)クリアのため、ここで解放する。
    // Phase 2.5でVisionが必要な場合はOllamaが自動再ロードする。
    // 冪等: useVision=falseでVision未ロード時もno-opで安全。
    // =====================================================
    await unloadOllamaVisionModel();

    // =====================================================
    // Phase 1.5 + 2 + 2.5: Motion (includes browser close + Ollama unload 2nd point)
    // =====================================================
    await processMotionPhase(state, ctx, sharedBrowser, {
      captureScrollPositions,
      defaultDetectMotion,
      analyzeScrollCaptures,
      saveMotionPatterns,
      saveJsAnimationPatterns,
      saveScrollVisionResults,
      saveFrameAnalysisToDb,
      gpuResourceManager,
      pageIngestAdapter,
      prisma,
    });

    // =====================================================
    // Phase 4 + 4.5: Narrative + Responsive (includes Ollama unload 3rd point)
    // =====================================================
    await processNarrativePhase(state, ctx, {
      handleNarrativeAnalysis,
      responsiveAnalysisService: responsiveAnalysisService as never,
      responsivePersistenceService: responsivePersistenceService as never,
      validateExternalUrl,
      isUrlAllowedByRobotsTxt,
    });

    // =====================================================
    // v0.4.0 PR7b (ADR-0008 #5 / TPA H-2): Phase 4 dispose
    // Narrative Phase 完了後に in-memory reference を null 化し、Phase 5 fork 前
    // の親 RSS を削減する。screenshot file / sharedBrowser は物理維持
    // （Phase 5 child / Queue-based Backfill が参照するため）。
    // GC + 100ms wait + 3 回平均 RSS 測定で測定ノイズを抑制する。
    //
    // v0.4.0 PR7b (ADR-0008 #5 / TPA H-2): Disposes in-memory references after
    // Narrative Phase to reduce parent RSS before Phase 5 fork. Preserves
    // screenshot files and sharedBrowser physically (referenced by Phase 5
    // child / Queue-based Backfill). Suppresses measurement noise via GC +
    // 100ms wait + 3-sample mean.
    // =====================================================
    {
      const dispose = await disposePhase4Memory(state);
      logger.info("[PageAnalyzeWorker] Phase 4 dispose complete", {
        beforeRssMb: dispose.beforeRssMb,
        afterRssMb: dispose.afterRssMb,
        reclaimedMb: dispose.reclaimedMb,
        url,
      });
    }

    // =====================================================
    // Memory Check 3: Before Phase 5 (Embedding)
    // If memory pressure is critical (shouldAbort=true), skip Phase 5
    // to prevent worker crash. Phase 0-4.5 results are preserved.
    //
    // v0.4.0 PR7b (ADR-0008 #4): 親 RSS upstream guard を追加。Phase 5 fork 前に
    // `PHASE5_PARENT_RSS_MAX_MB` を超えていたら、checkMemoryPressure() を待たず
    // 即時 skip し `skipped_memory_pressure` 経路で全 7 カテゴリを enqueue する。
    //
    // v0.4.0 PR7b (ADR-0008 #4): Adds parent RSS upstream guard. If parent RSS
    // exceeds `PHASE5_PARENT_RSS_MAX_MB` before Phase 5 fork, skip immediately
    // (don't wait for checkMemoryPressure) and enqueue all 7 categories via
    // the `skipped_memory_pressure` path.
    // =====================================================
    let memoryAbortEmbedding = false;
    // PR2 (v0.4.0): Phase 5 がスキップされた理由（サイレント skip 解消）
    // PR2 (v0.4.0): Reason Phase 5 was skipped (silent-skip fix)
    let observedSkipReason: EmbeddingSkipReason | undefined;
    let observedSkipDetail: string | undefined;
    {
      // v0.4.0 PR7b (ADR-0008 #4): 親 RSS upstream guard
      // 既存 checkMemoryPressure() (heapUsed ベース) よりも厳格な親プロセス
      // RSS 閾値 (デフォルト 3072MB) を Phase 5 fork 前に評価する。
      //
      // v0.4.0 PR7b (ADR-0008 #4): Parent RSS upstream guard.
      // Stricter parent-process RSS threshold (default 3072MB) evaluated before
      // Phase 5 fork, on top of the existing heapUsed-based checkMemoryPressure().
      const phase5Config = loadPhase5Config();
      const parentRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (parentRssMb > phase5Config.parentRssMaxMb) {
        logger.warn(
          "[PageAnalyzeWorker] [PR7b Parent RSS Guard] Parent RSS exceeds Phase 5 ceiling, skipping fork",
          {
            parentRssMb,
            ceilingMb: phase5Config.parentRssMaxMb,
            url,
          }
        );
        state.failedPhases.push("embedding" as AnalysisPhase);
        memoryAbortEmbedding = true;
        observedSkipReason = "system_memavailable_low";
        observedSkipDetail = truncateSkipDetail(
          `parent RSS=${parentRssMb}MB > ceiling=${phase5Config.parentRssMaxMb}MB`
        );
      } else {
        const memCheck3 = checkMemoryPressure();
        if (memCheck3.shouldAbort) {
          logger.warn(
            "[PageAnalyzeWorker] [Memory Critical] RSS high before embedding, skipping Phase 5 to preserve worker stability",
            {
              rssMb: memCheck3.rssMb,
              threshold: MEMORY_CRITICAL_THRESHOLD_MB,
              url,
            }
          );
          state.failedPhases.push("embedding" as AnalysisPhase);
          memoryAbortEmbedding = true;
          // Worker-level memory guard is conceptually the same failure class as
          // the fork-orchestrator's MIN_HEAP_HEADROOM_BYTES check → reuse that
          // EmbeddingSkipReason for consistent telemetry.
          observedSkipReason = "v8_heap_headroom_low";
          observedSkipDetail = truncateSkipDetail(
            `worker RSS=${memCheck3.rssMb}MB > ${MEMORY_CRITICAL_THRESHOLD_MB}MB`
          );
        }
      }
    }

    // =====================================================
    // Phase 5: Embedding Generation (delegated to processEmbeddingPhase)
    // =====================================================
    // Extend lock before Embedding phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding");

    const responsiveAnalysisIdForEmbedding = state.results?.responsive?.responsiveAnalysisId;
    const embeddingEnabled =
      !memoryAbortEmbedding &&
      state.actualWebPageId &&
      ((state.sectionSaveResult?.idMapping?.size ?? 0) +
        (state.motionSaveResult?.idMapping?.size ?? 0) +
        (state.jsSaveResult?.idMapping?.size ?? 0) +
        (state.bgSaveResult?.idMapping?.size ?? 0) +
        (state.scrollVisionSaveResult?.idMapping?.size ?? 0) >
        0 ||
        !!responsiveAnalysisIdForEmbedding ||
        (state.results?.partExtraction?.totalPartsSaved ?? 0) > 0);

    // v0.4.0 PR4: partsSavedCountForPhase5 を `if (embeddingEnabled)` の外側で計算する。
    // Phase 5 が skip された場合（memoryAbort や embeddingEnabled=false）でも、
    // 下流の backfill dispatch 判定で参照するため。
    // v0.4.0 PR4: Compute partsSavedCountForPhase5 outside the `if (embeddingEnabled)`
    // block because the downstream backfill dispatch logic needs it even when
    // Phase 5 is skipped (memoryAbort or embeddingEnabled=false).
    const partsSavedCountForPhase5 = state.results?.partExtraction?.totalPartsSaved ?? 0;

    if (embeddingEnabled) {
      // GPU Resource Manager: Acquire GPU for Embedding (unloads Ollama, switches ONNX to CUDA)
      try {
        const embeddingAcquireResult = await gpuResourceManager.acquireForEmbedding();
        logger.debug("[PageAnalyzeWorker] GPU acquired for embedding", {
          acquired: embeddingAcquireResult.acquired,
          fallbackToCpu: embeddingAcquireResult.fallbackToCpu,
        });
      } catch (gpuError) {
        logger.warn("[PageAnalyzeWorker] GPU acquire for embedding failed, using CPU", {
          error: gpuError instanceof Error ? gpuError.message : String(gpuError),
        });
        // Continue with CPU mode - embedding will work, just slower
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_START);

      // OOM-3: Phase 5 前メモリ診断 — job.log で Redis に永続化
      // logger.info は V8 OOM でプロセスが異常終了すると失われるが、
      // job.log は Redis に書き込み済みなので事後調査に利用可能。
      // OOM-3: Pre-Phase 5 memory diagnostic — persisted to Redis via job.log.
      // logger.info is lost on V8 OOM crash, but job.log is already in Redis.
      {
        const mem = process.memoryUsage();
        const v8Stats = (await import("node:v8")).getHeapStatistics();
        await job.log(
          `[Phase 5] Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, ` +
            `heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
            `heapLimit=${Math.round(v8Stats.heap_size_limit / 1024 / 1024)}MB, ` +
            `external=${Math.round(mem.external / 1024 / 1024)}MB, ` +
            `arrayBuffers=${Math.round(mem.arrayBuffers / 1024 / 1024)}MB, ` +
            `screenshotBase64=${state.screenshotBase64 ? Math.round(state.screenshotBase64.length / 1024) + "KB" : "none"}, ` +
            `screenshotPngPath=${state.screenshotPngPath ? "exists" : "none"}`
        );
      }

      await job.log("[Phase 5] Embedding generation started");

      // Wrap dispatchEmbeddingPhase in try-catch to prevent worker crash on
      // Phase 5 failures (OOM, fork crash, IPC error). On failure, the job
      // completes as partialSuccess with Phase 0-4.5 results preserved.
      let embeddingPhaseResult: Awaited<ReturnType<typeof dispatchEmbeddingPhase>> | undefined;
      // v0.4.0 PR4: 100 件を超える Part が存在する場合、同期フェーズは先頭 100 件のみ
      // 処理し、残余は本 Phase 5 完了後に `embedding-backfill` Queue へ投入する。
      // partsLimit=undefined は「無制限」を意味し、100 件以下のページは従来通り全件同期処理。
      //
      // v0.4.0 PR4: When there are more than 100 Parts, the sync phase processes
      // only the first 100; the remainder is enqueued on the `embedding-backfill`
      // Queue after Phase 5. partsLimit=undefined means "no limit" — pages with
      // 100 Parts or fewer continue to process synchronously as before.
      const partsLimitForSyncPhase =
        partsSavedCountForPhase5 > PART_SYNC_THRESHOLD ? PART_SYNC_THRESHOLD : undefined;
      try {
        embeddingPhaseResult = await dispatchEmbeddingPhase(
          {
            webPageId: state.actualWebPageId,
            url,
            job,
            effectiveToken,
            effectiveLockDuration,
            sectionSaveResult: state.sectionSaveResult,
            motionSaveResult: state.motionSaveResult,
            jsSaveResult: state.jsSaveResult,
            bgSaveResult: state.bgSaveResult,
            scrollVisionSaveResult: state.scrollVisionSaveResult,
            layoutResultForNarrative: state.layoutResultForNarrative,
            motionResultForEmbedding: state.motionResultForEmbedding,
            jsAnimationsForEmbedding: state.jsAnimationsForEmbedding,
            scrollVisionResultForEmbedding: state.scrollVisionResultForEmbedding,
            responsiveAnalysisId: responsiveAnalysisIdForEmbedding,
            partsSavedCount: partsSavedCountForPhase5,
            // v0.4.0 PR4: 同期フェーズの Part embedding 上限（100 件超のページのみ設定）
            // v0.4.0 PR4: Sync-phase Part embedding cap (set only for >100 pages)
            partsLimit: partsLimitForSyncPhase,
            screenshotPngPath: state.screenshotPngPath,
            sharedBrowser,
            onProgress: createPhaseProgressInterpolator(
              job,
              PHASE_PROGRESS.EMBEDDING_START,
              PHASE_PROGRESS.EMBEDDING_COMPLETE
            ),
          },
          {
            sharedLayoutEmbeddingService,
            gpuResourceManager,
            prisma: prisma as never,
          }
        );
      } catch (embeddingError) {
        // Phase 5 failed — record as failed phase but keep worker alive.
        // Phase 0-4.5 results are already saved to DB and preserved in state.
        const errorDetail = sanitizeErrorMessage(embeddingError);
        logger.warn(
          "[PageAnalyzeWorker] Phase 5 (Embedding) failed — recording as partialSuccess",
          {
            error: errorDetail,
            url,
          }
        );
        state.failedPhases.push("embedding" as AnalysisPhase);
        // PR2 (v0.4.0) + TDA MEDIUM 1 (v0.4.0 PR2 監査):
        // 外側 catch は dispatchEmbeddingPhase 全体の例外 (text/visual いずれに
        // 由来するか不明なケース) なので、汎用分類 `dispatch_phase_failed` を
        // 採用する。旧実装では `text_fork_failed` 固定で Visual 側経路の
        // 例外を誤分類するリスクがあった。これは「最初に発火した理由」を
        // 保持するため、runPhase5ViaFork 内で既に具体的な reason が設定
        // 済みならそちらを優先する。
        // PR2 (v0.4.0) + TDA MEDIUM 1 (v0.4.0 PR2 audit):
        // The outer catch covers any exception thrown by dispatchEmbeddingPhase
        // (origin unknown — text or visual path). We record the generic
        // `dispatch_phase_failed` classification. The previous implementation
        // hard-coded `text_fork_failed`, risking mis-classification of Visual
        // path exceptions. Because setSkipReasonIfUnset only sets the first
        // reason, any more specific reason already set by runPhase5ViaFork is
        // preserved.
        if (observedSkipReason === undefined) {
          observedSkipReason = "dispatch_phase_failed";
          observedSkipDetail = truncateSkipDetail(errorDetail);
        }
        await job.log(`[Phase 5] Embedding failed: ${errorDetail}`);
      }

      // v0.4.0 PR7d-1 (ADR-0010): Phase 5 Screenshot は永続化パス
      //   `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png` に保存され、
      //   削除は (1) GDPR `data.delete` (Art. 17 同期削除) + (2) PR6 TTL cron
      //   (7d) の 2 経路のみ。Worker 側で即時削除すると Queue-based Backfill
      //   (`part_visual` / `section_visual`) が screenshot を参照できず
      //   visual embedding が 0 件になる（ADR-0009 バグ 2 の再発）。
      //   ここでは in-memory 参照のみ null 化する（後続のダブル実行を防ぐ）。
      //
      // v0.4.0 PR7d-1 (ADR-0010): Phase 5 screenshots live at the persisted
      //   path `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`. Deletion
      //   is consolidated into exactly two paths: (1) GDPR `data.delete`
      //   (Art. 17, synchronous) + (2) PR6 TTL cron (7d). Any eager deletion
      //   by the worker would regress ADR-0009 Bug 2 — Queue-based Backfill
      //   (`part_visual` / `section_visual`) would read a zero-byte file and
      //   generate no visual embeddings. We therefore only null-out the
      //   in-memory reference here.
      if (state.screenshotPngPath) {
        delete state.screenshotPngPath;
      }

      tryGarbageCollect();

      // =====================================================
      // Map embedding phase result back to job results (PR2 v0.4.0)
      // Safety: state.results is always initialized to {} in PipelineState
      // construction (line ~315), but the type is optional because
      // PageAnalyzeJobResult.results is optional. Assert non-null here since
      // we know it's always set.
      //
      // PR2 (v0.4.0): サイレント skip バグを解消する。
      //   - カウント合計 > 0: 通常通り completedPhases に push する。
      //   - カウント合計 = 0 + completed = false + skipReason あり:
      //     サイレント skip を検知し、failedPhases に push して
      //     results.embedding.skipReason を埋める。
      //   - どちらにも当てはまらない（dispatch が例外を投げた場合）は、
      //     外側 catch ですでに failedPhases に push 済み。
      //
      // PR2 (v0.4.0): Silent-skip bug fix.
      //   - Total counts > 0  → push to completedPhases as usual.
      //   - Total counts == 0 + completed == false + skipReason present
      //     → detect silent skip, push to failedPhases, populate
      //       results.embedding.skipReason.
      //   - Neither applies (dispatch threw) → outer catch already pushed.
      // =====================================================
      const results = state.results!;

      // Forward skip reason surfaced by the fork orchestrator to the outer
      // observability variables so the post-embedding block can act on them.
      if (embeddingPhaseResult?.skipReason !== undefined && observedSkipReason === undefined) {
        observedSkipReason = embeddingPhaseResult.skipReason;
        observedSkipDetail = embeddingPhaseResult.skipDetail;
      }

      const totalEmbeddingsGenerated = embeddingPhaseResult
        ? embeddingPhaseResult.sectionEmbeddingsGenerated +
          embeddingPhaseResult.sectionVisualEmbeddingsGenerated +
          embeddingPhaseResult.motionEmbeddingsGenerated +
          embeddingPhaseResult.bgEmbeddingsGenerated +
          embeddingPhaseResult.jsAnimationEmbeddingsGenerated +
          embeddingPhaseResult.responsiveEmbeddingsGenerated +
          embeddingPhaseResult.partEmbeddingsGenerated +
          embeddingPhaseResult.partVisualEmbeddingsGenerated
        : 0;

      if (embeddingPhaseResult && totalEmbeddingsGenerated > 0) {
        const embeddingResult: NonNullable<PageAnalyzeJobResult["results"]>["embedding"] = {};
        if (embeddingPhaseResult.sectionEmbeddingsGenerated > 0) {
          embeddingResult.sectionEmbeddingsGenerated =
            embeddingPhaseResult.sectionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0) {
          embeddingResult.sectionVisualEmbeddingsGenerated =
            embeddingPhaseResult.sectionVisualEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.motionEmbeddingsGenerated > 0) {
          embeddingResult.motionEmbeddingsGenerated =
            embeddingPhaseResult.motionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.bgEmbeddingsGenerated > 0) {
          embeddingResult.backgroundDesignEmbeddingsGenerated =
            embeddingPhaseResult.bgEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0) {
          embeddingResult.jsAnimationEmbeddingsGenerated =
            embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.responsiveEmbeddingsGenerated > 0) {
          embeddingResult.responsiveEmbeddingsGenerated =
            embeddingPhaseResult.responsiveEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partEmbeddingsGenerated > 0) {
          embeddingResult.partEmbeddingsGenerated = embeddingPhaseResult.partEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partVisualEmbeddingsGenerated > 0) {
          embeddingResult.partVisualEmbeddingsGenerated =
            embeddingPhaseResult.partVisualEmbeddingsGenerated;
        }
        results.embedding = embeddingResult;
      }

      if (embeddingPhaseResult?.completed) {
        state.completedPhases.push("embedding" as AnalysisPhase);
      } else if (
        embeddingPhaseResult !== undefined &&
        totalEmbeddingsGenerated === 0 &&
        embeddingPhaseResult.skipReason !== undefined &&
        !state.failedPhases.includes("embedding" as AnalysisPhase)
      ) {
        // PR2 (v0.4.0): サイレント skip を検知 — これが本 PR の修正の核心。
        // PR2 (v0.4.0): Silent-skip detected — this is the core of this PR.
        state.failedPhases.push("embedding" as AnalysisPhase);
        logger.warn(
          "[PageAnalyzeWorker] Phase 5 silently skipped — recorded as failed phase (PR2)",
          {
            skipReason: embeddingPhaseResult.skipReason,
            skipDetail: embeddingPhaseResult.skipDetail,
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
            url,
          }
        );
        await job.log(
          `[Phase 5] Silent skip detected: reason=${embeddingPhaseResult.skipReason}, detail=${embeddingPhaseResult.skipDetail ?? "n/a"}`
        );
      }

      // PR2 (v0.4.0): skipReason を response の results.embedding に埋める
      // PR2 (v0.4.0): Surface skipReason to MCP clients via results.embedding
      if (observedSkipReason !== undefined) {
        if (!results.embedding) {
          results.embedding = {};
        }
        results.embedding.skipReason = observedSkipReason;
        if (observedSkipDetail !== undefined) {
          results.embedding.skipDetail = observedSkipDetail;
        }
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_COMPLETE);

      // =====================================================
      // Post-Embedding: Release in-memory refs and Counter Reconciliation
      // =====================================================
      {
        // Release all in-memory refs to minimize RSS
        state.layoutResultForNarrative = null;
        state.motionResultForEmbedding = null;
        state.jsAnimationsForEmbedding = null;
        state.scrollVisionResultForEmbedding = null;
        tryGarbageCollect();

        // =====================================================
        // FIX(Bug-2): Post-Phase 5 Counter Reconciliation
        // The fork child may generate embeddings (saved to DB) but the
        // IPC-relayed counter can be 0 due to IPC race condition (exit event
        // fires before message event). Reconcile ALL counters against the
        // authoritative DB state.
        //
        // PR5 (v0.4.0): 4 カテゴリ (section/part/motion/bg) から 9 カテゴリへ拡張。
        // Part は text / visual を独立集計し、js_animation / responsive /
        // section_visual も DB と整合させる。PR4 で part_text / part_visual が
        // 非同期 backfill に分割されたため、同期フェーズ完了時点での実生成数を
        // DB self-discovery で厳密に取得する。
        //
        // PR5 (v0.4.0): Extended from 4 to 9 counters. Part now splits into
        // text / visual, and js_animation / responsive / section_visual are
        // reconciled against the DB as well. Because PR4 split part_text /
        // part_visual into async backfill, we must derive the accurate
        // sync-phase totals directly from the DB.
        // =====================================================
        {
          // PR5 (v0.4.0): Prisma の `Unsupported("vector(768)")` カラムは
          // where 句 `{ not: null }` を受け付けないため、text/visual の非 NULL
          // カウントだけ生 SQL を用いる。他はリレーション経由で Prisma 標準
          // API を使用する。
          //
          // PR5 (v0.4.0): Prisma's `Unsupported("vector(768)")` columns don't
          // support `{ not: null }` in `where`, so non-null counts for
          // text/visual use raw SQL. The remaining counts use the Prisma API
          // via relations as before.
          //
          // PR6 TDA TD-1: ローカルヘルパー `queryCountNonNull` は
          // `utils/prisma-raw-count.ts` の `countNonNullVector` に抽出。
          // table / column は allowlist で閉じ込め、webPageId はパラメータ化される。
          //
          // PR6 TDA TD-1: Local helper `queryCountNonNull` extracted to
          // `countNonNullVector` in `utils/prisma-raw-count.ts`. Table / column
          // are enforced via allowlist; webPageId is parameterized.
          const [
            sectionEmbDbCount,
            sectionVisualEmbDbCount,
            partTextEmbDbCount,
            partVisualEmbDbCount,
            motionEmbDbCount,
            bgEmbDbCount,
            jsAnimationEmbDbCount,
            responsiveEmbDbCount,
          ] = await Promise.all([
            countNonNullVector({
              prisma,
              table: "section_embeddings",
              column: "text_embedding",
              joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
              webPageIdColumn: "sp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "section_embeddings",
              column: "vision_embedding",
              joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
              webPageIdColumn: "sp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "component_part_embeddings",
              column: "text_embedding",
              joinFragment: "JOIN component_parts cp ON t.component_part_id = cp.id",
              webPageIdColumn: "cp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "component_part_embeddings",
              column: "visual_embedding",
              joinFragment: "JOIN component_parts cp ON t.component_part_id = cp.id",
              webPageIdColumn: "cp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            prisma.motionEmbedding.count({
              where: { motionPattern: { webPageId: state.actualWebPageId } },
            }),
            prisma.backgroundDesignEmbedding.count({
              where: { backgroundDesign: { webPageId: state.actualWebPageId } },
            }),
            prisma.jSAnimationEmbedding.count({
              where: { jsAnimationPattern: { webPageId: state.actualWebPageId } },
            }),
            prisma.responsiveAnalysisEmbedding.count({
              where: { responsiveAnalysis: { webPageId: state.actualWebPageId } },
            }),
          ]);

          if (!results.embedding) {
            results.embedding = {};
          }

          const reconcile = (
            field: keyof NonNullable<typeof results.embedding>,
            dbCount: number,
            label: string
          ): void => {
            const reported = (results.embedding![field] as number | undefined) ?? 0;
            if (dbCount > reported) {
              (results.embedding as Record<string, number>)[field] = dbCount;
              logger.warn(`[PageAnalyzeWorker] ${label} embedding counter reconciled from DB`, {
                dbCount,
                reportedCount: reported,
                url,
              });
            }
          };

          // PR5: 9 カテゴリ reconciliation / 9-category reconciliation
          reconcile("sectionEmbeddingsGenerated", sectionEmbDbCount, "Section");
          reconcile("sectionVisualEmbeddingsGenerated", sectionVisualEmbDbCount, "SectionVisual");
          reconcile("partEmbeddingsGenerated", partTextEmbDbCount, "PartText");
          reconcile("partVisualEmbeddingsGenerated", partVisualEmbDbCount, "PartVisual");
          reconcile("motionEmbeddingsGenerated", motionEmbDbCount, "Motion");
          reconcile("backgroundDesignEmbeddingsGenerated", bgEmbDbCount, "Background");
          reconcile("jsAnimationEmbeddingsGenerated", jsAnimationEmbDbCount, "JsAnimation");
          reconcile("responsiveEmbeddingsGenerated", responsiveEmbDbCount, "Responsive");

          // PR2 (v0.4.0): IPC race で silent-skip を誤検知した場合の補正。
          // DB reconciliation で実際には embedding が書き込まれていたと判明
          // した場合、failedPhases から embedding を取り除いて
          // completedPhases に移す。results.embedding.skipReason も削除。
          //
          // PR2 (v0.4.0): Correct a false silent-skip caused by IPC race.
          // If DB reconciliation found embeddings were actually written,
          // move "embedding" from failedPhases to completedPhases and clear
          // the skipReason surfaced earlier.
          //
          // PR5 (v0.4.0): 9 カテゴリの合計で判定。
          // PR5 (v0.4.0): Decision based on 9-category sum.
          const dbTotal =
            sectionEmbDbCount +
            sectionVisualEmbDbCount +
            partTextEmbDbCount +
            partVisualEmbDbCount +
            motionEmbDbCount +
            bgEmbDbCount +
            jsAnimationEmbDbCount +
            responsiveEmbDbCount;
          if (
            dbTotal > 0 &&
            state.failedPhases.includes("embedding" as AnalysisPhase) &&
            !state.completedPhases.includes("embedding" as AnalysisPhase)
          ) {
            state.failedPhases = state.failedPhases.filter(
              (p) => p !== ("embedding" as AnalysisPhase)
            );
            state.completedPhases.push("embedding" as AnalysisPhase);
            if (results.embedding) {
              delete results.embedding.skipReason;
              delete results.embedding.skipDetail;
            }
            observedSkipReason = undefined;
            observedSkipDetail = undefined;
            logger.info(
              "[PageAnalyzeWorker] Silent-skip misdetection corrected via DB reconciliation (PR2)",
              {
                dbTotal,
                webPageId: state.actualWebPageId.slice(0, 8) + "...",
                url,
              }
            );
          }
        }

        // Log AFTER Counter Reconciliation so values reflect DB-authoritative counts
        {
          const emb = results.embedding;
          await job.log(
            `[Phase 5] Embedding complete: sections=${emb?.sectionEmbeddingsGenerated ?? 0}, parts=${emb?.partEmbeddingsGenerated ?? 0}, visual=${emb?.sectionVisualEmbeddingsGenerated ?? 0}, motion=${emb?.motionEmbeddingsGenerated ?? 0}, bg=${emb?.backgroundDesignEmbeddingsGenerated ?? 0}`
          );
        }
      }
    }

    // =====================================================
    // PR4 (v0.4.0): Queue-based Backfill 投入
    // PR4 (v0.4.0): Queue-based Backfill enqueue
    //
    // 100 件を超える Part を持つページでは、Phase 5 は先頭 100 件のみを同期処理
    // している。残余を `embedding-backfill` Queue に投入して非同期にバックフィルする。
    // 100 件以下のページでは threshold 未達なので何も投入しない。
    // screenshot 永続化パスが未保存 (PR1 前の旧データ) の場合は `part_visual` のみスキップ。
    //
    // For pages with more than 100 Parts, Phase 5 has processed only the first 100
    // synchronously. Enqueue the remainder on the `embedding-backfill` Queue for
    // asynchronous backfill. Pages with ≤ 100 Parts are below the threshold and
    // nothing is enqueued. If the persisted screenshot path is missing (legacy data
    // before PR1), only `part_visual` is skipped.
    // =====================================================
    let backfillEnqueuedCategories: EmbeddingBackfillCategory[] = [];
    if (state.actualWebPageId && partsSavedCountForPhase5 > PART_SYNC_THRESHOLD) {
      // Persisted screenshot path を DB から取得（PR1 で保存済みなら非 null）
      // Fetch persisted screenshot path from DB (non-null if saved by PR1)
      let persistedScreenshotPath: string | undefined;
      try {
        const webPageRow = await prisma.webPage.findUnique({
          where: { id: state.actualWebPageId },
          select: { screenshotStoragePath: true },
        });
        if (webPageRow?.screenshotStoragePath) {
          persistedScreenshotPath = webPageRow.screenshotStoragePath;
        }
      } catch (fetchError) {
        logger.warn(
          "[PageAnalyzeWorker] Failed to fetch screenshotStoragePath for backfill dispatch",
          {
            error: sanitizeErrorMessage(fetchError),
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
          }
        );
      }

      // v0.4.0 PR7e-α (バグ⑥): section_visual を backfill 対象に追加。
      // sectionsSavedCount は sectionSaveResult.idMapping.size (Phase 1 で
      // 保存した section 数) から取得。screenshotStoragePath と組み合わせて
      // SectionVisualProcessor が DINOv2 でベクトル再生成する条件となる。
      //
      // v0.4.0 PR7e-α (bug ⑥): pass sectionsSavedCount (from Phase 1's
      // sectionSaveResult.idMapping.size) so the Backfill Worker can enqueue
      // `section_visual` jobs for DINOv2 vision_embedding regeneration.
      const sectionsSavedCountForPhase5 = state.sectionSaveResult?.idMapping?.size ?? 0;
      backfillEnqueuedCategories = await dispatchBackfillJobsForPage({
        webPageId: state.actualWebPageId,
        url,
        partsSavedCount: partsSavedCountForPhase5,
        sectionsSavedCount: sectionsSavedCountForPhase5,
        screenshotStoragePath: persistedScreenshotPath,
      });

      if (backfillEnqueuedCategories.length > 0) {
        // backfill 投入済みなので status を `queued` に遷移させる
        // Transition status to `queued` since backfill jobs are enqueued
        await updateEmbeddingBackfillStatus(state.actualWebPageId, "queued", {
          url,
          reason: undefined,
        });
        await job.log(
          `[Phase 5] Enqueued backfill jobs: categories=${backfillEnqueuedCategories.join(",")}, ` +
            `partsSaved=${partsSavedCountForPhase5}, syncProcessed=${PART_SYNC_THRESHOLD}`
        );
        logger.info("[PageAnalyzeWorker] Enqueued embedding backfill jobs", {
          webPageId: state.actualWebPageId.slice(0, 8) + "...",
          categories: backfillEnqueuedCategories,
          partsSavedCount: partsSavedCountForPhase5,
          syncProcessed: PART_SYNC_THRESHOLD,
        });

        // PR5 (v0.4.0): MCP response に backfillPending を埋める。
        // PR6 TDA TD-3: pure builder (`buildBackfillPending`) に抽出し worker 本体を薄く保つ。
        //
        // PR5 (v0.4.0): Populate `backfillPending` on the MCP response.
        // PR6 TDA TD-3: extracted to pure builder (`buildBackfillPending`) to keep
        // the worker thin.
        const backfillPending = buildBackfillPending({
          partsSaved: partsSavedCountForPhase5,
          threshold: PART_SYNC_THRESHOLD,
          avgMsPerItem: BACKFILL_AVG_MS_PER_ITEM,
          webPageId: state.actualWebPageId,
          enqueuedTextCategory: backfillEnqueuedCategories.includes("part_text"),
          enqueuedVisualCategory: backfillEnqueuedCategories.includes("part_visual"),
          // v0.4.0 PR7e-α (バグ⑥): section_visual backfill dispatch の有無を伝搬
          // v0.4.0 PR7e-α (bug ⑥): propagate section_visual dispatch status
          enqueuedSectionVisualCategory: backfillEnqueuedCategories.includes("section_visual"),
        });

        if (backfillPending) {
          const backfillResults = state.results!;
          if (!backfillResults.embedding) {
            backfillResults.embedding = {};
          }
          backfillResults.embedding.backfillPending = backfillPending;
        }
      }
    }

    // =====================================================
    // PR2 (v0.4.0): web_pages.embeddingBackfillStatus を更新 + skipReason を
    // response に埋める。memoryAbort パスなど `if (embeddingEnabled)` ブロックを
    // 経由しなかった場合の skipReason 露出もここで処理する。
    //
    // PR2 (v0.4.0): Update web_pages.embeddingBackfillStatus and surface the
    // skipReason on the response. Also handles paths that bypassed the
    // `if (embeddingEnabled)` block (e.g. memoryAbort) so skipReason is
    // still emitted.
    //
    // 以下のすべてのパス（memoryAbort / embeddingEnabled=false / 正常完了 /
    // silent skip / 例外）を網羅するため、Phase 5 ブロックの外側で一括で更新する。
    // 値は `skipReasonToBackfillStatus()` が EmbeddingSkipReason から導出する。
    // skipReason が未設定 = 'not_required'（デフォルト）のまま維持。
    //
    // Unified update outside the Phase 5 block to cover all paths:
    // memoryAbort / embeddingEnabled=false / normal completion / silent skip
    // / exception. The status is derived from EmbeddingSkipReason via
    // `skipReasonToBackfillStatus()`. When skipReason is unset, the column
    // stays at its default 'not_required'.
    // =====================================================
    if (observedSkipReason !== undefined) {
      // Ensure results.embedding.skipReason is populated even on paths
      // that bypassed the `if (embeddingEnabled)` block.
      const embeddingResults = state.results!;
      if (!embeddingResults.embedding) {
        embeddingResults.embedding = {};
      }
      if (embeddingResults.embedding.skipReason === undefined) {
        embeddingResults.embedding.skipReason = observedSkipReason;
        if (observedSkipDetail !== undefined) {
          embeddingResults.embedding.skipDetail = observedSkipDetail;
        }
      }

      const backfillStatus = skipReasonToBackfillStatus(observedSkipReason);
      await updateEmbeddingBackfillStatus(state.actualWebPageId, backfillStatus, {
        url,
        reason: observedSkipReason,
      });

      // v0.4.0 PR7b (ADR-0008 #2): Skip recovery — Phase 5 全体 skip 時に
      // 全 7 カテゴリを `embedding-backfill` Queue へ enqueue する。
      // `not_required`（no_embeddable_items）は recovery 不要、
      // `failed`（dispatch_phase_failed の最終分類）も recovery 対象外。
      // recovery 対象は `skipped_fork_error` / `skipped_memory_pressure` のみ。
      //
      // v0.4.0 PR7b (ADR-0008 #2): Skip recovery — enqueue all 7 categories on
      // full Phase 5 skip. `not_required` (no_embeddable_items) needs no
      // recovery; `failed` (final dispatch_phase_failed classification) is not
      // recovery-eligible. Only `skipped_fork_error` / `skipped_memory_pressure`
      // trigger recovery.
      if (backfillStatus === "skipped_fork_error" || backfillStatus === "skipped_memory_pressure") {
        // Persisted screenshot path を DB から取得（part_visual / section_visual で必須）
        // Fetch persisted screenshot path from DB (required for part_visual / section_visual)
        let persistedScreenshotPath: string | undefined;
        try {
          const webPageRow = await prisma.webPage.findUnique({
            where: { id: state.actualWebPageId },
            select: { screenshotStoragePath: true },
          });
          if (webPageRow?.screenshotStoragePath) {
            persistedScreenshotPath = webPageRow.screenshotStoragePath;
          }
        } catch (fetchError) {
          logger.warn(
            "[PageAnalyzeWorker] Failed to fetch screenshotStoragePath for skip recovery",
            {
              error: sanitizeErrorMessage(fetchError),
              webPageId: state.actualWebPageId.slice(0, 8) + "...",
            }
          );
        }

        const recoveryResult = await dispatchSkipRecoveryBackfill({
          webPageId: state.actualWebPageId,
          url,
          skipReason: observedSkipReason,
          backfillStatus,
          screenshotStoragePath: persistedScreenshotPath,
        });

        await job.log(
          `[Phase 5 Skip Recovery] enqueued=${recoveryResult.enqueuedCategories.length}, ` +
            `categories=${recoveryResult.enqueuedCategories.join(",") || "none"}, ` +
            `reason=${recoveryResult.reason ?? "ok"}`
        );

        // PR7b (ADR-0008 #7): MCP response に `skip_recovery` variant を埋める。
        // enqueue が 1 件以上成功した場合のみ payload を付与する（0 件時は
        // backfillPending を返さず、cron が後続 recovery を担う）。
        //
        // PR7b (ADR-0008 #7): Attach the `skip_recovery` variant to the MCP
        // response only when at least one category was successfully enqueued.
        // When 0 were enqueued, no backfillPending is surfaced (cron takes over).
        if (
          recoveryResult.enqueuedCategories.length > 0 &&
          recoveryResult.retryCountAfter !== undefined &&
          recoveryResult.enqueuedAt !== undefined
        ) {
          const skipRecoveryPending = buildSkipRecoveryBackfillPending({
            skipReason: observedSkipReason,
            enqueuedCategories: recoveryResult.enqueuedCategories,
            retryCount: recoveryResult.retryCountAfter,
            enqueuedAt: recoveryResult.enqueuedAt,
          });

          const recoveryResults = state.results!;
          if (!recoveryResults.embedding) {
            recoveryResults.embedding = {};
          }

          // ADR-0008 Semantics Table: `sync_overflow` と `skip_recovery` は
          // 両立不能。万一既に sync_overflow payload が付与されていた場合は
          // invariant violation として debug.log に記録し、skip_recovery で
          // 上書きする（Phase 5 全体 skip が発生している = overflow は観測不能）。
          //
          // ADR-0008 Semantics Table: `sync_overflow` and `skip_recovery` are
          // mutually exclusive. If a sync_overflow payload was somehow already
          // attached, log the invariant violation via debug.log and overwrite
          // with skip_recovery (full Phase 5 skip means overflow is impossible).
          if (
            isBackfillPendingSourceConflict(
              recoveryResults.embedding.backfillPending,
              skipRecoveryPending
            )
          ) {
            logger.warn(
              "[PageAnalyzeWorker] ADR-0008 invariant violation: " +
                "sync_overflow + skip_recovery both present; overwriting with skip_recovery",
              {
                webPageId: state.actualWebPageId.slice(0, 8) + "...",
                existingSource: recoveryResults.embedding.backfillPending?.source,
                skipReason: observedSkipReason,
              }
            );
          }

          recoveryResults.embedding.backfillPending = skipRecoveryPending;
        }
      }
    }

    // GPU Resource Manager: Release GPU resources for next job's Vision phase
    try {
      await gpuResourceManager.release();
    } catch (gpuError) {
      logger.warn("[PageAnalyzeWorker] GPU release failed (non-fatal)", {
        error: gpuError instanceof Error ? gpuError.message : String(gpuError),
      });
    }

    // =====================================================
    // Memory Cleanup: Release all remaining intermediate data
    // All analysis and embedding phases are complete; release large
    // objects before building the final result.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      state.layoutResultForNarrative = null;
      state.motionResultForEmbedding = null;
      state.scrollVisionResultForEmbedding = null;
      state.jsAnimationsForEmbedding = null;
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Embedding final cleanup", {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
          releasedRefs: [
            "layoutResultForNarrative",
            "motionResultForEmbedding",
            "scrollVisionResultForEmbedding",
            "jsAnimationsForEmbedding",
          ],
        });
      }
    }

    // =====================================================
    // Finalize
    // =====================================================
    statusTracker.startPhase("finalizing");

    const processingTimeMs = Date.now() - startTime;
    const success = state.failedPhases.length === 0;
    const partialSuccess = !success && state.completedPhases.length > 0;

    // =====================================================
    // Update analysisStatus in DB (success/partial success path)
    // Phase 0 で "pending" に設定された analysisStatus を完了状態に更新する。
    // Product API の section-types/patterns クエリは analysis_status = 'completed' で
    // フィルタするため、この更新がないと分析済みページが表示されない。
    //
    // v0.4.0 PR7e-α (バグ④): PhasedDbHandler.markAnalysisCompleted() に委譲し、
    // `analysis_phase_status` / `last_analyzed_phase` / `analysis_completed_at`
    // も同時に更新する。success=true のとき phase_status='completed'、
    // 部分成功では最終到達フェーズを維持する (PhasedDbHandler 内部で判断)。
    //
    // v0.4.0 PR7e-α (bug ④): delegate to PhasedDbHandler.markAnalysisCompleted()
    // so `analysis_phase_status` / `last_analyzed_phase` / `analysis_completed_at`
    // also advance. On full success phase_status='completed'; on partial
    // success the last reached phase is preserved (PhasedDbHandler internal).
    // =====================================================
    if (phasedDb) {
      try {
        await phasedDb.markAnalysisCompleted(success);
      } catch (phasedDbError) {
        logger.warn(
          "[PageAnalyzeWorker] PhasedDbHandler.markAnalysisCompleted failed (non-fatal)",
          {
            error: sanitizeErrorMessage(phasedDbError),
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
          }
        );
      }
    } else {
      // PhasedDbHandler が初期化できなかった場合の fallback。従来と同じ inline 更新。
      // Fallback when PhasedDbHandler could not be initialised — legacy inline update.
      try {
        await prisma.webPage.update({
          where: { id: state.actualWebPageId },
          data: {
            analysisStatus: "completed",
            analysisCompletedAt: new Date(),
          },
        });
      } catch (statusError) {
        logger.warn("[PageAnalyzeWorker] Failed to update analysisStatus to completed", {
          error: sanitizeErrorMessage(statusError),
          webPageId: state.actualWebPageId.slice(0, 8) + "...",
        });
      }
    }

    statusTracker.completePhase("finalizing");

    const result: PageAnalyzeJobResult = {
      webPageId: state.actualWebPageId, // v0.1.0: 実際のDB IDを返す
      success,
      partialSuccess,
      completedPhases: state.completedPhases,
      failedPhases: state.failedPhases,
      processingTimeMs,
      completedAt: new Date().toISOString(),
    };

    // Add results only if there are any (avoid undefined assignment with exactOptionalPropertyTypes)
    if (state.results && Object.keys(state.results).length > 0) {
      result.results = state.results;
    }

    // =====================================================
    // Phase 7.5: Post-Analysis Gate (v0.3.0 Tier 2)
    // =====================================================
    // Phase 7.5a: Accessibility Audit (opt-in)
    // state.html is sanitized in Phase 0 (sanitizeHtml in phase-0-ingest.ts L176)
    // but released after Phase 4. Fetch from DB if needed.
    if (success && options?.accessibilityOptions?.enabled === true) {
      let a11yHtml = state.html;
      if (!a11yHtml && state.actualWebPageId) {
        try {
          const webPage = await prisma.webPage.findUnique({
            where: { id: state.actualWebPageId },
            select: { htmlContent: true },
          });
          a11yHtml = webPage?.htmlContent ?? null;
        } catch {
          // DB fetch failure is non-fatal
        }
      }
      try {
        const a11yOpts = {
          enabled: true as const,
          level: (options.accessibilityOptions?.level ?? "AA") as "A" | "AA" | "AAA",
          include_contrast: options.accessibilityOptions?.include_contrast ?? true,
          save_to_db: options.accessibilityOptions?.save_to_db ?? true,
        };
        const a11yResult = a11yHtml
          ? await handleAccessibilityPhase({
              accessibilityOptions: a11yOpts,
              sanitizedHtml: a11yHtml,
              warnings: [],
            })
          : undefined;
        if (a11yResult && state.results) {
          (state.results as Record<string, unknown>).accessibility = a11yResult;
          state.completedPhases.push("accessibility" as AnalysisPhase);
        }
      } catch (a11yError) {
        logger.warn("[PageAnalyzeWorker] Phase 7.5a accessibility failed (non-fatal)", {
          error: a11yError instanceof Error ? a11yError.message : String(a11yError),
        });
      }
    }

    // Phase 7.5b: Performance Evaluation (opt-in)
    if (success && options?.performanceOptions?.enabled === true) {
      try {
        const perfOpts = {
          enabled: true as const,
          include_screenshots: options.performanceOptions?.include_screenshots ?? false,
          save_to_db: options.performanceOptions?.save_to_db ?? true,
          ...(options.performanceOptions?.budget
            ? { budget: options.performanceOptions.budget }
            : {}),
        };
        const perfResult = await handlePerformancePhase({
          performanceOptions: perfOpts,
          url,
          warnings: [],
        });
        if (perfResult && state.results) {
          (state.results as Record<string, unknown>).performance = perfResult;
          state.completedPhases.push("performance" as AnalysisPhase);
        }
      } catch (perfError) {
        logger.warn("[PageAnalyzeWorker] Phase 7.5b performance failed (non-fatal)", {
          error: perfError instanceof Error ? perfError.message : String(perfError),
        });
      }
    }

    // Phase 7.5c: Auto-Snapshot (opt-in)
    // page.analyze 完了後にデザインスナップショットを自動生成
    // Auto-create design snapshot after successful page.analyze
    if (success && options?.autoSnapshot === true) {
      try {
        const snapshotResult = await createDesignSnapshot(state.actualWebPageId);
        if (snapshotResult.success) {
          logger.info("[PageAnalyzeWorker] Auto-snapshot created", {
            snapshotId: snapshotResult.snapshot_id?.slice(0, 8) + "...",
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
            sectionCount: snapshotResult.section_count,
          });
        } else {
          logger.warn("[PageAnalyzeWorker] Auto-snapshot failed (non-fatal)", {
            error: snapshotResult.error,
          });
        }
      } catch (snapshotError) {
        // Auto-snapshot failure is non-fatal — do not affect job result
        logger.warn("[PageAnalyzeWorker] Auto-snapshot error (non-fatal)", {
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
      }
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Job completed", {
        jobId: job.id,
        requestedWebPageId: webPageId,
        actualWebPageId: state.actualWebPageId,
        success,
        partialSuccess,
        completedPhases: state.completedPhases,
        failedPhases: state.failedPhases,
        processingTimeMs,
      });
    }

    // =====================================================
    // Memory-Gated Exit (post-job) (v0.4.0 PR7e-β2 hotfix)
    // =====================================================
    // RSS 閾値超過時は process.exit(0) → WorkerSupervisor 再起動。未満時は no-op で
    // BullMQ mainLoop が自然に次ジョブを fetch する。pause/resume は BullMQ 5.66.5
    // Worker.resume() の silent no-op race を避けるため削除済み（ADR-0009 参照）。
    // `moveToCompleted` Lua による fetchNext=false 保証と併用するため、本ヘルパー
    // は concurrency に対して中立。
    //
    // Exits on RSS threshold breach so WorkerSupervisor restarts, otherwise no-op —
    // the BullMQ mainLoop fetches the next job naturally. pause/resume were removed
    // to avoid the BullMQ 5.66.5 `Worker.resume()` silent no-op race (see ADR-0009).
    // Combined with the `moveToCompleted` Lua fetchNext=false guarantee, this helper
    // is concurrency-neutral.
    await applyPostJobMemoryGate(_preReturnPauseEnabled, "[PageAnalyzeWorker]");

    return result;
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error("[PageAnalyzeWorker] Job failed with exception", {
      jobId: job.id,
      webPageId,
      error: errorMessage,
      processingTimeMs,
    });

    // =====================================================
    // Update analysisStatus to "failed" in DB
    // Phase 0 で "pending" に設定された analysisStatus を失敗状態に更新する。
    // actualWebPageId が設定されている場合のみ更新（Phase 0 前の失敗では未設定の可能性）。
    //
    // v0.4.0 PR7e-α (バグ④): PhasedDbHandler.markAnalysisFailed() に委譲し、
    // analysis_phase_status='failed' + analysis_error + analysis_completed_at
    // を一括更新する。PhasedDbHandler 未初期化時は従来の inline update に
    // フォールバックする。
    //
    // v0.4.0 PR7e-α (bug ④): delegate to PhasedDbHandler.markAnalysisFailed()
    // so `analysis_phase_status='failed'` + `analysis_error` +
    // `analysis_completed_at` all update. Falls back to inline update when
    // PhasedDbHandler is unavailable.
    // =====================================================
    if (state.actualWebPageId) {
      const errorMessage = sanitizeErrorMessage(error).slice(0, 500);
      if (phasedDb) {
        try {
          await phasedDb.markAnalysisFailed(errorMessage);
        } catch (statusError) {
          logger.warn("[PageAnalyzeWorker] PhasedDbHandler.markAnalysisFailed failed (non-fatal)", {
            error: sanitizeErrorMessage(statusError),
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
          });
        }
      } else {
        try {
          await prisma.webPage.update({
            where: { id: state.actualWebPageId },
            data: {
              analysisStatus: "failed",
              analysisError: errorMessage,
              analysisCompletedAt: new Date(),
            },
          });
        } catch (statusError) {
          logger.warn("[PageAnalyzeWorker] Failed to update analysisStatus to failed", {
            error: sanitizeErrorMessage(statusError),
            webPageId: state.actualWebPageId.slice(0, 8) + "...",
          });
        }
      }
    }

    // Note: failure path では pause(true) を呼ばない。
    // success path の pause は 'completed' → IPC 'job-completed' → 計画的再起動の
    // フローで安全だが、failure path では 'failed' イベントが IPC を送信しないため、
    // pause すると Worker が永久停止する。autorun: false で起動時レースは防止済み。
    // Re-throw to let BullMQ record the failure
    // Note: BullMQ will capture the error message from the thrown error
    throw error;
  } finally {
    // Always stop the lock extender to prevent leaked intervals
    lockExtender.stop();
    // SEC-L1: Defensive cleanup - release capture buffers on any exit path
    state.scrollVisionCapturesForDeferred = null;

    // v0.4.0 PR7d-1 (ADR-0010): Phase 5 Screenshot は永続化パスに保存され、
    //   削除経路は GDPR `data.delete` + PR6 TTL cron の 2 経路に集約。
    //   finally では in-memory 参照の null 化のみ行う（delete は throw しないので
    //   try/catch 不要）。
    //
    // v0.4.0 PR7d-1 (ADR-0010): Screenshots are persisted; deletion is
    //   consolidated into GDPR `data.delete` + PR6 TTL cron. In finally we
    //   only null-out the in-memory reference (`delete` cannot throw, so no
    //   try/catch needed).
    if (state.screenshotPngPath) {
      delete state.screenshotPngPath;
    }
  }
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create a PageAnalyzeWorker instance
 *
 * @param options - Worker configuration options
 * @returns Worker instance with lifecycle methods
 */
export function createPageAnalyzeWorker(
  options: PageAnalyzeWorkerOptions = {}
): PageAnalyzeWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info("[PageAnalyzeWorker] Creating worker", {
      queueName: PAGE_ANALYZE_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<PageAnalyzeJobData, PageAnalyzeJobResult>(
    PAGE_ANALYZE_QUEUE_NAME,
    processPageAnalyzeJob,
    {
      // BullMQ 公式必須: Worker 接続では `maxRetriesPerRequest: null` を強制する
      // (BZPOPMIN blocking command が N 回失敗で中断されるのを防ぐ)。
      // https://docs.bullmq.io/guide/connections / taskforcesh/bullmq#2466
      // BullMQ requires `maxRetriesPerRequest: null` for Worker connections
      // so that BZPOPMIN does not abort after N retries.
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: null,
      },
      // Explicit start from start-workers.ts after local initialization is complete.
      autorun: false,
      concurrency,
      lockDuration,
      // Stalled job settings (detect stuck jobs)
      // stalledInterval = lockDuration/4 to avoid false stall detection during legitimate long processing
      stalledInterval: Math.max(60000, Math.floor(lockDuration / 4)),
      maxStalledCount: 3, // Allow 3 stalls before failing (CPU-bound embedding phase may block event loop)
    }
  );

  // RSS gate は concurrency 非依存 (pause/resume 削除済み、ADR-0009 参照)

  // Event handlers for monitoring
  worker.on("completed", (job, result) => {
    if (verbose) {
      logger.info("[PageAnalyzeWorker] Job completed event", {
        jobId: job.id,
        webPageId: result.webPageId,
        success: result.success,
        partialSuccess: result.partialSuccess,
      });
    }

    // P1-D: Notify parent process (WorkerSupervisor) of job completion via IPC
    // This enables maxJobsBeforeRestart planned restarts for OOM prevention.
    //
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload now conforms to the
    // `WorkerIpcMessageSchema` SSOT (`apps/mcp-server/src/schemas/worker-ipc.schema.ts`).
    // The supervisor's `verifyWorkerIpcMessage` rejects any payload missing
    // `workerType` or `timestamp`, so the legacy `{type, jobId}` shape would
    // be discarded and the supervisor would never trigger a planned restart.
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload は SSOT スキーマに準拠する。
    // 旧形式 `{type, jobId}` は workerType / timestamp 欠落で fail-closed
    // 破棄されるため、必ず正規形式で emit する。
    try {
      process.send?.({
        type: "job-completed",
        workerType: "page",
        jobId: job.id,
        timestamp: Date.now(),
      });
    } catch {
      // IPC channel may be closed if parent is shutting down; non-fatal
    }
  });

  worker.on("failed", (job, error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[PageAnalyzeWorker] Job failed event", {
      jobId: job?.id,
      error: sanitizeErrorMessage(error),
    });
  });

  worker.on("error", (error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[PageAnalyzeWorker] Worker error", {
      error: sanitizeErrorMessage(error),
    });
  });

  // Stall recovery: Create a Queue instance for job access during stall handling
  const recoveryQueue = createPageAnalyzeQueue(redisConfig);

  // Build StalledJobAccessor for handleStalledJob DI
  const stalledJobAccessor: StalledJobAccessor = {
    getJob: async (stalledJobId: string) => {
      const job = await recoveryQueue.getJob(stalledJobId);
      if (!job || !job.id) return null;
      return {
        id: job.id,
        progress: typeof job.progress === "number" ? job.progress : 0,
        processedOn: job.processedOn,
        data: {
          webPageId: job.data?.webPageId ?? "",
          url: job.data?.url ?? "",
        },
        moveToFailed: async (err: Error, token: string, fetchNext?: boolean): Promise<void> => {
          await job.moveToFailed(err, token, fetchNext);
        },
        moveToCompleted: async (
          returnValue: unknown,
          token: string,
          fetchNext?: boolean
        ): Promise<void> => {
          await job.moveToCompleted(returnValue as PageAnalyzeJobResult, token, fetchNext);
        },
        getState: async (): Promise<string> => job.getState(),
      };
    },
  };

  // Enhanced stalled event handler: trigger custom recovery
  worker.on("stalled", (jobId) => {
    logger.warn("[PageAnalyzeWorker] Job stalled — triggering recovery", { jobId });
    // Fire-and-forget: recovery runs asynchronously, errors are logged inside handleStalledJob
    handleStalledJob(jobId, stalledJobAccessor)
      .then((result) => {
        if (result.success) {
          logger.info("[PageAnalyzeWorker] Stalled job recovery result", {
            jobId: result.jobId,
            action: result.action,
            category: result.category,
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("[PageAnalyzeWorker] Stalled job recovery error", { jobId, error: msg });
      });
  });

  // Build DI functions for periodic stall check (reuse from recoverOrphanedJobs pattern)
  const getActiveJobsFn = async (): Promise<OrphanedJobInfo[]> => {
    const activeJobs = await recoveryQueue.getJobs(["active"], 0, 100);
    return activeJobs
      .filter((job) => job.id !== undefined)
      .map((job) => ({
        jobId: job.id ?? "",
        state: "active",
        progress: typeof job.progress === "number" ? job.progress : 0,
        processedOn: job.processedOn,
        lockDurationMs: lockDuration,
        data: {
          webPageId: job.data?.webPageId ?? "",
          url: job.data?.url ?? "",
        },
      }));
  };

  const moveToFailedFn = async (failJobId: string, reason: string): Promise<void> => {
    const job = await recoveryQueue.getJob(failJobId);
    if (job) {
      await job.moveToFailed(new Error(reason), "0", false);
    }
  };

  const moveToCompletedFn = async (completeJobId: string): Promise<void> => {
    const job = await recoveryQueue.getJob(completeJobId);
    if (job) {
      await job.moveToCompleted(
        {
          webPageId: job.data?.webPageId ?? "",
          success: true,
          partialSuccess: true,
          completedPhases: [],
          failedPhases: [],
          processingTimeMs: 0,
          completedAt: new Date().toISOString(),
        },
        "0",
        false
      );
    }
  };

  // Startup recovery: recover orphaned jobs from previous crash/restart
  recoverOrphanedJobs(getActiveJobsFn, moveToFailedFn, moveToCompletedFn, lockDuration)
    .then((result) => {
      if (result.recoveredCount > 0) {
        logger.info("[PageAnalyzeWorker] Startup recovery completed", {
          recoveredCount: result.recoveredCount,
          failedCount: result.failedCount,
        });
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[PageAnalyzeWorker] Startup recovery failed (non-fatal)", { error: msg });
    });

  // Periodic stall check: independent of BullMQ's internal stalledInterval
  const periodicCheck = createPeriodicStallCheck(
    getActiveJobsFn,
    moveToFailedFn,
    moveToCompletedFn,
    { lockDurationMs: lockDuration }
  );

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info("[PageAnalyzeWorker] Closing worker");
      }
      isRunning = false;
      periodicCheck.stop();
      // Release GPU resources before closing worker
      try {
        await gpuResourceManager.release();
      } catch {
        // Release failure during shutdown is non-fatal
      }
      await recoveryQueue.close();
      // v0.4.0 PR4: lazy-init した backfill queue も close する
      // v0.4.0 PR4: close the lazy-initialized backfill queue as well
      if (_backfillQueue !== null) {
        try {
          await _backfillQueue.close();
        } catch {
          /* non-fatal during shutdown */
        }
        _backfillQueue = null;
      }
      await worker.close();
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info("[PageAnalyzeWorker] Pausing worker (no new jobs will be accepted)");
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports
// ============================================================================

// PR2 (v0.4.0): EMBEDDING_SKIP_REASONS を phases/types.ts から再エクスポート
// PR2 (v0.4.0): Re-export EMBEDDING_SKIP_REASONS from phases/types.ts
//   → 主たる export ブロックの前に置く（embedding-chunking テストの
//     lastIndexOf("export {") がこのブロックを見つけられるように）
//   → Placed before the primary export block so that the
//     lastIndexOf("export {") probe in embedding-chunking tests still
//     locates the primary block.
export { EMBEDDING_SKIP_REASONS } from "./phases/types";

export {
  processPageAnalyzeJob,
  checkMemoryPressure,
  tryGarbageCollect,
  createPhaseProgressInterpolator,
  generateJsAnimationTextRepresentation,
  createLockExtender,
  extendJobLock,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_EXTEND_INTERVAL,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  EMBEDDING_CHUNK_SIZE,
  // v0.4.0 PR7b: テスト用 export — disposePhase4Memory / SKIP_RECOVERY_RETRY_CAP
  // v0.4.0 PR7b: Test-only exports — disposePhase4Memory / SKIP_RECOVERY_RETRY_CAP
  disposePhase4Memory,
  SKIP_RECOVERY_RETRY_CAP,
};

// Re-export types from phases/types.ts for backward compatibility
export type {
  LockExtender,
  PageAnalyzeWorkerOptions,
  PageAnalyzeWorkerInstance,
  EmbeddingPhaseParams,
  EmbeddingPhaseResult,
  EmbeddingSkipReason,
  PipelineState,
  PhaseContext,
} from "./phases/types";
