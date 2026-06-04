// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types, constants, and helper functions for page-analyze pipeline phases.
 *
 * Extracted from page-analyze-worker.ts (TDA-C1) to enable phase-level modularity.
 * All exports here are re-exported from page-analyze-worker.ts for backward compatibility.
 *
 * @module workers/phases/types
 */

import type { Worker, Job } from "bullmq";
import * as v8Module from "node:v8";
import type { RedisConfig } from "../../config/redis";
import type {
  PageAnalyzeJobData,
  PageAnalyzeJobResult,
  AnalysisPhase,
} from "../../queues/page-analyze-queue";
import type { ExecutionStatusTrackerV2 } from "../../tools/page/handlers/execution-status-tracker";
import type { ScrollCapture } from "../../services/vision/scroll-vision-capture.service";
import { logger, isDevelopment } from "../../utils/logger";
import { isBlankImage } from "../../utils/blank-image-detector";
import { safeParseInt } from "../../utils/safe-parse-int";
import {
  resolveMemoryConfig,
  logMemoryProfile,
  type MemoryProfile,
} from "../../services/worker-memory-profile";
import { DB_SAVED_PROGRESS_THRESHOLD } from "../../services/worker-constants";
import type {
  LayoutServiceResult,
  MotionServiceResult,
  JSAnimationFullResult,
} from "../../tools/page/handlers/types";
import type { SaveResult } from "../../services/worker-db-save.service";
import type { SaveBackgroundDesignsResult } from "../../services/background/background-design-db.service";
import type { SaveScrollVisionResult } from "../../services/vision/scroll-vision-persistence.service";
import type { ScrollVisionResult } from "../../services/vision/scroll-vision.analyzer";
import type { Browser } from "playwright";
import sharp from "sharp";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { emitSupervisorAuditLog } from "../../services/worker-supervisor-helpers";

// ============================================================================
// Dynamic Memory Configuration (lazy initialization — L-3 fix)
// ============================================================================
//
// Previously resolved at module load time, causing import-time side effects
// (os.totalmem(), env var reads, logger.info). Now uses lazy initialization:
// resolved on first call to initMemoryConstants() or checkMemoryPressure().
//
// CJS live binding: TypeScript `import { X }` compiles to property access on
// the require() result, so `export let` reassignments are visible to importers.
// ============================================================================

let _memoryConfig: MemoryProfile | null = null;
let _memConfigResolved = false;

/**
 * Lazy singleton: resolve memory configuration from system RAM.
 * Called automatically by initMemoryConstants() and checkMemoryPressure().
 */
function ensureMemoryConfig(): MemoryProfile {
  if (!_memoryConfig) {
    _memoryConfig = resolveMemoryConfig();
    logMemoryProfile(_memoryConfig);
  }
  return _memoryConfig;
}

/**
 * Initialize memory-derived constants from system RAM.
 *
 * Called once by the orchestrator (page-analyze-worker.ts) before pipeline
 * processing. Also called lazily by checkMemoryPressure() as a safety net.
 * Idempotent: safe to call multiple times.
 */
export function initMemoryConstants(): void {
  if (_memConfigResolved) return;
  _memConfigResolved = true;
  const config = ensureMemoryConfig();
  JS_ANIMATION_EMBEDDING_CHUNK_SIZE = config.jsAnimationEmbeddingChunkSize;
  EMBEDDING_CHUNK_SIZE = config.embeddingChunkSize;
  DINOV2_CHUNK_SIZE = config.dinov2ChunkSize;
  DINOV2_RECYCLE_THRESHOLD = config.dinov2RecycleThreshold;
  MEMORY_DEGRADATION_THRESHOLD_MB = config.degradationThresholdMb;
  MEMORY_CRITICAL_THRESHOLD_MB = config.criticalThresholdMb;
}

/** JSAnimation Embeddingチャンクサイズ（メモリ使用量抑制用、システムRAMに応じて動的決定） */
export let JS_ANIMATION_EMBEDDING_CHUNK_SIZE = 50;

/**
 * Universal embedding chunk size for sections/motions/backgrounds.
 *
 * All embedding sub-phases process items in chunks of this size to prevent
 * ONNX native arena memory from accumulating beyond the worker's memory threshold.
 *
 * Adaptive: reduced to half (min 5) under memory pressure.
 * Value is dynamically computed based on system RAM by resolveMemoryConfig().
 */
export let EMBEDDING_CHUNK_SIZE = 30;

/**
 * DINOv2 visual embedding chunk size for sections and parts.
 *
 * Controls the number of items processed per chunk during DINOv2 visual
 * embedding generation (section-level + part-level visual embeddings).
 * Separate from EMBEDDING_CHUNK_SIZE because DINOv2 ONNX inference has
 * different memory characteristics (~800MB model, larger per-item buffers).
 *
 * 0 = visual embedding disabled (8GB tier).
 * Adaptive: reduced to half (min 3) under memory pressure.
 * Value is dynamically computed based on system RAM tier by resolveMemoryConfig().
 */
export let DINOV2_CHUNK_SIZE = 15;

/**
 * DINOv2 session recycle threshold.
 *
 * After this many inferences, the DINOv2 ONNX session is disposed and
 * re-initialized to free accumulated native memory (arena fragmentation).
 *
 * Tier-based defaults: 16GB=5, 32GB=15, 64GB+=30.
 * Disabled when DINOV2_RECYCLE_ENABLED=false (HDD environments).
 * Value is dynamically computed based on system RAM tier by resolveMemoryConfig().
 */
export let DINOV2_RECYCLE_THRESHOLD = 15;

// ============================================================================
// Constants
// ============================================================================

/**
 * Default worker concurrency
 *
 * Note: Set to 1 to avoid race condition with singleton browser instance.
 */
export const DEFAULT_CONCURRENCY = 1;

/** Default lock duration (2400 seconds = 40 minutes, extended for CPU-bound embedding phase).
 * Configurable via BULLMQ_LOCK_DURATION environment variable.
 * SEC-M2: safeParseInt による安全なパース（NaN/範囲チェック付き、min=60s） */
export const DEFAULT_LOCK_DURATION = safeParseInt(process.env.BULLMQ_LOCK_DURATION, 2400000, {
  min: 60000,
});

/** Default lock extend interval (300 seconds = 5 minutes).
 * Configurable via BULLMQ_LOCK_EXTEND_INTERVAL_MS environment variable.
 * SEC-M2: safeParseInt による安全なパース（NaN/範囲チェック付き、min=10s） */
export const DEFAULT_LOCK_EXTEND_INTERVAL = safeParseInt(
  process.env.BULLMQ_LOCK_EXTEND_INTERVAL_MS,
  300000,
  { min: 10000 }
);

// ============================================================================
// Memory Degradation Constants (dynamically resolved from system RAM)
// ============================================================================

/**
 * RSS threshold for degradation - disable narrative/vision.
 * 環境変数 WORKER_MEMORY_DEGRADATION_MB でオーバーライド可能。
 */
export let MEMORY_DEGRADATION_THRESHOLD_MB = 12288;

/**
 * RSS threshold for critical abort - skip to DB save.
 * 環境変数 WORKER_MEMORY_CRITICAL_MB でオーバーライド可能。
 */
export let MEMORY_CRITICAL_THRESHOLD_MB = 14336;

/**
 * HTML size threshold for disabling vision LLM. Default: 5000000 (5MB)
 * SEC-M2: safeParseInt による安全なパース（min=100000=100KB）
 */
export const HTML_LARGE_THRESHOLD = safeParseInt(process.env.WORKER_HTML_LARGE_BYTES, 5000000, {
  min: 100000,
});

/**
 * HTML size threshold for disabling narrative+vision. Default: 10000000 (10MB)
 * SEC-M2: safeParseInt による安全なパース（min=100000=100KB）
 */
export const HTML_HUGE_THRESHOLD = safeParseInt(process.env.WORKER_HTML_HUGE_BYTES, 10000000, {
  min: 100000,
});

// ============================================================================
// PR-V3-T1a: Phase 5 streaming chunked encoder hardening constants
// (FIND-V3-IO-H-01 closure target; design §3.2 C1 contract)
// ============================================================================

/**
 * Per-chunk peak RSS budget (MB) for the C1 contract in PR-V3-T1a.
 *
 * After each chunk completes inside the streaming chunked encoder, the worker
 * measures `process.memoryUsage().rss` delta and emits
 * `embedding_skip_reason='text_child_memory_budget_exceeded_at_chunk_<n>'`
 * if the per-chunk peak exceeds this value. The remaining chunks are then
 * surfaced via the post-Phase-5 `dispatchBackfillJobsForPage` self-discovery
 * path (forward intent, A-1 compliance).
 *
 * Strictly tighter than the child-process-wide
 * `PHASE5_CHILD_RSS_KILL_DELTA_MB = 4096` so the latter remains a fail-safe
 * backstop, not the primary gate. Configurable via the
 * `PER_CHUNK_RSS_BUDGET_MB` environment variable.
 *
 * SEC-M2: safeParseInt による安全なパース (min 256 MB / max 8192 MB)。
 *
 * Per-chunk peak RSS budget (MB) for PR-V3-T1a's C1 contract. After each
 * chunk completes, the worker compares `process.memoryUsage().rss` delta;
 * on overshoot it emits the skip reason and breaks the loop, surfacing
 * remaining chunks to the post-Phase-5 backfill enumeration. Strictly
 * tighter than the process-wide kill threshold so it remains the primary
 * gate. Configurable via env. Range guard: 256-8192 MB.
 *
 * @see  §3.2 C1
 */
export const PER_CHUNK_RSS_BUDGET_MB = safeParseInt(process.env.PER_CHUNK_RSS_BUDGET_MB, 1536, {
  min: 256,
  max: 8192,
});

/**
 * Feature flag environment variable name for PR-V3-T1a streaming chunked
 * encoder hardening. When the variable is set to `"false"` (case-insensitive),
 * the C1-C4 hardening contracts are bypassed and the legacy chunk loop runs.
 * Default behaviour (variable unset or any value other than `"false"`) is
 * to apply the hardening contracts.
 *
 * Used by `isPhase5TextChunkedEncoderHardenedEnabled()` to read the flag at
 * runtime per chunk-loop entry; this allows operators to disable the
 * hardening via env injection if a regression surfaces on staging A/B test
 * (Plan v3 V2 §17 R-1 mitigation rollback path).
 *
 * Feature flag env var for PR-V3-T1a hardening; setting `"false"` disables
 * the C1-C4 contracts and falls back to the legacy chunk loop. Default
 * (unset / any other value) keeps hardening enabled.
 *
 * @see  §3.3.3 step 5 rollback path
 */
export const PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV = "PHASE5_TEXT_CHUNKED_ENCODER_HARDENED";

/**
 * Read the feature flag for PR-V3-T1a streaming chunked encoder hardening.
 * Returns `true` (hardening enabled) by default; returns `false` only when
 * the env var is exactly the case-insensitive string `"false"`.
 *
 * Read the PR-V3-T1a hardening feature flag. Returns `true` by default;
 * returns `false` only when the env var matches the case-insensitive string
 * `"false"`.
 */
export function isPhase5TextChunkedEncoderHardenedEnabled(): boolean {
  const raw = process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV];
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== "false";
}

/**
 * Chunked text-embedding telemetry surfaced from a fork-child text sub-phase to
 * the parent (for `audit_logs` emission + post-Phase-5 backfill enumeration).
 *
 * PR-V3-T1a §3.2 (FIND-V3-IO-H-01) defined these C1/C3/C4 contracts; PR-BT-5
 * chunk-fork contingency (ADR-0039 §Consequences #2a) relocated the interface
 * here (from `phase-5-embedding.ts`) so the shared `runChunkedTextEmbeddingLoop`
 * driver (`phase-5-chunked-text-loop.ts`) can mutate it without a circular
 * import on the embedding orchestrator. `phase-5-embedding.ts` re-exports it for
 * backward compatibility.
 *
 * 各 text sub-phase は per-sub-phase fork (ADR-0039 Decision 1) で個別 fork 実行
 * されるため、この telemetry は naturally per-sub-phase。
 */
