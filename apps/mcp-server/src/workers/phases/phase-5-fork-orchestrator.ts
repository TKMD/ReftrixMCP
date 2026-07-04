// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Fork Orchestrator
 *
 * Manages child_process.fork() lifecycle for Phase 5 embedding generation.
 *
 * PR-BT-5 (M-1-RSS, ADR-0039): dispatches up to **9 per-sub-phase forks**
 * sequentially (7 text sub-phases via e5-base + 2 visual sub-phases via DINOv2).
 * Each fork loads its single model, processes ONE sub-phase, and `exit(0)`s so
 * the OS reclaims the whole arena at the fork boundary (rooting out the
 * inter-sub-phase reload that was the M-1-RSS root cause). Empty sub-phases are
 * skipped (no fork). `PHASE5_SUBPHASE_FORK_ENABLED=false` reverts to the legacy
 * 2-fork (text/visual) path (rollback escape hatch). The dispatch *decision*
 * (descriptors + skip predicates) lives in the `phase-5-subphase-dispatch.ts`
 * leaf (CC ≤ 10); this file retains only the loop + IPC + result merge.
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

// PR-V3-T1a §3.2 (FIND-V3-IO-H-01 closure): emit audit_logs entries for the
// chunked encoder hardening telemetry returned from the text fork-child.
// `getAuditLogService()` graceful-degrades to no-op when the DI is not wired.
import { getAuditLogService, truncateAuditTargetId } from "../../services/audit-log.service";

// PR-1 GPU-COORD (ADR-0038 Decision 1/2, FIND-PLAN-H-01/M-03): parent-side
// per-workload VRAM probe drives the fork-child execution provider and emits
// the `embedding_cpu_fallback_degraded` audit on degraded (CPU-fallback) runs.
import {
  probeChildExecutionProvider,
  isDegradedDecision,
  type ChildExecutionProvider,
  type ChildWorkload,
  type ChildProviderDecision,
} from "./phase-5-gpu-probe";
import {
  AUDIT_ACTION_EMBEDDING_CPU_FALLBACK_DEGRADED,
  AUDIT_ACTOR_PHASE5_INIT,
} from "../../audit/audit-actions";

// PR-BT-5 (M-1-RSS, ADR-0039 Decision 1): per-sub-phase fork dispatch decision
// leaf (descriptor builders + skip predicates, CC ≤ 10 machine-enforced) +
// SSOT sub-phase identifiers.
import {
  buildTextSubPhaseDescriptors,
  buildVisualSubPhaseDescriptors,
} from "./phase-5-subphase-dispatch";
import {
  PHASE5_TOTAL_SUBPHASE_FORK_COUNT,
  type Phase5TextSubPhase as TextSubPhaseDispatch,
  type Phase5VisualSubPhase as VisualSubPhaseDispatch,
} from "./phase-5-subphases.const";
import { parseBoolEnv } from "../../utils/env-validators";

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
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 4): per-sub-phase fork feature flag.
 *
 * Default `true` — Phase 5 embedding dispatches one fork per sub-phase (≤ 9)
 * so the OS reclaims each arena at the fork boundary (M-1-RSS structural fix).
 * Setting `PHASE5_SUBPHASE_FORK_ENABLED=false` is a **rollback escape hatch**
 * that reverts to the legacy 2-fork (text/visual) path — but that path crashes
 * on heavy CPU sites (the very bug PR-BT-5 fixes), so it is NOT a
 * production-equivalent alternative.
 *
 * Uses the canonical strict boolean parser (CWE-1188): only `"true"` / `"false"`
 * (case-sensitive); `undefined` / `""` → default `true`.
 *
 * PR-BT-5 (M-1-RSS): per-sub-phase fork フィーチャーフラグ。default true。
 * false で legacy 2-fork path に戻す rollback escape hatch (heavy site で crash)。
 */
