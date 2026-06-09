// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - BullMQ Worker for Async Page Analysis
 *
 * Phase3-2: Handles heavy page analysis jobs asynchronously.
 * Designed for WebGL-heavy sites (Linear, Vercel, Notion) that may timeout
 * in synchronous processing.
 *
 * Configuration:
 * - concurrency: 1 (singleton browser, avoid race condition)
 * - lockDuration: 2400000ms (40 min, extended for CPU-bound embedding phase), configurable via BULLMQ_LOCK_DURATION
 * - attempts: 1 (no retries for WebGL sites)
 *
 * Lock Extension Strategy (Hybrid Approach):
 * BullMQ v5.x provides automatic lock renewal via lockRenewTime (default: lockDuration/2).
 * However, CPU-bound processing (e.g., Ollama Vision 10.7B) may block the event loop,
 * preventing timer-based renewal. This module adds:
 * 1. createLockExtender: setInterval-based periodic lock extension (secondary protection)
 * 2. extendJobLock: explicit lock extension at async phase boundaries
 * Together they provide dual-layer stall prevention for long-running jobs (30+ minutes).
 *
 * Architecture (v0.3.0+, Phase 1/3 sequential):
 * This file is a thin orchestrator. Phase logic lives in ./phases/:
 *   phase-0-ingest.ts  — HTML ingest + WebPage DB save
 *   phase-1-layout.ts  — Layout Analysis + Part Extraction        ┐ sequential
 *   phase-3-quality.ts — Quality Evaluation                       ┘ (Layout → Quality)
 *   phase-2-motion.ts  — Scroll Vision + Motion Detection + Scroll Vision Analysis
 *   phase-4-narrative.ts — Narrative Analysis + Responsive Analysis
 *   phase-5-embedding.ts — Embedding Generation (text + visual)
 * Shared types/constants/helpers are in ./phases/types.ts.
 *
 * Note: Phase 1/3 were parallelized via Promise.all in v0.2.0, but changed to
 * sequential execution in v0.3.0. Quality P50=0.02ms makes parallelism pointless,
 * and sequential execution improves memory efficiency by avoiding dual allocation.
 *
 * Environment Variables:
 * - BULLMQ_LOCK_DURATION: Lock duration in ms (default: 2400000)
 * - BULLMQ_LOCK_EXTEND_INTERVAL_MS: Lock extend interval in ms (default: 300000)
 *
 * @module workers/page-analyze-worker
 */

import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { getRedisConfig } from "../config/redis";
import {
  PAGE_ANALYZE_QUEUE_NAME,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type AnalysisPhase,
} from "../queues/page-analyze-queue";
import { ExecutionStatusTrackerV2 } from "../tools/page/handlers/execution-status-tracker";
import { logger, isDevelopment } from "../utils/logger";
import { prisma } from "@reftrixmcp/database";

// Service handlers (same as used in page.analyze synchronous mode)
import { defaultAnalyzeLayout } from "../tools/page/handlers/layout-handler";
import { defaultDetectMotion } from "../tools/page/handlers/motion-handler";
import { defaultEvaluateQuality } from "../tools/page/handlers/quality-handler";
import { pageIngestAdapter } from "../services/page-ingest-adapter";
import { saveBackgroundDesigns } from "../services/background/background-design-db.service";
import { handleNarrativeAnalysis } from "../tools/page/handlers/narrative-handler";
import { createSnapshot as createDesignSnapshot } from "../services/design-change-tracker.service";
// Phase 7.5: Accessibility + Performance (v0.3.0)
import {
  handleAccessibilityPhase,
  handlePerformancePhase,
} from "../tools/page/handlers/sync-phase-handlers-tier2";
// Scroll Vision Smart Capture
import { captureScrollPositions } from "../services/vision/scroll-vision-capture.service";
import { analyzeScrollCaptures } from "../services/vision/scroll-vision.analyzer";
import { saveScrollVisionResults } from "../services/vision/scroll-vision-persistence.service";
// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え
import { GpuResourceManager, gpuModeSignal } from "../services/gpu-resource-manager";
// Responsive Analysis
import { responsiveAnalysisService, responsivePersistenceService } from "../services/responsive";
import { validateExternalUrl } from "../utils/url-validator";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
// EmbeddingService singleton for GPU provider switching (switchProvider/releaseGpu)
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
// DB保存ロジック（SectionPattern, MotionPattern, QualityEvaluation, JSAnimationPattern）
import {
  saveSectionPatterns,
  saveMotionPatterns,
  saveQualityEvaluation,
  saveQualityBenchmarks,
  buildQualityBenchmarkInputs,
  saveJsAnimationPatterns,
} from "../services/worker-db-save.service";
// Section Merge/Split Post-Processor（過剰分割修正 + 巨大セクション再分割）
import { postProcessSections } from "../services/page/section-postprocessor.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// Plan v3 Track T4 (PR-V3-T4) — Pre-Return Pause failure-path race closure
// Plan v3 Track T4 (PR-V3-T4) — Pre-Return Pause failure-path race closure
import {
  markFailedAndAuditAtomic,
  type PhaseN,
  type FailurePathPrismaClient,
} from "../services/worker-supervisor-failure-path.service";
// Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — INV-WORKER-PID-IDENTITY-005
// write/clear hooks (Sub-A / Sub-B). recordWorkerSpawn writes the
// `worker_job_lifecycle` row at job start; recordWorkerRelease writes the
// paired `event_type='release'` row before planned exit (success or failure).
//
// UNBLOCK-T4-02: write/clear hook callsites for INV-WORKER-PID-IDENTITY-005.
import {
  recordWorkerRelease,
  recordWorkerSpawn,
  type WorkerJobLifecyclePrismaClient,
} from "../services/worker-supervisor-helpers";
import { readSupervisorInjectedSpawnTimeMs } from "./worker-ipc-spawn-recorded.schema";
// Embedding generation (reuse from synchronous flow)
import {
  setBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  setMotionLayoutEmbeddingServiceFactory,
} from "../tools/page/handlers/embedding-handler";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../services/layout-embedding.service";
import { setFramePrismaClientFactory } from "../services/motion/frame-embedding.service";

// Worker Memory Self-Monitoring（OOM防止用）
// v0.4.0 PR7c: applyPostJobMemoryGate が memory check を内包するため
// performMemoryCheckAndExit の直接参照は削除。
// v0.4.0 PR7c: Direct import removed — memory check is now performed inside
// applyPostJobMemoryGate.
// Part Extraction (Phase 1.1)
import { extractPartsFromSection } from "../services/part/part-extraction.service";
import { saveExtractedParts } from "../services/part/part-db.service";
// Dynamic memory thresholds: lazy initialization via initMemoryConstants()
// Stall recovery: BullMQ stalled event handler + periodic check
import {
  handleStalledJob,
  recoverOrphanedJobs,
  createPeriodicStallCheck,
  type OrphanedJobInfo,
  type StalledJobAccessor,
} from "../services/worker-stall-recovery.service";
import { createPageAnalyzeQueue } from "../queues/page-analyze-queue";
// SEC-M2: 安全な環境変数パース
import { safeParseInt } from "../utils/safe-parse-int";
// Frame Analysis DB保存ヘルパー（同期/非同期モード共有）
import { saveFrameAnalysisToDb } from "../services/motion/frame-analysis-save.helper";
// PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged)
// W0 で URL を正規化するため同じ util を再利用する。
// PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged).
// W0 uses the same URL normalizer as W1 for deterministic upsert keys.
import { normalizeUrlForStorage } from "../utils/url-normalizer";

// ============================================================================
// Phase Module Imports (TDA-C1 refactoring)
// ============================================================================
import {
  type PipelineState,
  type PhaseContext,
  type PageAnalyzeWorkerOptions,
  type PageAnalyzeWorkerInstance,
  type EmbeddingSkipReason,
  PHASE_PROGRESS,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_EXTEND_INTERVAL,
  DEFAULT_CONCURRENCY,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  EMBEDDING_CHUNK_SIZE,
  initMemoryConstants,
  checkMemoryPressure,
  tryGarbageCollect,
  createLockExtender,
  extendJobLock,
  createPhaseProgressInterpolator,
  generateJsAnimationTextRepresentation,
  unloadOllamaVisionModel,
  truncateSkipDetail,
} from "./phases/types";
import { processIngestPhase } from "./phases/phase-0-ingest";
// v0.4.0 PR7e-α (バグ④ fix): PhasedDbHandler で analysisPhaseStatus /
// analysisStartedAt を遷移させる。従来は page-analyze-worker が直接
// analysisStatus 等を update していたため、Product API が必要とする
// `analysis_phase_status` / `analysis_started_at` カラムが常に pending /
// null のままだった。
// v0.4.0 PR7e-α (bug ④ fix): integrate PhasedDbHandler so
// `analysis_phase_status` / `analysis_started_at` advance correctly (they
// used to remain `pending` / NULL forever because the inline update path
// only touched `analysis_status` / `analysis_completed_at`).
import { PhasedDbHandler } from "../tools/page/handlers/phased-db-handler";
import { createScreenshotPersistenceService } from "../services/screenshot-persistence.service";
import {
  applyPostJobMemoryGate,
  registerCompletedListenerAndExit,
} from "./shared/post-job-lifecycle";
import { processLayoutPhase } from "./phases/phase-1-layout";
import { processMotionPhase } from "./phases/phase-2-motion";
import { processQualityPhase } from "./phases/phase-3-quality";
import { processNarrativePhase } from "./phases/phase-4-narrative";
import { dispatchEmbeddingPhase } from "./phases/phase-5-embedding";

// v0.4.0 PR4: Queue-based backfill for Part text / visual embedding overflow
// v0.4.0 PR4: 100 件を超える Part embedding をキュー経由で非同期バックフィル
//
// v0.4.0 PR7b: Skip recovery 経路で全 7 カテゴリを enqueue するため SSOT 配列
// `EMBEDDING_BACKFILL_CATEGORIES` と back-pressure / memory_pressure delay の
// ヘルパーを追加 import する。
//
// v0.4.0 PR7b: Adds the SSOT array `EMBEDDING_BACKFILL_CATEGORIES`,
// back-pressure check, and memory-pressure delay resolver for the skip-recovery
// path that enqueues all 7 categories.
import {
  createEmbeddingBackfillQueue,
  addEmbeddingBackfillJobWithGuard,
  checkBackfillQueueBackPressure,
  resolveMemoryPressureDelayMs,
  EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
  EMBEDDING_BACKFILL_CATEGORIES,
  SKIP_RECOVERY_RETRY_CAP,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";
import { enqueueAllCategoriesForSkipRecovery } from "../queues/embedding-backfill-processors";
import type { Queue } from "bullmq";

// v0.4.0 PR6 TDA TD-1/TD-3: raw count util と backfillPending builder を抽出
// v0.4.0 PR6 TDA TD-1/TD-3: extracted raw count util and backfillPending builder
// v0.4.0 PR7b (ADR-0008 #7): skip_recovery variant の builder も追加
// v0.4.0 PR7b (ADR-0008 #7): also import skip_recovery variant builder
import { countNonNullVector } from "../utils/prisma-raw-count";
import {
  buildBackfillPending,
  buildSkipRecoveryBackfillPending,
  isBackfillPendingSourceConflict,
} from "../services/backfill-pending.builder";

// PR-C2 (Layer 2, ADR-0007 Amendment 3): relocate BOTH backfill enqueue paths
// (sync_overflow + skip_recovery) to AFTER markAnalysisCompleted so the analysis
// guard sees a terminal status and returns `proceed` (re_enqueue churn removed
// from the happy path). The ordering orchestration is a dedicated CC≤10 leaf so
// it can be machine-enforced via the scope-limited eslint complexity override
// without adding the 3470-LoC worker file (TDA-RE-M-01 / plan §3.4).
//
// PR-C2 (Layer 2, ADR-0007 Amendment 3): markComplete 後へ両 backfill enqueue path
// を移動する relocation leaf (CC≤10、eslint complexity override IN)。
import { enqueueBackfillAfterMarkComplete } from "./phases/backfill-enqueue-relocation";

// PR-PART30CAP (ADR-0007 Amendment 2): dual-trigger enqueue 用の 1-call pending
// snapshot 再利用。parts≤100 の inline partial-completion residual を
// `hasPendingParts` bool として resolver に渡すため、終端 parity gate と同じ
// helper を dispatch 前に 1 回だけ呼ぶ (N+1 なし、§3.3 SEC-M-01 10RPM bound)。
//
// PR-PART30CAP (ADR-0007 Amendment 2): reuse the 1-call pending snapshot for the
// dual-trigger enqueue. Calls the same helper used by the terminal parity gate
// once before dispatch (no N+1, §3.3 SEC-M-01 10RPM bound) to derive the
// `hasPendingParts` bool passed into the resolver for parts≤100 inline
// partial-completion residuals.
import { collectCategoryPendingSnapshot } from "../services/backfill-status.helper";

// v0.4.0 PR7b: Phase 5 親 RSS upstream guard
// v0.4.0 PR7b: Phase 5 parent RSS upstream guard
// PR-V3-T1a: parent_rss_ceiling_scaled audit emission helper
import { emitParentRssCeilingScaledIfApplicable, loadPhase5Config } from "../config/phase5-config";

// v0.4.0 PR7b: retry cap 超過時の audit log
// v0.4.0 PR7b: audit log when retry cap is exceeded
import {
  AUDIT_LOG_CONSTANTS,
  getAuditLogService,
  truncateAuditTargetId,
} from "../services/audit-log.service";

// PR-V3-T1a: parent_rss_ceiling_scaled audit action SSOT constant
import { AUDIT_ACTION_PARENT_RSS_CEILING_SCALED } from "../audit/audit-actions";
import { trimParentRssAndDecide } from "./phases/phase5-parent-rss-trim";

// ============================================================================
// Embedding DI factories initialization
// ============================================================================
// Worker runs in a separate process; factories must be set before use
// Single shared ONNX session to prevent memory leak from repeated LayoutEmbeddingService creation
// P0-1: All embedding sub-phases (Section, Motion, Background, JSAnimation) share this singleton
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);

// v0.4.0: Screenshot 永続化サービスのワーカー内シングルトン
// v0.4.0: Worker-local singleton of the screenshot persistence service
//
// Phase 0（保存）と Phase 5 fork orchestrator（cleanup）の両方から参照される。
// 環境変数 `REFTRIX_SCREENSHOT_ROOT` を内部で解決するため、ここでは prisma のみを注入する。
//
// Shared by Phase 0 (save) and Phase 5 fork orchestrator (cleanup).
// Resolves `REFTRIX_SCREENSHOT_ROOT` internally, so only prisma is injected here.
const screenshotPersistenceService = createScreenshotPersistenceService({
  prisma: prisma as never,
});
setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setBackgroundPrismaClientFactory(() => prisma as never);
setFramePrismaClientFactory(() => prisma as never);

// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え (singleton)
const gpuResourceManager = GpuResourceManager.getInstance();

// ============================================================================
// Post-Job Memory Gate: WORKER_MAX_JOBS_BEFORE_RESTART 駆動の RSS ゲート
// ============================================================================
//
// v0.4.0 PR7e-β2 hotfix で pause/resume 経路は完全削除され、post-job ライフ
// サイクルは「RSS 閾値超過 → process.exit(0)」のみを残した（ADR-0009 参照）。
// `fetchNext=false` の保証は BullMQ 側の `moveToCompleted` Lua スクリプトが
// 担うため、Worker 側で pause を呼ぶ必要はなく、本 gate は concurrency 非依存。
//
// v0.4.0 PR7e-β2 audit carryover: helper を
// `applyPostJobMemoryGate(enabled, loggerPrefix)` にリネームし、使われなくなった
// `workerRef` 引数とモジュール変数 `_workerInstanceRef` を削除した。
//
// v0.4.0 PR7e-β2 hotfix removed the pause/resume path entirely; the post-job
// lifecycle now keeps only the RSS gate ("RSS exceeds threshold → process.exit(0)").
// `fetchNext=false` is already guaranteed by BullMQ's `moveToCompleted` Lua
// script, so no Worker-side pause is needed and this gate is concurrency-neutral.
//
// v0.4.0 PR7e-β2 audit carryover: the helper was renamed to
// `applyPostJobMemoryGate(enabled, loggerPrefix)` and the obsolete `workerRef`
// argument plus the module-level `_workerInstanceRef` variable were removed.
// ============================================================================

/**
 * Whether the post-job memory gate is enabled (maxJobsBeforeRestart > 0).
 * Read from WORKER_MAX_JOBS_BEFORE_RESTART env var (default: 1).
 * When 0, the gate is disabled (unlimited jobs per process).
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

/**
 * Plan v1.1 candidate B / ADR-0034 Amendment 5: the module-level
 * `_workerInstanceRef` was used solely by the removed
 * `applyPostJobLifecycleGate(worker, ...)` callsite (success path
 * Pre-Return Pause). Stage 2 `worker.pause(true)` is formally removed
 * (ADR-0034 Amendment 5 §Decision 2-4), so the ref is no longer needed
 * and has been removed from the module.
 *
 * Plan v1.1 candidate B / ADR-0034 Amendment 5: the module-level
 * `_workerInstanceRef` was used solely by the removed
 * `applyPostJobLifecycleGate(worker, ...)` callsite (success path
 * Pre-Return Pause). Stage 2 `worker.pause(true)` is formally removed
 * (Amendment 5 §Decision 2-4); the ref is no longer needed and has been
 * removed from this module.
 */

/**
 * PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT feature flag.
 *
 * When `PHASE0_EARLY_INSERT=true`, the orchestrator upserts a minimal
 * `web_pages` row **before** calling `processIngestPhase`. This guarantees
 * that early failures during Phase 0 (robots.txt block / SSRF validation /
 * DNS NXDOMAIN etc.) still produce a DB row, so the failure-path
 * `markAnalysisFailed` → `prisma.webPage.update({where: {id: actualWebPageId}})`
 * does not hit P2025 on a missing row.
 *
 * Default: `false` (opt-in). Legacy behavior: the first DB write is the W1
 * upsert inside `processIngestPhase`, which never runs if Phase 0 throws.
 *
 * `PHASE0_EARLY_INSERT=true` の場合、オーケストレーターは `processIngestPhase`
 * を呼ぶ前に `web_pages` の最小行を upsert する (W0)。これにより Phase 0 の
 * 早期失敗 (robots.txt block / SSRF / DNS NXDOMAIN 等) でも DB 行が残り、
 * failure-path の `markAnalysisFailed` が P2025 で空振りしなくなる。
 *
 * デフォルト: `true` (opt-out)。PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6
 * §Decision 1 で default `false→true` に flip。Phase 0 fetch fail でも W0 が
 * 行を残し、failure-path url-key upsert が terminal `failed` を永続化する
 * (NOROW closure)。opt-out 経路 `PHASE0_EARLY_INSERT=false` は保持 (non-breaking)。
 *
 * Default: `true` (opt-out). Flipped `false→true` by PR-INGEST-FAIL-ROW /
 * ADR-0016 Amendment 6 §Decision 1 so Phase 0 fetch failures still leave a W0
 * row and the failure-path url-key upsert persists a terminal `failed` row
 * (NOROW closure). The opt-out path `PHASE0_EARLY_INSERT=false` is preserved
 * (non-breaking).
 */
function isPhase0EarlyInsertEnabled(): boolean {
  return process.env.PHASE0_EARLY_INSERT !== "false";
}

// Connect gpuModeSignal to the @reftrixmcp/ml EmbeddingService singleton.
// When GpuResourceManager requests a provider switch, the ONNX pipeline is
// disposed and re-initialized with the new execution provider (CPU/CUDA).
// We use mlEmbeddingService directly because LayoutEmbeddingService wraps
// IEmbeddingService which doesn't expose switchProvider/releaseGpu.
gpuModeSignal.onProviderSwitch = async (provider: "cpu" | "cuda"): Promise<void> => {
  if (provider === "cuda") {
    await mlEmbeddingService.switchProvider("cuda");
  } else {
    await mlEmbeddingService.releaseGpu();
  }
};

// ============================================================================
// Dynamic Memory Configuration (lazy initialization via initMemoryConstants)
// ============================================================================
// L-3 fix: moved from module-level resolveMemoryConfig() to lazy init.
// Constants in types.ts are updated on first call to initMemoryConstants().
initMemoryConstants();

// ============================================================================
// v0.4.0 PR4: Queue-based Backfill Dispatch
// ============================================================================

/**
 * Part text / visual embedding の同期処理閾値（件数）。
 * これを超えたページでは Phase 5 は先頭 `PART_SYNC_THRESHOLD` 件のみ処理し、
 * 残りは `embedding-backfill` Queue に投入する。
 *
 * Synchronous processing threshold (number of Parts) for Part text / visual
 * embedding. When a page exceeds this, Phase 5 processes only the first
 * `PART_SYNC_THRESHOLD` items and enqueues the remainder on the
 * `embedding-backfill` Queue.
 *
 * 環境変数 `EMBEDDING_SYNC_PART_LIMIT` で上書き可能（10〜1000 の範囲で clamp、
 * デフォルト 100）。TPA #1 (v0.4.0 PR4 audit) によりハードコードから env var
 * 化した。大型ページで同期 100 件を待たずに全件バックフィルへ回したい場合は
 * 10 程度に、オフラインバッチで全件同期処理したい場合は 1000 に設定する。
 *
 * Configurable via `EMBEDDING_SYNC_PART_LIMIT` env var (clamped to 10–1000,
 * default 100). Promoted from hardcoded constant to env var per TPA #1
 * (v0.4.0 PR4 audit). Set to ~10 to push most work to the backfill queue for
 * large pages, or 1000 to keep everything inline in offline batch runs.
 */