export interface ChunkedEncoderTelemetry {
  /**
   * C3 contract — partial completion. `chunksDone` chunks were durably
   * persisted before the loop broke; `totalChunks - chunksDone` chunks
   * remain (surfaced via post-Phase-5 backfill enumeration).
   */
  partialCompletion?: {
    chunksDone: number;
    totalChunks: number;
  };
  /**
   * C1 contract — per-chunk RSS budget overshoot. Index of the chunk whose
   * peak RSS delta exceeded `PER_CHUNK_RSS_BUDGET_MB`. When set,
   * `partialCompletion` is also set with `chunksDone = budgetExceededChunkIndex`.
   */
  budgetExceededChunkIndex?: number;
  /**
   * C4 contract — idempotency on retry. Number of chunks at the head of the
   * loop that were skipped because their persisted rows already exist (prior
   * partial completion run). 0 indicates a fresh run with no prior partial
   * state.
   */
  idempotencyChunkSkippedCount?: number;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Lock extender interface for managing periodic lock renewal
 */
export interface LockExtender {
  /** Start periodic lock extension */
  start: () => void;
  /** Stop periodic lock extension (safe to call multiple times) */
  stop: () => void;
}

/**
 * Worker configuration options
 */
export interface PageAnalyzeWorkerOptions {
  /** Redis configuration overrides */
  redisConfig?: Partial<RedisConfig>;
  /** Worker concurrency (default: 1) */
  concurrency?: number;
  /** Lock duration in ms (default: 2400000, configurable via BULLMQ_LOCK_DURATION) */
  lockDuration?: number;
  /** Enable verbose logging (default: isDevelopment()) */
  verbose?: boolean;
}

/**
 * Worker instance with lifecycle methods
 */
export interface PageAnalyzeWorkerInstance {
  /** BullMQ Worker instance */
  worker: Worker<PageAnalyzeJobData, PageAnalyzeJobResult>;
  /** Gracefully close the worker */
  close: () => Promise<void>;
  /** Pause the worker (stop accepting new jobs, current job continues) */
  pause: () => Promise<void>;
  /** Check if worker is running */
  isRunning: () => boolean;
}

/**
 * Prismaクライアントインターフェース（JSAnimationEmbedding保存用）
 * N+1解消: createMany によるバッチ挿入に対応
 */
export interface JsAnimationEmbeddingPrismaClient {
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

/**
 * Embedding phase のパラメータ
 */
export interface EmbeddingPhaseParams {
  /** 実際のWebPage DB ID（upsert結果） */
  webPageId: string;
  /** ソースURL */
  url: string;
  /** BullMQ Job インスタンス */
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>;
  /** Worker token for lock extension */
  effectiveToken: string;
  /** Lock duration (ms) */
  effectiveLockDuration: number;
  /** Section保存結果（embedding生成用） */
  sectionSaveResult: SaveResult | null;
  /** Motion保存結果（embedding生成用） */
  motionSaveResult: SaveResult | null;
  /** JSAnimation保存結果（embedding生成用） */
  jsSaveResult: SaveResult | null;
  /** BackgroundDesign保存結果（embedding生成用） */
  bgSaveResult: SaveBackgroundDesignsResult | null;
  /** ScrollVision保存結果（embedding生成用） */
  scrollVisionSaveResult: SaveScrollVisionResult | null;
  /** Layout結果（sections, backgroundDesigns for embedding） */
  layoutResultForNarrative: LayoutServiceResult | null;
  /** Motion結果（patterns for embedding） */
  motionResultForEmbedding: MotionServiceResult | null;
  /** JSAnimation検出結果（embedding生成用） */
  jsAnimationsForEmbedding: JSAnimationFullResult | null;
  /** ScrollVision解析結果（vision-detected motion embedding生成用） */
  scrollVisionResultForEmbedding: ScrollVisionResult | null;
  /** Responsive Analysis ID（Phase 4.5でDB保存済み、embedding生成用） */
  responsiveAnalysisId?: string | undefined;
  /** Phase 1.1でDB保存されたパーツ数（0の場合はPartEmbeddingスキップ） */
  partsSavedCount?: number | undefined;
  /**
   * v0.4.0 PR4: Phase 5 同期フェーズで処理する Part text / visual embedding の上限件数。
   * 100 件超のページで 100 に設定され、残余は embedding-backfill Queue 経由で処理する。
   * undefined の場合は無制限（全件同期処理）。
   *
   * v0.4.0 PR4: Cap on the number of Part text / visual embeddings processed
   * in the Phase 5 synchronous flow. Set to 100 when a page has more than 100
   * Parts so the remainder is processed via the embedding-backfill Queue.
   * Undefined means "no limit" (process all Parts synchronously).
   */
  partsLimit?: number | undefined;
  /** Base64エンコードされたフルページスクリーンショット（visual embedding用） */
  screenshotBase64?: string | undefined;
  /** Screenshot PNG ファイルパス（Phase 0 で保存、Phase 5 RAW デコード最適化用、TMP-5: Optional） */
  screenshotPngPath?: string | undefined;
  /** 共有ブラウザインスタンス（Phase 5 bbox解決用、切断済みなら独自起動にフォールバック） */
  sharedBrowser?: Browser | undefined;
  /** Granular progress callback for embedding sub-phases */
  onProgress?: ((completed: number, total: number) => void) | undefined;
}

/**
 * Embedding phase スキップ理由の列挙体
 * Reasons an embedding phase can be skipped.
 *
 * PR2 (v0.4.0): page.analyze の「サイレント skip」バグを解消するため、
 * Phase 5 が部分的/全面的にスキップされた場合は必ずどれか一つの理由を
 * {@link EmbeddingPhaseResult.skipReason} に設定する。
 *
 * PR2 (v0.4.0): Introduced to eliminate the "silent skip" bug in
 * `page.analyze`. Whenever Phase 5 is skipped (fully or partially), exactly
 * one of these values must be set on {@link EmbeddingPhaseResult.skipReason}.
 */
export const EMBEDDING_SKIP_REASONS = [
  // V8 ヒープ残量不足（< 512MB） / V8 heap headroom below 512MB
  "v8_heap_headroom_low",
  // システム MemAvailable 不足（< 8GB） / System MemAvailable below 8GB
  "system_memavailable_low",
  // Text child fork 失敗（例外） / Text child fork threw
  "text_fork_failed",
  // Text child がエラーメッセージを返信 / Text child reported an error via IPC
  "text_child_error",
  // Text child 異常終了（非ゼロ exit / シグナル） / Text child abnormal exit
  "text_child_abnormal_exit",
  // Text child IPC race（exit 0 だが結果メッセージ未受信） / Text IPC race
  "text_ipc_race",
  // Visual child fork 失敗（例外） / Visual child fork threw
  "visual_fork_failed",
  // Visual child がエラーメッセージを返信 / Visual child reported an error via IPC
  "visual_child_error",
  // Visual child 異常終了 / Visual child abnormal exit
  "visual_child_abnormal_exit",
  // Visual child IPC race / Visual IPC race
  "visual_ipc_race",
  // Embedding 対象件数が 0（正常ケース） / No embeddable items (normal case)
  "no_embeddable_items",
  // dispatchEmbeddingPhase 全体の予期せぬ例外（text/visual 固有の reason に
  // 分類できないケース）。TDA MEDIUM 1 (v0.4.0 PR2 監査): 外側 catch での
  // text_fork_failed 誤分類を避けるための汎用分類。
  // Generic catch-all for unexpected exceptions in `dispatchEmbeddingPhase`
  // that cannot be attributed to text/visual specific reasons. Added to avoid
  // mis-classifying Visual-path exceptions as `text_fork_failed` in the outer
  // catch (TDA MEDIUM 1, v0.4.0 PR2 audit).
  "dispatch_phase_failed",
  // ==========================================================================
  // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): 下記 2 値は PR-D-1 で enum 拡張のみ
  // 実装され、実際の emit は PR-D-3 (fork_terminated_before_done) / PR-D-4
  // (parity_check_failed) で開始する。`skipReasonToBackfillStatus()` では
  // 両値とも `skipped_fork_error` にマップされる (fork/child-family と同じ
  // backfill retry 経路)。
  // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): The following 2 values are landed
  // in PR-D-1 as enum expansion only; actual emission starts in PR-D-3
  // (fork_terminated_before_done) and PR-D-4 (parity_check_failed). Both map
  // to `skipped_fork_error` in `skipReasonToBackfillStatus()` (same backfill
  // retry path as fork/child family).
  // ==========================================================================
  //
  // Fork child が `done` IPC message 送信前に終了した全シナリオの catch-all:
  //   (a) 非ゼロ exit code
  //   (b) signal 起因終了 (SIGKILL / SIGTERM / SIGSEGV / SIGABRT)
  //   (c) heartbeat timeout (60s default)
  //   (d) IPC disconnect without `done`
  // text_child_abnormal_exit / visual_child_abnormal_exit はチャネル特定後
  // の abnormal exit 用。本値は orchestrator 階層 (どのチャネルか判定できない
  // 段階) の catch-all。
  // INV-EMBEDDING-INTEGRITY-004 の landing に必要 (ADR-0018 §Decision 2,
  // §Migration Path Step 5)。
  //
  // Catch-all for all scenarios where a fork child terminates before sending
  // the `done` IPC message: (a) non-zero exit, (b) signal termination
  // (SIGKILL/SIGTERM/SIGSEGV/SIGABRT), (c) heartbeat timeout (60s default),
  // (d) IPC disconnect without `done`. `text_child_abnormal_exit` /
  // `visual_child_abnormal_exit` cover post-channel-identification abnormal
  // exits; this value covers the orchestrator layer (pre-channel-identification).
  // Required to land INV-EMBEDDING-INTEGRITY-004 (ADR-0018 §Decision 2,
  // §Migration Path Step 5).
  "fork_terminated_before_done",
  // Terminal transition (completed / failed) を実行する直前の
  // `SELECT COUNT(*) FROM component_part_embeddings WHERE web_page_id=? AND relation=?`
  // が `returnvalue.generatedCount` と strict equal しないケース。
  // INV-EMBEDDING-INTEGRITY-001 の parity check 失敗に対応。terminal
  // transition を abort し `failed + skipReason='parity_check_failed'` に遷移。
  // skipDetail には `expected=<n> actual=<m> delta=<d>` を設定 (数値のみ、
  // URL / stack trace / user 識別子は混入禁止)。
  // (ADR-0018 §Decision 4, §Migration Path Step 4, §7 Threat Model T.3)。
  //
  // Case where the `SELECT COUNT(*) FROM component_part_embeddings WHERE
  // web_page_id=? AND relation=?` just before terminal transition
  // (completed / failed) does not strictly equal `returnvalue.generatedCount`.
  // Corresponds to INV-EMBEDDING-INTEGRITY-001 parity-check failure. Aborts
  // terminal transition and moves to `failed + skipReason='parity_check_failed'`.
  // `skipDetail` is set to `expected=<n> actual=<m> delta=<d>` (numeric only;
  // URLs / stack traces / user identifiers are prohibited).
  // (ADR-0018 §Decision 4, §Migration Path Step 4, §7 Threat Model T.3.)
  "parity_check_failed",
  // ==========================================================================
  // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
  // Part visual embedding ループで boundingBox が invalid (null / 型不一致 /
  // width<=0 / height<=0) により crop 不可となり skip された場合の観測用
  // catch-all。従来は silent drop (continue) されていたが本値の enum 化 + counter
  // 計上 (`EmbeddingPhaseResult.partVisualSkippedBboxInvalid`) により
  // INV-EMBEDDING-INTEGRITY-005 を landing する。
  //
  // `skipReasonToBackfillStatus()` は本値を `skipped_fork_error` にマップし、
  // 既存 fork/child-family と同じ retry bucket に載せる (IO Registry UC-01
  // Option D、GDPR Art.5(1)(d) accuracy 遵守)。当初検討されていた
  // `skipped_screenshot_missing` は `backfill-reconciliation.service.ts` で
  // retry 対象外のため採用せず (Option B 撤回)。
  // `skipDetail` への emit 形式は `bboxInvalid:<n>` (PII-free 数値のみ)。
  //
  // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
  // Catch-all for observability when the Part visual embedding loop skips a
  // part due to invalid boundingBox (null / non-number / width<=0 / height<=0).
  // Previously a silent drop (continue); promoting to an enum + counter
  // (`EmbeddingPhaseResult.partVisualSkippedBboxInvalid`) lands
  // INV-EMBEDDING-INTEGRITY-005.
  //
  // `skipReasonToBackfillStatus()` maps this value to `skipped_fork_error`,
  // sharing the retry bucket with the fork/child-family (IO Registry UC-01
  // Option D, GDPR Art.5(1)(d) accuracy compliance). The initially-considered
  // `skipped_screenshot_missing` was rejected because
  // `backfill-reconciliation.service.ts` excludes it from retry (Option B
  // withdrawn). `skipDetail` emit format is `bboxInvalid:<n>` (PII-free
  // numeric only).
  "bbox_invalid",
  // ==========================================================================
  // ADR-0018 §Decision 1 Supplement S3 (PR-D-9 Wave 4, C-02 + C-04):
  // Playwright-residual catch-all. Emitted when `PartBboxPlaywrightService`
  // 1st-pass `page.evaluate()` resolution fails AND the optional
  // `BBOX_RESOLVE_RELOAD_ENABLED=true` reload pass either (a) is disabled,
  // (b) exhausts its `BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE` cap
  // (default 5), or (c) exhausts its `BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS`
  // cap (default 60000ms). Mutually exclusive with `bbox_invalid` per
  // ADR-0018 §Decision 1 Supplement S3 decision-boundary contract:
  //   - `bbox_invalid`     = JSDOM-origin catch-all (extraction-time, pre-Playwright)
  //   - `bbox_unresolvable` = Playwright-residual catch-all (Phase 5/backfill,
  //                            post-1st-pass + post-reload-budget exhaustion)
  //
  // `skipReasonToBackfillStatus()` maps this value to `skipped_fork_error`
  // (same retry bucket as `bbox_invalid` per ADR-0018 §Decision 1 Supplement
  // S3 mapping; `backfill-reconciliation.service.ts` retries up to 5 times
  // before terminal `failed`).
  //
  // Emitted alongside `audit_logs.action='embedding_part_visual_skipped'`
  // (per `AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED` SSOT in
  // `apps/mcp-server/src/audit/audit-actions.ts`); `details.skipReason` field
  // carries this enum value, `details.targetId` is `truncateTargetId()` PII
  // truncated.
  //
  // ADR-0018 §Decision 1 Supplement S3 (PR-D-9 Wave 4, C-02 + C-04):
  // Playwright-residual catch-all. Emitted when 1st-pass resolution + optional
  // reload pass both fail. Mutually exclusive with `bbox_invalid` (JSDOM-origin
  // vs Playwright-residual). Maps to `skipped_fork_error` retry bucket.
  // Audit logged via `embedding_part_visual_skipped` action SSOT.
  "bbox_unresolvable",
  // ==========================================================================
  // Plan v3 T3-Vision V1 §4.2 INV-VISION-PHASE5-GATE-001 (PR-D Wave 1):
  // page-analyze-worker Phase 5 fork() pre-spawn gate emits one of these two
  // reasons when `verifyVisionUnloadPrecondition()` returns a non-`vision_unloaded`
  // status. Both values map to `skipped_fork_error` in `skipReasonToBackfillStatus()`
  // (same retry bucket as fork/child-family). The caller annotates BullMQ enqueue
  // `delayMs` differently per branch (V1 §C-1 SSOT triple):
  //   - `vision_residual_at_phase5_start`     → delayMs = VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS (30000ms)
  //   - `vision_probe_failed_at_phase5_start` → delayMs = 0 (probe failure is independent of residual)
  //
  // Plan v3 T3-Vision V1 §4.2 INV-VISION-PHASE5-GATE-001 (PR-D Wave 1):
  // Two reasons emitted by the Phase 5 fork() pre-spawn gate when the Vision
  // unload precondition is not met. Differ only in the `delayMs` annotation
  // propagated to the BullMQ backfill enqueue (30000ms vs 0ms).
  "vision_residual_at_phase5_start",
  "vision_probe_failed_at_phase5_start",
  // ==========================================================================
  // PR-V3-T1a §3.4.1 (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01 closure target):
  // Phase 5 streaming chunked encoder hardening — C1 contract (per-chunk RSS
  // budget enforcement). Emitted when a chunk's measured peak RSS overshoots
  // `PER_CHUNK_RSS_BUDGET_MB` (default 1.5 GB). The `<n>` slot in the value
  // (e.g. `text_child_memory_budget_exceeded_at_chunk_2`) is interpolated at
  // runtime via the existing INV-SCHEMA-ENUM-004 wildcard handling pattern.
  // The bare `text_child_memory_budget_exceeded_at_chunk_<n>` value is the
  // SSOT-canonical form recorded in this enum; downstream emission code
  // substitutes `<n>` with the failing chunk index.
  //
  // Forward contract (A-1 compliance): on overshoot the loop breaks, the
  // remaining chunks are surfaced via the post-Phase-5
  // `dispatchBackfillJobsForPage` self-discovery path, and `audit_logs`
  // records the event for observability. Maps to `skipped_memory_pressure`
  // in `skipReasonToBackfillStatus()` (the per-chunk RSS overshoot is a
  // memory-pressure signal, NOT a fork/IPC failure).
  //
  // PR-V3-T1a §3.4.1 (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01 closure target):
  // Phase 5 streaming chunked encoder hardening — C1 (per-chunk RSS budget
  // enforcement). Emitted when a chunk's peak RSS overshoots
  // `PER_CHUNK_RSS_BUDGET_MB` (default 1.5 GB). `<n>` is interpolated at
  // runtime per the existing INV-SCHEMA-ENUM-004 wildcard handling pattern.
  // The bare form is the SSOT-canonical entry; emission substitutes `<n>`.
  // Maps to `skipped_memory_pressure` (memory-pressure signal, not fork/IPC).
  "text_child_memory_budget_exceeded_at_chunk_<n>",
  // PR-V3-T1a §3.4.1 (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01 closure target):
  // C3 contract (failure-path partial-flush prevention). Emitted on chunk-N
  // encoding failure where chunks 0..N-1 are durable forward intent (already
  // persisted) and chunks N..total are skipped. The `<n>` and `<total>` slots
  // (e.g. `partial_chunked_5_of_7`) are interpolated at runtime via the
  // INV-SCHEMA-ENUM-004 wildcard handling pattern. Forward contract
  // (A-1 compliance): observable via `audit_logs`, never silent. Maps to
  // `skipped_fork_error` in `skipReasonToBackfillStatus()` so the existing
  // post-Phase-5 backfill enumeration path observes
  // `partTextPending = total_parts - chunksDone × chunkSize` (third source
  // alongside threshold-driven and visual-screenshot-missing per ADR-0007).
  //
  // PR-V3-T1a §3.4.1 (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01 closure target):
  // C3 (failure-path partial-flush prevention). Emitted on chunk-N encoding
  // failure where chunks 0..N-1 are durable forward intent and chunks
  // N..total are skipped. `<n>` / `<total>` interpolated at runtime per
  // INV-SCHEMA-ENUM-004 wildcard handling. Forward contract (A-1 compliant).
  // Maps to `skipped_fork_error`; backfill enumeration sees a third source.
  "partial_chunked_<n>_of_<total>",
  // ==========================================================================
  // ADR-0018 Amendment (PR-BACKFILL-TERMINAL 系統B / System B, PR-BT-2):
  // 下記 2 値は section_visual の terminal-skip マーカー
  // (`section_embeddings.vision_skip_reason`) として記録され、
  // `sectionVisualPendingExclusionPredicate` で section_visual pending クエリから
  // 除外される (part_visual の terminal-skip と対称)。いずれも backfill path
  // (`fallbackEnabled === false`) でのみ書込まれ、main-path (Phase 5 proper,
  // `fallbackEnabled === true`) では書込まない (INV-007 Block D orthogonality)。
  // `skipReasonToBackfillStatus()` では両値とも **`not_required`** にマップする
  // (terminal-skip = page が completed に到達できる正当な除外。`skipped_fork_error`
  // retry bucket には**マップしない** — それは本 PR が直そうとしている
  // false-failed pin を再生成するため)。本 2 値は section terminal-skip = skip
  // reason であって failure reason ではないため、`EMBEDDING_BACKFILL_FAILURE_REASONS`
  // (`embedding-backfill-queue.ts`) には**追加しない** (IO Plan Decision V2
  // `019e5842` BT-V2-CORR-01)。
  //
  // ADR-0018 Amendment (System B, PR-BT-2): the following 2 values are recorded
  // as the section_visual terminal-skip marker (`section_embeddings.vision_skip_reason`)
  // and are excluded from the section_visual pending query by
  // `sectionVisualPendingExclusionPredicate` (symmetry with part_visual). Both
  // are written only on the backfill path (`fallbackEnabled === false`), never on
  // the main path (Phase 5 proper, `fallbackEnabled === true`; INV-007 Block D
  // orthogonality). `skipReasonToBackfillStatus()` maps BOTH to `not_required`
  // (a terminal-skip is a legitimate exclusion that lets the page reach
  // `completed`; it MUST NOT map to the `skipped_fork_error` retry bucket, which
  // would re-create the false-failed pin this PR fixes). These 2 values are skip
  // reasons, NOT failure reasons, so they are NOT added to
  // `EMBEDDING_BACKFILL_FAILURE_REASONS` (IO Plan Decision V2 `019e5842`
  // BT-V2-CORR-01).
  // ==========================================================================
  //
  // out-of-range uncroppable: backfill path で `isOutOfRange === true` かつ
  // `fallbackEnabled === false` の section。永続 fullPage screenshot に写らず、
  // backfill worker は Playwright per-section capture を起動しないため crop
  // 構造的に不能 = terminal (no-fake-success: 事実の記録)。
  //
  // Out-of-range uncroppable: a section with `isOutOfRange === true` and
  // `fallbackEnabled === false` on the backfill path. It is not contained in the
  // persisted fullPage screenshot and the backfill worker does not launch
  // Playwright per-section capture, so it is structurally uncroppable = terminal.
  "section_visual_uncroppable",
  // dedup duplicate: backfill path で `isDuplicateVisionEmbedding` (同一
  // sectionType 内 cosine > threshold) が true となり skip された section。同 type
  // sibling が代表 visual を保持するため DINOv2 embedding は真に不要 (Type-aware
  // dedup 契約が意図的に抑制)。`fallbackEnabled === false` 条件付きで記録。
  //
  // Dedup duplicate: a section skipped on the backfill path because
  // `isDuplicateVisionEmbedding` (same-sectionType cosine > threshold) is true. A
  // same-type sibling represents the visual, so a DINOv2 embedding is genuinely
  // unnecessary (deliberately suppressed by the Type-aware dedup contract).
  // Written only when `fallbackEnabled === false`.
  "section_visual_duplicate",
  // ==========================================================================
  // ADR-0018 Amendment (PR-C4, section_visual PII asymmetry closure): この値は
  // section_visual の terminal-skip マーカー (`section_embeddings.vision_skip_reason`)
  // として記録され、`sectionVisualPendingExclusionPredicate` の PII NOT EXISTS
  // (Path A) と二重防御で section_visual pending クエリから除外される。
  // **真因 (corrected root cause)**: work 側 `runVisualEmbeddingSubPhases` は
  // `component_parts.pii_risk_level='high'` を含む section を visual loop から
  // 意図的に除外する (GDPR Art.5(1)(c) data-minimisation) が、pending 側 predicate
  // が PII filter を持たなかったため high-PII section が永久 pending = page が
  // `completed` 未到達 (無限ループ)。part_visual / part_text は work 側除外と
  // pending 側除外が対称 (`pii_risk_level != 'high'`)。section_visual だけが
  // 非対称だった = systemic bug。
  // 本値は **work 側 PII-exclusion filter site** (phase-5-embedding.ts、
  // `highPiiSectionIdSet` で除外された section 群) で bulk write され、
  // 「PII 由来で意図的に visual 非生成」を GDPR Art.30 processing trail として
  // 記録する (`processSingleSectionVisualEmbedding` には到達しないため関数内
  // marker write は不可)。`skipReasonToBackfillStatus()` では既存の
  // `section_visual_uncroppable` / `section_visual_duplicate` と同様 **`not_required`**
  // にマップする (terminal-skip = page が completed に到達できる正当な除外。
  // `skipped_fork_error` retry bucket には**マップしない**)。`section_visual_pii_excluded`
  // は skip reason であって failure reason ではないため、
  // `EMBEDDING_BACKFILL_FAILURE_REASONS` には**追加しない** (BT-V2-CORR-01 方針継承)。
  //
  // ADR-0018 Amendment (PR-C4, section_visual PII asymmetry closure): recorded as
  // the section_visual terminal-skip marker (`section_embeddings.vision_skip_reason`)
  // and excluded from the section_visual pending query as a second defense layer
  // alongside the predicate's PII NOT EXISTS (Path A). Corrected root cause: the
  // work side intentionally excludes high-PII sections
  // (`component_parts.pii_risk_level='high'`) from the visual loop (GDPR
  // Art.5(1)(c) data-minimisation), but the pending side predicate lacked the
  // symmetric PII filter, so high-PII sections stayed pending forever and the
  // page never reached `completed` (infinite loop). part_visual / part_text are
  // symmetric (`pii_risk_level != 'high'`); only section_visual was asymmetric =
  // systemic bug. This value is bulk-written at the work-side PII-exclusion
  // filter site (the sections excluded via `highPiiSectionIdSet`), recording the
  // intentional non-generation as a GDPR Art.30 processing trail (high-PII
  // sections never reach `processSingleSectionVisualEmbedding`, so an in-function
  // marker write is impossible). `skipReasonToBackfillStatus()` maps it to
  // `not_required` like the existing 2 section_visual values (terminal-skip =
  // legitimate exclusion that lets the page reach `completed`; MUST NOT map to
  // the `skipped_fork_error` retry bucket). It is a skip reason, NOT a failure
  // reason, so it is NOT added to `EMBEDDING_BACKFILL_FAILURE_REASONS`
  // (BT-V2-CORR-01 policy inherited).
  "section_visual_pii_excluded",
  // ==========================================================================
  // secvisual-blank-terminal (Plan V1 §4, IO Plan Decision V1 `019e7f1c-0b66`):
  // 下記 2 値は section_visual の **degraded-coverage technical terminal** マーカー
  // (`section_embeddings.vision_skip_reason`) として記録され、
  // `sectionVisualPendingExclusionPredicate` で section_visual pending クエリから
  // 除外される (既存 3 値 uncroppable / duplicate / pii_excluded と対称)。いずれも
  // backfill path (`fallbackEnabled === false`) でのみ書込まれ、main-path
  // (Phase 5 proper, `fallbackEnabled === true`) では書込まない (INV-007 Block D
  // orthogonality)。`skipReasonToBackfillStatus()` では両値とも **`not_required`**
  // にマップする (terminal-skip = page が completed に到達できる正当な除外。
  // `skipped_fork_error` retry bucket には**マップしない** — false-failed pin
  // 再生成を避けるため)。skip reason であって failure reason ではないため
  // `EMBEDDING_BACKFILL_FAILURE_REASONS` には**追加しない** (BT-V2-CORR-01 継承)。
  //
  // **重要 (FIND-PLAN-L-07 / LCC-L-01)**: 本 2 値は `section_visual_pii_excluded`
  // (GDPR Art.5(1)(c) data-minimisation 由来の PII 除外) とは **意味が異なる**:
  //   - `section_visual_blank`       = 描画済だが空 (uniform/blank crop、視覚内容なし)
  //   - `section_visual_no_position` = layoutInfo.position geometry 欠落/退化
  //     (crop 領域なし)
  // いずれも **非 PII** の degraded-coverage technical terminal であり、GDPR
  // Art.4(1) personal data に該当しない (PII 除外と混同してはならない)。
  //
  // secvisual-blank-terminal (Plan V1 §4): the following 2 values are recorded as
  // the section_visual **degraded-coverage technical terminal** marker
  // (`section_embeddings.vision_skip_reason`) and excluded from the section_visual
  // pending query by `sectionVisualPendingExclusionPredicate` (symmetry with the
  // existing 3). Both are written only on the backfill path
  // (`fallbackEnabled === false`), never on the main path (INV-007 Block D
  // orthogonality). `skipReasonToBackfillStatus()` maps BOTH to `not_required`
  // (a terminal-skip lets the page reach `completed`; it MUST NOT map to the
  // `skipped_fork_error` retry bucket). They are skip reasons, NOT failure
  // reasons, so they are NOT added to `EMBEDDING_BACKFILL_FAILURE_REASONS`.
  //
  // IMPORTANT (FIND-PLAN-L-07 / LCC-L-01): these 2 values differ in MEANING from
  // `section_visual_pii_excluded` (a GDPR Art.5(1)(c) data-minimisation PII
  // exclusion): `section_visual_blank` = rendered-but-empty (uniform/blank crop,
  // no visual content); `section_visual_no_position` = absent/degenerate
  // `layoutInfo.position` geometry (no crop region). Both are NON-PII
  // degraded-coverage technical terminals, NOT GDPR Art.4(1) personal data, and
  // MUST NOT be conflated with the PII exclusion.
  // ==========================================================================
  //
  // blank: backfill path で crop が white/uniform (isBlank === true) かつ
  // `fallbackEnabled === false` の section。section は描画されたが視覚内容を持たず、
  // backfill worker は dynamic fallback re-capture queue を drain しないため
  // embedding は構造的に不能 = terminal。
  //
  // Blank: a section whose crop is white/uniform (`isBlank === true`) with
  // `fallbackEnabled === false` on the backfill path. The section was rendered but
  // carries no visual content, and the backfill worker does not drain the dynamic
  // fallback re-capture queue, so the embedding is structurally impossible =
  // terminal.
  "section_visual_blank",
  // no_position: backfill path で `sectionPositionMap` に position が無い、または
  // `height < 10` (degenerate geometry) かつ `fallbackEnabled === false` の section。
  // crop 領域を決定できず embedding 構造的に不能 = terminal (no-fake-success:
  // 事実の記録)。
  //
  // No-position: a section absent from `sectionPositionMap` (no position) or with
  // `height < 10` (degenerate geometry) and `fallbackEnabled === false` on the
  // backfill path. The crop region cannot be determined, so the embedding is
  // structurally impossible = terminal.
  "section_visual_no_position",
] as const;

/**
 * Embedding phase スキップ理由の型 / Type of embedding phase skip reason
 */
export type EmbeddingSkipReason = (typeof EMBEDDING_SKIP_REASONS)[number];

// ============================================================================
// ADR-0018 Amendment 7 §7.1 (Plan v2 PR-A, UB-10): Part visual terminal-skip
// SSOT derive — `EMBEDDING_PART_VISUAL_SKIP_REASONS` is the terminal subset of
// `EMBEDDING_SKIP_REASONS` for which a Part's `component_part_embeddings.visual_skip_reason`
// per-row marker is written so the part is permanently excluded from the
// part_visual pending query (NF-TPA-01 infinite re-fetch closure).
//
// **SSOT contract (UB-10, hardcode literal 禁止)**: This MUST be DERIVED via
// `.filter()` from the `EMBEDDING_SKIP_REASONS` T1 SSOT — never a
// hardcoded literal array. The C1 enum contract is SUBSUMED by the NF-TPA-01
// exclusion predicate: both reference this same derived const, forming a single
// derivation chain from one SSOT, structurally eliminating the "enum and
// predicate hardcoded separately and drift apart" failure mode (IO V1 conflict
// resolution: SSOT predicate ⊃ enum-contract integration).
//
// ADR-0018 Amendment 7 §7.1 (Plan v2 PR-A, UB-10): Derived terminal subset of
// `EMBEDDING_SKIP_REASONS` for which a per-row `visual_skip_reason` marker is
// written, excluding the part forever from the part_visual pending query.
// MUST be derived via `.filter()` from the SSOT (no hardcoded literals).
// ============================================================================

/**
 * Terminal subset of `EmbeddingSkipReason` values that classify a Part visual
 * embedding skip as **terminal** (structurally cannot generate a visual
 * embedding; retry is pointless). Currently `{bbox_invalid, bbox_unresolvable}`.
 *
 * The set membership is derived from the `EMBEDDING_SKIP_REASONS` SSOT
 * via `.filter()` — the explicit terminal-reason literals below are the
 * SELECTION CRITERION, and the runtime `.includes()` against the SSOT guards
 * against the failure mode where a reason is removed from the SSOT but the
 * derived subset silently retains a stale value.
 */
const PART_VISUAL_TERMINAL_REASON_CANDIDATES = ["bbox_invalid", "bbox_unresolvable"] as const;

/**
 * `EMBEDDING_PART_VISUAL_SKIP_REASONS` — SSOT-derived terminal subset of
 * `EMBEDDING_SKIP_REASONS` (UB-10, ADR-0018 Amendment 7 §7.1).
 *
 * Derived via `.filter()` so that any candidate not present in the
 * `EMBEDDING_SKIP_REASONS` SSOT is dropped (drift guard). A part marked with one
 * of these reasons in `component_part_embeddings.visual_skip_reason` is excluded
 * from the part_visual pending query by the SSOT exclusion predicate.
 */
export const EMBEDDING_PART_VISUAL_SKIP_REASONS = PART_VISUAL_TERMINAL_REASON_CANDIDATES.filter(
  (reason) => (EMBEDDING_SKIP_REASONS as readonly string[]).includes(reason)
);

/**
 * Terminal Part visual skip reason type — narrowed to the SSOT-derived subset.
 */
export type PartVisualTerminalSkipReason = (typeof EMBEDDING_PART_VISUAL_SKIP_REASONS)[number];

/**
 * Single SSOT exclusion predicate fragment for the part_visual pending query
 * (UB-3, NF-TPA-01, ADR-0018 Amendment 7 §7.1).
 *
 * **All 3+ callsites** of the part_visual pending query MUST reference this
 * single fragment (never inline the WHERE clause) so a partial application that
 * lets the processor re-fetch terminal-skip parts forever is impossible by
 * construction (pinned by INV-PART-VISUAL-SKIP-TERMINAL-001).
 *
 * Semantic:
 * ```
 * cpe.visual_embedding IS NULL          -- not yet generated
 * AND cpe.visual_skip_reason IS NULL    -- not terminally skipped (per-row marker)
 * ```
 *
 * A row whose `visual_skip_reason` is non-NULL (one of
 * {@link EMBEDDING_PART_VISUAL_SKIP_REASONS}) is excluded from pending so the
 * processor stops retrying it (terminal). A row with both columns NULL remains
 * pending (real-leak / retry target — INV-(b) orthogonality per ADR §7.5).
 *
 * The fragment is parameter-free static SQL (no interpolation, no SQL-injection
 * surface). The caller is responsible for the table alias `cpe` matching its
 * JOIN context.
 *
 * @param alias Table alias for `component_part_embeddings` (default `"cpe"`).
 *   Restricted to a SQL-identifier-safe form by the caller; callers pass a
 *   compile-time literal alias.
 * @returns SQL WHERE-fragment string (no leading `AND`/`WHERE`).
 */
export function partVisualPendingExclusionPredicate(alias: string = "cpe"): string {
  // Static fragment; `alias` is always a compile-time literal at every callsite
  // (`cpe`). No runtime user input flows here (no SQL-injection surface).
  return `${alias}.visual_embedding IS NULL AND ${alias}.visual_skip_reason IS NULL`;
}

// ============================================================================
// ADR-0018 Amendment (PR-BACKFILL-TERMINAL 系統B / System B, PR-BT-2): Section
// visual terminal-skip SSOT derive — `EMBEDDING_SECTION_VISUAL_SKIP_REASONS` is
// the terminal subset of `EMBEDDING_SKIP_REASONS` for which a section's
// `section_embeddings.vision_skip_reason` per-row marker is written so the
// section is permanently excluded from the section_visual pending query
// (symmetry with part_visual's `EMBEDDING_PART_VISUAL_SKIP_REASONS`).
//
// **SSOT contract (BT-V2-CORR, hardcode literal 禁止)**: This MUST be DERIVED via
// `.filter()` from the `EMBEDDING_SKIP_REASONS` T1 SSOT — never a
// hardcoded literal array. The CHECK-constraint contract on
// `section_embeddings.vision_skip_reason` is SUBSUMED by the
// `sectionVisualPendingExclusionPredicate` exclusion predicate: both reference
// this same derived const, forming a single derivation chain from one SSOT,
// structurally eliminating the "enum and predicate hardcoded separately and
// drift apart" failure mode (mirrors part_visual UB-10).
//
// ADR-0018 Amendment (System B, PR-BT-2): Derived terminal subset of
// `EMBEDDING_SKIP_REASONS` for which a per-row `vision_skip_reason` marker is
// written, excluding the section forever from the section_visual pending query.
// MUST be derived via `.filter()` from the SSOT (no hardcoded literals).
// ============================================================================

/**
 * Terminal subset of `EmbeddingSkipReason` values that classify a section visual
 * embedding skip as **terminal** (structurally cannot generate a visual
 * embedding on the backfill path; retry is pointless). Currently
 * `{section_visual_uncroppable, section_visual_duplicate, section_visual_pii_excluded,
 * section_visual_blank, section_visual_no_position}` (PR-C4 added
 * `section_visual_pii_excluded`; secvisual-blank-terminal added
 * `section_visual_blank` + `section_visual_no_position`).
 *
 * The set membership is derived from the `EMBEDDING_SKIP_REASONS` SSOT
 * via `.filter()` — the explicit terminal-reason literals below are the
 * SELECTION CRITERION, and the runtime `.includes()` against the SSOT guards
 * against the failure mode where a reason is removed from the SSOT but the
 * derived subset silently retains a stale value (mirrors
 * `PART_VISUAL_TERMINAL_REASON_CANDIDATES`).
 */
const SECTION_VISUAL_TERMINAL_REASON_CANDIDATES = [
  "section_visual_uncroppable",
  "section_visual_duplicate",
  // PR-C4 (ADR-0018 Amendment, section_visual PII asymmetry closure): work-side
  // PII-exclusion terminal marker (GDPR Art.30 processing trail). Added so
  // `SectionVisualTerminalSkipReason` accepts this value and the 4-site lockstep
  // (Prisma CHECK <-> TS SSOT <-> schema field <-> exclusion predicate) covers it.
  "section_visual_pii_excluded",
  // secvisual-blank-terminal (Plan V1 §4): degraded-coverage technical terminals
  // (NON-PII; distinct from `section_visual_pii_excluded`, FIND-PLAN-L-07).
  // `section_visual_blank` = rendered-but-empty (uniform/blank crop);
  // `section_visual_no_position` = absent/degenerate `layoutInfo.position`
  // geometry. Added so `SectionVisualTerminalSkipReason` accepts both and the
  // 4-site lockstep (Prisma CHECK <-> TS SSOT <-> schema field <-> exclusion
  // predicate) covers them (3 -> 5 additive). Derived via `.filter()` below.
  "section_visual_blank",
  "section_visual_no_position",
] as const;

/**
 * `EMBEDDING_SECTION_VISUAL_SKIP_REASONS` — SSOT-derived terminal subset of
 * `EMBEDDING_SKIP_REASONS` (ADR-0018 Amendment, System B, PR-BT-2).
 *
 * Derived via `.filter()` so that any candidate not present in the
 * `EMBEDDING_SKIP_REASONS` SSOT is dropped (drift guard). A section marked with
 * one of these reasons in `section_embeddings.vision_skip_reason` is excluded
 * from the section_visual pending query by the SSOT exclusion predicate. The
 * migration CHECK-constraint literals derive from this set (4-site lockstep:
 * Prisma CHECK <-> Prisma schema field <-> TS SSOT <-> exclusion predicate).
 */
export const EMBEDDING_SECTION_VISUAL_SKIP_REASONS =
  SECTION_VISUAL_TERMINAL_REASON_CANDIDATES.filter((reason) =>
    (EMBEDDING_SKIP_REASONS as readonly string[]).includes(reason)
  );

/**
 * Terminal section visual skip reason type — narrowed to the SSOT-derived subset.
 */
export type SectionVisualTerminalSkipReason =
  (typeof EMBEDDING_SECTION_VISUAL_SKIP_REASONS)[number];

/**
 * Single SSOT exclusion predicate fragment for the section_visual pending query
 * (ADR-0018 Amendment, System B, PR-BT-2; PR-C4 PII-filter symmetry; symmetry
 * with {@link partVisualPendingExclusionPredicate}).
 *
 * **All 3 callsites** of the section_visual pending query MUST reference this
 * single fragment (never inline the WHERE clause) so a partial application that
 * lets the processor re-fetch terminal-skip sections forever is impossible by
 * construction:
 *   1. `collectCategoryPendingSnapshot` (parity-gate snapshot)
 *   2. `countSectionVisualBackfillTargets` (backfill candidate count)
 *   3. `runVisualEmbeddingSubPhases` `sectionsNeedingVisual` (the work-fetch loop)
 *
 * Semantic:
 * ```
 * se.text_embedding IS NOT NULL        -- the section has a text embedding
 * AND se.vision_embedding IS NULL      -- vision not yet generated
 * AND se.vision_skip_reason IS NULL    -- not terminally skipped (per-row marker)
 * AND NOT EXISTS (                     -- PR-C4: not a high-PII section
 *   SELECT 1 FROM component_parts cp
 *   WHERE cp.section_pattern_id = se.section_pattern_id
 *     AND cp.pii_risk_level = 'high'
 * )
 * ```
 *
 * **PR-C4 PII-filter symmetry (corrected root cause closure)**: the work side
 * (`runVisualEmbeddingSubPhases`) intentionally excludes high-PII sections
 * (`component_parts.pii_risk_level='high'`) from the visual loop for GDPR
 * Art.5(1)(c) data-minimisation. Before PR-C4 this predicate had **no** PII
 * filter, so a high-PII section satisfied `text_embedding IS NOT NULL` /
 * `vision_embedding IS NULL` / `vision_skip_reason IS NULL` and stayed pending
 * forever — the page never reached `completed` (infinite loop). part_visual /
 * part_text are symmetric (`pii_risk_level != 'high'`); only section_visual was
 * asymmetric. The `NOT EXISTS` subquery restores symmetry: a section whose
 * `section_pattern_id` has any `component_parts` row with `pii_risk_level='high'`
 * is excluded from pending (work-side exclusion ↔ pending-side exclusion). This
 * is orthogonal to the per-row `vision_skip_reason` marker (Path B): the marker
 * (`section_visual_pii_excluded`) provides a second defense layer so pending
 * exclusion still holds via `vision_skip_reason IS NULL` even if the NOT EXISTS
 * is ever changed.
 *
 * **PR-C4 B3 live-marker relationship (TPA-IMPL-01 closure)**: the Path B marker
 * write is fed by `queryHighPiiPendingSectionPatternIds` (in `phase-5-embedding.ts`),
 * which derives the high-PII set from the **PII-filter-free** pending condition
 * (`text_embedding IS NOT NULL AND vision_embedding IS NULL AND vision_skip_reason
 * IS NULL` intersected with `pii_risk_level='high'`) — NOT from the result of THIS
 * predicate (which already removes high-PII rows via its NOT EXISTS clause). This
 * decoupling is what makes the marker live: deriving the high-PII set from this
 * predicate's output would always be empty. Once the marker sets
 * `vision_skip_reason = 'section_visual_pii_excluded'`, the row becomes terminal
 * and is excluded by the `vision_skip_reason IS NULL` clause of BOTH this
 * predicate and the live-marker query, so the marker write is idempotent and
 * completion (pending → 0) is preserved. The NOT EXISTS clause here is the
 * belt-and-suspenders defense for the pre-marker window and for runs where the
 * work loop does not execute.
 *
 * A row whose `vision_skip_reason` is non-NULL (one of
 * {@link EMBEDDING_SECTION_VISUAL_SKIP_REASONS}) is excluded from pending so the
 * processor stops retrying it (terminal). A row with `vision_embedding IS NULL`
 * AND `vision_skip_reason IS NULL` AND no high-PII child part remains pending
 * (real-leak / retry target — INV-(b) orthogonality per ADR-0018 §7.5). A
 * non-high-PII real-leak section is NOT excluded by the NOT EXISTS (it stays
 * pending and is correctly retried — RISKS R1 / INV-011 orthogonality assert).
 *
 * The fragment is parameter-free static SQL (no reason-literal interpolation, no
 * SQL-injection surface — it only checks `vision_skip_reason IS NULL` and an
 * enum-bound `pii_risk_level = 'high'` literal, never embeds a specific reason
 * string or runtime user input). The caller is responsible for the table alias
 * matching its JOIN/subquery context, and for the `<alias>.section_pattern_id`
 * column being available (all 3 callsites SELECT from `section_embeddings`).
 *
 * @param alias Table alias for `section_embeddings` (default `"se"`). Restricted
 *   to a SQL-identifier-safe form by the caller; callers pass a compile-time
 *   literal alias.
 * @returns SQL WHERE-fragment string (no leading `AND`/`WHERE`).
 */
export function sectionVisualPendingExclusionPredicate(alias: string = "se"): string {
  // Static fragment; `alias` is always a compile-time literal at every callsite
  // (`se`). No runtime user input flows here (no SQL-injection surface). The
  // predicate only checks `vision_skip_reason IS NULL` and an enum-bound
  // `pii_risk_level = 'high'` literal — it never interpolates a specific reason
  // literal nor runtime user input (no enum-drift / SQL-injection surface).
  // PR-C4: the NOT EXISTS subquery anchors on `<alias>.section_pattern_id`
  // (correlated subquery), restoring part_visual ↔ section_visual PII symmetry.
  return (
    `${alias}.text_embedding IS NOT NULL ` +
    `AND ${alias}.vision_embedding IS NULL ` +
    `AND ${alias}.vision_skip_reason IS NULL ` +
    `AND NOT EXISTS (` +
    `SELECT 1 FROM component_parts cp ` +
    `WHERE cp.section_pattern_id = ${alias}.section_pattern_id ` +
    `AND cp.pii_risk_level = 'high'` +
    `)`
  );
}

/**
 * `EmbeddingPhaseResult.skipDetail` の最大長（文字数）。
 * 将来 URL / スタックトレース / PII が誤って混入した場合でも DB / ログ /
 * MCP レスポンスへの漏洩を 200 文字で打ち切るための型レベルガード。
 * LCC 推奨 (v0.4.0 PR2 監査)。
 *
 * Maximum length (in characters) of `EmbeddingPhaseResult.skipDetail`.
 * Acts as a type-level guard so that URLs, stack traces, or PII that may
 * accidentally reach this field are truncated to 200 chars before they leak
 * into the DB, logs, or MCP responses. LCC recommendation (v0.4.0 PR2 audit).
 */
export const SKIP_DETAIL_MAX_LENGTH = 200;

/**
 * `skipDetail` 文字列を {@link SKIP_DETAIL_MAX_LENGTH} 文字以内に切り詰める。
 * 既に収まっていれば入力をそのまま返す。機微情報（PII / stack trace / URL）の
 * 混入が将来発生しても露出を最小化する目的で使用する。
 *
 * Truncates a `skipDetail` string to at most {@link SKIP_DETAIL_MAX_LENGTH}
 * characters; returns the input unchanged when it already fits. Guards
 * against PII / stack trace / URL accidentally reaching this field.
 *
 * @param detail 生の skipDetail 文字列 / raw skipDetail string
 * @returns 切り詰め済み文字列 / truncated string
 */
export function truncateSkipDetail(detail: string): string {
  if (detail.length <= SKIP_DETAIL_MAX_LENGTH) {
    return detail;
  }
  // 末尾 3 文字は "..." の余白として確保する。
  // Reserve 3 chars for the "..." suffix marker.
  return `${detail.slice(0, SKIP_DETAIL_MAX_LENGTH - 3)}...`;
}

/**
 * Embedding phase の結果
 */
export interface EmbeddingPhaseResult {
  /** Section embedding 生成数 */
  sectionEmbeddingsGenerated: number;
  /** Motion embedding 生成数 */
  motionEmbeddingsGenerated: number;
  /** BackgroundDesign embedding 生成数 */
  bgEmbeddingsGenerated: number;
  /** JSAnimation embedding 生成数 */
  jsAnimationEmbeddingsGenerated: number;
  /** Responsive Analysis embedding 生成数 */
  responsiveEmbeddingsGenerated: number;
  /** Part embedding 生成数 */
  partEmbeddingsGenerated: number;
  /** Part visual embedding 生成数（DINOv2） */
  partVisualEmbeddingsGenerated: number;
  /**
   * Part visual embedding loop で boundingBox が invalid (null / non-number /
   * width<=0 / height<=0) により skip された件数 (PR-D-2, INV-EMBEDDING-INTEGRITY-005)。
   * 従来の silent drop (continue) を counter 計上に置換することで observability
   * を担保する。Phase 5 完了時の `skipDetail` には `bboxInvalid:<n>` として
   * encode され、run-level で全 part が bbox_invalid で skip された場合は
   * `skipReason='bbox_invalid'` に promote される (§Plan 3.3)。
   *
   * Count of parts skipped by the Part visual embedding loop because the
   * boundingBox is invalid (null / non-number / width<=0 / height<=0).
   * Replaces the legacy silent-drop (`continue`) with an explicit counter,
   * preserving observability (PR-D-2, INV-EMBEDDING-INTEGRITY-005). Encoded in
   * `skipDetail` as `bboxInvalid:<n>` and promoted to run-level
   * `skipReason='bbox_invalid'` when ALL parts are skipped this way (Plan §3.3).
   */
  partVisualSkippedBboxInvalid: number;
  /**
   * ADR-0018 Amendment 7 §7.6 exit #2 (Plan v2 PR-B, UB-8, NF-TPA-02): count of
   * parts skipped because the resolved crop is zero-size (cropWidth<=0 ||
   * cropHeight<=0) after off-screen clamping (M3 = off-screen non-zero bbox).
   * Replaces the legacy silent bare `continue` with an observable counter +
   * per-row `visual_skip_reason='bbox_unresolvable'` terminal marker, so the
   * part is excluded from the part_visual pending query (NF-TPA-01).
   *
   * Count of parts skipped because the off-screen-clamped crop is zero-size;
   * promotes the legacy silent bare `continue` to an observable counter + a
   * per-row `bbox_unresolvable` terminal marker.
   */
  partVisualSkippedBboxUnresolvable: number;
  /** Section visual embedding 生成数（DINOv2） */
  sectionVisualEmbeddingsGenerated: number;
  /** Embedding生成に失敗したチャンク数 */
  embeddingFailedChunks: number;
  /** Embedding phase が完了したか */
  completed: boolean;
  /**
   * Phase 5 が部分的/全面的にスキップされた理由（PR2 v0.4.0）。
   * `completed === false` かつ生成カウント合計が 0 のときは **必ず** 設定される。
   * `completed === true` の場合でも、一部サブステップがスキップされた場合は設定されうる。
   *
   * Reason Phase 5 was skipped (PR2 v0.4.0). When `completed === false` and
   * every embedding count is 0, this **must** be set. It may also be set when
   * `completed === true` but a sub-step was skipped.
   */
  skipReason?: EmbeddingSkipReason | undefined;
  /**
   * `skipReason` の補足情報（数値・閾値など）。機微情報は含めないこと。
   * Additional context for `skipReason` (numbers, thresholds). Must not contain PII.
   */
  skipDetail?: string | undefined;
}

/** Phase progress percentages
 * EMBEDDING_START は DB_SAVED_PROGRESS_THRESHOLD と一致する必要がある。
 * progress >= DB_SAVED_PROGRESS_THRESHOLD のジョブはDB保存済みとみなされる。
 *
 * Execution order (must be monotonically increasing):
 *   Phase 0  (Ingest)                    0-15
 *   Phase 1  (Layout)                   15-33
 *   Phase 1.1 (Part Extraction)         33-35
 *   Phase 1.5 (ScrollVision Capture)    35-45
 *   Phase 2  (Motion)                   45-60
 *   Phase 2.5 (ScrollVision Analysis)   60-63
 *   Phase 3  (Quality)                  63-73
 *   Phase 4  (Narrative)                73-83
 *   Phase 4.5 (Responsive)              83-90
 *   Phase 5  (Embedding)                90-100
 */
export const PHASE_PROGRESS = {
  INGEST_START: 0,
  INGEST_COMPLETE: 15,
  LAYOUT_START: 15,
  LAYOUT_COMPLETE: 33,
  PART_EXTRACTION_START: 33,
  PART_EXTRACTION_COMPLETE: 35,
  SCROLL_VISION_CAPTURE_START: 35,
  SCROLL_VISION_CAPTURE_COMPLETE: 45,
  MOTION_START: 45,
  MOTION_COMPLETE: 60,
  SCROLL_VISION_ANALYSIS_START: 60,
  SCROLL_VISION_ANALYSIS_COMPLETE: 63,
  QUALITY_START: 63,
  QUALITY_COMPLETE: 73,
  NARRATIVE_START: 73,
  NARRATIVE_COMPLETE: 83,
  RESPONSIVE_START: 83,
  RESPONSIVE_COMPLETE: DB_SAVED_PROGRESS_THRESHOLD,
  EMBEDDING_START: DB_SAVED_PROGRESS_THRESHOLD,
  EMBEDDING_COMPLETE: 100,
} as const;

/**
 * Phase context — immutable context passed to all phase functions.
 *
 * job, options, url, etc. are read-only during phase execution.
 * Phase functions modify PipelineState (mutable) and read PhaseContext (immutable).
 */
export interface PhaseContext {
  /** BullMQ Job instance */
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>;
  /** Job options (analysis configuration) */
  options: PageAnalyzeJobData["options"];
  /** Target URL */
  url: string;
  /** Original requested WebPage ID */
  webPageId: string;
  /** BullMQ lock token */
  effectiveToken: string;
  /** BullMQ lock duration (ms) */
  effectiveLockDuration: number;
  /** Status tracker for progress reporting */
  statusTracker: ExecutionStatusTrackerV2;
}

/**
 * Pipeline orchestrator state — mutable state shared across phases.
 *
 * processPageAnalyzeJob の全 Phase で読み書きされる変数を構造体にまとめたもの。
 * 各 Phase 関数はこのオブジェクトを受け取り、Phase 完了時に結果を書き戻す。
 */
export interface PipelineState {
  /** 実際の WebPage DB ID（upsert 結果で更新される） */
  actualWebPageId: string;
  /**
   * `normalizeUrlForStorage(url)` の結果。failure-path の url-key upsert
   * (`markFailedAndAuditAtomic`) が `where.url` / create `url` の key として
   * 使用する (PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2)。
   * Phase 0 entry で確定し、W0 / W1 / failure-path 全経路が同一の
   * `url @unique` (`schema.prisma:208`) に収束する (CONS-3 / CWE-362)。
   *
   * `normalizeUrlForStorage(url)` value. Used by the failure-path url-key
   * upsert as the `where.url` / create `url` key so W0 / W1 / failure-path
   * all converge on the same `url @unique` row.
   */
  normalizedUrl: string;
  /** 完了した Phase の配列 */
  completedPhases: AnalysisPhase[];
  /** 失敗した Phase の配列 */
  failedPhases: AnalysisPhase[];
  /** 各 Phase の結果サマリ */
  results: PageAnalyzeJobResult["results"];
  /** Layout 結果（Narrative/Embedding 用に保持） */
  layoutResultForNarrative: LayoutServiceResult | null;
  /** Section DB 保存結果 */
  sectionSaveResult: SaveResult | null;
  /** Motion DB 保存結果 */
  motionSaveResult: SaveResult | null;
  /** JSAnimation DB 保存結果 */
  jsSaveResult: SaveResult | null;
  /** BackgroundDesign DB 保存結果 */
  bgSaveResult: SaveBackgroundDesignsResult | null;
  /** Motion 結果（embedding 用） */
  motionResultForEmbedding: MotionServiceResult | null;
  /** JSAnimation 検出結果（embedding 用） */
  jsAnimationsForEmbedding: JSAnimationFullResult | null;
  /** ScrollVision DB 保存結果 */
  scrollVisionSaveResult: SaveScrollVisionResult | null;
  /** ScrollVision 解析結果（embedding 用） */
  scrollVisionResultForEmbedding: ScrollVisionResult | null;
  /** ScrollVision captures (deferred analysis) */
  scrollVisionCapturesForDeferred: ScrollCapture[] | null;
  /** HTML — null after Phase 4 release */
  html: string | null;
  /** Screenshot (base64) — undefined after Phase 5 release */
  screenshotBase64: string | undefined;
  /** Screenshot PNG file path — Phase 0 saves to tmp, Phase 5 reads (TMP-5: Optional) */
  screenshotPngPath?: string;
  /** Narrative/Vision pre-disable flags */
  narrativePreDisabled: boolean;
  visionPreDisabled: boolean;
  /** Memory abort flag */
  memoryAborted: boolean;
  /**
   * Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — supervisor-injected spawn-time
   * (epoch ms) read from `REFTRIX_WORKER_SPAWN_TIME_MS` env var. Used as the
   * `worker_job_lifecycle.worker_spawn_time` SSOT join key for both the
   * spawn write hook (`recordWorkerSpawn`) and the release clear hook
   * (`recordWorkerRelease`). Falls back to `Date.now()` for legacy / test
   * runs without supervisor.
   *
   * UNBLOCK-T4-02 spawn-time SSOT for INV-WORKER-PID-IDENTITY-005 hooks.
   */
  workerSpawnTimeMs?: number;
}

// ============================================================================
// Ollama Vision Unload
// ============================================================================

/** Default Ollama URL */
const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/** Ollama Vision model name (same as GpuResourceManager) */
const OLLAMA_VISION_MODEL_NAME = process.env.OLLAMA_VISION_MODEL ?? "llama3.2-vision";

/** Ollama API timeout for unload request (ms) */
const OLLAMA_UNLOAD_TIMEOUT_MS = 10_000;

/** Allowed hostnames for Ollama API (SSRF prevention) */
const OLLAMA_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * SEC: Ollama URL のローカルホストバリデーション（SSRF 対策）
 */
export function validateOllamaLocalhostUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!OLLAMA_ALLOWED_HOSTS.includes(parsed.hostname)) {
      logger.warn("[PageAnalyzeWorker] Ollama URL rejected: must point to localhost", {
        hostname: parsed.hostname,
      });
      return OLLAMA_DEFAULT_URL;
    }
    return url;
  } catch {
    logger.warn("[PageAnalyzeWorker] Invalid Ollama URL, falling back to default", { url });
    return OLLAMA_DEFAULT_URL;
  }
}

