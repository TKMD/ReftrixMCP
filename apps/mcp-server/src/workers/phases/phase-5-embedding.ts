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
// ADR-0018 Amendment 13 (truncated-screenshot data-loss fix, Plan §5.10c):
// leaf module so cyclomatic complexity is machine-enforced via the scoped
// eslint `complexity` override.
import { isScreenshotTruncated } from "./screenshot-truncation";
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
  type ChunkedEncoderTelemetry,
  isPhase5TextChunkedEncoderHardenedEnabled,
  checkMemoryPressure,
  tryGarbageCollect,
  extendJobLock,
  isDuplicateVisionEmbedding,
  acquireSectionCropBuffer,
  generateJsAnimationTextRepresentation,
  saveJsAnimationEmbeddingChunk,
  truncateSkipDetail,
  partVisualPendingExclusionPredicate,
  sectionVisualPendingExclusionPredicate,
  type PartVisualWritableSkipReason,
  type SectionVisualWritableSkipReason,
} from "./types";
// PR-BT-5 chunk-fork contingency: canonical chunked text-embedding loop driver
// (C1 per-chunk RSS budget break) consumed by all text sub-phases.
import { runChunkedTextEmbeddingLoop } from "./phase-5-chunked-text-loop";

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

// LayoutEmbeddingService type
import type { LayoutEmbeddingService } from "../../services/layout-embedding.service";

// PR-C4 (ADR-0018 Amendment, section_visual PII asymmetry closure): audit emit
// for the work-side `section_visual_pii_excluded` terminal marker. `log()`
// internally applies `truncateAuditTargetId` to `targetId` (SSOT PII
// minimisation, SEC-RV1-03), so we pass the raw webPageId (same pattern as the
// existing `embedding_part_visual_skipped` emit in embedding-backfill-processors).
import { getAuditLogService, truncateAuditTargetId } from "../../services/audit-log.service";
import {
  AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
  AUDIT_ACTOR_PAGE_ANALYZE_WORKER,
} from "../../audit/audit-actions";

// PR-BT-5 (M-1-RSS, ADR-0039 Decision 1/3): per-sub-phase fork filter types
// (SSOT-derived sub-phase identifiers).
import type { Phase5TextSubPhase, Phase5VisualSubPhase } from "./phase-5-subphases.const";

// ============================================================================
// Dependency Injection Interface
// ============================================================================

/**
 * Dependencies injected from the orchestrator (module-level singletons).
 *
 * dispatchEmbeddingPhase は page-analyze-worker.ts のモジュールレベルシングルトン
 * (sharedLayoutEmbeddingService, prisma) を
 * このインターフェースを通じて受け取る。
 *
 * PR-1 GPU-COORD (FIND-IMPL-TDA-L-01): `gpuResourceManager` は本 interface の
 * 注入 dep から削除済み。fork child の provider 選択は probe 配線
 * (`detectExecutionProvider`/DINOv2 init pre-flight) が駆動するため、
 * in-process full GpuResourceManager は embedding phase へ注入しない
 * (ADR-0037 fork-only 境界保全)。
 *
 * PR-1 GPU-COORD (FIND-IMPL-TDA-L-01): `gpuResourceManager` was removed from this
 * interface's injected deps. The fork child's provider selection is driven by the
 * probe wiring (`detectExecutionProvider`/DINOv2 init pre-flight), so the in-process
 * full GpuResourceManager is not injected into the embedding phase
 * (ADR-0037 fork-only boundary preservation).
 */
export interface EmbeddingPhaseDeps {
  /** Shared ONNX session singleton for all text embedding sub-phases */
  sharedLayoutEmbeddingService: LayoutEmbeddingService;
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

// PR-V3-T1a §3.2 C1/C3 (FIND-V3-IO-H-01 closure): chunked encoder telemetry,
// surfaced from a fork-child text sub-phase to the parent via the `text-result`
// IPC message for `audit_logs` emission. PR-BT-5 chunk-fork contingency
// (ADR-0039 §Consequences #2a) relocated the `ChunkedEncoderTelemetry` interface
// to `types.ts` so the shared `runChunkedTextEmbeddingLoop` driver
// (phase-5-chunked-text-loop.ts) can mutate it without a circular import on this
// orchestrator. Re-exported here for backward compatibility (existing importers
// of `ChunkedEncoderTelemetry` from phase-5-embedding.ts continue to resolve).
export type { ChunkedEncoderTelemetry } from "./types";

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
  prisma: EmbeddingPhasePrismaClient;
  result: EmbeddingPhaseResult;
  reportEmbeddingSubProgress: (subCompleted: number, subTotal: number) => void;
  /**
   * PR-V3-T1a §3.2: chunked encoder telemetry mutated by
   * `processSectionTextEmbeddingChunks` and surfaced to the parent via the
   * IPC `text-result` message in `runTextEmbeddingSubPhases`.
   */
  chunkedEncoderTelemetry: ChunkedEncoderTelemetry;
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
 *
 * PR-V3-T1a §3.2 (FIND-V3-IO-H-01 closure): delta-restructured to apply the
 * C1-C4 hardening contracts — per-chunk RSS budget enforcement (C1), streaming
 * flush ordering invariant (C2), failure-path partial-flush prevention (C3),
 * and idempotency on retry via skip-detection (C4). Hardening is gated by the
 * `PHASE5_TEXT_CHUNKED_ENCODER_HARDENED` env feature flag (default on); when
 * disabled, the legacy chunk loop runs unchanged.
 *
 * PR-V3-T1a §3.2: delta-restructured for C1-C4 hardening contracts (per-chunk
 * RSS budget, flush ordering invariant, partial-flush prevention, idempotent
 * retry skip-detection). Feature-flag gated; legacy path preserved.
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

  // PR-V3-T1a §3.2 C1: clamp chunk size to EMBEDDING_CHUNK_SIZE upper bound.
  const sectionChunkSize = EMBEDDING_CHUNK_SIZE;