const PART_SYNC_THRESHOLD = safeParseInt(process.env["EMBEDDING_SYNC_PART_LIMIT"], 100, {
  min: 10,
  max: 1000,
});

/**
 * PR5 (v0.4.0): MCP response `backfillPending.estimatedCompletionAt` 算出用の
 * 1 件あたり平均処理時間（ms）。実測ではなく best-effort のヒューリスティック。
 *
 * Average per-item processing time (ms) used to estimate
 * `backfillPending.estimatedCompletionAt` in the MCP response (PR5 v0.4.0).
 * Best-effort heuristic — not a measured value.
 *
 * `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` で上書き可能（100〜60000ms で clamp、
 * デフォルト 5000ms）。MCP client がポーリング間隔を決める際の参考値。
 * Configurable via `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` (clamped to
 * 100–60000ms, default 5000ms). Intended as a polling-interval hint for
 * MCP clients.
 */
const BACKFILL_AVG_MS_PER_ITEM = safeParseInt(
  process.env["EMBEDDING_BACKFILL_AVG_MS_PER_ITEM"],
  5000,
  { min: 100, max: 60000 }
);

/**
 * Module-level lazy-initialized backfill queue.
 * Keeping it lazy avoids Redis connections when Queue-based Backfill is not needed.
 *
 * モジュールレベルで遅延初期化するバックフィル Queue。
 * バックフィルが不要な場合は Redis 接続を避けるため lazy にする。
 */
let _backfillQueue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null = null;

function getBackfillQueue(): Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
  if (_backfillQueue === null) {
    _backfillQueue = createEmbeddingBackfillQueue();
  }
  return _backfillQueue;
}

/**
 * PR-BACKFILL-TERMINAL (系統A): the 3 dispatch-managed gated categories.
 *
 * These categories have bespoke happy-path gates in `dispatchBackfillJobsForPage`:
 *   - `part_text` / `part_visual`: gated by `partsSavedCount > PART_SYNC_THRESHOLD`
 *     (the first PART_SYNC_THRESHOLD parts are processed inline by Phase 5;
 *     only the overflow is backfilled — ADR-0007 / FIND-BT-M-03 PRESERVE).
 *   - `section_visual`: gated by `sectionsSavedCount > 0 && screenshot present`.
 *
 * PR-BACKFILL-TERMINAL (System A): the 3 dispatch-managed gated categories.
 */
const BACKFILL_DISPATCH_GATED_CATEGORIES: ReadonlySet<EmbeddingBackfillCategory> = new Set([
  "part_text",
  "part_visual",
  "section_visual",
]);

/**
 * PR-BACKFILL-TERMINAL (系統A): derive the screenshot-free, gate-less categories
 * from the `EMBEDDING_BACKFILL_CATEGORIES` SSOT (drift-proof).
 *
 * Gate-less = SSOT minus the dispatch-managed gated set. Currently
 * `{motion, background, js_animation, responsive}`. These categories are
 * screenshot-free (`requiresScreenshot()=false`) and page-state-independent, so
 * they MUST be enqueued unconditionally on the happy path — a NEW SSOT category
 * is automatically treated as gate-less unless explicitly added to
 * `BACKFILL_DISPATCH_GATED_CATEGORIES`. INV-BACKFILL-TERMINAL-COMPLETED-007
 * Block A pins this 3-way Set-equality.
 *
 * PR-BACKFILL-TERMINAL (System A): gate-less = SSOT minus the gated set.
 */
const BACKFILL_DISPATCH_GATELESS_CATEGORIES: readonly EmbeddingBackfillCategory[] =
  EMBEDDING_BACKFILL_CATEGORIES.filter((c) => !BACKFILL_DISPATCH_GATED_CATEGORIES.has(c));

/**
 * PR-BACKFILL-TERMINAL (系統A): resolve which backfill categories the happy-path
 * dispatch should enqueue for a page, given its part/section/screenshot state.
 *
 * **Root cause closed (系統A)**: previously only part_text/part_visual (threshold-
 * gated) and section_visual (its own condition) were enqueued; motion/bg/js/
 * responsive rode neither gate and were never enqueued, so their parity pending
 * stayed > 0 and the page was mis-pinned to `failed`. This resolver derives the
 * gate-less set from the SSOT (`BACKFILL_DISPATCH_GATELESS_CATEGORIES`) and
 * enqueues it **unconditionally** while PRESERVING the part threshold gate
 * (FIND-BT-M-03) and the section_visual condition.
 *
 * Pure function (no I/O) so it can be unit-pinned by INV-007 Block A without a
 * queue or DB.
 *
 * @returns the ordered list of categories to enqueue (gated subset first, then
 *   the gate-less SSOT-derived set), de-duplicated by construction.
 */
export function resolveBackfillDispatchCategories(input: {
  partsSavedCount: number;
  sectionsSavedCount: number;
  hasScreenshot: boolean;
  hasPendingParts?: boolean;
}): EmbeddingBackfillCategory[] {
  const { partsSavedCount, sectionsSavedCount, hasScreenshot, hasPendingParts = false } = input;
  const categories: EmbeddingBackfillCategory[] = [];

  // --- Gated part categories (dual-trigger, FIND-BT-M-03: threshold gate PRESERVED) ---
  // PR-PART30CAP (ADR-0007 Amendment 2 dual-trigger): enqueue part_text/part_visual
  // when EITHER the inline-cap threshold is exceeded (existing behaviour) OR the
  // inline partial-completion left residual un-embedded parts in the DB
  // (`hasPendingParts=true`). The latter closes the parts≤100 gap where a C1
  // per-chunk RSS budget break stops inline embedding at chunk 0 (=30 parts),
  // leaving residual parts that the threshold gate (parts>100) never enqueued →
  // permanent in_progress stuck (run3: 5 sites). The `hasPendingParts` bool is
  // derived at the call site (`dispatchBackfillJobsForPage`) from a 1-call pending
  // snapshot; NO DB/Prisma argument is injected here so this resolver stays a pure
  // function unit-pinned by INV-007 Block A (TPA-M-02 + TDA-M-03).
  //
  // PR-PART30CAP (ADR-0007 Amendment 2): the existing `PART_SYNC_THRESHOLD`
  // inline-cap semantic (head-100 inline processing) is UNCHANGED — only the
  // enqueue trigger is extended (§3.2). NaN/Infinity defense: a non-finite count
  // must never enqueue parts via the threshold arm.
  const thresholdExceeded =
    Number.isFinite(partsSavedCount) && partsSavedCount > PART_SYNC_THRESHOLD;
  const shouldEnqueueParts = thresholdExceeded || hasPendingParts;
  if (shouldEnqueueParts) {
    // part_text is screenshot-free — always enqueue when over threshold.
    categories.push("part_text");
    // part_visual requires a persisted screenshot.
    if (hasScreenshot) {
      categories.push("part_visual");
    }
  }

  // --- Gated section_visual category (own condition PRESERVED) ---
  const shouldEnqueueSectionVisual =
    Number.isFinite(sectionsSavedCount) && sectionsSavedCount > 0 && hasScreenshot;
  if (shouldEnqueueSectionVisual) {
    categories.push("section_visual");
  }

  // --- Gate-less categories (系統A fix: unconditional, SSOT-derived) ---
  // motion/bg/js/responsive are screenshot-free and page-state-independent;
  // page.analyze completion alone warrants their enqueue (rescues inline-
  // generation misses). Derived from the SSOT so a new category is covered.
  for (const category of BACKFILL_DISPATCH_GATELESS_CATEGORIES) {
    categories.push(category);
  }

  return categories;
}

/**
 * Enqueue backfill jobs for a page after Phase 5.
 *
 * v0.4.0 PR4: Phase 5 完了後に呼ばれ、残余 Part を `embedding-backfill` Queue
 * に投入する。`part_text` と `part_visual` の両方を独立ジョブとして投入し、
 * それぞれ BullMQ の jobId 一意化 (`<webPageId>__<category>`) で重複投入を防ぐ。
 *
 * PR-BACKFILL-TERMINAL (系統A): motion/background/js_animation/responsive の 4
 * gate-less category を `resolveBackfillDispatchCategories` (SSOT 由来) 経由で
 * **無条件 enqueue** する。これらは screenshot 不要・text-only ゆえ全ページが対象
 * (happy-path inline 生成 miss を救済)。part の threshold gate と section_visual
 * の独立条件は PRESERVE する (FIND-BT-M-03)。
 *
 * v0.4.0 PR4: Called after Phase 5 to enqueue remaining backfill jobs on the
 * `embedding-backfill` Queue. BullMQ jobId uniqueness (`<webPageId>__<category>`)
 * prevents duplicate enqueue. PR-BACKFILL-TERMINAL (System A): the 4 gate-less
 * categories (motion/background/js_animation/responsive) are enqueued
 * unconditionally via the SSOT-derived `resolveBackfillDispatchCategories`,
 * preserving the part threshold gate and the section_visual condition.
 *
 * Graceful Degradation: Queue 投入失敗はメインのジョブ結果に影響させない
 * （warn ログのみ）。
 *
 * @returns 投入したカテゴリのリスト / The list of categories enqueued
 */
async function dispatchBackfillJobsForPage(params: {
  webPageId: string;
  url: string;
  partsSavedCount: number;
  sectionsSavedCount: number;
  screenshotStoragePath?: string | undefined;
}): Promise<EmbeddingBackfillCategory[]> {
  const { webPageId, partsSavedCount, sectionsSavedCount, screenshotStoragePath } = params;
  const enqueued: EmbeddingBackfillCategory[] = [];

  // PR-PART30CAP (ADR-0007 Amendment 2 dual-trigger): derive `hasPendingParts`
  // from a SINGLE pending-snapshot call so parts≤100 inline partial-completion
  // residuals are enqueued even when the threshold gate (parts>100) would not
  // fire. `collectCategoryPendingSnapshot` aggregates ALL category pending counts
  // in one Promise.all (no per-category loop / no N+1); page.analyze is bound to
  // the analysis-tier 10RPM rate-limit, so this extra round-trip adds no new
  // back-pressure surface (§3.3 SEC-M-01). Fail-open: a snapshot error must NOT
  // abort dispatch — fall back to threshold-only enqueue (the gate-less
  // categories must still be enqueued), with the residual rescued by the
  // reconciliation cron. The DB I/O lives HERE at the call site; the resolver
  // receives only the derived bool, preserving its pure-function unit-pin
  // (INV-007 Block A, TPA-M-02 + TDA-M-03).
  //
  // PR-PART30CAP (ADR-0007 Amendment 2 dual-trigger): single pending-snapshot
  // call derives `hasPendingParts` so parts≤100 inline partial-completion
  // residuals are enqueued even when the parts>100 threshold gate does not fire.
  let hasPendingParts = false;
  try {
    const pendingSnapshot = await collectCategoryPendingSnapshot(webPageId, prisma);
    hasPendingParts = pendingSnapshot.part_text > 0 || pendingSnapshot.part_visual > 0;
  } catch (error) {
    // Fail-open: do not block dispatch on a snapshot failure. The threshold gate
    // and gate-less enqueue still run; any residual parts are rescued later by
    // the reconciliation cron. Logged in all environments (no isDevelopment guard).
    logger.warn(
      "[PageAnalyzeWorker] Failed to collect pending snapshot for dual-trigger (non-fatal)",
      {
        error: sanitizeErrorMessage(error),
        webPageId: truncateAuditTargetId(webPageId),
      }
    );
  }

  // PR-BACKFILL-TERMINAL (系統A) + PR-PART30CAP (Amendment 2): SSOT-derived
  // dispatch set. part_* は threshold gate OR inline partial-completion residual
  // (hasPendingParts) の dual-trigger、section_visual は独立条件、motion/bg/js/
  // responsive は無条件 (gate-less)。resolveBackfillDispatchCategories が
  // drift-proof な category 集合を返す。
  //
  // PR-BACKFILL-TERMINAL (System A) + PR-PART30CAP (Amendment 2): SSOT-derived
  // dispatch set — part_* gated by threshold OR partial-completion residual
  // (dual-trigger), section_visual by its own condition, the 4 gate-less
  // categories unconditionally. `resolveBackfillDispatchCategories` returns the
  // drift-proof set.
  const dispatchSet = new Set(
    resolveBackfillDispatchCategories({
      partsSavedCount,
      sectionsSavedCount,
      hasScreenshot: screenshotStoragePath !== undefined,
      hasPendingParts,
    })
  );
  const shouldEnqueueParts = dispatchSet.has("part_text");
  const shouldEnqueueSectionVisual = dispatchSet.has("section_visual");

  const queue = getBackfillQueue();

  if (shouldEnqueueParts) {
    // part_text は screenshot 不要 — 常に投入可能
    // part_text does not require a screenshot — always enqueue
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    try {
      const result = await addEmbeddingBackfillJobWithGuard(queue, {
        webPageId,
        category: "part_text",
      });
      enqueued.push("part_text");
      if (result.outcome !== "enqueued_new") {
        logger.info("[PageAnalyzeWorker] part_text backfill enqueue outcome", {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: truncateAuditTargetId(webPageId),
        });
      }
    } catch (error) {
      logger.warn("[PageAnalyzeWorker] Failed to enqueue part_text backfill (non-fatal)", {
        error: sanitizeErrorMessage(error),
        webPageId: truncateAuditTargetId(webPageId),
      });
    }

    // part_visual は persisted screenshot が必須
    // part_visual requires a persisted screenshot
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    if (screenshotStoragePath) {
      try {
        const result = await addEmbeddingBackfillJobWithGuard(queue, {
          webPageId,
          category: "part_visual",
          screenshotStoragePath,
          requiresBboxResolution: true,
        });
        enqueued.push("part_visual");
        if (result.outcome !== "enqueued_new") {
          logger.info("[PageAnalyzeWorker] part_visual backfill enqueue outcome", {
            outcome: result.outcome,
            collision: result.collision,
            webPageId: truncateAuditTargetId(webPageId),
          });
        }
      } catch (error) {
        logger.warn("[PageAnalyzeWorker] Failed to enqueue part_visual backfill (non-fatal)", {
          error: sanitizeErrorMessage(error),
          webPageId: truncateAuditTargetId(webPageId),
        });
      }
    } else if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] No persisted screenshot; skipping part_visual backfill", {
        webPageId: truncateAuditTargetId(webPageId),
      });
    }
  }

  // v0.4.0 PR7e-α (バグ⑥): section_visual を backfill 対象に追加。
  // Queue-based Backfill Worker の SectionVisualProcessor が DINOv2 で
  // vision_embedding を再生成する (PR7b の section_visual 統合を活用)。
  //
  // v0.4.0 PR7e-α (bug ⑥): enqueue section_visual so Queue-based Backfill
  // (SectionVisualProcessor) can regenerate DINOv2 vision_embeddings — the
  // PR7b section_visual integration is leveraged here.
  if (shouldEnqueueSectionVisual && screenshotStoragePath) {
    // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
    try {
      const result = await addEmbeddingBackfillJobWithGuard(queue, {
        webPageId,
        category: "section_visual",
        screenshotStoragePath,
      });
      enqueued.push("section_visual");
      if (result.outcome !== "enqueued_new") {
        logger.info("[PageAnalyzeWorker] section_visual backfill enqueue outcome", {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: truncateAuditTargetId(webPageId),
        });
      }
    } catch (error) {
      logger.warn("[PageAnalyzeWorker] Failed to enqueue section_visual backfill (non-fatal)", {
        error: sanitizeErrorMessage(error),
        webPageId: truncateAuditTargetId(webPageId),
      });
    }
  }

  // PR-BACKFILL-TERMINAL (系統A): motion/background/js_animation/responsive の
  // 4 gate-less category を無条件 enqueue する。これらは screenshot 不要・
  // text-only ゆえ page.analyze 完了した全ページが対象。従来は part / section_visual
  // のどちらの gate にも乗らず未 enqueue → parity pending>0 → reconciliation cron が
  // `failed` に誤 pin していた (root cause)。`addEmbeddingBackfillJobWithGuard` の
  // jobId 一意化 (`<webPageId>__<category>`) で重複投入を防ぐ。category 集合は
  // SSOT (`EMBEDDING_BACKFILL_CATEGORIES`) 由来 (drift-proof、INV-007 Block A pin)。
  //
  // PR-BACKFILL-TERMINAL (System A): unconditionally enqueue the 4 gate-less
  // categories (motion/background/js_animation/responsive). They are
  // screenshot-free and text-only, so every page.analyze completion warrants
  // them. Previously they rode neither dispatch gate → parity pending stayed
  // > 0 → the reconciliation cron mis-pinned the page to `failed`. jobId
  // uniqueness prevents duplicate enqueue; the category set is SSOT-derived
  // (`EMBEDDING_BACKFILL_CATEGORIES`), pinned by INV-007 Block A.
  for (const category of BACKFILL_DISPATCH_GATELESS_CATEGORIES) {
    try {
      const result = await addEmbeddingBackfillJobWithGuard(queue, {
        webPageId,
        category,
      });
      enqueued.push(category);
      if (result.outcome !== "enqueued_new") {
        logger.info("[PageAnalyzeWorker] gate-less backfill enqueue outcome", {
          category,
          outcome: result.outcome,
          collision: result.collision,
          webPageId: truncateAuditTargetId(webPageId),
        });
      }
    } catch (error) {
      logger.warn("[PageAnalyzeWorker] Failed to enqueue gate-less backfill (non-fatal)", {
        category,
        error: sanitizeErrorMessage(error),
        webPageId: truncateAuditTargetId(webPageId),
      });
    }
  }

  // v0.4.0 PR7e-α (TDA 最小 observability): dispatched categories を常時ログ。
  // isDevelopment() ガードは使わない — 本番でも backfill 観測に必要。
  //
  // v0.4.0 PR7e-α (TDA minimum observability): log dispatched categories
  // unconditionally — required for production backfill observability.
  logger.info("[PageAnalyzeWorker] Dispatched backfill categories", {
    webPageId: truncateAuditTargetId(webPageId),
    categories: enqueued,
    partsSavedCount,
    sectionsSavedCount,
    hasScreenshot: screenshotStoragePath !== undefined,
    // PR-PART30CAP: observe whether the dual-trigger residual arm fired.
    hasPendingParts,
  });

  return enqueued;
}

// ============================================================================
// v0.4.0 PR7b: Skip Recovery — All-Category Backfill Enqueue
// ============================================================================

/**
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` は
 * `queues/embedding-backfill-queue.ts` の SSOT から import する。
 * 以前はローカル定数として重複していたが、MCP response の
 * `backfillPendingSkipRecoverySchema.retryCount.max` と不整合になるリスクが
 * あったため SSOT 化した。
 *
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` is now imported from
 * the SSOT in `queues/embedding-backfill-queue.ts`. Previously duplicated as a
 * local constant, which created a drift risk against
 * `backfillPendingSkipRecoverySchema.retryCount.max` in the MCP response.
 */

/**
 * Skip recovery 経路 (ADR-0008 #2) — Phase 5 全体 skip 検出時に全 7 カテゴリを
 * `embedding-backfill` Queue へ一括 enqueue する。
 *
 * 流れ / Flow:
 *   1. retry cap (`SKIP_RECOVERY_RETRY_CAP`) 確認 — 超過なら `failed` 固定 + audit log
 *   2. back-pressure (`checkBackfillQueueBackPressure`) 確認 — 超過なら `skipped_*` のまま残し cron 補完
 *   3. CAS guard (`updateMany` WHERE `skipped_*` / `in_progress`) で `queued` 遷移 +
 *      `embeddingBackfillRetryCount` インクリメント
 *   4. 全 7 カテゴリ enqueue（screenshot 必須カテゴリは screenshot path 存在確認）
 *   5. memory_pressure 経路は初期 `delay` を付与（BullMQ exponential backoff は retry 時に独立適用）
 *
 * Skip recovery path (ADR-0008 #2) — bulk-enqueues all 7 categories on the
 * `embedding-backfill` Queue when full Phase 5 skip is detected.
 *
 * Steps:
 *   1. Check retry cap; pin to `failed` + audit log if exceeded
 *   2. Check back-pressure; leave `skipped_*` for cron recovery if exceeded
 *   3. CAS guard transitions to `queued` and increments retry count
 *   4. Enqueue all 7 categories (screenshot-required categories check path)
 *   5. memory_pressure path adds initial `delay`; exponential backoff is applied
 *      independently on retry
 *
 * 戻り値 / Returns:
 * - `enqueuedCategories`: 実際に enqueue したカテゴリ一覧（CAS 失敗 / cap 超過時は空配列）
 *   Categories actually enqueued (empty on CAS failure / retry cap exceeded).
 * - `reason`: 非 enqueue パスの原因（`retry_cap_exceeded` / `cas_failed` 等）。enqueue 成功時は null。
 *   Non-enqueue reason (`retry_cap_exceeded` / `cas_failed` / etc). null on enqueue success.
 * - `retryCountAfter`: CAS increment 後の retry count（enqueue パスのみ有効、それ以外は undefined）。
 *   PR7b (ADR-0008 #7): `backfillPending.skip_recovery.retryCount` に露出するため返却。
 *   Retry count after CAS increment (enqueue path only). PR7b (ADR-0008 #7): returned
 *   so it can be surfaced via `backfillPending.skip_recovery.retryCount`.
 * - `enqueuedAt`: 実際に Queue に投入した時刻（enqueue パスのみ）。
 *   PR7b: response の `enqueuedAt` 用。`memory_pressure` 遅延込みの Queue 投入
 *   トランザクション開始時刻を使う。
 *   Timestamp when enqueue actually occurred (enqueue path only). PR7b: used for
 *   response `enqueuedAt`. Uses the start-of-transaction time including any
 *   memory_pressure initial delay window.
 */
