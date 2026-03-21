// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 1.5 (Scroll Vision Capture), Phase 2 (Motion Detection + DB saves),
 * Browser close cleanup, and Phase 2.5 (Scroll Vision Analysis).
 *
 * Extracted from page-analyze-worker.ts (TDA-C1) for phase-level modularity.
 *
 * Sub-phases:
 * 1. Phase 1.5: Scroll Vision Smart Capture (with sharedBrowser)
 * 2. GC cleanup after Layout + ScrollVision
 * 3. Phase 2: Motion Detection + DB saves (motion, jsAnimation, frameAnalysis)
 * 4. Browser close + GC
 * 5. Phase 2.5: Scroll Vision Analysis (GPU acquire, OllamaReadinessProbe, analyzeScrollCaptures, save)
 * 6. Release captures + GC
 * 7. Ollama Vision Unload (2nd point)
 *
 * @module workers/phases/phase-2-motion
 */

import type { Browser } from "playwright";

import { logger, isDevelopment } from "../../utils/logger";

// Scroll Vision Smart Capture
import type {
  captureScrollPositions,
  SectionBoundary,
} from "../../services/vision/scroll-vision-capture.service";
import type {
  analyzeScrollCaptures,
  ScrollVisionResult,
} from "../../services/vision/scroll-vision.analyzer";
import type {
  saveScrollVisionResults,
  ScrollVisionPrismaClient,
} from "../../services/vision/scroll-vision-persistence.service";
// P2-8: VRAM状態チェック（Phase 2.5実行前のReadiness Probe）
import { OllamaReadinessProbe } from "../../services/vision/ollama-readiness-probe";
// Frame Analysis DB保存ヘルパー（同期/非同期モード共有）
import type { saveFrameAnalysisToDb } from "../../services/motion/frame-analysis-save.helper";

// DB保存ロジック（MotionPattern, JSAnimationPattern）
import type {
  MotionPatternPrismaClient,
  JsAnimationPatternPrismaClient,
  SaveResult,
} from "../../services/worker-db-save.service";

// Handler types
import type {
  MotionServiceResult,
  MotionDetectionContext,
  IPageAnalyzePrismaClient,
  JSAnimationFullResult,
} from "../../tools/page/handlers/types";

// GPU Resource Manager type
import type { GpuResourceManager } from "../../services/gpu-resource-manager";

// Shared types, constants, and helpers from types.ts
import {
  type PipelineState,
  type PhaseContext,
  PHASE_PROGRESS,
  tryGarbageCollect,
  extendJobLock,
  createPhaseProgressInterpolator,
  unloadOllamaVisionModel,
} from "./types";

// ============================================================================
// Dependency Injection Interface
// ============================================================================

/**
 * Dependencies injected from the orchestrator (module-level singletons).
 *
 * processMotionPhase は元の page-analyze-worker.ts でモジュールレベルの
 * シングルトン (gpuResourceManager, pageIngestAdapter, prisma) を
 * 直接参照していた。Phase 抽出後はこのインターフェースを通じて注入する。
 *
 * Dependency injection interface for Phase 2 (Motion). The original code
 * referenced module-level singletons directly; after extraction, they are
 * injected via this interface.
 */
export interface MotionPhaseDeps {
  /**
   * Scroll Vision Smart Capture function.
   * Captures screenshots at section boundary scroll positions.
   */
  captureScrollPositions: typeof captureScrollPositions;

  /**
   * Default motion detection function (CSS + JS + WebGL hybrid detection).
   * Signature matches defaultDetectMotion from motion-handler.ts.
   */
  defaultDetectMotion: (
    html: string,
    url: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
    dbContext?: MotionDetectionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extendedContext?: any,
    preExtractedCssUrls?: string[],
    sharedBrowser?: Browser
  ) => Promise<MotionServiceResult>;

  /**
   * Scroll Vision analysis function (Ollama Vision LLM).
   * Deferred from Phase 1.5 to Phase 2.5 to avoid VRAM conflict.
   */
  analyzeScrollCaptures: typeof analyzeScrollCaptures;

