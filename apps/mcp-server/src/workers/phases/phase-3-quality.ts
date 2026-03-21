// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 3: Quality Evaluation
 *
 * Evaluates design quality, saves results and benchmarks to DB,
 * and performs memory checks before/after the phase.
 *
 * Extracted from page-analyze-worker.ts (TDA-C1).
 *
 * @module workers/phases/phase-3-quality
 */

import { logger, isDevelopment } from "../../utils/logger";
import type { QualityServiceResult } from "../../tools/page/handlers/types";
import type {
  QualityEvaluationPrismaClient,
  QualityBenchmarkPrismaClient,
  QualityBenchmarkInput,
} from "../../services/worker-db-save.service";

import {
  type PipelineState,
  type PhaseContext,
  PHASE_PROGRESS,
  checkMemoryPressure,
  MEMORY_CRITICAL_THRESHOLD_MB,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  tryGarbageCollect,
} from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Quality phase dependency injection interface.
 *
 * All external functions and the Prisma client are injected to keep
 * the phase pure and testable.
 */
export interface QualityPhaseDeps {
  /** Quality evaluation function (from quality-handler) */
  defaultEvaluateQuality: (
    html: string,
    options?: {
      strict?: boolean;
      includeRecommendations?: boolean;
      weights?:
        | {
            originality?: number;
            craftsmanship?: number;
            contextuality?: number;
          }
        | undefined;
      targetIndustry?: string | undefined;
      targetAudience?: string | undefined;
    }
  ) => Promise<QualityServiceResult>;
  /** Save quality evaluation to DB */
  saveQualityEvaluation: (
    prisma: QualityEvaluationPrismaClient,
    webPageId: string,
    qualityResult: QualityServiceResult,
    options?: {
      strict?: boolean | undefined;
      targetIndustry?: string | undefined;
      targetAudience?: string | undefined;
    }
  ) => Promise<{ success: boolean; count: number; ids: string[]; idMapping: Map<string, string> }>;
  /** Save quality benchmarks to DB */
  saveQualityBenchmarks: (
    prisma: QualityBenchmarkPrismaClient,
    webPageId: string,
    benchmarks: QualityBenchmarkInput[]
  ) => Promise<{ success: boolean; count: number; ids: string[]; idMapping: Map<string, string> }>;
  /** Build benchmark inputs from quality result */
  buildQualityBenchmarkInputs: (
    qualityResult: QualityServiceResult,
    sourceUrl: string,
    options?: {
      targetIndustry?: string | undefined;
      targetAudience?: string | undefined;
    }
  ) => QualityBenchmarkInput[];
  /** Prisma client (cast to specific types internally) */
  prisma: unknown;
}

// ============================================================================
// Phase 3 Implementation
// ============================================================================

/**
 * Process the Quality phase of the page-analyze pipeline.
 *
 * 1. Memory Check 1: if checkMemoryPressure().shouldAbort → state.memoryAborted = true, return
 * 2. Phase 3: Quality Evaluation (if !memoryAborted && features.quality !== false)
 *    - Call defaultEvaluateQuality with html and quality options
 *    - Save QualityEvaluation to DB
 *    - Save QualityBenchmarks to DB
 * 3. GC cleanup
 * 4. Memory Check 2: if shouldAbort → memoryAborted; if shouldDegrade → narrativePreDisabled, visionPreDisabled
 */
