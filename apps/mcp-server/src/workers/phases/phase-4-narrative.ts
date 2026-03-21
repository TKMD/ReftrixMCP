// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 4: Narrative Analysis, Memory Cleanups, Ollama Unload,
 * and Phase 4.5: Responsive Analysis.
 *
 * Extracted from page-analyze-worker.ts (TDA-C1).
 *
 * @module workers/phases/phase-4-narrative
 */

import { logger, isDevelopment } from "../../utils/logger";

import type {
  NarrativeHandlerInput,
  NarrativeHandlerResult,
} from "../../tools/page/handlers/types";
import type { UrlValidationResult } from "../../utils/url-validator";
import type { RobotsTxtCheckResult } from "@reftrix/core";

import type { ResponsiveAnalysisResult } from "../../services/responsive/types";

import {
  type PhaseContext,
  type PipelineState,
  PHASE_PROGRESS,
  extendJobLock,
  unloadOllamaVisionModel,
  tryGarbageCollect,
} from "./types";

// ============================================================================
// NarrativePhaseDeps
// ============================================================================

/**
 * Dependencies injected into processNarrativePhase.
 *
 * Callers provide concrete implementations; the phase function stays testable.
 */
export interface NarrativePhaseDeps {
  /** Narrative analysis handler (from narrative-handler.ts) */
  handleNarrativeAnalysis: (input: NarrativeHandlerInput) => Promise<NarrativeHandlerResult>;

  /** Responsive analysis service */
  responsiveAnalysisService: {
    analyze: (url: string, opts: unknown) => Promise<ResponsiveAnalysisResult>;
  };

  /** Responsive persistence service (DB save) */
  responsivePersistenceService: {
    save: (webPageId: string, result: unknown) => Promise<string>;
  };

  /** SSRF validation for external URLs */
  validateExternalUrl: (url: string) => UrlValidationResult;

  /** robots.txt permission check */
  isUrlAllowedByRobotsTxt: (
    url: string,
    respectRobotsTxt?: boolean
  ) => Promise<RobotsTxtCheckResult>;
}

// ============================================================================
// processNarrativePhase
// ============================================================================

/**
 * Execute Phase 4 (Narrative Analysis), post-narrative memory cleanups,
 * Ollama Vision unload (3rd point), pre-embedding buffer release,
 * and Phase 4.5 (Responsive Analysis).
 *
 * Mutates `state` in place — sets `results.narrative`, `results.responsive`,
 * pushes to `completedPhases` / `failedPhases`, nullifies `state.html`,
 * and trims `layoutResultForNarrative`.
 */