/**
 * Ollama Vision モデルを RAM/VRAM からアンロードしてメモリを解放する
 *
 * 冪等: Ollama が起動していない環境や Vision 未ロード時は何もせず正常終了する (non-fatal)。
 * 呼び出し箇所: (1) Phase 1完了後、(2) Phase 2.5完了後、(3) Phase 4完了後。
 *
 * @returns アンロード成功時 true、失敗/スキップ時 false
 */
export async function unloadOllamaVisionModel(): Promise<boolean> {
  const ollamaUrl = validateOllamaLocalhostUrl(process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL_NAME,
        keep_alive: "0",
        prompt: "",
      }),
      signal: AbortSignal.timeout(OLLAMA_UNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("[PageAnalyzeWorker] Ollama vision model unload request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    logger.info(
      "[PageAnalyzeWorker] Ollama vision model unloaded to free memory for embedding phase",
      {
        model: OLLAMA_VISION_MODEL_NAME,
        currentRssMb: rssMb,
      }
    );
    return true;
  } catch (error) {
    logger.warn(
      "[PageAnalyzeWorker] Failed to unload Ollama vision model (service may be unavailable)",
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}

// ============================================================================
// Ollama Vision Unload + Verify (Plan v3 T3-Vision V1 §3.1 Layer 1)
// ============================================================================

/**
 * Number of `/api/ps` poll attempts after unload POST before declaring residual.
 * Plan v3 T3-Vision V1 §3.1 step 3.
 *
 * /api/ps を unload POST 後にポーリングする回数 (3 回)。
 */
const VISION_PROBE_ATTEMPTS = 3;

/**
 * Delay between successive `/api/ps` poll attempts.
 * Test contract: 3 attempts × ~50ms = ~150ms (test allows 15s timeout for slack).
 *
 * /api/ps ポーリング間隔。3 回 × 50ms = 150ms (test 15s budget 内)。
 */
const VISION_PROBE_INTERVAL_MS = 50;

/**
 * Per-attempt timeout for `/api/ps` poll.
 *
 * /api/ps 1 回あたりの timeout。
 */
const VISION_PROBE_ATTEMPT_TIMEOUT_MS = 3_000;

/**
 * Ollama Vision unload + verify result (Plan v3 T3-Vision V1 §4.1 INV-VISION-UNLOAD-001).
 *
 * Wraps the legacy `unloadOllamaVisionModel()` POST keep_alive=0 with a
 * `/api/ps`-based residual verification step (3 attempts) and emits one of
 *   - `vision_unload_verified`         (residualBytes === 0, success)
 *   - `vision_unload_residual_persisted` (residualBytes > 0,  failure)
 * via `emitSupervisorAuditLog()` SSOT (audit_logs.action enum).
 *
 * If the audit emit itself throws (DB unavailable, transient connection error),
 * the caller's behaviour is preserved (no propagation) via L1.5 SLO_MARKER
 * fail-open compensation per ADR-0011 Amendment 3 §SLO 5-tier.
 *
 * `unloadOllamaVisionModel()` の POST keep_alive=0 を `/api/ps` ポーリングで
 * verify したラッパー。audit emit が throw しても caller 動作を保つ (L1.5 SLO_MARKER)。
 */
export interface VisionUnloadVerifyResult {
  /** `true` iff residual bytes == 0 after probe (POST 5xx tolerated when probe succeeds). */
  readonly unloaded: boolean;
  /** Residual VRAM bytes detected via `/api/ps` (NaN/Infinity defended to 0). */
  readonly residualBytes: number;
  /** `true` iff `/api/ps` was reached (request didn't throw). */
  readonly probeAttempted: boolean;
  /** `true` iff `POST /api/generate keep_alive=0` returned 2xx. */
  readonly unloadAckReceived: boolean;
  /** Wall-clock duration of unload + verify, finite ms. */
  readonly elapsedMs: number;
  /** Sanitized probe error string (set only when all probe attempts fail). */
  readonly probeError?: string;
}

// ============================================================================
// `pollVramResidual` sub-helpers (IO Impl Decision V1 §5 Option (a) refactor).
//
// Plan v3 T3-Vision V1 §1.7 / IO Impl Decision V1 §5 で
// `unloadOllamaVisionModelAndVerify()` から 4 段の helper を抽出。
// 各 sub-helper は cyclomatic ≤5 contract を満たす。
//
// IO Impl Decision V1 §5 Option (a) refactor extracted 4 helpers from the
// inline polling loop, each ≤5 cyclomatic.
// ============================================================================

/**
 * Lower bound for per-attempt `/api/ps` probe timeout (`pollWithBudget`).
 *
 * Plan v3 T3-Vision V1 §1.7: callers may pass `deadlineMs=0` (e.g. in
 * shutdown paths); we clamp to 500 ms so a single fetch can still complete
 * without an immediate timeout failure.
 *
 * `/api/ps` プローブの per-attempt timeout 下限。`deadlineMs=0` でも
 * 500ms に clamp して即時 timeout 失敗を防ぐ。
 */
const POLL_VRAM_MIN_ATTEMPT_TIMEOUT_MS = 500;

/**
 * Per-attempt residual + error pair returned by {@link attemptVramProbe}.
 *
 * `attemptVramProbe()` の per-attempt 結果。
 */
export interface VramProbeAttemptResult {
  /** `true` iff the HTTP GET succeeded and JSON parsed cleanly. */
  readonly observedSuccessfully: boolean;
  /** Residual bytes extracted from this attempt (NaN/Infinity defended to 0). */
  readonly attemptResidual: number;
  /** Sanitized error string set only when `observedSuccessfully=false`. */
  readonly probeError?: string;
}

/**
 * Aggregated polling result returned by {@link pollWithBudget} and
 * {@link pollVramResidual}.
 *
 * `pollWithBudget()` / `pollVramResidual()` の集約結果。
 */
export interface VramPollResult {
  /** Maximum residual observed across all successful attempts. */
  readonly maxResidualBytes: number;
  /** `true` iff at least one attempt succeeded (HTTP OK + JSON parsed). */
  readonly observedSuccessfully: boolean;
  /** Number of attempts actually executed (1..attempts; early-return when residual=0). */
  readonly attemptsUsed: number;
  /** Sanitized error string set only when no attempt succeeded. */
  readonly probeError?: string;
}

/**
 * Extract the maximum residual VRAM (in bytes) of any model whose name starts
 * with `llama3.2-vision` (Apple Silicon `llama3.2-vision:11b` also matches per
 * ADR-0011 Amendment 1 §C). NaN / Infinity / negative values are coerced to 0
 * via `Number.isFinite` + `Math.max(0, ...)`. Null / undefined entries are
 * safely ignored.
 *
 * IO Impl Decision V1 §5 sub-helper #1 — pure function, no I/O.
 *
 * `llama3.2-vision` で始まる model の最大 size_vram を抽出する純粋関数。
 * NaN/Infinity 防御、null/undefined entry の skip 込み。
 */
export function extractMaxResidual(
  models: ReadonlyArray<{ name?: string; size_vram?: number } | null | undefined>
): number {
  let max = 0;
  for (const m of models) {
    if (!m) continue;
    const name = typeof m.name === "string" ? m.name : "";
    if (!name.startsWith("llama3.2-vision")) continue;
    const rawSize = typeof m.size_vram === "number" ? m.size_vram : 0;
    if (!Number.isFinite(rawSize)) continue;
    const residual = Math.max(0, rawSize);
    if (residual > max) max = residual;
  }
  return max;
}

/**
 * Issue a single HTTP GET `/api/ps` against `ollamaUrl` with a per-attempt
 * `timeoutMs` budget (clamped to {@link POLL_VRAM_MIN_ATTEMPT_TIMEOUT_MS}).
 *
 * Returns:
 *   - `observedSuccessfully=true`  on 2xx + valid JSON (residual from `extractMaxResidual`)
 *   - `observedSuccessfully=false` on non-2xx, malformed JSON, or fetch throw
 *     (`probeError` is `sanitizeErrorMessage`-sanitized; CWE-209 PII contract)
 *
 * IO Impl Decision V1 §5 sub-helper #2 — single I/O round-trip.
 *
 * 単一の `/api/ps` GET を発行し residual を抽出する helper。
 */
export async function attemptVramProbe(
  ollamaUrl: string,
  timeoutMs: number
): Promise<VramProbeAttemptResult> {
  const clampedTimeout = Math.max(
    POLL_VRAM_MIN_ATTEMPT_TIMEOUT_MS,
    Number.isFinite(timeoutMs) ? timeoutMs : POLL_VRAM_MIN_ATTEMPT_TIMEOUT_MS
  );
  try {
    const psResponse = await fetch(`${ollamaUrl}/api/ps`, {
      method: "GET",
      signal: AbortSignal.timeout(clampedTimeout),
    });
    if (!psResponse.ok) {
      // HTTP status responses carry no PII risk (status code is a server-side
      // contract identifier, not user data). Test contract:
      // `probeError.toMatch(/HTTP 503/)` requires verbatim status surface,
      // so we skip `sanitizeErrorMessage()` for the HTTP-not-OK branch.
      // CWE-209 PII contract is enforced separately on the network-error
      // branch where stack frames could surface.
      return {
        observedSuccessfully: false,
        attemptResidual: 0,
        probeError: `Ollama /api/ps returned HTTP ${psResponse.status}`,
      };
    }
    const data = (await psResponse.json()) as {
      models?: Array<{ name?: string; size_vram?: number }> | null;
    };
    const models = Array.isArray(data.models) ? data.models : [];
    return {
      observedSuccessfully: true,
      attemptResidual: extractMaxResidual(models),
    };
  } catch (err) {
    return {
      observedSuccessfully: false,
      attemptResidual: 0,
      probeError: sanitizeErrorMessage(err),
    };
  }
}

/**
 * Orchestrate the retry loop for `/api/ps` polling against `ollamaUrl`.
 *
 * Behaviour:
 *   - Issue up to `attempts` probes (each via {@link attemptVramProbe}).
 *   - `intervalMs` delay between probes; no delay after the final attempt.
 *   - When any attempt observes residual=0, return early (`attemptsUsed`
 *     reflects only the attempts actually executed).
 *   - `maxResidualBytes` preserved across all successful attempts.
 *   - `observedSuccessfully=true` iff at least one attempt succeeded.
 *   - `probeError` set to the most recent sanitized error (preserved only when
 *     no attempt succeeded; cleared once any attempt succeeds).
 *
 * IO Impl Decision V1 §5 sub-helper #3 — retry loop orchestrator.
 *
 * `attemptVramProbe()` を `attempts` 回まで実行し、max residual を集約する。
 */
export async function pollWithBudget(
  ollamaUrl: string,
  deadlineMs: number,
  attempts: number,
  intervalMs: number
): Promise<VramPollResult> {
  let max = 0;
  let observedSuccessfully = false;
  let probeError: string | undefined;
  let attemptsUsed = 0;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    attemptsUsed = i + 1;
    const r = await attemptVramProbe(ollamaUrl, deadlineMs);
    if (r.observedSuccessfully) {
      observedSuccessfully = true;
      probeError = undefined;
      if (r.attemptResidual > max) max = r.attemptResidual;
      if (r.attemptResidual === 0) break; // early-return on confirmed unload
    } else if (!observedSuccessfully) {
      // Preserve the most recent error only while no attempt has succeeded.
      probeError = r.probeError;
    }
  }

  return {
    maxResidualBytes: observedSuccessfully ? max : 0,
    observedSuccessfully,
    attemptsUsed,
    ...(probeError !== undefined && !observedSuccessfully ? { probeError } : {}),
  };
}