  // PR-V3-T1a §3.2 C4: idempotency-on-retry skip-detection at loop entry.
  // Best-effort COUNT; failure → no skip (Prisma uniqueness still prevents dup).
  // (section_text is the only sub-phase with head-chunk skip semantics — the
  // computed `skippedHeadChunks` is threaded into the canonical loop driver.)
  const hardeningEnabled = isPhase5TextChunkedEncoderHardenedEnabled();
  let skippedHeadChunks = 0;
  if (hardeningEnabled) {
    try {
      // Count existing rows for this page; chunks fully covered are skipped.
      const existingRowsRaw = (await ctx.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM section_embeddings
         WHERE section_pattern_id IN (
           SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
         )`,
        ctx.webPageId
      )) as Array<{ count: number }>;
      const existingCount = existingRowsRaw[0]?.count ?? 0;
      if (existingCount > 0 && existingCount < allSections.length) {
        // Fully-covered head chunks = floor(existingCount / sectionChunkSize)
        skippedHeadChunks = Math.floor(existingCount / sectionChunkSize);
      }
      if (skippedHeadChunks > 0) {
        ctx.chunkedEncoderTelemetry.idempotencyChunkSkippedCount = skippedHeadChunks;
        logger.info(
          "[PageAnalyzeWorker] PR-V3-T1a C4 idempotency: skipping head chunks (prior partial run)",
          {
            existingCount,
            skippedHeadChunks,
            totalSections: allSections.length,
            sectionChunkSize,
          }
        );
      }
    } catch (countError) {
      // Best-effort: COUNT failure collapses to no skip (Prisma uniqueness
      // still prevents duplicates).
      logger.warn(
        "[PageAnalyzeWorker] PR-V3-T1a C4 idempotency COUNT failed (non-fatal, falling back to no skip)",
        {
          error: countError instanceof Error ? countError.message : String(countError),
        }
      );
      skippedHeadChunks = 0;
    }
  }

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): section_text is
  // the canonical origin of the C1/C2/C3/C4 hardening pattern — it now consumes
  // the SHARED `runChunkedTextEmbeddingLoop` driver (which the other text
  // sub-phases also consume), eliminating the per-processor duplication. The
  // section-specific C4 head-chunk skip is threaded in via `skippedHeadChunks`.
  await runChunkedTextEmbeddingLoop(ctx, {
    items: allSections,
    lockLabel: "embedding-sections",
    hardeningEnabled,
    skippedHeadChunks,
    onEncodeError: () => {
      ctx.result.embeddingFailedChunks++;
    },
    encodeChunk: async (chunkSections, chunkIndex, offset) => {
      const chunkIdMapping = new Map<string, string>();
      for (const section of chunkSections) {
        const dbId = sectionSaveResult.idMapping.get(section.id);
        if (dbId) chunkIdMapping.set(section.id, dbId);
      }

      const sectionEmbResult = await generateSectionEmbeddings(chunkSections, chunkIdMapping, {
        webPageId: ctx.webPageId,
        onProgress: ctx.reportEmbeddingSubProgress,
        layoutEmbeddingService: ctx.sharedLayoutEmbeddingService,
      });
      ctx.result.sectionEmbeddingsGenerated += sectionEmbResult.generatedCount;

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] SectionEmbeddings chunk completed", {
          chunkOffset: offset,
          chunkIndex,
          chunkSize: chunkSections.length,
          generatedCount: sectionEmbResult.generatedCount,
          failedCount: sectionEmbResult.failedCount,
          totalSoFar: ctx.result.sectionEmbeddingsGenerated,
        });
      }
    },
  });
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

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): route through
  // the canonical chunked loop driver so motion_text gets the C1 per-chunk RSS
  // budget break (real-machine CPU verification: motion_text reached 4010MB,
  // near the 4096MB fork kill threshold, because it lacked the budget break).
  await runChunkedTextEmbeddingLoop(ctx, {
    items: allMotionPatterns,
    lockLabel: "embedding-motions",
    hardeningEnabled: isPhase5TextChunkedEncoderHardenedEnabled(),
    onEncodeError: () => {
      ctx.result.embeddingFailedChunks++;
    },
    encodeChunk: async (chunkPatterns, chunkIndex, offset) => {
      const chunkIdMapping = new Map<string, string>();
      for (const pattern of chunkPatterns) {
        const dbId = motionSaveResult.idMapping.get(pattern.id);
        if (dbId) chunkIdMapping.set(pattern.id, dbId);
      }

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
          chunkIndex,
          chunkSize: chunkPatterns.length,
          savedCount: motionEmbResult.savedCount,
          errorCount: motionEmbResult.errors.length,
          totalSoFar: ctx.result.motionEmbeddingsGenerated,
        });
      }
    },
  });
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

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): route through
  // the canonical chunked loop driver so vision_motion_text gets the C1 per-chunk
  // RSS budget break (uniform robustness — vision-detected animation counts can
  // grow with page complexity; bound it identically to motion_text).
  await runChunkedTextEmbeddingLoop(ctx, {
    items: visionPatterns,
    lockLabel: "embedding-motions",
    hardeningEnabled: isPhase5TextChunkedEncoderHardenedEnabled(),
    onEncodeError: () => {
      ctx.result.embeddingFailedChunks++;
    },
    encodeChunk: async (chunkVisionPatterns, _chunkIndex, offset) => {
      const chunkVisionIdMapping = new Map<string, string>();
      for (const pattern of chunkVisionPatterns) {
        const dbId = scrollVisionSaveResult.idMapping.get(pattern.id);
        if (dbId) chunkVisionIdMapping.set(pattern.id, dbId);
      }

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
    },
  });
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

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): route through
  // the canonical chunked loop driver. background_text is the HIGHEST-priority
  // target — real-machine CPU verification SIGKILLed it at delta=4711MB with only
  // 130 background designs (no per-chunk RSS budget break; the gradient/color
  // text representations grow the e5 arena fast). The C1 break now stops the loop
  // at PER_CHUNK_RSS_BUDGET_MB (1536MB) so the rest is surfaced to backfill BEFORE
  // the 4096MB fork kill threshold. Note: the `chunkIds` slice is realigned by
  // offset + chunk length so adaptive chunk-size halving keeps ids/bgs paired.
  await runChunkedTextEmbeddingLoop(ctx, {
    items: allBackgroundsForText,
    lockLabel: "embedding-backgrounds",
    hardeningEnabled: isPhase5TextChunkedEncoderHardenedEnabled(),
    onEncodeError: () => {
      ctx.result.embeddingFailedChunks++;
    },
    encodeChunk: async (chunkBgs, _chunkIndex, offset) => {
      const chunkIds = bgSaveResult.ids.slice(offset, offset + chunkBgs.length);

      const chunkIdMapping = new Map<string, string>();
      for (const bg of chunkBgs) {
        const dbId = bgSaveResult.idMapping.get(bg.name);
        if (dbId) chunkIdMapping.set(bg.name, dbId);
      }

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
    },
  });
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

  const jsEmbService = ctx.sharedLayoutEmbeddingService;

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): convert the
  // historically item-by-item js_animation loop to slice-based chunking over the
  // idMapping entries so it consumes the canonical driver and gets the C1
  // per-chunk RSS budget break + chunk-boundary dispose. The chunk size keeps
  // its historically separate, larger JS_ANIMATION_EMBEDDING_CHUNK_SIZE (passed
  // via initialChunkSize) so the DB-save batching behaviour is preserved.
  const jsEntries: Array<[string, string]> = Array.from(jsSaveResult.idMapping);

  await runChunkedTextEmbeddingLoop(ctx, {
    items: jsEntries,
    lockLabel: "embedding-js-animations",
    hardeningEnabled: isPhase5TextChunkedEncoderHardenedEnabled(),
    initialChunkSize: JS_ANIMATION_EMBEDDING_CHUNK_SIZE,
    onEncodeError: () => {
      ctx.result.embeddingFailedChunks++;
    },
    encodeChunk: async (chunkEntries) => {
      const embeddingItems: Array<{
        originalId: string;
        dbId: string;
        textRepresentation: string;
        embedding: number[];
      }> = [];

      for (const [originalId, dbId] of chunkEntries) {
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
        } catch (jsEmbItemError) {
          try {
            ctx.reportEmbeddingSubProgress(0, 0);
          } catch {
            /* fire-and-forget */
          }
          ctx.result.embeddingFailedChunks++;
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

      if (embeddingItems.length > 0) {
        const savedCount = await saveJsAnimationEmbeddingChunk(embeddingItems, ctx.prisma as never);
        ctx.result.jsAnimationEmbeddingsGenerated += savedCount;

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings chunk saved", {
            chunkSize: savedCount,
            totalSoFar: ctx.result.jsAnimationEmbeddingsGenerated,
          });
        }
      }
    },
  });

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] JSAnimationEmbeddings generated", {
      generatedCount: ctx.result.jsAnimationEmbeddingsGenerated,
      totalPatterns: jsSaveResult.idMapping.size,
    });
  }
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

  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): responsive_text
  // processes exactly ONE `responsiveAnalysisId` → ONE e5 inference. It is
  // **inherently bounded** (no cross-chunk arena accumulation; the intra-fork
  // reload count is the `max(1, chunkCount) = 1` floor by construction), so it is
  // deliberately NOT routed through the `runChunkedTextEmbeddingLoop` driver
  // (single-item chunking would be artificial abstraction with no RSS benefit —
  // there is no second chunk to dispose between). The real-machine CPU
  // verification did NOT flag responsive_text. The fork-boundary OS reclamation
  // (ADR-0039 Decision 2) reclaims the single inference's arena on exit(0).
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

    // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): route the
    // (already-chunked) part_text loop through the canonical driver so it gets
    // the C1 per-chunk RSS budget break UNIFORMLY (part_text survived the
    // real-machine CPU verification at 254 parts / 2760MB — its short
    // CSS-attribute text representations grow the arena slowly — but applying
    // the budget break here too makes the bound robust to future part-count or
    // attribute-size growth, matching all other text sub-phases).
    await runChunkedTextEmbeddingLoop(ctx, {
      items: partsForEmbedding,
      lockLabel: "embedding-parts",
      hardeningEnabled: isPhase5TextChunkedEncoderHardenedEnabled(),
      onEncodeError: () => {
        ctx.result.embeddingFailedChunks++;
      },
      encodeChunk: async (chunkParts, _chunkIndex, offset) => {
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
              partId: truncateAuditTargetId(part.id),
              error: partItemError instanceof Error ? partItemError.message : String(partItemError),
            });
          }
        }

        if (chunkEmbeddings.length > 0) {
          // PR-D-2: savedCount → generatedCount rename。INV-EMBEDDING-INTEGRITY-002
          // により generatedCount は createMany.count からのみ導出される。
          // PR-D-2: renamed savedCount → generatedCount. Per
          // INV-EMBEDDING-INTEGRITY-002, generatedCount derives solely from
          // createMany.count (loop counter prohibited).
          const saveResult = await savePartEmbeddings(
            ctx.prisma as unknown as PartEmbeddingPrismaClient,
            chunkEmbeddings
          );
          ctx.result.partEmbeddingsGenerated += saveResult.generatedCount;
          if (saveResult.filteredNonFinite > 0) {
            logger.warn(
              "[PageAnalyzeWorker] Part embedding NaN/Infinity pre-filter removed items",
              {
                filteredNonFinite: saveResult.filteredNonFinite,
                chunkSize: chunkEmbeddings.length,
              }
            );
          }
        }

        if (isDevelopment()) {
          logger.info("[PageAnalyzeWorker] PartEmbeddings chunk completed", {
            chunkOffset: offset,
            chunkSize: chunkParts.length,
            savedCount: chunkEmbeddings.length,
            totalSoFar: ctx.result.partEmbeddingsGenerated,
          });
        }
      },
    });

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

  // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2): the sub-phase-tail
  // `terminateAndRespawnEmbeddingPipeline()` is REMOVED from the fork-child path.
  // In the per-sub-phase fork model each sub-phase runs in its own fork that
  // `exit(0)`s, so the OS reclaims the whole arena at the fork boundary — the
  // inter-sub-phase reload (the M-1-RSS root cause) is rooted out by the fork
  // boundary. The intra-sub-phase chunk-boundary `disposeEmbeddingPipeline()`
  // (transient recovery, max(1, chunkCount) reload upper bound) lives in the
  // shared `runChunkedTextEmbeddingLoop` driver (phase-5-chunked-text-loop.ts).
  // Source-pinned by INV-PHASE5-SUBPHASE-NO-RELOAD-001 (AST sweep: 0
  // terminateAndRespawn call sites across the fork-child path).
  tryGarbageCollect();
}

/**
 * ADR-0018 Amendment 7 §7.6 (Plan v2 PR-B, UB-8, NF-TPA-02): write a per-row
 * terminal-skip marker to `component_part_embeddings.visual_skip_reason` so the
 * part is permanently excluded from the part_visual pending query (single SSOT
 * exclusion predicate). Only the 2 **terminal** silent-skip exits call this:
 *   - exit #1 `:1373` bbox_invalid (JSDOM-origin structurally invalid bbox)
 *   - exit #2 `:1390` bbox_unresolvable (off-screen clamp → zero-size crop)
 * The transient DINOv2-catch exit (#3) does NOT call this (keeps the row pending
 * for retry — INV-(b) orthogonality, ADR §7.5 req3).
 *
 * Marker write failure is non-fatal (logged, not thrown): a missed marker
 * degrades to the legacy re-fetch behaviour for that single row, never aborting
 * the run (Graceful Degradation). The `reason` is the SSOT-derived terminal
 * subset type so a non-terminal reason cannot be passed by construction.
 */
async function writePartVisualTerminalSkipMarker(
  // PR-BT-4 (ADR-0018 Amendment 10 Decision 10.2): narrowed to the minimal
  // prisma-bearing shape so the backfill residual-path helper
  // (`markResidualBboxUnresolvableParts`) can reuse this single SSOT writer
  // without fabricating a full `EmbeddingSubPhaseContext`. The main-path loop
  // still passes its `ctx` (which structurally satisfies `{ prisma }`).
  ctx: { prisma: Pick<EmbeddingPhasePrismaClient, "$executeRawUnsafe"> },
  embeddingId: string,
  // ADR-0018 Amendment 13: widened to the writable set (terminal subset ∪
  // {screenshot_truncated}) so the bounded-retryable non-terminal marker can be
  // written. The DB CHECK constraint admits exactly this set.
  reason: PartVisualWritableSkipReason
): Promise<void> {
  try {
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE component_part_embeddings
         SET visual_skip_reason = $1
       WHERE id = $2::uuid AND visual_skip_reason IS NULL`,
      reason,
      embeddingId
    );
  } catch (markerError) {
    // Non-fatal: a missed marker degrades to legacy re-fetch for this row only.
    logger.warn("[PageAnalyzeWorker] Failed to write part visual_skip_reason marker (non-fatal)", {
      partEmbeddingId: truncateAuditTargetId(embeddingId),
      reason,
      error: markerError instanceof Error ? markerError.message : String(markerError),
    });
  }
}

/**
 * PR-BT-4 (ADR-0018 Amendment 10 Decision 10.2; design V1 §4.3.1) — gap B
 * closure for the backfill `PartVisualProcessor` residual bbox path.
 *
 * After `resolveAndPersistBboxes` runs the Playwright bbox re-resolution, some
 * parts remain **residual**: their `bounding_box` is still null or zero-size
 * (the selector matched nothing / the element was never measurable) AND they
 * are still part_visual pending (`visual_embedding IS NULL AND
 * visual_skip_reason IS NULL`). DINOv2 can never produce a visual embedding for
 * a zero-size crop, so these parts would otherwise stay pending forever and the
 * 60-min reconciliation cron would force-pin the page to `failed`.
 *
 * This helper writes a **Layer-1 per-row** `visual_skip_reason='bbox_unresolvable'`
 * marker for each such residual part by REUSING the idempotent
 * {@link writePartVisualTerminalSkipMarker} (the marker SSOT writer), so each
 * part is excluded by {@link partVisualPendingExclusionPredicate} and the page
 * can reach `completed`.
 *
 * **Layer-2 non-propagation (TPA-H-01 / U2)**: this is a per-row marker only.
 * The caller (`PartVisualProcessor.resolveAndPersistBboxes`) does NOT promote
 * this to the run-level `skipReason` channel — residual bbox skip is a valid
 * per-part terminal state, not a run failure, so it must not be routed to the
 * `skipped_fork_error` retry bucket (which would re-consume the retry budget and
 * risk a false `failed`). Pinned by INV-BACKFILL-PART-RESIDUAL-MARKER-009.
 *
 * Residual selection mirrors the bbox service's `partsNeedingBbox` predicate
 * (null OR width/height <= 0) and the main-path loop's PII guard
 * (`piiRiskLevel != 'high'`). The marker reason `bbox_unresolvable` is the
 * SSOT-derived terminal subset value (no new enum / no migration).
 *
 * Failures are non-fatal (Graceful Degradation): a residual query / marker error
 * is logged and the run continues — the reconciliation cron remains the safety
 * net. Returns the number of residual parts marked (0 when none / on error).
 *
 * @param prisma A prisma client exposing raw query/execute (worker or shared).
 * @param webPageId The owning web page id (residual parts scoped to this page).
 * @returns Number of residual parts marked `bbox_unresolvable`.
 */
export async function markResidualBboxUnresolvableParts(
  prisma: Pick<EmbeddingPhasePrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
  webPageId: string
): Promise<number> {
  let residualEmbeddingIds: string[];
  try {
    // Residual = bbox still null/zero-size AND part_visual pending. The bbox-zero
    // condition matches the bbox service's `partsNeedingBbox` filter; the pending
    // condition is the single SSOT exclusion predicate (no inline WHERE drift).
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT cpe.id AS id
         FROM component_part_embeddings cpe
         JOIN component_parts cp ON cp.id = cpe.component_part_id
        WHERE cp.web_page_id = $1::uuid
          AND cp.pii_risk_level <> 'high'
          AND (
            cp.bounding_box IS NULL
            OR COALESCE((cp.bounding_box->>'width')::float8, 0) <= 0
            OR COALESCE((cp.bounding_box->>'height')::float8, 0) <= 0
          )
          AND ${partVisualPendingExclusionPredicate("cpe")}`,
      webPageId
    );
    residualEmbeddingIds = rows.map((r) => r.id);
  } catch (queryError) {
    logger.warn("[PartVisualProcessor] residual bbox_unresolvable query failed (non-fatal)", {
      webPageId: truncateAuditTargetId(webPageId),
      error: queryError instanceof Error ? queryError.message : String(queryError),
    });
    return 0;
  }

  if (residualEmbeddingIds.length === 0) return 0;

  const ctx = { prisma };
  let marked = 0;
  for (const embeddingId of residualEmbeddingIds) {
    // Reuse the idempotent SSOT writer (4th `(ctx,` callsite,
    // INV-PART-VISUAL-SKIP-TERMINAL-001 Block (c) toBe(4)). Per-row failure is
    // non-fatal inside the writer; we count attempted residual rows.
    await writePartVisualTerminalSkipMarker(ctx, embeddingId, "bbox_unresolvable");
    marked += 1;
  }
  return marked;
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
  // ADR-0018 Amendment 13 §5.9 flag-gating: gates the truncated-screenshot
  // retryable reclassification. When `false`, an off-screen-due-to-truncation
  // part stays terminal (`bbox_unresolvable`) = status-quo.
  fallbackEnabled: boolean,
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
      // ADR-0018 Amendment 7 §7.1 (UB-3, NF-TPA-01): SSOT exclusion predicate so
      // terminal-skip parts (visual_skip_reason non-NULL) are excluded from the
      // partsNeedingVisual collection (same single SSOT predicate as the 2 backfill
      // count callsites). The predicate is applied to the bare table (no JOIN alias).
      const nullVisualRows = await ctx.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM component_part_embeddings
       WHERE id = ANY($1::uuid[]) AND ${partVisualPendingExclusionPredicate("component_part_embeddings")}`,
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

  // ADR-0018 Amendment 13 §5.1 (truncated-screenshot data-loss fix): compute the
  // run-level truncation decision ONCE (not per-part). `maxPartExtentY` is the
  // maximum `round(absoluteY) + round(height)` across the parts needing visual
  // embeddings (same formula as the crop loop's `absoluteBbox.y`/`.height`).
  // `isTruncatedRun` is then a deterministic run-level flag used by the 2-branch
  // crop guard (exit #2a / clamp-後 row #2) so a part is routed to the
  // bounded-retryable `screenshot_truncated` reason ONLY when the screenshot is
  // truncated AND the section-fallback flag is ON (Plan §5.9 flag-gating).
  let maxPartExtentY = 0;
  for (const part of partsNeedingVisual) {
    const pbbox = part.boundingBox as Record<string, number> | null;
    if (
      !pbbox ||
      typeof pbbox.y !== "number" ||
      typeof pbbox.height !== "number" ||
      !Number.isFinite(pbbox.y) ||
      !Number.isFinite(pbbox.height)
    ) {
      continue;
    }
    const startY = sectionStartYMap.get(part.sectionPatternId) ?? 0;
    const extentY = Math.round((pbbox.y ?? 0) + startY) + Math.round(pbbox.height);
    if (Number.isFinite(extentY) && extentY > maxPartExtentY) {
      maxPartExtentY = extentY;
    }
  }
  const isTruncatedRun = isScreenshotTruncated(imgHeight, maxPartExtentY);

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
          // PR-G1 RC1 (SEC-01): `Number.isFinite` で NaN/Infinity を弾く。
          // `typeof === "number"` は NaN/Infinity を素通りさせ、後続の
          // `NaN <= 0 === false` gap で除外されないため、bbox_invalid 判定の手前で
          // finite 検証を追加する (NaN bbox が Sharp crop / pgvector へ流れるのを防止)。
          // `Number.isFinite` rejects NaN/Infinity that `typeof === "number"` lets
          // through (the `NaN <= 0 === false` gap), preventing a NaN bbox from
          // reaching the Sharp crop / pgvector downstream.
          !Number.isFinite(bbox.width) ||
          !Number.isFinite(bbox.height) ||
          bbox.width <= 0 ||
          bbox.height <= 0
        ) {
          // RC-C / INV-EMBEDDING-INTEGRITY-005 (PR-D-2): bbox=0 の silent drop を
          // 明示的な counter に計上する。従来の silent `continue` を observability
          // 可能な skip として promote し、Phase 5 終了時に
          // partsNeedingVisual 全件が bbox_invalid で skip された場合のみ
          // run-level `skipReason='bbox_invalid'` への promotion 判定が可能になる
          // (§Plan 3.3 の 3 条件 gate は promote 処理側で実施)。
          //
          // RC-C / INV-EMBEDDING-INTEGRITY-005 (PR-D-2): promote the bbox=0
          // silent drop to an observable counter. The legacy silent `continue`
          // becomes an explicit skip count, enabling later run-level
          // `skipReason='bbox_invalid'` promotion when 100% of
          // partsNeedingVisual are skipped this way (per Plan §3.3's 3-condition
          // gate, handled at the caller).
          ctx.result.partVisualSkippedBboxInvalid++;
          // ADR-0018 Amendment 7 §7.6 exit #1 (UB-8, terminal): JSDOM-origin
          // invalid bbox cannot resolve on retry → write terminal marker so the
          // part is excluded from the part_visual pending query (NF-TPA-01).
          await writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_invalid");
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

        // ADR-0018 Amendment 7 §7.6 exit #2a (UB-8, terminal — off-screen
        // precondition): a part whose clamped left-top edge already sits at or
        // beyond the screenshot bounds (`top >= imgHeight` or `left >= imgWidth`)
        // has ZERO croppable pixels — `Math.max(1, imgHeight - top)` /
        // `Math.max(1, imgWidth - left)` would otherwise floor the available
        // span to 1 and let `cropHeight`/`cropWidth` stay > 0, so the
        // `cropWidth <= 0 || cropHeight <= 0` guard below never fires and Sharp
        // `.extract({left, top})` throws `extract_area: bad extract area` →
        // routed to the transient DINOv2 catch (exit #3) → permanent pending
        // (NF-TPA-02). Detect the fully-off-screen case here, BEFORE the clamp,
        // and write the terminal `bbox_unresolvable` marker so the row is
        // excluded from the part_visual pending query.
        //
        // Over-termination guard (TPA-IMPL-L-01): only the FULLY off-screen edge
        // (left-top corner outside the image) is terminal. A partially-visible
        // part (`top < imgHeight && top + height > imgHeight`, or the analogous
        // horizontal case) still has croppable pixels inside the viewport and
        // MUST keep flowing through the clamp below — it is NOT marked here.
        if (top >= imgHeight || left >= imgWidth) {
          // ADR-0018 Amendment 13 §8.2 (truncated-screenshot data-loss fix,
          // FIND-RE-TPA-M-01): the off-screen exit #2a is now truncation-gated +
          // flag-gated. A part off-screen ONLY because the persisted screenshot is
          // truncated (`isTruncatedRun`) AND the section-fallback flag is ON
          // (`fallbackEnabled`, Plan §5.9) is bounded-retryable
          // (`screenshot_truncated`, non-terminal); otherwise it stays terminal
          // (`bbox_unresolvable`) = genuinely off-screen / flag-OFF status-quo.
          if (isTruncatedRun && fallbackEnabled) {
            ctx.result.partVisualSkippedScreenshotTruncated++;
            await writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "screenshot_truncated");
          } else {
            ctx.result.partVisualSkippedBboxUnresolvable++;
            await writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_unresolvable");
          }
          continue;
        }

        const cropWidth = Math.min(Math.round(absoluteBbox.width), Math.max(1, imgWidth - left));
        const cropHeight = Math.min(Math.round(absoluteBbox.height), Math.max(1, imgHeight - top));

        if (cropWidth <= 0 || cropHeight <= 0) {
          // ADR-0018 Amendment 13 §8.2 (truncated-screenshot data-loss fix,
          // FIND-RE-TPA-M-01): the clamp-後 row #2 guard is ALSO truncation-gated +
          // flag-gated. A part with `top < imgHeight` but `top + height > imgHeight`
          // passes exit #2a, then clamps to a zero-size crop on a truncated
          // screenshot — previously falling here to terminal `bbox_unresolvable`
          // (partial data-loss). The 2-branch is symmetric with exit #2a above.
          //
          // ADR-0018 Amendment 7 §7.6 exit #2 (UB-8): the NON-truncated / flag-OFF
          // branch keeps the legacy observable counter + terminal `bbox_unresolvable`
          // marker so the part is excluded from the pending query (status-quo).
          if (isTruncatedRun && fallbackEnabled) {
            ctx.result.partVisualSkippedScreenshotTruncated++;
            await writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "screenshot_truncated");
          } else {
            ctx.result.partVisualSkippedBboxUnresolvable++;
            await writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_unresolvable");
          }
          continue;
        }

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
          partId: truncateAuditTargetId(part.id),
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

  // INV-EMBEDDING-INTEGRITY-005 (PR-D-2): bbox_invalid の observability 情報を
  // skipDetail に encode。3 条件 gate (Plan §3.3) を満たす場合のみ run-level
  // `skipReason='bbox_invalid'` に promote、そうでない場合は counter のみ
  // skipDetail に追記 (partial skip として観測)。
  //
  //   Gate:
  //     (1) partsNeedingVisual.length > 0
  //     (2) partVisualSkippedBboxInvalid === partsNeedingVisual.length
  //         (100% bbox_invalid)
  //     (3) partVisualEmbeddingsGenerated === 0 (他の skip reason でない)
  //
  // INV-EMBEDDING-INTEGRITY-005 (PR-D-2): encode bbox_invalid observability
  // into skipDetail. Promote to run-level `skipReason='bbox_invalid'` only
  // when the 3-condition gate (Plan §3.3) is satisfied; otherwise append the
  // counter to skipDetail only (observed as a partial skip).
  if (ctx.result.partVisualSkippedBboxInvalid > 0) {
    const bboxInvalidDetail = `bboxInvalid:${ctx.result.partVisualSkippedBboxInvalid}`;
    const allBboxInvalid =
      partsNeedingVisual.length > 0 &&
      ctx.result.partVisualSkippedBboxInvalid === partsNeedingVisual.length &&
      ctx.result.partVisualEmbeddingsGenerated === 0;

    if (allBboxInvalid && ctx.result.skipReason === undefined) {
      // Promote to run-level terminal state. Only set when no prior skipReason
      // exists so we don't override memory-pressure / fork-error etc.
      ctx.result.skipReason = "bbox_invalid";
      ctx.result.skipDetail = truncateSkipDetail(bboxInvalidDetail);
    } else {
      // Partial skip: append to existing skipDetail (or create new).
      // PII-free: only numeric value, no part IDs / URLs / stack traces.
      const existing = ctx.result.skipDetail ?? "";
      const combined = existing ? `${existing} ${bboxInvalidDetail}` : bboxInvalidDetail;
      ctx.result.skipDetail = truncateSkipDetail(combined);
    }
  }

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] DINOv2 part visual embedding generation complete", {
      generatedCount: ctx.result.partVisualEmbeddingsGenerated,
      skippedBboxInvalid: ctx.result.partVisualSkippedBboxInvalid,
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
  /**
   * PR-B (Plan §7.5 / FIND-RE-LCC-01): backfill 再capture 直前の robots.txt 再評価フラグ。
   * Phase 5 proper (contemporaneous) は false (省略)、backfill は true。
   * PR-B (Plan §7.5 / FIND-RE-LCC-01): re-check robots.txt before backfill re-capture.
   */
  recheckRobotsTxt?: boolean | undefined;
  /** PR-B: robots.txt 尊重オーバーライド (recheckRobotsTxt 時のみ参照)。 */
  respectRobotsTxt?: boolean | undefined;
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
  fallbackTimeoutMs: number,
  // PR-B (Plan §7.5): backfill 文脈で navigation 直前に robots.txt を再評価する。
  // PR-B (Plan §7.5): re-evaluate robots.txt just before navigation in the backfill context.
  recheckRobotsTxt: boolean,
  respectRobotsTxt: boolean | undefined
): Promise<{
  screenshots: Map<string, Buffer>;
  capturedCount: number;
  // PR-B (Plan §7.5 / FIND-RE-LCC-01): robots.txt Disallow で再capture 不能と確定した
  // off-screen section の section_pattern_id 集合 (呼び出し側が terminal 収束)。
  // section_pattern_ids the caller converges to `screenshot_truncated_expired`.
  robotsDisallowedSectionPatternIds: string[];
}> {
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
  const robotsDisallowedSectionPatternIds: string[] = [];

  if (fallbackSections.length > 0 && fallbackEnabled) {
    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Batch capturing fallback section screenshots", {
        fallbackSectionCount: fallbackSections.length,
        recheckRobotsTxt,
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
        recheckRobotsTxt,
        respectRobotsTxt,
      });

      // PR-B (Plan §7.5 / FIND-RE-LCC-01): robots.txt Disallow で capture を起動しなかった
      // 場合、この run の全 off-screen fallback section を terminal 収束対象として返す。
      // SSRF block / HTTP error / 空結果は `robotsDisallowed: false` ゆえ bounded budget の
      // 後続 retry に委ねる。 / On robots.txt Disallow, return all off-screen fallback sections
      // for terminal convergence (SSRF/HTTP/empty stay false → bounded-budget retry).
      if (fallbackResult.robotsDisallowed) {
        for (const fb of fallbackSections) {
          robotsDisallowedSectionPatternIds.push(fb.id);
        }
      }

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

  return { screenshots, capturedCount, robotsDisallowedSectionPatternIds };
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
    recheckRobotsTxt = false,
    respectRobotsTxt,
  } = loopParams;

  const SECTION_FALLBACK_TIMEOUT_MS = 300_000; // 300s cumulative timeout
  let generatedCount = 0;

  // ADR-0018 Amendment 13 §5.7 / OQ-2 (truncated-screenshot data-loss fix,
  // part/section symmetry): run-level truncation decision for the section path.
  // `maxSectionExtentY` is the maximum `startY + height` across the sections
  // needing visual embeddings (from `sectionPositionMap`). `isTruncatedRun` then
  // gates the `section_visual_uncroppable` exit toward the bounded-retryable
  // `screenshot_truncated` reason (only when `fallbackEnabled` is ON, Plan §5.9).
  let maxSectionExtentY = 0;
  for (const s of sectionsFiltered) {
    const pos = sectionPositionMap.get(s.section_pattern_id);
    if (!pos) continue;
    if (!Number.isFinite(pos.startY) || !Number.isFinite(pos.height)) continue;
    const extentY = pos.startY + pos.height;
    if (Number.isFinite(extentY) && extentY > maxSectionExtentY) {
      maxSectionExtentY = extentY;
    }
  }
  const isTruncatedRun = isScreenshotTruncated(imgHeight, maxSectionExtentY);

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
  const {
    screenshots: fallbackScreenshots,
    capturedCount: initialFallbackCaptured,
    robotsDisallowedSectionPatternIds,
  } = await collectFallbackScreenshots(
    sectionsFiltered,
    sectionPositionMap,
    imgHeight,
    fallbackEnabled,
    url,
    job,
    params,
    SECTION_FALLBACK_TIMEOUT_MS,
    recheckRobotsTxt,
    respectRobotsTxt
  );
  let sectionFallbackCapturedCount = initialFallbackCaptured;

  // PR-B (Plan §7.5 / FIND-RE-LCC-01 / INV-BACKFILL-SECTION-FALLBACK-ROBOTS):
  // robots.txt Disallow で再capture 不能と確定した off-screen section を
  // `screenshot_truncated_expired` terminal へ fail-loud 収束 (再capture/budget を消費せず
  // 即 terminal 化、Disallow site への retry 浪費を排除)。robots 再評価は backfill flag-ON
  // path のみ起動ゆえ Phase 5 proper は非影響。 / Converge off-screen sections that robots.txt
  // Disallow confirms un-re-capturable to the `screenshot_truncated_expired` terminal
  // fail-loud (gated on the backfill flag-ON path; Phase 5 proper unaffected).
  if (robotsDisallowedSectionPatternIds.length > 0) {
    const disallowedSet = new Set(robotsDisallowedSectionPatternIds);
    for (const section of sectionsFiltered) {
      if (!disallowedSet.has(section.section_pattern_id)) continue;
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE section_embeddings
             SET vision_skip_reason = $1
           WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
          "screenshot_truncated_expired",
          section.id
        );
      } catch (markerError) {
        // Non-fatal: marker 欠落は当該 1 row のみ legacy re-fetch に degrade (Graceful Degradation)。
        logger.warn(
          "[PageAnalyzeWorker] Failed to write robots-disallowed section terminal marker (non-fatal)",
          {
            sectionId: truncateAuditTargetId(section.section_pattern_id),
            error: markerError instanceof Error ? markerError.message : String(markerError),
          }
        );
      }
    }
    logger.warn(
      "[PageAnalyzeWorker] robots.txt Disallow on backfill re-capture; converged sections to screenshot_truncated_expired",
      {
        sectionCount: robotsDisallowedSectionPatternIds.length,
      }
    );
  }

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
        isTruncatedRun,
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
      recheckRobotsTxt,
      respectRobotsTxt,
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
  /**
   * ADR-0018 Amendment 13 §5.7 (truncated-screenshot data-loss fix, part/section
   * symmetry): run-level flag that the persisted screenshot is truncated relative
   * to the section content extent. When `true` AND `fallbackEnabled` is ON, the
   * `section_visual_uncroppable` exit is routed to the bounded-retryable
   * `screenshot_truncated` reason instead of the terminal (Plan §5.9 flag-gating).
   */
  isTruncatedRun: boolean;
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
 * PR-BT-2 (系統B、ADR-0018 Amendment): `section_embeddings.vision_skip_reason` に
 * per-row terminal-skip マーカーを書込み、section を section_visual pending クエリ
 * から恒久除外する (single SSOT exclusion predicate
 * `sectionVisualPendingExclusionPredicate`、part_visual の
 * `writePartVisualTerminalSkipMarker` と対称)。backfill path
 * (`fallbackEnabled === false`) の 4 つの terminal exit のみが呼ぶ:
 *   - no_position exit: `section_visual_no_position` (sectionPositionMap に position
 *     無し、または `height < 10` の degenerate geometry)
 *   - blank exit: `section_visual_blank` (crop が white/uniform、`isBlank === true`)
 *   - no_crop_buffer exit: `section_visual_uncroppable` (`isOutOfRange === true`)
 *   - dedup exit: `section_visual_duplicate`
 * (secvisual-blank-terminal (Plan V1 §4) で no_position / blank の 2 exit を追加、
 * 2 → 4 exit)。transient/main-path exit は呼ばない (row を pending に残し retry、
 * INV-(b) orthogonality、INV-007 Block D)。
 *
 * marker write 失敗は非致命 (logged, not thrown): marker 欠落は当該 1 row のみ
 * legacy re-fetch に degrade し、run を abort しない (Graceful Degradation)。
 * `reason` は SSOT-derive terminal subset 型ゆえ非 terminal reason は構造的に
 * 渡せない。
 *
 * PR-BT-2 (System B, ADR-0018 Amendment): write a per-row terminal-skip marker to
 * `section_embeddings.vision_skip_reason` so the section is permanently excluded
 * from the section_visual pending query (symmetry with
 * `writePartVisualTerminalSkipMarker`). Only the 4 backfill-path terminal exits
 * call this (no_position / blank / uncroppable / duplicate; secvisual-blank-terminal
 * (Plan V1 §4) added the no_position + blank exits, 2 -> 4). Marker-write failure
 * is non-fatal (logged); the `reason` is the SSOT-derived terminal subset type so a
 * non-terminal reason cannot be passed.
 */