export async function processNarrativePhase(
  state: PipelineState,
  ctx: PhaseContext,
  deps: NarrativePhaseDeps
): Promise<void> {
  const { job, options, url, effectiveToken, effectiveLockDuration, statusTracker } = ctx;

  const {
    actualWebPageId,
    completedPhases,
    failedPhases,
    layoutResultForNarrative,
    screenshotBase64,
    memoryAborted,
    narrativePreDisabled,
    visionPreDisabled,
  } = state;

  // results is always initialized to {} before phase functions are called
  const results = state.results!;

  // =====================================================
  // Phase 4: Narrative Analysis
  // =====================================================
  // Extend lock before potentially long-running Narrative/Vision phase
  await extendJobLock(job, effectiveToken, effectiveLockDuration, "narrative");

  // Narrative is disabled if: user opt-out, memory aborted, or pre-degradation disabled it
  const narrativeEnabled =
    !memoryAborted && !narrativePreDisabled && options.narrativeOptions?.enabled !== false;
  if (narrativeEnabled) {
    statusTracker.startPhase("narrative");
    await job.updateProgress(PHASE_PROGRESS.NARRATIVE_START);

    try {
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Starting narrative analysis", {
          includeVision: options.narrativeOptions?.includeVision ?? true,
          saveToDb: options.narrativeOptions?.saveToDb ?? true,
        });
      }

      // Narrative分析入力を構築
      // visionPreDisabled が true の場合、vision を強制無効化（HTMLサイズ or メモリ圧迫）
      const effectiveIncludeVision = visionPreDisabled
        ? false
        : (options.narrativeOptions?.includeVision ?? true);
      const narrativeInput: NarrativeHandlerInput = {
        html: state.html!,
        narrativeOptions: {
          enabled: true,
          saveToDb: options.narrativeOptions?.saveToDb ?? true,
          includeVision: effectiveIncludeVision,
          visionTimeoutMs: options.narrativeOptions?.visionTimeoutMs ?? 300000,
          generateEmbedding: options.narrativeOptions?.generateEmbedding ?? true,
        },
      };

      // スクリーンショットがある場合は渡す（Vision分析用）
      if (screenshotBase64) {
        narrativeInput.screenshot = screenshotBase64;
      }

      // webPageIdがある場合は渡す（DB保存用）
      if (actualWebPageId) {
        narrativeInput.webPageId = actualWebPageId;
      }

      // 既存分析結果を渡す（Narrative分析の精度向上）
      if (layoutResultForNarrative) {
        narrativeInput.existingAnalysis = {};
        if (layoutResultForNarrative.cssVariables) {
          narrativeInput.existingAnalysis.cssVariables = layoutResultForNarrative.cssVariables;
        }
        if (layoutResultForNarrative.sections) {
          narrativeInput.existingAnalysis.sections = layoutResultForNarrative.sections;
        }
        if (layoutResultForNarrative.visionFeatures) {
          narrativeInput.existingAnalysis.visualFeatures = layoutResultForNarrative.visionFeatures;
        }
        if (layoutResultForNarrative.externalCssContent) {
          narrativeInput.externalCss = layoutResultForNarrative.externalCssContent;
        }
      }

      const narrativeHandlerResult = await deps.handleNarrativeAnalysis(narrativeInput);

      if (narrativeHandlerResult.success && narrativeHandlerResult.narrative) {
        statusTracker.completePhase("narrative");
        completedPhases.push("narrative");
        results.narrative = {
          moodCategory: narrativeHandlerResult.narrative.worldView.moodCategory,
          confidence: narrativeHandlerResult.narrative.confidence ?? 0,
          visionUsed: options.narrativeOptions?.includeVision ?? true,
        };

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] Narrative analysis completed", {
            moodCategory: results.narrative.moodCategory,
            confidence: results.narrative.confidence,
            processingTimeMs: narrativeHandlerResult.processingTimeMs,
            savedId: narrativeHandlerResult.savedId,
          });
        }
      } else if (narrativeHandlerResult.error) {
        throw new Error(narrativeHandlerResult.error.message);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusTracker.failPhase("narrative", errorMessage);
      failedPhases.push("narrative");

      logger.warn("[PageAnalyzeWorker] Narrative analysis failed", { error: errorMessage });
    }
    await job.updateProgress(PHASE_PROGRESS.NARRATIVE_COMPLETE);
  } else if (memoryAborted || narrativePreDisabled) {
    statusTracker.skipPhase(
      "narrative",
      memoryAborted ? "Skipped due to memory pressure" : "Skipped due to large HTML pre-degradation"
    );
  } else {
    statusTracker.skipPhase("narrative", "Disabled by options");
  }

  // =====================================================
  // Memory Cleanup: GC after Narrative phase
  // narrativeInput and narrativeHandlerResult are block-scoped.
  // This cleanup prepares for the Embedding phase.
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Narrative GC", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
      });
    }
  }

  // =====================================================
  // Ollama Vision Unload (3rd point): Free RAM before Embedding phase
  // CPU-only環境(16GB RAM)でOllama Vision(~10.6GB)がembeddingメモリを圧迫するのを防止。
  // GpuResourceManager.acquireForEmbedding()はGPU無し環境でunloadをスキップするため、
  // ここで明示的にアンロードする。失敗してもnon-fatalで続行。
  // Phase 4 (Narrative) でVisionが再ロードされるため、Embedding前に再度アンロードが必要。
  // 冪等なので多重呼び出しも安全。
  // 3箇所戦略: 1st=Phase 1完了後, 2nd=Phase 2.5完了後, 3rd=ここ(Phase 4完了後)
  // =====================================================
  await unloadOllamaVisionModel();

  // =====================================================
  // Memory Cleanup: Release large buffers before Phase 5 (Embedding)
  // html (15-50MB per large site) is no longer needed after Phase 4 (Narrative).
  // screenshotBase64 (5-15MB) is retained for Phase 5 DINOv2 visual embedding
  // and released after Phase 5 completes.
  // layoutResultForNarrative is trimmed to keep only sections and
  // backgroundDesigns needed for embedding generation.
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    state.html = null;
    // NOTE: screenshotBase64 is intentionally NOT released here.
    // It is needed by Phase 5 for DINOv2 visual embedding crop generation.
    // It will be released after processEmbeddingPhase() completes.

    // Trim layoutResultForNarrative: keep only sections + backgroundDesigns for embedding
    // Release large fields: externalCssContent, cssSnippet, visionFeatures, cssVariables, etc.
    if (state.layoutResultForNarrative) {
      delete state.layoutResultForNarrative.html;
      delete state.layoutResultForNarrative.cssSnippet;
      delete state.layoutResultForNarrative.externalCssContent;
      delete state.layoutResultForNarrative.externalCssMeta;
      delete state.layoutResultForNarrative.screenshot;
      delete state.layoutResultForNarrative.visionFeatures;
      delete state.layoutResultForNarrative.textRepresentation;
      delete state.layoutResultForNarrative.visualFeatures;
      delete state.layoutResultForNarrative.cssVariables;
      delete state.layoutResultForNarrative.cssFramework;
    }

    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] Pre-Embedding buffer release", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
        releasedRefs: ["html"],
        retainedRefs: ["screenshotBase64 (for Phase 5 DINOv2 visual embedding)"],
        trimmedRefs: ["layoutResultForNarrative (kept: sections, backgroundDesigns)"],
      });
    }
  }

  // =====================================================
  // Phase 4.5: Responsive Analysis
  // =====================================================
  const responsiveEnabled = options.responsiveOptions?.enabled !== false;
  if (responsiveEnabled && actualWebPageId && !memoryAborted) {
    statusTracker.startPhase("responsive");
    await job.updateProgress(PHASE_PROGRESS.RESPONSIVE_START);
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "responsive");

    try {
      // SSRF対策: URLを検証
      const urlValidation = deps.validateExternalUrl(url);
      if (!urlValidation.valid) {
        if (isDevelopment()) {
          logger.warn("[PageAnalyzeWorker] Responsive SSRF blocked", {
            url,
            error: urlValidation.error,
          });
        }
        statusTracker.skipPhase("responsive", `SSRF blocked: ${urlValidation.error}`);
      } else {
        // robots.txt チェック（respect_robots_txt パラメータを伝搬）
        const robotsResult = await deps.isUrlAllowedByRobotsTxt(url, options.respectRobotsTxt);
        if (!robotsResult.allowed) {
          if (isDevelopment()) {
            logger.warn("[PageAnalyzeWorker] Responsive blocked by robots.txt", {
              url,
              reason: robotsResult.reason,
            });
          }
          statusTracker.skipPhase(
            "responsive",
            `Robots.txt blocked: ${robotsResult.reason}. ` +
              `Use respect_robots_txt: false to override. ` +
              `Note: Overriding may have legal implications (e.g., EU DSM Directive Article 4).`
          );
        } else {
          // crawl-delay を取得（秒→ミリ秒変換、上限30秒）
          const MAX_CRAWL_DELAY_MS = 30000;
          const crawlDelayMs =
            robotsResult.crawlDelay !== undefined
              ? Math.min(robotsResult.crawlDelay * 1000, MAX_CRAWL_DELAY_MS)
              : undefined;

          const responsiveOpts: {
            enabled: boolean;
            viewports?: Array<{ name: string; width: number; height: number }>;
            include_screenshots?: boolean;
            include_diff_images?: boolean;
            diff_threshold?: number;
            detect_navigation?: boolean;
            detect_visibility?: boolean;
            detect_layout?: boolean;
            crawlDelayMs?: number;
          } = { enabled: true };

          const rOpts = options.responsiveOptions;
          if (rOpts?.viewports !== undefined) responsiveOpts.viewports = rOpts.viewports;
          if (rOpts?.include_screenshots !== undefined)
            responsiveOpts.include_screenshots = rOpts.include_screenshots;
          if (rOpts?.include_diff_images !== undefined)
            responsiveOpts.include_diff_images = rOpts.include_diff_images;
          if (rOpts?.diff_threshold !== undefined)
            responsiveOpts.diff_threshold = rOpts.diff_threshold;
          if (rOpts?.detect_navigation !== undefined)
            responsiveOpts.detect_navigation = rOpts.detect_navigation;
          if (rOpts?.detect_visibility !== undefined)
            responsiveOpts.detect_visibility = rOpts.detect_visibility;
          if (rOpts?.detect_layout !== undefined)
            responsiveOpts.detect_layout = rOpts.detect_layout;
          if (crawlDelayMs !== undefined) responsiveOpts.crawlDelayMs = crawlDelayMs;

          // 最大2分のタイムアウト（clearTimeout でタイマーリーク防止）
          const responsiveTimeout = 120000;
          let responsiveTimerId: ReturnType<typeof setTimeout> | undefined;
          const responsiveResult = await Promise.race([
            deps.responsiveAnalysisService.analyze(url, responsiveOpts),
            new Promise<never>((_, reject) => {
              responsiveTimerId = setTimeout(
                () => reject(new Error("Responsive analysis timeout")),
                responsiveTimeout
              );
            }),
          ]).finally(() => {
            if (responsiveTimerId) clearTimeout(responsiveTimerId);
          });

          // DB保存
          const saveToDb = options.responsiveOptions?.save_to_db !== false;
          let responsiveAnalysisId: string | undefined;
          if (saveToDb && responsiveResult) {
            try {
              responsiveAnalysisId = await deps.responsivePersistenceService.save(
                actualWebPageId,
                responsiveResult
              );
            } catch (saveError) {
              logger.warn("[PageAnalyzeWorker] Responsive DB save failed", {
                error: saveError instanceof Error ? saveError.message : String(saveError),
              });
            }
          }

          results.responsive = {
            differencesDetected: responsiveResult.differences.length,
            breakpointsDetected: responsiveResult.breakpoints.length,
            viewportsAnalyzed: responsiveResult.viewportsAnalyzed.map((v) => ({
              name: v.name,
              width: v.width,
              height: v.height,
            })),
            analysisTimeMs: responsiveResult.analysisTimeMs,
            ...(responsiveAnalysisId ? { responsiveAnalysisId } : {}),
          };

          statusTracker.completePhase("responsive");
          completedPhases.push("responsive");
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusTracker.failPhase("responsive", errorMessage);
      logger.warn("[PageAnalyzeWorker] Responsive analysis failed (graceful degradation)", {
        error: errorMessage,
      });
      // Graceful degradation: メイン結果に影響しない
    }
    await job.updateProgress(PHASE_PROGRESS.RESPONSIVE_COMPLETE);
  } else if (!responsiveEnabled) {
    statusTracker.skipPhase("responsive", "Disabled by options");
  } else if (memoryAborted) {
    statusTracker.skipPhase("responsive", "Skipped due to memory pressure");
  }
}
