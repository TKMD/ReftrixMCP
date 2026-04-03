// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Embedding Generation
 *
 * Generates text and visual embeddings for sections, motions, backgrounds,
 * JS animations, responsive analyses, and parts (text + DINOv2 visual).
 *
 * Extracted from page-analyze-worker.ts (TDA-C1).
 *
 * @module workers/phases/phase-5-embedding
 */

import { logger, isDevelopment } from "../../utils/logger";
import sharp from "sharp";
import path from "path";
import * as fs from "node:fs";

// Embedding generation (reuse from synchronous flow)
import {
  generateSectionEmbeddings,
  generateMotionEmbeddings,
  generateBackgroundDesignEmbeddings,
  type SectionDataForEmbedding,
  type BackgroundDesignForText,
} from "../../tools/page/handlers/embedding-handler";
import type { MotionPatternForEmbedding } from "../../tools/page/handlers/types";

// Part Embedding (Phase 5 text + visual via DINOv2)
import {
  buildPartTextRepresentation,
  generateVisualEmbedding,
  type ComponentPartForEmbedding,
  type PartEmbeddingResult,
} from "../../services/part/part-embedding.service";
// DINOv2 visual embedding service
import { DINOv2Service, DINOV2_INPUT_SIZE } from "@reftrixmcp/ml";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../services/part/part-embedding-db.service";
// Part Bounding Box resolution via Playwright (Phase 5 pre-step for DINOv2)
import { resolvePartBoundingBoxes } from "../../services/part/part-bbox-playwright.service";
// Section Screenshot Fallback: screenshotBase64範囲外セクション用Playwrightキャプチャ
import { captureSectionScreenshots } from "../../services/part/section-screenshot-fallback.service";
// Responsive Analysis Embedding generation
import { generateResponsiveAnalysisEmbeddings } from "../../services/responsive/responsive-analysis-embedding.service";

// Shared types, constants, and helpers from types.ts
import {
  type EmbeddingPhaseParams,
  type EmbeddingPhaseResult,
  EMBEDDING_CHUNK_SIZE,
  DINOV2_CHUNK_SIZE,
  DINOV2_RECYCLE_THRESHOLD,
  JS_ANIMATION_EMBEDDING_CHUNK_SIZE,
  checkMemoryPressure,
  tryGarbageCollect,
  extendJobLock,
  isDuplicateVisionEmbedding,
  acquireSectionCropBuffer,
  generateJsAnimationTextRepresentation,
  saveJsAnimationEmbeddingChunk,
} from "./types";

// Phase 5 RAW decode optimization
import {
  decodeToRawFile,
  loadRawBuffer,
  acquireSectionCropBufferFromRaw,
  type RawScreenshotMetadata,
} from "./phase-5-raw-decode";

// GPU Resource Manager type
import type { GpuResourceManager } from "../../services/gpu-resource-manager";
// LayoutEmbeddingService type
import type { LayoutEmbeddingService } from "../../services/layout-embedding.service";

// ============================================================================
// P0-A: Phase 5 RSS Measurement Points (8 points)
// ============================================================================

/**
 * Phase 5 メモリ計測ログ出力（P0-A）
 *
 * Phase 5 の各サブフェーズ境界で RSS / heapUsed / external / arrayBuffers を記録する。
 * isDevelopment() ガード禁止（全環境で出力）。PII を含めない。
 *
 * Logs Phase 5 memory usage at sub-phase boundaries.
 * No isDevelopment() guard (logs in all environments). No PII included.
 */
function logPhase5Memory(label: string): void {
  const mem = process.memoryUsage();
  logger.info("[Phase5Memory]", {
    label,
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    arrayBuffersMb: Math.round(mem.arrayBuffers / 1024 / 1024),
  });
}

// ============================================================================
// Dependency Injection Interface
// ============================================================================

/**
 * Dependencies injected from the orchestrator (module-level singletons).
 *
 * processEmbeddingPhase は元の page-analyze-worker.ts でモジュールレベルの
 * シングルトン (sharedLayoutEmbeddingService, gpuResourceManager, prisma) を
 * 直接参照していた。Phase 抽出後はこのインターフェースを通じて注入する。
 */
export interface EmbeddingPhaseDeps {
  /** Shared ONNX session singleton for all text embedding sub-phases */
  sharedLayoutEmbeddingService: LayoutEmbeddingService;
  /** GPU resource manager singleton (Vision/Embedding dynamic switching) */
  gpuResourceManager: GpuResourceManager;
  /** Prisma client instance */
  prisma: EmbeddingPhasePrismaClient;
}

/**
 * Prisma client shape required by the embedding phase.
 * Avoids importing the full Prisma client type.
 */
export interface EmbeddingPhasePrismaClient {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  componentPart: {
    findMany: (args: unknown) => Promise<unknown[]>;
    count: (args: unknown) => Promise<number>;
  };
  sectionPattern: {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  jSAnimationEmbedding: {
    createMany: (args: {
      data: Array<{
        jsAnimationPatternId: string;
        textRepresentation: string;
        modelVersion: string;
      }>;
    }) => Promise<{ count: number }>;
  };
}

// Note: EmbeddingPhasePrismaClient is already exported via `export interface` above

// ============================================================================
// Sub-phase shared context (for extracted sub-phase functions)
// ============================================================================

/**
 * Sub-phase context shared across all text embedding sub-phases.
 *
 * Holds references to injected dependencies and progress tracking state
 * so that each extracted sub-phase function receives a minimal, uniform interface.
 */
interface EmbeddingSubPhaseContext {
  webPageId: string;
  url: string;
  job: EmbeddingPhaseParams["job"];
  params: EmbeddingPhaseParams;
  effectiveToken: string;
  effectiveLockDuration: number;
  sharedLayoutEmbeddingService: LayoutEmbeddingService;
  gpuResourceManager: GpuResourceManager;
  prisma: EmbeddingPhasePrismaClient;
  result: EmbeddingPhaseResult;
  reportEmbeddingSubProgress: (subCompleted: number, subTotal: number) => void;
}

// ============================================================================
// Main Phase Function (Orchestrator — refactored from 1396 lines to ~280)
// ============================================================================

/**
 * Phase 5: Embedding Generation
 *
 * Generates text embeddings (e5-base) and visual embeddings (DINOv2) for all
 * analyzed content: sections, motions, backgrounds, JS animations, responsive
 * analyses, and parts.
 *
 * @param params - Embedding phase parameters (job data, save results, etc.)
 * @param deps - Injected dependencies (singletons from orchestrator)
 * @returns Embedding phase result with generation counts
 */
export async function processEmbeddingPhase(
  params: EmbeddingPhaseParams,
  deps: EmbeddingPhaseDeps
): Promise<EmbeddingPhaseResult> {
  const {
    webPageId,
    url,
    job,
    effectiveToken,
    effectiveLockDuration,
    sectionSaveResult,
    motionSaveResult,
    jsSaveResult,
    bgSaveResult,
    scrollVisionSaveResult,
    layoutResultForNarrative,
    motionResultForEmbedding,
    jsAnimationsForEmbedding,
    scrollVisionResultForEmbedding,
    responsiveAnalysisId,
    partsSavedCount,
    screenshotPngPath,
    onProgress,
  } = params;

  // P0-B: screenshotBase64 をミュータブルに保持（Phase 5 冒頭で早期 null 化するため）
  let screenshotBase64: string | null | undefined = params.screenshotBase64;

  const { sharedLayoutEmbeddingService, gpuResourceManager, prisma } = deps;

  const result: EmbeddingPhaseResult = {
    sectionEmbeddingsGenerated: 0,
    motionEmbeddingsGenerated: 0,
    bgEmbeddingsGenerated: 0,
    jsAnimationEmbeddingsGenerated: 0,
    responsiveEmbeddingsGenerated: 0,
    partEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    sectionVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
    completed: false,
  };

  // ========================================================================
  // Sharp memory control: disable internal cache and limit concurrency
  // to prevent libvips arena memory accumulation during embedding phase.
  // Restored in the finally block below.
  // ========================================================================
  const previousCacheState = sharp.cache();
  const previousConcurrency = sharp.concurrency();
  sharp.cache(false);
  sharp.concurrency(1);

  try {
    // Compound progress tracking: accumulate across all embedding sub-phases
    const sectionCount =
      sectionSaveResult &&
      sectionSaveResult.idMapping.size > 0 &&
      layoutResultForNarrative?.sections
        ? (layoutResultForNarrative.sections as SectionDataForEmbedding[]).length
        : 0;
    const motionCount =
      motionSaveResult && motionSaveResult.idMapping.size > 0 && motionResultForEmbedding?.patterns
        ? motionResultForEmbedding.patterns.length
        : 0;
    const visionMotionCount =
      scrollVisionSaveResult &&
      scrollVisionSaveResult.idMapping.size > 0 &&
      scrollVisionResultForEmbedding
        ? scrollVisionResultForEmbedding.scrollTriggeredAnimations.length
        : 0;
    const bgCount =
      bgSaveResult && bgSaveResult.ids.length > 0 && layoutResultForNarrative?.backgroundDesigns
        ? (layoutResultForNarrative.backgroundDesigns as unknown[]).length
        : 0;
    const jsCount =
      jsSaveResult && jsSaveResult.idMapping.size > 0 && jsAnimationsForEmbedding
        ? jsSaveResult.idMapping.size
        : 0;
    const totalEmbeddingItems = sectionCount + motionCount + visionMotionCount + bgCount + jsCount;
    let completedEmbeddingItems = 0;

    function reportEmbeddingSubProgress(_subCompleted: number, _subTotal: number): void {
      if (!onProgress || totalEmbeddingItems <= 0) return;
      completedEmbeddingItems++;
      try {
        onProgress(completedEmbeddingItems, totalEmbeddingItems);
      } catch {
        /* fire-and-forget */
      }
    }

    // Build shared sub-phase context
    const ctx: EmbeddingSubPhaseContext = {
      webPageId,
      url,
      job,
      params,
      effectiveToken,
      effectiveLockDuration,
      sharedLayoutEmbeddingService,
      gpuResourceManager,
      prisma,
      result,
      reportEmbeddingSubProgress,
    };

    // P0-A: Measurement point 1 — Phase 5 start (before text embedding)
    logPhase5Memory("phase5-start");

    try {
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Starting embedding generation", {
          sectionIdMappingSize: sectionSaveResult?.idMapping?.size ?? 0,
          motionIdMappingSize: motionSaveResult?.idMapping?.size ?? 0,
          jsIdMappingSize: jsSaveResult?.idMapping?.size ?? 0,
          bgIdMappingSize: bgSaveResult?.idMapping?.size ?? 0,
          scrollVisionIdMappingSize: scrollVisionSaveResult?.idMapping?.size ?? 0,
        });
      }

      // 1. Section text embedding
      await processSectionTextEmbeddingChunks(ctx, sectionSaveResult, layoutResultForNarrative);

      // P0-A: Measurement point 2 — Section text embedding complete
      logPhase5Memory("after-section-text-embedding");

      // 2. Motion text embedding
      await processMotionTextEmbeddingChunks(ctx, motionSaveResult, motionResultForEmbedding);

      // 2.5. Vision Motion text embedding
      await processVisionMotionEmbeddingChunks(
        ctx,
        scrollVisionSaveResult,
        scrollVisionResultForEmbedding
      );

      // 3. Background text embedding
      await processBackgroundTextEmbeddingChunks(ctx, bgSaveResult, layoutResultForNarrative);

      // 4. JS Animation embedding
      await processJsAnimationEmbeddingChunks(ctx, jsSaveResult, jsAnimationsForEmbedding);

      // 5. Responsive embedding
      await processResponsiveEmbeddingChunks(ctx, responsiveAnalysisId);

      // 6. Part text embedding
      await processPartTextEmbeddingChunks(ctx, partsSavedCount);

      // 7. DINOv2 Visual Embedding (Section + Part)
      const hasSections = (sectionSaveResult?.idMapping?.size ?? 0) > 0;
      const hasParts = (partsSavedCount ?? 0) > 0;

      // P0-B: screenshotBuffer を screenshotPngPath 優先で生成、base64 は早期 null 化
      let screenshotBuffer: Buffer | null = null;
      if (screenshotBase64 && (hasSections || hasParts)) {
        if (screenshotPngPath && fs.existsSync(screenshotPngPath)) {
          // P0-B: PNG ファイルベースで読み込み（Buffer.from(base64) 廃止）
          screenshotBuffer = fs.readFileSync(screenshotPngPath);
        } else if (screenshotBase64) {
          // Fallback: PNG ファイルがない場合のみ従来の base64 デコード
          screenshotBuffer = Buffer.from(screenshotBase64, "base64");
        }

        // P0-B: screenshotBase64 の早期 null 化（~200MB 解放）
        screenshotBase64 = null;
        tryGarbageCollect();
      }

