// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingBackfillWorker — BullMQ Worker for Async Part Embedding Backfill
 *
 * v0.4.0 PR4: `embedding-backfill` Queue のジョブを消費し、Part text / visual
 * embedding をバックフィルする。page.analyze の Phase 5 で 100 件を超える
 * Part が存在する場合、最初の 100 件のみ同期処理し、残余を本 Worker が
 * 非同期に処理する（Queue-based Backfill）。
 *
 * v0.4.0 PR4: Consumes jobs from the `embedding-backfill` Queue and backfills
 * Part text / visual embeddings. When `page.analyze` Phase 5 has more than
 * 100 Parts, only the first 100 are processed synchronously and the
 * remainder is handled asynchronously by this Worker (Queue-based Backfill).
 *
 * Configuration:
 * - concurrency: 1 (OOM prevention; single ONNX / DINOv2 session per process)
 * - lockDuration: 600000ms (10 min, extended for DINOv2 inference)
 * - attempts: 3 (defined in queue — transient OOM recovery)
 * - autorun: false (explicit .run() call in start-workers.ts)
 *
 * Lifecycle:
 * 1. Receive job from Queue (jobId = `<webPageId>__<category>`)
 * 2. Validate webPageId exists and has pending embeddings
 * 3. For `part_text`: call `backfillPartTextForPage()` (DB self-discovery)
 * 4. For `part_visual`: use `runVisualEmbeddingSubPhases()` with persisted screenshot (PR1)
 * 5. After all pending categories complete → update `embeddingBackfillStatus = 'completed'`
 * 6. Still-pending categories → leave as `'in_progress'`
 *
 * @module workers/embedding-backfill-worker
 */

import { Worker, type Job } from "bullmq";
import { prisma } from "@reftrixmcp/database";
import { embeddingService as mlEmbeddingService } from "@reftrixmcp/ml";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  EMBEDDING_BACKFILL_QUEUE_NAME,
  EmbeddingBackfillJobDataSchema,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";
import { getAuditLogService } from "../services/audit-log.service";
import { pickKnownKeys, detectCategoryDrift } from "../utils/pick-known-keys";
import {
  getBackfillProcessor,
  type BackfillProcessContext,
} from "../queues/embedding-backfill-processors";
import { getRedisConfig, type RedisConfig } from "../config/redis";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { safeParseInt } from "../utils/safe-parse-int";
import {
  computeRemainingStatusWithPrisma,
  verifyCategoryParity,
  type CategoryPendingSnapshot,
} from "../services/backfill-status.helper";
import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
} from "../services/layout-embedding.service";
// v0.4.0 PR7e-β3: motion backfill 経路用 DI
// MotionProcessor (embedding-backfill-processors.ts:497) が backfillMotionsForPage
// → saveMotionEmbedding を呼ぶ際に Frame Prisma factory が必要。
// これが未設定だと "PrismaClient not initialized" で motion backfill 全件 failed となる。
//
// v0.4.0 PR7e-β3: DI for the motion backfill path.
// MotionProcessor calls backfillMotionsForPage → saveMotionEmbedding, which
// requires the Frame Prisma factory. Without it, motion backfill throws
// "PrismaClient not initialized" for every row.
import { setFramePrismaClientFactory } from "../services/motion/frame-embedding.service";
import { validateScreenshotPath } from "../services/screenshot-persistence.service";
import { applyPostJobMemoryGate } from "./shared/post-job-lifecycle";
import type { EmbeddingPhasePrismaClient } from "./phases/phase-5-embedding";

// ============================================================================
// Constants
// ============================================================================

/** Default concurrency — 1 to prevent OOM (same as page-analyze-worker) */
const DEFAULT_CONCURRENCY = 1;

/** Default lock duration (10 min — enough for DINOv2 inference) */
const DEFAULT_LOCK_DURATION = 600_000;

/** Default stalled interval = lockDuration / 4 */
const DEFAULT_STALLED_INTERVAL = Math.floor(DEFAULT_LOCK_DURATION / 4);

/** Max stalled count before failing (allow 3 stalls for CPU-bound DINOv2) */
const DEFAULT_MAX_STALLED_COUNT = 3;

/**
 * Progress sentinel values — BullMQ UI displays these as percentages.
 * Progress センチネル値 — BullMQ UI が% として表示する。
 */
const PROGRESS_START = 0;
const PROGRESS_AFTER_FETCH = 10;
const PROGRESS_AFTER_EMBEDDING = 90;
const PROGRESS_COMPLETE = 100;

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingBackfillWorkerOptions {
  /** Optional Redis config overrides */
  redisConfig?: Partial<RedisConfig> | undefined;
  /** Worker concurrency (default: 1) */
  concurrency?: number;
  /** BullMQ lock duration (default: 600000ms) */
  lockDuration?: number;
  /** Enable verbose logging (default: isDevelopment()) */
  verbose?: boolean;
}

export interface EmbeddingBackfillWorkerInstance {
  worker: Worker<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  close: () => Promise<void>;
  pause: () => Promise<void>;
  isRunning: () => boolean;
}

// ============================================================================
// DI Setup
// ============================================================================

