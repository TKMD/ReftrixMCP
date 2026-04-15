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
import v8 from "node:v8";
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
  CHILD_RSS_KILL_DELTA_MB,
} from "./phase-5-child-ipc";
import type { EmbeddingPhaseParams, EmbeddingPhaseResult, EmbeddingSkipReason } from "./types";
import { extendJobLock, truncateSkipDetail } from "./types";
import { cleanupPhase5TempDir } from "./phase-5-raw-decode";

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

/**
 * Observability flag for RSS heartbeat logging (v0.4.0 PR3 / TPA #2).
 *
 * When `PHASE5_RSS_DEBUG=true`, heartbeat lines (absolute RSS + delta RSS)
 * are emitted at `logger.info` level so operators can watch delta growth in
 * production dashboards during the initial rollout of delta-based monitoring.
 * Default `false` keeps the log at `logger.debug` (invisible in production).
 *
 * PHASE5_RSS_DEBUG=true の場合、heartbeat ログ (絶対値 RSS + delta RSS) を
 * logger.info レベルで出力する。delta ベース監視の運用初期に本番環境で
 * delta の挙動を監視するために使用する。デフォルトは false で logger.debug
 * レベル (本番では不可視)。
 */
const PHASE5_RSS_DEBUG = process.env.PHASE5_RSS_DEBUG === "true";

/** Minimum V8 heap headroom (bytes) required to proceed with fork.
 *  If remaining heap is below this threshold, fork is skipped to avoid OOM during
 *  JSON.stringify of large layout/motion/vision results. */
const MIN_HEAP_HEADROOM_BYTES = 512 * 1024 * 1024; // 512 MB

/** Minimum system MemAvailable (bytes) required to proceed with fork (OOM-FIX-4).
 *  Checked via /proc/meminfo. If system-wide free memory is too low, fork is
 *  skipped to prevent OOM Killer from targeting the worker process tree. */
const MIN_SYSTEM_MEM_AVAILABLE_BYTES =
  safeParseInt(process.env.PHASE5_MIN_FREE_MEMORY_MB, 8192, { min: 1024, max: 65536 }) *
  1024 *
  1024;

// ============================================================================
// System Memory Check (OOM-FIX-4)
// ============================================================================

/**
 * Read MemAvailable from /proc/meminfo (Linux only).
 * Returns available memory in bytes, or null if unavailable.
 */
function getSystemMemAvailable(): number | null {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match?.[1]) {
      return parseInt(match[1], 10) * 1024; // kB → bytes
    }
  } catch {
    // Non-Linux or /proc not available
  }
  return null;
}

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

  // OOM-1: glibc malloc arena 断片化を防止（子プロセスにも適用）
  // OOM-1: Prevent glibc malloc arena fragmentation in child processes too
  if (!baseEnv.MALLOC_ARENA_MAX) {
    baseEnv.MALLOC_ARENA_MAX = "2";
  }

  return baseEnv;
}

/** Max V8 heap for fork child processes (OOM-FIX-3).
 *  Children are short-lived ONNX inference processes — 4GB is sufficient.
 *  Parent keeps the full profile.maxOldSpaceSizeMb (8192 on 64GB+). */
const CHILD_MAX_OLD_SPACE_MB = 4096;

/**
 * Build execArgv for child process fork (P1-12, OOM-FIX-3).
 */