  /** Save motion patterns to DB */
  saveMotionPatterns: (
    prisma: MotionPatternPrismaClient,
    webPageId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patterns: any[],
    sourceUrl: string
  ) => Promise<SaveResult>;

  /** Save JS animation patterns to DB */
  saveJsAnimationPatterns: (
    prisma: JsAnimationPatternPrismaClient,
    webPageId: string,
    jsAnimations: JSAnimationFullResult,
    sourceUrl: string
  ) => Promise<SaveResult>;

  /** Save scroll vision results to DB */
  saveScrollVisionResults: typeof saveScrollVisionResults;

  /** Save frame analysis results to DB */
  saveFrameAnalysisToDb: typeof saveFrameAnalysisToDb;

  /** GPU Resource Manager singleton for Vision/Embedding GPU switching */
  gpuResourceManager: GpuResourceManager;

  /**
   * PageIngestAdapter instance — only close() is used in this phase.
   * close() sets this.browser = null after closing.
   */
  pageIngestAdapter: {
    close: () => Promise<void>;
  };

  /** Prisma client for DB operations */
  prisma: {
    // Used as MotionPatternPrismaClient, JsAnimationPatternPrismaClient, ScrollVisionPrismaClient
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

// ============================================================================
// Phase 2: Motion (Phase 1.5 + Phase 2 + Phase 2.5)
// ============================================================================

/**
 * Phase 1.5 (Scroll Vision Capture), Phase 2 (Motion Detection + DB saves),
 * browser close cleanup, and Phase 2.5 (Scroll Vision Analysis).
 *
 * Mutates `state` with:
 * - motionResultForEmbedding, jsAnimationsForEmbedding
 * - motionSaveResult, jsSaveResult, scrollVisionSaveResult
 * - scrollVisionResultForEmbedding, scrollVisionCapturesForDeferred
 * - completedPhases / failedPhases
 * - results.motion, results.layout (scrollVision merge)
 *
 * @param state   Mutable pipeline state shared across phases
 * @param ctx     Immutable phase context (job, options, url, etc.)
 * @param sharedBrowser  Playwright Browser instance (shared with Phase 0/1)
 * @param deps    Injected dependencies (service functions, singletons)
 */
export async function processMotionPhase(
  state: PipelineState,
  ctx: PhaseContext,
  sharedBrowser: Browser,
  deps: MotionPhaseDeps
): Promise<void> {
  const { job, options, url, effectiveToken, effectiveLockDuration, statusTracker } = ctx;
  const {
    defaultDetectMotion,
    captureScrollPositions: captureScrollPositionsFn,
    analyzeScrollCaptures: analyzeScrollCapturesFn,
    saveMotionPatterns,
    saveJsAnimationPatterns,
    saveScrollVisionResults: saveScrollVisionResultsFn,
    saveFrameAnalysisToDb: saveFrameAnalysisToDbFn,
    gpuResourceManager,
    pageIngestAdapter,
    prisma,
  } = deps;
  const { actualWebPageId, completedPhases, failedPhases, layoutResultForNarrative } = state;
  // results is always initialized to {} by the orchestrator, but the type is optional.
  // Use non-null assertion via fallback to satisfy strict type checking.
  const results = state.results ?? {};

  // =====================================================
  // Phase 1.5: Scroll Vision Smart Capture
  // =====================================================
  // Extend lock before potentially long-running Scroll Vision phase
  await extendJobLock(job, effectiveToken, effectiveLockDuration, "scroll-vision");

  // Runs after layout analysis to use section boundary positions.
  // Only when: useVision=true AND scrollVision !== false AND layout succeeded with sections.
  const scrollVisionEnabled =
    options.layoutOptions?.useVision !== false &&
    options.layoutOptions?.scrollVision !== false &&
    completedPhases.includes("layout") &&
    layoutResultForNarrative?.sections &&
    Array.isArray(layoutResultForNarrative.sections) &&
    layoutResultForNarrative.sections.length > 0;

  if (scrollVisionEnabled) {
    await job.updateProgress(PHASE_PROGRESS.SCROLL_VISION_CAPTURE_START);

    try {
      const layoutSections = layoutResultForNarrative?.sections ?? [];

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Starting scroll vision capture (Phase 1.5)", {
          sectionCount: layoutSections.length,
          maxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
        });
      }

      // Extract section boundaries from layout result
      const sectionBoundaries: SectionBoundary[] = layoutSections
        .filter(
          (s: { position?: { startY: number; endY: number } }) =>
            s.position?.startY !== undefined && s.position?.endY !== undefined
        )
        .map((s: { position?: { startY: number; endY: number }; type?: string }, i: number) => ({
          sectionIndex: i,
          startY: s.position?.startY ?? 0,
          endY: s.position?.endY ?? 0,
          sectionType: s.type,
        }));

      if (sectionBoundaries.length >= 2) {
        // P0-2: Phase 1.5 captures only (browser required).
        // Vision analysis (Ollama) is deferred to Phase 2.5 after browser close
        // to avoid VRAM conflict (Chromium 2-4GB + Ollama 7.8GB > RTX 3060 12GB).
        const captureResult = await captureScrollPositionsFn(url, sectionBoundaries, {
          maxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
          waitAfterScrollMs: 800,
          viewport: options.layoutOptions?.viewport,
          sharedBrowser,
        });

        // Store captures for deferred analysis in Phase 2.5
        state.scrollVisionCapturesForDeferred = captureResult.captures;

        if (isDevelopment()) {
          logger.debug(
            "[PageAnalyzeWorker] Scroll vision capture completed (analysis deferred to Phase 2.5)",
            {
              capturedPositions: captureResult.captures.length,
            }
          );
        }
      } else {
        if (isDevelopment()) {
          logger.debug(
            "[PageAnalyzeWorker] Scroll vision skipped: insufficient section boundaries",
            {
              boundaryCount: sectionBoundaries.length,
            }
          );
        }
      }
    } catch (scrollVisionError) {
      // Graceful Degradation: Scroll Vision capture failure does NOT fail the overall job
      const errorMessage =
        scrollVisionError instanceof Error ? scrollVisionError.message : String(scrollVisionError);

      logger.warn("[PageAnalyzeWorker] Scroll vision capture failed (non-fatal)", {
        error: errorMessage,
      });
    }

