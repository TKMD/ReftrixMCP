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
import * as os from "node:os";
import * as fs from "node:fs";
import { resolvePhase5Dir } from "../../services/screenshot-persistence.service";

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
// v0.4.0 PR7d-2 (TDA LOW-1): also import createPhase5TempDir/cleanupPhase5TempDir
// so RAW decode writes into an ephemeral `reftrix-phase5-raw-*` dir under
// os.tmpdir() (whitelisted by cleanupPhase5TempDir) instead of the persisted
// screenshot directory. Prevents stale RAW files under
// <REFTRIX_SCREENSHOT_ROOT>/phase5/ on exception paths.
// v0.4.0 PR7d-2 (TDA LOW-1): createPhase5TempDir/cleanupPhase5TempDir を追加
// import し、RAW decode を `<REFTRIX_SCREENSHOT_ROOT>/phase5/` ではなく
// os.tmpdir() 配下の `reftrix-phase5-raw-*` (whitelist 対象) に書き出す。
import {
  createPhase5TempDir,
  cleanupPhase5TempDir,
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
// Dependency Injection Interface
// ============================================================================

/**
 * Dependencies injected from the orchestrator (module-level singletons).
 *
 * dispatchEmbeddingPhase は page-analyze-worker.ts のモジュールレベルシングルトン
 * (sharedLayoutEmbeddingService, gpuResourceManager, prisma) を
 * このインターフェースを通じて受け取る。
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
// Screenshot path allowlist (SEC: Path Traversal defense)
// ============================================================================

/**
 * Phase 5 で screenshot PNG として受け入れるパスを検証する
 * Validate that the given absolute path is an acceptable screenshot location
 *
 * 許可ルート（いずれか配下であれば OK） / Allowed roots (must be under one of):
 *   1. `<os.tmpdir()>/reftrix-phase5-raw-<random>/` - 短命 RAW decode tmp dir
 *   2. `<REFTRIX_SCREENSHOT_ROOT>/phase5/`          - v0.4.0 永続化パス
 */
async function isAllowedScreenshotPath(absolutePath: string): Promise<boolean> {
  const tmpRoot = path.resolve(os.tmpdir());
  const persistRoot = await resolvePhase5Dir();
  const underTmpPhase5Raw =
    absolutePath.startsWith(tmpRoot + path.sep) &&
    path.basename(path.dirname(absolutePath)).startsWith("reftrix-phase5-raw-");
  const underPersistRoot =
    absolutePath.startsWith(persistRoot + path.sep) || absolutePath === persistRoot;
  return underTmpPhase5Raw || underPersistRoot;
}

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
// Legacy processEmbeddingPhase removed (v0.4.0)
//
// The in-process embedding path was retired. Phase 5 always uses
// child_process.fork() via dispatchEmbeddingPhase → runPhase5ViaFork().
// ============================================================================

// ============================================================================
// Text Embedding Sub-Phase Functions
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
 *
 * @param options.limit - v0.4.0 PR4: 処理する Part 件数の上限。
 *   100 件超のページで同期フェーズを 100 件に切り詰め、残りを Queue 経由で
 *   バックフィルする。未指定 (undefined) / 0 以下 / 非有限値は無制限として扱う。
 *
 *   v0.4.0 PR4: cap the number of Parts processed. Used to truncate the
 *   synchronous phase to 100 items when there are more than 100 Parts so the
 *   remainder is backfilled via the queue. Undefined, zero, negative, or
 *   non-finite values mean "no limit".
 */
async function processPartTextEmbeddingChunks(
  ctx: EmbeddingSubPhaseContext,
  partsSavedCount: number | undefined,
  options?: { limit?: number | undefined }
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

  // v0.4.0 PR4: limit 検証（NaN/Infinity 防御 + 非正値の無効化）
  // v0.4.0 PR4: limit validation (NaN/Infinity defense + reject non-positive)
  const resolvedLimit =
    options?.limit !== undefined &&
    Number.isFinite(options.limit) &&
    options.limit > 0 &&
    Number.isInteger(options.limit)
      ? options.limit
      : undefined;

  try {
    const findManyArgs: Record<string, unknown> = {
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
    };
    // Prisma の findMany は take を指定すると DB レベルで件数制限する
    // Prisma findMany applies `take` at the DB level to cap row count
    if (resolvedLimit !== undefined) {
      findManyArgs.take = resolvedLimit;
      // 決定的な順序を保証するため id 昇順に固定
      // Fix ordering for determinism when truncating
      findManyArgs.orderBy = { id: "asc" };
    }
    const partsForEmbedding = (await ctx.prisma.componentPart.findMany(findManyArgs)) as Array<{
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
 *
 * @param options.limit - v0.4.0 PR4: 処理する Part 件数の上限（`part_text` と同様）。
 *   未指定 / 非有限値 / 非正値は無制限扱い。
 *
 *   v0.4.0 PR4: cap on the number of Parts processed (mirrors `part_text`).
 *   Undefined / non-finite / non-positive values mean "no limit".
 */
async function processPartVisualEmbeddingLoop(
  ctx: EmbeddingSubPhaseContext,
  screenshotBuffer: Buffer | null,
  rawScreenshotMeta: RawScreenshotMetadata | null,
  screenshotBase64ForParts: string | null,
  imgWidth: number,
  imgHeight: number,
  dinov2Service: InstanceType<typeof DINOv2Service>,
  options?: { limit?: number | undefined }
): Promise<void> {
  // v0.4.0 PR4: limit 検証（NaN/Infinity 防御）
  // v0.4.0 PR4: limit validation
  const resolvedLimit =
    options?.limit !== undefined &&
    Number.isFinite(options.limit) &&
    options.limit > 0 &&
    Number.isInteger(options.limit)
      ? options.limit
      : undefined;

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
    // v0.4.0 PR4: limit 指定時は DB レベルで件数制限 + 決定的順序
    // v0.4.0 PR4: DB-level cap + deterministic ordering when limit is set
    ...(resolvedLimit !== undefined ? { take: resolvedLimit, orderBy: { id: "asc" } } : {}),
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
  /**
   * v0.4.0 PR4: Part text embedding の同期フェーズで処理する上限件数。
   * 100 件超のページで 100 に設定され、残余は embedding-backfill Queue 経由で処理する。
   * undefined / 非正値 / 非有限値は無制限扱い。
   *
   * v0.4.0 PR4: Maximum number of Part text embeddings to process in the
   * synchronous phase. Set to 100 when a page has more than 100 Parts so the
   * remainder is processed via the embedding-backfill Queue. Undefined /
   * non-positive / non-finite values mean "no limit".
   */
  partsLimit?: number | undefined;
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
  // v0.4.0 PR4: 同期フェーズは partsLimit に従って DB レベルで件数制限する
  // v0.4.0 PR4: sync phase respects partsLimit (DB-level cap)
  await processPartTextEmbeddingChunks(ctx, textParams.partsSavedCount, {
    limit: textParams.partsLimit,
  });

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
  /**
   * v0.4.0 PR4: Part visual embedding の同期フェーズで処理する上限件数。
   * 100 件超のページで 100 に設定され、残余は embedding-backfill Queue 経由で処理する。
   * undefined / 非正値 / 非有限値は無制限扱い。
   *
   * v0.4.0 PR4: Maximum number of Part visual embeddings to process in the
   * synchronous phase. Set to 100 when a page has more than 100 Parts so the
   * remainder is processed via the embedding-backfill Queue.
   */
  partsLimit?: number | undefined;
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

  // Read screenshot buffer from file
  // SEC: 許可されたルート配下のみを受け入れる（Path Traversal 防御）
  //   - `<tmpdir>/reftrix-phase5-raw-*`: Phase 5 RAW decode 用短命ディレクトリ
  //   - `<REFTRIX_SCREENSHOT_ROOT>/phase5/`: v0.4.0 永続化パス
  // Accept only paths under the allowed roots:
  //   - `<tmpdir>/reftrix-phase5-raw-*`: ephemeral Phase 5 RAW decode dir
  //   - `<REFTRIX_SCREENSHOT_ROOT>/phase5/`: v0.4.0 persistence path
  let screenshotBuffer: Buffer | null = null;
  const resolvedPng = path.resolve(vParams.screenshotPngPath);
  if (!(await isAllowedScreenshotPath(resolvedPng))) {
    logger.warn("[Phase5Visual] screenshotPngPath rejected by allowlist check");
  } else if (fs.existsSync(resolvedPng)) {
    screenshotBuffer = fs.readFileSync(resolvedPng);
  }
  if (!screenshotBuffer) return vResult;

  // Initialize DINOv2
  const dinov2Service = new DINOv2Service({ modelPath: vParams.dinov2ModelPath });
  await dinov2Service.initialize();

  // v0.4.0 PR7d-2 (TDA LOW-1): lifted outside the try so the outer finally
  // can reach it for unconditional cleanup.
  // v0.4.0 PR7d-2 (TDA LOW-1): 外側 finally から unconditional cleanup
  // できるよう try の外に lift。
  let phase5TmpDir: string | null = null;

  try {
    const screenshotMeta = await sharp(screenshotBuffer).metadata();
    const imgWidth = screenshotMeta.width ?? 0;
    const imgHeight = screenshotMeta.height ?? 0;

    // RAW Decode Optimization
    //
    // v0.4.0 PR7d-2 (TDA LOW-1): write the RAW-decoded buffer into a fresh
    // ephemeral `reftrix-phase5-raw-*` dir under `os.tmpdir()` (not into the
    // persisted screenshot directory `<REFTRIX_SCREENSHOT_ROOT>/phase5/`).
    //
    // Rationale:
    //   - The persisted screenshot dir is GDPR-sensitive storage with a 7d
    //     TTL cron; mixing ephemeral RAW files in risks (a) leaking them past
    //     the TTL reconciliation window and (b) re-introducing the PR7a..c
    //     retention-over-deletion bug class if any cleanup path ever
    //     widened its scope.
    //   - `cleanupPhase5TempDir()` enforces a 3-stage whitelist that requires
    //     the `reftrix-phase5-raw-` prefix under `os.tmpdir()`, so using the
    //     persisted path would have rejected cleanup anyway.
    //   - Exception paths now cleanly `cleanupPhase5TempDir(phase5TmpDir)` in
    //     the outer `finally` below; `fs.unlinkSync(rawScreenshotMeta.rawPath)`
    //     remains as double-defence for the happy path.
    //
    // v0.4.0 PR7d-2 (TDA LOW-1): RAW decode 出力先を永続化ディレクトリでは
    // なく os.tmpdir() 配下の短命 `reftrix-phase5-raw-*` に切り替える。
    //   - 永続化ディレクトリは GDPR の 7d TTL 管理下にあり、短命 RAW を
    //     混入させると TTL 外でのリーク/破損リスクが発生する。
    //   - `cleanupPhase5TempDir()` は prefix + os.tmpdir() 配下の 3 段 whitelist
    //     検証を行うため、永続化パスは元々削除対象外。
    //   - 例外経路は下の outer `finally` で `cleanupPhase5TempDir()` により
    //     確実に回収される (happy path の `fs.unlinkSync` は二重防御として残置)。
    let rawScreenshotMeta: RawScreenshotMetadata | null = null;

    try {
      phase5TmpDir = createPhase5TempDir();
      const pngStat = fs.statSync(vParams.screenshotPngPath);
      if (pngStat.size <= 500 * 1024 * 1024) {
        rawScreenshotMeta = await decodeToRawFile(vParams.screenshotPngPath, phase5TmpDir);
      }
    } catch {
      rawScreenshotMeta = null;
    }

    // OOM-FIX-5: Release PNG buffer after RAW decode succeeds.
    // RAW file on disk is the source of truth from here — PNG buffer is no longer needed.
    if (rawScreenshotMeta) {
      screenshotBuffer = null;
      if (typeof globalThis.gc === "function") globalThis.gc();
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
          dinov2Service,
          // v0.4.0 PR4: partsLimit を DINOv2 ループへ伝搬
          // v0.4.0 PR4: propagate partsLimit to the DINOv2 loop
          { limit: vParams.partsLimit }
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
    // v0.4.0 PR7d-2 (TDA LOW-1): Guarantee cleanup of the ephemeral RAW decode
    // tmp dir even if visual embedding throws mid-loop. `cleanupPhase5TempDir`
    // applies a 3-stage whitelist so a mis-set path is silently rejected
    // rather than accidentally nuking the persisted screenshot directory.
    // v0.4.0 PR7d-2 (TDA LOW-1): visual embedding の途中例外でも RAW decode
    // 用短命 tmp dir を確実に回収する。`cleanupPhase5TempDir` の 3 段
    // whitelist により、誤ったパスは silent reject され永続化ディレクトリを
    // 誤削除することはない。
    if (phase5TmpDir) {
      cleanupPhase5TempDir(phase5TmpDir);
    }
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
// Dispatch Function
// ============================================================================

/**
 * Dispatch Phase 5 embedding generation via child_process.fork().
 *
 * Delegates to runPhase5ViaFork() which spawns child processes for text
 * and visual embedding, preventing ONNX Runtime glibc malloc fragmentation
 * from accumulating in the parent worker.
 */
export async function dispatchEmbeddingPhase(
  params: EmbeddingPhaseParams,
  deps: EmbeddingPhaseDeps
): Promise<EmbeddingPhaseResult> {
  const { runPhase5ViaFork } = await import("./phase-5-fork-orchestrator.js");
  // v0.4.0 PR7c: Screenshot 削除は PR6 の TTL cron (`scheduleScreenshotCleanupCron`, 7d)
  //   に一本化したため、Phase 5 dispatch では ScreenshotPersistenceService を注入しない。
  //   GDPR `data.delete` 経路は `service-registrar-search.ts` 経由で引き続きサービスを使用する。
  // v0.4.0 PR7c: Screenshot deletion is consolidated into PR6's TTL cron, so Phase 5
  //   dispatch no longer injects ScreenshotPersistenceService. The GDPR `data.delete`
  //   path continues to use it via `service-registrar-search.ts`.

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

  return runPhase5ViaFork(params, {
    resolvePartBboxFn,
    dinov2ModelPath,
  });
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
