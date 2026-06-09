// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Text Embedding Child Process
 *
 * Entry point for child_process.fork() — generates all text embeddings:
 *   1. Section text (e5-base)
 *   2. Motion text
 *   3. Vision-detected Motion text
 *   4. Background text
 *   5. JS Animation text
 *   6. Responsive Analysis text
 *   7. Part text
 *
 * Lifecycle:
 *   1. Parent sends `init-text` IPC message with serialized data
 *   2. Child creates own Prisma client and LayoutEmbeddingService
 *   3. Child calls sub-phase functions (imported from phase-5-embedding.ts)
 *   4. Child sends periodic heartbeats via IPC
 *   5. Child sends `text-result` with counts on success, or `error` on failure
 *   6. Child disconnects Prisma and exits (OS reclaims all memory)
 *
 * P0-1: EMBEDDING_WORKER_THREAD=false set by parent fork env (in-process ONNX)
 * P0-2: All IPC messages validated via Zod schemas
 * P0-3: DATABASE_URL has connection_limit=3 (set by parent)
 * P0-10: Error messages sanitized via sanitizeErrorMessage (CWE-209)
 * P1-14: IPC error messages capped at 1000 chars
 *
 * @module workers/phases/phase-5-text-embedding-child
 */

import { prisma } from "@reftrixmcp/database";
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../../services/layout-embedding.service";
import {
  setBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  setMotionLayoutEmbeddingServiceFactory,
} from "../../tools/page/handlers/embedding-handler";
import { setFramePrismaClientFactory } from "../../services/motion/frame-embedding.service";
// v0.4.0 PR7e-β3: motion_embeddings silent-zero 修復
// fork child の setupDI が motion persistence factory を設定していなかったため、
// `getMotionPersistenceService().isAvailable()` が false を返し motion embedding が
// 全件 silent skip されていた (reftrix.io 552件 / Stripe 216件 motion_patterns に対し
// motion_embeddings = 0)。sync 経路 (service-registrar-analysis.ts:236-244) と同じ
// 2 factory を fork child でも明示的に設定する。
//
// v0.4.0 PR7e-β3: Fix for motion_embeddings silent-zero bug. The fork child's
// setupDI was not registering motion persistence factories, causing
// `getMotionPersistenceService().isAvailable()` to return false and all motion
// embeddings to be silently skipped (motion_embeddings = 0 across all pages
// despite 552 + 216 motion_patterns). Align the fork child with the sync path
// (service-registrar-analysis.ts:236-244) by explicitly registering the same
// 2 factories.
import {
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
} from "../../services/motion-persistence.service";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  validateParentMessage,
  deserializeIdMapping,
  truncateErrorForIPC,
  sendToParent,
  sendToParentAndFlush,
  startHeartbeat,
  stopHeartbeat,
  registerProcessErrorHandlers,
  handleShutdown,
} from "./phase-5-child-ipc";
import { type EmbeddingPhaseResult, initMemoryConstants } from "./types";
import { runTextEmbeddingSubPhases } from "./phase-5-embedding";
import { wireChildExecutionProvider } from "./phase-5-gpu-probe";

import type { SaveResult } from "../../services/worker-db-save.service";
import type { SaveBackgroundDesignsResult } from "../../services/background/background-design-db.service";
import type { SaveScrollVisionResult } from "../../services/vision/scroll-vision-persistence.service";
import type {
  LayoutServiceResult,
  MotionServiceResult,
  JSAnimationFullResult,
} from "../../tools/page/handlers/types";
import type { ScrollVisionResult } from "../../services/vision/scroll-vision.analyzer";

// ============================================================================
// DI Setup
// ============================================================================

/**
 * Initialize DI factories for LayoutEmbeddingService and related services.
 *
 * In child process context (EMBEDDING_WORKER_THREAD=false), EmbeddingService
 * runs ONNX in-process instead of spawning a worker_thread.
 */