async function dispatchSkipRecoveryBackfill(params: {
  webPageId: string;
  url: string;
  skipReason: EmbeddingSkipReason;
  backfillStatus: "skipped_fork_error" | "skipped_memory_pressure";
  screenshotStoragePath?: string | undefined;
}): Promise<{
  enqueuedCategories: EmbeddingBackfillCategory[];
  reason: string | null;
  retryCountAfter?: number;
  enqueuedAt?: Date;
}> {
  const { webPageId, skipReason, backfillStatus, screenshotStoragePath } = params;

  // -- Step 1: Retry cap (SEC HIGH-1) ----------------------------------------
  let currentRetryCount = 0;
  try {
    const row = await prisma.webPage.findUnique({
      where: { id: webPageId },
      select: { embeddingBackfillRetryCount: true },
    });
    currentRetryCount = row?.embeddingBackfillRetryCount ?? 0;
  } catch (fetchError) {
    logger.warn("[PageAnalyzeWorker] Failed to fetch embeddingBackfillRetryCount", {
      error: sanitizeErrorMessage(fetchError),
      webPageId: truncateAuditTargetId(webPageId),
    });
    return { enqueuedCategories: [], reason: "retry_count_fetch_failed" };
  }

  if (currentRetryCount >= SKIP_RECOVERY_RETRY_CAP) {
    // 5 回超過: failed 固定 + audit log
    // Exceeded 5 retries: pin to failed + audit log
    try {
      await prisma.webPage.updateMany({
        where: { id: webPageId, embeddingBackfillStatus: { in: [backfillStatus] } },
        data: { embeddingBackfillStatus: "failed", embeddingBackfillStartedAt: null },
      });
    } catch (updateError) {
      logger.warn("[PageAnalyzeWorker] Failed to pin embeddingBackfillStatus to failed", {
        error: sanitizeErrorMessage(updateError),
        webPageId: truncateAuditTargetId(webPageId),
      });
    }
    try {
      await getAuditLogService().log({
        action: "backfill_retry_exhausted",
        actor: "page-analyze-worker",
        targetType: "web_page",
        targetId: webPageId,
        details: {
          retryCount: currentRetryCount,
          retryCap: SKIP_RECOVERY_RETRY_CAP,
          skipReason,
          backfillStatus,
        },
        result: "denied",
      });
    } catch {
      /* audit log 失敗は致命的でない / non-fatal */
    }
    logger.warn("[PageAnalyzeWorker] Skip recovery retry cap exceeded — pinned to failed", {
      webPageId: truncateAuditTargetId(webPageId),
      retryCount: currentRetryCount,
      retryCap: SKIP_RECOVERY_RETRY_CAP,
    });
    return { enqueuedCategories: [], reason: "retry_cap_exceeded" };
  }

  // -- Step 2: Back-pressure (SEC HIGH-2) ------------------------------------
  const queue = getBackfillQueue();
  const backPressure = await checkBackfillQueueBackPressure(queue);
  if (!backPressure.allowEnqueue) {
    logger.warn("[PageAnalyzeWorker] Back-pressure exceeded; leaving skipped_* for cron recovery", {
      webPageId: truncateAuditTargetId(webPageId),
      waitingCount: backPressure.waitingCount,
      cap: EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
    });
    return { enqueuedCategories: [], reason: "back_pressure_exceeded" };
  }

  // -- Step 3: CAS guard — skipped_* → queued + retry count increment --------
  // ADR-0008 #9: WHERE で skipped_fork_error / skipped_memory_pressure / in_progress
  // を許可。Worker 即時 enqueue と cron 補完の race を optimistic concurrency で解決。
  // ADR-0008 #9: WHERE permits skipped_* and in_progress; resolves race between
  // immediate Worker enqueue and cron recovery via optimistic concurrency.
  let casOk = false;
  try {
    const updated = await prisma.webPage.updateMany({
      where: {
        id: webPageId,
        embeddingBackfillStatus: {
          in: ["skipped_fork_error", "skipped_memory_pressure", "in_progress"],
        },
      },
      data: {
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: new Date(),
        embeddingBackfillRetryCount: { increment: 1 },
      },
    });
    casOk = updated.count > 0;
  } catch (casError) {
    logger.warn("[PageAnalyzeWorker] CAS guard failed for skip recovery transition", {
      error: sanitizeErrorMessage(casError),
      webPageId: truncateAuditTargetId(webPageId),
    });
    return { enqueuedCategories: [], reason: "cas_failed" };
  }

  if (!casOk) {
    // 別 worker / cron が先に遷移済み（skipped_* → queued/in_progress）。
    // Another worker / cron already transitioned (skipped_* → queued/in_progress).
    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] CAS guard skipped — concurrent transition detected", {
        webPageId: truncateAuditTargetId(webPageId),
      });
    }
    return { enqueuedCategories: [], reason: "concurrent_transition" };
  }

  // -- Step 4: Enqueue all 7 categories --------------------------------------
  // memory_pressure 経路は初期 delay を付与（OS にメモリ回収猶予を与える）
  // memory_pressure path adds initial delay (gives OS time to reclaim memory)
  const initialDelayMs =
    backfillStatus === "skipped_memory_pressure" ? resolveMemoryPressureDelayMs() : 0;

  // PR7b-convergence (SEC MEDIUM-2): enqueue transaction 開始時刻をループ**前**に
  // 記録する。これは「enqueue を試行開始した時点」を意味し、BullMQ 内部の
  // `delay` (memory_pressure 初期遅延) や exponential backoff の経過時間は
  // 含まない。呼び出し元 (MCP response の `backfillPending.skip_recovery.enqueuedAt`)
  // はこの値を使って skip recovery のタイミング分析を行う。
  //
  // PR7b-convergence (SEC MEDIUM-2): Record the enqueue-transaction start time
  // **before** the loop. This timestamp represents "when we started attempting
  // enqueue" and does NOT include BullMQ-internal `delay` (memory_pressure
  // initial delay) or exponential backoff elapsed time. Callers (MCP response
  // `backfillPending.skip_recovery.enqueuedAt`) rely on this semantic for
  // skip-recovery timing analysis.
  const enqueueTransactionStartAt = new Date();

  // PR7b-convergence (TDA H-1 / H-2 / M-2): ヘルパーに集約。Worker/Cron の
  // 30 行 × 2 の重複コードを一箇所に統合し、`dispatchSkipRecoveryBackfill` の
  // 複雑度を 14 → ≤10 に収束。
  //
  // PR7b-convergence (TDA H-1 / H-2 / M-2): Consolidated into the helper.
  // Unifies ~30 lines × 2 Worker/Cron duplication and drives
  // `dispatchSkipRecoveryBackfill` complexity from 14 to ≤10.
  const { enqueued, failed } = await enqueueAllCategoriesForSkipRecovery(queue, {
    webPageId,
    screenshotStoragePath,
    initialDelayMs,
    source: "worker",
  });

  if (enqueued.length > 0) {
    logger.info("[PageAnalyzeWorker] Skip recovery: enqueued backfill jobs", {
      webPageId: truncateAuditTargetId(webPageId),
      categories: enqueued,
      failedCategories: failed,
      skipReason,
      backfillStatus,
      retryCountAfter: currentRetryCount + 1,
      initialDelayMs,
    });
  } else {
    // すべて enqueue に失敗 — CAS で queued に遷移済みなので、cron が再回収する。
    // All enqueues failed — already transitioned to queued via CAS, cron will recover.
    logger.warn(
      "[PageAnalyzeWorker] Skip recovery: 0 categories enqueued (all failed); cron will retry",
      {
        webPageId: truncateAuditTargetId(webPageId),
        failedCategories: failed,
      }
    );
  }

  // PR7b (ADR-0008 #7): MCP response `backfillPending.skip_recovery` 用に
  // post-increment retry count と enqueue 時刻を返却。
  // PR7b (ADR-0008 #7): return post-increment retry count and enqueue timestamp
  // for MCP response `backfillPending.skip_recovery`.
  return {
    enqueuedCategories: enqueued,
    reason: null,
    retryCountAfter: currentRetryCount + 1,
    enqueuedAt: enqueueTransactionStartAt,
  };
}

/**
 * Phase 4 完了後の選択的メモリ解放 (v0.4.0 PR7e-β2 P0-2)。
 *
 * 設計の歴史 / Design history:
 *   - PR7b (ADR-0008 #5): `state.layoutResultForNarrative` 等 4 つを null 化
 *     して Phase 5 fork 前の親 RSS を削減していた。
 *   - PR7e-α Revert: その null 化が「全ページ embedding 0 件」バグの真因
 *     （Phase 5 が入力を受け取れず）と判明し撤回。dispose は GC hint のみに退化。
 *   - PR7e-β2 P0-2 (本実装): Phase 5 が **使う** reference は維持しつつ、
 *     Phase 5 が **使わない** 中間データを選択的に破棄する。これにより
 *     reftrix.io / Stripe で観測された Phase 5 entry RSS=5028-5528MB を
 *     圧縮し、parent RSS guard 6144MB ceiling 内に収める。
 *
 *   - PR7b (ADR-0008 #5): nulled out 4 state references to reduce parent RSS
 *     before Phase 5 fork.
 *   - PR7e-α Revert: that null-out was the root cause of the "zero embeddings
 *     DB-wide" bug (Phase 5 starved of its inputs) and was reverted; dispose
 *     degraded to a GC hint only.
 *   - PR7e-β2 P0-2 (this revision): Keep references that Phase 5 **uses**;
 *     selectively drop the intermediate fields that Phase 5 **does not use**.
 *     This compresses the observed Phase 5 entry RSS=5028-5528MB on
 *     reftrix.io / Stripe so it fits within the 6144MB parent-RSS guard.
 *
 * 保持必須 (Phase 5 が使う) / Must preserve (used by Phase 5):
 *   - state.layoutResultForNarrative.sections (capped 50 in phase-4-narrative.ts)
 *   - state.motionResultForEmbedding.patterns
 *   - state.jsAnimationsForEmbedding (cdpAnimations / webAnimations / libraries)
 *   - state.scrollVisionResultForEmbedding.scrollTriggeredAnimations
 *   - state.sectionSaveResult, motionSaveResult, jsSaveResult, bgSaveResult,
 *     scrollVisionSaveResult, screenshotPngPath
 *
 * 破棄対象 (Phase 5 が使わない) / Drop targets (unused by Phase 5):
 *   - MotionServiceResult: frame_capture / frame_analysis (frame buffers, MB単位),
 *     webgl_animations (Canvas data), video_info / runtime_info, warnings,
 *     js_animation_summary, js_animations (jsAnimationsForEmbedding が独立保持)
 *   - ScrollVisionResult: analyses (per-capture Vision raw response, KB-MB単位)
 *
 *   - Note: jsAnimationsForEmbedding は分離保持なので motionResultForEmbedding 側の
 *     js_animations / js_animation_summary は冗長 → 破棄して安全。
 *   - Note: jsAnimationsForEmbedding is preserved separately, so
 *     motionResultForEmbedding's js_animations / js_animation_summary are
 *     redundant → safe to drop.
 *
 * 戻り値 / Returns: dispose 前後の RSS 平均 (MB)。`afterRssMb` が 3 回平均で測定される
 * ことを保証するため、`tryGarbageCollect()` + 100ms 待機後に 3 回サンプリングする。
 *
 * Returns pre/post RSS averages (MB). `afterRssMb` is measured as the mean of
 * 3 samples after `tryGarbageCollect()` + 100ms wait, to ensure the GC effect
 * is captured deterministically.
 */