/**
 * `pollVramResidual()` — env-aware convenience wrapper around
 * {@link pollWithBudget} that resolves `OLLAMA_HOST` via
 * `validateOllamaLocalhostUrl()` (SSRF defence).
 *
 * IO Impl Decision V1 §5 parent — used by `unloadOllamaVisionModelAndVerify()`.
 *
 * 環境変数 `OLLAMA_HOST` を解決した上で `pollWithBudget()` を呼ぶ wrapper。
 */
export async function pollVramResidual(
  deadlineMs: number,
  attempts: number,
  intervalMs: number
): Promise<VramPollResult> {
  const ollamaUrl = validateOllamaLocalhostUrl(process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);
  return pollWithBudget(ollamaUrl, deadlineMs, attempts, intervalMs);
}

/**
 * `unloadOllamaVisionModelAndVerify()` — unload Ollama Vision + verify residual
 * via `/api/ps` polling (Plan v3 T3-Vision V1 §3.1 Layer 1, §4.1 INV-VISION-UNLOAD-001).
 *
 * Behaviour:
 *   1. POST `/api/generate keep_alive=0` (capture 2xx ack in `unloadAckReceived`).
 *   2. Poll `/api/ps` up to {@link VISION_PROBE_ATTEMPTS} times with
 *      {@link VISION_PROBE_INTERVAL_MS} delay; locate Vision residual
 *      (`name.startsWith("llama3.2-vision")` AND `size_vram > 0`, NaN-defended).
 *      Exit polling early when residual == 0 (success path).
 *   3. Emit one of:
 *      - `vision_unload_verified`          (residualBytes === 0, "success")
 *      - `vision_unload_residual_persisted` (residualBytes > 0,  "failure")
 *      via `emitSupervisorAuditLog()` SSOT.
 *   4. If the emit throws, log `[SLO_MARKER] vision_unload_audit_emit_failed`
 *      with a PII-safe payload (`reason`, `residualBytes`, `model`) and continue
 *      (L1.5 fail-open compensation).
 *
 * Probe trumps POST: if POST returns 5xx but `/api/ps` later shows
 * `size_vram == 0`, `unloaded=true` (Case C in the standing regression).
 *
 * @returns {@link VisionUnloadVerifyResult} — discriminated outcome.
 */