      if (screenshotBuffer && (hasSections || hasParts)) {
        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-visual-dinov2");

        // Resolve part bounding boxes via Playwright
        if (hasParts) {
          try {
            const bboxResult = await resolvePartBoundingBoxes({
              webPageId,
              url,
              prisma: prisma as never,
              sharedBrowser: params.sharedBrowser,
              viewportWidth: job.data.options?.layoutOptions?.viewport?.width,
              viewportHeight: job.data.options?.layoutOptions?.viewport?.height,
            });
            if (isDevelopment()) {
              logger.info("[PageAnalyzeWorker] Resolved part bounding boxes via Playwright", {
                resolved: bboxResult.resolvedCount,
                skipped: bboxResult.skippedCount,
              });
            }
          } catch (bboxError) {
            logger.warn("[PageAnalyzeWorker] Part bounding box resolution failed (non-fatal)", {
              error: bboxError instanceof Error ? bboxError.message : String(bboxError),
            });
          }
        }

        try {
          // DINOv2 model path resolution
          let dinov2ModelPath: string;
          if (process.env["DINOV2_MODEL_PATH"]) {
            dinov2ModelPath = process.env["DINOV2_MODEL_PATH"];
          } else {
            const mlMainPath = require.resolve("@reftrixmcp/ml");
            const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
            dinov2ModelPath = path.join(mlRoot, "models", "dinov2-base", "model.onnx");
          }

          // GPU acquire for DINOv2
          try {
            const dinov2GpuResult = await gpuResourceManager.acquireForDINOv2();
            if (isDevelopment()) {
              logger.info("[PageAnalyzeWorker] GPU acquired for DINOv2 visual embedding", {
                mode: dinov2GpuResult.mode,
                message: dinov2GpuResult.message,
              });
            }
          } catch (gpuError) {
            logger.warn("[PageAnalyzeWorker] GPU acquire for DINOv2 failed, using CPU", {
              error: gpuError instanceof Error ? gpuError.message : String(gpuError),
            });
          }

          // P0-A: Measurement point 3 — Before DINOv2 initialize
          logPhase5Memory("before-dinov2-init");

          // DINOv2 Service initialize (shared for Section + Part)
          const dinov2Service = new DINOv2Service({ modelPath: dinov2ModelPath });
          await dinov2Service.initialize();

          // P0-A: Measurement point 4 — After DINOv2 initialize
          logPhase5Memory("after-dinov2-init");

          // Get screenshot dimensions
          const screenshotMeta = await sharp(screenshotBuffer).metadata();
          const imgWidth = screenshotMeta.width ?? 0;
          const imgHeight = screenshotMeta.height ?? 0;

          // P0-A: Measurement point 5 — After screenshotBuffer metadata
          logPhase5Memory("after-screenshot-metadata");

          // RAW Decode Optimization
          let rawScreenshotMeta: RawScreenshotMetadata | null = null;
          let phase5TmpDir: string | null = null;

          if (screenshotPngPath) {
            try {
              phase5TmpDir = path.dirname(screenshotPngPath);

              // P0-B: Path Traversal defense
              const resolvedPng = path.resolve(screenshotPngPath);
              const resolvedTmp = path.resolve(phase5TmpDir);
              if (!resolvedPng.startsWith(resolvedTmp)) {
                logger.warn(
                  "[PageAnalyzeWorker] Path traversal detected in screenshotPngPath, skipping RAW decode",
                  { screenshotPngPath: "(redacted)" }
                );
              } else {
                // P0-B: File size limit (500MB)
                const pngStat = fs.statSync(screenshotPngPath);
                const MAX_PNG_SIZE_BYTES = 500 * 1024 * 1024;
                if (pngStat.size > MAX_PNG_SIZE_BYTES) {
                  logger.warn(
                    "[PageAnalyzeWorker] Screenshot PNG exceeds 500MB limit, skipping RAW decode",
                    { sizeMb: Math.round(pngStat.size / 1024 / 1024) }
                  );
                } else {
                  rawScreenshotMeta = await decodeToRawFile(screenshotPngPath, phase5TmpDir);

                  if (rawScreenshotMeta && isDevelopment()) {
                    logger.info(
                      "[PageAnalyzeWorker] RAW decode completed for Phase 5 optimization",
                      {
                        rawPath: rawScreenshotMeta.rawPath,
                        width: rawScreenshotMeta.width,
                        height: rawScreenshotMeta.height,
                      }
                    );
                  }
                }
              }
            } catch (rawDecodeError) {
              logger.warn(
                "[PageAnalyzeWorker] RAW decode failed, falling back to legacy path (non-fatal)",
                {
                  error:
                    rawDecodeError instanceof Error
                      ? rawDecodeError.message
                      : String(rawDecodeError),
                }
              );
              rawScreenshotMeta = null;
            }
          }

          // P0-A: Measurement point 6 — After RAW buffer load
          logPhase5Memory("after-raw-decode");

          try {
            // Section Visual Embedding (DINOv2)
            if (hasSections) {
              await extendJobLock(
                job,
                effectiveToken,
                effectiveLockDuration,
                "embedding-sections-visual"
              );

              try {
                const sectionsNeedingVisual = await prisma.$queryRawUnsafe<
                  Array<{ id: string; section_pattern_id: string }>
                >(
                  `SELECT id, section_pattern_id
                 FROM section_embeddings
                 WHERE section_pattern_id IN (
                   SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
                 )
                 AND text_embedding IS NOT NULL
                 AND vision_embedding IS NULL`,
                  webPageId
                );

                if (sectionsNeedingVisual.length > 0) {
                  if (isDevelopment()) {
                    logger.info(
                      "[PageAnalyzeWorker] Starting Section DINOv2 visual embedding generation",
                      { totalSections: sectionsNeedingVisual.length }
                    );
                  }

                  const sectionPatternIds = sectionsNeedingVisual.map((s) => s.section_pattern_id);
                  const sectionPatterns = (await prisma.sectionPattern.findMany({
                    where: { id: { in: sectionPatternIds } },
                    select: { id: true, layoutInfo: true, sectionType: true },
                  })) as Array<{ id: string; layoutInfo: unknown; sectionType: string }>;
                  const sectionPositionMap = new Map<
                    string,
                    { startY: number; height: number; sectionType: string }
                  >();
                  for (const sp of sectionPatterns) {
                    const info = sp.layoutInfo as Record<string, unknown> | null;
                    const position = info?.position as
                      | { startY?: number; height?: number }
                      | undefined;
                    sectionPositionMap.set(sp.id, {
                      startY: position?.startY ?? 0,
                      height: position?.height ?? 0,
                      sectionType: sp.sectionType,
                    });
                  }

                  // PII protection
                  const highPiiSectionIds = await prisma.$queryRawUnsafe<
                    Array<{ section_pattern_id: string }>
                  >(
                    `SELECT DISTINCT cp.section_pattern_id
                   FROM component_parts cp
                   WHERE cp.section_pattern_id IN (${sectionPatternIds.map((_, i) => `$${i + 1}::uuid`).join(", ")})
                   AND cp.pii_risk_level = 'high'`,
                    ...sectionPatternIds
                  );
                  const highPiiSectionIdSet = new Set(
                    highPiiSectionIds.map((r) => r.section_pattern_id)
                  );

                  const sectionsFiltered =
                    highPiiSectionIdSet.size > 0
                      ? sectionsNeedingVisual.filter(
                          (s) => !highPiiSectionIdSet.has(s.section_pattern_id)
                        )
                      : sectionsNeedingVisual;

                  if (highPiiSectionIdSet.size > 0) {
                    logger.warn(
                      "[PageAnalyzeWorker] Skipped sections with high PII risk for visual embedding (GDPR Art. 5(1)(c))",
                      {
                        skippedCount: highPiiSectionIdSet.size,
                        remainingCount: sectionsFiltered.length,
                      }
                    );
                  }

                  const sectionVisualResult = await processSectionVisualEmbeddingLoop({
                    sectionsFiltered,
                    sectionsNeedingVisual,
                    sectionPositionMap,
                    screenshotBufferRef: { value: screenshotBuffer },
                    imgWidth,
                    imgHeight,
                    fallbackEnabled:
                      (process.env["ENABLE_SECTION_SCREENSHOT_FALLBACK"] ?? "true") === "true",
                    url,
                    job,
                    params,
                    effectiveToken,
                    effectiveLockDuration,
                    dinov2Service,
                    prisma,
                    rawScreenshotMeta,
                  });

                  screenshotBuffer = sectionVisualResult.screenshotBuffer;
                  result.sectionVisualEmbeddingsGenerated +=
                    sectionVisualResult.sectionVisualEmbeddingsGenerated;
                }
              } catch (sectionVisualError) {
                result.embeddingFailedChunks++;
                logger.warn(
                  "[PageAnalyzeWorker] Section DINOv2 visual embedding failed (non-fatal)",
                  {
                    error:
                      sectionVisualError instanceof Error
                        ? sectionVisualError.message
                        : String(sectionVisualError),
                  }
                );
              }

              // P0-A: Measurement point 7 — After section visual embedding
              logPhase5Memory("after-section-visual-embedding");

              // Memory recovery between section and part visual embedding
              // P0-C: Null out sectionRawBuffer intent — handled inside processSectionVisualEmbeddingLoop
              tryGarbageCollect();
            }

            // Part Visual Embedding (DINOv2)
            if (hasParts) {
              // P0-C: Part visual embedding uses its own loadRawBuffer call (not shared with section)
              await processPartVisualEmbeddingLoop(
                ctx,
                screenshotBuffer,
                rawScreenshotMeta,
                screenshotBase64 ?? null,
                imgWidth,
                imgHeight,
                dinov2Service
              );

              // P0-A: Measurement point 8 — After part visual embedding
              logPhase5Memory("after-part-visual-embedding");
            }

            screenshotBuffer = null;
          } finally {
            try {
              await dinov2Service.dispose();
            } catch {
              // dispose failure is non-fatal
            }
            tryGarbageCollect();
          }
        } catch (visualEmbError) {
          result.embeddingFailedChunks++;
          logger.warn("[PageAnalyzeWorker] DINOv2 visual embedding failed (non-fatal)", {
            error:
              visualEmbError instanceof Error ? visualEmbError.message : String(visualEmbError),
          });
        }
      }

      result.completed = true;
    } catch (embeddingError) {
      result.embeddingFailedChunks++;
      logger.warn("[PageAnalyzeWorker] Embedding generation failed (non-fatal)", {
        error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
      });
    }

    if (result.embeddingFailedChunks > 0) {
      logger.warn("[PageAnalyzeWorker] Embedding phase completed with failures", {
        embeddingFailedChunks: result.embeddingFailedChunks,
        sectionEmbeddingsGenerated: result.sectionEmbeddingsGenerated,
        sectionVisualEmbeddingsGenerated: result.sectionVisualEmbeddingsGenerated,
        motionEmbeddingsGenerated: result.motionEmbeddingsGenerated,
        bgEmbeddingsGenerated: result.bgEmbeddingsGenerated,
        jsAnimationEmbeddingsGenerated: result.jsAnimationEmbeddingsGenerated,
        responsiveEmbeddingsGenerated: result.responsiveEmbeddingsGenerated,
        partEmbeddingsGenerated: result.partEmbeddingsGenerated,
        partVisualEmbeddingsGenerated: result.partVisualEmbeddingsGenerated,
      });
    }
  } finally {
    if (typeof previousCacheState === "boolean") {
      sharp.cache(previousCacheState);
    } else {
      sharp.cache(true);
    }
    sharp.concurrency(previousConcurrency);
  }

  return result;
}

// ============================================================================
// Extracted Text Embedding Sub-Phase Functions
// ============================================================================

/**
 * 1. Section text embedding (chunked)
 */