/**
 * Shared singleton LayoutEmbeddingService used across jobs to avoid ONNX
 * session re-allocation cost. Same pattern as page-analyze-worker.
 *
 * 全ジョブで共有する LayoutEmbeddingService シングルトン。ONNX セッション
 * 再確保コストを避けるため page-analyze-worker と同じパターンを採用。
 */
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);
// v0.4.0 PR7e-β3: motion backfill DI (上記 import コメント参照)
// v0.4.0 PR7e-β3: Motion backfill DI (see import)
setFramePrismaClientFactory(() => prisma as never);

// ============================================================================
// Post-Job Memory Gate — OOM prevention via planned restart
// ============================================================================
//
// v0.4.0 PR7e-β2 hotfix で pause/resume 経路は完全削除済み (ADR-0009)。
// v0.4.0 PR7e-β2 audit carryover で helper を `applyPostJobMemoryGate` に
// リネームし、未使用になった `_workerInstanceRef` モジュール変数も削除した。
// 残すのは `WORKER_MAX_JOBS_BEFORE_RESTART > 0` 判定フラグのみ。
//
// v0.4.0 PR7e-β2 hotfix removed the pause/resume path entirely (see ADR-0009).
// v0.4.0 PR7e-β2 audit carryover renamed the helper to `applyPostJobMemoryGate`
// and dropped the now-unused `_workerInstanceRef` module-level variable. Only
// the `WORKER_MAX_JOBS_BEFORE_RESTART > 0` flag remains.

/**
 * Post-job memory gate enabled when WORKER_MAX_JOBS_BEFORE_RESTART > 0 (default: 1).
 * Same env var as page-analyze-worker to keep restart policy aligned.
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

// ============================================================================
// Processor
// ============================================================================

/**
 * Resolve the screenshot path for a given webPageId.
 *
 * Prefers the `screenshotStoragePath` provided in job data (hot cache from
 * `page.analyze`), then falls back to the DB column (`web_pages.screenshotStoragePath`).
 * Both candidates pass through `validateScreenshotPath()` which enforces:
 *   1. allowlist (path must be inside `${REFTRIX_SCREENSHOT_ROOT}/phase5/`)
 *   2. symlink resolution via `fs.promises.realpath` (no TOCTOU)
 *   3. real-file check (rejects directories / special files)
 * Returns null when validation fails or no persisted screenshot exists.
 *
 * webPageId に紐づく screenshot の絶対パスを解決する。ジョブデータ内のヒント
 * を優先し、無ければ DB (`web_pages.screenshotStoragePath`) を参照する。
 * どちらの候補も `validateScreenshotPath()` で allowlist + realpath 検証を
 * 通し、Phase 5 ディレクトリ配下の実ファイルであることを保証する。
 * 検証失敗または永続化済み screenshot が無い場合は null を返す。
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): BullMQ Redis 越しに受信する
 * `screenshotStoragePath` は外部入力同等。旧実装 (`fs.existsSync` +
 * `path.resolve`) では `/etc/passwd.png` 等の任意パス読み取りが可能だったため、
 * allowlist + realpath ベースの検証を再適用した。
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): `screenshotStoragePath` received via
 * BullMQ Redis is treated as external input. The previous implementation
 * (`fs.existsSync` + `path.resolve`) allowed arbitrary path reads such as
 * `/etc/passwd.png`; the allowlist + realpath check is now re-applied.
 */