    await job.updateProgress(PHASE_PROGRESS.SCROLL_VISION_CAPTURE_COMPLETE);
  }

  // =====================================================
  // Memory Cleanup: GC after Layout + ScrollVision phases
  // Layout/ScrollVision local variables (layoutResult, captureResult) are
  // block-scoped and already eligible for GC. Trigger collection now
  // before Motion phase allocates new buffers.
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Layout/ScrollVision GC", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
      });
    }
  }

  // =====================================================
  // Phase 2: Motion Detection
  // =====================================================
  if (options.features?.motion !== false) {
    statusTracker.startPhase("motion");
    await job.updateProgress(PHASE_PROGRESS.MOTION_START);

    try {
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Starting motion detection");
      }

      // Motion detection timeout: デフォルト3分、最大10分
      // MCP Protocol 60秒制限は async worker 内では適用されないため、長時間検出が可能
      const motionTimeout = Math.min(
        options.motionOptions?.timeout ?? 180000,
        600000 // 最大10分
      );

      const html = state.html ?? "";

      const motionResult = await defaultDetectMotion(
        html,
        url,
        {
          fetchExternalCss: true,
          maxPatterns: options.motionOptions?.maxPatterns ?? 100,
          // v0.1.0: WebGLサイト対応 - hybrid modeでCSS+ランタイム検出を実行
          detection_mode: "hybrid" as const,
          minDuration: 0,
          includeWarnings: true,
          enable_frame_capture: options.motionOptions?.enableFrameCapture ?? false,
          analyze_frames:
            (options.motionOptions?.enableFrameCapture ?? false) &&
            (options.motionOptions?.analyzeFrames ?? false),
          // v0.1.0: JSアニメーション検出を有効化
          detect_js_animations: options.motionOptions?.detectJsAnimations ?? true,
          // v0.1.0: WebGLアニメーション検出を有効化
          detect_webgl_animations: options.motionOptions?.detectWebglAnimations ?? true,
          saveToDb: options.motionOptions?.saveToDb ?? true,
          // v0.1.0: Motion検出タイムアウト（async workerでは長時間検出可能）
          timeout: motionTimeout,
          // video_options は完全なオブジェクトとして渡す（Zod output型に合わせる）
          video_options: {
            timeout: motionTimeout,
            record_duration: 5000,
            scroll_page: true,
            move_mouse: true,
            wait_until: "domcontentloaded" as const,
          },
        },
        {
          prisma: prisma as unknown as IPageAnalyzePrismaClient,
          webPageId: actualWebPageId,
          sourceUrl: url,
        } satisfies MotionDetectionContext,
        undefined,
        undefined,
        sharedBrowser
      );

      state.motionResultForEmbedding = motionResult;

      // Granular progress: motion detection complete (halfway through motion phase)
      await job.updateProgress(55);

      statusTracker.completePhase("motion");
      completedPhases.push("motion");
      const patternsDetected = motionResult.patterns?.length ?? 0;
      const jsAnimationsDetected = motionResult.js_animations?.totalDetected ?? 0;
      const webglCount = motionResult.webgl_animation_summary?.totalPatterns ?? 0;
      results.motion = {
        patternsDetected,
        jsAnimationsDetected,
        webglAnimationsDetected: webglCount > 0 ? webglCount : undefined,
      };

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Motion detection completed", {
          patternsDetected,
          jsAnimationsDetected,
          webglAnimationsDetected: webglCount > 0 ? webglCount : undefined,
        });
      }

      // MotionPattern DB保存
      if (actualWebPageId && motionResult.patterns && motionResult.patterns.length > 0) {
        try {
          state.motionSaveResult = await saveMotionPatterns(
            prisma as unknown as MotionPatternPrismaClient,
            actualWebPageId,
            motionResult.patterns,
            url
          );

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] MotionPatterns saved", {
              count: state.motionSaveResult.count,
              webPageId: actualWebPageId,
            });
          }
        } catch (motionSaveError) {
          // Graceful Degradation: MotionPattern保存失敗はジョブを中断しない
          logger.warn("[PageAnalyzeWorker] MotionPattern save failed", {
            error:
              motionSaveError instanceof Error ? motionSaveError.message : String(motionSaveError),
          });
        }
      }

      // JSAnimationPattern DB保存
      if (
        actualWebPageId &&
        motionResult.js_animations &&
        motionResult.js_animations.totalDetected > 0
      ) {
        state.jsAnimationsForEmbedding = motionResult.js_animations;

        // Path A (handler) で既に保存済みの場合はスキップ（double-save防止）
        // Path A は CDP + Web + Library パターンを保存するため、Path B より完全
        if (
          motionResult.jsSavedPatternCount !== undefined &&
          motionResult.jsSavedPatternCount > 0
        ) {
          state.jsSaveResult = {
            success: true,
            count: motionResult.jsSavedPatternCount,
            ids: [],
            idMapping: new Map(),
          };

          if (isDevelopment()) {
            logger.info(
              "[PageAnalyzeWorker] JSAnimationPatterns already saved by handler (Path A), skipping worker save",
              {
                savedCount: motionResult.jsSavedPatternCount,
                webPageId: actualWebPageId,
              }
            );
          }
        } else {
          // Path A が保存しなかった場合のフォールバック（Path B）
          try {
            state.jsSaveResult = await saveJsAnimationPatterns(
              prisma as unknown as JsAnimationPatternPrismaClient,
              actualWebPageId,
              motionResult.js_animations,
              url
            );

            if (isDevelopment()) {
              logger.info("[PageAnalyzeWorker] JSAnimationPatterns saved (Path B fallback)", {
                count: state.jsSaveResult.count,
                webPageId: actualWebPageId,
                cdpCount: motionResult.js_animations.cdpAnimations.length,
                webAnimCount: motionResult.js_animations.webAnimations.length,
              });
            }
          } catch (jsSaveError) {
            // Graceful Degradation: JSAnimationPattern保存失敗はジョブを中断しない
            logger.warn("[PageAnalyzeWorker] JSAnimationPattern save failed", {
              error: jsSaveError instanceof Error ? jsSaveError.message : String(jsSaveError),
            });
          }
        }
      }

      // Frame Analysis DB保存（analyze_frames=true かつ frame_analysis結果がある場合）
      if (actualWebPageId && motionResult.frame_analysis) {
        const frameAnalysisSaveResult = await saveFrameAnalysisToDbFn({
          frameAnalysis: motionResult.frame_analysis,
          frameCapture: motionResult.frame_capture,
          webPageId: actualWebPageId,
          sourceUrl: url,
        });

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] Frame analysis DB save result", {
            saved: frameAnalysisSaveResult.saved,
            error: frameAnalysisSaveResult.error,
            skipped: frameAnalysisSaveResult.skipped,
          });
        }
      }

      // Granular progress: motion DB saves complete
      await job.updateProgress(60);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusTracker.failPhase("motion", errorMessage);
      failedPhases.push("motion");

      logger.warn("[PageAnalyzeWorker] Motion detection failed", { error: errorMessage });
    }
    await job.updateProgress(PHASE_PROGRESS.MOTION_COMPLETE);
  } else {
    statusTracker.skipPhase("motion", "Disabled by options");
  }

  // =====================================================
  // Memory Cleanup: Close shared browser + GC after Motion phase
  // Chromium consumes 2-6GB RSS; releasing it before Phase 3+
  // prevents OOM during Quality/Narrative/Embedding phases.
  // motionResult (block-scoped) holds HTML buffers and intermediate detection data.
  // motionResultForEmbedding retains only patterns needed for embedding.
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);

    // Close shared browser to reclaim Chromium memory (2-6GB)
    // pageIngestAdapter.close() sets this.browser = null after closing
    try {
      logger.info("[PageAnalyzeWorker] [MemCleanup] Closing shared browser after Motion phase");
      await pageIngestAdapter.close();
    } catch (browserCloseError) {
      // Browser close failure must not crash the worker
      logger.warn("[PageAnalyzeWorker] [MemCleanup] Failed to close shared browser (non-fatal)", {
        error:
          browserCloseError instanceof Error
            ? browserCloseError.message
            : String(browserCloseError),
      });
    }

    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Motion GC (browser closed)", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
      });
    }
  }

  // =====================================================
  // Phase 2.5: Scroll Vision Analysis (deferred from Phase 1.5)
  // P0-2: Ollama Vision analysis runs AFTER browser close to avoid
  // VRAM conflict (Chromium 2-4GB + Ollama llama3.2-vision 7.8GB > RTX 3060 12GB).
  // Captures were stored in scrollVisionCapturesForDeferred during Phase 1.5.
  // =====================================================
  if (state.scrollVisionCapturesForDeferred && state.scrollVisionCapturesForDeferred.length > 0) {
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "scroll-vision-analysis");

    try {
      // GPU Resource Manager: Acquire GPU for Vision analysis (unloads ONNX if on GPU)
      try {
        const visionAcquireResult = await gpuResourceManager.acquireForVision();
        logger.debug("[PageAnalyzeWorker] GPU acquired for vision", {
          result: visionAcquireResult,
        });
      } catch (gpuError) {
        logger.warn(
          "[PageAnalyzeWorker] GPU acquire for vision failed, continuing with default mode",
          {
            error: gpuError instanceof Error ? gpuError.message : String(gpuError),
          }
        );
        // Continue without GPU management - Ollama will use whatever resources are available
      }

      // P2-8: VRAM Readiness Probe - Ollama Vision実行前にGPU VRAM空き容量を確認
      const readinessProbe = new OllamaReadinessProbe();
      const probeResult = await readinessProbe.check();

      if (!probeResult.ready) {
        if (isDevelopment()) {
          logger.warn(
            "[PageAnalyzeWorker] Ollama readiness probe failed, skipping scroll vision analysis",
            {
              reason: probeResult.reason,
              vram: probeResult.vram,
              waitRetries: probeResult.waitRetries,
              totalWaitMs: probeResult.totalWaitMs,
            }
          );
        }
        // Graceful Degradation: VRAM不足時はVision分析をスキップ（ジョブは継続）
        state.scrollVisionCapturesForDeferred = null;
      }

      if (
        state.scrollVisionCapturesForDeferred &&
        state.scrollVisionCapturesForDeferred.length > 0
      ) {
        if (isDevelopment()) {
          logger.debug("[PageAnalyzeWorker] Starting deferred scroll vision analysis (Phase 2.5)", {
            captureCount: state.scrollVisionCapturesForDeferred.length,
            vramFreeMb: probeResult.vram?.freeMb,
            probeWaitRetries: probeResult.waitRetries,
          });
        }

        const visionResult: ScrollVisionResult = await analyzeScrollCapturesFn(
          state.scrollVisionCapturesForDeferred,
          {
            onProgress: createPhaseProgressInterpolator(
              job,
              PHASE_PROGRESS.SCROLL_VISION_ANALYSIS_START,
              PHASE_PROGRESS.SCROLL_VISION_ANALYSIS_COMPLETE
            ),
          }
        );
        state.scrollVisionResultForEmbedding = visionResult;

        // Merge scroll vision results into layout results
        if (results.layout) {
          results.layout.scrollVisionAnalyzed = true;
          results.layout.scrollTriggeredAnimations = visionResult.scrollTriggeredAnimations.length;
        }

        // Save scroll vision results to DB (MotionPattern table)
        if (visionResult.scrollTriggeredAnimations.length > 0) {
          state.scrollVisionSaveResult = await saveScrollVisionResultsFn(
            prisma as unknown as ScrollVisionPrismaClient,
            actualWebPageId,
            visionResult,
            url
          );

          if (isDevelopment()) {
            logger.debug("[PageAnalyzeWorker] Scroll vision DB save", {
              success: state.scrollVisionSaveResult.success,
              count: state.scrollVisionSaveResult.count,
              idMappingSize: state.scrollVisionSaveResult.idMapping.size,
              error: state.scrollVisionSaveResult.error,
            });
          }
        }

        if (isDevelopment()) {
          logger.debug(
            "[PageAnalyzeWorker] Deferred scroll vision analysis completed (Phase 2.5)",
            {
              scrollTriggeredAnimations: visionResult.scrollTriggeredAnimations.length,
            }
          );
        }
      }
    } catch (scrollVisionError) {
      // Graceful Degradation: Scroll Vision analysis failure does NOT fail the overall job
      const errorMessage =
        scrollVisionError instanceof Error ? scrollVisionError.message : String(scrollVisionError);

      logger.warn("[PageAnalyzeWorker] Deferred scroll vision analysis failed (non-fatal)", {
        error: errorMessage,
      });
    }

    // Release capture buffers after analysis (PNG screenshots can be 5-20MB total)
    state.scrollVisionCapturesForDeferred = null;
    tryGarbageCollect();
  }

  // =====================================================
  // Ollama Vision Unload (2nd point): Free RAM after Phase 2.5 (Scroll Vision Analysis)
  // Phase 2.5でOllama Visionを使用した場合、Phase 3 (Quality) に向けてメモリを解放。
  // CPU-only環境(16GB RAM)ではPhase 3実行時のOOM回避に寄与する。
  // Phase 4 (Narrative) でVisionが必要な場合はOllamaが自動再ロードする。
  // 冪等: Phase 2.5でVisionを使わなかった場合もno-opで安全。
  // Note: GpuResourceManager.currentOwnerは'vision'のまま残るが、
  // Phase 5のacquireForEmbedding()で再度unloadが呼ばれても冪等のため実害なし。
  // 3箇所戦略: 1st=Phase 1完了後, 2nd=ここ(Phase 2.5完了後), 3rd=Phase 4完了後
  // =====================================================
  await unloadOllamaVisionModel();
}
