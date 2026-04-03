// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Fork Orchestrator
 *
 * Manages child_process.fork() lifecycle for Phase 5 embedding generation.
 * Spawns two sequential child processes:
 *   1. Text Embedding child (e5-base, sections/motions/backgrounds/JS/responsive/parts)
 *   2. Visual Embedding child (DINOv2, section visual + part visual + fallback)
 *
 * Parent responsibilities:
 *   - Fork child processes with appropriate env vars
 *   - Relay BullMQ lock extensions on heartbeat/lock-request
 *   - Collect IPC results and aggregate counts
 *   - Handle child timeouts and crashes
 *   - Secondary tmp file cleanup after child exit (P1-17)
 *
 * P0-1: Child env sets EMBEDDING_WORKER_THREAD=false, DINOV2_WORKER_THREAD=false
 * P0-2: All IPC messages validated via Zod schemas
 * P0-3: DATABASE_URL gets ?connection_limit=3
 * P0-10: Error messages sanitized via sanitizeErrorMessage (CWE-209)
 * P1-12: fork() execArgv includes --max-old-space-size from tier profile
 * P1-13: Timeout env vars use safeParseInt
 *
 * Complexity target: ≤ 10 (P0-6)
 *
 * @module workers/phases/phase-5-fork-orchestrator
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { safeParseInt } from "../../utils/safe-parse-int";
import { computeMemoryProfile } from "../../services/worker-memory-profile";
import {
  type ChildToParentMessage,
  type ParentToChildMessage,
  validateChildMessage,
  serializeIdMapping,
  appendConnectionLimit,
} from "./phase-5-child-ipc";
import type { EmbeddingPhaseParams, EmbeddingPhaseResult } from "./types";
import { extendJobLock } from "./types";

// ============================================================================
// Constants (P1-13: safeParseInt for all timeout env vars)
// ============================================================================

/** Timeout for text embedding child process (ms) */
const TEXT_CHILD_TIMEOUT_MS = safeParseInt(process.env.PHASE5_TEXT_TIMEOUT_MS, 300_000, {
  min: 30_000,
  max: 1_800_000,
});

/** Timeout for visual embedding child process (ms) */
const VISUAL_CHILD_TIMEOUT_MS = safeParseInt(process.env.PHASE5_VISUAL_TIMEOUT_MS, 600_000, {
  min: 60_000,
  max: 3_600_000,
});

/** Heartbeat timeout — if no heartbeat in this interval, kill child (ms) */
const HEARTBEAT_TIMEOUT_MS = safeParseInt(process.env.PHASE5_HEARTBEAT_TIMEOUT_MS, 60_000, {
  min: 5_000,
  max: 300_000,
});

/** Connection pool limit for child process Prisma (P0-3) */
const CHILD_CONNECTION_LIMIT = safeParseInt(process.env.PHASE5_CHILD_CONNECTION_LIMIT, 3, {
  min: 1,
  max: 10,
});

// ============================================================================
// Fork Environment Builder
// ============================================================================

/**
 * Build environment variables for child process fork.
 *
 * P0-1: Disables worker_threads in both EmbeddingService and DINOv2Service.
 * P0-3: Appends connection_limit to DATABASE_URL.
 */
function buildChildEnv(): Record<string, string> {
  const profile = computeMemoryProfile();
  const baseEnv = { ...process.env } as Record<string, string>;

  // P0-1: Disable worker_threads nesting in child processes
  baseEnv.EMBEDDING_WORKER_THREAD = "false";
  baseEnv.DINOV2_WORKER_THREAD = "false";

  // P0-3: Limit connection pool size for child process
  if (baseEnv.DATABASE_URL) {
    baseEnv.DATABASE_URL = appendConnectionLimit(baseEnv.DATABASE_URL, CHILD_CONNECTION_LIMIT);
  }

  // Forward memory profile info for child's --max-old-space-size
  baseEnv.WORKER_MAX_OLD_SPACE_MB = String(profile.maxOldSpaceSizeMb);

  return baseEnv;
}

/**
 * Build execArgv for child process fork (P1-12).
 */
function buildChildExecArgv(): string[] {
  const profile = computeMemoryProfile();
  return [`--max-old-space-size=${profile.maxOldSpaceSizeMb}`, "--expose-gc"];
}