async function resolveScreenshotPath(
  webPageId: string,
  hint: string | undefined
): Promise<string | null> {
  // 1. ジョブデータ由来のヒント（BullMQ Redis 経由 → 外部入力同等）
  //    Hint from job data (via BullMQ Redis → treated as external input)
  if (hint) {
    const validated = await validateScreenshotPath(hint);
    if (validated !== null) {
      return validated;
    }
    logger.warn("[EmbeddingBackfillWorker] Rejected unsafe screenshot path from job hint", {
      webPageId: webPageId.slice(0, 8) + "...",
    });
  }

  // 2. DB から取得（内部状態だが念のため allowlist 検証）
  //    Fetch from DB (internal state but re-validate via allowlist)
  try {
    const row = await prisma.webPage.findUnique({
      where: { id: webPageId },
      select: { screenshotStoragePath: true },
    });
    if (row?.screenshotStoragePath) {
      const validated = await validateScreenshotPath(row.screenshotStoragePath);
      if (validated !== null) {
        return validated;
      }
      logger.warn("[EmbeddingBackfillWorker] Rejected unsafe screenshot path from DB", {
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to fetch screenshot path from DB", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, 8) + "...",
    });
  }
  return null;
}

/**
 * Determine the remaining backfill status for a webPage after a Worker run.
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): `computeRemainingStatusWithPrisma`
 * helper に実装を委譲し、reconciliation service と SSOT を共有する。旧実装
 * (backfill-worker.ts 内に直接ロジックを記述) は drift 防止のため削除済み。
 * 公開 API 契約（戻り値型 / export 名）は維持する。
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): Delegates to
 * `computeRemainingStatusWithPrisma` helper so the worker and reconciliation
 * service share a single source of truth. The previous in-module
 * implementation was removed to prevent drift. Public API contract
 * (return type / export name) is preserved.
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA 申し送り): 全 7 カテゴリの残件を確認する。
 * いずれかのカテゴリで未完了行が残っていれば `in_progress` を維持。
 * PR5 Counter Reconciliation の 9 カテゴリ DB authoritative と同じカウント方法を採用。
 *
 * v0.4.0 PR7b (TPA Low-1 / TDA carryover): Checks remaining items across all 7
 * categories. Any remaining row keeps the status as `in_progress`. Mirrors the
 * 9-category DB-authoritative counts from the PR5 Counter Reconciliation.
 */
async function computeRemainingStatus(webPageId: string): Promise<{
  finalStatus: "completed" | "in_progress";
  pendingSnapshot: CategoryPendingSnapshot;
}> {
  return computeRemainingStatusWithPrisma(webPageId, prisma);
}

/**
 * Safely update `web_pages.embeddingBackfillStatus`.
 * DB 更新失敗は致命的でないので warn のみ出力して続行する。
 *
 * v0.4.0 PR-D-4: `skipped_fork_error` が明示引数として許可される
 * (INV-EMBEDDING-INTEGRITY-003 parity-check failure の retry bucket 遷移用)。
 * v0.4.0 PR-D-4: `skipped_fork_error` is an allowed argument (used for the
 * INV-EMBEDDING-INTEGRITY-003 parity-check-failure retry-bucket transition).
 */
async function updateEmbeddingBackfillStatus(
  webPageId: string,
  status: "in_progress" | "completed" | "failed" | "skipped_fork_error"
): Promise<void> {
  try {
    await prisma.webPage.update({
      where: { id: webPageId },
      data: { embeddingBackfillStatus: status },
    });
  } catch (error) {
    logger.warn("[EmbeddingBackfillWorker] Failed to update embeddingBackfillStatus", {
      error: sanitizeErrorMessage(error),
      webPageId: webPageId.slice(0, 8) + "...",
      status,
    });
  }
}

/**
 * Zod re-validation at the Worker receipt boundary (SEC M-1 defense-in-depth).
 * Throws a sanitized Error when validation fails so BullMQ marks the job failed
 * immediately (retries would reproduce the same error).
 *
 * Worker 受信境界での Zod 再検証（SEC M-1 defense-in-depth）。検証失敗時は
 * サニタイズしたエラーを throw して即時 failed 扱いにする。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2.
 */
function validateJobData(job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>): void {
  // SEC M-1 (v0.4.0 PR4 audit): Zod re-validation at worker receipt boundary.
  // BullMQ Redis 越しに受信するジョブデータを defense in depth として再検証し、
  // キュー投入後に改竄された payload / 旧バージョンの Worker で投入された不正
  // データを拒否する。失敗時はサニタイズしたエラーでジョブを failed 扱いにする
  // （BullMQ の attempts=3 リトライでも検証失敗は再現するため即時失敗とする）。
  //
  // SEC M-1 (v0.4.0 PR4 audit): Zod re-validation at the worker receipt
  // boundary for defense in depth. Rejects payloads tampered with after
  // enqueue or enqueued by older worker versions. Validation failures are
  // terminal (BullMQ retries would re-hit the same error).
  try {
    EmbeddingBackfillJobDataSchema.parse(job.data);
  } catch (validationError) {
    const msg = sanitizeErrorMessage(validationError);
    logger.error("[EmbeddingBackfillWorker] Rejecting job with invalid data (Zod)", {
      jobId: job.id,
      error: msg,
    });
    throw new Error(`[EmbeddingBackfillWorker] Invalid job data: ${msg}`);
  }
}

/**
 * Resolve the screenshot path for the processor only when required.
 * Processor が要求する場合のみ検証済み screenshot パスを解決する。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2.
 */
async function resolveScreenshotForProcessor(
  processor: ReturnType<typeof getBackfillProcessor>,
  webPageId: string,
  category: EmbeddingBackfillCategory,
  hint: string | undefined
): Promise<string | undefined> {
  if (!processor.requiresScreenshot()) {
    return undefined;
  }
  const resolved = await resolveScreenshotPath(webPageId, hint);
  if (!resolved && category === "part_visual") {
    logger.warn("[EmbeddingBackfillWorker] No persisted screenshot; skipping part_visual", {
      webPageId: webPageId.slice(0, 8) + "...",
    });
  }
  return resolved ?? undefined;
}

/**
 * v0.4.0 PR-D-5 (FIND-PLAN-IO-07 M → resolved):
 * Emit `parity_check_failed` via audit_logs DB write (primary evidence) +
 * logger.warn (observability / alert routing). Dual-emit design: if either
 * path fails, the other still executes.
 *
 * **Dual-emit rationale**: `audit_logs` は GDPR Art.30 Record of Processing
 * Activity として persist される primary evidence。`logger.warn` は real-time
 * observability / alert routing (SLO §3.4) のため維持される。片方が失敗しても
 * 他方は実行される (fail-independent, defense in depth)。
 *
 * **5-field contract (pinned via test + JSDoc, PR-D-4 Amendment 4 binding)**:
 * `auditLogService.log` payload には必ず以下を含む:
 *   - action: literal `"embedding_parity_check_failed"`
 *   - actor: literal `"system:embedding-backfill-worker"`
 *   - targetType: literal `"web_page"`
 *   - targetId: webPageId (audit-log.service 側で 8-char truncate される)
 *   - details: { category, unexpectedKeys, pendingSnapshot, skipReason, timestamp }
 *
 * **Set-equality enforcement (FIND-IMPL-IO-13)**: write 前に `category` map の
 * keys が `EMBEDDING_BACKFILL_CATEGORIES` と Set-equal であることを runtime
 * assert。drift 検出時は sentinel entry を追加で emit した上で primary emit
 * を継続 (best evidence preservation, Option C per IO Binding Q2).
 *
 * **FIND-TPA-PLAN-05 (M)**: primary emit payload は `pickKnownKeys` filter を
 * 適用することで、drift 時も schema-strict downstream consumer (Grafana /
 * audit parser) への contract violation を回避。未知 category key は
 * `unexpectedKeys` array に分離して persist (sentinel との cross-correlation)。
 *
 * **FIND-TPA-PLAN-03 (M)**: audit_logs primary emit failure 時は
 * `[SLO_MARKER] audit_log_emit_failed` log line を出力し、log-based metric
 * で L1.5 tier (primary emit failure rate) として監視可能にする。
 * fail-open による L0 OK 偽陽性化を systemic に検知する役割。
 *
 * **PII safety (FIND-PLAN-IO-10)**: `pendingSnapshot` / `category` は numeric-only。
 * No IDs, hashes, URLs, or user identifiers.
 *
 * @param webPageId       - full UUID (will be truncated internally)
 * @param pendingSnapshot - category → pending count map (numeric-only)
 */
async function emitParityCheckFailedIfEnabled(
  webPageId: string,
  pendingSnapshot: CategoryPendingSnapshot
): Promise<void> {
  const timestamp = new Date().toISOString();

  // (i) Set-equality enforcement (FIND-IMPL-IO-13). drift detection MUST NOT
  //     swallow the primary emit — sentinel entry is additive, not replacing.
  const drift = detectCategoryDrift(pendingSnapshot, EMBEDDING_BACKFILL_CATEGORIES);
  if (drift !== null) {
    await emitCategoryDriftSentinel(webPageId, drift, timestamp);
    // Continue with primary emit anyway (best evidence preservation).
  }

  // (ii) FIND-TPA-PLAN-05 (M): primary emit payload sanitization.
  //      schema-strict downstream consumer との contract 保護のため、
  //      `category` map は EMBEDDING_BACKFILL_CATEGORIES SSOT に含まれる
  //      key のみに filter する。未知 key は unexpectedKeys に分離。
  const filteredCategory = pickKnownKeys(pendingSnapshot, EMBEDDING_BACKFILL_CATEGORIES);
  const unexpectedKeys = drift?.unexpected ?? [];

  // (iii) Primary emit — audit_logs DB write.
  try {
    await getAuditLogService().log({
      action: "embedding_parity_check_failed",
      actor: "system:embedding-backfill-worker",
      targetType: "web_page",
      targetId: webPageId, // 8-char truncated inside audit-log.service
      result: "failure",
      details: {
        category: filteredCategory,
        unexpectedKeys,
        pendingSnapshot: filteredCategory,
        skipReason: "parity_check_failed" as const,
        timestamp,
      },
    });
  } catch (error) {
    // AuditLogService は内部で graceful-degrade (warn-only) するが、DI 未登録
    // 等の早期 throw 経路もあるため明示 catch。primary emit failure は
    // logger.warn で継続伝達する (defense in depth)。
    // FIND-TPA-PLAN-03 (M): SLO_MARKER tag により L1.5 tier
    // (primary emit failure rate) として log-based metric 監視可能にする。
    logger.warn("[EmbeddingBackfillWorker] [SLO_MARKER] audit_log_emit_failed", {
      action: "embedding_parity_check_failed",
      webPageId: webPageId.slice(0, 8) + "...",
      error: sanitizeErrorMessage(error),
      timestamp,
    });
  }

  // (iv) Dual-emit — observability / alert routing.
  logger.warn("[EmbeddingBackfillWorker] parity_check_failed emitted", {
    webPageId: webPageId.slice(0, 8) + "...",
    category: filteredCategory,
    unexpectedKeys,
    pendingSnapshot: filteredCategory,
    skipReason: "parity_check_failed" as const,
    timestamp,
  });
}

/**
 * v0.4.0 PR-D-5 (FIND-IMPL-IO-13 + FIND-TPA-PLAN-05):
 * Sentinel entry for `category` map schema drift — write_time check caught
 * keys that are not in `EMBEDDING_BACKFILL_CATEGORIES` SSOT.
 *
 * Emitted with a **separate action string** (`embedding_parity_schema_drift`)
 * so SLO L3 CRIT alerts can fire independently of the primary emit. Payload
 * schema is drift-specific (does NOT persist raw pendingSnapshot); cross-
 * correlation with primary emit is via `unexpectedKeys`.
 *
 * Sentinel failure is non-fatal — primary emit must proceed regardless.
 */
async function emitCategoryDriftSentinel(
  webPageId: string,
  drift: NonNullable<ReturnType<typeof detectCategoryDrift>>,
  timestamp: string
): Promise<void> {
  try {
    await getAuditLogService().log({
      action: "embedding_parity_schema_drift",
      actor: "system:embedding-backfill-worker",
      targetType: "web_page",
      targetId: webPageId,
      result: "failure",
      details: {
        expected: [...EMBEDDING_BACKFILL_CATEGORIES],
        missing: drift.missing,
        unexpected: drift.unexpected,
        unexpectedKeys: drift.unexpected,
        timestamp,
      },
    });
  } catch (error) {
    // FIND-TPA-PLAN-03 (M): SLO_MARKER tag for L1.5 tier monitoring.
    logger.warn("[EmbeddingBackfillWorker] [SLO_MARKER] audit_log_emit_failed", {
      action: "embedding_parity_schema_drift",
      webPageId: webPageId.slice(0, 8) + "...",
      error: sanitizeErrorMessage(error),
      timestamp,
    });
  }
  logger.error("[EmbeddingBackfillWorker] CRITICAL: category schema drift detected", {
    webPageId: webPageId.slice(0, 8) + "...",
    missing: drift.missing,
    unexpected: drift.unexpected,
  });
}

/**
 * Outcome of the terminal parity gate.
 *
 * `parityFailed === true` の場合、DB row は `skipped_fork_error` (retry bucket) に
 * 遷移済で、呼び出し側は BullMQ job を成功扱いで完了させる。`finalStatus` union
 * は Option A (FIND-PLAN-IO-03) により `skipped_fork_error` を含む形に拡張されている。
 *
 * When `parityFailed === true`, the DB row has already transitioned to
 * `skipped_fork_error` (retry bucket) while the BullMQ job completes
 * successfully. `finalStatus` union expanded via FIND-PLAN-IO-03 Option A.
 */
type ParityGateOutcome = {
  parityFailed: boolean;
  finalStatus: "completed" | "in_progress" | "skipped_fork_error";
};

/**
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003): Terminal parity gate.
 *
 * `finalStatus === "completed"` への遷移直前に `verifyCategoryParity` を実行し、
 * parity 失敗時は `parity_check_failed` を emit した上で DB row を
 * `skipped_fork_error` (retry bucket) に遷移させる。BullMQ job 自体は完了扱い
 * (parity 失敗は DB status を retry に回すだけで job 実行は成功と見なす設計)。
 *
 * Sub-function extraction is mandatory per FIND-PLAN-IO-08 to keep the parent
 * `initiateBackfillJob` cyclomatic complexity ≤ 10.
 *
 * Runs `verifyCategoryParity` immediately before transitioning to `completed`.
 * On parity failure, emits `parity_check_failed` and transitions the DB row
 * to `skipped_fork_error` (retry bucket). The BullMQ job itself still
 * completes successfully (parity failure only redirects DB status to retry).
 *
 * **Invocation-ordering contract (FIND-PLAN-IO-10)**: `verifyCategoryParity`
 * MUST be called before any `updateEmbeddingBackfillStatus(..., "completed")`.
 *
 * @param webPageId       - target web page UUID
 * @param finalStatus     - the status computed by `computeRemainingStatus`
 * @param processorResult - processor outcome (generated / failed counts)
 * @param pendingSnapshot - snapshot from `computeRemainingStatus` (single round-trip)
 * @returns `{parityFailed, finalStatus}` — `finalStatus` matches the DB write
 */
async function handleTerminalParityGate(
  webPageId: string,
  finalStatus: "completed" | "in_progress",
  processorResult: { generated: number; failed: number },
  pendingSnapshot: CategoryPendingSnapshot
): Promise<ParityGateOutcome> {
  void processorResult;
  // Only run the parity gate on the "completed" transition attempt. An
  // `in_progress` verdict means there is still work left and cannot conflict
  // with the INV-003 "completed == all pending=0" contract.
  if (finalStatus !== "completed") {
    return { parityFailed: false, finalStatus };
  }

  const parityResult = verifyCategoryParity(pendingSnapshot);
  if (parityResult.ok) {
    return { parityFailed: false, finalStatus };
  }

  // Parity failed. Emit before DB write so the evidence survives even if the
  // subsequent DB write fails. logger.warn is the sole evidence source until
  // PR-D-5 lands `audit_logs` (FIND-PLAN-IO-07).
  await emitParityCheckFailedIfEnabled(webPageId, parityResult.pendingSnapshot);
  await updateEmbeddingBackfillStatus(webPageId, "skipped_fork_error");
  return { parityFailed: true, finalStatus: "skipped_fork_error" };
}

/**
 * Initiate the backfill job: status transition (queued → in_progress) + Strategy
 * Pattern dispatch. Returns the processor result for the orchestrator to finalize.
 *
 * ジョブ initiation: status 遷移（queued → in_progress）＋ Strategy Pattern dispatch。
 * Processor 結果を orchestrator に返して finalize する。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出（complexity < 10）。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2 (complexity < 10).
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing):
 * - `computeRemainingStatus` を single-query refactor 版に更新 (`{finalStatus, pendingSnapshot}` 返却)。
 * - `handleTerminalParityGate` sub-function を抽出し、terminal transition 直前に
 *   parity gate を挿入。親関数の cyclomatic complexity ≤ 10 を維持 (FIND-PLAN-IO-08)。
 * - Return type `finalStatus` union に `"skipped_fork_error"` を追加 (Option A per FIND-PLAN-IO-03)。
 *   JSDoc 契約: "BullMQ job completes successfully while DB row is in retry bucket".
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing):
 * - Upgraded to single-query-refactor `computeRemainingStatus` returning
 *   `{finalStatus, pendingSnapshot}`.
 * - Extracted `handleTerminalParityGate` sub-function to insert the parity
 *   gate immediately before the terminal transition. Keeps parent cyclomatic
 *   complexity ≤ 10 (FIND-PLAN-IO-08).
 * - Return-type `finalStatus` union extended with `"skipped_fork_error"`
 *   (Option A per FIND-PLAN-IO-03). JSDoc contract: "BullMQ job completes
 *   successfully while DB row is in retry bucket".
 */
async function initiateBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<{
  generated: number;
  failed: number;
  /**
   * Final status returned to `processBackfillJob`. `"skipped_fork_error"`
   * indicates the INV-003 parity gate failed: the BullMQ job completes
   * successfully while the DB row is routed to the retry bucket
   * (see `handleTerminalParityGate` + FIND-PLAN-IO-03 Option A).
   */
  finalStatus: "completed" | "in_progress" | "skipped_fork_error";
  /**
   * PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1 Supplement S3):
   * `bbox_unresolvable` added (Playwright-residual catch-all from
   * `PartVisualProcessor`; mutually exclusive with `bbox_invalid`).
   */
  skipReason?: "ssrf_blocked_on_backfill" | "parity_check_failed" | "bbox_unresolvable";
}> {
  const { webPageId, category } = job.data;

  // ジョブ開始直後に in_progress へ遷移（status 観測性）
  // Transition to in_progress immediately for observability
  await updateEmbeddingBackfillStatus(webPageId, "in_progress");

  // v0.4.0 PR7a-2: Strategy Pattern dispatch（exhaustiveness は Record で保証）
  // v0.4.0 PR7a-2: Strategy Pattern dispatch — exhaustiveness enforced by the Record
  await job.updateProgress(PROGRESS_AFTER_FETCH);
  const processor = getBackfillProcessor(category);

  const screenshotStoragePath = await resolveScreenshotForProcessor(
    processor,
    webPageId,
    category,
    job.data.screenshotStoragePath
  );

  const ctx: BackfillProcessContext = {
    webPageId,
    job,
    screenshotStoragePath,
    prisma: prisma as unknown as EmbeddingPhasePrismaClient,
  };
  const processorResult = await processor.process(ctx);
  await job.updateProgress(PROGRESS_AFTER_EMBEDDING);

  // 完了後の status 判定（残余があれば in_progress、無ければ completed）+ parity snapshot
  // Decide final status (in_progress if items remain, otherwise completed) + parity snapshot
  const { finalStatus: remainingStatus, pendingSnapshot } = await computeRemainingStatus(webPageId);

  // v0.4.0 PR-D-4: INV-EMBEDDING-INTEGRITY-003 terminal parity gate.
  // On parity failure the DB row transitions to `skipped_fork_error` (retry bucket)
  // and the caller-facing `finalStatus` matches the DB write (FIND-PLAN-IO-03
  // Option A). Parent cyclomatic complexity stays ≤ 10 via the extracted
  // `handleTerminalParityGate` sub-function (FIND-PLAN-IO-08).
  const parityOutcome = await handleTerminalParityGate(
    webPageId,
    remainingStatus,
    { generated: processorResult.generated, failed: processorResult.failed },
    pendingSnapshot
  );

  // Non-parity-failure path writes the computed finalStatus as usual.
  // parityFailed path already wrote `skipped_fork_error` in handleTerminalParityGate.
  if (!parityOutcome.parityFailed) {
    await updateEmbeddingBackfillStatus(webPageId, remainingStatus);
  }

  await job.updateProgress(PROGRESS_COMPLETE);
  await job.log(
    `[EmbeddingBackfill] Complete: generated=${processorResult.generated}, ` +
      `failed=${processorResult.failed}, status=${parityOutcome.finalStatus}`
  );

  // v0.4.0 PR7e-α (bug⑦ observability): surface ssrf_blocked_on_backfill onto
  // the job result so MCP clients can distinguish SSRF-blocked Backfill skips
  // from generic "0 generated" results.
  //
  // v0.4.0 PR-D-4: `skipReason: "parity_check_failed"` is also surfaced on
  // parity-failure so MCP clients observe the retry-bucket transition.
  //
  // PR-D-9 Wave 4 (C-02 + C-04): added `bbox_unresolvable` to the union to
  // accept Playwright-residual catch-all from `PartVisualProcessor` per
  // ADR-0018 §Decision 1 Supplement S3 (mutually exclusive with `bbox_invalid`,
  // mapped to `skipped_fork_error` retry bucket via `skipReasonToBackfillStatus`).
  const ret: {
    generated: number;
    failed: number;
    finalStatus: "completed" | "in_progress" | "skipped_fork_error";
    skipReason?: "ssrf_blocked_on_backfill" | "parity_check_failed" | "bbox_unresolvable";
  } = {
    generated: processorResult.generated,
    failed: processorResult.failed,
    finalStatus: parityOutcome.finalStatus,
  };
  if (parityOutcome.parityFailed) {
    ret.skipReason = "parity_check_failed";
  } else if (processorResult.skipReason !== undefined) {
    ret.skipReason = processorResult.skipReason;
  }
  return ret;
}

/**
 * Finalize the backfill job: failure-path status update (only on final attempt)
 * + Pre-Return Pause + post-job memory check.
 *
 * ジョブ finalization: 失敗時 status 更新（最終 attempt のみ）＋ Pre-Return Pause
 * ＋ post-job memory check。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `processBackfillJob` から抽出（complexity < 10）。
 * v0.4.0 PR7a-3: Extracted from `processBackfillJob` per TDA High-2 (complexity < 10).
 */
async function finalizeBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  error: unknown | null
): Promise<void> {
  const { webPageId } = job.data;

  // 失敗時のみ: 最終 attempt で failed 遷移
  // Failure path: transition to failed only on the final attempt
  if (error !== null) {
    // BullMQ の attempts=3 でリトライされるため、failed への更新は最終試行後のみ行う。
    // attemptsMade は 1-origin, job.opts.attempts は最大試行回数。
    //
    // Update to `failed` only on the final attempt — BullMQ will retry up to
    // `attempts=3` times. attemptsMade is 1-origin; opts.attempts is the cap.
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await updateEmbeddingBackfillStatus(webPageId, "failed");
    }
  }

  // Memory-Gated Exit (post-job) (v0.4.0 PR7e-β2 hotfix)
  // ---------------------------------------------------------------------
  // RSS 閾値超過時は process.exit(0) → WorkerSupervisor 再起動。未満時は no-op で
  // BullMQ mainLoop が自然に次ジョブを fetch する。pause/resume は BullMQ 5.66.5
  // Worker.resume() の silent no-op race を避けるため削除済み（ADR-0009 参照）。
  // `moveToCompleted` Lua による fetchNext=false 保証と併用するため、本ヘルパーは
  // concurrency に対して中立。
  //
  // Exits on RSS threshold breach so WorkerSupervisor restarts, otherwise no-op —
  // the BullMQ mainLoop fetches the next job naturally. pause/resume were removed
  // to avoid the BullMQ 5.66.5 `Worker.resume()` silent no-op race (see ADR-0009).
  //
  // Note: failure path (error !== null) も同じ gate を適用する。
  //       BullMQ リトライ (attempts=3) と独立した memory gate なので両 path 共通。
  // Note: the failure path (error !== null) also applies the same gate.
  //       It is independent of BullMQ retry semantics (attempts=3) and shared by both paths.
  await applyPostJobMemoryGate(_preReturnPauseEnabled, "[EmbeddingBackfillWorker]");
}

