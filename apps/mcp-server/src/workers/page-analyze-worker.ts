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
 * Architecture (v0.2.0+, Phase 1/3 parallelization):
 * This file is a thin orchestrator. Phase logic lives in ./phases/:
 *   phase-0-ingest.ts  — HTML ingest + WebPage DB save
 *   phase-1-layout.ts  — Layout Analysis + Part Extraction        ┐ Promise.all
 *   phase-3-quality.ts — Quality Evaluation                       ┘ (parallel)
 *   phase-2-motion.ts  — Scroll Vision + Motion Detection + Scroll Vision Analysis
 *   phase-4-narrative.ts — Narrative Analysis + Responsive Analysis
 *   phase-5-embedding.ts — Embedding Generation (text + visual)
 * Shared types/constants/helpers are in ./phases/types.ts.
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
import { performMemoryCheckAndExit } from "../services/worker-memory-monitor.service";
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
// Post-embedding backfill: DB-driven embedding gap detection and repair
import {
  backfillWebPageEmbeddings,
  checkWebPageEmbeddingCoverage,
} from "../services/embedding-backfill.service";
// Frame Analysis DB保存ヘルパー（同期/非同期モード共有）
import { saveFrameAnalysisToDb } from "../services/motion/frame-analysis-save.helper";

// ============================================================================
// Phase Module Imports (TDA-C1 refactoring)
// ============================================================================
import {
  type PipelineState,
  type PhaseContext,
  type PageAnalyzeWorkerOptions,
  type PageAnalyzeWorkerInstance,
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
} from "./phases/types";
import { processIngestPhase } from "./phases/phase-0-ingest";
import { processLayoutPhase } from "./phases/phase-1-layout";
import { processMotionPhase } from "./phases/phase-2-motion";
import { processQualityPhase } from "./phases/phase-3-quality";
import { processNarrativePhase } from "./phases/phase-4-narrative";
import { processEmbeddingPhase } from "./phases/phase-5-embedding";

// ============================================================================
// Embedding DI factories initialization
// ============================================================================
// Worker runs in a separate process; factories must be set before use
// Single shared ONNX session to prevent memory leak from repeated LayoutEmbeddingService creation
// P0-1: All embedding sub-phases (Section, Motion, Background, JSAnimation) share this singleton
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);
setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setBackgroundPrismaClientFactory(() => prisma as never);
setFramePrismaClientFactory(() => prisma as never);

// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え (singleton)
const gpuResourceManager = GpuResourceManager.getInstance();

// ============================================================================
// Pre-Return Pause: BullMQ moveToCompleted レースコンディション防止
// ============================================================================
//
// BullMQ v5 の moveToCompleted Lua スクリプトは fetchNext=true の場合、
// ジョブ完了と次のジョブ取得を1つのアトミック操作で行う。
// これにより Worker.on('completed') イベントが発火する前に次のジョブが
// active 状態に遷移してしまい、WorkerSupervisor の計画的再起動時に
// 新規ジョブが「ブラウザ閉鎖済み」エラーで失敗するレースコンディションが発生する。
//
// 解決: Processor内で return 前に worker.pause(true) を呼ぶことで
// BullMQ Worker.paused フラグを立て、fetchNext=false を保証する。
// worker.pause(doNotWaitActive=true) はProcessor内から安全に呼べる。
//
// WorkerSupervisor側では job-completed IPC で再起動をトリガーする従来の
// フローが維持され、shutdown処理中に新規ジョブが取得されることはない。
// ============================================================================

/**
 * Module-level reference to the BullMQ Worker instance.
 * Set by createPageAnalyzeWorker(), read by processPageAnalyzeJob().
 * This bridge enables the Processor to call worker.pause() before returning.
 */
let _workerInstanceRef: Worker<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;