async function processSectionTextEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  sectionSaveResult: EmbeddingPhaseParams["sectionSaveResult"],
  layoutResultForNarrative: EmbeddingPhaseParams["layoutResultForNarrative"]
): Promise<void> {
  await extendJobLock(ctx.job, ctx.effectiveToken, ctx.effectiveLockDuration, "embedding-sections");
  if (
    !sectionSaveResult ||
    sectionSaveResult.idMapping.size === 0 ||
    !layoutResultForNarrative?.sections
  ) {
    return;
  }

  const allSections = layoutResultForNarrative.sections as SectionDataForEmbedding[];
  let sectionChunkSize = EMBEDDING_CHUNK_SIZE;

  for (let offset = 0; offset < allSections.length; offset += sectionChunkSize) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping section embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      sectionChunkSize = Math.max(5, Math.floor(sectionChunkSize / 2));
      logger.warn("[PageAnalyzeWorker] Memory pressure, reducing section chunk size", {
        rssMb: memCheck.rssMb,
        newChunkSize: sectionChunkSize,
      });
    }

    const chunkSections = allSections.slice(offset, offset + sectionChunkSize);
    await extendJobLock(
      ctx.job,
      ctx.effectiveToken,
      ctx.effectiveLockDuration,
      "embedding-sections"
    );

    const chunkIdMapping = new Map<string, string>();
    for (const section of chunkSections) {
      const dbId = sectionSaveResult.idMapping.get(section.id);
      if (dbId) chunkIdMapping.set(section.id, dbId);
    }

    try {
      const sectionEmbResult = await generateSectionEmbeddings(chunkSections, chunkIdMapping, {
        webPageId: ctx.webPageId,
        onProgress: ctx.reportEmbeddingSubProgress,
        layoutEmbeddingService: ctx.sharedLayoutEmbeddingService,
      });
      ctx.result.sectionEmbeddingsGenerated += sectionEmbResult.generatedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] SectionEmbeddings chunk completed", {
          chunkOffset: offset,
          chunkSize: chunkSections.length,
          generatedCount: sectionEmbResult.generatedCount,
          failedCount: sectionEmbResult.failedCount,
          totalSoFar: ctx.result.sectionEmbeddingsGenerated,
        });
      }
    } catch (sectionEmbError) {
      ctx.result.embeddingFailedChunks++;
      logger.warn("[PageAnalyzeWorker] SectionEmbedding chunk failed (non-fatal)", {
        chunkOffset: offset,
        error: sectionEmbError instanceof Error ? sectionEmbError.message : String(sectionEmbError),
      });
    }

    if (offset + sectionChunkSize < allSections.length) {
      await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
      // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 2. Motion text embedding (chunked)
 */
async function processMotionTextEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  motionSaveResult: EmbeddingPhaseParams["motionSaveResult"],
  motionResultForEmbedding: EmbeddingPhaseParams["motionResultForEmbedding"]
): Promise<void> {
  await extendJobLock(ctx.job, ctx.effectiveToken, ctx.effectiveLockDuration, "embedding-motions");
  if (
    !motionSaveResult ||
    motionSaveResult.idMapping.size === 0 ||
    !motionResultForEmbedding?.patterns
  ) {
    return;
  }

  const allMotionPatterns = motionResultForEmbedding.patterns as MotionPatternForEmbedding[];
  let motionChunkSize = EMBEDDING_CHUNK_SIZE;

  for (let offset = 0; offset < allMotionPatterns.length; offset += motionChunkSize) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping motion embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      motionChunkSize = Math.max(5, Math.floor(motionChunkSize / 2));
      logger.warn("[PageAnalyzeWorker] Memory pressure, reducing motion chunk size", {
        rssMb: memCheck.rssMb,
        newChunkSize: motionChunkSize,
      });
    }

    const chunkPatterns = allMotionPatterns.slice(offset, offset + motionChunkSize);
    await extendJobLock(
      ctx.job,
      ctx.effectiveToken,
      ctx.effectiveLockDuration,
      "embedding-motions"
    );

    const chunkIdMapping = new Map<string, string>();
    for (const pattern of chunkPatterns) {
      const dbId = motionSaveResult.idMapping.get(pattern.id);
      if (dbId) chunkIdMapping.set(pattern.id, dbId);
    }

    try {
      const motionEmbResult = await generateMotionEmbeddings(chunkPatterns, {
        webPageId: ctx.webPageId,
        sourceUrl: ctx.url,
        motionPatternIdMapping: chunkIdMapping,
        onProgress: ctx.reportEmbeddingSubProgress,
      });
      ctx.result.motionEmbeddingsGenerated += motionEmbResult.savedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] MotionEmbeddings chunk completed", {
          chunkOffset: offset,
          chunkSize: chunkPatterns.length,
          savedCount: motionEmbResult.savedCount,
          errorCount: motionEmbResult.errors.length,
          totalSoFar: ctx.result.motionEmbeddingsGenerated,
        });
      }
    } catch (motionEmbError) {
      ctx.result.embeddingFailedChunks++;
      logger.warn("[PageAnalyzeWorker] MotionEmbedding chunk failed (non-fatal)", {
        chunkOffset: offset,
        error: motionEmbError instanceof Error ? motionEmbError.message : String(motionEmbError),
      });
    }

    if (offset + motionChunkSize < allMotionPatterns.length) {
      await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 2.5. Vision-detected Motion text embedding (scroll-vision, chunked)
 */
async function processVisionMotionEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  scrollVisionSaveResult: EmbeddingPhaseParams["scrollVisionSaveResult"],
  scrollVisionResultForEmbedding: EmbeddingPhaseParams["scrollVisionResultForEmbedding"]
): Promise<void> {
  if (
    !scrollVisionSaveResult ||
    scrollVisionSaveResult.idMapping.size === 0 ||
    !scrollVisionResultForEmbedding
  ) {
    return;
  }

  const visionPatterns: MotionPatternForEmbedding[] =
    scrollVisionResultForEmbedding.scrollTriggeredAnimations.map((animation, index) => ({
      id: `vision_detected_${index}`,
      name: `Scroll-triggered ${animation.animationType}: ${animation.element.slice(0, 100)}`,
      type: "vision_detected" as const,
      category:
        animation.animationType === "parallax"
          ? "parallax"
          : animation.animationType === "appear"
            ? "reveal"
            : animation.animationType === "lazy-load"
              ? "entrance"
              : "scroll_trigger",
      trigger: "scroll",
      duration: 0,
      easing: "unknown",
      properties: [],
      performance: {
        level: "acceptable" as const,
        usesTransform: false,
        usesOpacity: false,
      },
      accessibility: {
        respectsReducedMotion: false,
      },
    }));

  let visionChunkSize = EMBEDDING_CHUNK_SIZE;

  for (let offset = 0; offset < visionPatterns.length; offset += visionChunkSize) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping vision motion embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      visionChunkSize = Math.max(5, Math.floor(visionChunkSize / 2));
      logger.warn(
        "[PageAnalyzeWorker] Memory pressure detected, reducing vision-motion chunk size",
        { rssMb: memCheck.rssMb, newChunkSize: visionChunkSize }
      );
    }

    const chunkVisionPatterns = visionPatterns.slice(offset, offset + visionChunkSize);
    await extendJobLock(
      ctx.job,
      ctx.effectiveToken,
      ctx.effectiveLockDuration,
      "embedding-motions"
    );

    const chunkVisionIdMapping = new Map<string, string>();
    for (const pattern of chunkVisionPatterns) {
      const dbId = scrollVisionSaveResult.idMapping.get(pattern.id);
      if (dbId) chunkVisionIdMapping.set(pattern.id, dbId);
    }

    try {
      const visionEmbResult = await generateMotionEmbeddings(chunkVisionPatterns, {
        webPageId: ctx.webPageId,
        sourceUrl: ctx.url,
        motionPatternIdMapping: chunkVisionIdMapping,
        onProgress: ctx.reportEmbeddingSubProgress,
      });
      ctx.result.motionEmbeddingsGenerated += visionEmbResult.savedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Vision-detected MotionEmbeddings chunk completed", {
          chunkOffset: offset,
          savedCount: visionEmbResult.savedCount,
          errorCount: visionEmbResult.errors.length,
        });
      }
    } catch (visionEmbError) {
      ctx.result.embeddingFailedChunks++;
      logger.warn("[PageAnalyzeWorker] Vision-detected MotionEmbedding chunk failed (non-fatal)", {
        chunkOffset: offset,
        error: visionEmbError instanceof Error ? visionEmbError.message : String(visionEmbError),
      });
    }

    if (offset + visionChunkSize < visionPatterns.length) {
      await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 3. Background text embedding (chunked)
 */
async function processBackgroundTextEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  bgSaveResult: EmbeddingPhaseParams["bgSaveResult"],
  layoutResultForNarrative: EmbeddingPhaseParams["layoutResultForNarrative"]
): Promise<void> {
  await extendJobLock(
    ctx.job,
    ctx.effectiveToken,
    ctx.effectiveLockDuration,
    "embedding-backgrounds"
  );
  if (
    !bgSaveResult ||
    bgSaveResult.ids.length === 0 ||
    !layoutResultForNarrative?.backgroundDesigns
  ) {
    return;
  }

  const allBackgroundsForText: BackgroundDesignForText[] =
    layoutResultForNarrative.backgroundDesigns.map(
      (bg: {
        name: string;
        designType: string;
        selector?: string;
        colorInfo?: {
          dominantColors?: string[];
          colorCount?: number;
          hasAlpha?: boolean;
          colorSpace?: string;
        };
        gradientInfo?: {
          type?: string;
          angle?: number;
          stops?: Array<{ color: string; position: number }>;
          repeating?: boolean;
        };
      }) => ({
        name: bg.name,
        designType: bg.designType,
        selector: bg.selector,
        colorInfo: bg.colorInfo,
        gradientInfo: bg.gradientInfo,
      })
    );

  let bgChunkSize = EMBEDDING_CHUNK_SIZE;

  for (let offset = 0; offset < allBackgroundsForText.length; offset += bgChunkSize) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping background embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      bgChunkSize = Math.max(5, Math.floor(bgChunkSize / 2));
      logger.warn("[PageAnalyzeWorker] Memory pressure, reducing background chunk size", {
        rssMb: memCheck.rssMb,
        newChunkSize: bgChunkSize,
      });
    }

    const chunkBgs = allBackgroundsForText.slice(offset, offset + bgChunkSize);
    const chunkIds = bgSaveResult.ids.slice(offset, offset + bgChunkSize);

    const chunkIdMapping = new Map<string, string>();
    for (const bg of chunkBgs) {
      const dbId = bgSaveResult.idMapping.get(bg.name);
      if (dbId) chunkIdMapping.set(bg.name, dbId);
    }

    await extendJobLock(
      ctx.job,
      ctx.effectiveToken,
      ctx.effectiveLockDuration,
      "embedding-backgrounds"
    );

    try {
      const bgEmbResult = await generateBackgroundDesignEmbeddings(chunkBgs, chunkIdMapping, {
        webPageId: ctx.webPageId,
        backgroundDesignIds: chunkIds,
        onProgress: ctx.reportEmbeddingSubProgress,
      });
      ctx.result.bgEmbeddingsGenerated += bgEmbResult.generatedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] BackgroundDesignEmbeddings chunk completed", {
          chunkOffset: offset,
          chunkSize: chunkBgs.length,
          generatedCount: bgEmbResult.generatedCount,
          failedCount: bgEmbResult.failedCount,
          totalSoFar: ctx.result.bgEmbeddingsGenerated,
        });
      }
    } catch (bgEmbError) {
      ctx.result.embeddingFailedChunks++;
      logger.warn("[PageAnalyzeWorker] BackgroundDesignEmbedding chunk failed (non-fatal)", {
        chunkOffset: offset,
        error: bgEmbError instanceof Error ? bgEmbError.message : String(bgEmbError),
      });
    }

    if (offset + bgChunkSize < allBackgroundsForText.length) {
      await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 4. JS Animation embedding (item-by-item with chunked DB save)
 */
async function processJsAnimationEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  jsSaveResult: EmbeddingPhaseParams["jsSaveResult"],
  jsAnimationsForEmbedding: EmbeddingPhaseParams["jsAnimationsForEmbedding"]
): Promise<void> {
  await extendJobLock(
    ctx.job,
    ctx.effectiveToken,
    ctx.effectiveLockDuration,
    "embedding-js-animations"
  );
  if (!jsSaveResult || jsSaveResult.idMapping.size === 0 || !jsAnimationsForEmbedding) {
    return;
  }

  try {
    const jsEmbService = ctx.sharedLayoutEmbeddingService;
    const embeddingItems: Array<{
      originalId: string;
      dbId: string;
      textRepresentation: string;
      embedding: number[];
    }> = [];

    for (const [originalId, dbId] of jsSaveResult.idMapping) {
      const memCheck = checkMemoryPressure();
      if (memCheck.shouldAbort) {
        logger.warn("[PageAnalyzeWorker] Critical memory, stopping JS animation embedding", {
          rssMb: memCheck.rssMb,
        });
        break;
      }
      if (memCheck.shouldDegrade) {
        logger.warn("[PageAnalyzeWorker] Memory pressure detected in JS animation embedding", {
          rssMb: memCheck.rssMb,
        });
      }

      try {
        const textRepresentation = generateJsAnimationTextRepresentation(
          originalId,
          jsAnimationsForEmbedding
        );
        const embeddingResult = await jsEmbService.generateFromText(textRepresentation);

        embeddingItems.push({
          originalId,
          dbId,
          textRepresentation,
          embedding: embeddingResult.embedding,
        });

        try {
          ctx.reportEmbeddingSubProgress(0, 0);
        } catch {
          /* fire-and-forget */
        }

        if (embeddingItems.length >= JS_ANIMATION_EMBEDDING_CHUNK_SIZE) {
          const savedCount = await saveJsAnimationEmbeddingChunk(
            embeddingItems,
            ctx.prisma as never
          );
          ctx.result.jsAnimationEmbeddingsGenerated += savedCount;

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings chunk saved", {
              chunkSize: savedCount,
              totalSoFar: ctx.result.jsAnimationEmbeddingsGenerated,
            });
          }

          embeddingItems.length = 0;
          tryGarbageCollect();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch (jsEmbItemError) {
        try {
          ctx.reportEmbeddingSubProgress(0, 0);
        } catch {
          /* fire-and-forget */
        }
        ctx.result.embeddingFailedChunks++;
        logger.warn("[PageAnalyzeWorker] JSAnimationEmbedding item generation failed (non-fatal)", {
          originalId,
          dbId,
          error: jsEmbItemError instanceof Error ? jsEmbItemError.message : String(jsEmbItemError),
        });
      }
    }

    if (embeddingItems.length > 0) {
      const savedCount = await saveJsAnimationEmbeddingChunk(embeddingItems, ctx.prisma as never);
      ctx.result.jsAnimationEmbeddingsGenerated += savedCount;
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings generated", {
        generatedCount: ctx.result.jsAnimationEmbeddingsGenerated,
        totalPatterns: jsSaveResult.idMapping.size,
      });
    }
  } catch (jsEmbError) {
    ctx.result.embeddingFailedChunks++;
    logger.warn("[PageAnalyzeWorker] JSAnimationEmbedding generation failed (non-fatal)", {
      error: jsEmbError instanceof Error ? jsEmbError.message : String(jsEmbError),
    });
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 5. Responsive Analysis embedding
 */
async function processResponsiveEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  responsiveAnalysisId: string | undefined
): Promise<void> {
  if (!responsiveAnalysisId) return;

  await extendJobLock(
    ctx.job,
    ctx.effectiveToken,
    ctx.effectiveLockDuration,
    "embedding-responsive"
  );

  try {
    const memCheck = checkMemoryPressure();
    if (!memCheck.shouldAbort) {
      const responsiveEmbResult = await generateResponsiveAnalysisEmbeddings(
        [responsiveAnalysisId],
        ctx.sharedLayoutEmbeddingService,
        ctx.prisma as never
      );
      ctx.result.responsiveEmbeddingsGenerated = responsiveEmbResult.generatedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] ResponsiveAnalysisEmbeddings generated", {
          generatedCount: responsiveEmbResult.generatedCount,
          responsiveAnalysisId,
        });
      }
    } else {
      logger.warn("[PageAnalyzeWorker] Critical memory, skipping responsive embedding", {
        rssMb: memCheck.rssMb,
      });
    }
  } catch (respEmbError) {
    ctx.result.embeddingFailedChunks++;
    logger.warn("[PageAnalyzeWorker] ResponsiveAnalysisEmbedding generation failed (non-fatal)", {
      error: respEmbError instanceof Error ? respEmbError.message : String(respEmbError),
    });
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * 6. Part text embedding (chunked)
 */
async function processPartTextEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  partsSavedCount: number | undefined
): Promise<void> {
  if ((partsSavedCount ?? 0) <= 0) {
    // FIX(Bug-1): Part Extraction runs inside Promise.race with 30s timeout.
    // If timeout fires before any section completes, partsSavedCount stays 0
    // even though the async IIFE continues saving parts to DB in the background.
    // By Phase 5, those parts are committed. Query DB as authoritative source.
    const dbPartCount = await ctx.prisma.componentPart.count({
      where: { webPageId: ctx.webPageId },
    });
    if (dbPartCount <= 0) return;
    logger.info("[PageAnalyzeWorker] Part count recovered from DB (partsSavedCount was 0)", {
      dbPartCount,
      webPageId: ctx.webPageId,
    });
  }

  await extendJobLock(ctx.job, ctx.effectiveToken, ctx.effectiveLockDuration, "embedding-parts");

  try {
    const partsForEmbedding = (await ctx.prisma.componentPart.findMany({
      where: { webPageId: ctx.webPageId, embedding: { is: null } },
      select: {
        id: true,
        partType: true,
        partSubtype: true,
        computedStyles: true,
        cssClasses: true,
        attributes: true,
        interactionInfo: true,
      },
    })) as Array<{
      id: string;
      partType: string;
      partSubtype: string | null;
      computedStyles: unknown;
      cssClasses: string[];
      attributes: unknown;
      interactionInfo: unknown;
    }>;

    if (partsForEmbedding.length === 0) return;

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Starting Part embedding generation", {
        totalParts: partsForEmbedding.length,
      });
    }

    let partChunkSize = EMBEDDING_CHUNK_SIZE;

    for (let offset = 0; offset < partsForEmbedding.length; offset += partChunkSize) {
      const memCheck = checkMemoryPressure();
      if (memCheck.shouldAbort) {
        logger.warn("[PageAnalyzeWorker] Critical memory, stopping part embedding", {
          rssMb: memCheck.rssMb,
        });
        break;
      }
      if (memCheck.shouldDegrade) {
        partChunkSize = Math.max(5, Math.floor(partChunkSize / 2));
        logger.warn("[PageAnalyzeWorker] Memory pressure, reducing part chunk size", {
          rssMb: memCheck.rssMb,
          newChunkSize: partChunkSize,
        });
      }

      const chunkParts = partsForEmbedding.slice(offset, offset + partChunkSize);
      await extendJobLock(
        ctx.job,
        ctx.effectiveToken,
        ctx.effectiveLockDuration,
        "embedding-parts"
      );

      try {
        const chunkEmbeddings: PartEmbeddingResult[] = [];

        for (const part of chunkParts) {
          try {
            const partForEmb: ComponentPartForEmbedding = {
              id: part.id,
              partType: part.partType,
              partSubtype: part.partSubtype,
              computedStyles: (part.computedStyles ?? {}) as Record<string, string>,
              cssClasses: part.cssClasses,
              attributes: (part.attributes ?? {}) as Record<string, string>,
              interactionInfo: (part.interactionInfo ?? {}) as Record<string, boolean>,
            };
            const textRepr = buildPartTextRepresentation(partForEmb);
            const textForEmbedding = textRepr.startsWith("passage: ")
              ? textRepr.slice("passage: ".length)
              : textRepr;
            const embResult =
              await ctx.sharedLayoutEmbeddingService.generateFromText(textForEmbedding);

            chunkEmbeddings.push({
              componentPartId: part.id,
              visualEmbedding: null,
              textEmbedding: embResult.embedding,
              textRepresentation: textRepr,
            });

            try {
              ctx.reportEmbeddingSubProgress(0, 0);
            } catch {
              /* fire-and-forget */
            }
          } catch (partItemError) {
            ctx.result.embeddingFailedChunks++;
            try {
              ctx.reportEmbeddingSubProgress(0, 0);
            } catch {
              /* fire-and-forget */
            }
            logger.warn("[PageAnalyzeWorker] Part embedding failed for item (non-fatal)", {
              partId: part.id.slice(0, 8) + "...",
              error: partItemError instanceof Error ? partItemError.message : String(partItemError),
            });
          }
        }

        if (chunkEmbeddings.length > 0) {
          const saveResult = await savePartEmbeddings(
            ctx.prisma as unknown as PartEmbeddingPrismaClient,
            chunkEmbeddings
          );
          ctx.result.partEmbeddingsGenerated += saveResult.savedCount;
        }

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] PartEmbeddings chunk completed", {
            chunkOffset: offset,
            chunkSize: chunkParts.length,
            savedCount: chunkEmbeddings.length,
            totalSoFar: ctx.result.partEmbeddingsGenerated,
          });
        }
      } catch (partChunkError) {
        ctx.result.embeddingFailedChunks++;
        logger.warn("[PageAnalyzeWorker] PartEmbedding chunk failed (non-fatal)", {
          chunkOffset: offset,
          error: partChunkError instanceof Error ? partChunkError.message : String(partChunkError),
        });
      }

      if (offset + partChunkSize < partsForEmbedding.length) {
        await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
        tryGarbageCollect();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] PartEmbeddings generation complete", {
        generatedCount: ctx.result.partEmbeddingsGenerated,
        totalParts: partsForEmbedding.length,
      });
    }
  } catch (partEmbError) {
    ctx.result.embeddingFailedChunks++;
    logger.warn("[PageAnalyzeWorker] PartEmbedding generation failed (non-fatal)", {
      error: partEmbError instanceof Error ? partEmbError.message : String(partEmbError),
    });
  }

  await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();
  tryGarbageCollect();
}