// ============================================================================
// Child Process Runner (extracted for complexity reduction — P0-6)
// ============================================================================

interface ChildRunOptions {
  /** Path to child process entry point script */
  scriptPath: string;
  /** IPC init message to send to child */
  initMessage: ParentToChildMessage;
  /** Timeout for the entire child process (ms) */
  timeoutMs: number;
  /** BullMQ job for lock extension relay */
  job: EmbeddingPhaseParams["job"];
  /** Worker token for lock extension */
  effectiveToken: string;
  /** Lock duration (ms) */
  effectiveLockDuration: number;
  /** Label for logging */
  label: string;
}

interface ChildRunResult {
  /** Parsed result message from child */
  message: ChildToParentMessage | null;
  /** Whether the child exited cleanly */
  exitedCleanly: boolean;
  /** Exit code (null if signal-killed) */
  exitCode: number | null;
}

/**
 * Merge child process result into aggregated EmbeddingPhaseResult.
 *
 * Handles the 3-branch pattern (success / error / abnormal-exit) that is
 * common to both text and visual child processes. (TDA HIGH-2)
 */
function mergeChildResult(
  childResult: ChildRunResult,
  expectedType: string,
  label: string,
  result: EmbeddingPhaseResult,
  mergeFn: (msg: ChildToParentMessage) => void
): void {
  if (childResult.message?.type === expectedType) {
    mergeFn(childResult.message);
  } else if (childResult.message?.type === "error") {
    result.embeddingFailedChunks++;
    logger.warn(`[Phase5-ForkOrchestrator] ${label} child returned error`, {
      error: childResult.message.message,
    });
  } else if (!childResult.exitedCleanly) {
    result.embeddingFailedChunks++;
    logger.warn(`[Phase5-ForkOrchestrator] ${label} child exited abnormally`, {
      exitCode: childResult.exitCode,
    });
  } else {
    // Fix: Detect IPC race condition — child exited cleanly (code 0) but
    // no result message was received. This happens when the "exit" event
    // fires before the "message" event in the parent's event loop.
    result.embeddingFailedChunks++;
    logger.warn(
      `[Phase5-ForkOrchestrator] ${label} child exited cleanly but no result received (IPC race)`,
      { exitCode: childResult.exitCode }
    );
  }
}

/**
 * Fork a child process, send init message, and wait for result.
 *
 * Handles:
 * - IPC message validation (Zod)
 * - Lock extension relay (on heartbeat/lock-request)
 * - Heartbeat timeout monitoring
 * - Overall timeout enforcement
 */