/**
 * Main processor function for embedding backfill jobs.
 * Embedding バックフィルジョブのメイン Processor 関数。
 *
 * v0.4.0 PR7a-2: Strategy Pattern (`PROCESSORS` in `embedding-backfill-processors.ts`)
 * にカテゴリ別処理を委譲。`part_text` / `part_visual` 以外の 5 カテゴリも SSOT 上は
 * valid だが、runtime に enqueue されるのは現状 `part_text` / `part_visual` のみ
 * （PR7b で Skip recovery enqueue パス実装時に他カテゴリも runtime 活性化）。
 *
 * v0.4.0 PR7a-3: TDA High-2 対応で `initiateBackfillJob` + `finalizeBackfillJob`
 * + `validateJobData` に分割。本関数は薄い orchestrator として残し、各関数の
 * cyclomatic complexity は < 10 に収まる。
 *
 * v0.4.0 PR7a-2: Delegates per-category logic to the Strategy Pattern
 * (`PROCESSORS` in `embedding-backfill-processors.ts`). The 5 non-part categories
 * are SSOT-valid but currently unreachable at runtime — only `part_text` /
 * `part_visual` are enqueued today. PR7b activates the rest via the skip-recovery
 * enqueue path.
 *
 * v0.4.0 PR7a-3: Split into `initiateBackfillJob` + `finalizeBackfillJob` +
 * `validateJobData` per TDA High-2. This function is now a thin orchestrator;
 * each helper keeps cyclomatic complexity < 10.
 */