export async function unloadOllamaVisionModelAndVerify(): Promise<VisionUnloadVerifyResult> {
  const startedAtMs = Date.now();
  const ollamaUrl = validateOllamaLocalhostUrl(process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);

  // --------------------------------------------------------------------------
  // Step 1: POST /api/generate keep_alive=0 (legacy unload path).
  // --------------------------------------------------------------------------
  let unloadAckReceived = false;
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL_NAME,
        keep_alive: "0",
        prompt: "",
      }),
      signal: AbortSignal.timeout(OLLAMA_UNLOAD_TIMEOUT_MS),
    });
    unloadAckReceived = response.ok;
  } catch {
    // Network / timeout failure on POST tolerated — probe will determine
    // residual independently (probe trumps POST per Case C).
    unloadAckReceived = false;
  }

  // --------------------------------------------------------------------------
  // Step 2: Poll /api/ps (up to VISION_PROBE_ATTEMPTS) for residual via
  //         pollWithBudget() (IO Impl Decision V1 §5 sub-helper #3).
  // --------------------------------------------------------------------------
  const pollResult = await pollWithBudget(
    ollamaUrl,
    VISION_PROBE_ATTEMPT_TIMEOUT_MS,
    VISION_PROBE_ATTEMPTS,
    VISION_PROBE_INTERVAL_MS
  );
  const probeAttempted = pollResult.attemptsUsed > 0;
  const residualBytes = pollResult.maxResidualBytes;
  const lastProbeSucceeded = pollResult.observedSuccessfully;
  const probeError = pollResult.probeError;

  // --------------------------------------------------------------------------
  // Step 3: Build result + emit audit_logs (fail-open per L1.5 SLO_MARKER).
  // --------------------------------------------------------------------------
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const unloaded = lastProbeSucceeded && residualBytes === 0;
  const model = OLLAMA_VISION_MODEL_NAME;

  const auditAction = unloaded ? "vision_unload_verified" : "vision_unload_residual_persisted";
  const auditResult: "success" | "failure" = unloaded ? "success" : "failure";
  const auditDetails: Record<string, unknown> = {
    model,
    residualBytes,
  };
  try {
    emitSupervisorAuditLog(auditAction, "page", auditDetails, auditResult);
  } catch (emitErr) {
    // L1.5 SLO_MARKER fail-open compensation (Plan v3 T3-Vision V1 §1.3 U-T3V-3).
    // Caller behaviour unchanged; log line is a Grafana Loki-monitorable source.
    const reason = sanitizeErrorMessage(emitErr);
    console.error("[SLO_MARKER] vision_unload_audit_emit_failed", {
      reason,
      residualBytes,
      model,
    });
  }

  const result: VisionUnloadVerifyResult = {
    unloaded,
    residualBytes,
    probeAttempted,
    unloadAckReceived,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    ...(probeError !== undefined && !lastProbeSucceeded ? { probeError } : {}),
  };
  return result;
}