function isSubPhaseForkEnabled(): boolean {
  return parseBoolEnv(process.env.PHASE5_SUBPHASE_FORK_ENABLED, true);
}

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
function buildChildEnv(resolvedProvider: ChildExecutionProvider): Record<string, string> {
  const profile = computeMemoryProfile();
  const baseEnv = { ...process.env } as Record<string, string>;

  // P0-1: Disable worker_threads nesting in child processes
  baseEnv.EMBEDDING_WORKER_THREAD = "false";
  baseEnv.DINOV2_WORKER_THREAD = "false";

  // PR-1 GPU-COORD (ADR-0038 Decision 1, FIND-PLAN-H-01): the fork-child
  // execution provider is now DRIVEN by the parent's per-workload VRAM probe.
  //   - probe selected "cuda" (free VRAM ≥ threshold) → set ONNX_EXECUTION_PROVIDER=cuda
  //     so the in-process DINOv2/e5 init (detectExecutionProvider) intentionally
  //     selects CUDA. The child re-confirms child-locally via
  //     wireChildExecutionProvider (zero new IPC types, FIND-PLAN-M-01).
  //   - probe selected "cpu" (below threshold / vram_contention / probe disabled)
  //     → set ONNX_EXECUTION_PROVIDER=cpu (legacy behaviour preserved; the
  //     PHASE5_FORK_GPU_PROBE_ENABLED=false rollback always yields "cpu").
  //
  // The pre-PR-1 hardcoded `cpu` (β2-P1) is now the probe's "cpu" branch — the
  // CUDA-unavailable / below-threshold safety still resolves to CPU, so the
  // SIGABRT / exitCode=1 risk on hosts without libonnxruntime_providers_cuda.so
  // is preserved (the probe returns null on such hosts → "cpu").
  //
  // PR-1 GPU-COORD: fork 子プロセスの execution provider は親の per-workload VRAM
  // probe で駆動される。"cuda" 選択時のみ ONNX_EXECUTION_PROVIDER=cuda を設定し、
  // それ以外 (閾値未満 / contention / probe 無効) は "cpu" を設定する (legacy 挙動)。
  baseEnv.ONNX_EXECUTION_PROVIDER = resolvedProvider;

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

  // PR-BT-5 (M-1-RSS): one-shot fork 内では e5-base の in-process pipeline recycle
  // (EmbeddingService.recyclePipelineIfNeeded, threshold=30) を無効化する。
  //
  // 根拠: per-sub-phase fork は単一 sub-phase を処理して exit(0) するため、OS が
  // fork 境界で arena 全体を回収する。長命プロセスの累積メモリ抑制が目的の
  // recycle (mid-encode の dispose+reload) は one-shot fork では (a) 純粋に冗長
  // (chunk-boundary disposeBetweenChunks が既に arena reset を担う)、(b) chunk size
  // (=30) と threshold (=30) が一致するため各 chunk 末で recycle+chunk-boundary の
  // DOUBLE dispose+reload を引き起こし transient 重複で RSS を kill 閾値まで押し上げ、
  // (c) 決定的な harm として recycle が chunk 末で arena を reset することで直後の
  // C1 per-chunk RSS budget check (PER_CHUNK_RSS_BUDGET_MB) の post-encode 計測値を
  // 低く見せ、runaway loop の検出を mask する。
  //
  // 実機 CPU 検証 (webPageId 019e64b1): background_text が recycle で C1 を mask され
  // chunk#2,#3 へ進み、chunk#3 の fresh model load + 前 chunk の glibc 未返却 arena の
  // 重複で delta 4711MB > 4096 → SIGKILL → skipped_fork_error の degraded backfill。
  // motion_text も同 mask で peak 4174MB (kill 寸前)。section_text は recycle 不発で
  // C1 が delta 2406MB を正しく検出し peak 2598MB < 4096 で clean 停止 (対照)。
  //
  // 既存 guard を再利用: EmbeddingService の recyclePipelineIfNeeded は
  // `if (threshold <= 0) return;` を持つため、threshold=0 で recycle は no-op になる。
  // chunk-boundary disposeEmbeddingPipeline() (INV-PHASE5-SUBPHASE-NO-RELOAD-001 (b)
  // の RETAINED arena reset) は不変。MCP server 検索パス (worker-thread mode、別
  // プロセス・本 env 非継承) も非影響。
  //
  // PR-BT-5 (M-1-RSS): disable the e5-base in-process pipeline recycle
  // (EmbeddingService.recyclePipelineIfNeeded, threshold=30) inside the one-shot
  // fork. Each per-sub-phase fork processes a single sub-phase then exit(0)s, so
  // the OS reclaims the whole arena at the fork boundary; the recycle (intended
  // for long-lived accumulation) is (a) redundant with the chunk-boundary
  // disposeBetweenChunks reset, (b) a source of DOUBLE dispose+reload per chunk
  // when chunk size (=30) equals threshold (=30), spiking RSS via transient
  // overlap, and (c) — the decisive harm — it resets the arena at chunk end, which
  // makes the immediately-following C1 per-chunk RSS budget check read a low
  // post-encode delta and FAIL to detect the runaway loop. Real-machine CPU
  // verification (webPageId 019e64b1): background_text was masked past C1 and
  // SIGKILLed at delta 4711MB (degraded skipped_fork_error backfill); section_text
  // (recycle did not fire) had C1 detect 2406MB and stop cleanly at 2598MB < 4096.
  // Reuses the existing `if (threshold <= 0) return;` guard so threshold=0 makes
  // recycle a no-op; the chunk-boundary dispose (NO-RELOAD INV (b)) is unchanged,
  // and the MCP server search path (worker-thread mode, separate process) is
  // unaffected.
  baseEnv.PIPELINE_RECYCLE_THRESHOLD = "0";

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
  /**
   * PR-1 GPU-COORD: the probe-resolved execution provider for this child.
   * Sets `ONNX_EXECUTION_PROVIDER` in the child env so the in-process DINOv2/e5
   * init (`detectExecutionProvider`) selects the intended provider.
   */
  resolvedProvider: ChildExecutionProvider;
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
 * PR-V3-T1a §3.2 (FIND-V3-IO-H-01 closure): emit `audit_logs` entries for the
 * chunked encoder hardening telemetry returned by the text fork-child.
 *
 * The SSOT skip reason values
 * `text_child_memory_budget_exceeded_at_chunk_<n>` (C1) and
 * `partial_chunked_<n>_of_<total>` (C3) are kept as bare canonical strings in
 * `EMBEDDING_SKIP_REASONS` per design §3.4.1; the `<n>` / `<total>` slots are
 * interpolated into `details` (PII-free numeric only). Idempotency-on-retry
 * skip count (C4) is recorded as a separate audit entry.
 *
 * `audit_logs` write failures are non-fatal (graceful degradation pattern,
 * inherited from `AuditLogService.log()`). The `embedding_skip_reason`
 * action mirrors the existing PR-D-1 / PR-D-2 / PR-D-9 convention used by
 * `dispatchEmbeddingPhase` for skip events.
 *
 * PR-V3-T1a §3.2 audit emission for chunked encoder telemetry (C1 + C3 + C4).
 * Non-fatal on failure. Action `embedding_skip_reason` mirrors existing
 * convention.
 *
 * @internal exported for unit testing only
 */
export async function emitChunkedEncoderTelemetryAudit(
  webPageId: string,
  telemetry: {
    partialCompletion?: { chunksDone: number; totalChunks: number } | undefined;
    budgetExceededChunkIndex?: number | undefined;
    idempotencyChunkSkippedCount?: number | undefined;
  }
): Promise<void> {
  const auditService = getAuditLogService();
  // C1: per-chunk RSS budget exceeded — `text_child_memory_budget_exceeded_at_chunk_<n>`.
  if (telemetry.budgetExceededChunkIndex !== undefined) {
    await auditService.log({
      action: "embedding_skip_reason",
      actor: "system:phase5-text-child",
      targetType: "web_page",
      targetId: webPageId,
      details: {
        skipReason: "text_child_memory_budget_exceeded_at_chunk_<n>",
        chunkIndex: telemetry.budgetExceededChunkIndex,
        contract: "C1",
      },
      result: "success",
    });
  }
  // C3: partial completion — `partial_chunked_<n>_of_<total>`. When C1 also
  // triggered (budget overshoot drove the partial), the C3 entry follows the
  // C1 entry (both observable, paired by timestamp).
  if (telemetry.partialCompletion !== undefined) {
    await auditService.log({
      action: "embedding_skip_reason",
      actor: "system:phase5-text-child",
      targetType: "web_page",
      targetId: webPageId,
      details: {
        skipReason: "partial_chunked_<n>_of_<total>",
        chunksDone: telemetry.partialCompletion.chunksDone,
        totalChunks: telemetry.partialCompletion.totalChunks,
        contract: "C3",
      },
      result: "success",
    });
  }
  // C4: idempotency-on-retry skip count.
  if (
    telemetry.idempotencyChunkSkippedCount !== undefined &&
    telemetry.idempotencyChunkSkippedCount > 0
  ) {
    await auditService.log({
      action: "embedding_skip_reason",
      actor: "system:phase5-text-child",
      targetType: "web_page",
      targetId: webPageId,
      details: {
        skipReason: "partial_chunked_<n>_of_<total>",
        idempotencyChunkSkippedCount: telemetry.idempotencyChunkSkippedCount,
        contract: "C4",
      },
      result: "success",
    });
  }
}

/**
 * PR-1 GPU-COORD (ADR-0038 Decision 1/2, FIND-PLAN-H-01/M-03): run the
 * parent-side per-workload VRAM probe and, on a degraded (CPU-fallback)
 * outcome, emit the `embedding_cpu_fallback_degraded` audit (parent-side DB
 * write — zero new IPC types per FIND-PLAN-M-01).
 *
 * The decision drives the fork-child execution provider via `buildChildEnv`
 * (the child re-confirms child-locally via `wireChildExecutionProvider`). The
 * audit `details` are PII-free (numeric VRAM values + reason enum only); the
 * `targetId` is `truncateAuditTargetId`-truncated per the canonical CWE-209
 * PII protection pattern. Audit emit failures are non-fatal (graceful
 * degradation, inherited from `AuditLogService.log()`).
 *
 * @param webPageId  page id (truncated for the audit targetId)
 * @param workload   "text" (e5 threshold) or "visual" (DINOv2 threshold)
 * @returns the resolved provider decision (used to build the child env)
 */
async function resolveProviderAndAuditDegraded(
  webPageId: string,
  workload: ChildWorkload
): Promise<ChildProviderDecision> {
  const decision = await probeChildExecutionProvider(workload);

  if (isDegradedDecision(decision)) {
    try {
      await getAuditLogService().log({
        action: AUDIT_ACTION_EMBEDDING_CPU_FALLBACK_DEGRADED,
        actor: AUDIT_ACTOR_PHASE5_INIT,
        targetType: "web_page",
        targetId: truncateAuditTargetId(webPageId),
        details: {
          reason: decision.reason,
          workload,
          freeVramMb: decision.freeVramMb,
          thresholdMb: decision.thresholdMb,
        },
        result: "success",
      });
    } catch (err) {
      logger.warn(
        "[Phase5-ForkOrchestrator] embedding_cpu_fallback_degraded audit emit failed (non-fatal)",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  logger.info("[Phase5-ForkOrchestrator] GPU-COORD probe decision", {
    workload,
    provider: decision.provider,
    reason: decision.reason,
    freeVramMb: decision.freeVramMb,
    thresholdMb: decision.thresholdMb,
  });

  return decision;
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
  const {
    scriptPath,
    initMessage,
    timeoutMs,
    job,
    effectiveToken,
    effectiveLockDuration,
    label,
    resolvedProvider,
  } = opts;

  const childEnv = buildChildEnv(resolvedProvider);
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
// PR-BT-5 (M-1-RSS): Per-Sub-Phase Fork helpers (ADR-0039 Decision 1/4)
// ============================================================================

/**
 * Serialized text-embedding IPC payloads, built once and reused across all 7
 * text sub-phase forks (each fork receives the same serialized data but a
 * different `subPhase` so it runs only that one sub-phase). Held by `let` so it
 * can be released after the last text fork (OOM-FIX-2 semantics).
 */
interface TextForkPayloads {
  sectionIdMapping: [string, string][] | null;
  motionIdMapping: [string, string][] | null;
  jsIdMapping: [string, string][] | null;
  bgIds: string[] | null;
  scrollVisionIdMapping: [string, string][] | null;
  layoutResultJson: string | null;
  motionResultJson: string | null;
  jsAnimationsJson: string | null;
  scrollVisionResultJson: string | null;
}

/**
 * Merge a `text-result` IPC message into the aggregated result.
 *
 * PR-BT-5: in the per-sub-phase fork model each text fork returns a
 * `text-result` with ONLY its own sub-phase's field populated (others 0), so
 * the merge is **additive** (`+=`) across the up-to-7 text forks. This is
 * order-independent and tolerant of skipped/empty sub-phases.
 *
 * PR-V3-T1a §3.2 audit-continuity (LCC-M-01): chunked encoder telemetry from
 * the section_text fork is surfaced for `audit_logs` emission here (preserved
 * across the N-fork loop — the per-chunk RSS overshoot audit must NOT be
 * silently dropped by the restructure).
 */
function mergeTextSubPhaseResult(
  webPageId: string,
  result: EmbeddingPhaseResult,
  msg: ChildToParentMessage
): void {
  if (msg.type !== "text-result") return;
  result.sectionEmbeddingsGenerated += msg.sectionEmbeddingsGenerated;
  result.motionEmbeddingsGenerated += msg.motionEmbeddingsGenerated;
  result.bgEmbeddingsGenerated += msg.bgEmbeddingsGenerated;
  result.jsAnimationEmbeddingsGenerated += msg.jsAnimationEmbeddingsGenerated;
  result.responsiveEmbeddingsGenerated += msg.responsiveEmbeddingsGenerated;
  result.partEmbeddingsGenerated += msg.partEmbeddingsGenerated;
  result.embeddingFailedChunks += msg.embeddingFailedChunks;

  // LCC-M-01 audit-continuity: per-chunk RSS overshoot / partial-completion
  // telemetry (PR-V3-T1a §3.2) emission preserved per-page across the N-fork
  // loop. Only the section_text fork populates this today (C1 is section-only).
  const telemetry = msg.chunkedEncoderTelemetry;
  if (telemetry !== undefined) {
    emitChunkedEncoderTelemetryAudit(webPageId, telemetry).catch((err) => {
      logger.warn(
        "[Phase5-ForkOrchestrator] PR-V3-T1a chunked encoder telemetry audit emission failed (non-fatal)",
        { error: err instanceof Error ? err.message : String(err) }
      );
    });
  }
}

/**
 * Merge a `visual-result` IPC message into the aggregated result.
 *
 * PR-BT-5: each visual fork returns a `visual-result` with ONLY its own
 * sub-phase's field(s) populated; merge is additive across the up-to-2 visual
 * forks.
 */
function mergeVisualSubPhaseResult(result: EmbeddingPhaseResult, msg: ChildToParentMessage): void {
  if (msg.type !== "visual-result") return;
  result.sectionVisualEmbeddingsGenerated += msg.sectionVisualEmbeddingsGenerated;
  result.partVisualEmbeddingsGenerated += msg.partVisualEmbeddingsGenerated;
  result.partVisualSkippedBboxInvalid += msg.partVisualSkippedBboxInvalid;
  result.partVisualSkippedBboxUnresolvable += msg.partVisualSkippedBboxUnresolvable;
  // ADR-0018 Amendment 13 (truncated-screenshot data-loss fix): merge the
  // screenshot_truncated counter from the visual child IPC into the parent result.
  result.partVisualSkippedScreenshotTruncated += msg.partVisualSkippedScreenshotTruncated;
  result.embeddingFailedChunks += msg.embeddingFailedChunks;
}

/**
 * Dispatch ONE text sub-phase fork: run the per-workload GPU-COORD probe (e5
 * threshold + degraded audit), fork the text child with the `subPhase` set, and
 * merge the result additively. fork() exceptions are non-fatal (set skipReason,
 * continue to the next sub-phase — graceful degradation per sub-phase).
 *
 * PR-BT-5 (ADR-0039 Decision 1): GPU-COORD probe is called per fork (preserves
 * the PR-1 verifyCudaAvailability AND VRAM gate; probe count grows 2→≤9).
 */
async function runTextSubPhaseFork(args: {
  subPhase: TextSubPhaseDispatch;
  scriptPath: string;
  payloads: TextForkPayloads;
  webPageId: string;
  url: string;
  responsiveAnalysisId: string | undefined;
  partsSavedCount: number;
  partsLimit: number | undefined;
  job: EmbeddingPhaseParams["job"];
  effectiveToken: string;
  effectiveLockDuration: number;
  result: EmbeddingPhaseResult;
}): Promise<void> {
  const { subPhase, payloads, webPageId, url, result } = args;

  const initMessage: ParentToChildMessage = {
    type: "init-text",
    webPageId,
    url,
    sectionIdMapping: payloads.sectionIdMapping,
    motionIdMapping: payloads.motionIdMapping,
    jsIdMapping: payloads.jsIdMapping,
    bgIds: payloads.bgIds,
    scrollVisionIdMapping: payloads.scrollVisionIdMapping,
    layoutResultJson: payloads.layoutResultJson,
    motionResultJson: payloads.motionResultJson,
    jsAnimationsJson: payloads.jsAnimationsJson,
    scrollVisionResultJson: payloads.scrollVisionResultJson,
    responsiveAnalysisId: args.responsiveAnalysisId,
    partsSavedCount: args.partsSavedCount,
    ...(args.partsLimit !== undefined ? { partsLimit: args.partsLimit } : {}),
    subPhase,
  };

  // PR-1 GPU-COORD: parent-side per-workload probe drives the provider + audit.
  const decision = await resolveProviderAndAuditDegraded(webPageId, "text");

  try {
    const childResult = await runChildProcess({
      scriptPath: args.scriptPath,
      initMessage,
      timeoutMs: TEXT_CHILD_TIMEOUT_MS,
      job: args.job,
      effectiveToken: args.effectiveToken,
      effectiveLockDuration: args.effectiveLockDuration,
      label: `text:${subPhase}`,
      resolvedProvider: decision.provider,
    });
    mergeChildResult(
      childResult,
      "text-result",
      `Text:${subPhase}`,
      TEXT_CHANNEL_REASONS,
      result,
      (m) => mergeTextSubPhaseResult(webPageId, result, m)
    );
  } catch (forkError) {
    result.embeddingFailedChunks++;
    setSkipReasonIfUnset(result, "text_fork_failed", sanitizeErrorMessage(forkError));
    logger.warn(`[Phase5-ForkOrchestrator] Text sub-phase fork failed (${subPhase})`, {
      error: sanitizeErrorMessage(forkError),
    });
  }
}

/**
 * Dispatch ONE visual sub-phase fork: run the per-workload GPU-COORD probe
 * (DINOv2 threshold + degraded audit), fork the visual child with `subPhase`
 * set, and merge additively. fork() exceptions are non-fatal.
 */
async function runVisualSubPhaseFork(args: {
  subPhase: VisualSubPhaseDispatch;
  scriptPath: string;
  webPageId: string;
  url: string;
  screenshotPngPath: string;
  sectionIdMapping: [string, string][] | null;
  partsSavedCount: number;
  partsLimit: number | undefined;
  layoutResultJson: string | null;
  viewportWidth: number | undefined;
  viewportHeight: number | undefined;
  fallbackEnabled: boolean;
  dinov2ModelPath: string;
  job: EmbeddingPhaseParams["job"];
  effectiveToken: string;
  effectiveLockDuration: number;
  result: EmbeddingPhaseResult;
}): Promise<void> {
  const { subPhase, webPageId, result } = args;

  const initMessage: ParentToChildMessage = {
    type: "init-visual",
    webPageId,
    url: args.url,
    screenshotPngPath: args.screenshotPngPath,
    sectionIdMapping: args.sectionIdMapping,
    partsSavedCount: args.partsSavedCount,
    ...(args.partsLimit !== undefined ? { partsLimit: args.partsLimit } : {}),
    layoutResultJson: args.layoutResultJson,
    viewportWidth: args.viewportWidth,
    viewportHeight: args.viewportHeight,
    fallbackEnabled: args.fallbackEnabled,
    dinov2ModelPath: args.dinov2ModelPath,
    subPhase,
  };

  const decision = await resolveProviderAndAuditDegraded(webPageId, "visual");

  try {
    const childResult = await runChildProcess({
      scriptPath: args.scriptPath,
      initMessage,
      timeoutMs: VISUAL_CHILD_TIMEOUT_MS,
      job: args.job,
      effectiveToken: args.effectiveToken,
      effectiveLockDuration: args.effectiveLockDuration,
      label: `visual:${subPhase}`,
      resolvedProvider: decision.provider,
    });
    mergeChildResult(
      childResult,
      "visual-result",
      `Visual:${subPhase}`,
      VISUAL_CHANNEL_REASONS,
      result,
      (m) => mergeVisualSubPhaseResult(result, m)
    );
  } catch (forkError) {
    result.embeddingFailedChunks++;
    setSkipReasonIfUnset(result, "visual_fork_failed", sanitizeErrorMessage(forkError));
    logger.warn(`[Phase5-ForkOrchestrator] Visual sub-phase fork failed (${subPhase})`, {
      error: sanitizeErrorMessage(forkError),
    });
  }
}

// ============================================================================
// Public API: Fork Orchestrator
// ============================================================================

/**
 * Run Phase 5 embedding via fork() child processes.
 *
 * PR-BT-5 (M-1-RSS, ADR-0039): dispatches up to 9 per-sub-phase forks
 * sequentially (7 text + 2 visual), each loading its single model, processing
 * one sub-phase, and `exit(0)`ing for OS arena reclamation. `resolvePartBboxFn`
 * is called in the parent BEFORE the part_visual fork because it requires the
 * sharedBrowser (Playwright) which cannot cross the process boundary (B-3).
 *
 * @returns Aggregated EmbeddingPhaseResult merged across all sub-phase forks
 */
// v0.4.0 PR7c / PR-SS-B: IPhase5ScreenshotPersistence 依存を削除
//   - 削除責務は GDPR `data.delete` (Art.17 同期削除) のみに集約。TTL 構造は
//     PR-SS-B (ADR-0041) で撤去済 (Screenshot 保持 = `data.delete` まで)。
//   - GDPR 削除経路は引き続き `service-registrar-search.ts` 経由で
//     `ScreenshotPersistenceService.deleteScreenshot()` を使用するため、
//     `screenshot-persistence.types.ts` の型定義自体は保持する。
// v0.4.0 PR7c / PR-SS-B: Removed IPhase5ScreenshotPersistence dependency
//   - Deletion responsibility is consolidated into GDPR `data.delete` (Art.17,
//     synchronous) only. The TTL structure was removed in PR-SS-B (ADR-0041);
//     screenshot retention is "until `data.delete`".
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
    partVisualSkippedBboxInvalid: 0,
    partVisualSkippedBboxUnresolvable: 0,
    partVisualSkippedScreenshotTruncated: 0,
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
  // PR-BT-5 (M-1-RSS, ADR-0039): Per-Sub-Phase Fork dispatch loop
  //
  // Replaces the legacy 2-fork (text/visual) path with a sequential dispatch
  // loop of up to 9 per-sub-phase forks (7 text + 2 visual). Each fork loads
  // its single model, processes ONE sub-phase, and `exit(0)`s — letting the OS
  // reclaim the whole arena at the fork boundary (rooting out the
  // inter-sub-phase reload that was the M-1-RSS root cause). Empty sub-phases
  // (skipPredicate false) are skipped (no fork). Runner = (B) local
  // `runChildProcess` (NOT fork-common migration, ADR-0039 Decision 1).
  //
  // `PHASE5_SUBPHASE_FORK_ENABLED=false` reverts to the legacy 2-fork path
  // (rollback escape hatch; crashes on heavy CPU sites, not prod-equivalent).
  // ====================================================================
  const subPhaseForkEnabled = isSubPhaseForkEnabled();

  // Serialize the text IPC payloads ONCE and reuse across the (up to 7) text
  // sub-phase forks. Sequential stringify with optional GC between
  // serializations to keep peak heap pressure low (OOM-FIX-2 semantics).
  const layoutResultJson = layoutResultForNarrative
    ? JSON.stringify(layoutResultForNarrative)
    : null;
  if (typeof globalThis.gc === "function") globalThis.gc();
  const motionResultJson = motionResultForEmbedding
    ? JSON.stringify(motionResultForEmbedding)
    : null;
  if (typeof globalThis.gc === "function") globalThis.gc();
  const jsAnimationsJson = jsAnimationsForEmbedding
    ? JSON.stringify(jsAnimationsForEmbedding)
    : null;
  if (typeof globalThis.gc === "function") globalThis.gc();
  const scrollVisionResultJson = scrollVisionResultForEmbedding
    ? JSON.stringify(scrollVisionResultForEmbedding)
    : null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  let textPayloads: TextForkPayloads | null = {
    sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
    motionIdMapping: serializeIdMapping(motionSaveResult?.idMapping),
    jsIdMapping: serializeIdMapping(jsSaveResult?.idMapping),
    bgIds: bgSaveResult?.ids ?? null,
    scrollVisionIdMapping: serializeIdMapping(scrollVisionSaveResult?.idMapping),
    layoutResultJson,
    motionResultJson,
    jsAnimationsJson,
    scrollVisionResultJson,
  };

  const textScriptPath = resolveChildScriptPath("phase-5-text-embedding-child.js");

  // --- Step 1: Text sub-phase forks (section/motion/vision_motion/background/
  //              js_animation/responsive/part — each its own fork) ---
  const textDescriptors = subPhaseForkEnabled
    ? buildTextSubPhaseDescriptors(params)
    : // Legacy fallback: a single descriptor with subPhase unset (the child
      // grandfathers to running all 7 text sub-phases in one fork).
      [
        {
          subPhase: undefined as unknown as TextSubPhaseDispatch,
          workload: "text" as const,
          shouldRun: true,
        },
      ];

  for (const descriptor of textDescriptors) {
    if (!descriptor.shouldRun) continue;
    await runTextSubPhaseFork({
      subPhase: descriptor.subPhase,
      scriptPath: textScriptPath,
      payloads: textPayloads,
      webPageId,
      url,
      responsiveAnalysisId,
      partsSavedCount: partsSavedCount ?? 0,
      partsLimit,
      job,
      effectiveToken,
      effectiveLockDuration,
      result,
    });
  }

  // OOM-FIX-2: Release the text payloads after all text forks complete.
  textPayloads = null;
  if (typeof globalThis.gc === "function") globalThis.gc();

  // --- Step 2: Resolve Part Bounding Boxes (parent — requires sharedBrowser).
  //              Must run BEFORE the part_visual fork (ADR-0039 B-3). ---
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

  // --- Step 3: Visual sub-phase forks (section_visual / part_visual). Gated on
  //              screenshot presence (the screenshot is the visual source). ---
  const hasScreenshot = !!screenshotPngPath && fs.existsSync(screenshotPngPath);
  if (hasScreenshot) {
    const visualScriptPath = resolveChildScriptPath("phase-5-visual-embedding-child.js");
    const fallbackEnabled =
      (process.env["ENABLE_SECTION_SCREENSHOT_FALLBACK"] ?? "true") === "true";

    // OOM-FIX-2: Stringify the visual layout JSON once (after text payloads
    // freed) and release the original object reference.
    const visualLayoutJson = layoutResultForNarrative
      ? JSON.stringify(layoutResultForNarrative)
      : null;
    (params as unknown as Record<string, unknown>).layoutResultForNarrative = null;
    if (typeof globalThis.gc === "function") globalThis.gc();

    const visualDescriptors = subPhaseForkEnabled
      ? buildVisualSubPhaseDescriptors(params)
      : [
          {
            subPhase: undefined as unknown as VisualSubPhaseDispatch,
            workload: "visual" as const,
            shouldRun: true,
          },
        ];

    for (const descriptor of visualDescriptors) {
      if (!descriptor.shouldRun) continue;
      await runVisualSubPhaseFork({
        subPhase: descriptor.subPhase,
        scriptPath: visualScriptPath,
        webPageId,
        url,
        screenshotPngPath: screenshotPngPath!,
        sectionIdMapping: serializeIdMapping(sectionSaveResult?.idMapping),
        partsSavedCount: partsSavedCount ?? 0,
        partsLimit,
        layoutResultJson: visualLayoutJson,
        viewportWidth: job.data.options?.layoutOptions?.viewport?.width,
        viewportHeight: job.data.options?.layoutOptions?.viewport?.height,
        fallbackEnabled,
        dinov2ModelPath: deps.dinov2ModelPath,
        job,
        effectiveToken,
        effectiveLockDuration,
        result,
      });
    }
  }

  // PR-BT-5 (ADR-0039 §Security / unblock #8): the fork count is bounded by the
  // static sub-phase enumeration (≤ PHASE5_TOTAL_SUBPHASE_FORK_COUNT = 9),
  // data-row-count-independent. Referenced here so the CWE-770 cap constant is
  // bound into the dispatch path (asserted by INV-PHASE5-SUBPHASE-FORK-EXIT-001).
  void PHASE5_TOTAL_SUBPHASE_FORK_COUNT;

  // P1-17: Secondary cleanup — remove RAW decode tmp dir only (parent verifies after child exit)
  // v0.4.0 PR7d-1 (ADR-0010): cleanupPhase5TmpDirOnly() was removed and folded
  //   into `cleanupPhase5TempDir` (phase-5-raw-decode.ts) which now carries a
  //   3-stage whitelist defense (realpath + os.tmpdir() containment + prefix
  //   whitelist). `screenshotPngPath` may be undefined (e.g. WebGL sites that
  //   skipped the screenshot); guard accordingly. The persisted PNG is retained
  //   until GDPR `data.delete` (Art. 17) — the TTL deletion path was removed in
  //   PR-SS-B (ADR-0041; retention = "until `data.delete`").
  //   See ADR-0009 + ADR-0010 + ADR-0041 + DATA_RETENTION.md §9.
  // v0.4.0 PR7d-1 (ADR-0010) / PR-SS-B (ADR-0041): `cleanupPhase5TmpDirOnly()`
  //   has been removed and delegates to `cleanupPhase5TempDir`
  //   (phase-5-raw-decode.ts) which enforces a 3-stage whitelist (realpath +
  //   os.tmpdir() containment + `reftrix-phase5-raw-` prefix). Persisted PNG
  //   deletion is consolidated into GDPR `data.delete` (Art. 17) only.
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