/**
 * Part Visual Embedding loop (DINOv2) — extracted from orchestrator.
 *
 * P0-C: Loads partRawBuffer independently (not shared with section visual embedding).
 */
async function processPartVisualEmbeddingLoop(
  ctx: EmbeddingSubPhaseContext,
  screenshotBuffer: Buffer | null,
  rawScreenshotMeta: RawScreenshotMetadata | null,
  screenshotBase64ForParts: string | null,
  imgWidth: number,
  imgHeight: number,
  dinov2Service: InstanceType<typeof DINOv2Service>
): Promise<void> {
  const partsWithEmbeddings = (await ctx.prisma.componentPart.findMany({
    where: {
      webPageId: ctx.webPageId,
      piiRiskLevel: { not: "high" },
      embedding: { isNot: null },
    },
    select: {
      id: true,
      boundingBox: true,
      sectionPatternId: true,
      embedding: { select: { id: true } },
    },
  })) as Array<{
    id: string;
    boundingBox: unknown;
    sectionPatternId: string;
    embedding: { id: string } | null;
  }>;

  let partsNeedingVisual: Array<{
    id: string;
    boundingBox: unknown;
    sectionPatternId: string;
    embeddingId: string;
  }> = [];

  if (partsWithEmbeddings.length > 0) {
    const embeddingIds = partsWithEmbeddings
      .filter((p): p is typeof p & { embedding: { id: string } } => p.embedding !== null)
      .map((p) => p.embedding.id);

    if (embeddingIds.length > 0) {
      const nullVisualRows = await ctx.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM component_part_embeddings
       WHERE id = ANY($1::uuid[]) AND visual_embedding IS NULL`,
        embeddingIds
      );
      const nullVisualIds = new Set(nullVisualRows.map((r) => r.id));

      partsNeedingVisual = partsWithEmbeddings
        .filter(
          (p): p is typeof p & { embedding: { id: string } } =>
            p.embedding !== null && nullVisualIds.has(p.embedding.id)
        )
        .map((p) => ({
          id: p.id,
          boundingBox: p.boundingBox,
          sectionPatternId: p.sectionPatternId,
          embeddingId: p.embedding.id,
        }));
    }
  }

  const hasScreenshotSource =
    screenshotBuffer != null || rawScreenshotMeta != null || screenshotBase64ForParts != null;
  if (partsNeedingVisual.length === 0 || !hasScreenshotSource) return;

  // P0-C: Load RAW buffer independently for part visual embedding (not shared with section)
  let partRawBuffer: Buffer | null = null;
  if (rawScreenshotMeta) {
    partRawBuffer = loadRawBuffer(rawScreenshotMeta);
    if (partRawBuffer && isDevelopment()) {
      logger.info("[PageAnalyzeWorker] RAW buffer loaded for part visual embedding loop", {
        rawBufferSizeMb: Math.round(partRawBuffer.length / 1024 / 1024),
      });
    }
  }

  // P0-B: Use PNG path fallback instead of Buffer.from(base64)
  let partFallbackBuffer: Buffer | null = null;
  if (!partRawBuffer && !screenshotBuffer && screenshotBase64ForParts) {
    // Last resort: decode base64 (only if no other source available)
    partFallbackBuffer = Buffer.from(screenshotBase64ForParts, "base64");
  }

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] Starting DINOv2 part visual embedding generation", {
      totalParts: partsNeedingVisual.length,
      useRawOptimization: !!partRawBuffer,
      useFallbackBuffer: !!partFallbackBuffer,
    });
  }

  const uniqueSectionIds = [...new Set(partsNeedingVisual.map((p) => p.sectionPatternId))];
  const sectionPositions = (await ctx.prisma.sectionPattern.findMany({
    where: { id: { in: uniqueSectionIds } },
    select: { id: true, layoutInfo: true },
  })) as Array<{ id: string; layoutInfo: unknown }>;
  const sectionStartYMap = new Map<string, number>();
  for (const s of sectionPositions) {
    const info = s.layoutInfo as Record<string, unknown> | null;
    const position = info?.position as { startY?: number } | undefined;
    sectionStartYMap.set(s.id, position?.startY ?? 0);
  }

  let visualChunkSize = DINOV2_CHUNK_SIZE;

  if (visualChunkSize <= 0) {
    logger.info("[PageAnalyzeWorker] Part DINOv2 visual embedding disabled (chunk size = 0)");
  }

  for (
    let offset = 0;
    visualChunkSize > 0 && offset < partsNeedingVisual.length;
    offset += visualChunkSize
  ) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping part visual embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      visualChunkSize = Math.max(3, Math.floor(visualChunkSize / 2));
      logger.warn("[PageAnalyzeWorker] Memory pressure, reducing part visual chunk size", {
        rssMb: memCheck.rssMb,
        newChunkSize: visualChunkSize,
      });
    }

    const chunk = partsNeedingVisual.slice(offset, offset + visualChunkSize);

    await extendJobLock(
      ctx.job,
      ctx.effectiveToken,
      ctx.effectiveLockDuration,
      "embedding-parts-visual"
    );

    for (const part of chunk) {
      try {
        const bbox = part.boundingBox as Record<string, number> | null;
        if (
          !bbox ||
          typeof bbox.width !== "number" ||
          typeof bbox.height !== "number" ||
          bbox.width <= 0 ||
          bbox.height <= 0
        ) {
          continue;
        }

        const sectionStartY = sectionStartYMap.get(part.sectionPatternId) ?? 0;
        const absoluteBbox = {
          x: bbox.x ?? 0,
          y: (bbox.y ?? 0) + sectionStartY,
          width: bbox.width,
          height: bbox.height,
        };

        const left = Math.max(0, Math.round(absoluteBbox.x));
        const top = Math.max(0, Math.round(absoluteBbox.y));
        const cropWidth = Math.min(Math.round(absoluteBbox.width), Math.max(1, imgWidth - left));
        const cropHeight = Math.min(Math.round(absoluteBbox.height), Math.max(1, imgHeight - top));

        if (cropWidth <= 0 || cropHeight <= 0) continue;

        let partSharpInput: sharp.Sharp;
        if (partRawBuffer && rawScreenshotMeta) {
          partSharpInput = sharp(partRawBuffer, {
            raw: {
              width: rawScreenshotMeta.width,
              height: rawScreenshotMeta.height,
              channels: rawScreenshotMeta.channels as 1 | 2 | 3 | 4,
            },
          });
        } else if (screenshotBuffer) {
          partSharpInput = sharp(screenshotBuffer);
        } else if (partFallbackBuffer) {
          partSharpInput = sharp(partFallbackBuffer);
        } else {
          continue;
        }

        const rawCropBuffer = await partSharpInput
          .extract({ left, top, width: cropWidth, height: cropHeight })
          .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, { fit: "cover", kernel: "cubic" })
          .removeAlpha()
          .toColorspace("srgb")
          .raw()
          .toBuffer();

        const visualEmbedding = await generateVisualEmbedding(dinov2Service, rawCropBuffer);

        const visualVectorString = `[${visualEmbedding.join(",")}]`;
        await ctx.prisma.$executeRawUnsafe(
          `UPDATE component_part_embeddings
         SET visual_embedding = $1::vector(768)
         WHERE id = $2::uuid`,
          visualVectorString,
          part.embeddingId
        );

        ctx.result.partVisualEmbeddingsGenerated++;
      } catch (partVisualError) {
        logger.warn("[PageAnalyzeWorker] DINOv2 visual embedding failed for part (non-fatal)", {
          partId: part.id.slice(0, 8) + "...",
          error:
            partVisualError instanceof Error ? partVisualError.message : String(partVisualError),
        });
      }
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Part visual embedding chunk completed", {
        chunkOffset: offset,
        chunkSize: chunk.length,
        totalVisualSoFar: ctx.result.partVisualEmbeddingsGenerated,
      });
    }

    if (offset + visualChunkSize < partsNeedingVisual.length) {
      tryGarbageCollect();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // P0-C: Release part RAW buffer after loop
  partRawBuffer = null;
  partFallbackBuffer = null;

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] DINOv2 part visual embedding generation complete", {
      generatedCount: ctx.result.partVisualEmbeddingsGenerated,
      totalParts: partsNeedingVisual.length,
    });
  }
}

// ============================================================================
// Section Visual Embedding Sub-functions
// ============================================================================

/**
 * セクションビジュアルエンベディングループのパラメータ
 */
interface SectionVisualEmbeddingLoopParams {
  sectionsFiltered: Array<{ id: string; section_pattern_id: string }>;
  sectionsNeedingVisual: Array<{ id: string; section_pattern_id: string }>;
  sectionPositionMap: Map<string, { startY: number; height: number; sectionType: string }>;
  screenshotBufferRef: { value: Buffer | null };
  imgWidth: number;
  imgHeight: number;
  fallbackEnabled: boolean;
  url: string;
  job: EmbeddingPhaseParams["job"];
  params: EmbeddingPhaseParams;
  effectiveToken: string;
  effectiveLockDuration: number;
  dinov2Service: InstanceType<typeof DINOv2Service>;
  prisma: EmbeddingPhasePrismaClient;
  /** RAW スクリーンショットメタデータ（Phase 5 RAW decode 最適化用、null の場合は従来パス） */
  rawScreenshotMeta?: RawScreenshotMetadata | null | undefined;
}

/**
 * セクションビジュアルエンベディングループの戻り値
 */
interface SectionVisualEmbeddingLoopResult {
  sectionVisualEmbeddingsGenerated: number;
  screenshotBuffer: Buffer | null;
}

/**
 * フォールバック対象セクションの事前収集とバッチキャプチャ
 *
 * screenshotBase64の高さ範囲外セクションを収集し、Playwrightで一括キャプチャする。
 * Collects sections outside screenshotBase64 height range and batch-captures via Playwright.
 */
async function collectFallbackScreenshots(
  sectionsFiltered: Array<{ section_pattern_id: string }>,
  sectionPositionMap: Map<string, { startY: number; height: number; sectionType: string }>,
  imgHeight: number,
  fallbackEnabled: boolean,
  url: string,
  job: EmbeddingPhaseParams["job"],
  params: EmbeddingPhaseParams,
  fallbackTimeoutMs: number
): Promise<{ screenshots: Map<string, Buffer>; capturedCount: number }> {
  const fallbackSections: Array<{ id: string; startY: number; height: number }> = [];
  for (const section of sectionsFiltered) {
    const sectionPos = sectionPositionMap.get(section.section_pattern_id);
    if (!sectionPos || sectionPos.height < 10) continue;
    const sectionTop = Math.max(0, Math.round(sectionPos.startY));
    if (sectionTop >= imgHeight) {
      fallbackSections.push({
        id: section.section_pattern_id,
        startY: sectionPos.startY,
        height: sectionPos.height,
      });
    }
  }

  const screenshots = new Map<string, Buffer>();
  let capturedCount = 0;

  if (fallbackSections.length > 0 && fallbackEnabled) {
    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Batch capturing fallback section screenshots", {
        fallbackSectionCount: fallbackSections.length,
      });
    }

    try {
      const fallbackResult = await captureSectionScreenshots({
        url,
        sections: fallbackSections,
        viewportWidth: job.data.options?.layoutOptions?.viewport?.width ?? 1920,
        viewportHeight: job.data.options?.layoutOptions?.viewport?.height ?? 1080,
        maxSections: 50,
        timeoutMs: fallbackTimeoutMs,
        sharedBrowser: params.sharedBrowser,
        checkMemoryPressure,
      });

      for (const fbResult of fallbackResult.results) {
        if (fbResult.screenshotBuffer && !fbResult.skipped) {
          screenshots.set(fbResult.sectionId, fbResult.screenshotBuffer);
        }
      }
      capturedCount = fallbackResult.capturedCount;
    } catch (batchFallbackError) {
      logger.warn("[PageAnalyzeWorker] Batch section screenshot fallback failed (non-fatal)", {
        error:
          batchFallbackError instanceof Error
            ? batchFallbackError.message
            : String(batchFallbackError),
      });
    }
  }

  return { screenshots, capturedCount };
}

/**
 * セクションビジュアルエンベディングのメインループ処理
 *
 * フォールバックバッチ収集、チャンクごとのcrop→DINOv2→DB保存、
 * 動的Fallbackバッチ処理、診断サマリーログ出力を行う。
 */
async function processSectionVisualEmbeddingLoop(
  loopParams: SectionVisualEmbeddingLoopParams
): Promise<SectionVisualEmbeddingLoopResult> {
  const {
    sectionsFiltered,
    sectionsNeedingVisual,
    sectionPositionMap,
    screenshotBufferRef,
    imgWidth,
    imgHeight,
    fallbackEnabled,
    url,
    job,
    params,
    effectiveToken,
    effectiveLockDuration,
    dinov2Service,
    prisma,
    rawScreenshotMeta,
  } = loopParams;

  const SECTION_FALLBACK_TIMEOUT_MS = 300_000; // 300s cumulative timeout
  let generatedCount = 0;

  // 診断カウンター
  let diagInRangeCount = 0;
  let diagFallbackCount = 0;
  let diagDynamicCount = 0;
  let diagDedupSkipCount = 0;
  let diagSkippedCount = 0;

  // RAW バッファをループ開始時に1回ロード（RAW decode 最適化）
  // ループ内で acquireSectionCropBufferFromRaw に渡し、ファイル I/O を削減
  let sectionRawBuffer: Buffer | null = null;
  if (rawScreenshotMeta) {
    sectionRawBuffer = loadRawBuffer(rawScreenshotMeta);
    if (sectionRawBuffer && isDevelopment()) {
      logger.info("[PageAnalyzeWorker] RAW buffer loaded for section visual embedding loop", {
        rawBufferSizeMb: Math.round(sectionRawBuffer.length / 1024 / 1024),
      });
    }
  }

  // フォールバック対象セクションの事前バッチ収集とキャプチャ
  const { screenshots: fallbackScreenshots, capturedCount: initialFallbackCaptured } =
    await collectFallbackScreenshots(
      sectionsFiltered,
      sectionPositionMap,
      imgHeight,
      fallbackEnabled,
      url,
      job,
      params,
      SECTION_FALLBACK_TIMEOUT_MS
    );
  let sectionFallbackCapturedCount = initialFallbackCaptured;

  // Type-aware 重複ベクトル検出用のスライディングウィンドウ
  const parsedThreshold = parseFloat(process.env["DUPLICATE_VECTOR_THRESHOLD"] ?? "0.995");
  const DUPLICATE_THRESHOLD = Number.isFinite(parsedThreshold) ? parsedThreshold : 0.995;
  const MAX_RECENT_EMBEDDINGS = 10;
  const recentSectionVisualEmbeddings: Array<{
    embedding: number[];
    sectionType: string;
  }> = [];

  // 動的Fallbackキュー: 白画像検出セクションを蓄積
  const MAX_DYNAMIC_FALLBACK_SECTIONS = 20;
  const dynamicFallbackSections: Array<{
    sectionEmbeddingId: string;
    sectionPatternId: string;
    startY: number;
    height: number;
  }> = [];

  let sectionVisualChunkSize = DINOV2_CHUNK_SIZE;

  if (sectionVisualChunkSize <= 0) {
    logger.info("[PageAnalyzeWorker] Section DINOv2 visual embedding disabled (chunk size = 0)");
  }

  // DINOv2 session recycle counter (DINO-4: disabled via DINOV2_RECYCLE_ENABLED=false)
  let dinov2InferenceCount = 0;
  const recycleEnabled = process.env["DINOV2_RECYCLE_ENABLED"] !== "false";
  let recycleAborted = false;

  // DINOv2 fallback dispose/re-init control (DINO-4: disabled via DINOV2_FALLBACK_DISPOSE_ENABLED=false)
  // HDD環境でのre-init遅延回避のためopt-out可能
  const fallbackDisposeEnabled = process.env["DINOV2_FALLBACK_DISPOSE_ENABLED"] !== "false";

  for (
    let offset = 0;
    sectionVisualChunkSize > 0 && offset < sectionsFiltered.length;
    offset += sectionVisualChunkSize
  ) {
    // Memory pressure check
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn("[PageAnalyzeWorker] Critical memory, stopping section visual embedding", {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      sectionVisualChunkSize = Math.max(3, Math.floor(sectionVisualChunkSize / 2));
      logger.warn("[PageAnalyzeWorker] Memory pressure, reducing section visual chunk size", {
        rssMb: memCheck.rssMb,
        newChunkSize: sectionVisualChunkSize,
      });
    }

    // DINOv2 session recycle check (before processing chunk)
    if (
      recycleEnabled &&
      !recycleAborted &&
      DINOV2_RECYCLE_THRESHOLD > 0 &&
      dinov2InferenceCount >= DINOV2_RECYCLE_THRESHOLD
    ) {
      try {
        // DINO-3: reuse pre-resolved dinov2Service (no re-read of DINOV2_MODEL_PATH)
        await dinov2Service.recycle();
        dinov2InferenceCount = 0;
        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] DINOv2 session recycled for memory recovery", {
            threshold: DINOV2_RECYCLE_THRESHOLD,
          });
        }
      } catch (recycleError) {
        // DINO-1: Graceful Degradation — DINOv2 recycle failed, skip remaining visual embeddings
        logger.warn(
          "[PageAnalyzeWorker] DINOv2 recycle failed, skipping remaining visual embeddings (Graceful Degradation)",
          {
            error: recycleError instanceof Error ? recycleError.message : String(recycleError),
            processedSoFar: generatedCount,
          }
        );
        recycleAborted = true;
        break;
      }
    }

    if (recycleAborted) break;

    const chunk = sectionsFiltered.slice(offset, offset + sectionVisualChunkSize);

    // Lock extension per chunk
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-sections-visual");

    for (const section of chunk) {
      const singleResult = await processSingleSectionVisualEmbedding({
        section,
        sectionPositionMap,
        screenshotBuffer: screenshotBufferRef.value!,
        imgWidth,
        imgHeight,
        fallbackScreenshots,
        fallbackEnabled,
        dinov2Service,
        prisma,
        recentSectionVisualEmbeddings,
        dynamicFallbackSections,
        maxDynamicFallbackSections: MAX_DYNAMIC_FALLBACK_SECTIONS,
        duplicateThreshold: DUPLICATE_THRESHOLD,
        maxRecentEmbeddings: MAX_RECENT_EMBEDDINGS,
        rawScreenshotMeta: rawScreenshotMeta ?? undefined,
        rawBuffer: sectionRawBuffer ?? undefined,
      });

      if (singleResult.generated > 0) {
        dinov2InferenceCount += singleResult.generated;
      }
      generatedCount += singleResult.generated;
      diagInRangeCount += singleResult.diagInRange;
      diagFallbackCount += singleResult.diagFallback;
      diagDedupSkipCount += singleResult.diagDedupSkip;
      diagSkippedCount += singleResult.diagSkipped;
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Section visual embedding chunk completed", {
        chunkOffset: offset,
        chunkSize: chunk.length,
        totalVisualSoFar: generatedCount,
      });
    }

    // Inter-chunk memory recovery (except last chunk)
    if (offset + sectionVisualChunkSize < sectionsNeedingVisual.length) {
      tryGarbageCollect();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // P0-C: Release sectionRawBuffer before dynamic fallback (Playwright launch)
  // 動的Fallback前にRAWバッファを解放し、Playwright起動のメモリを確保
  sectionRawBuffer = null;
  tryGarbageCollect();

  // 動的Fallback: 白画像検出セクションをバッチ再キャプチャ
  if (dynamicFallbackSections.length > 0 && fallbackEnabled) {
    // Step 5: DINOv2一時dispose → Playwright Fallback → DINOv2再init
    // DINOv2(~800MB)を解放してPlaywright Chromium(~300-500MB)のメモリ確保
    let dinov2ReInitFailed = false;

    if (fallbackDisposeEnabled) {
      // 1. DINOv2 pre-fallback dispose（メモリ~800MB解放）
      try {
        await dinov2Service.dispose();
        if (isDevelopment()) {
          logger.info(
            "[PageAnalyzeWorker] DINOv2 pre-fallback dispose completed for memory recovery"
          );
        }
      } catch (disposeError) {
        logger.warn(
          "[PageAnalyzeWorker] DINOv2 pre-fallback dispose failed (non-fatal, continuing with fallback)",
          {
            error: disposeError instanceof Error ? disposeError.message : String(disposeError),
          }
        );
      }
    }

    // 2. Playwright Fallbackキャプチャ実行（既存コード）
    const dynamicResult = await processDynamicFallbackBatch({
      dynamicFallbackSections,
      sectionFallbackCapturedCount,
      sectionPositionMap,
      url,
      job,
      params,
      dinov2Service,
      prisma,
      recentSectionVisualEmbeddings,
      duplicateThreshold: DUPLICATE_THRESHOLD,
      maxRecentEmbeddings: MAX_RECENT_EMBEDDINGS,
      fallbackTimeoutMs: SECTION_FALLBACK_TIMEOUT_MS,
    });

    // 3. DINOv2 post-fallback re-init
    // DINO-3: 事前解決済みのdinov2Service.modelPathを再利用（process.env再読み込みしない）
    if (fallbackDisposeEnabled) {
      try {
        await dinov2Service.initialize();
        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] DINOv2 post-fallback re-init completed");
        }
      } catch (reinitError) {
        // DINO-2: Graceful Degradation — re-init失敗時は残りのvisual embeddingをスキップ
        logger.warn(
          "[PageAnalyzeWorker] DINOv2 post-fallback re-init failed, skipping remaining visual embeddings (Graceful Degradation)",
          {
            error: reinitError instanceof Error ? reinitError.message : String(reinitError),
          }
        );
        dinov2ReInitFailed = true;
      }
    }

    // screenshotBuffer解放は動的Fallback内で実施
    screenshotBufferRef.value = null;
    if (typeof global.gc === "function") {
      global.gc();
    }

    sectionFallbackCapturedCount += dynamicResult.capturedCount;
    diagDynamicCount += dynamicResult.dynamicCount;
    generatedCount += dynamicResult.generated;

    // DINO-2: re-init失敗時は後続のvisual embedding処理を停止
    if (dinov2ReInitFailed) {
      logger.warn(
        "[PageAnalyzeWorker] DINOv2 re-init failed after dynamic fallback, " +
          "subsequent visual embedding generation will be skipped"
      );
    }
  }

  // 診断サマリーログ
  logger.info("[PageAnalyzeWorker] Section visual embedding path summary", {
    totalSections: sectionsNeedingVisual.length,
    inRangeCount: diagInRangeCount,
    fallbackCount: diagFallbackCount,
    dynamicCount: diagDynamicCount,
    dedupSkipCount: diagDedupSkipCount,
    skippedCount: diagSkippedCount,
    totalGenerated: generatedCount,
    fallbackCaptured: sectionFallbackCapturedCount,
  });

  return {
    sectionVisualEmbeddingsGenerated: generatedCount,
    screenshotBuffer: screenshotBufferRef.value,
  };
}

/**
 * 単一セクションのビジュアルエンベディング処理パラメータ
 */
interface SingleSectionVisualParams {
  section: { id: string; section_pattern_id: string };
  sectionPositionMap: Map<string, { startY: number; height: number; sectionType: string }>;
  screenshotBuffer: Buffer;
  imgWidth: number;
  imgHeight: number;
  fallbackScreenshots: Map<string, Buffer>;
  fallbackEnabled: boolean;
  dinov2Service: InstanceType<typeof DINOv2Service>;
  prisma: EmbeddingPhasePrismaClient;
  recentSectionVisualEmbeddings: Array<{ embedding: number[]; sectionType: string }>;
  dynamicFallbackSections: Array<{
    sectionEmbeddingId: string;
    sectionPatternId: string;
    startY: number;
    height: number;
  }>;
  maxDynamicFallbackSections: number;
  duplicateThreshold: number;
  maxRecentEmbeddings: number;
  /** RAW スクリーンショットメタデータ（RAW decode 最適化用） */
  rawScreenshotMeta?: RawScreenshotMetadata | undefined;
  /** 事前ロード済み RAW バッファ（ループ内で再利用） */
  rawBuffer?: Buffer | undefined;
}

/**
 * 単一セクションのビジュアルエンベディング処理結果
 */
interface SingleSectionVisualResult {
  generated: number;
  diagInRange: number;
  diagFallback: number;
  diagDedupSkip: number;
  diagSkipped: number;
}

/**
 * 単一セクションに対するcrop→DINOv2→dedup判定→DB保存処理
 */
async function processSingleSectionVisualEmbedding(
  p: SingleSectionVisualParams
): Promise<SingleSectionVisualResult> {
  const result: SingleSectionVisualResult = {
    generated: 0,
    diagInRange: 0,
    diagFallback: 0,
    diagDedupSkip: 0,
    diagSkipped: 0,
  };

  try {
    const sectionPos = p.sectionPositionMap.get(p.section.section_pattern_id);
    if (!sectionPos || sectionPos.height < 10) {
      result.diagSkipped++;
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
          path: "skipped",
          skipReason: !sectionPos ? "no_position" : "height_too_small",
        });
      }
      return result;
    }

    const sectionTop = Math.max(0, Math.round(sectionPos.startY));
    const isOutOfRange = sectionTop >= p.imgHeight;

    // RAW decode 最適化: in-range セクションで RAW メタデータがあれば RAW パスを使用。
    // out-of-range セクション（フォールバック対象）は従来の acquireSectionCropBuffer を使用
    // （フォールバックスクリーンショットは PNG バッファなので RAW パス不適用）。
    let cropResult: { rawCropBuffer: Buffer | null; isBlank: boolean };

    if (!isOutOfRange && p.rawScreenshotMeta && p.rawBuffer) {
      // RAW 最適化パス: PNG デコード不要
      cropResult = await acquireSectionCropBufferFromRaw({
        rawMeta: p.rawScreenshotMeta,
        sectionPos,
        imgWidth: p.imgWidth,
        imgHeight: p.imgHeight,
        dinov2InputSize: DINOV2_INPUT_SIZE,
        rawBuffer: p.rawBuffer,
      });
    } else {
      // 従来パス: PNG デコード（フォールバック対象または RAW 未利用時）
      // TDA HIGH-1: acquireSectionCropBuffer でcropパスを一元管理
      cropResult = await acquireSectionCropBuffer({
        sectionPatternId: p.section.section_pattern_id,
        sectionPos,
        screenshotBuffer: p.screenshotBuffer,
        imgWidth: p.imgWidth,
        imgHeight: p.imgHeight,
        fallbackScreenshots: p.fallbackScreenshots,
        fallbackEnabled: p.fallbackEnabled,
        dinov2InputSize: DINOV2_INPUT_SIZE,
      });
    }

    if (cropResult.isBlank) {
      // 白画像検出: 動的Fallbackキューに蓄積
      if (p.dynamicFallbackSections.length < p.maxDynamicFallbackSections) {
        p.dynamicFallbackSections.push({
          sectionEmbeddingId: p.section.id,
          sectionPatternId: p.section.section_pattern_id,
          startY: sectionPos.startY,
          height: sectionPos.height,
        });
      }
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "dynamic",
        });
      }
      return result;
    }

    if (!cropResult.rawCropBuffer) {
      result.diagSkipped++;
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "skipped",
          skipReason: "no_crop_buffer",
        });
      }
      return result;
    }

    // Generate visual embedding via DINOv2
    const visualEmbedding = await generateVisualEmbedding(
      p.dinov2Service,
      cropResult.rawCropBuffer
    );

    // Type-aware 重複ベクトル検出
    const currentSectionType = sectionPos.sectionType;
    const isDuplicateVector = isDuplicateVisionEmbedding({
      sectionType: currentSectionType,
      height: sectionPos.height,
      embedding: visualEmbedding,
      recentEmbeddings: p.recentSectionVisualEmbeddings,
      threshold: p.duplicateThreshold,
    });

    if (isDuplicateVector) {
      result.diagDedupSkip++;
      logger.warn("[PageAnalyzeWorker] Duplicate vision embedding detected, skipping DB save", {
        sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
        sectionType: currentSectionType,
      });
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "dedup",
          sectionType: currentSectionType,
        });
      }
      return result;
    }

    // スライディングウィンドウに追加
    p.recentSectionVisualEmbeddings.push({
      embedding: visualEmbedding,
      sectionType: currentSectionType,
    });
    if (p.recentSectionVisualEmbeddings.length > p.maxRecentEmbeddings) {
      p.recentSectionVisualEmbeddings.shift();
    }

    // Update vision_embedding in DB via raw SQL
    const visualVectorString = `[${visualEmbedding.join(",")}]`;
    await p.prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
       SET vision_embedding = $1::vector(768)
       WHERE id = $2::uuid`,
      visualVectorString,
      p.section.id
    );

    if (isOutOfRange) {
      result.diagFallback++;
    } else {
      result.diagInRange++;
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Section visual path", {
        sectionId: p.section.section_pattern_id.slice(0, 8) + "...",
        startY: sectionPos.startY,
        height: sectionPos.height,
        imgHeight: p.imgHeight,
        path: isOutOfRange ? "fallback" : "in_range",
      });
    }

    result.generated++;
  } catch (sectionVisualError) {
    result.diagSkipped++;
    logger.warn("[PageAnalyzeWorker] DINOv2 visual embedding failed for section (non-fatal)", {
      sectionEmbeddingId: p.section.id.slice(0, 8) + "...",
      error:
        sectionVisualError instanceof Error
          ? sectionVisualError.message
          : String(sectionVisualError),
    });
  }

  return result;
}