async function writeSectionVisionSkipReason(
  p: SingleSectionVisualParams,
  // ADR-0018 Amendment 13: widened to the writable set (terminal subset ∪
  // {screenshot_truncated}) so the bounded-retryable non-terminal marker can be
  // written on the section path (symmetry with part). The DB CHECK constraint
  // admits exactly this set.
  reason: SectionVisualWritableSkipReason
): Promise<void> {
  try {
    await p.prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
         SET vision_skip_reason = $1
       WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
      reason,
      p.section.id
    );
  } catch (markerError) {
    // Non-fatal: a missed marker degrades to legacy re-fetch for this row only.
    logger.warn(
      "[PageAnalyzeWorker] Failed to write section vision_skip_reason marker (non-fatal)",
      {
        sectionEmbeddingId: truncateAuditTargetId(p.section.id),
        reason,
        error: markerError instanceof Error ? markerError.message : String(markerError),
      }
    );
  }
}

/**
 * PR-C4 (ADR-0018 Amendment, section_visual PII asymmetry closure, Path B):
 * write the `section_visual_pii_excluded` terminal marker for the high-PII
 * sections that the work side intentionally excludes from the DINOv2 visual
 * loop (GDPR Art.5(1)(c) data-minimisation).
 *
 * Why a work-side bulk write (not `processSingleSectionVisualEmbedding`): the
 * high-PII sections are filtered out **before** the per-section loop
 * (`highPiiSectionIdSet`), so they never reach
 * `processSingleSectionVisualEmbedding` — an in-function marker write is
 * structurally impossible. Writing the marker here (a) records the intentional
 * non-generation as a GDPR Art.30 processing trail and (b) provides a second
 * pending-exclusion defense layer alongside Path A's PII NOT EXISTS predicate
 * (`vision_skip_reason IS NULL` excludes these rows even if the NOT EXISTS is
 * ever changed). Extracted as a helper so `runVisualEmbeddingSubPhases` gains no
 * inline branch complexity (TDA-PLAN-02).
 *
 * Idempotent: the bulk UPDATE is guarded by `vision_embedding IS NULL AND
 * vision_skip_reason IS NULL`, so re-runs do not overwrite a generated embedding
 * or an existing marker. Marker-write / audit failures are non-fatal (logged,
 * not thrown) — a missed marker degrades to Path A's NOT EXISTS pending
 * exclusion only (Graceful Degradation, RISKS R2).
 *
 * The audit emit passes the raw `webPageId` to `getAuditLogService().log()`,
 * which internally applies `truncateAuditTargetId` (SSOT PII minimisation,
 * SEC-RV1-03 / U1; same pattern as the `embedding_part_visual_skipped` emit).
 * `details` is PII-free (enum + numeric count only).
 *
 * PR-C4 (ADR-0018 Amendment, Path B): writes the `section_visual_pii_excluded`
 * marker for high-PII sections excluded by the work side (GDPR Art.30 trail +
 * second pending-exclusion layer). Idempotent bulk UPDATE; non-fatal on failure.
 *
 * @param prisma                 Prisma client bound to `$executeRawUnsafe`
 * @param webPageId              target page UUID (audit targetId, truncated internally)
 * @param highPiiSectionPatternIds  section_pattern_id list excluded for PII
 */