async function runChildProcess(opts: ChildRunOptions): Promise<ChildRunResult> {
  const { scriptPath, initMessage, timeoutMs, job, effectiveToken, effectiveLockDuration, label } =
    opts;

  const childEnv = buildChildEnv();
  const execArgv = buildChildExecArgv();

  const child: ChildProcess = fork(scriptPath, [], {
    execArgv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: childEnv,
    cwd: path.resolve(__dirname, "../.."),
  });

  // Pipe child stdout/stderr to parent logger
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.info(`[Phase5-${label}] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.warn(`[Phase5-${label}] ${line}`);
  });

  return new Promise<ChildRunResult>((resolve) => {
    let resultMessage: ChildToParentMessage | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    function cleanup(): void {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (overallTimer) clearTimeout(overallTimer);
      child.removeAllListeners();
    }

    function finish(exitedCleanly: boolean, exitCode: number | null): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ message: resultMessage, exitedCleanly, exitCode });
    }

    function resetHeartbeat(): void {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        logger.warn(
          `[Phase5-${label}] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms), killing child`
        );
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }

    // P0-2: IPC message handler with Zod validation
    child.on("message", (raw: unknown) => {
      const msg = validateChildMessage(raw);
      if (!msg) return; // Invalid message — logged by validator

      resetHeartbeat();

      switch (msg.type) {
        case "heartbeat":
          // Extend BullMQ lock on heartbeat (relay from child)
          extendJobLock(job, effectiveToken, effectiveLockDuration, `${label}-heartbeat`).catch(
            () => {
              /* lock extension failure is non-fatal in relay context */
            }
          );
          break;

        case "lock-request":
          extendJobLock(job, effectiveToken, effectiveLockDuration, `${label}-${msg.label}`).then(
            () => sendToChild(child, { type: "lock-ack" as const, success: true }),
            () => sendToChild(child, { type: "lock-ack" as const, success: false })
          );
          break;

        case "progress":
          // Forward progress — could be used for BullMQ job.updateProgress
          break;

        case "text-result":
        case "visual-result":
          resultMessage = msg;
          break;

        case "error":
          logger.warn(`[Phase5-${label}] Child error: ${msg.message}`);
          resultMessage = msg;
          break;
      }
    });

    child.on("exit", (code, signal) => {
      // Fix: Use setImmediate to let pending IPC "message" events drain first.
      // Without this, removeAllListeners() in finish() kills the message listener
      // before the text-result/visual-result message is processed, causing silent
      // result loss (IPC race condition).
      setImmediate(() => {
        if (signal) {
          logger.warn(`[Phase5-${label}] Child killed by signal: ${signal}`);
          finish(false, null);
        } else {
          finish(code === 0, code);
        }
      });
    });

    child.on("error", (err) => {
      logger.warn(`[Phase5-${label}] Child process error: ${err.message}`);
      finish(false, null);
    });

    // Overall timeout
    overallTimer = setTimeout(() => {
      logger.warn(`[Phase5-${label}] Overall timeout (${timeoutMs}ms), killing child`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    // Start heartbeat monitoring
    resetHeartbeat();

    // Send init message to child
    sendToChild(child, initMessage);
  });
}

/**
 * Send an IPC message to child process (fire-and-forget).
 */
function sendToChild(child: ChildProcess, msg: ParentToChildMessage): void {
  try {
    if (child.connected) {
      child.send(msg);
    }
  } catch {
    // Child may have already exited
  }
}

// ============================================================================
// Public API: Fork Orchestrator
// ============================================================================

/**
 * Run Phase 5 embedding via fork() child processes.
 *
 * Executes two sequential child processes:
 * 1. Text Embedding child — generates all text embeddings
 * 2. Visual Embedding child — generates DINOv2 visual embeddings
 *
 * resolvePartBoundingBoxes() is called in the parent before visual child
 * because it requires the sharedBrowser (Playwright instance) which cannot
 * be serialized across process boundaries.
 *
 * @returns Aggregated EmbeddingPhaseResult from both child processes
 */
export async function runPhase5ViaFork(
  params: EmbeddingPhaseParams,
  deps: {
    resolvePartBboxFn: () => Promise<void>;
    dinov2ModelPath: string;
  }
): Promise<EmbeddingPhaseResult> {
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
  } = params;

  // ====================================================================
  // Step 1: Text Embedding Child
  // ====================================================================
  const textScriptPath = resolveChildScriptPath("phase-5-text-embedding-child.js");

  const textInitMsg: ParentToChildMessage = {
    type: "init-text",
    webPageId,
    url,
    sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
    motionIdMapping: serializeIdMapping(motionSaveResult?.idMapping),
    jsIdMapping: serializeIdMapping(jsSaveResult?.idMapping),
    bgIds: bgSaveResult?.ids ?? null,
    scrollVisionIdMapping: serializeIdMapping(scrollVisionSaveResult?.idMapping),
    layoutResultJson: layoutResultForNarrative ? JSON.stringify(layoutResultForNarrative) : null,
    motionResultJson: motionResultForEmbedding ? JSON.stringify(motionResultForEmbedding) : null,
    jsAnimationsJson: jsAnimationsForEmbedding ? JSON.stringify(jsAnimationsForEmbedding) : null,
    scrollVisionResultJson: scrollVisionResultForEmbedding
      ? JSON.stringify(scrollVisionResultForEmbedding)
      : null,
    responsiveAnalysisId,
    partsSavedCount: partsSavedCount ?? 0,
  };

  try {
    const textResult = await runChildProcess({
      scriptPath: textScriptPath,
      initMessage: textInitMsg,
      timeoutMs: TEXT_CHILD_TIMEOUT_MS,
      job,
      effectiveToken,
      effectiveLockDuration,
      label: "text",
    });

    mergeChildResult(textResult, "text-result", "Text", result, (msg) => {
      if (msg.type !== "text-result") return;
      result.sectionEmbeddingsGenerated = msg.sectionEmbeddingsGenerated;
      result.motionEmbeddingsGenerated = msg.motionEmbeddingsGenerated;
      result.bgEmbeddingsGenerated = msg.bgEmbeddingsGenerated;
      result.jsAnimationEmbeddingsGenerated = msg.jsAnimationEmbeddingsGenerated;
      result.responsiveEmbeddingsGenerated = msg.responsiveEmbeddingsGenerated;
      result.partEmbeddingsGenerated = msg.partEmbeddingsGenerated;
      result.embeddingFailedChunks += msg.embeddingFailedChunks;
    });
  } catch (textError) {
    result.embeddingFailedChunks++;
    logger.warn("[Phase5-ForkOrchestrator] Text child fork failed", {
      error: sanitizeErrorMessage(textError),
    });
  }

  // ====================================================================
  // Step 2: Resolve Part Bounding Boxes (parent — requires sharedBrowser)
  // ====================================================================
  const hasParts = (partsSavedCount ?? 0) > 0;
  if (hasParts) {
    try {
      await deps.resolvePartBboxFn();
    } catch (bboxError) {
      logger.warn("[Phase5-ForkOrchestrator] Part bbox resolution failed (non-fatal)", {
        error: bboxError instanceof Error ? bboxError.message : String(bboxError),
      });
    }
  }

  // ====================================================================
  // Step 3: Visual Embedding Child
  // ====================================================================
  const hasSections = (sectionSaveResult?.idMapping?.size ?? 0) > 0;
  const hasScreenshot = !!screenshotPngPath && fs.existsSync(screenshotPngPath);

  if (hasScreenshot && (hasSections || hasParts)) {
    const visualScriptPath = resolveChildScriptPath("phase-5-visual-embedding-child.js");
    const fallbackEnabled =
      (process.env["ENABLE_SECTION_SCREENSHOT_FALLBACK"] ?? "true") === "true";

    const visualInitMsg: ParentToChildMessage = {
      type: "init-visual",
      webPageId,
      url,
      screenshotPngPath: screenshotPngPath!,
      sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
      partsSavedCount: partsSavedCount ?? 0,
      layoutResultJson: layoutResultForNarrative ? JSON.stringify(layoutResultForNarrative) : null,
      viewportWidth: job.data.options?.layoutOptions?.viewport?.width,
      viewportHeight: job.data.options?.layoutOptions?.viewport?.height,
      fallbackEnabled,
      dinov2ModelPath: deps.dinov2ModelPath,
    };

    try {
      const visualResult = await runChildProcess({
        scriptPath: visualScriptPath,
        initMessage: visualInitMsg,
        timeoutMs: VISUAL_CHILD_TIMEOUT_MS,
        job,
        effectiveToken,
        effectiveLockDuration,
        label: "visual",
      });

      mergeChildResult(visualResult, "visual-result", "Visual", result, (msg) => {
        if (msg.type !== "visual-result") return;
        result.sectionVisualEmbeddingsGenerated = msg.sectionVisualEmbeddingsGenerated;
        result.partVisualEmbeddingsGenerated = msg.partVisualEmbeddingsGenerated;
        result.embeddingFailedChunks += msg.embeddingFailedChunks;
      });
    } catch (visualError) {
      result.embeddingFailedChunks++;
      logger.warn("[Phase5-ForkOrchestrator] Visual child fork failed", {
        error: sanitizeErrorMessage(visualError),
      });
    }
  }

  // P1-17: Secondary tmp file cleanup (parent verifies after child exit)
  cleanupTmpDir(screenshotPngPath);

  result.completed =
    result.embeddingFailedChunks === 0 ||
    result.sectionEmbeddingsGenerated > 0 ||
    result.motionEmbeddingsGenerated > 0;

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve child process script path from dist/ directory.
 */
function resolveChildScriptPath(filename: string): string {
  // __dirname in built code: apps/mcp-server/dist/workers/phases/
  return path.resolve(__dirname, filename);
}

/**
 * P1-17: Secondary cleanup — remove tmp dir if child didn't clean up.
 */
function cleanupTmpDir(screenshotPngPath: string | undefined): void {
  if (!screenshotPngPath) return;
  try {
    const tmpDir = path.dirname(screenshotPngPath);
    if (fs.existsSync(tmpDir) && tmpDir.includes("reftrix-phase5")) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // Cleanup failure is non-fatal
  }
}