/**
 * 動的Fallbackバッチ処理パラメータ
 */
interface DynamicFallbackBatchParams {
  dynamicFallbackSections: Array<{
    sectionEmbeddingId: string;
    sectionPatternId: string;
    startY: number;
    height: number;
  }>;
  sectionFallbackCapturedCount: number;
  sectionPositionMap: Map<string, { startY: number; height: number; sectionType: string }>;
  url: string;
  job: EmbeddingPhaseParams["job"];
  params: EmbeddingPhaseParams;
  dinov2Service: InstanceType<typeof DINOv2Service>;
  prisma: EmbeddingPhasePrismaClient;
  recentSectionVisualEmbeddings: Array<{ embedding: number[]; sectionType: string }>;
  duplicateThreshold: number;
  maxRecentEmbeddings: number;
  fallbackTimeoutMs: number;
}

/**
 * 動的Fallbackバッチ処理結果
 */
interface DynamicFallbackBatchResult {
  generated: number;
  dynamicCount: number;
  capturedCount: number;
}

/**
 * 白画像検出セクションのバッチ再キャプチャ→DINOv2→DB保存処理
 */
async function processDynamicFallbackBatch(
  p: DynamicFallbackBatchParams
): Promise<DynamicFallbackBatchResult> {
  const result: DynamicFallbackBatchResult = { generated: 0, dynamicCount: 0, capturedCount: 0 };

  const remainingCapacity = Math.max(0, 50 - p.sectionFallbackCapturedCount);
  const dynamicBatch = p.dynamicFallbackSections.slice(0, remainingCapacity);

  if (dynamicBatch.length === 0) return result;

  const memCheckDynamic = checkMemoryPressure();
  if (memCheckDynamic.shouldAbort) {
    logger.warn("[PageAnalyzeWorker] Skipping dynamic fallback due to memory pressure", {
      rssMb: memCheckDynamic.rssMb,
      dynamicFallbackCount: dynamicBatch.length,
    });
    return result;
  }

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] Starting dynamic fallback for blank-detected sections", {
      dynamicFallbackCount: dynamicBatch.length,
      remainingCapacity,
    });
  }

  try {
    const dynamicFallbackResult = await captureSectionScreenshots({
      url: p.url,
      sections: dynamicBatch.map((s) => ({
        id: s.sectionPatternId,
        startY: s.startY,
        height: s.height,
      })),
      viewportWidth: p.job.data.options?.layoutOptions?.viewport?.width ?? 1920,
      viewportHeight: p.job.data.options?.layoutOptions?.viewport?.height ?? 1080,
      maxSections: remainingCapacity,
      timeoutMs: p.fallbackTimeoutMs,
      sharedBrowser: p.params.sharedBrowser,
      checkMemoryPressure,
    });

    result.capturedCount = dynamicFallbackResult.capturedCount;

    for (const fbResult of dynamicFallbackResult.results) {
      if (fbResult.skipped || !fbResult.screenshotBuffer) continue;

      const matchingSection = dynamicBatch.find((s) => s.sectionPatternId === fbResult.sectionId);
      if (!matchingSection) continue;

      try {
        const rawCropBuffer = await sharp(fbResult.screenshotBuffer)
          .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, {
            fit: "cover",
            kernel: "cubic",
          })
          .removeAlpha()
          .toColorspace("srgb")
          .raw()
          .toBuffer();

        // LCC MUST-FIX-3: 動的Fallbackスクリーンショットバッファの参照解除
        fbResult.screenshotBuffer = null;

        const visualEmbedding = await generateVisualEmbedding(p.dinov2Service, rawCropBuffer);

        const dynamicSectionPos = p.sectionPositionMap.get(matchingSection.sectionPatternId);
        const dynamicSectionType = dynamicSectionPos?.sectionType ?? "unknown";
        const isDuplicateVector = isDuplicateVisionEmbedding({
          sectionType: dynamicSectionType,
          height: dynamicSectionPos?.height ?? 0,
          embedding: visualEmbedding,
          recentEmbeddings: p.recentSectionVisualEmbeddings,
          threshold: p.duplicateThreshold,
        });

        if (isDuplicateVector) {
          logger.warn(
            "[PageAnalyzeWorker] Duplicate vision embedding (dynamic fallback), skipping",
            {
              sectionId: fbResult.sectionId.slice(0, 8) + "...",
              sectionType: dynamicSectionType,
            }
          );
          continue;
        }

        p.recentSectionVisualEmbeddings.push({
          embedding: visualEmbedding,
          sectionType: dynamicSectionType,
        });
        if (p.recentSectionVisualEmbeddings.length > p.maxRecentEmbeddings) {
          p.recentSectionVisualEmbeddings.shift();
        }

        const visualVectorString = `[${visualEmbedding.join(",")}]`;
        await p.prisma.$executeRawUnsafe(
          `UPDATE section_embeddings
           SET vision_embedding = $1::vector(768)
           WHERE id = $2::uuid`,
          visualVectorString,
          matchingSection.sectionEmbeddingId
        );

        result.dynamicCount++;
        result.generated++;
      } catch (dynamicEmbeddingError) {
        logger.warn(
          "[PageAnalyzeWorker] DINOv2 visual embedding failed for dynamic fallback section (non-fatal)",
          {
            sectionId: fbResult.sectionId.slice(0, 8) + "...",
            error:
              dynamicEmbeddingError instanceof Error
                ? dynamicEmbeddingError.message
                : String(dynamicEmbeddingError),
          }
        );
      }
    }
  } catch (dynamicFallbackError) {
    logger.warn("[PageAnalyzeWorker] Dynamic section screenshot fallback failed (non-fatal)", {
      error:
        dynamicFallbackError instanceof Error
          ? dynamicFallbackError.message
          : String(dynamicFallbackError),
    });
  }

  return result;
}

