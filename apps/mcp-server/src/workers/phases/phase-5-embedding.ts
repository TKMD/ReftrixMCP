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
import { DINOv2Service, DINOV2_INPUT_SIZE } from "@reftrix/ml";
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
  JS_ANIMATION_EMBEDDING_CHUNK_SIZE,
  checkMemoryPressure,
  tryGarbageCollect,
  extendJobLock,
  isDuplicateVisionEmbedding,
  acquireSectionCropBuffer,
  generateJsAnimationTextRepresentation,
  saveJsAnimationEmbeddingChunk,
} from "./types";

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

// ============================================================================
// Main Phase Function
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
    screenshotBase64,
    onProgress,
  } = params;

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

  // Compound progress tracking: accumulate across all 4 embedding sub-phases
  // Calculate total expected items for proportional progress reporting
  const sectionCount =
    sectionSaveResult && sectionSaveResult.idMapping.size > 0 && layoutResultForNarrative?.sections
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

  /** Report compound embedding progress via parent onProgress callback */
  function reportEmbeddingSubProgress(_subCompleted: number, _subTotal: number): void {
    if (!onProgress || totalEmbeddingItems <= 0) return;
    // Each call increments the global counter by 1 item
    completedEmbeddingItems++;
    try {
      onProgress(completedEmbeddingItems, totalEmbeddingItems);
    } catch {
      /* fire-and-forget */
    }
  }

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

    // 1. SectionEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-sections");
    if (
      sectionSaveResult &&
      sectionSaveResult.idMapping.size > 0 &&
      layoutResultForNarrative?.sections
    ) {
      const allSections = layoutResultForNarrative.sections as SectionDataForEmbedding[];
      let sectionChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < allSections.length; offset += sectionChunkSize) {
        // メモリ圧力チェック: degradation時はチャンクサイズ縮小
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

        // チャンクごとに lock extension（大量アイテム処理での lockDuration 超過リスク回避）
        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-sections");

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const section of chunkSections) {
          const dbId = sectionSaveResult.idMapping.get(section.id);
          if (dbId) chunkIdMapping.set(section.id, dbId);
        }

        try {
          const sectionEmbResult = await generateSectionEmbeddings(chunkSections, chunkIdMapping, {
            webPageId,
            onProgress: reportEmbeddingSubProgress,
            layoutEmbeddingService: sharedLayoutEmbeddingService,
          });

          result.sectionEmbeddingsGenerated += sectionEmbResult.generatedCount;

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] SectionEmbeddings chunk completed", {
              chunkOffset: offset,
              chunkSize: chunkSections.length,
              generatedCount: sectionEmbResult.generatedCount,
              failedCount: sectionEmbResult.failedCount,
              totalSoFar: result.sectionEmbeddingsGenerated,
            });
          }
        } catch (sectionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn("[PageAnalyzeWorker] SectionEmbedding chunk failed (non-fatal)", {
            chunkOffset: offset,
            error:
              sectionEmbError instanceof Error ? sectionEmbError.message : String(sectionEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + sectionChunkSize < allSections.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Section embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 2. MotionEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-motions");
    if (
      motionSaveResult &&
      motionSaveResult.idMapping.size > 0 &&
      motionResultForEmbedding?.patterns
    ) {
      const allMotionPatterns = motionResultForEmbedding.patterns as MotionPatternForEmbedding[];
      let motionChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < allMotionPatterns.length; offset += motionChunkSize) {
        // メモリ圧力チェック
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

        // チャンクごとに lock extension
        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-motions");

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const pattern of chunkPatterns) {
          const dbId = motionSaveResult.idMapping.get(pattern.id);
          if (dbId) chunkIdMapping.set(pattern.id, dbId);
        }

        try {
          const motionEmbResult = await generateMotionEmbeddings(chunkPatterns, {
            webPageId,
            sourceUrl: url,
            motionPatternIdMapping: chunkIdMapping,
            onProgress: reportEmbeddingSubProgress,
          });

          result.motionEmbeddingsGenerated += motionEmbResult.savedCount;

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] MotionEmbeddings chunk completed", {
              chunkOffset: offset,
              chunkSize: chunkPatterns.length,
              savedCount: motionEmbResult.savedCount,
              errorCount: motionEmbResult.errors.length,
              totalSoFar: result.motionEmbeddingsGenerated,
            });
          }
        } catch (motionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn("[PageAnalyzeWorker] MotionEmbedding chunk failed (non-fatal)", {
            chunkOffset: offset,
            error:
              motionEmbError instanceof Error ? motionEmbError.message : String(motionEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + motionChunkSize < allMotionPatterns.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    // 2.5. Vision-detected MotionEmbedding生成（scroll-vision由来、チャンク化対象）
    if (
      scrollVisionSaveResult &&
      scrollVisionSaveResult.idMapping.size > 0 &&
      scrollVisionResultForEmbedding
    ) {
      // vision_detectedパターンをMotionPatternForEmbedding形式に変換
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
            {
              rssMb: memCheck.rssMb,
              newChunkSize: visionChunkSize,
            }
          );
        }

        const chunkVisionPatterns = visionPatterns.slice(offset, offset + visionChunkSize);

        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-motions");

        const chunkVisionIdMapping = new Map<string, string>();
        for (const pattern of chunkVisionPatterns) {
          const dbId = scrollVisionSaveResult.idMapping.get(pattern.id);
          if (dbId) chunkVisionIdMapping.set(pattern.id, dbId);
        }

        try {
          const visionEmbResult = await generateMotionEmbeddings(chunkVisionPatterns, {
            webPageId,
            sourceUrl: url,
            motionPatternIdMapping: chunkVisionIdMapping,
            onProgress: reportEmbeddingSubProgress,
          });

          result.motionEmbeddingsGenerated += visionEmbResult.savedCount;

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] Vision-detected MotionEmbeddings chunk completed", {
              chunkOffset: offset,
              savedCount: visionEmbResult.savedCount,
              errorCount: visionEmbResult.errors.length,
            });
          }
        } catch (visionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn(
            "[PageAnalyzeWorker] Vision-detected MotionEmbedding chunk failed (non-fatal)",
            {
              chunkOffset: offset,
              error:
                visionEmbError instanceof Error ? visionEmbError.message : String(visionEmbError),
            }
          );
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + visionChunkSize < visionPatterns.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Motion embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 3. BackgroundDesignEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    // bgSaveResult.ids を使用して name 重複による idMapping 欠落を回避
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-backgrounds");
    if (
      bgSaveResult &&
      bgSaveResult.ids.length > 0 &&
      layoutResultForNarrative?.backgroundDesigns
    ) {
      // BackgroundDesignForText形式に変換（全件）
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
        // メモリ圧力チェック
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

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const bg of chunkBgs) {
          const dbId = bgSaveResult.idMapping.get(bg.name);
          if (dbId) chunkIdMapping.set(bg.name, dbId);
        }

        // チャンクごとに lock extension
        await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-backgrounds");

        try {
          const bgEmbResult = await generateBackgroundDesignEmbeddings(chunkBgs, chunkIdMapping, {
            webPageId,
            backgroundDesignIds: chunkIds,
            onProgress: reportEmbeddingSubProgress,
          });

          result.bgEmbeddingsGenerated += bgEmbResult.generatedCount;

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] BackgroundDesignEmbeddings chunk completed", {
              chunkOffset: offset,
              chunkSize: chunkBgs.length,
              generatedCount: bgEmbResult.generatedCount,
              failedCount: bgEmbResult.failedCount,
              totalSoFar: result.bgEmbeddingsGenerated,
            });
          }
        } catch (bgEmbError) {
          result.embeddingFailedChunks++;
          logger.warn("[PageAnalyzeWorker] BackgroundDesignEmbedding chunk failed (non-fatal)", {
            chunkOffset: offset,
            error: bgEmbError instanceof Error ? bgEmbError.message : String(bgEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + bgChunkSize < allBackgroundsForText.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Background embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 4. JSAnimationEmbedding生成（チャンク処理: 50件/バッチでメモリ抑制）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-js-animations");
    if (jsSaveResult && jsSaveResult.idMapping.size > 0 && jsAnimationsForEmbedding) {
      try {
        const jsEmbService = sharedLayoutEmbeddingService;

        // チャンク化: 50件ずつ生成+DB保存を繰り返し、メモリを抑制
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
            // Note: JSAnimation uses item-by-item processing, not chunk slicing,
            // so chunk size reduction is not applicable here. The warning is for monitoring.
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

            // Granular progress: report each JS animation embedding item
            try {
              reportEmbeddingSubProgress(0, 0);
            } catch {
              /* fire-and-forget */
            }

            // チャンク境界: DB保存してメモリ解放
            if (embeddingItems.length >= JS_ANIMATION_EMBEDDING_CHUNK_SIZE) {
              const savedCount = await saveJsAnimationEmbeddingChunk(
                embeddingItems,
                prisma as never
              );
              result.jsAnimationEmbeddingsGenerated += savedCount;

              if (isDevelopment()) {
                logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings chunk saved", {
                  chunkSize: savedCount,
                  totalSoFar: result.jsAnimationEmbeddingsGenerated,
                });
              }

              embeddingItems.length = 0; // 配列をクリアしてメモリ解放
              tryGarbageCollect();
              // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          } catch (jsEmbItemError) {
            // Granular progress: report failed item too
            try {
              reportEmbeddingSubProgress(0, 0);
            } catch {
              /* fire-and-forget */
            }
            // Graceful Degradation: 個別パターンの失敗はジョブを止めない
            result.embeddingFailedChunks++;
            logger.warn(
              "[PageAnalyzeWorker] JSAnimationEmbedding item generation failed (non-fatal)",
              {
                originalId,
                dbId,
                error:
                  jsEmbItemError instanceof Error ? jsEmbItemError.message : String(jsEmbItemError),
              }
            );
          }
        }

        // 残りのアイテムを保存
        if (embeddingItems.length > 0) {
          const savedCount = await saveJsAnimationEmbeddingChunk(embeddingItems, prisma as never);
          result.jsAnimationEmbeddingsGenerated += savedCount;
        }

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings generated", {
            generatedCount: result.jsAnimationEmbeddingsGenerated,
            totalPatterns: jsSaveResult.idMapping.size,
          });
        }
      } catch (jsEmbError) {
        result.embeddingFailedChunks++;
        logger.warn("[PageAnalyzeWorker] JSAnimationEmbedding generation failed (non-fatal)", {
          error: jsEmbError instanceof Error ? jsEmbError.message : String(jsEmbError),
        });
      }
    }

    // ONNX session dispose: JSAnimation embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 5. ResponsiveAnalysisEmbedding生成（Phase 4.5でDB保存済みの分析結果にEmbeddingを付与）
    if (responsiveAnalysisId) {
      await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-responsive");
      try {
        const memCheck = checkMemoryPressure();
        if (!memCheck.shouldAbort) {
          const responsiveEmbResult = await generateResponsiveAnalysisEmbeddings(
            [responsiveAnalysisId],
            sharedLayoutEmbeddingService,
            prisma as never
          );
          result.responsiveEmbeddingsGenerated = responsiveEmbResult.generatedCount;

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
        // Graceful Degradation: responsive embedding失敗はジョブを中断しない
        result.embeddingFailedChunks++;
        logger.warn(
          "[PageAnalyzeWorker] ResponsiveAnalysisEmbedding generation failed (non-fatal)",
          {
            error: respEmbError instanceof Error ? respEmbError.message : String(respEmbError),
          }
        );
      }

      // ONNX session dispose: Responsive embedding後の最終メモリ回復
      await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
    }

    // 6. PartEmbedding生成（text-only, Phase 1.1でDB保存済みパーツにテキストEmbeddingを付与）
    //    ビジュアルEmbedding（DINOv2）はbackfill経由で後から生成
    if ((partsSavedCount ?? 0) > 0) {
      await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-parts");
      try {
        // Query parts from DB (saved in Phase 1.1) that don't have embeddings yet
        const partsForEmbedding = (await prisma.componentPart.findMany({
          where: {
            webPageId,
            embedding: { is: null },
          },
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

        if (partsForEmbedding.length > 0) {
          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] Starting Part embedding generation", {
              totalParts: partsForEmbedding.length,
            });
          }

          let partChunkSize = EMBEDDING_CHUNK_SIZE;

          for (let offset = 0; offset < partsForEmbedding.length; offset += partChunkSize) {
            // Memory pressure check
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

            // Lock extension per chunk
            await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-parts");

            try {
              const chunkEmbeddings: PartEmbeddingResult[] = [];

              for (const part of chunkParts) {
                try {
                  // Build ComponentPartForEmbedding from Prisma result (Json → Record cast)
                  const partForEmb: ComponentPartForEmbedding = {
                    id: part.id,
                    partType: part.partType,
                    partSubtype: part.partSubtype,
                    computedStyles: (part.computedStyles ?? {}) as Record<string, string>,
                    cssClasses: part.cssClasses,
                    attributes: (part.attributes ?? {}) as Record<string, string>,
                    interactionInfo: (part.interactionInfo ?? {}) as Record<string, boolean>,
                  };

                  // Build text representation (returns "passage: ..." prefixed string)
                  const textRepr = buildPartTextRepresentation(partForEmb);

                  // Strip "passage: " prefix because generateFromText adds it internally
                  const textForEmbedding = textRepr.startsWith("passage: ")
                    ? textRepr.slice("passage: ".length)
                    : textRepr;

                  const embResult =
                    await sharedLayoutEmbeddingService.generateFromText(textForEmbedding);

                  chunkEmbeddings.push({
                    componentPartId: part.id,
                    visualEmbedding: null, // text-only in worker, visual via backfill
                    textEmbedding: embResult.embedding,
                    textRepresentation: textRepr,
                  });

                  // Progress reporting
                  try {
                    reportEmbeddingSubProgress(0, 0);
                  } catch {
                    /* fire-and-forget */
                  }
                } catch (partItemError) {
                  // Per-part failure: continue with others (Graceful Degradation)
                  try {
                    reportEmbeddingSubProgress(0, 0);
                  } catch {
                    /* fire-and-forget */
                  }
                  logger.warn("[PageAnalyzeWorker] Part embedding failed for item (non-fatal)", {
                    partId: part.id.slice(0, 8) + "...",
                    error:
                      partItemError instanceof Error
                        ? partItemError.message
                        : String(partItemError),
                  });
                }
              }

              // Save chunk embeddings to DB
              if (chunkEmbeddings.length > 0) {
                const saveResult = await savePartEmbeddings(
                  prisma as unknown as PartEmbeddingPrismaClient,
                  chunkEmbeddings
                );
                result.partEmbeddingsGenerated += saveResult.savedCount;
              }

              if (isDevelopment()) {
                logger.info("[PageAnalyzeWorker] PartEmbeddings chunk completed", {
                  chunkOffset: offset,
                  chunkSize: chunkParts.length,
                  savedCount: chunkEmbeddings.length,
                  totalSoFar: result.partEmbeddingsGenerated,
                });
              }
            } catch (partChunkError) {
              result.embeddingFailedChunks++;
              logger.warn("[PageAnalyzeWorker] PartEmbedding chunk failed (non-fatal)", {
                chunkOffset: offset,
                error:
                  partChunkError instanceof Error ? partChunkError.message : String(partChunkError),
              });
            }

            // Inter-chunk memory recovery (except last chunk)
            if (offset + partChunkSize < partsForEmbedding.length) {
              await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
              tryGarbageCollect();
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }

          if (isDevelopment()) {
            logger.info("[PageAnalyzeWorker] PartEmbeddings generation complete", {
              generatedCount: result.partEmbeddingsGenerated,
              totalParts: partsForEmbedding.length,
            });
          }
        }
      } catch (partEmbError) {
        // Graceful Degradation: Part embedding failure does NOT block the job
        result.embeddingFailedChunks++;
        logger.warn("[PageAnalyzeWorker] PartEmbedding generation failed (non-fatal)", {
          error: partEmbError instanceof Error ? partEmbError.message : String(partEmbError),
        });
      }

      // ONNX session dispose: Part text embedding後のメモリ回復
      await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
    }

    // 7. DINOv2 Visual Embedding生成（Section + Part）
    //    screenshotBase64が利用可能な場合、DINOv2を1回初期化してSection・Partの両方でvisual embeddingを生成する。
    //    text_embeddingはあるがvision_embeddingがないセクション、visual_embeddingがないパーツを対象とする。
    const hasSections = (sectionSaveResult?.idMapping?.size ?? 0) > 0;
    const hasParts = (partsSavedCount ?? 0) > 0;

    if (screenshotBase64 && (hasSections || hasParts)) {
      await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding-visual-dinov2");

      // 0. Playwright でパーツの bounding box を後付け取得（JSDOM は常に {0,0,0,0} を返すため）
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
          // Graceful Degradation: bbox resolution failure is non-fatal
          logger.warn("[PageAnalyzeWorker] Part bounding box resolution failed (non-fatal)", {
            error: bboxError instanceof Error ? bboxError.message : String(bboxError),
          });
        }
      }

      try {
        // 1. screenshotをBufferに変換
        // let: 動的Fallback前にメモリ解放のためnull代入が必要
        let screenshotBuffer: Buffer | null = Buffer.from(screenshotBase64, "base64");

        // 2. DINOv2 モデルパスを解決
        let dinov2ModelPath: string;
        if (process.env["DINOV2_MODEL_PATH"]) {
          dinov2ModelPath = process.env["DINOV2_MODEL_PATH"];
        } else {
          const mlMainPath = require.resolve("@reftrix/ml");
          const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
          dinov2ModelPath = path.join(mlRoot, "models", "dinov2-base", "model.onnx");
        }

        // 3. GPU確保（DINOv2用）
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

        // 4. DINOv2Serviceを初期化（Section + Partで共用）
        const dinov2Service = new DINOv2Service({ modelPath: dinov2ModelPath });
        await dinov2Service.initialize();

        // Get screenshot dimensions for crop bounds clamping（Section + Part共通）
        const screenshotMeta = await sharp(screenshotBuffer).metadata();
        const imgWidth = screenshotMeta.width ?? 0;
        const imgHeight = screenshotMeta.height ?? 0;

        try {
          // ====================================================================
          // 5. Section Visual Embedding（DINOv2）
          // ====================================================================
          if (hasSections) {
            await extendJobLock(
              job,
              effectiveToken,
              effectiveLockDuration,
              "embedding-sections-visual"
            );

            try {
              // 5a. vision_embeddingが未生成のsection_embeddingsをDBから取得
              const sectionsNeedingVisual = await prisma.$queryRawUnsafe<
                Array<{
                  id: string;
                  section_pattern_id: string;
                }>
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
                    {
                      totalSections: sectionsNeedingVisual.length,
                    }
                  );
                }

                // 5b. 対応するsection_patternsからlayoutInfo.position (startY, height) を取得
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

                // 5c. PII保護: piiRiskLevel='high' のパーツを含むセクションを除外
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

                // 5d. チャンク処理でcrop→DINOv2→DB保存
                const SECTION_FALLBACK_TIMEOUT_MS = 300_000; // 300s cumulative timeout
                let sectionFallbackCapturedCount = 0;

                // 5d-diag. 診断カウンター
                let diagInRangeCount = 0;
                let diagFallbackCount = 0;
                let diagDynamicCount = 0;
                let diagDedupSkipCount = 0;
                let diagSkippedCount = 0;

                // 5d-pre. フォールバック対象セクションの事前バッチ収集
                const fallbackEnabled =
                  (process.env["ENABLE_SECTION_SCREENSHOT_FALLBACK"] ?? "true") === "true";
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

                // 5d-batch. フォールバック対象を1回のバッチ呼び出しで一括キャプチャ
                const fallbackScreenshots = new Map<string, Buffer>();
                if (fallbackSections.length > 0 && fallbackEnabled) {
                  if (isDevelopment()) {
                    logger.info(
                      "[PageAnalyzeWorker] Batch capturing fallback section screenshots",
                      {
                        fallbackSectionCount: fallbackSections.length,
                      }
                    );
                  }

                  try {
                    const fallbackResult = await captureSectionScreenshots({
                      url,
                      sections: fallbackSections,
                      viewportWidth: job.data.options?.layoutOptions?.viewport?.width ?? 1920,
                      viewportHeight: job.data.options?.layoutOptions?.viewport?.height ?? 1080,
                      maxSections: 50,
                      timeoutMs: SECTION_FALLBACK_TIMEOUT_MS,
                      sharedBrowser: params.sharedBrowser,
                      checkMemoryPressure,
                    });

                    for (const fbResult of fallbackResult.results) {
                      if (fbResult.screenshotBuffer && !fbResult.skipped) {
                        fallbackScreenshots.set(fbResult.sectionId, fbResult.screenshotBuffer);
                      }
                    }
                    sectionFallbackCapturedCount = fallbackResult.capturedCount;
                  } catch (batchFallbackError) {
                    logger.warn(
                      "[PageAnalyzeWorker] Batch section screenshot fallback failed (non-fatal)",
                      {
                        error:
                          batchFallbackError instanceof Error
                            ? batchFallbackError.message
                            : String(batchFallbackError),
                      }
                    );
                  }
                }

                // 5d-dedup. Type-aware 重複ベクトル検出用のスライディングウィンドウ
                const parsedThreshold = parseFloat(
                  process.env["DUPLICATE_VECTOR_THRESHOLD"] ?? "0.995"
                );
                const DUPLICATE_THRESHOLD = Number.isFinite(parsedThreshold)
                  ? parsedThreshold
                  : 0.995;
                const MAX_RECENT_EMBEDDINGS = 10;
                const recentSectionVisualEmbeddings: Array<{
                  embedding: number[];
                  sectionType: string;
                }> = [];

                // 5d-dynamic. 動的Fallbackキュー: 白画像検出セクションを蓄積
                const MAX_DYNAMIC_FALLBACK_SECTIONS = 20;
                const dynamicFallbackSections: Array<{
                  sectionEmbeddingId: string;
                  sectionPatternId: string;
                  startY: number;
                  height: number;
                }> = [];

                let sectionVisualChunkSize = EMBEDDING_CHUNK_SIZE;

                for (
                  let offset = 0;
                  offset < sectionsFiltered.length;
                  offset += sectionVisualChunkSize
                ) {
                  // Memory pressure check
                  const memCheck = checkMemoryPressure();
                  if (memCheck.shouldAbort) {
                    logger.warn(
                      "[PageAnalyzeWorker] Critical memory, stopping section visual embedding",
                      { rssMb: memCheck.rssMb }
                    );
                    break;
                  }
                  if (memCheck.shouldDegrade) {
                    sectionVisualChunkSize = Math.max(3, Math.floor(sectionVisualChunkSize / 2));
                    logger.warn(
                      "[PageAnalyzeWorker] Memory pressure, reducing section visual chunk size",
                      {
                        rssMb: memCheck.rssMb,
                        newChunkSize: sectionVisualChunkSize,
                      }
                    );
                  }

                  const chunk = sectionsFiltered.slice(offset, offset + sectionVisualChunkSize);

                  // Lock extension per chunk
                  await extendJobLock(
                    job,
                    effectiveToken,
                    effectiveLockDuration,
                    "embedding-sections-visual"
                  );

                  for (const section of chunk) {
                    try {
                      const sectionPos = sectionPositionMap.get(section.section_pattern_id);
                      if (!sectionPos || sectionPos.height < 10) {
                        diagSkippedCount++;
                        if (isDevelopment()) {
                          logger.info("[PageAnalyzeWorker] Section visual path", {
                            sectionId: section.section_pattern_id.slice(0, 8) + "...",
                            path: "skipped",
                            skipReason: !sectionPos ? "no_position" : "height_too_small",
                          });
                        }
                        continue;
                      }

                      const sectionTop = Math.max(0, Math.round(sectionPos.startY));
                      const isOutOfRange = sectionTop >= imgHeight;

                      // TDA HIGH-1: acquireSectionCropBuffer でcropパスを一元管理
                      const cropResult = await acquireSectionCropBuffer({
                        sectionPatternId: section.section_pattern_id,
                        sectionPos,
                        screenshotBuffer: screenshotBuffer!,
                        imgWidth,
                        imgHeight,
                        fallbackScreenshots,
                        fallbackEnabled,
                        dinov2InputSize: DINOV2_INPUT_SIZE,
                      });

                      if (cropResult.isBlank) {
                        // 白画像検出: 動的Fallbackキューに蓄積
                        if (dynamicFallbackSections.length < MAX_DYNAMIC_FALLBACK_SECTIONS) {
                          dynamicFallbackSections.push({
                            sectionEmbeddingId: section.id,
                            sectionPatternId: section.section_pattern_id,
                            startY: sectionPos.startY,
                            height: sectionPos.height,
                          });
                        }
                        if (isDevelopment()) {
                          logger.info("[PageAnalyzeWorker] Section visual path", {
                            sectionId: section.section_pattern_id.slice(0, 8) + "...",
                            startY: sectionPos.startY,
                            height: sectionPos.height,
                            imgHeight,
                            path: "dynamic",
                          });
                        }
                        continue;
                      }

                      if (!cropResult.rawCropBuffer) {
                        diagSkippedCount++;
                        if (isDevelopment()) {
                          logger.info("[PageAnalyzeWorker] Section visual path", {
                            sectionId: section.section_pattern_id.slice(0, 8) + "...",
                            startY: sectionPos.startY,
                            height: sectionPos.height,
                            imgHeight,
                            path: "skipped",
                            skipReason: "no_crop_buffer",
                          });
                        }
                        continue;
                      }

                      // Generate visual embedding via DINOv2
                      const visualEmbedding = await generateVisualEmbedding(
                        dinov2Service,
                        cropResult.rawCropBuffer
                      );

                      // Type-aware 重複ベクトル検出
                      const currentSectionType = sectionPos.sectionType;
                      const isDuplicateVector = isDuplicateVisionEmbedding({
                        sectionType: currentSectionType,
                        height: sectionPos.height,
                        embedding: visualEmbedding,
                        recentEmbeddings: recentSectionVisualEmbeddings,
                        threshold: DUPLICATE_THRESHOLD,
                      });

                      if (isDuplicateVector) {
                        diagDedupSkipCount++;
                        logger.warn(
                          "[PageAnalyzeWorker] Duplicate vision embedding detected, skipping DB save",
                          {
                            sectionId: section.section_pattern_id.slice(0, 8) + "...",
                            sectionType: currentSectionType,
                          }
                        );
                        if (isDevelopment()) {
                          logger.info("[PageAnalyzeWorker] Section visual path", {
                            sectionId: section.section_pattern_id.slice(0, 8) + "...",
                            startY: sectionPos.startY,
                            height: sectionPos.height,
                            imgHeight,
                            path: "dedup",
                            sectionType: currentSectionType,
                          });
                        }
                        continue;
                      }

                      // スライディングウィンドウに追加
                      recentSectionVisualEmbeddings.push({
                        embedding: visualEmbedding,
                        sectionType: currentSectionType,
                      });
                      if (recentSectionVisualEmbeddings.length > MAX_RECENT_EMBEDDINGS) {
                        recentSectionVisualEmbeddings.shift();
                      }

                      // Update vision_embedding in DB via raw SQL
                      const visualVectorString = `[${visualEmbedding.join(",")}]`;
                      await prisma.$executeRawUnsafe(
                        `UPDATE section_embeddings
                         SET vision_embedding = $1::vector(768)
                         WHERE id = $2::uuid`,
                        visualVectorString,
                        section.id
                      );

                      if (isOutOfRange) {
                        diagFallbackCount++;
                      } else {
                        diagInRangeCount++;
                      }

                      if (isDevelopment()) {
                        logger.info("[PageAnalyzeWorker] Section visual path", {
                          sectionId: section.section_pattern_id.slice(0, 8) + "...",
                          startY: sectionPos.startY,
                          height: sectionPos.height,
                          imgHeight,
                          path: isOutOfRange ? "fallback" : "in_range",
                        });
                      }

                      result.sectionVisualEmbeddingsGenerated++;
                    } catch (sectionVisualError) {
                      diagSkippedCount++;
                      logger.warn(
                        "[PageAnalyzeWorker] DINOv2 visual embedding failed for section (non-fatal)",
                        {
                          sectionEmbeddingId: section.id.slice(0, 8) + "...",
                          error:
                            sectionVisualError instanceof Error
                              ? sectionVisualError.message
                              : String(sectionVisualError),
                        }
                      );
                    }
                  }

                  if (isDevelopment()) {
                    logger.info("[PageAnalyzeWorker] Section visual embedding chunk completed", {
                      chunkOffset: offset,
                      chunkSize: chunk.length,
                      totalVisualSoFar: result.sectionVisualEmbeddingsGenerated,
                    });
                  }

                  // Inter-chunk memory recovery (except last chunk)
                  if (offset + sectionVisualChunkSize < sectionsNeedingVisual.length) {
                    tryGarbageCollect();
                    await new Promise<void>((resolve) => setImmediate(resolve));
                  }
                }

                // 5d-dynamic-batch. 動的Fallback: 白画像検出セクションをバッチ再キャプチャ
                if (dynamicFallbackSections.length > 0 && fallbackEnabled) {
                  const remainingCapacity = Math.max(0, 50 - sectionFallbackCapturedCount);
                  const dynamicBatch = dynamicFallbackSections.slice(0, remainingCapacity);

                  if (dynamicBatch.length > 0) {
                    // 動的FallbackではscreenshotBase64不要 → メモリ解放して圧力軽減
                    screenshotBuffer = null;
                    if (typeof global.gc === "function") {
                      global.gc();
                    }

                    const memCheckDynamic = checkMemoryPressure();
                    if (!memCheckDynamic.shouldAbort) {
                      if (isDevelopment()) {
                        logger.info(
                          "[PageAnalyzeWorker] Starting dynamic fallback for blank-detected sections",
                          {
                            dynamicFallbackCount: dynamicBatch.length,
                            remainingCapacity,
                          }
                        );
                      }

                      try {
                        const dynamicFallbackResult = await captureSectionScreenshots({
                          url,
                          sections: dynamicBatch.map((s) => ({
                            id: s.sectionPatternId,
                            startY: s.startY,
                            height: s.height,
                          })),
                          viewportWidth: job.data.options?.layoutOptions?.viewport?.width ?? 1920,
                          viewportHeight: job.data.options?.layoutOptions?.viewport?.height ?? 1080,
                          maxSections: remainingCapacity,
                          timeoutMs: SECTION_FALLBACK_TIMEOUT_MS,
                          sharedBrowser: params.sharedBrowser,
                          checkMemoryPressure,
                        });

                        sectionFallbackCapturedCount += dynamicFallbackResult.capturedCount;

                        for (const fbResult of dynamicFallbackResult.results) {
                          if (fbResult.skipped || !fbResult.screenshotBuffer) continue;

                          const matchingSection = dynamicBatch.find(
                            (s) => s.sectionPatternId === fbResult.sectionId
                          );
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

                            const visualEmbedding = await generateVisualEmbedding(
                              dinov2Service,
                              rawCropBuffer
                            );

                            const dynamicSectionPos = sectionPositionMap.get(
                              matchingSection.sectionPatternId
                            );
                            const dynamicSectionType = dynamicSectionPos?.sectionType ?? "unknown";
                            const isDuplicateVector = isDuplicateVisionEmbedding({
                              sectionType: dynamicSectionType,
                              height: dynamicSectionPos?.height ?? 0,
                              embedding: visualEmbedding,
                              recentEmbeddings: recentSectionVisualEmbeddings,
                              threshold: DUPLICATE_THRESHOLD,
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

                            recentSectionVisualEmbeddings.push({
                              embedding: visualEmbedding,
                              sectionType: dynamicSectionType,
                            });
                            if (recentSectionVisualEmbeddings.length > MAX_RECENT_EMBEDDINGS) {
                              recentSectionVisualEmbeddings.shift();
                            }

                            const visualVectorString = `[${visualEmbedding.join(",")}]`;
                            await prisma.$executeRawUnsafe(
                              `UPDATE section_embeddings
                               SET vision_embedding = $1::vector(768)
                               WHERE id = $2::uuid`,
                              visualVectorString,
                              matchingSection.sectionEmbeddingId
                            );

                            diagDynamicCount++;
                            result.sectionVisualEmbeddingsGenerated++;
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
                        logger.warn(
                          "[PageAnalyzeWorker] Dynamic section screenshot fallback failed (non-fatal)",
                          {
                            error:
                              dynamicFallbackError instanceof Error
                                ? dynamicFallbackError.message
                                : String(dynamicFallbackError),
                          }
                        );
                      }
                    } else {
                      logger.warn(
                        "[PageAnalyzeWorker] Skipping dynamic fallback due to memory pressure",
                        {
                          rssMb: memCheckDynamic.rssMb,
                          dynamicFallbackCount: dynamicBatch.length,
                        }
                      );
                    }
                  }
                }

                // 5d-diag-summary. セクション visual embedding 処理パスサマリーログ
                logger.info("[PageAnalyzeWorker] Section visual embedding path summary", {
                  totalSections: sectionsNeedingVisual.length,
                  inRangeCount: diagInRangeCount,
                  fallbackCount: diagFallbackCount,
                  dynamicCount: diagDynamicCount,
                  dedupSkipCount: diagDedupSkipCount,
                  skippedCount: diagSkippedCount,
                  totalGenerated: result.sectionVisualEmbeddingsGenerated,
                  fallbackCaptured: sectionFallbackCapturedCount,
                });
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

            // Memory recovery between section and part visual embedding
            tryGarbageCollect();
          }

          // ====================================================================
          // 6. Part Visual Embedding（DINOv2）
          // ====================================================================
          if (hasParts) {
            const partsWithEmbeddings = (await prisma.componentPart.findMany({
              where: {
                webPageId,
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

            // Check which parts already have visual_embedding via raw SQL
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
                const nullVisualRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
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

            if (partsNeedingVisual.length > 0 && screenshotBuffer) {
              if (isDevelopment()) {
                logger.info(
                  "[PageAnalyzeWorker] Starting DINOv2 part visual embedding generation",
                  {
                    totalParts: partsNeedingVisual.length,
                  }
                );
              }

              const uniqueSectionIds = [
                ...new Set(partsNeedingVisual.map((p) => p.sectionPatternId)),
              ];
              const sectionPositions = (await prisma.sectionPattern.findMany({
                where: { id: { in: uniqueSectionIds } },
                select: { id: true, layoutInfo: true },
              })) as Array<{ id: string; layoutInfo: unknown }>;
              const sectionStartYMap = new Map<string, number>();
              for (const s of sectionPositions) {
                const info = s.layoutInfo as Record<string, unknown> | null;
                const position = info?.position as { startY?: number } | undefined;
                sectionStartYMap.set(s.id, position?.startY ?? 0);
              }

              let visualChunkSize = EMBEDDING_CHUNK_SIZE;

              for (let offset = 0; offset < partsNeedingVisual.length; offset += visualChunkSize) {
                const memCheck = checkMemoryPressure();
                if (memCheck.shouldAbort) {
                  logger.warn(
                    "[PageAnalyzeWorker] Critical memory, stopping part visual embedding",
                    { rssMb: memCheck.rssMb }
                  );
                  break;
                }
                if (memCheck.shouldDegrade) {
                  visualChunkSize = Math.max(3, Math.floor(visualChunkSize / 2));
                  logger.warn(
                    "[PageAnalyzeWorker] Memory pressure, reducing part visual chunk size",
                    {
                      rssMb: memCheck.rssMb,
                      newChunkSize: visualChunkSize,
                    }
                  );
                }

                const chunk = partsNeedingVisual.slice(offset, offset + visualChunkSize);

                await extendJobLock(
                  job,
                  effectiveToken,
                  effectiveLockDuration,
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
                    const cropWidth = Math.min(
                      Math.round(absoluteBbox.width),
                      Math.max(1, imgWidth - left)
                    );
                    const cropHeight = Math.min(
                      Math.round(absoluteBbox.height),
                      Math.max(1, imgHeight - top)
                    );

                    if (cropWidth <= 0 || cropHeight <= 0) continue;

                    const rawCropBuffer = await sharp(screenshotBuffer)
                      .extract({ left, top, width: cropWidth, height: cropHeight })
                      .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, {
                        fit: "cover",
                        kernel: "cubic",
                      })
                      .removeAlpha()
                      .toColorspace("srgb")
                      .raw()
                      .toBuffer();

                    const visualEmbedding = await generateVisualEmbedding(
                      dinov2Service,
                      rawCropBuffer
                    );

                    const visualVectorString = `[${visualEmbedding.join(",")}]`;
                    await prisma.$executeRawUnsafe(
                      `UPDATE component_part_embeddings
                       SET visual_embedding = $1::vector(768)
                       WHERE id = $2::uuid`,
                      visualVectorString,
                      part.embeddingId
                    );

                    result.partVisualEmbeddingsGenerated++;
                  } catch (partVisualError) {
                    logger.warn(
                      "[PageAnalyzeWorker] DINOv2 visual embedding failed for part (non-fatal)",
                      {
                        partId: part.id.slice(0, 8) + "...",
                        error:
                          partVisualError instanceof Error
                            ? partVisualError.message
                            : String(partVisualError),
                      }
                    );
                  }
                }

                if (isDevelopment()) {
                  logger.info("[PageAnalyzeWorker] Part visual embedding chunk completed", {
                    chunkOffset: offset,
                    chunkSize: chunk.length,
                    totalVisualSoFar: result.partVisualEmbeddingsGenerated,
                  });
                }

                if (offset + visualChunkSize < partsNeedingVisual.length) {
                  tryGarbageCollect();
                  await new Promise<void>((resolve) => setImmediate(resolve));
                }
              }

              if (isDevelopment()) {
                logger.info(
                  "[PageAnalyzeWorker] DINOv2 part visual embedding generation complete",
                  {
                    generatedCount: result.partVisualEmbeddingsGenerated,
                    totalParts: partsNeedingVisual.length,
                  }
                );
              }
            }
          }
        } finally {
          // 7. DINOv2 dispose（必ず実行、Section + Part完了後）
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
          error: visualEmbError instanceof Error ? visualEmbError.message : String(visualEmbError),
        });
      }
    }

    result.completed = true;
  } catch (embeddingError) {
    // Graceful Degradation: Embedding失敗はジョブを中断しない
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

  return result;
}