async function disposePhase4Memory(state: PipelineState): Promise<{
  beforeRssMb: number;
  afterRssMb: number;
  reclaimedMb: number;
}> {
  const beforeRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // ============================================================
  // PR7e-β2 P0-2: 選択的破棄 / Selective disposal
  //
  // 履歴 / History:
  //   - PR7b は state.layoutResultForNarrative 等を null 化していた。
  //   - PR7e-α Revert (ADR-0012): その null 代入が「全 embedding 0 件」バグの
  //     真因と判明し撤回。state.* references は Phase 5 入力として保持。
  //   - PR7e-β2 P0-2: Phase 5 が使う reference は保持しつつ、Phase 5 不使用の
  //     中間フィールドのみを選択的に破棄する。
  //
  //   - PR7b nulled out state.layoutResultForNarrative et al.
  //   - PR7e-α Revert (ADR-0012): that null assignment was the root cause of
  //     the "zero embeddings DB-wide" bug and was reverted; state.* refs are
  //     preserved as Phase 5 inputs.
  //   - PR7e-β2 P0-2: Keep refs Phase 5 uses; selectively drop only the
  //     intermediate fields Phase 5 does not consume.
  // ============================================================

  // MotionServiceResult: keep only `patterns`; drop heavy intermediates.
  // 破棄対象: frame_capture (5-30MB), frame_analysis, webgl_animations,
  //   video_info, runtime_info, warnings, js_animation_summary,
  //   js_animations (jsAnimationsForEmbedding が独立保持)
  // Cast via `unknown` — MotionServiceResult lacks an index signature so a
  // direct `as Record<string, unknown>` cast is rejected by strict TS, but
  // optional fields are safe to `delete` at runtime.
  if (state.motionResultForEmbedding) {
    const m = state.motionResultForEmbedding as unknown as Record<string, unknown>;
    delete m["frame_capture"];
    delete m["frame_analysis"];
    delete m["frame_capture_error"];
    delete m["frame_analysis_error"];
    delete m["webgl_animations"];
    delete m["webgl_animation_summary"];
    delete m["webgl_animation_error"];
    delete m["video_info"];
    delete m["runtime_info"];
    delete m["warnings"];
    delete m["js_animation_summary"];
    delete m["js_animations"];
    delete m["js_animation_error"];
  }

  // ScrollVisionResult: keep only `scrollTriggeredAnimations`; drop per-capture
  // raw Vision analyses.
  // 破棄対象: analyses (per-capture Ollama Vision raw response, KB-MB単位)
  if (state.scrollVisionResultForEmbedding) {
    const sv = state.scrollVisionResultForEmbedding as unknown as Record<string, unknown>;
    delete sv["analyses"];
  }

  // ============================================================
  // GC + 3-sample RSS measurement (existing behavior preserved)
  // ============================================================
  tryGarbageCollect();

  // GC 完了待ち — 100ms wait + 3 samples で測定ノイズを抑制
  // Wait for GC — 100ms + 3 samples to suppress measurement noise
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    samples.push(process.memoryUsage().rss);
    if (i < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const avgRss = samples.reduce((a, b) => a + b, 0) / samples.length;
  const afterRssMb = Math.round(avgRss / 1024 / 1024);

  return {
    beforeRssMb,
    afterRssMb,
    reclaimedMb: beforeRssMb - afterRssMb,
  };
}

// ============================================================================
// Plan v3 Track T4 (PR-V3-T4) — derivePhaseNFromCompletedPhases
// ============================================================================

/**
 * Derive the in-flight phase identifier (PhaseN) from the highest completed
 * AnalysisPhase. Used by the catch-block tail to populate
 * `failed_with_known_reason='worker_restart_during_inflight_phase_<N>'`
 * via {@link markFailedAndAuditAtomic}.
 *
 *   - completedPhases empty                  → phase 0 (Ingest in-flight)
 *   - completedPhases includes "ingest"      → phase 1 (Layout in-flight)
 *   - completedPhases includes "layout"      → phase 2_5 (ScrollVision in-flight)
 *   - completedPhases includes "motion"      → phase 4 (Narrative in-flight)
 *   - completedPhases includes "narrative"   → phase 5 (Embedding in-flight)
 *   - completedPhases includes "embedding"   → phase 7_5 (Post-Analysis Gate)
 *
 * Plan v3 T4 — derive PhaseN from highest completed AnalysisPhase.
 *
 * @param completedPhases - state.completedPhases array
 * @returns PhaseN identifier
 */
function derivePhaseNFromCompletedPhases(completedPhases: readonly AnalysisPhase[]): PhaseN {
  // Order matters: check from highest to lowest.
  if (completedPhases.includes("embedding" as AnalysisPhase)) return "7_5";
  if (completedPhases.includes("narrative" as AnalysisPhase)) return "5";
  if (completedPhases.includes("motion" as AnalysisPhase)) return "4";
  if (completedPhases.includes("layout" as AnalysisPhase)) return "2_5";
  if (completedPhases.includes("ingest" as AnalysisPhase)) return "1";
  return "0";
}

// ============================================================================
// processPageAnalyzeJob — Thin Orchestrator
// ============================================================================

/**
 * Process a page analysis job by orchestrating phase modules.
 *
 * This function creates the pipeline state and context, then delegates
 * to extracted phase modules (phase-0 through phase-5) in sequence.
 * Phase 5 (Embedding) and post-embedding backfill remain inline because
 * they reference module-level singletons (gpuResourceManager) and have a
 * different API signature (EmbeddingPhaseParams + EmbeddingPhaseDeps).
 *
 * @param job - BullMQ job instance
 * @param token - BullMQ worker token for lock management
 * @returns Job result with completed/failed phases and analysis results
 */

/**
 * Prisma schema enum `EmbeddingBackfillStatus` の値。
 * Valid values of the Prisma `EmbeddingBackfillStatus` enum.
 *
 * Kept as a string-literal union (not imported from `@prisma/client`) so that
 * this worker module stays free of a runtime dependency on the generated
 * client type when used from tests / fork children.
 *
 * 生成された `@prisma/client` 型への実行時依存を避けるため、あえて文字列
 * リテラル合併型として定義する（テスト / fork 子プロセスからも利用可能）。
 *
 * INV-SCHEMA-ENUM-004-B (standing regression): この literal union は Prisma
 * schema の `EmbeddingBackfillStatus` enum (現在 8 値) と完全一致しなければ
 * ならない。`skipped_screenshot_missing` は PR7d-1 で追加された repair 用
 * 終端状態 (`repair-orphaned-backfill-records.ts` 専用)。
 *
 * INV-SCHEMA-ENUM-004-B (standing regression): this literal union must match
 * Prisma's `EmbeddingBackfillStatus` enum (currently 8 values). The
 * `skipped_screenshot_missing` value was added in PR7d-1 as a repair-only
 * terminal state (used exclusively by `repair-orphaned-backfill-records.ts`).
 */
type EmbeddingBackfillStatusValue =
  | "not_required"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped_memory_pressure"
  | "skipped_fork_error"
  | "skipped_screenshot_missing"
  | "failed_with_known_reason";

/**
 * EmbeddingSkipReason → EmbeddingBackfillStatus へのマッピング（PR2 v0.4.0）。
 * Maps {@link EmbeddingSkipReason} to {@link EmbeddingBackfillStatusValue}.
 *
 * `v8_heap_headroom_low` / `system_memavailable_low` はメモリ圧迫に分類、
 * fork/child 由来は `skipped_fork_error`、`no_embeddable_items` は対象ゼロ
 * のため `not_required` に戻す。
 *
 * `v8_heap_headroom_low` / `system_memavailable_low` map to memory pressure;
 * fork/child-originated reasons map to `skipped_fork_error`; and
 * `no_embeddable_items` collapses back to `not_required` (no work to backfill).
 */
// PR-V3-T1a §3.4.1 (FIND-V3-IO-H-01 closure):
//   - `text_child_memory_budget_exceeded_at_chunk_<n>` is a memory-pressure
//     signal (not a fork/IPC failure), so it shares the same
//     `skipped_memory_pressure` retry bucket as system-level memory shortage.
//   - `partial_chunked_<n>_of_<total>` is a third `partTextPending` source
//     per ADR-0007 (alongside threshold-driven and visual-screenshot-missing);
//     chunks 0..N-1 are durable forward intent, chunks N..total are skipped
//     and surfaced via post-Phase-5 `dispatchBackfillJobsForPage`. Routes
//     through `skipped_fork_error` (5 retries, then `failed`).
//
// PR-V3-T1a §3.4.1: `text_child_memory_budget_exceeded_at_chunk_<n>` →
// `skipped_memory_pressure`; `partial_chunked_<n>_of_<total>` →
// `skipped_fork_error`.
function skipReasonToBackfillStatus(reason: EmbeddingSkipReason): EmbeddingBackfillStatusValue {
  switch (reason) {
    case "v8_heap_headroom_low":
    case "system_memavailable_low":
    case "text_child_memory_budget_exceeded_at_chunk_<n>":
      return "skipped_memory_pressure";
    case "text_fork_failed":
    case "text_child_error":
    case "text_child_abnormal_exit":
    case "text_ipc_race":
    case "visual_fork_failed":
    case "visual_child_error":
    case "visual_child_abnormal_exit":
    case "visual_ipc_race":
    case "dispatch_phase_failed":
    case "fork_terminated_before_done":
    case "parity_check_failed":
    case "bbox_invalid":
    case "bbox_unresolvable":
    case "vision_residual_at_phase5_start":
    case "vision_probe_failed_at_phase5_start":
    case "partial_chunked_<n>_of_<total>":
    case "screenshot_truncated":
      // ADR-0018 Amendment 13 (truncated-screenshot data-loss fix, Plan §5.4):
      // `screenshot_truncated` is the NON-terminal bounded-retryable reason for a
      // part/section off-screen ONLY because the persisted screenshot was
      // truncated to viewport-only. It maps to the existing `skipped_fork_error`
      // retry bucket (same bucket as `bbox_unresolvable`) so the row is actually
      // re-enqueued — until the PR-B section fallback supplies a real generation
      // source, or the bounded budget (`SCREENSHOT_TRUNCATED_RETRY_CAP`=5)
      // converges it to the `screenshot_truncated_expired` terminal (Plan §5.5
      // reconciliation per-row branch → `not_required`, NOT `failed`).
      //
      // ADR-0018 Amendment 13 (Plan §5.4): `screenshot_truncated` (non-terminal,
      // bounded-retryable) maps to the `skipped_fork_error` retry bucket so it is
      // actually re-enqueued; the bounded budget converges it to
      // `screenshot_truncated_expired` (→ `not_required`).
      // TDA MEDIUM 1 (v0.4.0 PR2 監査): `dispatch_phase_failed` は
      // `dispatchEmbeddingPhase` 全体の予期せぬ例外に対応する汎用分類で、
      // fork / child 系と同じ backfill queue 経路で再試行させる。
      // TDA MEDIUM 1 (v0.4.0 PR2 audit): `dispatch_phase_failed` is the
      // catch-all classification for unexpected exceptions thrown by
      // `dispatchEmbeddingPhase`; it is funneled through the same
      // backfill-queue retry path as fork/child-originated skips.
      //
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): `fork_terminated_before_done`
      // (fork child `done` 送信前終了) と `parity_check_failed` (terminal
      // transition 直前の COUNT(*) parity check 失敗) も同じ `skipped_fork_error`
      // ルートにマップし、backfill queue 経由で retry → 最終 state `failed`
      // (INV-EMBEDDING-INTEGRITY-001/004 契約)。
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): `fork_terminated_before_done`
      // (fork child terminated before sending `done`) and `parity_check_failed`
      // (COUNT(*) parity-check failed before terminal transition) also map to
      // `skipped_fork_error`, retrying via backfill queue and ultimately
      // transitioning to `failed` (INV-EMBEDDING-INTEGRITY-001/004 contracts).
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // `bbox_invalid` (Part visual embedding loop が boundingBox invalid で
      // skip) も同じ `skipped_fork_error` ルートにマップする。`skipped_fork_error`
      // は `backfill-reconciliation.service.ts` の retry bucket 対象
      // (L283/559/621/758) で、5 retry 後に `failed` 永続化。semantic-stretch:
      // `skipped_fork_error` は既に 11 種類の skip reason (fork系/child系/
      // ipc系/dispatch系) を集約する general-purpose retry-bucket mapping
      // として機能しており、`bbox_invalid` の "Phase 5 part visual embedding
      // 生成失敗" は自然な拡張。当初検討された `skipped_screenshot_missing`
      // は retry 対象外のため GDPR Art.5(1)(d) accuracy 原則違反として
      // 撤回 (IO Registry UC-01 Option B → Option D)。
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // `bbox_invalid` (Part visual embedding loop skip due to invalid
      // boundingBox) also maps to `skipped_fork_error`. `skipped_fork_error`
      // is the retry bucket in `backfill-reconciliation.service.ts`
      // (L283/559/621/758), persisting to `failed` after 5 retries.
      // Semantic-stretch: `skipped_fork_error` already aggregates 11 skip
      // reasons (fork/child/ipc/dispatch) as a general-purpose retry-bucket
      // mapping, so `bbox_invalid`'s "Phase 5 part visual embedding generation
      // failure" is a natural extension. The initially-considered
      // `skipped_screenshot_missing` was withdrawn (IO Registry UC-01 Option B
      // → Option D) because it is retry-excluded, violating GDPR Art.5(1)(d)
      // accuracy principle.
      //
      // PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1 Supplement S3):
      // `bbox_unresolvable` (Playwright-residual catch-all post-1st-pass +
      // post-reload-budget exhaustion) shares the same `skipped_fork_error`
      // retry bucket. Per Supplement S3 mapping rationale: same accuracy-
      // preserving retry path; downstream `backfill-reconciliation.service.ts`
      // re-enqueues via skip recovery (5 retries, then terminal `failed`).
      // Mutually exclusive with `bbox_invalid` (JSDOM-origin vs Playwright-
      // residual) by Supplement S3 decision-boundary contract.
      return "skipped_fork_error";
    case "section_visual_uncroppable":
    case "section_visual_duplicate":
    case "section_visual_pii_excluded":
    case "section_visual_blank":
    case "section_visual_no_position":
    case "screenshot_truncated_expired":
      // ADR-0018 Amendment 13 (truncated-screenshot data-loss fix, Plan §5.4 /
      // §5.5): `screenshot_truncated_expired` is the TERMINAL of the bounded-retry
      // budget. It maps to `not_required` (NOT `failed`) so the page can reach
      // `completed` without the false-failed pin this fix removes. The
      // reconciliation per-row branch (Plan §5.5) converges `screenshot_truncated`
      // rows over the retry cap to this terminal.
      //
      // ADR-0018 Amendment 13 (Plan §5.4/§5.5): `screenshot_truncated_expired`
      // (terminal) maps to `not_required` (NOT `failed`), avoiding the
      // false-failed pin; the reconciliation per-row branch converges here.
      //
      // secvisual-blank-terminal (Plan V1 §4, IO Plan Decision V1 `019e7f1c-0b66`,
      // FIND-PLAN-M-03): `section_visual_blank` / `section_visual_no_position` は
      // backfill-path の degraded-coverage technical terminal marker (NON-PII;
      // `section_visual_pii_excluded` とは意味が異なる、FIND-PLAN-L-07)。既存 3 値と
      // 同じく `not_required` にマップする (terminal-skip = page が completed に到達
      // できる正当な除外。`skipped_fork_error` retry bucket には**マップしない**)。
      // explicit case arm は必須 (never-narrowing default に暗黙 fallthrough すると
      // `skipped_fork_error` に誤マップされ false-failed pin を再生成する。default の
      // never check と二重防御 = compile-time でも arm 欠如を検出)。
      //
      // secvisual-blank-terminal (Plan V1 §4, FIND-PLAN-M-03): `section_visual_blank`
      // / `section_visual_no_position` are backfill-path degraded-coverage technical
      // terminal markers (NON-PII; distinct from `section_visual_pii_excluded`). They
      // map to `not_required` like the existing 3 section_visual values. The explicit
      // arms are mandatory (silent fallthrough through the never-narrowing default
      // would mis-map them to `skipped_fork_error`, re-creating the false-failed pin;
      // double-defense with the compile-time never check).
      //
      // PR-C4 (ADR-0018 Amendment, section_visual PII asymmetry closure):
      // `section_visual_pii_excluded` は work 側 PII-exclusion terminal marker
      // (GDPR Art.5(1)(c) data-minimisation)。既存 2 値と同じく
      // `not_required` にマップする (terminal-skip = page が completed に到達できる
      // 正当な除外。`skipped_fork_error` retry bucket には**マップしない**)。
      // PR-C4: `section_visual_pii_excluded` (work-side PII-exclusion terminal
      // marker) maps to `not_required` like the other 2 section_visual values.
      // PR-BT-2 (系統B、ADR-0018 Amendment、IO Plan Decision V2 `019e5842`
      // BT-V2-CORR-01): section_visual terminal-skip は「page が completed に
      // 到達できる正当な除外」を意味する。section の terminal-skip は
      // `vision_skip_reason` 列 + `sectionVisualPendingExclusionPredicate` の
      // pending 除外で達成され、`skipReasonToBackfillStatus` の戻り値経路とは
      // 別 layer。本 2 値が page-level skipReason としてここに渡るのは「page
      // 全体が当該理由で skip された」異常系のみで、その場合 page に embeddable
      // section が無い等価ゆえ `not_required` を返す。
      // **`skipped_fork_error` (retry → failed) には絶対にマップしない** — それは
      // 本 PR が直そうとしている false-failed pin を再生成するため。explicit arm
      // 自体は必須 (新 EmbeddingSkipReason を never-narrowing default に暗黙
      // fallthrough させると `skipped_fork_error` に誤マップされる)。
      //
      // PR-BT-2 (System B, ADR-0018 Amendment, IO Plan Decision V2 `019e5842`
      // BT-V2-CORR-01): a section_visual terminal-skip is a legitimate exclusion
      // that lets the page reach `completed`. Section terminal-skip is achieved
      // via the `vision_skip_reason` column + the pending-exclusion predicate (a
      // separate layer from this return-value path). These 2 values reach this
      // page-level path only in the abnormal case where the WHOLE page was
      // skipped for this reason, equivalent to "no embeddable section" → return
      // `not_required`. They MUST NOT map to `skipped_fork_error` (retry → failed),
      // which would re-create the false-failed pin this PR fixes. The explicit
      // arms are mandatory (a new EmbeddingSkipReason silently falling through the
      // never-narrowing default would be mis-mapped to `skipped_fork_error`).
      return "not_required";
    case "no_embeddable_items":
      return "not_required";
    default: {
      // Exhaustiveness check — adding a new EmbeddingSkipReason requires
      // updating this switch.
      const _exhaustive: never = reason;
      void _exhaustive;
      return "skipped_fork_error";
    }
  }
}

/**
 * `web_pages.embeddingBackfillStatus` を安全に更新する（PR2 v0.4.0）。
 * Safely updates `web_pages.embeddingBackfillStatus` (PR2 v0.4.0).
 *
 * DB エラーは致命的でないため、warn ログのみ出力して続行する。
 * DB errors are non-fatal; logs a warning and continues.
 *
 * PR6 TPA #2: `queued` / `in_progress` 遷移時に `embeddingBackfillStartedAt`
 * を同時に設定し、後続の stale 判定を専用列ベースで行えるようにする。
 * `completed` / `failed` / `not_required` 等の終端状態に遷移する場合は
 * `embeddingBackfillStartedAt` を NULL に戻して index を小さく保つ。
 *
 * PR6 TPA #2: Also sets `embeddingBackfillStartedAt` when transitioning to
 * `queued` / `in_progress` so stale detection can rely on a dedicated column.
 * Clears `embeddingBackfillStartedAt` back to NULL on terminal transitions
 * (completed / failed / not_required / skipped_*) to keep the partial index
 * compact.
 *
 * PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): `skipped_fork_error` /
 * `skipped_memory_pressure` 遷移時に `embeddingBackfillSkippedAt` を書き込む。
 * これが NULL のままだと `fetchStaleSkippedPages()` の WHERE が常に空配列を返し、
 * cron Section B + 7d TTL が dead code となるため、ADR-0008 の「最終防衛線」が
 * 破綻する。skipped_* 以外の状態に遷移する場合は NULL に戻す。
 *
 * PR7b-convergence (TPA CRITICAL H-1 / SEC HIGH-1): Writes
 * `embeddingBackfillSkippedAt` when transitioning to `skipped_fork_error` /
 * `skipped_memory_pressure`. Leaving it NULL would make the WHERE clause of
 * `fetchStaleSkippedPages()` match nothing, rendering cron Section B + 7d TTL
 * dead code and breaking ADR-0008's "last line of defense". Cleared back to
 * NULL on transitions to any non-skipped_* state.
 */
async function updateEmbeddingBackfillStatus(
  webPageId: string,
  status: EmbeddingBackfillStatusValue,
  context: { url: string; reason?: EmbeddingSkipReason | undefined }
): Promise<void> {
  try {
    const isActive = status === "queued" || status === "in_progress";
    const isSkipped = status === "skipped_fork_error" || status === "skipped_memory_pressure";
    await prisma.webPage.update({
      where: { id: webPageId },
      data: {
        embeddingBackfillStatus: status,
        embeddingBackfillStartedAt: isActive ? new Date() : null,
        embeddingBackfillSkippedAt: isSkipped ? new Date() : null,
      },
    });
  } catch (updateError) {
    logger.warn("[PageAnalyzeWorker] Failed to update embeddingBackfillStatus", {
      error: sanitizeErrorMessage(updateError),
      webPageId: truncateAuditTargetId(webPageId),
      status,
      reason: context.reason,
      url: context.url,
    });
  }
}