// ============================================================================
// Exported Interfaces and Functions for Fork Child Processes
// ============================================================================

import { PHASE5_FORK_ENABLED } from "./types";
import type { ScrollVisionResult } from "../../services/vision/scroll-vision.analyzer";
import type {
  LayoutServiceResult,
  MotionServiceResult,
  JSAnimationFullResult,
} from "../../tools/page/handlers/types";

/**
 * Parameters for text embedding sub-phases (fork child process).
 *
 * Replaces BullMQ Job and EmbeddingPhaseParams with serializable equivalents.
 * Lock extension is delegated to parent via onLockExtend callback → IPC relay.
 */
export interface TextEmbeddingSubPhaseParams {
  webPageId: string;
  url: string;
  sectionSaveResult: { idMapping: Map<string, string> } | null;
  motionSaveResult: { idMapping: Map<string, string> } | null;
  jsSaveResult: { idMapping: Map<string, string> } | null;
  bgSaveResult: { ids: string[] } | null;
  scrollVisionSaveResult: { idMapping: Map<string, string> } | null;
  layoutResultForNarrative: LayoutServiceResult | null;
  motionResultForEmbedding: MotionServiceResult | null;
  jsAnimationsForEmbedding: JSAnimationFullResult | null;
  scrollVisionResultForEmbedding: ScrollVisionResult | null;
  responsiveAnalysisId?: string | undefined;
  partsSavedCount?: number | undefined;
  sharedLayoutEmbeddingService: LayoutEmbeddingService;
  prisma: EmbeddingPhasePrismaClient;
  onLockExtend: (label: string) => void;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Result from text embedding sub-phases (fork child process).
 */
export interface TextEmbeddingSubPhaseResult {
  sectionEmbeddingsGenerated: number;
  motionEmbeddingsGenerated: number;
  bgEmbeddingsGenerated: number;
  jsAnimationEmbeddingsGenerated: number;
  responsiveEmbeddingsGenerated: number;
  partEmbeddingsGenerated: number;
  embeddingFailedChunks: number;
}

/**
 * Run all text embedding sub-phases.
 *
 * Exported for use by fork child process (phase-5-text-embedding-child.ts).
 * Creates a lightweight EmbeddingSubPhaseContext adapter that delegates
 * lock extension to the caller's onLockExtend callback (which sends IPC
 * to the parent for BullMQ Job lock relay).
 */
export async function runTextEmbeddingSubPhases(
  textParams: TextEmbeddingSubPhaseParams
): Promise<TextEmbeddingSubPhaseResult> {
  const textResult: EmbeddingPhaseResult = {
    sectionEmbeddingsGenerated: 0,
    motionEmbeddingsGenerated: 0,
    bgEmbeddingsGenerated: 0,
    jsAnimationEmbeddingsGenerated: 0,
    responsiveEmbeddingsGenerated: 0,
    partEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    sectionVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
    completed: false,
  };

  // Create a no-op job proxy for lock extension via IPC relay
  const noOpJob = createNoOpJobProxy(textParams.onLockExtend);

  // Build context with no-op job adapter
  const totalItems = estimateTotalItems(textParams);
  let completedItems = 0;
  function reportProgress(_subCompleted: number, _subTotal: number): void {
    if (!textParams.onProgress || totalItems <= 0) return;
    completedItems++;
    try {
      textParams.onProgress(completedItems, totalItems);
    } catch {
      /* fire-and-forget */
    }
  }

  const ctx: EmbeddingSubPhaseContext = {
    webPageId: textParams.webPageId,
    url: textParams.url,
    job: noOpJob as EmbeddingPhaseParams["job"],
    params: {
      webPageId: textParams.webPageId,
      url: textParams.url,
      job: noOpJob,
      effectiveToken: "fork-child",
      effectiveLockDuration: 0,
      sectionSaveResult: textParams.sectionSaveResult as EmbeddingPhaseParams["sectionSaveResult"],
      motionSaveResult: textParams.motionSaveResult as EmbeddingPhaseParams["motionSaveResult"],
      jsSaveResult: textParams.jsSaveResult as EmbeddingPhaseParams["jsSaveResult"],
      bgSaveResult: textParams.bgSaveResult as EmbeddingPhaseParams["bgSaveResult"],
      scrollVisionSaveResult:
        textParams.scrollVisionSaveResult as EmbeddingPhaseParams["scrollVisionSaveResult"],
      layoutResultForNarrative: textParams.layoutResultForNarrative,
      motionResultForEmbedding: textParams.motionResultForEmbedding,
      jsAnimationsForEmbedding: textParams.jsAnimationsForEmbedding,
      scrollVisionResultForEmbedding: textParams.scrollVisionResultForEmbedding,
      responsiveAnalysisId: textParams.responsiveAnalysisId,
      partsSavedCount: textParams.partsSavedCount,
    } as EmbeddingPhaseParams,
    effectiveToken: "fork-child",
    effectiveLockDuration: 0,
    sharedLayoutEmbeddingService: textParams.sharedLayoutEmbeddingService,
    gpuResourceManager: createNoOpGpuResourceManager() as GpuResourceManager,
    prisma: textParams.prisma,
    result: textResult,
    reportEmbeddingSubProgress: reportProgress,
  };

  // Run all 7 text embedding sub-phases in order
  await processSectionTextEmbeddingChunks(
    ctx,
    textParams.sectionSaveResult as EmbeddingPhaseParams["sectionSaveResult"],
    textParams.layoutResultForNarrative
  );
  await processMotionTextEmbeddingChunks(
    ctx,
    textParams.motionSaveResult as EmbeddingPhaseParams["motionSaveResult"],
    textParams.motionResultForEmbedding
  );
  await processVisionMotionEmbeddingChunks(
    ctx,
    textParams.scrollVisionSaveResult as EmbeddingPhaseParams["scrollVisionSaveResult"],
    textParams.scrollVisionResultForEmbedding
  );
  await processBackgroundTextEmbeddingChunks(
    ctx,
    textParams.bgSaveResult as EmbeddingPhaseParams["bgSaveResult"],
    textParams.layoutResultForNarrative
  );
  await processJsAnimationEmbeddingChunks(
    ctx,
    textParams.jsSaveResult as EmbeddingPhaseParams["jsSaveResult"],
    textParams.jsAnimationsForEmbedding
  );
  await processResponsiveEmbeddingChunks(ctx, textParams.responsiveAnalysisId);
  await processPartTextEmbeddingChunks(ctx, textParams.partsSavedCount);

  return {
    sectionEmbeddingsGenerated: textResult.sectionEmbeddingsGenerated,
    motionEmbeddingsGenerated: textResult.motionEmbeddingsGenerated,
    bgEmbeddingsGenerated: textResult.bgEmbeddingsGenerated,
    jsAnimationEmbeddingsGenerated: textResult.jsAnimationEmbeddingsGenerated,
    responsiveEmbeddingsGenerated: textResult.responsiveEmbeddingsGenerated,
    partEmbeddingsGenerated: textResult.partEmbeddingsGenerated,
    embeddingFailedChunks: textResult.embeddingFailedChunks,
  };
}

/**
 * Parameters for visual embedding sub-phases (fork child process).
 */
export interface VisualEmbeddingSubPhaseParams {
  webPageId: string;
  url: string;
  screenshotPngPath: string;
  sectionIdMapping: Map<string, string>;
  partsSavedCount: number;
  layoutResultJson: string | null;
  viewportWidth?: number | undefined;
  viewportHeight?: number | undefined;
  fallbackEnabled: boolean;
  dinov2ModelPath: string;
  prisma: EmbeddingPhasePrismaClient;
  onLockExtend: (label: string) => void;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Result from visual embedding sub-phases (fork child process).
 */
export interface VisualEmbeddingSubPhaseResult {
  sectionVisualEmbeddingsGenerated: number;
  partVisualEmbeddingsGenerated: number;
  embeddingFailedChunks: number;
}

/**
 * Run all visual embedding sub-phases (DINOv2).
 *
 * Exported for use by fork child process (phase-5-visual-embedding-child.ts).
 * Handles DINOv2 init/dispose, RAW decode optimization, section + part visual
 * embedding, and section screenshot fallback.
 */
export async function runVisualEmbeddingSubPhases(
  vParams: VisualEmbeddingSubPhaseParams
): Promise<VisualEmbeddingSubPhaseResult> {
  const vResult: VisualEmbeddingSubPhaseResult = {
    sectionVisualEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
  };

  const hasSections = vParams.sectionIdMapping.size > 0;
  const hasParts = vParams.partsSavedCount > 0;

  // Read screenshot buffer from file (SEC M-NEW-1: prefix check)
  let screenshotBuffer: Buffer | null = null;
  const resolvedPng = path.resolve(vParams.screenshotPngPath);
  if (!resolvedPng.includes("reftrix-phase5")) {
    logger.warn("[Phase5Visual] screenshotPngPath rejected by prefix check");
  } else if (fs.existsSync(resolvedPng)) {
    screenshotBuffer = fs.readFileSync(resolvedPng);
  }
  if (!screenshotBuffer) return vResult;

  // Initialize DINOv2
  const dinov2Service = new DINOv2Service({ modelPath: vParams.dinov2ModelPath });
  await dinov2Service.initialize();

  try {
    const screenshotMeta = await sharp(screenshotBuffer).metadata();
    const imgWidth = screenshotMeta.width ?? 0;
    const imgHeight = screenshotMeta.height ?? 0;

    // RAW Decode Optimization
    let rawScreenshotMeta: RawScreenshotMetadata | null = null;
    const phase5TmpDir = path.dirname(vParams.screenshotPngPath);

    try {
      const resolvedPng = path.resolve(vParams.screenshotPngPath);
      const resolvedTmp = path.resolve(phase5TmpDir);
      if (resolvedPng.startsWith(resolvedTmp)) {
        const pngStat = fs.statSync(vParams.screenshotPngPath);
        if (pngStat.size <= 500 * 1024 * 1024) {
          rawScreenshotMeta = await decodeToRawFile(vParams.screenshotPngPath, phase5TmpDir);
        }
      }
    } catch {
      rawScreenshotMeta = null;
    }

    const noOpJob = createNoOpJobProxy(vParams.onLockExtend);
    const fakeParams: EmbeddingPhaseParams = {
      webPageId: vParams.webPageId,
      url: vParams.url,
      job: noOpJob as EmbeddingPhaseParams["job"],
      effectiveToken: "fork-child",
      effectiveLockDuration: 0,
      sectionSaveResult: null,
      motionSaveResult: null,
      jsSaveResult: null,
      bgSaveResult: null,
      scrollVisionSaveResult: null,
      layoutResultForNarrative: null,
      motionResultForEmbedding: null,
      jsAnimationsForEmbedding: null,
      scrollVisionResultForEmbedding: null,
    };

    // Section Visual Embedding
    if (hasSections) {
      try {
        vParams.onLockExtend("embedding-sections-visual");

        const sectionsNeedingVisual = await vParams.prisma.$queryRawUnsafe<
          Array<{ id: string; section_pattern_id: string }>
        >(
          `SELECT id, section_pattern_id
           FROM section_embeddings
           WHERE section_pattern_id IN (
             SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
           )
           AND text_embedding IS NOT NULL
           AND vision_embedding IS NULL`,
          vParams.webPageId
        );

        if (sectionsNeedingVisual.length > 0) {
          const sectionPatternIds = sectionsNeedingVisual.map((s) => s.section_pattern_id);
          const sectionPatterns = (await vParams.prisma.sectionPattern.findMany({
            where: { id: { in: sectionPatternIds } },
            select: { id: true, layoutInfo: true, sectionType: true },
          })) as Array<{ id: string; layoutInfo: unknown; sectionType: string }>;
          const sectionPositionMap = new Map<
            string,
            { startY: number; height: number; sectionType: string }
          >();
          for (const sp of sectionPatterns) {
            const info = sp.layoutInfo as Record<string, unknown> | null;
            const position = info?.position as { startY?: number; height?: number } | undefined;
            sectionPositionMap.set(sp.id, {
              startY: position?.startY ?? 0,
              height: position?.height ?? 0,
              sectionType: sp.sectionType,
            });
          }

          // PII protection (GDPR Art. 5(1)(c))
          const highPiiSectionIds = await vParams.prisma.$queryRawUnsafe<
            Array<{ section_pattern_id: string }>
          >(
            `SELECT DISTINCT cp.section_pattern_id
             FROM component_parts cp
             WHERE cp.section_pattern_id IN (${sectionPatternIds.map((_, i) => `$${i + 1}::uuid`).join(", ")})
             AND cp.pii_risk_level = 'high'`,
            ...sectionPatternIds
          );
          const highPiiSectionIdSet = new Set(highPiiSectionIds.map((r) => r.section_pattern_id));

          const sectionsFiltered =
            highPiiSectionIdSet.size > 0
              ? sectionsNeedingVisual.filter((s) => !highPiiSectionIdSet.has(s.section_pattern_id))
              : sectionsNeedingVisual;

          const sectionVisualLoop = await processSectionVisualEmbeddingLoop({
            sectionsFiltered,
            sectionsNeedingVisual,
            sectionPositionMap,
            screenshotBufferRef: { value: screenshotBuffer },
            imgWidth,
            imgHeight,
            fallbackEnabled: vParams.fallbackEnabled,
            url: vParams.url,
            job: noOpJob as EmbeddingPhaseParams["job"],
            params: fakeParams,
            effectiveToken: "fork-child",
            effectiveLockDuration: 0,
            dinov2Service,
            prisma: vParams.prisma,
            rawScreenshotMeta,
          });

          screenshotBuffer = sectionVisualLoop.screenshotBuffer;
          vResult.sectionVisualEmbeddingsGenerated +=
            sectionVisualLoop.sectionVisualEmbeddingsGenerated;
        }
      } catch (sectionVisErr) {
        vResult.embeddingFailedChunks++;
        logger.warn("[Phase5-VisualChild] Section DINOv2 visual embedding failed (non-fatal)", {
          error: sectionVisErr instanceof Error ? sectionVisErr.message : String(sectionVisErr),
        });
      }

      tryGarbageCollect();
    }

    // Part Visual Embedding
    if (hasParts) {
      try {
        const partResultHolder: EmbeddingPhaseResult = {
          sectionEmbeddingsGenerated: 0,
          motionEmbeddingsGenerated: 0,
          bgEmbeddingsGenerated: 0,
          jsAnimationEmbeddingsGenerated: 0,
          responsiveEmbeddingsGenerated: 0,
          partEmbeddingsGenerated: 0,
          partVisualEmbeddingsGenerated: 0,
          sectionVisualEmbeddingsGenerated: 0,
          embeddingFailedChunks: 0,
          completed: false,
        };

        const partCtx: EmbeddingSubPhaseContext = {
          webPageId: vParams.webPageId,
          url: vParams.url,
          job: noOpJob as EmbeddingPhaseParams["job"],
          params: fakeParams,
          effectiveToken: "fork-child",
          effectiveLockDuration: 0,
          sharedLayoutEmbeddingService: null as unknown as LayoutEmbeddingService,
          gpuResourceManager: createNoOpGpuResourceManager() as GpuResourceManager,
          prisma: vParams.prisma,
          result: partResultHolder,
          reportEmbeddingSubProgress: () => {
            /* no-op */
          },
        };

        await processPartVisualEmbeddingLoop(
          partCtx,
          screenshotBuffer,
          rawScreenshotMeta,
          null,
          imgWidth,
          imgHeight,
          dinov2Service
        );

        vResult.partVisualEmbeddingsGenerated = partResultHolder.partVisualEmbeddingsGenerated;
      } catch (partVisErr) {
        vResult.embeddingFailedChunks++;
        logger.warn("[Phase5-VisualChild] Part DINOv2 visual embedding failed (non-fatal)", {
          error: partVisErr instanceof Error ? partVisErr.message : String(partVisErr),
        });
      }
    }

    if (rawScreenshotMeta?.rawPath) {
      try {
        fs.unlinkSync(rawScreenshotMeta.rawPath);
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      await dinov2Service.dispose();
    } catch {
      /* ignore */
    }
    tryGarbageCollect();
  }

  return vResult;
}

// ============================================================================
// Dispatch Function: Fork vs Legacy
// ============================================================================

/**
 * Dispatch Phase 5 embedding generation — fork mode or legacy in-process.
 *
 * When PHASE5_FORK_ENABLED is true (default), delegates to runPhase5ViaFork()
 * which spawns child processes. When false, falls back to processEmbeddingPhase()
 * which runs everything in-process.
 */
export async function dispatchEmbeddingPhase(
  params: EmbeddingPhaseParams,
  deps: EmbeddingPhaseDeps
): Promise<EmbeddingPhaseResult> {
  if (!PHASE5_FORK_ENABLED) {
    return processEmbeddingPhase(params, deps);
  }

  // Dynamic import to avoid loading fork orchestrator when not needed
  const { runPhase5ViaFork } = await import("./phase-5-fork-orchestrator.js");

  // DINOv2 model path resolution (shared with legacy path)
  let dinov2ModelPath: string;
  if (process.env["DINOV2_MODEL_PATH"]) {
    dinov2ModelPath = process.env["DINOV2_MODEL_PATH"];
  } else {
    const mlMainPath = require.resolve("@reftrixmcp/ml");
    const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
    dinov2ModelPath = path.join(mlRoot, "models", "dinov2-base", "model.onnx");
  }

  // resolvePartBoundingBoxes requires sharedBrowser — must run in parent
  const resolvePartBboxFn = async (): Promise<void> => {
    const hasParts = (params.partsSavedCount ?? 0) > 0;
    if (!hasParts) return;

    try {
      const bboxResult = await resolvePartBoundingBoxes({
        webPageId: params.webPageId,
        url: params.url,
        prisma: deps.prisma as never,
        sharedBrowser: params.sharedBrowser,
        viewportWidth: params.job.data.options?.layoutOptions?.viewport?.width,
        viewportHeight: params.job.data.options?.layoutOptions?.viewport?.height,
      });
      if (isDevelopment()) {
        logger.info("[Phase5-Dispatch] Resolved part bounding boxes via Playwright", {
          resolved: bboxResult.resolvedCount,
          skipped: bboxResult.skippedCount,
        });
      }
    } catch (bboxError) {
      logger.warn("[Phase5-Dispatch] Part bounding box resolution failed (non-fatal)", {
        error: bboxError instanceof Error ? bboxError.message : String(bboxError),
      });
    }
  };

  return runPhase5ViaFork(params, { resolvePartBboxFn, dinov2ModelPath });
}

// ============================================================================
// Fork Helper: No-Op Adapters
// ============================================================================

/**
 * Create a no-op Job proxy for fork child processes.
 *
 * Fork children cannot hold a BullMQ Job instance (not serializable).
 * Lock extension is delegated to parent via IPC. The extendLock method
 * calls onLockExtend callback which sends an IPC lock-request message.
 */
function createNoOpJobProxy(onLockExtend: (label: string) => void): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "extendLock") {
          return async (_token?: string, _duration?: number): Promise<void> => {
            onLockExtend("fork-child-lock");
          };
        }
        if (prop === "data") {
          return { options: {} };
        }
        return undefined;
      },
    }
  );
}