function buildChildExecArgv(): string[] {
  const profile = computeMemoryProfile();
  const childHeapMb = Math.min(profile.maxOldSpaceSizeMb, CHILD_MAX_OLD_SPACE_MB);
  return [`--max-old-space-size=${childHeapMb}`, "--expose-gc"];
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
 * Skip reason triple for a given child process channel (text/visual).
 * Maps the 3 failure branches of {@link mergeChildResult} onto
 * {@link EmbeddingSkipReason} enum values.
 *
 * チャネル（text/visual）ごとのスキップ理由3点セット。mergeChildResult の
 * 3 つの失敗分岐を {@link EmbeddingSkipReason} enum にマップする。
 */
interface ChannelSkipReasons {
  error: EmbeddingSkipReason;
  abnormalExit: EmbeddingSkipReason;
  ipcRace: EmbeddingSkipReason;
}

/**
 * Text child channel の skipReason マッピング
 * Skip reason mapping for the text-embedding child channel.
 */
const TEXT_CHANNEL_REASONS: ChannelSkipReasons = {
  error: "text_child_error",
  abnormalExit: "text_child_abnormal_exit",
  ipcRace: "text_ipc_race",
};

/**
 * Visual child channel の skipReason マッピング
 * Skip reason mapping for the visual-embedding child channel.
 */
const VISUAL_CHANNEL_REASONS: ChannelSkipReasons = {
  error: "visual_child_error",
  abnormalExit: "visual_child_abnormal_exit",
  ipcRace: "visual_ipc_race",
};

/**
 * Set {@link EmbeddingPhaseResult.skipReason} only if not already set.
 *
 * `skipReason` は「最初に発火した理由」を優先する（例: text child error の
 * 後に visual child abnormal exit が続いても text の理由を保持）。これにより
 * debug.log の可観測性が一貫する。
 *
 * Records the **first** reason that fires. For example, a text-child error
 * followed by a visual abnormal-exit keeps the text reason so that debug logs
 * remain consistent.
 */
function setSkipReasonIfUnset(
  result: EmbeddingPhaseResult,
  reason: EmbeddingSkipReason,
  detail?: string
): void {
  if (result.skipReason === undefined) {
    result.skipReason = reason;
    if (detail !== undefined) {
      // LCC 推奨 (v0.4.0 PR2 監査): PII / stack trace / URL が skipDetail に
      // 混入しても 200 文字で打ち切り、DB / ログ / MCP レスポンスへの漏洩を
      // 最小化する。
      // LCC recommendation (v0.4.0 PR2 audit): guard against PII / stack
      // trace / URL that may reach skipDetail by truncating to 200 chars,
      // minimizing leakage to DB / logs / MCP responses.
      result.skipDetail = truncateSkipDetail(detail);
    }
  }
}

/**
 * Merge child process result into aggregated EmbeddingPhaseResult.
 *
 * Handles the 3-branch pattern (success / error / abnormal-exit / IPC race)
 * that is common to both text and visual child processes. (TDA HIGH-2)
 *
 * PR2 (v0.4.0): On every failure branch, {@link EmbeddingPhaseResult.skipReason}
 * is populated using the channel-specific triple {@link ChannelSkipReasons}.
 *
 * PR2 (v0.4.0): 失敗分岐では必ず {@link EmbeddingPhaseResult.skipReason} を
 * チャネル固有のトリプル {@link ChannelSkipReasons} を使って設定する。
 */
function mergeChildResult(
  childResult: ChildRunResult,
  expectedType: string,
  label: string,
  channelReasons: ChannelSkipReasons,
  result: EmbeddingPhaseResult,
  mergeFn: (msg: ChildToParentMessage) => void
): void {
  if (childResult.message?.type === expectedType) {
    mergeFn(childResult.message);
  } else if (childResult.message?.type === "error") {
    result.embeddingFailedChunks++;
    // PII-safe: message は child が sanitizeErrorMessage で整形済み
    // PII-safe: message already sanitized by the child via sanitizeErrorMessage
    const detail = childResult.message.message;
    setSkipReasonIfUnset(result, channelReasons.error, detail);
    logger.warn(`[Phase5-ForkOrchestrator] ${label} child returned error`, {
      error: detail,
    });
  } else if (!childResult.exitedCleanly) {
    result.embeddingFailedChunks++;
    const detail = `exitCode=${childResult.exitCode ?? "signal"}`;
    setSkipReasonIfUnset(result, channelReasons.abnormalExit, detail);
    logger.warn(`[Phase5-ForkOrchestrator] ${label} child exited abnormally`, {
      exitCode: childResult.exitCode,
    });
  } else {
    // Fix: Detect IPC race condition — child exited cleanly (code 0) but
    // no result message was received. This happens when the "exit" event
    // fires before the "message" event in the parent's event loop.
    result.embeddingFailedChunks++;
    setSkipReasonIfUnset(result, channelReasons.ipcRace, `exitCode=${childResult.exitCode ?? 0}`);
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
    // TPA improvement #1: Prevent double SIGKILL from parent-side RSS kill switch.
    // Heartbeats arrive every 10s; without this flag, a single RSS breach would
    // log and SIGKILL on every subsequent heartbeat until the child exits.
    let killedByRssSwitch = false;

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
          // v0.4.0 PR3: Parent-side RSS kill switch now operates on `rssDeltaMb`
          // (child's currentRss - initialRss). Absolute-value thresholds were
          // removed because fork() Copy-on-Write causes the child to inherit
          // the parent's RSS, producing false positives (Stripe bug: parent
          // RSS 4610MB → child ONNX load tripped absolute 5120MB threshold
          // at delta ~500MB, yielding 0 embeddings).
          //
          // v0.4.0 PR3: 親側 RSS kill switch は delta ベース
          // (rssDeltaMb = 子の currentRss - initialRss) で動作する。
          // 絶対値閾値は fork() COW により親の RSS を継承するため偽陽性を
          // 生む (Stripe バグ: 親 RSS 4610MB → 子 ONNX ロードで delta ~500MB
          // でも絶対値 5120MB を超過し 0 件生成)。
          //
          // killedByRssSwitch flag prevents duplicate SIGKILL / log spam when
          // multiple heartbeats arrive before the child actually exits.
          if (msg.rssDeltaMb > CHILD_RSS_KILL_DELTA_MB) {
            if (!killedByRssSwitch) {
              killedByRssSwitch = true;
              logger.warn(
                `[Phase5-${label}] Child RSS delta ${msg.rssDeltaMb}MB exceeds kill ` +
                  `threshold ${CHILD_RSS_KILL_DELTA_MB}MB (currentRss=${msg.rssMb}MB), ` +
                  `sending SIGKILL`
              );
              try {
                child.kill("SIGKILL");
              } catch {
                /* already dead */
              }
            }
            break;
          }
          // Observability: record delta alongside absolute RSS so operators
          // can correlate child memory growth with phase-level metrics even
          // when no kill is triggered. The log level is gated by the
          // PHASE5_RSS_DEBUG env var — INFO during rollout (for visibility),
          // DEBUG in steady-state (to avoid log spam).
          // 可観測性: kill に至らない場合も delta を絶対値と並べてログする。
          // PHASE5_RSS_DEBUG=true の場合は INFO レベル、false の場合は DEBUG。
          if (PHASE5_RSS_DEBUG) {
            logger.info(
              `[Phase5-${label}] heartbeat rssMb=${msg.rssMb} rssDeltaMb=${msg.rssDeltaMb}`
            );
          } else {
            logger.debug(
              `[Phase5-${label}] heartbeat rssMb=${msg.rssMb} rssDeltaMb=${msg.rssDeltaMb}`
            );
          }
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
// v0.4.0 PR7c: IPhase5ScreenshotPersistence 依存を削除
//   - 削除責務は PR6 の TTL cron (`scheduleScreenshotCleanupCron`, 7d) に一本化。
//   - GDPR 削除経路は引き続き `service-registrar-search.ts` 経由で
//     `ScreenshotPersistenceService.deleteScreenshot()` を使用するため、
//     `screenshot-persistence.types.ts` の型定義自体は保持する。
// v0.4.0 PR7c: Removed IPhase5ScreenshotPersistence dependency
//   - Deletion responsibility is consolidated into PR6's TTL cron
//     (`scheduleScreenshotCleanupCron`, 7d).
//   - GDPR deletion still uses `ScreenshotPersistenceService.deleteScreenshot()`
//     via `service-registrar-search.ts`, so the type definition itself is retained.

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
    partsLimit,
    screenshotPngPath,
  } = params;

  // ====================================================================
  // Pre-fork memory measurement (修正5: fork前メモリ計測ログ)
  // Log RSS/heapUsed/external/arrayBuffers before fork to aid OOM diagnosis.
  // ====================================================================
  {
    const mem = process.memoryUsage();
    logger.info("[Phase5-ForkOrchestrator] Pre-fork memory snapshot", {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
      arrayBuffersMb: Math.round(mem.arrayBuffers / 1024 / 1024),
    });
  }

  // ====================================================================
  // V8 heap headroom check (修正2: fork前V8ヒープ事前チェック)
  // JSON.stringify of large layout/motion/vision results can spike heap usage.
  // If remaining heap < 512MB, skip fork to avoid parent OOM.
  //
  // PR2 (v0.4.0): skipReason='v8_heap_headroom_low' を必ず設定する。
  // PR2 (v0.4.0): Always sets skipReason='v8_heap_headroom_low'.
  // ====================================================================
  {
    const heapStats = v8.getHeapStatistics();
    const heapRemaining = heapStats.heap_size_limit - heapStats.used_heap_size;
    if (heapRemaining < MIN_HEAP_HEADROOM_BYTES) {
      const heapRemainingMb = Math.round(heapRemaining / 1024 / 1024);
      const thresholdMb = Math.round(MIN_HEAP_HEADROOM_BYTES / 1024 / 1024);
      logger.warn("[Phase5-ForkOrchestrator] Insufficient V8 heap headroom, skipping fork", {
        heapRemainingMb,
        heapLimitMb: Math.round(heapStats.heap_size_limit / 1024 / 1024),
        usedHeapMb: Math.round(heapStats.used_heap_size / 1024 / 1024),
        thresholdMb,
      });
      result.embeddingFailedChunks++;
      setSkipReasonIfUnset(
        result,
        "v8_heap_headroom_low",
        `heapRemaining=${heapRemainingMb}MB < ${thresholdMb}MB`
      );
      return result;
    }
  }

  // ====================================================================
  // System MemAvailable check (OOM-FIX-4)
  // If system-wide available memory is below threshold, skip fork to
  // prevent OOM Killer from targeting the worker process tree.
  //
  // PR2 (v0.4.0): skipReason='system_memavailable_low' を必ず設定する。
  // PR2 (v0.4.0): Always sets skipReason='system_memavailable_low'.
  // ====================================================================
  {
    const memAvailable = getSystemMemAvailable();
    if (memAvailable !== null && memAvailable < MIN_SYSTEM_MEM_AVAILABLE_BYTES) {
      const memAvailableMb = Math.round(memAvailable / 1024 / 1024);
      const thresholdMb = Math.round(MIN_SYSTEM_MEM_AVAILABLE_BYTES / 1024 / 1024);
      logger.warn("[Phase5-ForkOrchestrator] Insufficient system memory, skipping fork", {
        memAvailableMb,
        thresholdMb,
      });
      result.embeddingFailedChunks++;
      setSkipReasonIfUnset(
        result,
        "system_memavailable_low",
        `memAvailable=${memAvailableMb}MB < ${thresholdMb}MB`
      );
      return result;
    }
  }

  // ====================================================================
  // Step 1: Text Embedding Child
  // ====================================================================
  const textScriptPath = resolveChildScriptPath("phase-5-text-embedding-child.js");

  // OOM-FIX-2: Use `let` for JSON strings so they can be null-ed after IPC send.
  // Sequential JSON.stringify with optional GC between serializations
  // to reduce peak heap pressure during IPC message construction.
  let layoutResultJson = layoutResultForNarrative ? JSON.stringify(layoutResultForNarrative) : null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  let motionResultJson = motionResultForEmbedding ? JSON.stringify(motionResultForEmbedding) : null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  let jsAnimationsJson = jsAnimationsForEmbedding ? JSON.stringify(jsAnimationsForEmbedding) : null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  let scrollVisionResultJson = scrollVisionResultForEmbedding
    ? JSON.stringify(scrollVisionResultForEmbedding)
    : null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  let textInitMsg: ParentToChildMessage | null = {
    type: "init-text",
    webPageId,
    url,
    sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
    motionIdMapping: serializeIdMapping(motionSaveResult?.idMapping),
    jsIdMapping: serializeIdMapping(jsSaveResult?.idMapping),
    bgIds: bgSaveResult?.ids ?? null,
    scrollVisionIdMapping: serializeIdMapping(scrollVisionSaveResult?.idMapping),
    layoutResultJson,
    motionResultJson,
    jsAnimationsJson,
    scrollVisionResultJson,
    responsiveAnalysisId,
    partsSavedCount: partsSavedCount ?? 0,
    // v0.4.0 PR4: Part text embedding 同期フェーズ上限を text child へ伝搬
    // v0.4.0 PR4: propagate sync-phase Part text embedding cap to text child
    ...(partsLimit !== undefined ? { partsLimit } : {}),
  };

  // OOM-FIX-2: Release JSON strings immediately — they are now owned by textInitMsg
  layoutResultJson = null;
  motionResultJson = null;
  jsAnimationsJson = null;
  scrollVisionResultJson = null;

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

    mergeChildResult(textResult, "text-result", "Text", TEXT_CHANNEL_REASONS, result, (msg) => {
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
    const detail = sanitizeErrorMessage(textError);
    // PR2 (v0.4.0): fork 自体が例外を投げた場合の skipReason
    // PR2 (v0.4.0): skipReason when fork() itself threw
    setSkipReasonIfUnset(result, "text_fork_failed", detail);
    logger.warn("[Phase5-ForkOrchestrator] Text child fork failed", {
      error: detail,
    });
  }

  // OOM-FIX-2: Release textInitMsg after text child completes — frees IPC JSON data
  textInitMsg = null;
  if (typeof globalThis.gc === "function") globalThis.gc();

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

    // OOM-FIX-2: Stringify only for visual child init (after text child freed).
    // This avoids holding 2 copies of layoutResultJson simultaneously.
    const visualLayoutJson = layoutResultForNarrative
      ? JSON.stringify(layoutResultForNarrative)
      : null;

    // OOM-FIX: Release original object reference after JSON serialization.
    // Visual child receives JSON string only; original object is no longer needed.
    (params as unknown as Record<string, unknown>).layoutResultForNarrative = null;
    if (typeof globalThis.gc === "function") globalThis.gc();

    const visualInitMsg: ParentToChildMessage = {
      type: "init-visual",
      webPageId,
      url,
      screenshotPngPath: screenshotPngPath!,
      sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
      partsSavedCount: partsSavedCount ?? 0,
      // v0.4.0 PR4: Part visual embedding 同期フェーズ上限を visual child へ伝搬
      // v0.4.0 PR4: propagate sync-phase Part visual embedding cap to visual child
      ...(partsLimit !== undefined ? { partsLimit } : {}),
      layoutResultJson: visualLayoutJson,
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

      mergeChildResult(
        visualResult,
        "visual-result",
        "Visual",
        VISUAL_CHANNEL_REASONS,
        result,
        (msg) => {
          if (msg.type !== "visual-result") return;
          result.sectionVisualEmbeddingsGenerated = msg.sectionVisualEmbeddingsGenerated;
          result.partVisualEmbeddingsGenerated = msg.partVisualEmbeddingsGenerated;
          result.embeddingFailedChunks += msg.embeddingFailedChunks;
        }
      );
    } catch (visualError) {
      result.embeddingFailedChunks++;
      const detail = sanitizeErrorMessage(visualError);
      // PR2 (v0.4.0): fork 自体が例外を投げた場合の skipReason
      // PR2 (v0.4.0): skipReason when fork() itself threw
      setSkipReasonIfUnset(result, "visual_fork_failed", detail);
      logger.warn("[Phase5-ForkOrchestrator] Visual child fork failed", {
        error: detail,
      });
    }
  }

  // P1-17: Secondary cleanup — remove RAW decode tmp dir only (parent verifies after child exit)
  // v0.4.0 PR7d-1 (ADR-0010): cleanupPhase5TmpDirOnly() was removed and folded
  //   into `cleanupPhase5TempDir` (phase-5-raw-decode.ts) which now carries a
  //   3-stage whitelist defense (realpath + os.tmpdir() containment + prefix
  //   whitelist). `screenshotPngPath` may be undefined (e.g. WebGL sites that
  //   skipped the screenshot); guard accordingly. The persisted PNG is still
  //   retained and reaped exclusively by (a) PR6 TTL cron (7d) and
  //   (b) GDPR `data.delete` (Art. 17). See ADR-0009 + ADR-0010 + DATA_RETENTION.md §9.
  // v0.4.0 PR7d-1 (ADR-0010): `cleanupPhase5TmpDirOnly()` has been removed and
  //   delegates to `cleanupPhase5TempDir` (phase-5-raw-decode.ts) which enforces
  //   a 3-stage whitelist (realpath + os.tmpdir() containment + `reftrix-phase5-raw-`
  //   prefix). Persisted PNG deletion remains consolidated into (a) PR6 TTL cron
  //   (7d) and (b) GDPR `data.delete` (Art. 17).
  if (screenshotPngPath) {
    cleanupPhase5TempDir(path.dirname(screenshotPngPath));
  }
  void webPageId; // webPageId is retained for GDPR audit logs elsewhere; no longer used for cleanup here

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

// v0.4.0 PR7d-1 (ADR-0010): `cleanupPhase5TmpDirOnly()` was removed. Cleanup
//   is delegated to `cleanupPhase5TempDir` in `./phase-5-raw-decode.ts`, which
//   provides a 3-stage whitelist defense (realpath + os.tmpdir() containment +
//   `reftrix-phase5-raw-` prefix). See ADR-0010 for rationale.