function setupDI(sharedService: LayoutEmbeddingService): void {
  setEmbeddingServiceFactory(() => mlEmbeddingService);
  setLayoutPrismaClientFactory(() => prisma as never);
  setBackgroundEmbeddingServiceFactory(() => sharedService);
  setMotionLayoutEmbeddingServiceFactory(() => sharedService);
  setBackgroundPrismaClientFactory(() => prisma as never);
  setFramePrismaClientFactory(() => prisma as never);
  // v0.4.0 PR7e-β3: motion_embeddings silent-zero 修復 (上記 import コメント参照)
  // `motion-persistence.service.ts` の IEmbeddingService インターフェースは
  // `generateEmbedding(text, type)` を要求する。sharedService (LayoutEmbeddingService) は
  // `generateFromText()` のみを公開しており型不適合のため、`@reftrixmcp/ml` の `mlEmbeddingService`
  // (IEmbeddingService 互換、sync path の `service-registrar-analysis.ts:236` と同じインスタンス)
  // を直接渡す。
  //
  // v0.4.0 PR7e-β3: Motion persistence DI for motion_embeddings generation (see import).
  // `motion-persistence.service.ts`'s `IEmbeddingService` interface requires
  // `generateEmbedding(text, type)`. `sharedService` (LayoutEmbeddingService) only exposes
  // `generateFromText()` and is type-incompatible, so we pass `@reftrixmcp/ml`'s
  // `mlEmbeddingService` directly (IEmbeddingService-compatible, same instance used by the
  // sync path at `service-registrar-analysis.ts:236`).
  setMotionPersistenceEmbeddingServiceFactory(() => mlEmbeddingService);
  setMotionPersistencePrismaClientFactory(() => prisma as never);
}

// ============================================================================
// Reconstruct SaveResult-like objects from IPC data
// ============================================================================

function rebuildSaveResult(idMappingEntries: [string, string][] | null): SaveResult | null {
  if (!idMappingEntries) return null;
  const map = deserializeIdMapping(idMappingEntries);
  if (map.size === 0) return null;
  return {
    success: true,
    count: map.size,
    ids: Array.from(map.values()),
    idMapping: map,
  };
}

function rebuildBgSaveResult(bgIds: string[] | null): SaveBackgroundDesignsResult | null {
  if (!bgIds || bgIds.length === 0) return null;
  // Background designs use name→id mapping; reconstruct from ids
  const idMapping = new Map<string, string>();
  for (const id of bgIds) {
    idMapping.set(id, id);
  }
  return {
    success: true,
    count: bgIds.length,
    ids: bgIds,
    idMapping,
  };
}

function rebuildScrollVisionSaveResult(
  idMappingEntries: [string, string][] | null
): SaveScrollVisionResult | null {
  if (!idMappingEntries) return null;
  const map = deserializeIdMapping(idMappingEntries);
  if (map.size === 0) return null;
  return {
    success: true,
    count: map.size,
    ids: Array.from(map.values()),
    idMapping: map,
  };
}

// ============================================================================
// Main: IPC Message Handler
// ============================================================================