async function processPageAnalyzeJob(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token?: string
): Promise<PageAnalyzeJobResult> {
  const startTime = Date.now();
  const { webPageId, url, options } = job.data;

  // Lock extension: Create periodic lock extender as secondary protection
  // BullMQ's built-in lockRenewTime (lockDuration/2) handles the primary case,
  // but CPU-bound phases (Ollama Vision) may block the event loop.
  const effectiveToken = token ?? job.token ?? "";
  const effectiveLockDuration = DEFAULT_LOCK_DURATION;
  const lockExtender = createLockExtender(
    job,
    effectiveToken,
    effectiveLockDuration,
    DEFAULT_LOCK_EXTEND_INTERVAL
  );

  // Start lock extender before processing phases
  lockExtender.start();

  if (isDevelopment()) {
    logger.info("[PageAnalyzeWorker] Processing job", {
      jobId: job.id,
      webPageId,
      url,
      options,
      lockExtension: {
        lockDuration: effectiveLockDuration,
        extendInterval: DEFAULT_LOCK_EXTEND_INTERVAL,
        hasToken: !!effectiveToken,
      },
    });
  }

  // Initialize status tracker for progress reporting
  // Send detailed progress data including currentPhase and phases for SSE clients
  const statusTracker = new ExecutionStatusTrackerV2({
    webPageId,
    url,
    onStatusChange: (status): void => {
      // Bull Board requires numeric progress (0-100) for the progress bar.
      // Send overallProgress as number, and log phase details via job.log().
      const progress =
        typeof status.overallProgress === "number" && Number.isFinite(status.overallProgress)
          ? Math.round(status.overallProgress)
          : 0;

      // PR-B (v0.4.0 PR7e P5 / SEC-M2-04): 以下 2 点を同時に解消する。
      //   (1) raw `err.message` を `sanitizeErrorMessage()` で汎用メッセージ化
      //       (CWE-209 内部構造漏洩防止 — "Missing key for job <id>" や
      //       Redis internal path 等がログに載る経路を断つ)
      //   (2) `updateProgress` はジョブがアクティブでない場合 (lock 喪失 /
      //       stall 再試行直後 / BullMQ Redis hash 不在) に throw する。
      //       catch 内で err を再 throw しないため、二次 crash への波及は
      //       ない。sanitize されたメッセージを warn ログのみ記録して
      //       fire-and-forget を維持する。
      //
      // PR-B (v0.4.0 PR7e P5 / SEC-M2-04): Addresses two issues at once:
      //   (1) raw `err.message` → `sanitizeErrorMessage()` (CWE-209 leakage
      //       prevention; redacts "Missing key for job <id>" and Redis
      //       internals that would otherwise land in logs).
      //   (2) `updateProgress` may throw when the job is no longer active
      //       (lock lost / post-stall retry / missing BullMQ Redis hash).
      //       The catch does not rethrow, so this stays fire-and-forget —
      //       only the sanitized warn log is recorded.
      job.updateProgress(progress).catch((err: unknown) => {
        logger.warn("[PageAnalyzeWorker] Failed to update job progress", {
          jobId: job.id,
          error: sanitizeErrorMessage(err),
        });
      });

      // Write phase transition to Bull Board Logs tab
      job
        .log(`[${new Date().toISOString()}] Phase: ${status.currentPhase} | Progress: ${progress}%`)
        .catch(() => {
          /* fire-and-forget */
        });
    },
  });

  statusTracker.initialize();

  // Create PhaseContext (immutable across phases)
  const ctx: PhaseContext = {
    job,
    options,
    url,
    webPageId,
    effectiveToken,
    effectiveLockDuration,
    statusTracker,
  };

  // Create PipelineState (mutable, shared across phases)
  const state: PipelineState = {
    actualWebPageId: webPageId,
    // PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2: resolve the
    // url-key at Phase 0 entry so the failure-path url-key upsert can key on
    // the same `url @unique` value as W0 (:1623-1625) / W1 (phase-0-ingest).
    normalizedUrl: normalizeUrlForStorage(url),
    completedPhases: [],
    failedPhases: [],
    results: {},
    layoutResultForNarrative: null,
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    motionResultForEmbedding: null,
    jsAnimationsForEmbedding: null,
    scrollVisionSaveResult: null,
    scrollVisionResultForEmbedding: null,
    scrollVisionCapturesForDeferred: null,
    html: null,
    screenshotBase64: undefined,
    narrativePreDisabled: false,
    visionPreDisabled: false,
    memoryAborted: false,
  };

  // v0.4.0 PR7e-α (バグ④): PhasedDbHandler は `actualWebPageId` が確定する
  // Phase 0 の後にインスタンス化する。例外時も lock は WorkerActiveLockService
  // の TTL に任せ、ここでは fail-open（warn + 続行）で扱う。
  // v0.4.0 PR7e-α (bug ④): PhasedDbHandler is instantiated after Phase 0 so
  // `actualWebPageId` is stable. On failure we log+warn and continue (fail-
  // open); worker-level lock TTL handles cleanup.
  let phasedDb: PhasedDbHandler | null = null;

  // =====================================================
  // PR-B (v0.4.0 PR7e P4): Phase 0 Early INSERT (feature-flagged, default OFF)
  // =====================================================
  // `PHASE0_EARLY_INSERT=true` の場合、`processIngestPhase` を呼ぶ前に
  // `web_pages` の最小行を upsert する (W0)。これにより Phase 0 の早期
  // 失敗 (robots.txt block / SSRF / DNS NXDOMAIN 等) でも DB 行が残り、
  // failure-path の `markAnalysisFailed` / inline update が P2025 で空振り
  // しなくなる。W0 の本旨は `actualWebPageId` を確定することであり、
  // `htmlContent` / `htmlHash` は Phase 0.5 (W1) まで書き込まない。
  //
  // When `PHASE0_EARLY_INSERT=true`, upsert a minimal `web_pages` row BEFORE
  // `processIngestPhase` starts (W0). This ensures that early Phase 0
  // failures (robots.txt / SSRF / DNS) still leave a DB row, so the
  // failure-path `markAnalysisFailed` / inline update no longer no-ops on
  // P2025. W0 only resolves `actualWebPageId`; html content is still
  // written later by Phase 0.5 (W1).
  //
  // =============================================================
  // SAVETODB SEMANTICS — UNIFIED CONTRACT (FIND-PR-B-009)
  // =============================================================
  // `options.layoutOptions?.saveToDb !== false` is the canonical gate for
  // ALL `web_pages` upsert writes in the ingest path. This condition is
  // intentionally symmetric at two call sites:
  //   - W0: page-analyze-worker.ts (this block) — early INSERT under
  //         `PHASE0_EARLY_INSERT=true`, writes `analysisStatus='pending'`.
  //   - W1: phase-0-ingest.ts:~201 — html/hash/crawledAt upsert after
  //         `processIngestPhase` succeeds (does NOT overwrite
  //         `analysisStatus` when W0 already set it).
  //
  // Contract:
  //   - `saveToDb === undefined` (default) → PERSIST (treated as enabled).
  //   - `saveToDb === true` → PERSIST.
  //   - `saveToDb === false` → SKIP (explicit opt-out; transient analysis).
  //
  // Both sites MUST use `!== false` (not `=== true`) to preserve the default
  // behavior. Flipping one site to `=== true` will desynchronize W0/W1 and
  // break INV-PAGE-QUEUE-001-C (PHASE0_EARLY_INSERT failure-path persistence).
  // Any future change to this semantics requires an ADR amendment.
  // =============================================================
  const phase0EarlyInsertEnabled = isPhase0EarlyInsertEnabled();
  if (phase0EarlyInsertEnabled && options.layoutOptions?.saveToDb !== false) {
    try {
      const normalizedUrlForEarlyInsert = normalizeUrlForStorage(url);
      const earlyUpsert = await prisma.webPage.upsert({
        where: { url: normalizedUrlForEarlyInsert },
        create: {
          id: webPageId,
          url: normalizedUrlForEarlyInsert,
          title: null,
          description: null,
          sourceType: "user_provided",
          usageScope: "inspiration_only",
          crawledAt: new Date(),
          analysisStatus: "pending",
        },
        update: {
          // 既存行は `analysisStatus='pending'` に戻すだけ (retry 想定)。
          // `htmlContent` / `htmlHash` は Phase 0.5 (W1) で書き換える。
          // Existing row: reset `analysisStatus='pending'` only (retry flow).
          // `htmlContent` / `htmlHash` are refreshed later by Phase 0.5 (W1).
          analysisStatus: "pending",
          analysisError: null,
          analysisCompletedAt: null,
          lastAnalyzedPhase: null,
        },
        select: { id: true },
      });
      state.actualWebPageId = earlyUpsert.id;
      if (isDevelopment()) {
        logger.debug("[PageAnalyzeWorker] Phase 0 Early INSERT complete", {
          requestedWebPageId: truncateAuditTargetId(webPageId),
          actualWebPageId: truncateAuditTargetId(state.actualWebPageId),
          url,
        });
      }
    } catch (earlyUpsertError) {
      // fail-open: Early INSERT 失敗は non-fatal で続行する。
      // 後続の Phase 0.5 (W1) が通常経路で行を作る想定。
      //
      // fail-open: Early INSERT failure is non-fatal; continue so Phase 0.5
      // (W1) can create the row along the legacy path.
      logger.warn("[PageAnalyzeWorker] Phase 0 Early INSERT failed (non-fatal, continuing)", {
        error: sanitizeErrorMessage(earlyUpsertError),
        webPageId: truncateAuditTargetId(webPageId),
        url,
      });
    }
  }

  try {
    // =====================================================
    // Phase 0: Ingest (HTML取得) + Phase 0.5: WebPage DB Save
    // =====================================================
    const sharedBrowser = await processIngestPhase(state, ctx, {
      pageIngestAdapter,
      prisma,
      screenshotPersistenceService,
      phase0EarlyInsertEnabled,
    });

    // v0.4.0 PR7e-α (バグ④ fix): Phase 0 完了直後に PhasedDbHandler を起動し、
    // analysis_phase_status='pending' + analysis_started_at=NOW を書き込む。
    // 失敗は non-fatal — TPA 指摘 "例外パス trans" 対応で fail-open とする。
    //
    // PR-B (v0.4.0 PR7e P4): `phase0EarlyInsertEnabled=true` でも
    // `markAnalysisStarted` は呼ぶ。理由: このメソッドは `analysisPhaseStatus`
    // と `analysisStartedAt` も更新する (W0 は `analysisStatus` のみ)。
    // 重複書き込みは冪等 (同一値の上書き) なので safe。
    //
    // v0.4.0 PR7e-α (bug ④ fix): Instantiate PhasedDbHandler right after
    // Phase 0 so it writes analysis_phase_status='pending' +
    // analysis_started_at=NOW. Treat failure as non-fatal (TPA "exception
    // path trans" fail-open guidance).
    //
    // PR-B (v0.4.0 PR7e P4): Even with `phase0EarlyInsertEnabled=true` we
    // still call `markAnalysisStarted` because it also advances
    // `analysisPhaseStatus` / `analysisStartedAt` (W0 only touches
    // `analysisStatus`). Duplicate writes are idempotent.
    try {
      phasedDb = new PhasedDbHandler({
        prisma,
        webPageId: state.actualWebPageId,
      });
      await phasedDb.markAnalysisStarted();
    } catch (phasedDbError) {
      logger.warn("[PageAnalyzeWorker] PhasedDbHandler.markAnalysisStarted failed (non-fatal)", {
        error: sanitizeErrorMessage(phasedDbError),
        webPageId: truncateAuditTargetId(state.actualWebPageId),
      });
      phasedDb = null;
    }

    // =====================================================
    // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — INV-WORKER-PID-IDENTITY-005
    //   Sub-A write hook: record `worker_job_lifecycle` spawn-event row.
    // =====================================================
    // The supervisor injects its single-SSOT spawn-time via env var
    // `REFTRIX_WORKER_SPAWN_TIME_MS` (Module B `WorkerSupervisorLifecycle.
    // spawnWorker()`). The child reads it here so the row's `worker_spawn_time`
    // matches the supervisor's `WorkerChildState.startedAt` byte-for-byte —
    // making the supervisor backfill query (`findOrphanWebPageIds`) able to
    // join on `[workerPid, workerSpawnTime]` exactly.
    //
    // Fall back to `Date.now()` for legacy / test runs without supervisor; the
    // join will then degrade to `phase_reconstruction='best_effort'` (TPA-M-01
    // SLO ≤10% rolling 30-day window).
    //
    // UNBLOCK-T4-02 Sub-A write hook (fire-and-forget, non-fatal).
    const spawnTimeMs = readSupervisorInjectedSpawnTimeMs() ?? Date.now();
    state.workerSpawnTimeMs = spawnTimeMs;
    try {
      await recordWorkerSpawn(prisma as unknown as WorkerJobLifecyclePrismaClient, {
        webPageId: state.actualWebPageId,
        workerPid: process.pid,
        workerSpawnTime: new Date(spawnTimeMs),
        workerType: "page",
        nonce: process.env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE ?? randomUUID(),
      });
    } catch (recordSpawnError) {
      // recordWorkerSpawn is fire-and-forget per design; this catch is a
      // belt-and-braces guard against unexpected throws.
      logger.warn("[PageAnalyzeWorker] recordWorkerSpawn outer catch (non-fatal)", {
        error: sanitizeErrorMessage(recordSpawnError),
        webPageId: truncateAuditTargetId(state.actualWebPageId),
      });
    }

    // =====================================================
    // Phase 1 → Phase 3 逐次実行 / Sequential Phase 1 → Phase 3
    // =====================================================
    // v0.3.0: Promise.all 並列実行から逐次実行に変更。
    // Quality P50=0.02ms で並列実行のメリットはほぼゼロ。
    // 逐次実行によりメモリの二重保持を回避し、メモリ効率を改善。
    // 両フェーズは内部で try-catch による Graceful Degradation を実装しており、
    // Phase 1 が失敗しても Phase 3 は実行される。
    //
    // v0.3.0: Changed from Promise.all parallel to sequential execution.
    // Quality P50=0.02ms makes parallelism pointless.
    // Sequential execution avoids dual memory allocation, improving efficiency.
    // Both phases implement internal try-catch Graceful Degradation,
    // so Phase 3 executes even if Phase 1 fails.
    await processLayoutPhase(state, ctx, {
      defaultAnalyzeLayout: defaultAnalyzeLayout as never,
      saveBackgroundDesigns,
      saveSectionPatterns,
      postProcessSections,
      extractPartsFromSection: extractPartsFromSection as never,
      saveExtractedParts: saveExtractedParts as never,
      prisma,
    });
    await processQualityPhase(state, ctx, {
      defaultEvaluateQuality: defaultEvaluateQuality as never,
      saveQualityEvaluation,
      saveQualityBenchmarks,
      buildQualityBenchmarkInputs,
      prisma,
    });

    // =====================================================
    // Ollama Vision Unload (1st point): After Phase 1 / before Phase 1.5
    // Ollama VisionがVRAMにロードされたまま残る。
    // Phase 1.5 (Scroll Capture) のChromium VRAM確保 + Phase 2.5 (Scroll Vision Analysis) の
    // OllamaReadinessProbe VRAM閾値(8192MB)クリアのため、ここで解放する。
    // Phase 2.5でVisionが必要な場合はOllamaが自動再ロードする。
    // 冪等: useVision=falseでVision未ロード時もno-opで安全。
    // =====================================================
    await unloadOllamaVisionModel();

    // =====================================================
    // Phase 1.5 + 2 + 2.5: Motion (includes browser close + Ollama unload 2nd point)
    // =====================================================
    await processMotionPhase(state, ctx, sharedBrowser, {
      captureScrollPositions,
      defaultDetectMotion,
      analyzeScrollCaptures,
      saveMotionPatterns,
      saveJsAnimationPatterns,
      saveScrollVisionResults,
      saveFrameAnalysisToDb,
      gpuResourceManager,
      pageIngestAdapter,
      prisma,
    });

    // =====================================================
    // Phase 4 + 4.5: Narrative + Responsive (includes Ollama unload 3rd point)
    // =====================================================
    await processNarrativePhase(state, ctx, {
      handleNarrativeAnalysis,
      responsiveAnalysisService: responsiveAnalysisService as never,
      responsivePersistenceService: responsivePersistenceService as never,
      validateExternalUrl,
      isUrlAllowedByRobotsTxt,
    });

    // =====================================================
    // v0.4.0 PR7b (ADR-0008 #5 / TPA H-2): Phase 4 dispose
    // Narrative Phase 完了後に in-memory reference を null 化し、Phase 5 fork 前
    // の親 RSS を削減する。screenshot file / sharedBrowser は物理維持
    // （Phase 5 child / Queue-based Backfill が参照するため）。
    // GC + 100ms wait + 3 回平均 RSS 測定で測定ノイズを抑制する。
    //
    // v0.4.0 PR7b (ADR-0008 #5 / TPA H-2): Disposes in-memory references after
    // Narrative Phase to reduce parent RSS before Phase 5 fork. Preserves
    // screenshot files and sharedBrowser physically (referenced by Phase 5
    // child / Queue-based Backfill). Suppresses measurement noise via GC +
    // 100ms wait + 3-sample mean.
    // =====================================================
    {
      const dispose = await disposePhase4Memory(state);
      logger.info("[PageAnalyzeWorker] Phase 4 dispose complete", {
        beforeRssMb: dispose.beforeRssMb,
        afterRssMb: dispose.afterRssMb,
        reclaimedMb: dispose.reclaimedMb,
        url,
      });
    }

    // =====================================================
    // Memory Check 3: Before Phase 5 (Embedding)
    // If memory pressure is critical (shouldAbort=true), skip Phase 5
    // to prevent worker crash. Phase 0-4.5 results are preserved.
    //
    // v0.4.0 PR7b (ADR-0008 #4): 親 RSS upstream guard を追加。Phase 5 fork 前に
    // `PHASE5_PARENT_RSS_MAX_MB` を超えていたら、checkMemoryPressure() を待たず
    // 即時 skip し `skipped_memory_pressure` 経路で全 7 カテゴリを enqueue する。
    //
    // v0.4.0 PR7b (ADR-0008 #4): Adds parent RSS upstream guard. If parent RSS
    // exceeds `PHASE5_PARENT_RSS_MAX_MB` before Phase 5 fork, skip immediately
    // (don't wait for checkMemoryPressure) and enqueue all 7 categories via
    // the `skipped_memory_pressure` path.
    // =====================================================
    let memoryAbortEmbedding = false;
    // PR2 (v0.4.0): Phase 5 がスキップされた理由（サイレント skip 解消）
    // PR2 (v0.4.0): Reason Phase 5 was skipped (silent-skip fix)
    let observedSkipReason: EmbeddingSkipReason | undefined;
    let observedSkipDetail: string | undefined;
    {
      // v0.4.0 PR7b (ADR-0008 #4): 親 RSS upstream guard
      // 既存 checkMemoryPressure() (heapUsed ベース) よりも厳格な親プロセス
      // RSS 閾値 (デフォルト 8192MB、T1 SSOT phase5-config.ts:83) を Phase 5
      // fork 前に評価する。
      //
      // PR-C3 (系統B、plan V1.1 §3.3): ceiling 判定の直前に trim (global.gc +
      // 再計測) を行い、超過時は skip せず ceiling fallback で fork を継続する。
      //
      // v0.4.0 PR7b (ADR-0008 #4): Parent RSS upstream guard.
      // Stricter parent-process RSS threshold (default 8192MB, T1 SSOT
      // phase5-config.ts:83) evaluated before Phase 5 fork, on top of the
      // existing heapUsed-based checkMemoryPressure().
      //
      // PR-C3 (系統B, plan V1.1 §3.3): immediately before the ceiling check,
      // trim (global.gc + re-measure); on over-ceiling, DO NOT skip — proceed
      // via the deterministic ceiling fallback.
      const phase5Config = loadPhase5Config();
      // PR-V3-T1a §3.4.2: parent_rss_ceiling_scaled audit emission (one-shot per
      // process). The helper internally guards on idempotency + scaling-event
      // detection (default 8192 active vs operator override). Failure to emit
      // is logged but does NOT break Phase 5 init — audit logging is
      // observability, not a critical path.
      //
      // PR-V3-T1a §3.4.2: emit `parent_rss_ceiling_scaled` once-per-process
      // when the default 8192 ceiling is active. Helper guards idempotency.
      try {
        await emitParentRssCeilingScaledIfApplicable(phase5Config, async (details) => {
          await getAuditLogService().log({
            action: AUDIT_ACTION_PARENT_RSS_CEILING_SCALED,
            actor: "system:phase5-init",
            targetType: "phase5_config",
            targetId: undefined,
            details,
            result: "success",
          });
        });
      } catch (auditError) {
        // Defensive: emitParentRssCeilingScaledIfApplicable already swallows
        // emitter exceptions, but we wrap once more so a future refactor can't
        // accidentally regress Phase 5 init on audit-log failure.
        logger.warn(
          "[PageAnalyzeWorker] parent_rss_ceiling_scaled audit emission unexpected error (non-fatal)",
          {
            error: auditError instanceof Error ? auditError.message : String(auditError),
          }
        );
      }
      // PR-C3 (系統B, plan V1.1 §3.3 / §4.3): trim parent RSS (global.gc +
      // re-measure) immediately BEFORE the ceiling check, then decide. The
      // helper ALWAYS proceeds (never skips on the parent-RSS gate): within
      // ceiling → normal proceed; over ceiling after trim → deterministic
      // ceiling fallback (proceed anyway, ADR-0013 soft envelope, FIND-IO-V0-H-02).
      // graceful degradation when --expose-gc is absent (logger.warn, no
      // isDevelopment guard, SEC L-SEC-3 / FIND-IO-V0-L-05).
      const trimDecision = trimParentRssAndDecide(
        phase5Config.parentRssMaxMb,
        tryGarbageCollect,
        () => Math.round(process.memoryUsage().rss / 1024 / 1024),
        logger
      );
      // Observability (FIND-IO-V0-L-09): surface the trim outcome so the
      // post-GC reclaim, the ceiling fallback, and a missing --expose-gc are all
      // traceable in the log stream (the helper additionally logger.warn's the
      // no-op / fallback cases). The parent-RSS gate no longer skips Phase 5; the
      // hard OOM defence is the heap-critical checkMemoryPressure() abort below
      // (plus the per-chunk RSS budget + the fork-kill 4096 backstop in the child).
      logger.info("[PageAnalyzeWorker] [PR-C3] parent RSS trim before Phase 5 fork", {
        preTrimRssMb: trimDecision.preTrimRssMb,
        postTrimRssMb: trimDecision.postTrimRssMb,
        ceilingMb: trimDecision.ceilingMb,
        gcTriggered: trimDecision.gcTriggered,
        ceilingFallback: trimDecision.ceilingFallback,
        url,
      });
      const memCheck3 = checkMemoryPressure();
      if (memCheck3.shouldAbort) {
        logger.warn(
          "[PageAnalyzeWorker] [Memory Critical] RSS high before embedding, skipping Phase 5 to preserve worker stability",
          {
            rssMb: memCheck3.rssMb,
            threshold: MEMORY_CRITICAL_THRESHOLD_MB,
            url,
          }
        );
        state.failedPhases.push("embedding" as AnalysisPhase);
        memoryAbortEmbedding = true;
        // Worker-level memory guard is conceptually the same failure class as
        // the fork-orchestrator's MIN_HEAP_HEADROOM_BYTES check → reuse that
        // EmbeddingSkipReason for consistent telemetry.
        observedSkipReason = "v8_heap_headroom_low";
        observedSkipDetail = truncateSkipDetail(
          `worker RSS=${memCheck3.rssMb}MB > ${MEMORY_CRITICAL_THRESHOLD_MB}MB`
        );
      }
    }

    // =====================================================
    // Phase 5: Embedding Generation (delegated to processEmbeddingPhase)
    // =====================================================
    // Extend lock before Embedding phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, "embedding");

    const responsiveAnalysisIdForEmbedding = state.results?.responsive?.responsiveAnalysisId;
    const embeddingEnabled =
      !memoryAbortEmbedding &&
      state.actualWebPageId &&
      ((state.sectionSaveResult?.idMapping?.size ?? 0) +
        (state.motionSaveResult?.idMapping?.size ?? 0) +
        (state.jsSaveResult?.idMapping?.size ?? 0) +
        (state.bgSaveResult?.idMapping?.size ?? 0) +
        (state.scrollVisionSaveResult?.idMapping?.size ?? 0) >
        0 ||
        !!responsiveAnalysisIdForEmbedding ||
        (state.results?.partExtraction?.totalPartsSaved ?? 0) > 0);

    // v0.4.0 PR4: partsSavedCountForPhase5 を `if (embeddingEnabled)` の外側で計算する。
    // Phase 5 が skip された場合（memoryAbort や embeddingEnabled=false）でも、
    // 下流の backfill dispatch 判定で参照するため。
    // v0.4.0 PR4: Compute partsSavedCountForPhase5 outside the `if (embeddingEnabled)`
    // block because the downstream backfill dispatch logic needs it even when
    // Phase 5 is skipped (memoryAbort or embeddingEnabled=false).
    const partsSavedCountForPhase5 = state.results?.partExtraction?.totalPartsSaved ?? 0;

    if (embeddingEnabled) {
      // GPU Resource Manager: Acquire GPU for Embedding (unloads Ollama, switches ONNX to CUDA)
      try {
        const embeddingAcquireResult = await gpuResourceManager.acquireForEmbedding();
        logger.debug("[PageAnalyzeWorker] GPU acquired for embedding", {
          acquired: embeddingAcquireResult.acquired,
          fallbackToCpu: embeddingAcquireResult.fallbackToCpu,
        });
      } catch (gpuError) {
        logger.warn("[PageAnalyzeWorker] GPU acquire for embedding failed, using CPU", {
          error: gpuError instanceof Error ? gpuError.message : String(gpuError),
        });
        // Continue with CPU mode - embedding will work, just slower
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_START);

      // OOM-3: Phase 5 前メモリ診断 — job.log で Redis に永続化
      // logger.info は V8 OOM でプロセスが異常終了すると失われるが、
      // job.log は Redis に書き込み済みなので事後調査に利用可能。
      // OOM-3: Pre-Phase 5 memory diagnostic — persisted to Redis via job.log.
      // logger.info is lost on V8 OOM crash, but job.log is already in Redis.
      {
        const mem = process.memoryUsage();
        const v8Stats = (await import("node:v8")).getHeapStatistics();
        await job.log(
          `[Phase 5] Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, ` +
            `heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
            `heapLimit=${Math.round(v8Stats.heap_size_limit / 1024 / 1024)}MB, ` +
            `external=${Math.round(mem.external / 1024 / 1024)}MB, ` +
            `arrayBuffers=${Math.round(mem.arrayBuffers / 1024 / 1024)}MB, ` +
            `screenshotBase64=${state.screenshotBase64 ? Math.round(state.screenshotBase64.length / 1024) + "KB" : "none"}, ` +
            `screenshotPngPath=${state.screenshotPngPath ? "exists" : "none"}`
        );
      }

      await job.log("[Phase 5] Embedding generation started");

      // Wrap dispatchEmbeddingPhase in try-catch to prevent worker crash on
      // Phase 5 failures (OOM, fork crash, IPC error). On failure, the job
      // completes as partialSuccess with Phase 0-4.5 results preserved.
      let embeddingPhaseResult: Awaited<ReturnType<typeof dispatchEmbeddingPhase>> | undefined;
      // v0.4.0 PR4: 100 件を超える Part が存在する場合、同期フェーズは先頭 100 件のみ
      // 処理し、残余は本 Phase 5 完了後に `embedding-backfill` Queue へ投入する。
      // partsLimit=undefined は「無制限」を意味し、100 件以下のページは従来通り全件同期処理。
      //
      // v0.4.0 PR4: When there are more than 100 Parts, the sync phase processes
      // only the first 100; the remainder is enqueued on the `embedding-backfill`
      // Queue after Phase 5. partsLimit=undefined means "no limit" — pages with
      // 100 Parts or fewer continue to process synchronously as before.
      const partsLimitForSyncPhase =
        partsSavedCountForPhase5 > PART_SYNC_THRESHOLD ? PART_SYNC_THRESHOLD : undefined;
      try {
        embeddingPhaseResult = await dispatchEmbeddingPhase(
          {
            webPageId: state.actualWebPageId,
            url,
            job,
            effectiveToken,
            effectiveLockDuration,
            sectionSaveResult: state.sectionSaveResult,
            motionSaveResult: state.motionSaveResult,
            jsSaveResult: state.jsSaveResult,
            bgSaveResult: state.bgSaveResult,
            scrollVisionSaveResult: state.scrollVisionSaveResult,
            layoutResultForNarrative: state.layoutResultForNarrative,
            motionResultForEmbedding: state.motionResultForEmbedding,
            jsAnimationsForEmbedding: state.jsAnimationsForEmbedding,
            scrollVisionResultForEmbedding: state.scrollVisionResultForEmbedding,
            responsiveAnalysisId: responsiveAnalysisIdForEmbedding,
            partsSavedCount: partsSavedCountForPhase5,
            // v0.4.0 PR4: 同期フェーズの Part embedding 上限（100 件超のページのみ設定）
            // v0.4.0 PR4: Sync-phase Part embedding cap (set only for >100 pages)
            partsLimit: partsLimitForSyncPhase,
            screenshotPngPath: state.screenshotPngPath,
            sharedBrowser,
            onProgress: createPhaseProgressInterpolator(
              job,
              PHASE_PROGRESS.EMBEDDING_START,
              PHASE_PROGRESS.EMBEDDING_COMPLETE
            ),
          },
          {
            sharedLayoutEmbeddingService,
            prisma: prisma as never,
          }
        );
      } catch (embeddingError) {
        // Phase 5 failed — record as failed phase but keep worker alive.
        // Phase 0-4.5 results are already saved to DB and preserved in state.
        const errorDetail = sanitizeErrorMessage(embeddingError);
        logger.warn(
          "[PageAnalyzeWorker] Phase 5 (Embedding) failed — recording as partialSuccess",
          {
            error: errorDetail,
            url,
          }
        );
        state.failedPhases.push("embedding" as AnalysisPhase);
        // PR2 (v0.4.0) + TDA MEDIUM 1 (v0.4.0 PR2 監査):
        // 外側 catch は dispatchEmbeddingPhase 全体の例外 (text/visual いずれに
        // 由来するか不明なケース) なので、汎用分類 `dispatch_phase_failed` を
        // 採用する。旧実装では `text_fork_failed` 固定で Visual 側経路の
        // 例外を誤分類するリスクがあった。これは「最初に発火した理由」を
        // 保持するため、runPhase5ViaFork 内で既に具体的な reason が設定
        // 済みならそちらを優先する。
        // PR2 (v0.4.0) + TDA MEDIUM 1 (v0.4.0 PR2 audit):
        // The outer catch covers any exception thrown by dispatchEmbeddingPhase
        // (origin unknown — text or visual path). We record the generic
        // `dispatch_phase_failed` classification. The previous implementation
        // hard-coded `text_fork_failed`, risking mis-classification of Visual
        // path exceptions. Because setSkipReasonIfUnset only sets the first
        // reason, any more specific reason already set by runPhase5ViaFork is
        // preserved.
        if (observedSkipReason === undefined) {
          observedSkipReason = "dispatch_phase_failed";
          observedSkipDetail = truncateSkipDetail(errorDetail);
        }
        await job.log(`[Phase 5] Embedding failed: ${errorDetail}`);
      }

      // v0.4.0 PR7d-1 (ADR-0010): Phase 5 Screenshot は永続化パス
      //   `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png` に保存され、
      //   削除は (1) GDPR `data.delete` (Art. 17 同期削除) + (2) PR6 TTL cron
      //   (7d) の 2 経路のみ。Worker 側で即時削除すると Queue-based Backfill
      //   (`part_visual` / `section_visual`) が screenshot を参照できず
      //   visual embedding が 0 件になる（ADR-0009 バグ 2 の再発）。
      //   ここでは in-memory 参照のみ null 化する（後続のダブル実行を防ぐ）。
      //
      // v0.4.0 PR7d-1 (ADR-0010): Phase 5 screenshots live at the persisted
      //   path `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`. Deletion
      //   is consolidated into exactly two paths: (1) GDPR `data.delete`
      //   (Art. 17, synchronous) + (2) PR6 TTL cron (7d). Any eager deletion
      //   by the worker would regress ADR-0009 Bug 2 — Queue-based Backfill
      //   (`part_visual` / `section_visual`) would read a zero-byte file and
      //   generate no visual embeddings. We therefore only null-out the
      //   in-memory reference here.
      if (state.screenshotPngPath) {
        delete state.screenshotPngPath;
      }

      tryGarbageCollect();

      // =====================================================
      // Map embedding phase result back to job results (PR2 v0.4.0)
      // Safety: state.results is always initialized to {} in PipelineState
      // construction (line ~315), but the type is optional because
      // PageAnalyzeJobResult.results is optional. Assert non-null here since
      // we know it's always set.
      //
      // PR2 (v0.4.0): サイレント skip バグを解消する。
      //   - カウント合計 > 0: 通常通り completedPhases に push する。
      //   - カウント合計 = 0 + completed = false + skipReason あり:
      //     サイレント skip を検知し、failedPhases に push して
      //     results.embedding.skipReason を埋める。
      //   - どちらにも当てはまらない（dispatch が例外を投げた場合）は、
      //     外側 catch ですでに failedPhases に push 済み。
      //
      // PR2 (v0.4.0): Silent-skip bug fix.
      //   - Total counts > 0  → push to completedPhases as usual.
      //   - Total counts == 0 + completed == false + skipReason present
      //     → detect silent skip, push to failedPhases, populate
      //       results.embedding.skipReason.
      //   - Neither applies (dispatch threw) → outer catch already pushed.
      // =====================================================
      const results = state.results!;

      // Forward skip reason surfaced by the fork orchestrator to the outer
      // observability variables so the post-embedding block can act on them.
      if (embeddingPhaseResult?.skipReason !== undefined && observedSkipReason === undefined) {
        observedSkipReason = embeddingPhaseResult.skipReason;
        observedSkipDetail = embeddingPhaseResult.skipDetail;
      }

      const totalEmbeddingsGenerated = embeddingPhaseResult
        ? embeddingPhaseResult.sectionEmbeddingsGenerated +
          embeddingPhaseResult.sectionVisualEmbeddingsGenerated +
          embeddingPhaseResult.motionEmbeddingsGenerated +
          embeddingPhaseResult.bgEmbeddingsGenerated +
          embeddingPhaseResult.jsAnimationEmbeddingsGenerated +
          embeddingPhaseResult.responsiveEmbeddingsGenerated +
          embeddingPhaseResult.partEmbeddingsGenerated +
          embeddingPhaseResult.partVisualEmbeddingsGenerated
        : 0;

      if (embeddingPhaseResult && totalEmbeddingsGenerated > 0) {
        const embeddingResult: NonNullable<PageAnalyzeJobResult["results"]>["embedding"] = {};
        if (embeddingPhaseResult.sectionEmbeddingsGenerated > 0) {
          embeddingResult.sectionEmbeddingsGenerated =
            embeddingPhaseResult.sectionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0) {
          embeddingResult.sectionVisualEmbeddingsGenerated =
            embeddingPhaseResult.sectionVisualEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.motionEmbeddingsGenerated > 0) {
          embeddingResult.motionEmbeddingsGenerated =
            embeddingPhaseResult.motionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.bgEmbeddingsGenerated > 0) {
          embeddingResult.backgroundDesignEmbeddingsGenerated =
            embeddingPhaseResult.bgEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0) {
          embeddingResult.jsAnimationEmbeddingsGenerated =
            embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.responsiveEmbeddingsGenerated > 0) {
          embeddingResult.responsiveEmbeddingsGenerated =
            embeddingPhaseResult.responsiveEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partEmbeddingsGenerated > 0) {
          embeddingResult.partEmbeddingsGenerated = embeddingPhaseResult.partEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.partVisualEmbeddingsGenerated > 0) {
          embeddingResult.partVisualEmbeddingsGenerated =
            embeddingPhaseResult.partVisualEmbeddingsGenerated;
        }
        results.embedding = embeddingResult;
      }

      if (embeddingPhaseResult?.completed) {
        state.completedPhases.push("embedding" as AnalysisPhase);
      } else if (
        embeddingPhaseResult !== undefined &&
        totalEmbeddingsGenerated === 0 &&
        embeddingPhaseResult.skipReason !== undefined &&
        !state.failedPhases.includes("embedding" as AnalysisPhase)
      ) {
        // PR2 (v0.4.0): サイレント skip を検知 — これが本 PR の修正の核心。
        // PR2 (v0.4.0): Silent-skip detected — this is the core of this PR.
        state.failedPhases.push("embedding" as AnalysisPhase);
        logger.warn(
          "[PageAnalyzeWorker] Phase 5 silently skipped — recorded as failed phase (PR2)",
          {
            skipReason: embeddingPhaseResult.skipReason,
            skipDetail: embeddingPhaseResult.skipDetail,
            webPageId: truncateAuditTargetId(state.actualWebPageId),
            url,
          }
        );
        await job.log(
          `[Phase 5] Silent skip detected: reason=${embeddingPhaseResult.skipReason}, detail=${embeddingPhaseResult.skipDetail ?? "n/a"}`
        );
      }

      // PR2 (v0.4.0): skipReason を response の results.embedding に埋める
      // PR2 (v0.4.0): Surface skipReason to MCP clients via results.embedding
      if (observedSkipReason !== undefined) {
        if (!results.embedding) {
          results.embedding = {};
        }
        results.embedding.skipReason = observedSkipReason;
        if (observedSkipDetail !== undefined) {
          results.embedding.skipDetail = observedSkipDetail;
        }
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_COMPLETE);

      // =====================================================
      // Post-Embedding: Release in-memory refs and Counter Reconciliation
      // =====================================================
      {
        // Release all in-memory refs to minimize RSS
        state.layoutResultForNarrative = null;
        state.motionResultForEmbedding = null;
        state.jsAnimationsForEmbedding = null;
        state.scrollVisionResultForEmbedding = null;
        tryGarbageCollect();

        // =====================================================
        // FIX(Bug-2): Post-Phase 5 Counter Reconciliation
        // The fork child may generate embeddings (saved to DB) but the
        // IPC-relayed counter can be 0 due to IPC race condition (exit event
        // fires before message event). Reconcile ALL counters against the
        // authoritative DB state.
        //
        // PR5 (v0.4.0): 4 カテゴリ (section/part/motion/bg) から 9 カテゴリへ拡張。
        // Part は text / visual を独立集計し、js_animation / responsive /
        // section_visual も DB と整合させる。PR4 で part_text / part_visual が
        // 非同期 backfill に分割されたため、同期フェーズ完了時点での実生成数を
        // DB self-discovery で厳密に取得する。
        //
        // PR5 (v0.4.0): Extended from 4 to 9 counters. Part now splits into
        // text / visual, and js_animation / responsive / section_visual are
        // reconciled against the DB as well. Because PR4 split part_text /
        // part_visual into async backfill, we must derive the accurate
        // sync-phase totals directly from the DB.
        // =====================================================
        {
          // PR5 (v0.4.0): Prisma の `Unsupported("vector(768)")` カラムは
          // where 句 `{ not: null }` を受け付けないため、text/visual の非 NULL
          // カウントだけ生 SQL を用いる。他はリレーション経由で Prisma 標準
          // API を使用する。
          //
          // PR5 (v0.4.0): Prisma's `Unsupported("vector(768)")` columns don't
          // support `{ not: null }` in `where`, so non-null counts for
          // text/visual use raw SQL. The remaining counts use the Prisma API
          // via relations as before.
          //
          // PR6 TDA TD-1: ローカルヘルパー `queryCountNonNull` は
          // `utils/prisma-raw-count.ts` の `countNonNullVector` に抽出。
          // table / column は allowlist で閉じ込め、webPageId はパラメータ化される。
          //
          // PR6 TDA TD-1: Local helper `queryCountNonNull` extracted to
          // `countNonNullVector` in `utils/prisma-raw-count.ts`. Table / column
          // are enforced via allowlist; webPageId is parameterized.
          const [
            sectionEmbDbCount,
            sectionVisualEmbDbCount,
            partTextEmbDbCount,
            partVisualEmbDbCount,
            motionEmbDbCount,
            bgEmbDbCount,
            jsAnimationEmbDbCount,
            responsiveEmbDbCount,
          ] = await Promise.all([
            countNonNullVector({
              prisma,
              table: "section_embeddings",
              column: "text_embedding",
              joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
              webPageIdColumn: "sp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "section_embeddings",
              column: "vision_embedding",
              joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
              webPageIdColumn: "sp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "component_part_embeddings",
              column: "text_embedding",
              joinFragment: "JOIN component_parts cp ON t.component_part_id = cp.id",
              webPageIdColumn: "cp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            countNonNullVector({
              prisma,
              table: "component_part_embeddings",
              column: "visual_embedding",
              joinFragment: "JOIN component_parts cp ON t.component_part_id = cp.id",
              webPageIdColumn: "cp.web_page_id",
              webPageId: state.actualWebPageId,
            }),
            prisma.motionEmbedding.count({
              where: { motionPattern: { webPageId: state.actualWebPageId } },
            }),
            prisma.backgroundDesignEmbedding.count({
              where: { backgroundDesign: { webPageId: state.actualWebPageId } },
            }),
            prisma.jSAnimationEmbedding.count({
              where: { jsAnimationPattern: { webPageId: state.actualWebPageId } },
            }),
            prisma.responsiveAnalysisEmbedding.count({
              where: { responsiveAnalysis: { webPageId: state.actualWebPageId } },
            }),
          ]);

          if (!results.embedding) {
            results.embedding = {};
          }

          const reconcile = (
            field: keyof NonNullable<typeof results.embedding>,
            dbCount: number,
            label: string
          ): void => {
            const reported = (results.embedding![field] as number | undefined) ?? 0;
            if (dbCount > reported) {
              (results.embedding as Record<string, number>)[field] = dbCount;
              logger.warn(`[PageAnalyzeWorker] ${label} embedding counter reconciled from DB`, {
                dbCount,
                reportedCount: reported,
                url,
              });
            }
          };

          // PR5: 9 カテゴリ reconciliation / 9-category reconciliation
          reconcile("sectionEmbeddingsGenerated", sectionEmbDbCount, "Section");
          reconcile("sectionVisualEmbeddingsGenerated", sectionVisualEmbDbCount, "SectionVisual");
          reconcile("partEmbeddingsGenerated", partTextEmbDbCount, "PartText");
          reconcile("partVisualEmbeddingsGenerated", partVisualEmbDbCount, "PartVisual");
          reconcile("motionEmbeddingsGenerated", motionEmbDbCount, "Motion");
          reconcile("backgroundDesignEmbeddingsGenerated", bgEmbDbCount, "Background");
          reconcile("jsAnimationEmbeddingsGenerated", jsAnimationEmbDbCount, "JsAnimation");
          reconcile("responsiveEmbeddingsGenerated", responsiveEmbDbCount, "Responsive");

          // PR2 (v0.4.0): IPC race で silent-skip を誤検知した場合の補正。
          // DB reconciliation で実際には embedding が書き込まれていたと判明
          // した場合、failedPhases から embedding を取り除いて
          // completedPhases に移す。results.embedding.skipReason も削除。
          //
          // PR2 (v0.4.0): Correct a false silent-skip caused by IPC race.
          // If DB reconciliation found embeddings were actually written,
          // move "embedding" from failedPhases to completedPhases and clear
          // the skipReason surfaced earlier.
          //
          // PR5 (v0.4.0): 9 カテゴリの合計で判定。
          // PR5 (v0.4.0): Decision based on 9-category sum.
          const dbTotal =
            sectionEmbDbCount +
            sectionVisualEmbDbCount +
            partTextEmbDbCount +
            partVisualEmbDbCount +
            motionEmbDbCount +
            bgEmbDbCount +
            jsAnimationEmbDbCount +
            responsiveEmbDbCount;
          if (
            dbTotal > 0 &&
            state.failedPhases.includes("embedding" as AnalysisPhase) &&
            !state.completedPhases.includes("embedding" as AnalysisPhase)
          ) {
            state.failedPhases = state.failedPhases.filter(
              (p) => p !== ("embedding" as AnalysisPhase)
            );
            state.completedPhases.push("embedding" as AnalysisPhase);
            if (results.embedding) {
              delete results.embedding.skipReason;
              delete results.embedding.skipDetail;
            }
            observedSkipReason = undefined;
            observedSkipDetail = undefined;
            logger.info(
              "[PageAnalyzeWorker] Silent-skip misdetection corrected via DB reconciliation (PR2)",
              {
                dbTotal,
                webPageId: truncateAuditTargetId(state.actualWebPageId),
                url,
              }
            );
          }
        }

        // Log AFTER Counter Reconciliation so values reflect DB-authoritative counts
        {
          const emb = results.embedding;
          await job.log(
            `[Phase 5] Embedding complete: sections=${emb?.sectionEmbeddingsGenerated ?? 0}, parts=${emb?.partEmbeddingsGenerated ?? 0}, visual=${emb?.sectionVisualEmbeddingsGenerated ?? 0}, motion=${emb?.motionEmbeddingsGenerated ?? 0}, bg=${emb?.backgroundDesignEmbeddingsGenerated ?? 0}`
          );
        }
      }
    }

    // =====================================================
    // PR4 (v0.4.0): Queue-based Backfill 投入
    // PR4 (v0.4.0): Queue-based Backfill enqueue
    //
    // 100 件を超える Part を持つページでは、Phase 5 は先頭 100 件のみを同期処理
    // している。残余 (part_*) を `embedding-backfill` Queue に投入して非同期に
    // バックフィルする。screenshot 永続化パスが未保存 (PR1 前の旧データ) の場合は
    // `part_visual` のみスキップ。
    //
    // PR-BACKFILL-TERMINAL (系統A): dispatch invocation を part-threshold gate の
    // 外に移し、**page.analyze 完了した全ページ** (actualWebPageId が存在する全て)
    // で呼ぶ。motion/bg/js/responsive の 4 gate-less category は part 数に依存せず
    // 投入が必要なため (`dispatchBackfillJobsForPage` 内で part / section_visual の
    // gate は preserve)。従来は `partsSavedCount > PART_SYNC_THRESHOLD` で dispatch
    // 全体を gate していたため、small page (parts<=100) で gate-less category が
    // 永久に未 enqueue → parity pending>0 → reconciliation cron が `failed` に誤 pin
    // していた。
    //
    // For pages over the threshold, Phase 5 processed only the first 100 parts
    // synchronously; the overflow part_* is backfilled. PR-BACKFILL-TERMINAL
    // (System A): the dispatch invocation is moved OUTSIDE the part-threshold gate
    // so it runs for EVERY completed page (any valid actualWebPageId) — the 4
    // gate-less categories (motion/bg/js/responsive) are part-count-independent
    // and must always be enqueued (`dispatchBackfillJobsForPage` preserves the
    // part / section_visual gates internally). Previously the whole dispatch was
    // gated on `partsSavedCount > PART_SYNC_THRESHOLD`, so small pages never
    // enqueued the gate-less categories → parity pending stayed > 0 → the
    // reconciliation cron mis-pinned the page to `failed`.
    // =====================================================
    // PR-C2 (Layer 2, ADR-0007 Amendment 3): worker-scope captures for the two
    // relocated enqueue paths. Both closures are DEFINED here (where their inputs
    // are in scope) but EXECUTED after `markAnalysisCompleted` via
    // `enqueueBackfillAfterMarkComplete` (plan §3.2). `recoverySkipReason` is the
    // recovery-eligible skip reason captured during the skipReason block below
    // (undefined when the page was NOT skipped via a recovery-eligible reason).
    //
    // PR-C2 (Layer 2, ADR-0007 Amendment 3): 両 relocation path の worker-scope capture。
    // closure は input が in-scope のここで定義し markComplete 後に実行する。
    let recoverySkipReason: EmbeddingSkipReason | undefined;
    let runSkipRecoveryEnqueue:
      | (() => Promise<{
          enqueuedCategories: EmbeddingBackfillCategory[];
          skipRecoveryPending: unknown | undefined;
        }>)
      | undefined;

    // PR-C2 (Layer 2, ADR-0007 Amendment 3): the sync_overflow enqueue is
    // CAPTURED as a closure here but EXECUTED after `markAnalysisCompleted`
    // (below, via `enqueueBackfillAfterMarkComplete`). Running it after the
    // analysis status becomes terminal means the backfill worker's analysis
    // guard returns `proceed` (re_enqueue churn removed from the happy path).
    // The closure body is the former inline block verbatim (no new logic).
    //
    // PR-C2 (Layer 2, ADR-0007 Amendment 3): sync_overflow enqueue を closure 化し
    // markComplete 後に実行 (guard が terminal status を見て proceed、re_enqueue churn 排除)。
    const runSyncOverflowEnqueue = async (): Promise<{
      enqueuedCategories: EmbeddingBackfillCategory[];
      backfillPending: unknown | undefined;
    }> => {
      let enqueuedCategories: EmbeddingBackfillCategory[] = [];
      let surfacedPending: unknown | undefined;
      if (!state.actualWebPageId) {
        return { enqueuedCategories, backfillPending: surfacedPending };
      }
      // Persisted screenshot path を DB から取得（PR1 で保存済みなら非 null）
      // Fetch persisted screenshot path from DB (non-null if saved by PR1)
      let persistedScreenshotPath: string | undefined;
      try {
        const webPageRow = await prisma.webPage.findUnique({
          where: { id: state.actualWebPageId },
          select: { screenshotStoragePath: true },
        });
        if (webPageRow?.screenshotStoragePath) {
          persistedScreenshotPath = webPageRow.screenshotStoragePath;
        }
      } catch (fetchError) {
        logger.warn(
          "[PageAnalyzeWorker] Failed to fetch screenshotStoragePath for backfill dispatch",
          {
            error: sanitizeErrorMessage(fetchError),
            webPageId: truncateAuditTargetId(state.actualWebPageId),
          }
        );
      }

      // v0.4.0 PR7e-α (バグ⑥): section_visual を backfill 対象に追加。
      // sectionsSavedCount は sectionSaveResult.idMapping.size (Phase 1 で
      // 保存した section 数) から取得。screenshotStoragePath と組み合わせて
      // SectionVisualProcessor が DINOv2 でベクトル再生成する条件となる。
      //
      // v0.4.0 PR7e-α (bug ⑥): pass sectionsSavedCount (from Phase 1's
      // sectionSaveResult.idMapping.size) so the Backfill Worker can enqueue
      // `section_visual` jobs for DINOv2 vision_embedding regeneration.
      const sectionsSavedCountForPhase5 = state.sectionSaveResult?.idMapping?.size ?? 0;
      enqueuedCategories = await dispatchBackfillJobsForPage({
        webPageId: state.actualWebPageId,
        url,
        partsSavedCount: partsSavedCountForPhase5,
        sectionsSavedCount: sectionsSavedCountForPhase5,
        screenshotStoragePath: persistedScreenshotPath,
      });

      if (enqueuedCategories.length > 0) {
        // backfill 投入済みなので status を `queued` に遷移させる
        // Transition status to `queued` since backfill jobs are enqueued
        await updateEmbeddingBackfillStatus(state.actualWebPageId, "queued", {
          url,
          reason: undefined,
        });
        await job.log(
          `[Phase 5] Enqueued backfill jobs: categories=${enqueuedCategories.join(",")}, ` +
            `partsSaved=${partsSavedCountForPhase5}, syncProcessed=${PART_SYNC_THRESHOLD}`
        );
        logger.info("[PageAnalyzeWorker] Enqueued embedding backfill jobs", {
          webPageId: truncateAuditTargetId(state.actualWebPageId),
          categories: enqueuedCategories,
          partsSavedCount: partsSavedCountForPhase5,
          syncProcessed: PART_SYNC_THRESHOLD,
        });

        // PR5 (v0.4.0): MCP response に backfillPending を埋める。
        // PR6 TDA TD-3: pure builder (`buildBackfillPending`) に抽出し worker 本体を薄く保つ。
        //
        // PR5 (v0.4.0): Populate `backfillPending` on the MCP response.
        // PR6 TDA TD-3: extracted to pure builder (`buildBackfillPending`) to keep
        // the worker thin.
        const backfillPending = buildBackfillPending({
          partsSaved: partsSavedCountForPhase5,
          threshold: PART_SYNC_THRESHOLD,
          avgMsPerItem: BACKFILL_AVG_MS_PER_ITEM,
          webPageId: state.actualWebPageId,
          enqueuedTextCategory: enqueuedCategories.includes("part_text"),
          enqueuedVisualCategory: enqueuedCategories.includes("part_visual"),
          // v0.4.0 PR7e-α (バグ⑥): section_visual backfill dispatch の有無を伝搬
          // v0.4.0 PR7e-α (bug ⑥): propagate section_visual dispatch status
          enqueuedSectionVisualCategory: enqueuedCategories.includes("section_visual"),
        });

        if (backfillPending) {
          const backfillResults = state.results!;
          if (!backfillResults.embedding) {
            backfillResults.embedding = {};
          }
          backfillResults.embedding.backfillPending = backfillPending;
          surfacedPending = backfillPending;
        }
      }
      return { enqueuedCategories, backfillPending: surfacedPending };
    };

    // =====================================================
    // PR2 (v0.4.0): web_pages.embeddingBackfillStatus を更新 + skipReason を
    // response に埋める。memoryAbort パスなど `if (embeddingEnabled)` ブロックを
    // 経由しなかった場合の skipReason 露出もここで処理する。
    //
    // PR2 (v0.4.0): Update web_pages.embeddingBackfillStatus and surface the
    // skipReason on the response. Also handles paths that bypassed the
    // `if (embeddingEnabled)` block (e.g. memoryAbort) so skipReason is
    // still emitted.
    //
    // 以下のすべてのパス（memoryAbort / embeddingEnabled=false / 正常完了 /
    // silent skip / 例外）を網羅するため、Phase 5 ブロックの外側で一括で更新する。
    // 値は `skipReasonToBackfillStatus()` が EmbeddingSkipReason から導出する。
    // skipReason が未設定 = 'not_required'（デフォルト）のまま維持。
    //
    // Unified update outside the Phase 5 block to cover all paths:
    // memoryAbort / embeddingEnabled=false / normal completion / silent skip
    // / exception. The status is derived from EmbeddingSkipReason via
    // `skipReasonToBackfillStatus()`. When skipReason is unset, the column
    // stays at its default 'not_required'.
    // =====================================================
    if (observedSkipReason !== undefined) {
      // Ensure results.embedding.skipReason is populated even on paths
      // that bypassed the `if (embeddingEnabled)` block.
      const embeddingResults = state.results!;
      if (!embeddingResults.embedding) {
        embeddingResults.embedding = {};
      }
      if (embeddingResults.embedding.skipReason === undefined) {
        embeddingResults.embedding.skipReason = observedSkipReason;
        if (observedSkipDetail !== undefined) {
          embeddingResults.embedding.skipDetail = observedSkipDetail;
        }
      }

      const backfillStatus = skipReasonToBackfillStatus(observedSkipReason);
      await updateEmbeddingBackfillStatus(state.actualWebPageId, backfillStatus, {
        url,
        reason: observedSkipReason,
      });

      // v0.4.0 PR7b (ADR-0008 #2): Skip recovery — Phase 5 全体 skip 時に
      // 全 7 カテゴリを `embedding-backfill` Queue へ enqueue する。
      // `not_required`（no_embeddable_items）は recovery 不要、
      // `failed`（dispatch_phase_failed の最終分類）も recovery 対象外。
      // recovery 対象は `skipped_fork_error` / `skipped_memory_pressure` のみ。
      //
      // v0.4.0 PR7b (ADR-0008 #2): Skip recovery — enqueue all 7 categories on
      // full Phase 5 skip. `not_required` (no_embeddable_items) needs no
      // recovery; `failed` (final dispatch_phase_failed classification) is not
      // recovery-eligible. Only `skipped_fork_error` / `skipped_memory_pressure`
      // trigger recovery.
      if (backfillStatus === "skipped_fork_error" || backfillStatus === "skipped_memory_pressure") {
        // PR-C2 (Layer 2, ADR-0007 Amendment 3): CAPTURE the recovery-eligible
        // skip reason + the skip_recovery enqueue closure here (where
        // `observedSkipReason` / `backfillStatus` are in scope), but EXECUTE the
        // enqueue AFTER `markAnalysisCompleted` so the analysis guard sees a
        // terminal status (`failed`) and returns `proceed` — NOT `re_enqueue`
        // (plan §3.2, ADR-0008 Amendment 1 skip_recovery guard semantics:
        // terminal=failed → proceed). The skipReason→status update above is the
        // terminal-status write `markAnalysisCompleted` depends on, so it STAYS
        // here; only the enqueue is deferred. The closure body is the former
        // inline block verbatim (no new logic).
        //
        // PR-C2 (Layer 2, ADR-0007 Amendment 3): skip_recovery enqueue を closure 化し
        // markComplete 後に実行 (guard terminal=failed → proceed)。status 更新は markComplete
        // が依存するためここに残す。
        recoverySkipReason = observedSkipReason;
        const recoveryBackfillStatus = backfillStatus;
        const recoverySkipReasonForClosure = observedSkipReason;
        runSkipRecoveryEnqueue = async (): Promise<{
          enqueuedCategories: EmbeddingBackfillCategory[];
          skipRecoveryPending: unknown | undefined;
        }> => {
          // Persisted screenshot path を DB から取得（part_visual / section_visual で必須）
          // Fetch persisted screenshot path from DB (required for part_visual / section_visual)
          let persistedScreenshotPath: string | undefined;
          try {
            const webPageRow = await prisma.webPage.findUnique({
              where: { id: state.actualWebPageId },
              select: { screenshotStoragePath: true },
            });
            if (webPageRow?.screenshotStoragePath) {
              persistedScreenshotPath = webPageRow.screenshotStoragePath;
            }
          } catch (fetchError) {
            logger.warn(
              "[PageAnalyzeWorker] Failed to fetch screenshotStoragePath for skip recovery",
              {
                error: sanitizeErrorMessage(fetchError),
                webPageId: truncateAuditTargetId(state.actualWebPageId),
              }
            );
          }

          const recoveryResult = await dispatchSkipRecoveryBackfill({
            webPageId: state.actualWebPageId,
            url,
            skipReason: recoverySkipReasonForClosure,
            backfillStatus: recoveryBackfillStatus,
            screenshotStoragePath: persistedScreenshotPath,
          });

          await job.log(
            `[Phase 5 Skip Recovery] enqueued=${recoveryResult.enqueuedCategories.length}, ` +
              `categories=${recoveryResult.enqueuedCategories.join(",") || "none"}, ` +
              `reason=${recoveryResult.reason ?? "ok"}`
          );

          // PR7b (ADR-0008 #7): MCP response に `skip_recovery` variant を埋める。
          // enqueue が 1 件以上成功した場合のみ payload を付与する（0 件時は
          // backfillPending を返さず、cron が後続 recovery を担う）。
          //
          // PR7b (ADR-0008 #7): Attach the `skip_recovery` variant to the MCP
          // response only when at least one category was successfully enqueued.
          // When 0 were enqueued, no backfillPending is surfaced (cron takes over).
          let surfacedSkipRecoveryPending: unknown | undefined;
          if (
            recoveryResult.enqueuedCategories.length > 0 &&
            recoveryResult.retryCountAfter !== undefined &&
            recoveryResult.enqueuedAt !== undefined
          ) {
            const skipRecoveryPending = buildSkipRecoveryBackfillPending({
              skipReason: recoverySkipReasonForClosure,
              enqueuedCategories: recoveryResult.enqueuedCategories,
              retryCount: recoveryResult.retryCountAfter,
              enqueuedAt: recoveryResult.enqueuedAt,
            });

            const recoveryResults = state.results!;
            if (!recoveryResults.embedding) {
              recoveryResults.embedding = {};
            }

            // ADR-0008 Semantics Table: `sync_overflow` と `skip_recovery` は
            // 両立不能。万一既に sync_overflow payload が付与されていた場合は
            // invariant violation として debug.log に記録し、skip_recovery で
            // 上書きする（Phase 5 全体 skip が発生している = overflow は観測不能）。
            //
            // ADR-0008 Semantics Table: `sync_overflow` and `skip_recovery` are
            // mutually exclusive. If a sync_overflow payload was somehow already
            // attached, log the invariant violation via debug.log and overwrite
            // with skip_recovery (full Phase 5 skip means overflow is impossible).
            if (
              isBackfillPendingSourceConflict(
                recoveryResults.embedding.backfillPending,
                skipRecoveryPending
              )
            ) {
              logger.warn(
                "[PageAnalyzeWorker] ADR-0008 invariant violation: " +
                  "sync_overflow + skip_recovery both present; overwriting with skip_recovery",
                {
                  webPageId: truncateAuditTargetId(state.actualWebPageId),
                  existingSource: recoveryResults.embedding.backfillPending?.source,
                  skipReason: recoverySkipReasonForClosure,
                }
              );
            }

            recoveryResults.embedding.backfillPending = skipRecoveryPending;
            surfacedSkipRecoveryPending = skipRecoveryPending;
          }
          return {
            enqueuedCategories: recoveryResult.enqueuedCategories,
            skipRecoveryPending: surfacedSkipRecoveryPending,
          };
        };
      }
    }

    // GPU Resource Manager: Release GPU resources for next job's Vision phase
    try {
      await gpuResourceManager.release();
    } catch (gpuError) {
      logger.warn("[PageAnalyzeWorker] GPU release failed (non-fatal)", {
        error: gpuError instanceof Error ? gpuError.message : String(gpuError),
      });
    }

    // =====================================================
    // Memory Cleanup: Release all remaining intermediate data
    // All analysis and embedding phases are complete; release large
    // objects before building the final result.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      state.layoutResultForNarrative = null;
      state.motionResultForEmbedding = null;
      state.scrollVisionResultForEmbedding = null;
      state.jsAnimationsForEmbedding = null;
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug("[PageAnalyzeWorker] [MemCleanup] Post-Embedding final cleanup", {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
          releasedRefs: [
            "layoutResultForNarrative",
            "motionResultForEmbedding",
            "scrollVisionResultForEmbedding",
            "jsAnimationsForEmbedding",
          ],
        });
      }
    }

    // =====================================================
    // Finalize
    // =====================================================
    statusTracker.startPhase("finalizing");

    const processingTimeMs = Date.now() - startTime;
    const success = state.failedPhases.length === 0;
    const partialSuccess = !success && state.completedPhases.length > 0;

    // =====================================================
    // Update analysisStatus in DB (success/partial success path)
    // Phase 0 で "pending" に設定された analysisStatus を完了状態に更新する。
    // Product API の section-types/patterns クエリは analysis_status = 'completed' で
    // フィルタするため、この更新がないと分析済みページが表示されない。
    //
    // v0.4.0 PR7e-α (バグ④): PhasedDbHandler.markAnalysisCompleted() に委譲し、
    // `analysis_phase_status` / `last_analyzed_phase` / `analysis_completed_at`
    // も同時に更新する。success=true のとき phase_status='completed'、
    // 部分成功では最終到達フェーズを維持する (PhasedDbHandler 内部で判断)。
    //
    // v0.4.0 PR7e-α (bug ④): delegate to PhasedDbHandler.markAnalysisCompleted()
    // so `analysis_phase_status` / `last_analyzed_phase` / `analysis_completed_at`
    // also advance. On full success phase_status='completed'; on partial
    // success the last reached phase is preserved (PhasedDbHandler internal).
    // =====================================================
    if (phasedDb) {
      try {
        await phasedDb.markAnalysisCompleted(success);
      } catch (phasedDbError) {
        logger.warn(
          "[PageAnalyzeWorker] PhasedDbHandler.markAnalysisCompleted failed (non-fatal)",
          {
            error: sanitizeErrorMessage(phasedDbError),
            webPageId: truncateAuditTargetId(state.actualWebPageId),
          }
        );
      }
    } else {
      // PhasedDbHandler が初期化できなかった場合の fallback。従来と同じ inline 更新。
      // Fallback when PhasedDbHandler could not be initialised — legacy inline update.
      try {
        await prisma.webPage.update({
          where: { id: state.actualWebPageId },
          data: {
            analysisStatus: "completed",
            analysisCompletedAt: new Date(),
          },
        });
      } catch (statusError) {
        logger.warn("[PageAnalyzeWorker] Failed to update analysisStatus to completed", {
          error: sanitizeErrorMessage(statusError),
          webPageId: truncateAuditTargetId(state.actualWebPageId),
        });
      }
    }

    statusTracker.completePhase("finalizing");

    // =====================================================
    // PR-C2 (Layer 2, ADR-0007 Amendment 3): Relocated backfill enqueue.
    // Both enqueue paths (sync_overflow + skip_recovery) run HERE — AFTER
    // `markAnalysisCompleted` (above) and BEFORE Phase 7.5 (below) — so the
    // backfill worker's analysis guard sees a terminal `analysis_status`
    // (`completed` / `failed`) and returns `proceed`, removing the `re_enqueue`
    // churn from the happy path (plan §3.2 / §4.2). The ordering decision is in
    // the CC≤10 leaf `enqueueBackfillAfterMarkComplete`; the actual DB/queue I/O
    // lives in the injected closures captured above. Both closures mutate
    // `state.results` so this MUST run before `result.results = state.results`.
    //
    // PR-C2 (Layer 2, ADR-0007 Amendment 3): 両 backfill enqueue を markComplete 後 /
    // Phase 7.5 前に実行 (guard が terminal status を見て proceed、re_enqueue churn 排除)。
    // Fallback closure is never invoked when `recoverySkipReason` is undefined
    // (the leaf guards on it); it only satisfies the non-optional dep type.
    const noopSkipRecoveryEnqueue = async (): Promise<{
      enqueuedCategories: EmbeddingBackfillCategory[];
      skipRecoveryPending: unknown | undefined;
    }> => ({ enqueuedCategories: [], skipRecoveryPending: undefined });
    await enqueueBackfillAfterMarkComplete({
      hasWebPageId: Boolean(state.actualWebPageId),
      runSyncOverflowEnqueue,
      recoverySkipReason,
      runSkipRecoveryEnqueue: runSkipRecoveryEnqueue ?? noopSkipRecoveryEnqueue,
    });

    const result: PageAnalyzeJobResult = {
      webPageId: state.actualWebPageId, // v0.1.0: 実際のDB IDを返す
      success,
      partialSuccess,
      completedPhases: state.completedPhases,
      failedPhases: state.failedPhases,
      processingTimeMs,
      completedAt: new Date().toISOString(),
    };

    // Add results only if there are any (avoid undefined assignment with exactOptionalPropertyTypes)
    if (state.results && Object.keys(state.results).length > 0) {
      result.results = state.results;
    }

    // =====================================================
    // Phase 7.5: Post-Analysis Gate (v0.3.0 Tier 2)
    // =====================================================
    // Phase 7.5a: Accessibility Audit (opt-in)
    // state.html is sanitized in Phase 0 (sanitizeHtml in phase-0-ingest.ts L176)
    // but released after Phase 4. Fetch from DB if needed.
    if (success && options?.accessibilityOptions?.enabled === true) {
      let a11yHtml = state.html;
      if (!a11yHtml && state.actualWebPageId) {
        try {
          const webPage = await prisma.webPage.findUnique({
            where: { id: state.actualWebPageId },
            select: { htmlContent: true },
          });
          a11yHtml = webPage?.htmlContent ?? null;
        } catch {
          // DB fetch failure is non-fatal
        }
      }
      try {
        const a11yOpts = {
          enabled: true as const,
          level: (options.accessibilityOptions?.level ?? "AA") as "A" | "AA" | "AAA",
          include_contrast: options.accessibilityOptions?.include_contrast ?? true,
          save_to_db: options.accessibilityOptions?.save_to_db ?? true,
        };
        const a11yResult = a11yHtml
          ? await handleAccessibilityPhase({
              accessibilityOptions: a11yOpts,
              sanitizedHtml: a11yHtml,
              warnings: [],
            })
          : undefined;
        if (a11yResult && state.results) {
          (state.results as Record<string, unknown>).accessibility = a11yResult;
          state.completedPhases.push("accessibility" as AnalysisPhase);
        }
      } catch (a11yError) {
        logger.warn("[PageAnalyzeWorker] Phase 7.5a accessibility failed (non-fatal)", {
          error: a11yError instanceof Error ? a11yError.message : String(a11yError),
        });
      }
    }

    // Phase 7.5b: Performance Evaluation (opt-in)
    if (success && options?.performanceOptions?.enabled === true) {
      try {
        const perfOpts = {
          enabled: true as const,
          include_screenshots: options.performanceOptions?.include_screenshots ?? false,
          save_to_db: options.performanceOptions?.save_to_db ?? true,
          ...(options.performanceOptions?.budget
            ? { budget: options.performanceOptions.budget }
            : {}),
        };
        const perfResult = await handlePerformancePhase({
          performanceOptions: perfOpts,
          url,
          warnings: [],
        });
        if (perfResult && state.results) {
          (state.results as Record<string, unknown>).performance = perfResult;
          state.completedPhases.push("performance" as AnalysisPhase);
        }
      } catch (perfError) {
        logger.warn("[PageAnalyzeWorker] Phase 7.5b performance failed (non-fatal)", {
          error: perfError instanceof Error ? perfError.message : String(perfError),
        });
      }
    }

    // Phase 7.5c: Auto-Snapshot (opt-in)
    // page.analyze 完了後にデザインスナップショットを自動生成
    // Auto-create design snapshot after successful page.analyze
    if (success && options?.autoSnapshot === true) {
      try {
        const snapshotResult = await createDesignSnapshot(state.actualWebPageId);
        if (snapshotResult.success) {
          logger.info("[PageAnalyzeWorker] Auto-snapshot created", {
            snapshotId:
              snapshotResult.snapshot_id?.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) +
              "...",
            webPageId: truncateAuditTargetId(state.actualWebPageId),
            sectionCount: snapshotResult.section_count,
          });
        } else {
          logger.warn("[PageAnalyzeWorker] Auto-snapshot failed (non-fatal)", {
            error: snapshotResult.error,
          });
        }
      } catch (snapshotError) {
        // Auto-snapshot failure is non-fatal — do not affect job result
        logger.warn("[PageAnalyzeWorker] Auto-snapshot error (non-fatal)", {
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
      }
    }

    if (isDevelopment()) {
      logger.info("[PageAnalyzeWorker] Job completed", {
        jobId: job.id,
        requestedWebPageId: webPageId,
        actualWebPageId: state.actualWebPageId,
        success,
        partialSuccess,
        completedPhases: state.completedPhases,
        failedPhases: state.failedPhases,
        processingTimeMs,
      });
    }

    // =====================================================
    // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — INV-WORKER-PID-IDENTITY-005
    //   Sub-B clear hook (success path): record paired `release` event row.
    // =====================================================
    // Pairs with `recordWorkerSpawn` so the supervisor backfill can detect
    // "orphan vs gracefully released" via paired-row presence. Fire-and-forget;
    // failure to write is logged and ignored — supervisor backfill degrades
    // to `phase_reconstruction='best_effort'` if the release row is missing.
    //
    // UNBLOCK-T4-02 Sub-B clear hook (success path, fire-and-forget).
    if (state.workerSpawnTimeMs !== undefined) {
      try {
        await recordWorkerRelease(prisma as unknown as WorkerJobLifecyclePrismaClient, {
          webPageId: state.actualWebPageId,
          workerPid: process.pid,
          workerSpawnTime: new Date(state.workerSpawnTimeMs),
          workerType: "page",
          nonce: process.env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE ?? randomUUID(),
        });
      } catch (recordReleaseError) {
        logger.warn(
          "[PageAnalyzeWorker] recordWorkerRelease (success path) outer catch (non-fatal)",
          {
            error: sanitizeErrorMessage(recordReleaseError),
            webPageId: truncateAuditTargetId(state.actualWebPageId),
          }
        );
      }
    }

    // =====================================================
    // Post-job Memory Gate (success path, Plan v1.1 candidate B)
    // ADR-0034 Amendment 5 (Stage 2 `worker.pause(true)` formal removal)
    // =====================================================
    // Plan v1.1 candidate B / ADR-0034 Amendment 5: Stage 2 `worker.pause(true)`
    // formal removal。success path は `applyPostJobMemoryGate` (memory-only
    // gate) のみを呼ぶ。failure path も同 helper のみを呼ぶため、両 path で
    // `worker.pause` callsite は production code 全域で 0 件
    // (INV-WORKER-NO-PAUSE-001、AST gate `verify-no-worker-pause.mjs` で
    // enforce、exempt scope = BullMQ `pause:` event handler L3338 + test files)。
    //
    // 計画的再起動 (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) は constructor 段階で
    // pre-register された `worker.once('completed', listener)` (callback-based
    // exit、ADR-0034 §Decision 1) のみで担保される: processor return →
    // moveToCompleted Lua → emit('completed') → listener fire → process.exit(0)。
    //
    // H2 (moveToCompleted paused 評価 race) + H3 (event-loop starvation 下の
    // emit 遅延、BullMQ #359 indirect evidence) は本 candidate B で構造的消滅。
    // H1 (dispose ceiling 5s microtask race、ADR-0035 §Decision 1) は本 PR
    // scope 外、`registerCompletedListenerAndExit` 内で active 維持 (直交)。
    //
    // Plan v1.1 candidate B / ADR-0034 Amendment 5: success path calls only
    // `applyPostJobMemoryGate`; the failure path uses the same helper, so
    // `worker.pause` callsites in production code are 0
    // (INV-WORKER-NO-PAUSE-001 enforced by AST gate
    // `verify-no-worker-pause.mjs`; exempt scope = BullMQ `pause:` event
    // handler L3338 + test files). Planned restart
    // (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) is driven exclusively by the
    // constructor-pre-registered `worker.once('completed', listener)`. H2 +
    // H3 races are structurally eliminated; H1 (dispose ceiling 5s,
    // ADR-0035 §Decision 1) remains active inside
    // `registerCompletedListenerAndExit` (orthogonal).
    await applyPostJobMemoryGate(_preReturnPauseEnabled, "[PageAnalyzeWorker]");
    // Plan v4.2 callback-based exit: BullMQ native flow に制御を返し
    // worker.once('completed') listener が process.exit(0) を発火する
    // (ADR-0034 §Decision 1 Stage 5-8、Amendment 5 で Stage 2 pause 廃止後の
    // 7-stage に縮退)。Lua transaction commit を listener fire の precondition
    // にすることで job orphan race を構造的に排除する。
    // Plan v4.2 callback-based exit: yield control back to BullMQ native flow;
    // the worker.once('completed') listener fires process.exit(0).
    return result;
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const rawErrorMessage = error instanceof Error ? error.message : String(error);

    logger.error("[PageAnalyzeWorker] Job failed with exception", {
      jobId: job.id,
      webPageId,
      error: rawErrorMessage,
      processingTimeMs,
    });

    // =====================================================
    // Update analysisStatus to "failed" in DB
    // Phase 0 で "pending" に設定された analysisStatus を失敗状態に更新する。
    // actualWebPageId が設定されている場合のみ更新（Phase 0 前の失敗では未設定の可能性）。
    //
    // Plan v3 Track T4 (PR-V3-T4) Contract 1 — DB-write-before-exit ordering
    // invariant: `markFailedAndAuditAtomic` runs `web_pages` UPDATE +
    // `audit_logs` INSERT in a single Prisma transaction so the failure row
    // and the audit_log entry commit atomically before any process.exit can
    // fire. The phaseN is derived from `state.completedPhases` (highest +
    // 1 → in-flight phase identifier).
    //
    // Plan v3 T4 Contract 1: atomic markFailedAndAuditAtomic via Prisma
    // $transaction (DB-write-before-exit ordering invariant).
    //
    // UNBLOCK-T4-09 closure (analysis-status-update.test.ts +3): the local
    // const is named `errorMessage` (not `sanitizedErrorMessage`) so the
    // PR7e-α PhasedDbHandler test contracts continue to pass. The unsanitized
    // raw form used for the outer logger call is renamed to `rawErrorMessage`.
    // =====================================================
    if (state.actualWebPageId) {
      const errorMessage = sanitizeErrorMessage(error).slice(0, 500);
      // Derive phaseN from state.completedPhases (highest completed → in-flight
      // is next phase). Map AnalysisPhase → PhaseN identifier.
      const phaseN: PhaseN = derivePhaseNFromCompletedPhases(state.completedPhases);

      const t4Result = await markFailedAndAuditAtomic(
        prisma as unknown as FailurePathPrismaClient,
        {
          webPageId: state.actualWebPageId,
          // PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2: pass the
          // url-key so the upsert can create the terminal `failed` row when
          // W0 did not (NOROW closure) and converge concurrent retries.
          normalizedUrl: state.normalizedUrl,
          errorMessage,
          phaseN,
          childPid: process.pid,
        }
      );

      if (!t4Result.committed) {
        logger.warn(
          "[PageAnalyzeWorker] markFailedAndAuditAtomic did not commit; falling back to legacy update",
          {
            reason: t4Result.reason,
            webPageId: truncateAuditTargetId(state.actualWebPageId),
          }
        );
        // Legacy fallback: phasedDb.markAnalysisFailed() (preserves
        // pre-existing PR7e-α behaviour for the transaction_aborted path).
        if (phasedDb) {
          try {
            await phasedDb.markAnalysisFailed(errorMessage);
          } catch (statusError) {
            logger.warn(
              "[PageAnalyzeWorker] PhasedDbHandler.markAnalysisFailed failed (non-fatal)",
              {
                error: sanitizeErrorMessage(statusError),
                webPageId: truncateAuditTargetId(state.actualWebPageId),
              }
            );
          }
        } else {
          try {
            await prisma.webPage.update({
              where: { id: state.actualWebPageId },
              data: {
                analysisStatus: "failed",
                analysisError: errorMessage,
                analysisCompletedAt: new Date(),
              },
            });
          } catch (statusError) {
            logger.warn("[PageAnalyzeWorker] Failed to update analysisStatus to failed", {
              error: sanitizeErrorMessage(statusError),
              webPageId: truncateAuditTargetId(state.actualWebPageId),
            });
          }
        }
      }

      // =====================================================
      // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-02 — INV-WORKER-PID-IDENTITY-005
      //   Sub-B clear hook (failure path): record paired `release` event row.
      // =====================================================
      // Even on failure, record the release event so the supervisor backfill
      // can distinguish "child reached catch tail and committed" from "true
      // orphan (SIGKILL/OOM/segfault)". Fire-and-forget; failure to write is
      // logged and ignored.
      //
      // UNBLOCK-T4-02 Sub-B clear hook (failure path, fire-and-forget).
      if (state.workerSpawnTimeMs !== undefined) {
        try {
          await recordWorkerRelease(prisma as unknown as WorkerJobLifecyclePrismaClient, {
            webPageId: state.actualWebPageId,
            workerPid: process.pid,
            workerSpawnTime: new Date(state.workerSpawnTimeMs),
            workerType: "page",
            nonce: process.env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE ?? randomUUID(),
          });
        } catch (recordReleaseError) {
          logger.warn(
            "[PageAnalyzeWorker] recordWorkerRelease (failure path) outer catch (non-fatal)",
            {
              error: sanitizeErrorMessage(recordReleaseError),
              webPageId: truncateAuditTargetId(state.actualWebPageId),
            }
          );
        }
      }
    }

    // Note: failure path では pause(true) を呼ばない。
    // success path の pause は 'completed' → IPC 'job-completed' → 計画的再起動の
    // フローで安全だが、failure path では 'failed' イベントが IPC を送信しないため、
    // pause すると Worker が永久停止する。autorun: false で起動時レースは防止済み。
    // Re-throw to let BullMQ record the failure
    // Note: BullMQ will capture the error message from the thrown error
    throw error;
  } finally {
    // Always stop the lock extender to prevent leaked intervals
    lockExtender.stop();
    // SEC-L1: Defensive cleanup - release capture buffers on any exit path
    state.scrollVisionCapturesForDeferred = null;

    // v0.4.0 PR7d-1 (ADR-0010): Phase 5 Screenshot は永続化パスに保存され、
    //   削除経路は GDPR `data.delete` + PR6 TTL cron の 2 経路に集約。
    //   finally では in-memory 参照の null 化のみ行う（delete は throw しないので
    //   try/catch 不要）。
    //
    // v0.4.0 PR7d-1 (ADR-0010): Screenshots are persisted; deletion is
    //   consolidated into GDPR `data.delete` + PR6 TTL cron. In finally we
    //   only null-out the in-memory reference (`delete` cannot throw, so no
    //   try/catch needed).
    if (state.screenshotPngPath) {
      delete state.screenshotPngPath;
    }
  }
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create a PageAnalyzeWorker instance
 *
 * @param options - Worker configuration options
 * @returns Worker instance with lifecycle methods
 */
export function createPageAnalyzeWorker(
  options: PageAnalyzeWorkerOptions = {}
): PageAnalyzeWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info("[PageAnalyzeWorker] Creating worker", {
      queueName: PAGE_ANALYZE_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<PageAnalyzeJobData, PageAnalyzeJobResult>(
    PAGE_ANALYZE_QUEUE_NAME,
    processPageAnalyzeJob,
    {
      // BullMQ 公式必須: Worker 接続では `maxRetriesPerRequest: null` を強制する
      // (BZPOPMIN blocking command が N 回失敗で中断されるのを防ぐ)。
      // https://docs.bullmq.io/guide/connections / taskforcesh/bullmq#2466
      // BullMQ requires `maxRetriesPerRequest: null` for Worker connections
      // so that BZPOPMIN does not abort after N retries.
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: null,
      },
      // Explicit start from start-workers.ts after local initialization is complete.
      autorun: false,
      concurrency,
      lockDuration,
      // Stalled job settings (detect stuck jobs)
      // stalledInterval = lockDuration/4 to avoid false stall detection during legitimate long processing
      stalledInterval: Math.max(60000, Math.floor(lockDuration / 4)),
      maxStalledCount: 3, // Allow 3 stalls before failing (CPU-bound embedding phase may block event loop)
    }
  );

  // Plan v1.1 candidate B / ADR-0034 Amendment 5: the success path no longer
  // needs a module-level worker ref because `applyPostJobLifecycleGate` is a
  // no-op stub and the canonical post-job gate (`applyPostJobMemoryGate`) is
  // worker-instance-free. The module-level `_workerInstanceRef` has been
  // removed.

  // Event handlers for monitoring
  worker.on("completed", (job, result) => {
    if (verbose) {
      logger.info("[PageAnalyzeWorker] Job completed event", {
        jobId: job.id,
        webPageId: result.webPageId,
        success: result.success,
        partialSuccess: result.partialSuccess,
      });
    }

    // P1-D: Notify parent process (WorkerSupervisor) of job completion via IPC
    // This enables maxJobsBeforeRestart planned restarts for OOM prevention.
    //
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload now conforms to the
    // `WorkerIpcMessageSchema` SSOT (`apps/mcp-server/src/schemas/worker-ipc.schema.ts`).
    // The supervisor's `verifyWorkerIpcMessage` rejects any payload missing
    // `workerType` or `timestamp`, so the legacy `{type, jobId}` shape would
    // be discarded and the supervisor would never trigger a planned restart.
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload は SSOT スキーマに準拠する。
    // 旧形式 `{type, jobId}` は workerType / timestamp 欠落で fail-closed
    // 破棄されるため、必ず正規形式で emit する。
    try {
      process.send?.({
        type: "job-completed",
        workerType: "page",
        jobId: job.id,
        timestamp: Date.now(),
      });
    } catch {
      // IPC channel may be closed if parent is shutting down; non-fatal
    }
  });

  // Plan v4.2 PR-A: callback-based exit responsibility 集約 (TPA-V42-M-03 Option A
  // single-shot)。Worker constructor 内、既存 worker.on('completed', ...) IPC send
  // handler の **後** に register することで、Node.js EventEmitter の register 順
  // listener invoke 規約により IPC send → process.exit(0) の順序が deterministic
  // となる (parent への job-completed 通知が exit より先に flush される)。
  //
  // Plan v4.2 PR-L closure (TDA-V42-L-02): boilerplate を
  // `registerCompletedListenerAndExit` helper に集約。Helper 内 listener body は
  // SEC M-NEW-1 mandate (synchronous-only) を継承し、AST gate
  // `scripts/verify-completed-listener-sync.mjs` が helper file を含む
  // TARGETS list で synchronous-only を CI で enforce する。
  //
  // Cross-ref: ADR-0034 §Decision 1 Step C, Plan v4.2 §3.2 Step 4 + PR-L
  // closure (TDA-V42-L-02 helper extraction, SEC-V42-L-NEW-4 mandate).
  //
  // Plan v4.2 PR-A + PR-L (TDA-V42-L-02): callback-based exit listener is
  // registered via the shared helper `registerCompletedListenerAndExit`,
  // which retains SEC M-NEW-1 synchronous-only listener body contract. The
  // AST gate `scripts/verify-completed-listener-sync.mjs` extends TARGETS to
  // include the helper file (post-job-lifecycle.ts) so synchronous-only is
  // enforced in CI for helper-routed listeners as well.
  registerCompletedListenerAndExit(worker, "page-analyze");

  worker.on("failed", (job, error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[PageAnalyzeWorker] Job failed event", {
      jobId: job?.id,
      error: sanitizeErrorMessage(error),
    });
  });

  worker.on("error", (error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[PageAnalyzeWorker] Worker error", {
      error: sanitizeErrorMessage(error),
    });
  });

  // Stall recovery: Create a Queue instance for job access during stall handling
  const recoveryQueue = createPageAnalyzeQueue(redisConfig);

  // Build StalledJobAccessor for handleStalledJob DI
  const stalledJobAccessor: StalledJobAccessor = {
    getJob: async (stalledJobId: string) => {
      const job = await recoveryQueue.getJob(stalledJobId);
      if (!job || !job.id) return null;
      return {
        id: job.id,
        progress: typeof job.progress === "number" ? job.progress : 0,
        processedOn: job.processedOn,
        data: {
          webPageId: job.data?.webPageId ?? "",
          url: job.data?.url ?? "",
        },
        moveToFailed: async (err: Error, token: string, fetchNext?: boolean): Promise<void> => {
          await job.moveToFailed(err, token, fetchNext);
        },
        moveToCompleted: async (
          returnValue: unknown,
          token: string,
          fetchNext?: boolean
        ): Promise<void> => {
          await job.moveToCompleted(returnValue as PageAnalyzeJobResult, token, fetchNext);
        },
        getState: async (): Promise<string> => job.getState(),
      };
    },
  };

  // Enhanced stalled event handler: trigger custom recovery
  worker.on("stalled", (jobId) => {
    logger.warn("[PageAnalyzeWorker] Job stalled — triggering recovery", { jobId });
    // Fire-and-forget: recovery runs asynchronously, errors are logged inside handleStalledJob
    handleStalledJob(jobId, stalledJobAccessor)
      .then((result) => {
        if (result.success) {
          logger.info("[PageAnalyzeWorker] Stalled job recovery result", {
            jobId: result.jobId,
            action: result.action,
            category: result.category,
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("[PageAnalyzeWorker] Stalled job recovery error", { jobId, error: msg });
      });
  });

  // Build DI functions for periodic stall check (reuse from recoverOrphanedJobs pattern)
  const getActiveJobsFn = async (): Promise<OrphanedJobInfo[]> => {
    const activeJobs = await recoveryQueue.getJobs(["active"], 0, 100);
    return activeJobs
      .filter((job) => job.id !== undefined)
      .map((job) => ({
        jobId: job.id ?? "",
        state: "active",
        progress: typeof job.progress === "number" ? job.progress : 0,
        processedOn: job.processedOn,
        lockDurationMs: lockDuration,
        data: {
          webPageId: job.data?.webPageId ?? "",
          url: job.data?.url ?? "",
        },
      }));
  };

  const moveToFailedFn = async (failJobId: string, reason: string): Promise<void> => {
    const job = await recoveryQueue.getJob(failJobId);
    if (job) {
      await job.moveToFailed(new Error(reason), "0", false);
    }
  };

  const moveToCompletedFn = async (completeJobId: string): Promise<void> => {
    const job = await recoveryQueue.getJob(completeJobId);
    if (job) {
      await job.moveToCompleted(
        {
          webPageId: job.data?.webPageId ?? "",
          success: true,
          partialSuccess: true,
          completedPhases: [],
          failedPhases: [],
          processingTimeMs: 0,
          completedAt: new Date().toISOString(),
        },
        "0",
        false
      );
    }
  };

  // Startup recovery: recover orphaned jobs from previous crash/restart
  recoverOrphanedJobs(getActiveJobsFn, moveToFailedFn, moveToCompletedFn, lockDuration)
    .then((result) => {
      if (result.recoveredCount > 0) {
        logger.info("[PageAnalyzeWorker] Startup recovery completed", {
          recoveredCount: result.recoveredCount,
          failedCount: result.failedCount,
        });
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[PageAnalyzeWorker] Startup recovery failed (non-fatal)", { error: msg });
    });

  // Periodic stall check: independent of BullMQ's internal stalledInterval
  const periodicCheck = createPeriodicStallCheck(
    getActiveJobsFn,
    moveToFailedFn,
    moveToCompletedFn,
    { lockDurationMs: lockDuration }
  );

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info("[PageAnalyzeWorker] Closing worker");
      }
      isRunning = false;
      periodicCheck.stop();
      // Release GPU resources before closing worker
      try {
        await gpuResourceManager.release();
      } catch {
        // Release failure during shutdown is non-fatal
      }
      await recoveryQueue.close();
      // v0.4.0 PR4: lazy-init した backfill queue も close する
      // v0.4.0 PR4: close the lazy-initialized backfill queue as well
      if (_backfillQueue !== null) {
        try {
          await _backfillQueue.close();
        } catch {
          /* non-fatal during shutdown */
        }
        _backfillQueue = null;
      }
      await worker.close();
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info("[PageAnalyzeWorker] Pausing worker (no new jobs will be accepted)");
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports
// ============================================================================

// PR2 (v0.4.0): EMBEDDING_SKIP_REASONS を phases/types.ts から再エクスポート
// PR2 (v0.4.0): Re-export EMBEDDING_SKIP_REASONS from phases/types.ts
//   → 主たる export ブロックの前に置く（embedding-chunking テストの
//     lastIndexOf("export {") がこのブロックを見つけられるように）
//   → Placed before the primary export block so that the
//     lastIndexOf("export {") probe in embedding-chunking tests still
//     locates the primary block.
export { EMBEDDING_SKIP_REASONS } from "./phases/types";

export {
  processPageAnalyzeJob,
  checkMemoryPressure,
  tryGarbageCollect,
  createPhaseProgressInterpolator,
  generateJsAnimationTextRepresentation,
  createLockExtender,
  extendJobLock,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_EXTEND_INTERVAL,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  EMBEDDING_CHUNK_SIZE,
  // v0.4.0 PR7b: テスト用 export — disposePhase4Memory / SKIP_RECOVERY_RETRY_CAP
  // v0.4.0 PR7b: Test-only exports — disposePhase4Memory / SKIP_RECOVERY_RETRY_CAP
  disposePhase4Memory,
  SKIP_RECOVERY_RETRY_CAP,
};
// PR-BACKFILL-TERMINAL (系統A): `resolveBackfillDispatchCategories` is exported
// inline at its declaration (drift-proof dispatch category resolver, pinned by
// INV-BACKFILL-TERMINAL-COMPLETED-007 Block A 3-way Set-equality).

// Re-export types from phases/types.ts for backward compatibility
export type {
  LockExtender,
  PageAnalyzeWorkerOptions,
  PageAnalyzeWorkerInstance,
  EmbeddingPhaseParams,
  EmbeddingPhaseResult,
  EmbeddingSkipReason,
  PipelineState,
  PhaseContext,
} from "./phases/types";
