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
] as const;

/**
 * Embedding phase スキップ理由の型 / Type of embedding phase skip reason
 */
export type EmbeddingSkipReason = (typeof EMBEDDING_SKIP_REASONS)[number];

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