/**
 * Whether pre-return pause is enabled (maxJobsBeforeRestart > 0).
 * Read from WORKER_MAX_JOBS_BEFORE_RESTART env var (default: 1).
 * When 0, pre-return pause is disabled (unlimited jobs per process).
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

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
// processPageAnalyzeJob — Thin Orchestrator
// ============================================================================

/**
 * Process a page analysis job by orchestrating phase modules.
 *
 * This function creates the pipeline state and context, then delegates
 * to extracted phase modules (phase-0 through phase-5) in sequence.
 * Phase 5 (Embedding) and post-embedding backfill remain inline because
 * they reference module-level singletons (_workerInstanceRef, gpuResourceManager)
 * and have a different API signature (EmbeddingPhaseParams + EmbeddingPhaseDeps).
 *
 * @param job - BullMQ job instance
 * @param token - BullMQ worker token for lock management
 * @returns Job result with completed/failed phases and analysis results
 */
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
      // Build detailed progress data for SSE consumers
      const progressData = {
        overallProgress: status.overallProgress,
        currentPhase: status.currentPhase,
        phases: status.phases,
        webPageId: status.webPageId,
        url: status.url,
        startedAt: status.startedAt.toISOString(),
        lastUpdatedAt: status.lastUpdatedAt.toISOString(),
        estimatedCompletion: status.estimatedCompletion?.toISOString(),
      };

      job.updateProgress(progressData).catch((err) => {
        logger.warn("[PageAnalyzeWorker] Failed to update job progress", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
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

  try {
    // =====================================================
    // Phase 0: Ingest (HTML取得) + Phase 0.5: WebPage DB Save
    // =====================================================
    const sharedBrowser = await processIngestPhase(state, ctx, {
      pageIngestAdapter,
      prisma,
    });

    // =====================================================
    // Phase 1 + Phase 3 並列実行 / Parallel Phase 1 + Phase 3
    // =====================================================
    // Phase 3 (Quality) は state.html のみに依存し、Phase 1 (Layout) の
    // 出力（layoutResultForNarrative, sectionSaveResult 等）を参照しない。
    // 両フェーズは PipelineState 内の異なるフィールドに書き込むため、
    // 同一オブジェクトへの同時書き込み競合は発生しない:
    //   Phase 1: layoutResultForNarrative, sectionSaveResult, bgSaveResult, results.layout
    //   Phase 3: memoryAborted, narrativePreDisabled, visionPreDisabled, results.quality
    // completedPhases/failedPhases への Array.push() は Node.js
    // シングルスレッドイベントループにおいて同期的に完了するため安全。
    // statusTracker は phase ごとに独立スロットを使用するため並列呼び出し安全。
    //
    // Phase 3 (Quality) depends only on state.html (set by Phase 0).
    // It does NOT read Phase 1 outputs (layoutResultForNarrative, sectionSaveResult, etc.).
    // Both phases write to distinct PipelineState fields, preventing concurrent
    // write conflicts. Array.push() on completedPhases/failedPhases is safe
    // in Node.js single-threaded event loop (synchronous completion).
    // statusTracker uses independent slots per phase, safe for parallel calls.
    await Promise.all([
      processLayoutPhase(state, ctx, {
        defaultAnalyzeLayout: defaultAnalyzeLayout as never,
        saveBackgroundDesigns,
        saveSectionPatterns,
        postProcessSections,
        extractPartsFromSection: extractPartsFromSection as never,
        saveExtractedParts: saveExtractedParts as never,
        prisma,
      }),
      processQualityPhase(state, ctx, {
        defaultEvaluateQuality: defaultEvaluateQuality as never,
        saveQualityEvaluation,
        saveQualityBenchmarks,
        buildQualityBenchmarkInputs,
        prisma,
      }),
    ]);

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
    // Memory Check 3: Before Phase 5 (Embedding)
    // Even under memory pressure, we want to attempt embedding generation
    // because it persists already-collected data to the DB.
    // Just log a warning for observability.
    // =====================================================
    {
      const memCheck3 = checkMemoryPressure();
      if (memCheck3.shouldAbort) {
        logger.warn(
          "[PageAnalyzeWorker] [Memory Critical] RSS high before embedding, attempting minimal save",
          {
            rssMb: memCheck3.rssMb,
            threshold: MEMORY_CRITICAL_THRESHOLD_MB,
            url,
          }
        );
      }
    }

    // =====================================================
    // Phase 5: Embedding Generation (delegated to processEmbeddingPhase)
    // =====================================================
    // Extend lock before Embedding phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding");

    const responsiveAnalysisIdForEmbedding = state.results?.responsive?.responsiveAnalysisId;
    const embeddingEnabled =
      state.actualWebPageId &&
      ((state.sectionSaveResult?.idMapping?.size ?? 0) +
        (state.motionSaveResult?.idMapping?.size ?? 0) +
        (state.jsSaveResult?.idMapping?.size ?? 0) +
        (state.bgSaveResult?.idMapping?.size ?? 0) +
        (state.scrollVisionSaveResult?.idMapping?.size ?? 0) >
        0 ||
        !!responsiveAnalysisIdForEmbedding ||
        (state.results?.partExtraction?.totalPartsSaved ?? 0) > 0);

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

      const embeddingPhaseResult = await processEmbeddingPhase(
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
          partsSavedCount: state.results?.partExtraction?.totalPartsSaved ?? 0,
          screenshotBase64: state.screenshotBase64,
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

      // Release screenshotBase64 after Phase 5 (visual embedding) completes
      // screenshotBase64はPhase 5のDINOv2 visual embedding完了後に解放
      state.screenshotBase64 = undefined;
      tryGarbageCollect();

      // Map embedding phase result back to job results
      // Safety: state.results is always initialized to {} in PipelineState construction (line ~315),
      // but the type is optional because PageAnalyzeJobResult.results is optional.
      // We assert non-null here since we know it's always set.
      const results = state.results!;

      if (
        embeddingPhaseResult.sectionEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.motionEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.bgEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.responsiveEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.partEmbeddingsGenerated > 0 ||
        embeddingPhaseResult.partVisualEmbeddingsGenerated > 0
      ) {
        const embeddingResult: NonNullable<PageAnalyzeJobResult["results"]>["embedding"] = {};
        if (embeddingPhaseResult.sectionEmbeddingsGenerated > 0) {
          embeddingResult!.sectionEmbeddingsGenerated =
            embeddingPhaseResult.sectionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0) {
          embeddingResult!.sectionVisualEmbeddingsGenerated =
            embeddingPhaseResult.sectionVisualEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.motionEmbeddingsGenerated > 0) {
          embeddingResult!.motionEmbeddingsGenerated =
            embeddingPhaseResult.motionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.bgEmbeddingsGenerated > 0) {
          embeddingResult!.backgroundDesignEmbeddingsGenerated =
            embeddingPhaseResult.bgEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0) {
          embeddingResult!.jsAnimationEmbeddingsGenerated =
            embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.responsiveEmbeddingsGenerated > 0) {
          embeddingResult!.responsiveEmbeddingsGenerated =
            embeddingPhaseResult.responsiveEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partEmbeddingsGenerated > 0) {
          embeddingResult!.partEmbeddingsGenerated = embeddingPhaseResult.partEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partVisualEmbeddingsGenerated > 0) {
          embeddingResult!.partVisualEmbeddingsGenerated =
            embeddingPhaseResult.partVisualEmbeddingsGenerated;
        }
        results.embedding = embeddingResult;
      }

      if (embeddingPhaseResult.completed) {
        state.completedPhases.push("embedding" as AnalysisPhase);
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_COMPLETE);

      // =====================================================
      // Post-Embedding Backfill: Detect and repair missing embeddings
      // If Phase 5 partially failed (OOM, memory pressure), some patterns
      // may have been saved to DB but lack embeddings. This step reads
      // from DB, generates embeddings in small chunks, and saves them back.
      // =====================================================
      {
        // Release all in-memory refs to minimize RSS before backfill
        // (backfill reads from DB, so pipeline data is no longer needed)
        state.layoutResultForNarrative = null;
        state.motionResultForEmbedding = null;
        state.jsAnimationsForEmbedding = null;
        state.scrollVisionResultForEmbedding = null;
        tryGarbageCollect();

        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-backfill");

        const coverage = await checkWebPageEmbeddingCoverage(state.actualWebPageId);
        const totalMissing = coverage.reduce((sum, c) => sum + c.missing, 0);

        if (totalMissing > 0) {
          logger.info("[PageAnalyzeWorker] Post-embedding backfill starting", {
            url,
            webPageId: state.actualWebPageId,
            totalMissing,
            coverage: coverage.map((c) => `${c.type}: ${c.embedded}/${c.total}`),
          });

          const backfillResult = await backfillWebPageEmbeddings(state.actualWebPageId, {
            chunkSize: 5,
            onProgress: (_type, _done, _total) => {
              // Extend lock on each progress update to prevent stall during backfill
              extendJobLock(job, effectiveToken, effectiveLockDuration, "backfill-progress").catch(
                () => {}
              );
            },
          });

          logger.info("[PageAnalyzeWorker] Post-embedding backfill completed", {
            url,
            totalBackfilled: backfillResult.totalBackfilled,
            sectionBackfilled: backfillResult.sectionBackfilled,
            motionBackfilled: backfillResult.motionBackfilled,
            backgroundBackfilled: backfillResult.backgroundBackfilled,
            jsAnimationBackfilled: backfillResult.jsAnimationBackfilled,
            responsiveBackfilled: backfillResult.responsiveBackfilled,
            errors: backfillResult.errors.length,
          });

          // Add backfill results to embedding phase counters
          if (embeddingPhaseResult) {
            embeddingPhaseResult.sectionEmbeddingsGenerated += backfillResult.sectionBackfilled;
            embeddingPhaseResult.motionEmbeddingsGenerated += backfillResult.motionBackfilled;
            embeddingPhaseResult.bgEmbeddingsGenerated += backfillResult.backgroundBackfilled;
            embeddingPhaseResult.jsAnimationEmbeddingsGenerated +=
              backfillResult.jsAnimationBackfilled;
            embeddingPhaseResult.responsiveEmbeddingsGenerated +=
              backfillResult.responsiveBackfilled;

            // Update results object with new totals
            if (backfillResult.totalBackfilled > 0) {
              if (!results.embedding) {
                results.embedding = {};
              }
              results.embedding.sectionEmbeddingsGenerated =
                embeddingPhaseResult.sectionEmbeddingsGenerated;
              results.embedding.motionEmbeddingsGenerated =
                embeddingPhaseResult.motionEmbeddingsGenerated;
              results.embedding.backgroundDesignEmbeddingsGenerated =
                embeddingPhaseResult.bgEmbeddingsGenerated;
              results.embedding.jsAnimationEmbeddingsGenerated =
                embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
              results.embedding.responsiveEmbeddingsGenerated =
                embeddingPhaseResult.responsiveEmbeddingsGenerated;
              results.embedding.partEmbeddingsGenerated =
                embeddingPhaseResult.partEmbeddingsGenerated;
            }
          }
        } else {
          logger.debug("[PageAnalyzeWorker] Post-embedding backfill: no missing embeddings", {
            url,
            webPageId: state.actualWebPageId,
          });
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
    statusTracker.completePhase("finalizing");

    const processingTimeMs = Date.now() - startTime;
    const success = state.failedPhases.length === 0;
    const partialSuccess = !success && state.completedPhases.length > 0;

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
    // Pre-return pause: fetchNext=false を保証してレースコンディション防止
    // =====================================================
    // BullMQ moveToCompleted Lua スクリプトは fetchNext=true だと
    // ジョブ完了と同時に次ジョブを取得する。worker.pause(true) で
    // Worker.paused フラグを立てることで fetchNext=false が保証され、
    // WorkerSupervisor の計画的再起動が安全に実行できる。
    if (_preReturnPauseEnabled && _workerInstanceRef) {
      try {
        await _workerInstanceRef.pause(true);
        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] Pre-return pause applied (fetchNext=false guaranteed)");
        }
      } catch (pauseError) {
        // pause失敗は致命的でない（WorkerSupervisor側のshutdownでフォールバック）
        logger.warn("[PageAnalyzeWorker] Pre-return pause failed (non-fatal)", {
          error: pauseError instanceof Error ? pauseError.message : String(pauseError),
        });
      }
    }

    // =====================================================
    // Post-job memory self-check (SEC監査 Low #2 対応)
    // =====================================================
    // WorkerSupervisorがジョブカウントで再起動するが、
    // メモリが閾値を超えた場合はワーカー自身でも graceful exit する。
    // これによりOOMキラーによる強制終了を防止する。
    // setImmediate で result を BullMQ に返却した後にチェックする。
    setImmediate(() => {
      performMemoryCheckAndExit();
    });

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
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
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

  // Set module-level reference for Processor→Worker bridge (pre-return pause)
  _workerInstanceRef = worker;

  // SEC-M1: Pre-return pause は concurrency=1 前提の設計。
  // concurrency > 1 では複数 Processor が同一 Worker に対して pause を呼ぶ可能性がある。
  // BullMQ の pause() は冪等であるため安全だが、設計意図として警告を出す。
  if (concurrency > 1 && _preReturnPauseEnabled) {
    logger.warn(
      "[PageAnalyzeWorker] Pre-return pause is designed for concurrency=1. " +
        "concurrency > 1 may cause unexpected pause timing.",
      { concurrency }
    );
  }

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
    // This enables maxJobsBeforeRestart planned restarts for OOM prevention
    try {
      process.send?.({ type: "job-completed", jobId: job.id });
    } catch {
      // IPC channel may be closed if parent is shutting down; non-fatal
    }
  });

  worker.on("failed", (job, error) => {
    logger.error("[PageAnalyzeWorker] Job failed event", {
      jobId: job?.id,
      error: error.message,
    });
  });

  worker.on("error", (error) => {
    logger.error("[PageAnalyzeWorker] Worker error", {
      error: error.message,
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
};

// Re-export types from phases/types.ts for backward compatibility
export type {
  LockExtender,
  PageAnalyzeWorkerOptions,
  PageAnalyzeWorkerInstance,
  EmbeddingPhaseParams,
  EmbeddingPhaseResult,
  PipelineState,
  PhaseContext,
} from "./phases/types";