async function writeSectionVisualPiiExcludedMarkers(
  prisma: Pick<EmbeddingPhasePrismaClient, "$executeRawUnsafe">,
  webPageId: string,
  highPiiSectionPatternIds: string[]
): Promise<void> {
  if (highPiiSectionPatternIds.length === 0) return;

  let markedCount = 0;
  try {
    // Bulk UPDATE: mark all pending section_embeddings rows whose section_pattern
    // is high-PII. Parameterized ($1 = reason enum literal, $2.. = section_pattern
    // UUIDs); no reason-literal interpolation into the SQL string (SEC-RV1-02).
    // Guarded by `vision_embedding IS NULL AND vision_skip_reason IS NULL` for
    // idempotency. `markedCount` is the affected-row count for the audit detail.
    const placeholders = highPiiSectionPatternIds.map((_, i) => `$${i + 2}::uuid`).join(", ");
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
         SET vision_skip_reason = $1
       WHERE section_pattern_id IN (${placeholders})
         AND vision_embedding IS NULL
         AND vision_skip_reason IS NULL`,
      "section_visual_pii_excluded",
      ...highPiiSectionPatternIds
    );
    markedCount = typeof affected === "number" && Number.isFinite(affected) ? affected : 0;
  } catch (markerError) {
    // Non-fatal: a missed marker degrades to Path A's NOT EXISTS pending exclusion.
    logger.warn(
      "[PageAnalyzeWorker] Failed to write section_visual_pii_excluded markers (non-fatal)",
      {
        webPageId: truncateAuditTargetId(webPageId),
        highPiiSectionCount: highPiiSectionPatternIds.length,
        error: markerError instanceof Error ? markerError.message : String(markerError),
      }
    );
    return;
  }

  // GDPR Art.30 processing trail: record intentional high-PII section visual
  // non-generation. `log()` truncates `targetId` via the SSOT helper (SEC-RV1-03).
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED,
      actor: AUDIT_ACTOR_PAGE_ANALYZE_WORKER,
      targetType: "web_page",
      targetId: webPageId,
      details: {
        skipReason: "section_visual_pii_excluded",
        excludedSectionCount: markedCount,
      },
      result: "success",
    });
  } catch (auditError) {
    // Non-fatal: the marker write (the functional contract) already succeeded;
    // a failed audit emit must not abort the run (Graceful Degradation).
    logger.warn(
      "[PageAnalyzeWorker] Failed to emit section_visual_pii_excluded audit (non-fatal)",
      {
        webPageId: truncateAuditTargetId(webPageId),
        error: auditError instanceof Error ? auditError.message : String(auditError),
      }
    );
  }
}

/**
 * PR-C4 (ADR-0018 Amendment, Path B B3 live-marker closure): query the
 * `section_pattern_id`s of **high-PII pending** sections for `webPageId`,
 * derived from the **PII-filter-free** pending condition (NOT from the
 * `sectionVisualPendingExclusionPredicate`, which already excludes high-PII rows
 * via its `NOT EXISTS pii_risk_level='high'` clause).
 *
 * Why a dedicated query (TPA-IMPL-01 dead-code closure): the work-loop's
 * `sectionsNeedingVisual` fetch uses the SSOT pending predicate, which already
 * removes every high-PII section. Re-deriving the high-PII set from that
 * already-filtered list therefore always produced an empty set, so
 * `writeSectionVisualPiiExcludedMarkers` never executed and the GDPR Art.30
 * audit emit was dead. This helper instead intersects the **non-PII** pending
 * condition (`text_embedding IS NOT NULL AND vision_embedding IS NULL AND
 * vision_skip_reason IS NULL`) with `component_parts.pii_risk_level='high'`,
 * yielding exactly the sections the work side intentionally declines to embed —
 * which is the correct input for the live marker write.
 *
 * Self-consistency with Path A: once the marker write sets
 * `vision_skip_reason = 'section_visual_pii_excluded'`, the row becomes terminal
 * and is excluded by the existing `vision_skip_reason IS NULL` clause in BOTH
 * this query and the SSOT pending predicate. So this query naturally returns the
 * empty set on subsequent runs (idempotent, no double-emit on re-run), and
 * completion (pending → 0) is preserved. Path A's `NOT EXISTS` remains as
 * belt-and-suspenders for the pre-marker window and for work-loop-skipped runs.
 *
 * The static SQL only embeds the enum-bound `pii_risk_level='high'` literal and
 * `vision_skip_reason IS NULL` (no reason-literal interpolation, no runtime user
 * input — no SQL-injection / enum-drift surface). `webPageId` is parameterized.
 *
 * @param prisma     Prisma client bound to `$queryRawUnsafe`
 * @param webPageId  target page UUID (parameterized, $1)
 * @returns distinct high-PII pending `section_pattern_id`s (possibly empty)
 */
async function queryHighPiiPendingSectionPatternIds(
  prisma: Pick<EmbeddingPhasePrismaClient, "$queryRawUnsafe">,
  webPageId: string
): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ section_pattern_id: string }>>(
    `SELECT DISTINCT se.section_pattern_id
       FROM section_embeddings se
      WHERE se.section_pattern_id IN (
              SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
            )
        AND se.text_embedding IS NOT NULL
        AND se.vision_embedding IS NULL
        AND se.vision_skip_reason IS NULL
        AND EXISTS (
              SELECT 1 FROM component_parts cp
               WHERE cp.section_pattern_id = se.section_pattern_id
                 AND cp.pii_risk_level = 'high'
            )`,
    webPageId
  );
  return rows.map((r) => r.section_pattern_id);
}

/**
 * PR-C4 B6 (TPA-RV2-01 hoist closure): query the high-PII pending sections for
 * `webPageId` and, if any exist, write the `section_visual_pii_excluded` terminal
 * marker + emit the GDPR Art.30 audit trail (`writeSectionVisualPiiExcludedMarkers`).
 *
 * Why exported / why a single entry point: the high-PII marker must fire on a
 * page whose ONLY pending sections are high-PII (e.g. w3.org, navigation is the
 * sole pending section). In that case the work-loop's `sectionsNeedingVisual`
 * (SSOT predicate, PII NOT EXISTS) is empty, and the backfill processor's
 * `countSectionVisualBackfillTargets` (same SSOT predicate) returns
 * `pendingCount === 0`. Both paths previously short-circuited BEFORE reaching the
 * marker write → 0 GDPR Art.30 trail. This helper is the single SSOT entry point
 * called from both:
 *   1. the work-loop (`runVisualEmbeddingSubPhases`), hoisted OUT of the
 *      `if (sectionsNeedingVisual.length > 0)` gate; and
 *   2. the backfill `SectionVisualProcessor` early-return branch (when
 *      `pendingCount === 0` so `runVisualEmbeddingSubPhases` is not invoked).
 *
 * No double-emit across paths: the marker write sets
 * `vision_skip_reason = 'section_visual_pii_excluded'`, terminalizing the rows.
 * Both this query's `vision_skip_reason IS NULL` clause AND Path A's SSOT
 * predicate then exclude the rows, so a second run (or the other path on the
 * same page) returns the empty set → no double-emit. Within a single page the
 * two call sites are mutually exclusive: the work-loop fires it once per run;
 * the backfill early-return only runs when the sub-phase (which would also fire
 * it) is NOT invoked.
 *
 * Non-fatal: query/marker/audit failures are swallowed inside
 * `writeSectionVisualPiiExcludedMarkers` (Graceful Degradation, RISKS R2). The
 * outer try/catch here guards the query itself.
 *
 * @param prisma     Prisma client (query + executeRawUnsafe)
 * @param webPageId  target page UUID
 * @returns count of high-PII section_pattern_ids found (0 if none / on error)
 */
export async function emitSectionVisualPiiExcludedMarkersForPage(
  prisma: Pick<EmbeddingPhasePrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
  webPageId: string
): Promise<number> {
  try {
    const highPiiSectionPatternIds = await queryHighPiiPendingSectionPatternIds(prisma, webPageId);
    if (highPiiSectionPatternIds.length === 0) return 0;
    await writeSectionVisualPiiExcludedMarkers(prisma, webPageId, highPiiSectionPatternIds);
    return highPiiSectionPatternIds.length;
  } catch (markerError) {
    // Non-fatal: a missed marker degrades to Path A's NOT EXISTS pending exclusion.
    logger.warn(
      "[PageAnalyzeWorker] emitSectionVisualPiiExcludedMarkersForPage failed (non-fatal)",
      {
        webPageId: truncateAuditTargetId(webPageId),
        error: markerError instanceof Error ? markerError.message : String(markerError),
      }
    );
    return 0;
  }
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
      // secvisual-blank-terminal (Plan V1 §4, exit#1): backfill path
      // (`p.fallbackEnabled === false`) で position が無い (`!sectionPos`) または
      // height < 10 (degenerate geometry) の section は crop 領域を決定できず
      // embedding 構造的に不能 = terminal。`section_visual_no_position` で terminal
      // 化し永久 pending を解消する (degraded-coverage technical terminal、NON-PII)。
      // `writeSectionVisionSkipReason` は `p.section.id` で UPDATE するため
      // `sectionPos` 不在でも安全。main-path (`fallbackEnabled === true`) は marker
      // 書込なし (INV-007 Block D orthogonality)。
      //
      // secvisual-blank-terminal (Plan V1 §4, exit#1): on the backfill path
      // (`p.fallbackEnabled === false`), a section with no position (`!sectionPos`)
      // or `height < 10` (degenerate geometry) has no determinable crop region and
      // is structurally un-embeddable = terminal; terminal-mark it via
      // `section_visual_no_position` to clear the permanent pending (a
      // degraded-coverage technical terminal, NON-PII). The marker UPDATE keys on
      // `p.section.id`, so it is safe even when `sectionPos` is absent. The main
      // path (`fallbackEnabled === true`) writes NO marker (INV-007 Block D
      // orthogonality).
      if (p.fallbackEnabled === false) {
        await writeSectionVisionSkipReason(p, "section_visual_no_position");
      }
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: truncateAuditTargetId(p.section.section_pattern_id),
          path: "skipped",
          skipReason: !sectionPos ? "no_position" : "height_too_small",
          terminalSkip: p.fallbackEnabled === false,
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
      // secvisual-blank-terminal (Plan V1 §4, exit#2): backfill path
      // (`p.fallbackEnabled === false`) では dynamic fallback re-capture queue が
      // drain されないため、blank crop は永久 pending になる。`section_visual_blank`
      // で terminal 化し page が completed に到達できるようにする (degraded-coverage
      // technical terminal、NON-PII)。main-path (`fallbackEnabled === true`) は
      // marker 書込なし — dynamic fallback queue で後続回収されるため (Phase 5
      // proper 非汚染、INV-007 Block D orthogonality)。
      //
      // secvisual-blank-terminal (Plan V1 §4, exit#2): on the backfill path
      // (`p.fallbackEnabled === false`) the dynamic fallback re-capture queue is not
      // drained, so a blank crop would stay permanently pending; terminal-mark it
      // via `section_visual_blank` so the page can reach `completed` (a
      // degraded-coverage technical terminal, NON-PII). The main path
      // (`fallbackEnabled === true`) writes NO marker — the dynamic fallback queue
      // recovers it later (INV-007 Block D orthogonality).
      if (p.fallbackEnabled === false) {
        await writeSectionVisionSkipReason(p, "section_visual_blank");
      }
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: truncateAuditTargetId(p.section.section_pattern_id),
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "dynamic",
          terminalSkip: p.fallbackEnabled === false,
        });
      }
      return result;
    }

    if (!cropResult.rawCropBuffer) {
      result.diagSkipped++;
      // PR-BT-2 (系統B、FIND-BT-H-01 + L-01): no_crop_buffer exit は複数原因で
      // fire する。terminal-skip マーカーを書くのは
      // `isOutOfRange === true && p.fallbackEnabled === false` (backfill path で
      // 永続 screenshot に写らず Playwright fallback も起動しない = 構造的に
      // crop 不能 = terminal) の場合のみに narrow する。
      //   - transient decode 失敗 (`isOutOfRange === false`) は marker 書込なし
      //     (recoverable、pending 継続 = retry、INV-(b) orthogonality 保全)。
      //   - main-path (`fallbackEnabled === true`) は条件 false で marker 書込なし
      //     (out-of-range section は fallback queue で回収可能、Phase 5 proper
      //     非汚染、INV-007 Block D で assert)。
      //
      // PR-BT-2 (System B, FIND-BT-H-01 + L-01): the no_crop_buffer exit fires
      // for multiple causes. Write the terminal-skip marker ONLY when
      // `isOutOfRange === true && p.fallbackEnabled === false` (structurally
      // uncroppable on the backfill path = terminal). Transient decode failures
      // (`isOutOfRange === false`) and the main path (`fallbackEnabled === true`)
      // write NO marker (recoverable; INV-007 Block D orthogonality).
      if (isOutOfRange && p.fallbackEnabled === false) {
        // PR-B (TPA-IMPL-L-01 dead-branch closure): in flag-OFF mode the persisted
        // fullPage screenshot is the only crop source (no Playwright re-capture), so an
        // off-screen section is structurally uncroppable = terminal. The prior nested
        // `if (p.isTruncatedRun && p.fallbackEnabled)` branch was dead (gated by
        // `fallbackEnabled === false`, so `p.fallbackEnabled` was always false here) and
        // is removed (no flag-OFF behaviour change). The section truncated retryable +
        // genuine re-capture now lives on the flag-ON path (`collectFallbackScreenshots`
        // re-captures off-screen sections; robots-disallowed ones converge to
        // `screenshot_truncated_expired` above).
        await writeSectionVisionSkipReason(p, "section_visual_uncroppable");
      }
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: truncateAuditTargetId(p.section.section_pattern_id),
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "skipped",
          skipReason: "no_crop_buffer",
          terminalSkip: isOutOfRange && p.fallbackEnabled === false,
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
        sectionId: truncateAuditTargetId(p.section.section_pattern_id),
        sectionType: currentSectionType,
      });
      // PR-BT-2 (系統B、FIND-BT-H-02-RESIDUAL 案X): backfill path
      // (`p.fallbackEnabled === false`) では dedup-skip された both-NULL same-type
      // section を `section_visual_duplicate` で terminal 化する。同 type sibling
      // が cosine>threshold で代表 visual を保持するため embedding は真に不要
      // (Type-aware dedup 契約が意図的に抑制)。これにより永久 pending を解消し
      // page が completed に到達できる。main-path (`fallbackEnabled === true`) は
      // marker 書込なし (Phase 5 proper はループ scope 内で完結し inline parity で
      // completed に到達、誤 terminal 化は INV-007 Block D で排除)。
      //
      // PR-BT-2 (System B, FIND-BT-H-02-RESIDUAL Option X): on the backfill path
      // (`p.fallbackEnabled === false`), terminal-mark a dedup-skipped both-NULL
      // same-type section via `section_visual_duplicate` (a same-type sibling at
      // cosine>threshold represents the visual, so the embedding is genuinely
      // unnecessary), resolving the permanent pending so the page can complete.
      // The main path (`fallbackEnabled === true`) writes NO marker (INV-007
      // Block D orthogonality).
      if (p.fallbackEnabled === false) {
        await writeSectionVisionSkipReason(p, "section_visual_duplicate");
      }
      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Section visual path", {
          sectionId: truncateAuditTargetId(p.section.section_pattern_id),
          startY: sectionPos.startY,
          height: sectionPos.height,
          imgHeight: p.imgHeight,
          path: "dedup",
          sectionType: currentSectionType,
          terminalSkip: p.fallbackEnabled === false,
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

    // Update vision_embedding in DB via raw SQL.
    // ADR-0018 Amendment 13 follow-up (cosmetic metadata-cleanliness L): clear any
    // stale `vision_skip_reason` in the SAME UPDATE. When the backfill path
    // genuinely regenerates visual (e.g. a `screenshot_truncated` row recovered via
    // Playwright re-capture), the prior skip marker is stale and would otherwise
    // leave a contradictory row (vision_embedding IS NOT NULL AND
    // vision_skip_reason non-NULL). Functionally harmless (pending predicate gates
    // on vision_embedding IS NULL; search filters on IS NOT NULL only) but
    // metadata-inaccurate — GDPR Art.5(1)(d) accuracy.
    const visualVectorString = `[${visualEmbedding.join(",")}]`;
    await p.prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
       SET vision_embedding = $1::vector(768),
           vision_skip_reason = NULL
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
        sectionId: truncateAuditTargetId(p.section.section_pattern_id),
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
      sectionEmbeddingId: truncateAuditTargetId(p.section.id),
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
  /** PR-B (Plan §7.5 / FIND-RE-LCC-01): 動的Fallback再capture 直前の robots.txt 再評価。 */
  recheckRobotsTxt?: boolean | undefined;
  /** PR-B: robots.txt 尊重オーバーライド (recheckRobotsTxt 時のみ参照)。 */
  respectRobotsTxt?: boolean | undefined;
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
      recheckRobotsTxt: p.recheckRobotsTxt,
      respectRobotsTxt: p.respectRobotsTxt,
    });

    // PR-B (Plan §7.5 / FIND-RE-LCC-01): 動的Fallback でも robots.txt Disallow なら
    // 再capture 不能 → `screenshot_truncated_expired` terminal へ fail-loud 収束 (off-screen
    // path と対称)。 / On the dynamic-fallback path too, robots.txt Disallow converges sections
    // to `screenshot_truncated_expired` (symmetric with the off-screen path).
    if (dynamicFallbackResult.robotsDisallowed) {
      for (const ds of dynamicBatch) {
        try {
          await p.prisma.$executeRawUnsafe(
            `UPDATE section_embeddings
               SET vision_skip_reason = $1
             WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
            "screenshot_truncated_expired",
            ds.sectionEmbeddingId
          );
        } catch (markerError) {
          logger.warn(
            "[PageAnalyzeWorker] Failed to write robots-disallowed dynamic-fallback terminal marker (non-fatal)",
            {
              sectionId: truncateAuditTargetId(ds.sectionPatternId),
              error: markerError instanceof Error ? markerError.message : String(markerError),
            }
          );
        }
      }
      logger.warn(
        "[PageAnalyzeWorker] robots.txt Disallow on dynamic fallback; converged sections to screenshot_truncated_expired",
        { sectionCount: dynamicBatch.length }
      );
      return result;
    }

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
              sectionId: truncateAuditTargetId(fbResult.sectionId),
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

        // ADR-0018 Amendment 13 follow-up: clear any stale `vision_skip_reason`
        // in the same UPDATE (symmetry with the standard write above) so a
        // dynamically re-captured section does not retain a contradictory marker.
        const visualVectorString = `[${visualEmbedding.join(",")}]`;
        await p.prisma.$executeRawUnsafe(
          `UPDATE section_embeddings
           SET vision_embedding = $1::vector(768),
               vision_skip_reason = NULL
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
            sectionId: truncateAuditTargetId(fbResult.sectionId),
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
  /**
   * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1/3): per-sub-phase fork filter. When
   * set, ONLY this single text sub-phase runs (the per-sub-phase fork model —
   * each fork processes one sub-phase then `exit(0)`s so the OS reclaims the
   * arena). When **omitted**, ALL 7 text sub-phases run sequentially (legacy
   * 2-fork grandfather behaviour, `PHASE5_SUBPHASE_FORK_ENABLED=false`).
   * SSOT-typed via `Phase5TextSubPhase`.
   *
   * PR-BT-5 (M-1-RSS): per-sub-phase fork フィルタ。指定時は当 1 sub-phase のみ
   * 実行。省略時は legacy 全 7 sub-phase 実行に grandfather。
   */
  subPhase?: Phase5TextSubPhase | undefined;
}

/**
 * Result from text embedding sub-phases (fork child process).
 *
 * PR-V3-T1a §3.2 C1/C3 (FIND-V3-IO-H-01 closure): additively added optional
 * `chunkedEncoderTelemetry` so the parent can emit `audit_logs` entries for
 * the C1 (per-chunk RSS overshoot) / C3 (partial completion) / C4
 * (idempotency-on-retry skip) outcomes. Optional preserves backward
 * compatibility with legacy callers and the `--feature-flag=false` fallback.
 *
 * PR-V3-T1a §3.2 C1/C3: additively added optional `chunkedEncoderTelemetry`
 * for `audit_logs` emission via the parent.
 */
export interface TextEmbeddingSubPhaseResult {
  sectionEmbeddingsGenerated: number;
  motionEmbeddingsGenerated: number;
  bgEmbeddingsGenerated: number;
  jsAnimationEmbeddingsGenerated: number;
  responsiveEmbeddingsGenerated: number;
  partEmbeddingsGenerated: number;
  embeddingFailedChunks: number;
  chunkedEncoderTelemetry?: ChunkedEncoderTelemetry;
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
    partVisualSkippedBboxInvalid: 0,
    partVisualSkippedBboxUnresolvable: 0,
    partVisualSkippedScreenshotTruncated: 0,
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

  // PR-V3-T1a §3.2: chunked encoder telemetry container; mutated by
  // `processSectionTextEmbeddingChunks` and surfaced via the IPC text-result
  // message back to the parent for `audit_logs` emission.
  const chunkedEncoderTelemetry: ChunkedEncoderTelemetry = {};

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
    prisma: textParams.prisma,
    result: textResult,
    reportEmbeddingSubProgress: reportProgress,
    chunkedEncoderTelemetry,
  };

  // PR-BT-5 (M-1-RSS, ADR-0039 Decision 1): per-sub-phase fork filter. When
  // `subPhase` is set, ONLY the matching sub-phase runs (1 fork = 1 sub-phase →
  // exit(0) → OS arena reclamation). When `subPhase` is undefined the legacy
  // path runs all 7 sub-phases sequentially (grandfather,
  // PHASE5_SUBPHASE_FORK_ENABLED=false). `runSub` returns true for the legacy
  // (unset) case OR an exact match.
  const runSub = (name: Phase5TextSubPhase): boolean =>
    textParams.subPhase === undefined || textParams.subPhase === name;

  // Run the selected text embedding sub-phase(s) in order.
  if (runSub("section_text")) {
    await processSectionTextEmbeddingChunks(
      ctx,
      textParams.sectionSaveResult as EmbeddingPhaseParams["sectionSaveResult"],
      textParams.layoutResultForNarrative
    );
  }
  if (runSub("motion_text")) {
    await processMotionTextEmbeddingChunks(
      ctx,
      textParams.motionSaveResult as EmbeddingPhaseParams["motionSaveResult"],
      textParams.motionResultForEmbedding
    );
  }
  if (runSub("vision_motion_text")) {
    await processVisionMotionEmbeddingChunks(
      ctx,
      textParams.scrollVisionSaveResult as EmbeddingPhaseParams["scrollVisionSaveResult"],
      textParams.scrollVisionResultForEmbedding
    );
  }
  if (runSub("background_text")) {
    await processBackgroundTextEmbeddingChunks(
      ctx,
      textParams.bgSaveResult as EmbeddingPhaseParams["bgSaveResult"],
      textParams.layoutResultForNarrative
    );
  }
  if (runSub("js_animation_text")) {
    await processJsAnimationEmbeddingChunks(
      ctx,
      textParams.jsSaveResult as EmbeddingPhaseParams["jsSaveResult"],
      textParams.jsAnimationsForEmbedding
    );
  }
  if (runSub("responsive_text")) {
    await processResponsiveEmbeddingChunks(ctx, textParams.responsiveAnalysisId);
  }
  if (runSub("part_text")) {
    // v0.4.0 PR4: 同期フェーズは partsLimit に従って DB レベルで件数制限する
    // v0.4.0 PR4: sync phase respects partsLimit (DB-level cap)
    await processPartTextEmbeddingChunks(ctx, textParams.partsSavedCount, {
      limit: textParams.partsLimit,
    });
  }

  // PR-V3-T1a §3.2: surface chunked encoder telemetry only when populated.
  // Returning `undefined` for the un-populated case keeps the legacy IPC
  // payload byte-for-byte equivalent.
  const result: TextEmbeddingSubPhaseResult = {
    sectionEmbeddingsGenerated: textResult.sectionEmbeddingsGenerated,
    motionEmbeddingsGenerated: textResult.motionEmbeddingsGenerated,
    bgEmbeddingsGenerated: textResult.bgEmbeddingsGenerated,
    jsAnimationEmbeddingsGenerated: textResult.jsAnimationEmbeddingsGenerated,
    responsiveEmbeddingsGenerated: textResult.responsiveEmbeddingsGenerated,
    partEmbeddingsGenerated: textResult.partEmbeddingsGenerated,
    embeddingFailedChunks: textResult.embeddingFailedChunks,
  };
  // Telemetry is propagated only when at least one field was populated.
  if (
    chunkedEncoderTelemetry.partialCompletion !== undefined ||
    chunkedEncoderTelemetry.budgetExceededChunkIndex !== undefined ||
    chunkedEncoderTelemetry.idempotencyChunkSkippedCount !== undefined
  ) {
    result.chunkedEncoderTelemetry = chunkedEncoderTelemetry;
  }
  return result;
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
  /**
   * PR-B (Plan §7.5 / FIND-RE-LCC-01): backfill section fallback re-capture 直前に
   * robots.txt を再評価するか。backfill processor は `true`、Phase 5 proper (fork child)
   * は省略 (既定 false) で contemporaneous 前提を保持。
   *
   * PR-B (Plan §7.5 / FIND-RE-LCC-01): whether to re-evaluate robots.txt just before the
   * backfill section-fallback re-capture. Backfill processors pass `true`; Phase 5 proper
   * omits it (default false) to preserve the contemporaneous assumption.
   */
  recheckRobotsTxt?: boolean | undefined;
  /** PR-B: robots.txt 尊重オーバーライド (recheckRobotsTxt 時のみ参照、undefined で env flag)。 */
  respectRobotsTxt?: boolean | undefined;
  dinov2ModelPath: string;
  prisma: EmbeddingPhasePrismaClient;
  onLockExtend: (label: string) => void;
  onProgress?: (completed: number, total: number) => void;
  /**
   * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1/3): per-sub-phase fork filter. When
   * set, ONLY this single visual sub-phase runs (1 fork = 1 sub-phase → exit(0)
   * → OS reclaims DINOv2 arena + VRAM). When **omitted**, BOTH section_visual +
   * part_visual run sequentially (legacy 2-fork grandfather behaviour).
   * SSOT-typed via `Phase5VisualSubPhase`.
   *
   * PR-BT-5 (M-1-RSS): per-sub-phase fork フィルタ。指定時は当 1 sub-phase のみ
   * 実行。省略時は legacy 全 visual sub-phase 実行に grandfather。
   */
  subPhase?: Phase5VisualSubPhase | undefined;
}

/**
 * Result from visual embedding sub-phases (fork child process).
 */
export interface VisualEmbeddingSubPhaseResult {
  sectionVisualEmbeddingsGenerated: number;
  partVisualEmbeddingsGenerated: number;
  /**
   * Part visual embedding loop で bbox_invalid により skip された件数
   * (PR-D-2, INV-EMBEDDING-INTEGRITY-005)。fork child → parent IPC で伝搬する。
   *
   * Count of parts skipped by bbox_invalid in the Part visual embedding loop
   * (PR-D-2, INV-EMBEDDING-INTEGRITY-005). Propagated from fork child → parent
   * via IPC.
   */
  partVisualSkippedBboxInvalid: number;
  /**
   * ADR-0018 Amendment 7 §7.6 exit #2: count of parts skipped because the
   * off-screen-clamped crop is zero-size (bbox_unresolvable terminal marker
   * written). Propagated from fork child → parent via IPC (symmetric with
   * partVisualSkippedBboxInvalid).
   */
  partVisualSkippedBboxUnresolvable: number;
  /**
   * ADR-0018 Amendment 13 (truncated-screenshot data-loss fix, Plan §5.1 / §8.2):
   * count of parts routed to the bounded-retryable `screenshot_truncated` reason
   * (off-screen ONLY due to a truncated screenshot, flag-gated). Propagated from
   * fork child → parent via IPC (symmetric with partVisualSkippedBboxUnresolvable).
   */
  partVisualSkippedScreenshotTruncated: number;
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
    partVisualSkippedBboxInvalid: 0,
    partVisualSkippedBboxUnresolvable: 0,
    partVisualSkippedScreenshotTruncated: 0,
    embeddingFailedChunks: 0,
  };

  // PR-BT-5 (M-1-RSS, ADR-0039 Decision 1): per-sub-phase fork filter. When
  // `subPhase` is set, ONLY the matching visual sub-phase runs; when undefined
  // both run (legacy grandfather). The data-presence checks (idMapping size /
  // partsSavedCount) are AND-ed with the filter so an empty sub-phase still
  // skips its block.
  const wantSectionVisual = vParams.subPhase === undefined || vParams.subPhase === "section_visual";
  const wantPartVisual = vParams.subPhase === undefined || vParams.subPhase === "part_visual";
  const hasSections = wantSectionVisual && vParams.sectionIdMapping.size > 0;
  const hasParts = wantPartVisual && vParams.partsSavedCount > 0;

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

        // terminal-skip 行 (vision_skip_reason 非NULL) は SSOT exclusion predicate
        // で work-fetch から除外し、terminal section を再取得しない (PR-BT-2、
        // part_visual と対称、inline WHERE 禁止)。
        // Terminal-skip rows (vision_skip_reason non-NULL) are excluded from the
        // work-fetch via the SSOT exclusion predicate so terminal sections are not
        // re-fetched (PR-BT-2, symmetry with part_visual).
        const sectionsNeedingVisual = await vParams.prisma.$queryRawUnsafe<
          Array<{ id: string; section_pattern_id: string }>
        >(
          `SELECT se.id, se.section_pattern_id
           FROM section_embeddings se
           WHERE se.section_pattern_id IN (
             SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
           )
           AND ${sectionVisualPendingExclusionPredicate("se")}`,
          vParams.webPageId
        );

        // PII protection (GDPR Art. 5(1)(c)).
        //
        // PR-C4 B3 (TPA-IMPL-01 dead-code closure): derive the high-PII set
        // from the **PII-filter-free** pending condition keyed on web_page_id,
        // NOT from `sectionsNeedingVisual` (which is already PII-filtered by the
        // SSOT predicate's NOT EXISTS clause). This independent query returns
        // exactly the high-PII pending sections the work side declines to embed
        // — the correct, live marker input.
        //
        // PR-C4 B6 (TPA-RV2-01 hoist closure): the high-PII marker computation +
        // write are hoisted OUT of the `if (sectionsNeedingVisual.length > 0)`
        // gate. On a page whose only pending sections are high-PII (e.g. w3.org,
        // navigation is high-PII), `sectionsNeedingVisual` is empty (the SSOT
        // predicate excludes high-PII rows), so the marker write was previously
        // unreachable → 0 GDPR Art.30 trail emitted. Hoisting guarantees the
        // marker + audit fire whenever a high-PII pending set exists, regardless
        // of whether any non-PII visual work remains.
        const highPiiSectionIdSet = new Set(
          await queryHighPiiPendingSectionPatternIds(vParams.prisma, vParams.webPageId)
        );

        // PR-C4 (ADR-0018 Amendment, Path B, B3 live / B6 hoist): write the
        // `section_visual_pii_excluded` terminal marker for the high-PII
        // pending sections found above. This (a) records the intentional
        // non-generation as a GDPR Art.30 trail and (b) provides a second
        // pending-exclusion defense layer alongside Path A's PII NOT EXISTS.
        // Non-fatal; idempotent (marker write itself terminalizes the rows so
        // subsequent runs see the empty set → no double-emit). Extracted helper
        // keeps this site branch-free (TDA-PLAN-02).
        if (highPiiSectionIdSet.size > 0) {
          await writeSectionVisualPiiExcludedMarkers(
            vParams.prisma,
            vParams.webPageId,
            Array.from(highPiiSectionIdSet)
          );
        }

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

          // High-PII rows are already terminalized by the hoisted marker write
          // above (and were never in `sectionsNeedingVisual`). Filter defensively
          // so the per-section loop never attempts a high-PII section.
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
            recheckRobotsTxt: vParams.recheckRobotsTxt,
            respectRobotsTxt: vParams.respectRobotsTxt,
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
          partVisualSkippedBboxInvalid: 0,
          partVisualSkippedBboxUnresolvable: 0,
          partVisualSkippedScreenshotTruncated: 0,
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
          prisma: vParams.prisma,
          result: partResultHolder,
          reportEmbeddingSubProgress: () => {
            /* no-op */
          },
          // PR-V3-T1a §3.2: visual sub-phase does not exercise the chunked
          // encoder hardening, but the structural type requires the field;
          // an empty record keeps TS happy and the visual path never reads it.
          chunkedEncoderTelemetry: {},
        };

        await processPartVisualEmbeddingLoop(
          partCtx,
          screenshotBuffer,
          rawScreenshotMeta,
          null,
          imgWidth,
          imgHeight,
          dinov2Service,
          // ADR-0018 Amendment 13 §5.9 flag-gating: `fallbackEnabled` gates the
          // truncated-screenshot retryable reclassification. PR-A keeps this
          // `false` at both backfill callsites (status-quo fallback), so no new
          // `screenshot_truncated` is generated until PR-B flips it ON.
          vParams.fallbackEnabled,
          // v0.4.0 PR4: partsLimit を DINOv2 ループへ伝搬
          // v0.4.0 PR4: propagate partsLimit to the DINOv2 loop
          { limit: vParams.partsLimit }
        );

        vResult.partVisualEmbeddingsGenerated = partResultHolder.partVisualEmbeddingsGenerated;
        // PR-D-2 / INV-EMBEDDING-INTEGRITY-005: bbox_invalid counter を親へ伝搬
        // PR-D-2 / INV-EMBEDDING-INTEGRITY-005: propagate bbox_invalid counter to parent
        vResult.partVisualSkippedBboxInvalid = partResultHolder.partVisualSkippedBboxInvalid;
        // ADR-0018 Amendment 7 §7.6 exit #2: propagate bbox_unresolvable counter to parent
        vResult.partVisualSkippedBboxUnresolvable =
          partResultHolder.partVisualSkippedBboxUnresolvable;
        // ADR-0018 Amendment 13 §8.2: propagate screenshot_truncated counter to parent
        vResult.partVisualSkippedScreenshotTruncated =
          partResultHolder.partVisualSkippedScreenshotTruncated;
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
        // PR-G1 RC1 (SEC-05): scroll sweep の各 iteration 境界で lock を延長し、
        // 長尺ページの sweep による lock 失効 (dual-run / stall) を防止する。
        // Extend the job lock at each scroll-sweep iteration boundary to prevent
        // lock expiry (dual-run / stall) during a long-page sweep.
        onLockExtend: () =>
          extendJobLock(
            params.job,
            params.effectiveToken,
            params.effectiveLockDuration,
            "part-bbox-scroll-sweep"
          ),
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
