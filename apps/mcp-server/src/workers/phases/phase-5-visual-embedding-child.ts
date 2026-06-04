// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Visual Embedding Child Process
 *
 * Entry point for child_process.fork() — generates DINOv2 visual embeddings:
 *   1. Section visual embedding (DINOv2 ViT-B/14)
 *   2. Part visual embedding (DINOv2 ViT-B/14)
 *   3. Section screenshot fallback (standalone Chromium for out-of-range sections)
 *
 * Lifecycle:
 *   1. Parent sends `init-visual` IPC message with screenshotPngPath and config
 *   2. Child creates own Prisma client
 *   3. Child initializes DINOv2Service (in-process ONNX via DINOV2_WORKER_THREAD=false)
 *   4. Child runs section visual + part visual embedding loops
 *   5. Child sends periodic heartbeats via IPC
 *   6. Child sends `visual-result` with counts on success, or `error` on failure
 *   7. Child disconnects Prisma and exits (OS reclaims all memory + VRAM)
 *
 * P0-1: DINOV2_WORKER_THREAD=false set by parent fork env (in-process ONNX)
 * P0-2: All IPC messages validated via Zod schemas
 * P0-3: DATABASE_URL has connection_limit=3 (set by parent)
 * P0-10: Error messages sanitized via sanitizeErrorMessage (CWE-209)
 * P1-14: IPC error messages capped at 1000 chars
 *
 * Note: No sharedBrowser — visual child spawns standalone Chromium for
 * section screenshot fallback (Playwright Browser can't cross process boundary).
 *
 * @module workers/phases/phase-5-visual-embedding-child
 */

import * as fs from "node:fs";
import sharp from "sharp";
import { prisma } from "@reftrixmcp/database";
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
import { runVisualEmbeddingSubPhases } from "./phase-5-embedding";
import { wireChildExecutionProvider } from "./phase-5-gpu-probe";

import type { EmbeddingPhasePrismaClient } from "./phase-5-embedding";

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

  if (msg.type !== "init-visual") return;

  // Initialize memory constants for chunk sizing
  initMemoryConstants();

  // PR-1 GPU-COORD (ADR-0038 §1.1/§1.6, FIND-PLAN-H-01): child-local VRAM probe
  // pre-flight. Sets ONNX_EXECUTION_PROVIDER child-locally BEFORE the DINOv2
  // in-process init reads it via detectExecutionProvider, so the probe result
  // actually drives the CUDA-vs-CPU selection (zero new IPC types; the parent
  // already emitted any degraded audit). Uses the DINOv2 VRAM threshold.
  await wireChildExecutionProvider("visual");

  // Sharp memory control (same as legacy path)
  sharp.cache(false);
  sharp.concurrency(1);

  startHeartbeat("visual-embedding");

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
    sectionVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
    completed: false,
  };

  try {
    const hasSections = (msg.sectionIdMapping?.length ?? 0) > 0;
    const hasParts = (msg.partsSavedCount ?? 0) > 0;
    const hasScreenshot = !!msg.screenshotPngPath && fs.existsSync(msg.screenshotPngPath);

    if (!hasScreenshot || (!hasSections && !hasParts)) {
      // Nothing to do — send empty result (flush before exit via finally→process.exit)
      await sendToParentAndFlush({
        type: "visual-result",
        sectionVisualEmbeddingsGenerated: 0,
        partVisualEmbeddingsGenerated: 0,
        partVisualSkippedBboxInvalid: 0,
        partVisualSkippedBboxUnresolvable: 0,
        embeddingFailedChunks: 0,
      });
      return;
    }

    // Run visual embedding sub-phases (extracted function from phase-5-embedding.ts)
    const subResult = await runVisualEmbeddingSubPhases({
      webPageId: msg.webPageId,
      url: msg.url,
      screenshotPngPath: msg.screenshotPngPath,
      sectionIdMapping: deserializeIdMapping(msg.sectionIdMapping),
      partsSavedCount: msg.partsSavedCount ?? 0,
      // v0.4.0 PR4: 同期フェーズの Part visual embedding 上限を子プロセスに伝搬
      // v0.4.0 PR4: propagate sync-phase Part visual embedding cap to the child
      partsLimit: msg.partsLimit,
      layoutResultJson: msg.layoutResultJson,
      viewportWidth: msg.viewportWidth,
      viewportHeight: msg.viewportHeight,
      fallbackEnabled: msg.fallbackEnabled,
      dinov2ModelPath: msg.dinov2ModelPath,
      // PR-BT-5 (M-1-RSS, ADR-0039 Decision 1): per-sub-phase fork filter. When
      // set, only this single visual sub-phase runs then the child exit(0)s.
      // Undefined grandfathers to running both section_visual + part_visual.
      subPhase: msg.subPhase,
      prisma: prisma as unknown as EmbeddingPhasePrismaClient,
      onLockExtend: (label: string) => {
        sendToParent({ type: "lock-request", label });
      },
      onProgress: (completed: number, total: number) => {
        sendToParent({ type: "progress", completed, total, phase: "visual-embedding" });
      },
    });

    result.sectionVisualEmbeddingsGenerated = subResult.sectionVisualEmbeddingsGenerated;
    result.partVisualEmbeddingsGenerated = subResult.partVisualEmbeddingsGenerated;
    result.partVisualSkippedBboxInvalid = subResult.partVisualSkippedBboxInvalid;
    result.partVisualSkippedBboxUnresolvable = subResult.partVisualSkippedBboxUnresolvable;
    result.embeddingFailedChunks = subResult.embeddingFailedChunks;
    result.completed = true;

    // Send success result to parent (flush before exit to prevent IPC race)
    await sendToParentAndFlush({
      type: "visual-result",
      sectionVisualEmbeddingsGenerated: result.sectionVisualEmbeddingsGenerated,
      partVisualEmbeddingsGenerated: result.partVisualEmbeddingsGenerated,
      partVisualSkippedBboxInvalid: result.partVisualSkippedBboxInvalid,
      partVisualSkippedBboxUnresolvable: result.partVisualSkippedBboxUnresolvable,
      embeddingFailedChunks: result.embeddingFailedChunks,
    });
  } catch (error) {
    await sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(sanitizeErrorMessage(error)),
      phase: "visual-embedding",
    });
  } finally {
    stopHeartbeat();
    // Sharp cleanup
    sharp.cache(true);
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }

  // Exit cleanly — OS reclaims all memory + VRAM
  process.exit(0);
});

// Handle uncaught errors (shared implementation in phase-5-child-ipc.ts)
registerProcessErrorHandlers("visual-embedding");