// ============================================================================
// Memory Utilities
// ============================================================================

/**
 * Attempt to trigger garbage collection if --expose-gc flag is available.
 * Returns true if GC was triggered, false otherwise.
 */
export function tryGarbageCollect(): boolean {
  if (typeof global.gc === "function") {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Check current memory pressure.
 * Returns whether degradation or abort is recommended.
 * Lazily initializes memory constants if not yet resolved.
 *
 * P0-D: heapUsedMb チェック追加。heapUsed が maxOldSpaceSize の 80% を超えた場合も
 * shouldAbort を true にする。maxOldSpaceSize は V8 の heap_size_limit から取得。
 *
 * P0-D: Added heapUsedMb check. shouldAbort is also true when heapUsed exceeds
 * 80% of maxOldSpaceSize, obtained from V8 heap_size_limit.
 */
export function checkMemoryPressure(): {
  shouldDegrade: boolean;
  shouldAbort: boolean;
  rssMb: number;
  heapUsedMb: number;
} {
  // Safety net: ensure memory constants are initialized before comparison
  initMemoryConstants();
  tryGarbageCollect();
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);

  // P0-D: V8 heap limit check (--max-old-space-size or default)
  const v8HeapStats = v8Module.getHeapStatistics();
  const maxOldSpaceMb = Math.round(v8HeapStats.heap_size_limit / 1024 / 1024);
  const heapAbort = heapUsedMb >= Math.round(maxOldSpaceMb * 0.8);

  return {
    shouldDegrade: rssMb >= MEMORY_DEGRADATION_THRESHOLD_MB,
    shouldAbort: rssMb >= MEMORY_CRITICAL_THRESHOLD_MB || heapAbort,
    rssMb,
    heapUsedMb,
  };
}

// ============================================================================
// Type-Aware Dedup Constants & Helper
// ============================================================================

const DEDUP_EXEMPT_MAX_HEIGHT = 200;
const DEDUP_EXEMPT_TYPES = new Set(["cta"]);

/**
 * Type-aware duplicate vision embedding detection.
 * Compares cosine similarity only within same sectionType.
 * CTA small sections (height <= 200px) are exempt.
 *
 * @returns true if the embedding is a duplicate and should be skipped
 */
export function isDuplicateVisionEmbedding(params: {
  sectionType: string;
  height: number;
  embedding: number[];
  recentEmbeddings: ReadonlyArray<{ embedding: number[]; sectionType: string }>;
  threshold: number;
}): boolean {
  if (DEDUP_EXEMPT_TYPES.has(params.sectionType) && params.height <= DEDUP_EXEMPT_MAX_HEIGHT) {
    return false;
  }

  return params.recentEmbeddings.some((prev) => {
    if (prev.sectionType !== params.sectionType) return false;
    let dot = 0;
    for (let i = 0; i < prev.embedding.length; i++) {
      dot += prev.embedding[i]! * params.embedding[i]!;
    }
    return Number.isFinite(dot) && dot > params.threshold;
  });
}

// ============================================================================
// Section Crop Buffer Acquisition (TDA HIGH-1)
// ============================================================================

export interface AcquireSectionCropParams {
  /** section_pattern_id */
  sectionPatternId: string;
  /** セクションの位置情報 */
  sectionPos: { startY: number; height: number };
  /** スクリーンショットバッファ */
  screenshotBuffer: Buffer;
  /** 画像の幅 */
  imgWidth: number;
  /** 画像の高さ */
  imgHeight: number;
  /** 事前バッチキャプチャ済み Map */
  fallbackScreenshots: Map<string, Buffer>;
  /** フォールバック有効フラグ */
  fallbackEnabled: boolean;
  /** DINOv2入力サイズ */
  dinov2InputSize: number;
}

export interface AcquireSectionCropResult {
  /** DINOv2用 raw crop バッファ（null の場合はスキップ） */
  rawCropBuffer: Buffer | null;
  /** 白画像として検出されたか */
  isBlank: boolean;
}

export async function acquireSectionCropBuffer(
  params: AcquireSectionCropParams
): Promise<AcquireSectionCropResult> {
  const {
    sectionPatternId,
    sectionPos,
    screenshotBuffer,
    imgWidth,
    imgHeight,
    fallbackScreenshots,
    fallbackEnabled,
    dinov2InputSize,
  } = params;

  const sectionTop = Math.max(0, Math.round(sectionPos.startY));
  const sectionCropWidth = Math.max(1, imgWidth);
  const sectionCropHeight = Math.min(
    Math.round(sectionPos.height),
    Math.max(1, imgHeight - sectionTop)
  );

  if (sectionCropWidth <= 0 || sectionCropHeight <= 0) {
    return { rawCropBuffer: null, isBlank: false };
  }

  if (sectionTop >= imgHeight) {
    // screenshotBase64範囲外 → バッチ事前キャプチャ済み Map から取得
    if (!fallbackEnabled) {
      return { rawCropBuffer: null, isBlank: false };
    }

    const fb = fallbackScreenshots.get(sectionPatternId);
    if (!fb) {
      return { rawCropBuffer: null, isBlank: true };
    }

    const rawCropBuffer = await sharp(fb)
      .resize(dinov2InputSize, dinov2InputSize, { fit: "cover", kernel: "cubic" })
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer();

    fallbackScreenshots.delete(sectionPatternId);
    return { rawCropBuffer, isBlank: false };
  }

  // 既存パス: screenshotBase64 から Sharp crop
  const sectionLeft = 0;

  const croppedPngBuffer = await sharp(screenshotBuffer)
    .extract({
      left: sectionLeft,
      top: sectionTop,
      width: sectionCropWidth,
      height: sectionCropHeight,
    })
    .png()
    .toBuffer();

  const blank = await isBlankImage(croppedPngBuffer);
  if (blank) {
    return { rawCropBuffer: null, isBlank: true };
  }

  const rawCropBuffer = await sharp(croppedPngBuffer)
    .resize(dinov2InputSize, dinov2InputSize, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer();

  return { rawCropBuffer, isBlank: false };
}

// ============================================================================
// Lock Extension Utilities
// ============================================================================

/**
 * Create a lock extender that periodically extends the BullMQ job lock.
 */
export function createLockExtender(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token: string,
  lockDuration: number,
  intervalMs: number = DEFAULT_LOCK_EXTEND_INTERVAL
): LockExtender {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  return {
    start: (): void => {
      if (intervalId !== null) {
        return;
      }

      if (isDevelopment()) {
        logger.info("[PageAnalyzeWorker] Starting lock extender", {
          jobId: job.id,
          lockDuration,
          intervalMs,
        });
      }

      intervalId = setInterval(() => {
        job
          .extendLock(token, lockDuration)
          .then(() => {
            if (isDevelopment()) {
              logger.debug("[PageAnalyzeWorker] Lock extended successfully", {
                jobId: job.id,
                lockDuration,
              });
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("[PageAnalyzeWorker] Lock extension failed", {
              jobId: job.id,
              error: message,
            });
          });
      }, intervalMs);

      if (intervalId && typeof intervalId === "object" && "unref" in intervalId) {
        intervalId.unref();
      }
    },
    stop: (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;

        if (isDevelopment()) {
          logger.debug("[PageAnalyzeWorker] Lock extender stopped", {
            jobId: job.id,
          });
        }
      }
    },
  };
}

/**
 * Extend job lock at phase boundaries (explicit, one-shot extension).
 */
export async function extendJobLock(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token: string,
  lockDuration: number,
  phaseName: string
): Promise<void> {
  try {
    await job.extendLock(token, lockDuration);
    if (isDevelopment()) {
      logger.debug("[PageAnalyzeWorker] Lock extended at phase boundary", {
        jobId: job.id,
        phaseName,
        lockDuration,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[PageAnalyzeWorker] Lock extension failed at phase boundary", {
      jobId: job.id,
      phaseName,
      error: message,
    });
  }
}

// ============================================================================
// Phase Progress Interpolation
// ============================================================================

/**
 * Create a progress interpolator for reporting granular progress within a phase.
 */
export function createPhaseProgressInterpolator(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  phaseStart: number,
  phaseEnd: number
): (completed: number, total: number) => void {
  const range = phaseEnd - phaseStart;
  return (completed: number, total: number): void => {
    if (total <= 0) return;
    const ratio = Math.max(0, Math.min(completed / total, 1));
    const interpolated = Math.round(phaseStart + range * ratio);
    if (!Number.isFinite(interpolated)) return;
    job.updateProgress(interpolated).catch(() => {
      /* fire-and-forget */
    });
  };
}

// ============================================================================
// JS Animation Text Representation
// ============================================================================

/**
 * JSアニメーションからEmbedding用テキスト表現を生成
 */
export function generateJsAnimationTextRepresentation(
  originalId: string,
  jsAnimations: JSAnimationFullResult
): string {
  const parts: string[] = [];

  const cdpAnim = jsAnimations.cdpAnimations.find((a) => a.id === originalId);
  const webAnim = jsAnimations.webAnimations.find((a) => a.id === originalId);

  if (cdpAnim) {
    parts.push(`JavaScript animation: ${cdpAnim.name || cdpAnim.type}`);
    parts.push(`Type: ${cdpAnim.type}`);
    if (cdpAnim.source.duration > 0) {
      parts.push(`Duration: ${Math.round(cdpAnim.source.duration)}ms`);
    }
    if (cdpAnim.source.easing) {
      parts.push(`Easing: ${cdpAnim.source.easing}`);
    }
    parts.push(`Play state: ${cdpAnim.playState}`);
  } else if (webAnim) {
    parts.push(`JavaScript animation: WebAnimation on ${webAnim.target.slice(0, 100)}`);
    parts.push(`Type: Web Animations API`);
    if (webAnim.timing.duration > 0) {
      parts.push(`Duration: ${Math.round(webAnim.timing.duration)}ms`);
    }
    if (webAnim.timing.easing) {
      parts.push(`Easing: ${webAnim.timing.easing}`);
    }
    if (webAnim.timing.iterations > 1) {
      parts.push(`Iterations: ${webAnim.timing.iterations}`);
    }
    if (webAnim.keyframes.length > 0) {
      const propNames = new Set<string>();
      for (const kf of webAnim.keyframes) {
        for (const key of Object.keys(kf)) {
          if (!["offset", "easing", "composite"].includes(key)) {
            propNames.add(key);
          }
        }
      }
      if (propNames.size > 0) {
        parts.push(`Properties: ${Array.from(propNames).join(", ")}`);
      }
    }
    parts.push(`Play state: ${webAnim.playState}`);
  } else {
    parts.push(`JavaScript animation: pattern ${originalId}`);
  }

  const detectedLibs: string[] = [];
  if (jsAnimations.libraries.gsap.detected) detectedLibs.push("GSAP");
  if (jsAnimations.libraries.framerMotion.detected) detectedLibs.push("Framer Motion");
  if (jsAnimations.libraries.anime.detected) detectedLibs.push("anime.js");
  if (jsAnimations.libraries.three.detected) detectedLibs.push("Three.js");
  if (jsAnimations.libraries.lottie.detected) detectedLibs.push("Lottie");
  if (detectedLibs.length > 0) {
    parts.push(`Libraries: ${detectedLibs.join(", ")}`);
  }

  return `passage: ${parts.join(". ")}.`;
}

// ============================================================================
// JS Animation Embedding Chunk Save
// ============================================================================

/**
 * JSAnimationEmbeddingのチャンクをDBに一括保存
 */
export async function saveJsAnimationEmbeddingChunk(
  chunk: ReadonlyArray<{
    originalId: string;
    dbId: string;
    textRepresentation: string;
    embedding: number[];
  }>,
  prismaClient: { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> } & {
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
): Promise<number> {
  if (chunk.length === 0) {
    return 0;
  }

  const createData = chunk.map((item) => ({
    jsAnimationPatternId: item.dbId,
    textRepresentation: item.textRepresentation,
    modelVersion: "multilingual-e5-base",
  }));

  await (
    prismaClient as unknown as JsAnimationEmbeddingPrismaClient
  ).jSAnimationEmbedding.createMany({
    data: createData,
  });

  const vectorUpdates = chunk.filter((item) => item.embedding.length > 0);
  if (vectorUpdates.length > 0) {
    const valuesClause = vectorUpdates
      .map((_, idx) => `($${idx * 2 + 1}::vector, $${idx * 2 + 2}::uuid)`)
      .join(", ");

    const params: unknown[] = [];
    for (const item of vectorUpdates) {
      params.push(`[${item.embedding.join(",")}]`);
      params.push(item.dbId);
    }

    await prismaClient.$executeRawUnsafe(
      `UPDATE js_animation_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, pattern_id) WHERE e.js_animation_pattern_id = v.pattern_id`,
      ...params
    );
  }

  return chunk.length;
}