export async function processQualityPhase(
  state: PipelineState,
  ctx: PhaseContext,
  deps: QualityPhaseDeps
): Promise<void> {
  const { actualWebPageId, completedPhases, failedPhases, html } = state;
  // results is always initialized as {} by the pipeline orchestrator
  const results = state.results!;
  const { job, options, url, statusTracker } = ctx;

  // =====================================================
  // Memory Check 1: Before Phase 3 (Quality)
  // =====================================================
  {
    const memCheck1 = checkMemoryPressure();
    if (memCheck1.shouldAbort) {
      logger.warn(
        "[PageAnalyzeWorker] [Memory Critical] Skipping quality/narrative, saving collected data",
        {
          rssMb: memCheck1.rssMb,
          threshold: MEMORY_CRITICAL_THRESHOLD_MB,
          url,
        }
      );
      state.memoryAborted = true;
    }
  }

  // =====================================================
  // Phase 3: Quality Evaluation
  // =====================================================
  if (!state.memoryAborted && options.features?.quality !== false) {
    statusTracker.startPhase("quality");
    await job.updateProgress(PHASE_PROGRESS.QUALITY_START);

    try {
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Starting quality evaluation");
      }

      const qualityResult = await deps.defaultEvaluateQuality(html!, {
        strict: options.qualityOptions?.strict ?? false,
        includeRecommendations: true,
        weights: options.qualityOptions?.weights
          ? {
              originality: options.qualityOptions.weights.originality ?? 0.35,
              craftsmanship: options.qualityOptions.weights.craftsmanship ?? 0.4,
              contextuality: options.qualityOptions.weights.contextuality ?? 0.25,
            }
          : undefined,
        targetIndustry: options.qualityOptions?.targetIndustry,
        targetAudience: options.qualityOptions?.targetAudience,
      });

      statusTracker.completePhase("quality");
      completedPhases.push("quality");
      results.quality = {
        overallScore: qualityResult.overallScore ?? 0,
        grade: qualityResult.grade ?? "F",
      };

      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Quality evaluation completed", {
          overallScore: results.quality.overallScore,
          grade: results.quality.grade,
        });
      }

      // QualityEvaluation DB保存
      if (actualWebPageId && qualityResult.success) {
        try {
          const qualitySaveResult = await deps.saveQualityEvaluation(
            deps.prisma as unknown as QualityEvaluationPrismaClient,
            actualWebPageId,
            qualityResult,
            {
              strict: options.qualityOptions?.strict,
              targetIndustry: options.qualityOptions?.targetIndustry,
              targetAudience: options.qualityOptions?.targetAudience,
            }
          );

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] QualityEvaluation saved", {
              count: qualitySaveResult.count,
              webPageId: actualWebPageId,
            });
          }
        } catch (qualitySaveError) {
          // Graceful Degradation: QualityEvaluation save failed はジョブを中断しない
          logger.warn("[PageAnalyzeWorker] QualityEvaluation save failed", {
            error:
              qualitySaveError instanceof Error
                ? qualitySaveError.message
                : String(qualitySaveError),
          });
        }

        // QualityBenchmark DB保存
        try {
          const benchmarkInputs = deps.buildQualityBenchmarkInputs(qualityResult, url, {
            targetIndustry: options.qualityOptions?.targetIndustry,
            targetAudience: options.qualityOptions?.targetAudience,
          });

          if (benchmarkInputs.length > 0) {
            const benchmarkSaveResult = await deps.saveQualityBenchmarks(
              deps.prisma as unknown as QualityBenchmarkPrismaClient,
              actualWebPageId,
              benchmarkInputs
            );

            if (isDevelopment()) {
              logger.info("[PageAnalyzeWorker] QualityBenchmarks saved", {
                count: benchmarkSaveResult.count,
                webPageId: actualWebPageId,
              });
            }
          }
        } catch (benchmarkSaveError) {
          // Graceful Degradation: QualityBenchmark save failed はジョブを中断しない
          logger.warn("[PageAnalyzeWorker] QualityBenchmark save failed", {
            error:
              benchmarkSaveError instanceof Error
                ? benchmarkSaveError.message
                : String(benchmarkSaveError),
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      statusTracker.failPhase("quality", errorMessage);
      failedPhases.push("quality");

      logger.warn("[PageAnalyzeWorker] Quality evaluation failed", { error: errorMessage });
    }
    await job.updateProgress(PHASE_PROGRESS.QUALITY_COMPLETE);
  } else if (state.memoryAborted) {
    statusTracker.skipPhase("quality", "Skipped due to memory pressure");
  } else {
    statusTracker.skipPhase("quality", "Disabled by options");
  }

  // =====================================================
  // Memory Cleanup: GC after Quality phase
  // qualityResult (block-scoped) holds evaluation data no longer needed.
  // This is the critical cleanup point before Narrative - the most
  // frequently skipped phase due to memory pressure.
  // =====================================================
  {
    const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    tryGarbageCollect();
    if (isDevelopment()) {
      const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Quality GC", {
        beforeRssMb: beforeRss,
        afterRssMb: afterRss,
        reclaimedMb: beforeRss - afterRss,
      });
    }
  }

  // =====================================================
  // Memory Check 2: Before Phase 4 (Narrative)
  // =====================================================
  if (!state.memoryAborted) {
    const memCheck2 = checkMemoryPressure();
    if (memCheck2.shouldAbort) {
      logger.warn(
        "[PageAnalyzeWorker] [Memory Critical] Skipping narrative, saving collected data",
        {
          rssMb: memCheck2.rssMb,
          threshold: MEMORY_CRITICAL_THRESHOLD_MB,
          url,
        }
      );
      state.memoryAborted = true;
    } else if (memCheck2.shouldDegrade) {
      logger.warn("[PageAnalyzeWorker] [Memory Pressure] Disabling narrative/vision for this job", {
        rssMb: memCheck2.rssMb,
        threshold: MEMORY_DEGRADATION_THRESHOLD_MB,
        url,
      });
      state.narrativePreDisabled = true;
      state.visionPreDisabled = true;
    }
  }
}