async function processBackfillJob(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<EmbeddingBackfillJobResult> {
  const startTime = Date.now();

  validateJobData(job);

  const { webPageId, category } = job.data;

  if (isDevelopment()) {
    logger.info("[EmbeddingBackfillWorker] Processing job", {
      jobId: job.id,
      webPageId: webPageId.slice(0, 8) + "...",
      category,
    });
  }

  await job.updateProgress(PROGRESS_START);
  await job.log(
    `[EmbeddingBackfill] Started category=${category}, webPageId=${webPageId.slice(0, 8)}...`
  );

  let generatedCount = 0;
  let failedCount = 0;
  let errorMsg: string | undefined;
  let caughtError: unknown | null = null;
  // PR-D-9 Wave 4 (C-02 + C-04): added `bbox_unresolvable` per ADR-0018
  // §Decision 1 Supplement S3 (Playwright-residual catch-all).
  let outcomeSkipReason:
    | "ssrf_blocked_on_backfill"
    | "parity_check_failed"
    | "bbox_unresolvable"
    | undefined;

  try {
    const outcome = await initiateBackfillJob(job);
    generatedCount = outcome.generated;
    failedCount = outcome.failed;
    if (outcome.skipReason !== undefined) {
      outcomeSkipReason = outcome.skipReason;
    }
  } catch (error) {
    caughtError = error;
    errorMsg = sanitizeErrorMessage(error);
    logger.error("[EmbeddingBackfillWorker] Job failed", {
      jobId: job.id,
      webPageId: webPageId.slice(0, 8) + "...",
      category,
      error: errorMsg,
    });
  } finally {
    await finalizeBackfillJob(job, caughtError);
  }

  if (caughtError !== null) {
    throw caughtError;
  }

  const processingTimeMs = Date.now() - startTime;
  const result: EmbeddingBackfillJobResult = {
    webPageId,
    category,
    generatedCount,
    failedCount,
    processingTimeMs,
    completedAt: new Date().toISOString(),
  };
  if (errorMsg !== undefined) {
    result.error = errorMsg;
  }
  if (outcomeSkipReason !== undefined) {
    result.skipReason = outcomeSkipReason;
  }
  return result;
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create an EmbeddingBackfillWorker instance
 *
 * EmbeddingBackfillWorker インスタンスを作成する
 *
 * @param options - Worker configuration
 * @returns Worker instance with lifecycle methods
 */
export function createEmbeddingBackfillWorker(
  options: EmbeddingBackfillWorkerOptions = {}
): EmbeddingBackfillWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info("[EmbeddingBackfillWorker] Creating worker", {
      queueName: EMBEDDING_BACKFILL_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>(
    EMBEDDING_BACKFILL_QUEUE_NAME,
    processBackfillJob,
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
      stalledInterval: Math.max(60_000, DEFAULT_STALLED_INTERVAL),
      maxStalledCount: DEFAULT_MAX_STALLED_COUNT,
    }
  );

  // Event handlers for monitoring
  worker.on("completed", (job, result) => {
    if (verbose) {
      logger.info("[EmbeddingBackfillWorker] Job completed", {
        jobId: job.id,
        webPageId: result.webPageId.slice(0, 8) + "...",
        category: result.category,
        generatedCount: result.generatedCount,
      });
    }
    // Notify parent (WorkerSupervisor) via IPC for planned restart.
    //
    // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload now conforms to the
    // `WorkerIpcMessageSchema` SSOT. supervisor's `verifyWorkerIpcMessage`
    // rejects payloads lacking `workerType` or `timestamp`.
    // PR-D-8 Phase 2: IPC payload は SSOT スキーマ準拠で emit する。
    try {
      process.send?.({
        type: "job-completed",
        workerType: "embedding-backfill",
        jobId: job.id,
        timestamp: Date.now(),
      });
    } catch {
      /* non-fatal — IPC channel may be closed during shutdown */
    }
  });

  worker.on("failed", (job, error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[EmbeddingBackfillWorker] Job failed event", {
      jobId: job?.id,
      webPageId: job?.data.webPageId?.slice(0, 8) + "...",
      error: sanitizeErrorMessage(error),
    });
  });

  worker.on("error", (error) => {
    // PR7c F3: CWE-209 統一 — sanitizeErrorMessage で PII/内部構造漏洩を防御
    // PR7c F3: CWE-209 unification — sanitizeErrorMessage prevents PII / internal structure leakage
    logger.error("[EmbeddingBackfillWorker] Worker error", {
      error: sanitizeErrorMessage(error),
    });
  });

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info("[EmbeddingBackfillWorker] Closing worker");
      }
      isRunning = false;
      // Fix-1 (INFRA-EMBEDDING-MOTION-SIGABRT-001): close BullMQ Worker FIRST so
      // any in-flight job completes (and its lock releases) before we tear down
      // the ONNX Runtime pipeline. The previous order (`dispose → close`) raced
      // with motion-category batches whose final ONNX inference was still
      // running on the parent Worker Thread; tearing down the ONNX session
      // mid-inference triggered a native pthread abort (SIGABRT) due to ONNX
      // Runtime's COW pthread inheritance with the still-active inference.
      //
      // 修正: BullMQ Worker を先に close → in-flight job 完了と lock release を
      // 待つ → ONNX disposeEmbeddingPipeline() で安全に session 解放。
      // motion category 処理中に dispose が ONNX 推論と race して native
      // pthread abort (SIGABRT) を起こす問題を解消。
      //
      // Cross-ref: ADR-0019 "Embedding Worker Close-Before-Dispose Ordering",
      //            IO §13.16.4 Plan Decision (Fix-1 Option A).
      await worker.close();
      try {
        await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      } catch {
        /* non-fatal during shutdown */
      }
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info("[EmbeddingBackfillWorker] Pausing worker (no new jobs will be accepted)");
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports — for tests
// ============================================================================

// Exported only for unit tests. Not part of the public contract.
// 単体テスト用のみ。公開契約ではない。
export {
  processBackfillJob,
  initiateBackfillJob,
  finalizeBackfillJob,
  validateJobData,
  resolveScreenshotForProcessor,
  resolveScreenshotPath,
  computeRemainingStatus,
  updateEmbeddingBackfillStatus,
  // v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003): exposed for standing regression.
  emitParityCheckFailedIfEnabled,
  // v0.4.0 PR-D-5 (FIND-IMPL-IO-13 + FIND-TPA-PLAN-05): exposed for unit tests.
  emitCategoryDriftSentinel,
  handleTerminalParityGate,
  type ParityGateOutcome,
  type EmbeddingBackfillCategory,
};