process.on("message", async (raw: unknown) => {
  const msg = validateParentMessage(raw);
  if (!msg) return;

  if (msg.type === "shutdown") {
    await handleShutdown(prisma);
    return;
  }

  if (msg.type !== "init-text") return;

  // Initialize memory constants for chunk sizing
  initMemoryConstants();

  // PR-1 GPU-COORD (ADR-0038 §1.1/§1.6, FIND-PLAN-H-01): child-local VRAM probe
  // pre-flight. Sets ONNX_EXECUTION_PROVIDER child-locally BEFORE the e5-base
  // in-process init reads it via detectExecutionProvider, so the probe result
  // actually drives the CUDA-vs-CPU selection (zero new IPC types; the parent
  // already emitted any degraded audit). Awaited before LayoutEmbeddingService
  // construction so the provider is resolved prior to ONNX session creation.
  await wireChildExecutionProvider("text");

  // Create shared LayoutEmbeddingService (in-process ONNX via EMBEDDING_WORKER_THREAD=false)
  const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
  setupDI(sharedLayoutEmbeddingService);

  startHeartbeat("text-embedding");

  const result: EmbeddingPhaseResult = {
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

  try {
    // Reconstruct save results from IPC data
    const sectionSaveResult = rebuildSaveResult(msg.sectionIdMapping);
    const motionSaveResult = rebuildSaveResult(msg.motionIdMapping);
    const jsSaveResult = rebuildSaveResult(msg.jsIdMapping);
    const bgSaveResult = rebuildBgSaveResult(msg.bgIds);
    const scrollVisionSaveResult = rebuildScrollVisionSaveResult(msg.scrollVisionIdMapping);

    // Parse JSON payloads
    const layoutResultForNarrative: LayoutServiceResult | null = msg.layoutResultJson
      ? JSON.parse(msg.layoutResultJson)
      : null;
    const motionResultForEmbedding: MotionServiceResult | null = msg.motionResultJson
      ? JSON.parse(msg.motionResultJson)
      : null;
    const jsAnimationsForEmbedding: JSAnimationFullResult | null = msg.jsAnimationsJson
      ? JSON.parse(msg.jsAnimationsJson)
      : null;
    const scrollVisionResultForEmbedding: ScrollVisionResult | null = msg.scrollVisionResultJson
      ? JSON.parse(msg.scrollVisionResultJson)
      : null;

    // Run all text embedding sub-phases
    // The `sendToParent` heartbeat callback allows lock extension relay
    const subResult = await runTextEmbeddingSubPhases({
      webPageId: msg.webPageId,
      url: msg.url,
      sectionSaveResult,
      motionSaveResult,
      jsSaveResult,
      bgSaveResult,
      scrollVisionSaveResult,
      layoutResultForNarrative,
      motionResultForEmbedding,
      jsAnimationsForEmbedding,
      scrollVisionResultForEmbedding,
      responsiveAnalysisId: msg.responsiveAnalysisId,
      partsSavedCount: msg.partsSavedCount,
      // v0.4.0 PR4: 同期フェーズの Part text embedding 上限を子プロセスに伝搬
      // v0.4.0 PR4: propagate sync-phase Part text embedding cap to the child
      partsLimit: msg.partsLimit,
      // PR-BT-5 (M-1-RSS, ADR-0039 Decision 1): per-sub-phase fork filter. When
      // set, only this single text sub-phase runs then the child exit(0)s.
      // Undefined grandfathers to the legacy all-7-sub-phase behaviour.
      subPhase: msg.subPhase,
      sharedLayoutEmbeddingService,
      prisma: prisma as never,
      onLockExtend: (label: string) => {
        sendToParent({ type: "lock-request", label });
      },
      onProgress: (completed: number, total: number) => {
        sendToParent({ type: "progress", completed, total, phase: "text-embedding" });
      },
    });

    // Merge sub-phase results
    result.sectionEmbeddingsGenerated = subResult.sectionEmbeddingsGenerated;
    result.motionEmbeddingsGenerated = subResult.motionEmbeddingsGenerated;
    result.bgEmbeddingsGenerated = subResult.bgEmbeddingsGenerated;
    result.jsAnimationEmbeddingsGenerated = subResult.jsAnimationEmbeddingsGenerated;
    result.responsiveEmbeddingsGenerated = subResult.responsiveEmbeddingsGenerated;
    result.partEmbeddingsGenerated = subResult.partEmbeddingsGenerated;
    result.embeddingFailedChunks = subResult.embeddingFailedChunks;
    result.completed = true;

    // Send success result to parent (flush before exit to prevent IPC race).
    // PR-V3-T1a §3.2: forward optional chunked encoder telemetry so the
    // parent can emit audit_logs entries for C1 (per-chunk RSS overshoot) /
    // C3 (partial completion) / C4 (idempotency-on-retry skip) outcomes.
    await sendToParentAndFlush({
      type: "text-result",
      sectionEmbeddingsGenerated: result.sectionEmbeddingsGenerated,
      motionEmbeddingsGenerated: result.motionEmbeddingsGenerated,
      bgEmbeddingsGenerated: result.bgEmbeddingsGenerated,
      jsAnimationEmbeddingsGenerated: result.jsAnimationEmbeddingsGenerated,
      responsiveEmbeddingsGenerated: result.responsiveEmbeddingsGenerated,
      partEmbeddingsGenerated: result.partEmbeddingsGenerated,
      embeddingFailedChunks: result.embeddingFailedChunks,
      ...(subResult.chunkedEncoderTelemetry !== undefined
        ? { chunkedEncoderTelemetry: subResult.chunkedEncoderTelemetry }
        : {}),
    });
  } catch (error) {
    await sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(sanitizeErrorMessage(error)),
      phase: "text-embedding",
    });
  } finally {
    stopHeartbeat();
    // Note: disposeEmbeddingPipeline() intentionally omitted.
    // ONNX Runtime native addon dispose can SIGSEGV due to heap fragmentation,
    // which kills the child before the IPC text-result message reaches the parent.
    // Since process.exit(0) follows, the OS reclaims all memory anyway.
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }

  // Exit cleanly — OS reclaims all memory (including ONNX Runtime)
  process.exit(0);
});

// Handle uncaught errors (shared implementation in phase-5-child-ipc.ts)
registerProcessErrorHandlers("text-embedding");
