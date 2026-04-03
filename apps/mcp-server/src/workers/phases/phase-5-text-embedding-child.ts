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

    // Send success result to parent (flush before exit to prevent IPC race)
    await sendToParentAndFlush({
      type: "text-result",
      sectionEmbeddingsGenerated: result.sectionEmbeddingsGenerated,
      motionEmbeddingsGenerated: result.motionEmbeddingsGenerated,
      bgEmbeddingsGenerated: result.bgEmbeddingsGenerated,
      jsAnimationEmbeddingsGenerated: result.jsAnimationEmbeddingsGenerated,
      responsiveEmbeddingsGenerated: result.responsiveEmbeddingsGenerated,
      partEmbeddingsGenerated: result.partEmbeddingsGenerated,
      embeddingFailedChunks: result.embeddingFailedChunks,
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