/**
 * Create a no-op GpuResourceManager for fork child processes.
 */
function createNoOpGpuResourceManager(): unknown {
  return {
    acquireForDINOv2: async () => ({ mode: "cpu", message: "fork child - no GPU manager" }),
    acquireForEmbedding: async () => ({ mode: "cpu", message: "fork child - no GPU manager" }),
    release: async (): Promise<void> => {
      /* no-op */
    },
  };
}

/**
 * Estimate total embedding items for progress reporting.
 */
function estimateTotalItems(textParams: TextEmbeddingSubPhaseParams): number {
  let total = 0;
  if (textParams.sectionSaveResult && textParams.layoutResultForNarrative) {
    const sections = (textParams.layoutResultForNarrative as { sections?: unknown[] }).sections;
    total += sections?.length ?? 0;
  }
  if (textParams.motionSaveResult && textParams.motionResultForEmbedding) {
    const patterns = (textParams.motionResultForEmbedding as { patterns?: unknown[] }).patterns;
    total += patterns?.length ?? 0;
  }
  if (textParams.bgSaveResult && textParams.layoutResultForNarrative) {
    const bgs = (textParams.layoutResultForNarrative as { backgroundDesigns?: unknown[] })
      .backgroundDesigns;
    total += bgs?.length ?? 0;
  }
  if (textParams.jsSaveResult) {
    total += textParams.jsSaveResult.idMapping.size;
  }
  return total;
}
