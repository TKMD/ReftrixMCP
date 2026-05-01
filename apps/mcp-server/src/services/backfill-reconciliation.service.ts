// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Reconciliation Service — Stale `in_progress` Detection & Remediation
 *
 * v0.4.0 PR5: `web_pages.embeddingBackfillStatus = 'in_progress'` のページで、
 * 対応する `embedding-backfill` ジョブが BullMQ に存在しない（completed / failed /
 * retention 期限切れ）場合、DB 完全性から真の状態を再判定して status を補正する。
 *
 * v0.4.0 PR5: For pages with `web_pages.embeddingBackfillStatus = 'in_progress'`
 * whose corresponding `embedding-backfill` jobs are no longer in BullMQ
 * (completed / failed / retention expired), re-derive the actual state from DB
 * completeness and correct the status.
 *
 * 判定ロジック / Decision logic:
 *   - Queue に該当 job が active / waiting / delayed として存在 → 変更なし
 *     (still being processed / retried — leave `in_progress`)
 *   - Queue に該当 job が存在しない:
 *     - DB 上 embedding が全件完全 → `completed`
 *     - 未完全のものが残っている → `failed`
 *       （次回 `embedding-backfill` 投入時に Worker がピックアップするため）
 *
 * Stale 判定しきい値は `staleThresholdMs`（デフォルト 1 時間）で制御し、
 * `embeddingBackfillStartedAt` (v0.4.0 PR6 で追加) から一定時間経過したページのみを
 * 対象にする（競合回避 + updatedAt 揺らぎからの分離）。
 *
 * A `staleThresholdMs` gate (default 1 hour) restricts remediation to pages
 * whose `embeddingBackfillStartedAt` (added in v0.4.0 PR6) is old enough,
 * preventing races with in-flight workers and decoupling from unrelated
 * `updatedAt` changes.
 *
 * v0.4.0 PR6 更新点 / PR6 updates:
 *   - TPA #1: `update` → `updateMany` CAS パターンで Worker 側 status 遷移と競合回避
 *   - TPA #1: Switched from `update` to `updateMany` CAS to avoid races with worker
 *   - TPA #2: `embeddingBackfillStartedAt` ベースの stale 判定に移行
 *   - TPA #2: Migrated stale detection to `embeddingBackfillStartedAt`
 *
 * @module services/backfill-reconciliation.service
 */

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  SKIP_RECOVERY_RETRY_CAP,
  buildBackfillJobId,
  checkBackfillQueueBackPressure,
  resolveMemoryPressureDelayMs,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../queues/embedding-backfill-queue";
import { enqueueAllCategoriesForSkipRecovery } from "../queues/embedding-backfill-processors";
import { computeRemainingStatusWithPrisma } from "./backfill-status.helper";
import { getAuditLogService } from "./audit-log.service";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

/**
 * Reconciliation 結果 / Reconciliation result
 *
 * v0.4.0 PR7b (ADR-0008 #6): `staleDetected` / `remediated` は `in_progress` 起源と
 * `skipped_*` 起源の合算。recovery / TTL expiration / retry cap exhausted は内訳
 * フィールドで分離して観測する。
 *
 * v0.4.0 PR7b (ADR-0008 #6): `staleDetected` / `remediated` aggregate across
 * `in_progress` and `skipped_*` origins. Recovery / TTL expiration / retry cap
 * exhaustion are surfaced via dedicated breakdown fields.
 */
export interface BackfillReconciliationResult {
  /** Total rows examined (in_progress + skipped_*) / 検査した行数の合計 */
  totalChecked: number;
  /** Detected as stale (no active queue job) / Queue に active/waiting/delayed が無かった件数 */
  staleDetected: number;
  /** DB 判定で status を書き換えた件数（合計） / Rows whose status was updated (total) */
  remediated: number;
  /**
   * CAS 条件を満たせず Worker 側が先に status を更新した件数（PR6 TPA #1）
   * Rows whose status was changed by the worker between check and update (PR6 TPA #1)
   *
   * `updateMany` の WHERE に `embeddingBackfillStatus = 'in_progress'` を含めることで
   * Worker による先行 completed 遷移との race を検出する。この数は実害ではなく、
   * 本サービスが非破壊的に動作している健全性シグナルとして扱う。
   *
   * Counts cases where the worker already transitioned the row (e.g. to 'completed')
   * between our SELECT and UPDATE, detected via the WHERE guard on
   * `embeddingBackfillStatus = 'in_progress'`. This is not a failure but a healthy
   * non-destructive operation signal.
   */
  concurrentUpdatesSkipped: number;
  /** DB 判定または queue 照会で例外が起きた件数 / Rows that errored out */
  errors: number;
  /**
   * v0.4.0 PR7b (ADR-0008 #6): skipped_* 起源で再 enqueue した件数。
   * skip recovery 補完経路（Worker 即時 enqueue が IPC race / crash 等で失敗した
   * 場合の最終防衛線）の発火回数を観測する。
   *
   * v0.4.0 PR7b (ADR-0008 #6): Number of skipped_* rows re-enqueued by the
   * cron. Observes how often the recovery fallback fires (last line of defense
   * when the immediate Worker enqueue fails via IPC race / crash).
   */
  skipRecoveryEnqueued: number;
  /**
   * v0.4.0 PR7b (ADR-0008 #6 / LCC M-3): 7d TTL を超過し `failed` に固定した件数。
   * `embeddingBackfillSkippedAt` から 7 日経過した skipped_* 行を `failed` に
   * 遷移させる。古いインシデントの無限 recovery を防止。
   *
   * v0.4.0 PR7b (ADR-0008 #6 / LCC M-3): Rows pinned to `failed` after
   * exceeding the 7-day TTL on `embeddingBackfillSkippedAt`. Prevents
   * indefinite recovery of stale incidents.
   */
  ttlExpired: number;
  /**
   * v0.4.0 PR7b (ADR-0008 #8 / SEC HIGH-1): retry cap (5) を超過し `failed` に
   * 固定した件数。本 cron でも recovery enqueue 前に `embeddingBackfillRetryCount`
   * を確認し、超過行はここでカウントする。
   *
   * v0.4.0 PR7b (ADR-0008 #8 / SEC HIGH-1): Rows pinned to `failed` after
   * exceeding retry cap (5). The cron also checks `embeddingBackfillRetryCount`
   * before enqueueing recovery; rows exceeding the cap are counted here.
   */
  retryCapExhausted: number;
  /**
   * Dry-run モード中は実 update を行わず、対象ページの一覧のみを返す（PR6 SEC LOW-2）
   * In dry-run mode, no real updates are performed; only a preview of target pages is
   * returned (PR6 SEC LOW-2).
   */
  dryRun: boolean;
}

/**
 * Options for {@link reconcileStaleBackfillJobs}.
 */
export interface ReconcileOptions {
  prisma: PrismaClient;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /**
   * `in_progress` 状態で書き換え対象とする経過時間（ms）。
   * デフォルト 60 分（3,600,000ms）。
   * How long a row must have been `in_progress` before it becomes eligible
   * for remediation. Default: 60 minutes (3,600,000ms).
   */
  staleThresholdMs?: number;
  /**
   * 1 回で処理する最大行数（誤発火時のブラスト半径を限定）。
   * Maximum rows per invocation (caps blast radius on misfire). Default 500.
   */
  batchLimit?: number;
  /**
   * Dry-run モード：実際の update はスキップし、対象ページ一覧のみをログ出力する。
   * PR6 SEC LOW-2: production での誤発火を防ぐため CLI `--dry-run` で利用。
   *
   * Dry-run mode: skip actual updates and only log the target page list.
   * PR6 SEC LOW-2: used by CLI `--dry-run` to prevent accidental production runs.
   */
  dryRun?: boolean;
}

/**
 * Zod schema for the option values that can be overridden via env / CLI.
 */
const OptionsSchema = z.object({
  staleThresholdMs: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60 * 1000)
    .optional(),
  batchLimit: z.number().int().positive().max(10000).optional(),
  dryRun: z.boolean().optional(),
});

const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_BATCH_LIMIT = 500;

/**
 * v0.4.0 PR7b (ADR-0008 #6 / LCC M-3): skipped_* 状態の TTL（ms）。
 * `embeddingBackfillSkippedAt` から本値を超過した skipped_* 行は `failed` に
 * 固定し、recovery 対象から外す。デフォルト 7 日。
 *
 * v0.4.0 PR7b (ADR-0008 #6 / LCC M-3): TTL (ms) for skipped_* rows. Rows whose
 * `embeddingBackfillSkippedAt` exceeds this value are pinned to `failed` and
 * removed from the recovery pool. Default 7 days.
 */
const DEFAULT_SKIP_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` は
 * `queues/embedding-backfill-queue.ts` の SSOT から import する。
 * 以前は page-analyze-worker.ts と 2 重定義されており drift リスクがあった。
 *
 * PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` now imported from the
 * SSOT in `queues/embedding-backfill-queue.ts`. Previously duplicated with
 * `page-analyze-worker.ts`, creating drift risk.
 */

/**
 * Queue 状態が「まだ処理中とみなす」かを返す。
 * Returns whether the queue state should still be treated as in-progress.
 *
 * `active` / `waiting` / `delayed` は Worker が再開する可能性があるので据え置き、
 * `completed` / `failed` / `unknown`（ジョブが retention 切れ） は再判定対象。
 */
function isQueueStateActive(state: string): boolean {
  return state === "active" || state === "waiting" || state === "delayed";
}

interface WebPageStalenessRow {
  id: string;
  url: string | null;
  startedAt: Date;
}

/**
 * v0.4.0 PR7b (ADR-0008 #6): skipped_* 行の判定用
 * v0.4.0 PR7b (ADR-0008 #6): skipped_* row metadata
 */
interface WebPageSkippedRow {
  id: string;
  url: string | null;
  status: "skipped_fork_error" | "skipped_memory_pressure";
  skippedAt: Date;
  retryCount: number;
  screenshotStoragePath: string | null;
}

/**
 * `in_progress` が `staleThresholdMs` を超えた web_pages 行を取得する。
 * Fetches `in_progress` web_pages rows older than the threshold.
 *
 * PR6 TPA #2: `updatedAt` ではなく専用列 `embeddingBackfillStartedAt` を参照する。
 * NULL の行（PR6 以前に `in_progress` 遷移したレガシー行）は自動的に除外される。
 *
 * PR6 TPA #2: Uses the dedicated `embeddingBackfillStartedAt` column instead of
 * `updatedAt`. Rows with NULL values (legacy rows that transitioned before PR6)
 * are naturally excluded.
 */
async function fetchStaleInProgressPages(
  prisma: PrismaClient,
  thresholdMs: number,
  limit: number
): Promise<WebPageStalenessRow[]> {
  const cutoff = new Date(Date.now() - thresholdMs);
  const rows = await prisma.webPage.findMany({
    where: {
      embeddingBackfillStatus: "in_progress",
      embeddingBackfillStartedAt: { lt: cutoff, not: null },
    },
    select: { id: true, url: true, embeddingBackfillStartedAt: true },
    take: limit,
    orderBy: { embeddingBackfillStartedAt: "asc" },
  });
  return rows
    .filter(
      (row): row is typeof row & { embeddingBackfillStartedAt: Date } =>
        row.embeddingBackfillStartedAt !== null
    )
    .map((row) => ({
      id: row.id,
      url: row.url,
      startedAt: row.embeddingBackfillStartedAt,
    }));
}

/**
 * v0.4.0 PR7b (ADR-0008 #6): skipped_* 状態で stale な行を取得する。
 * `embeddingBackfillSkippedAt` が `staleThresholdMs` を超過した行のみ対象。
 * `embeddingBackfillRetryCount` は呼び出し側で 5 回超過チェックする。
 *
 * v0.4.0 PR7b (ADR-0008 #6): Fetches stale skipped_* rows. Only rows whose
 * `embeddingBackfillSkippedAt` exceeds `staleThresholdMs`. The caller checks
 * `embeddingBackfillRetryCount` against the cap.
 */
async function fetchStaleSkippedPages(
  prisma: PrismaClient,
  thresholdMs: number,
  limit: number
): Promise<WebPageSkippedRow[]> {
  const cutoff = new Date(Date.now() - thresholdMs);
  const rows = await prisma.webPage.findMany({
    where: {
      embeddingBackfillStatus: { in: ["skipped_fork_error", "skipped_memory_pressure"] },
      embeddingBackfillSkippedAt: { lt: cutoff, not: null },
    },
    select: {
      id: true,
      url: true,
      embeddingBackfillStatus: true,
      embeddingBackfillSkippedAt: true,
      embeddingBackfillRetryCount: true,
      screenshotStoragePath: true,
    },
    take: limit,
    orderBy: { embeddingBackfillSkippedAt: "asc" },
  });
  return rows
    .filter(
      (row): row is typeof row & { embeddingBackfillSkippedAt: Date } =>
        row.embeddingBackfillSkippedAt !== null
    )
    .map((row) => ({
      id: row.id,
      url: row.url,
      status: row.embeddingBackfillStatus as "skipped_fork_error" | "skipped_memory_pressure",
      skippedAt: row.embeddingBackfillSkippedAt,
      retryCount: row.embeddingBackfillRetryCount ?? 0,
      screenshotStoragePath: row.screenshotStoragePath,
    }));
}

/**
 * Queue 側に `<webPageId>__<category>` のどれかが active/waiting/delayed として
 * 残っているかを確認する。
 * Checks whether any `<webPageId>__<category>` job is still active/waiting/delayed
 * on the queue.
 */
async function hasActiveQueueJob(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  webPageId: string
): Promise<boolean> {
  for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
    const jobId = buildBackfillJobId(webPageId, category);
    const job = await queue.getJob(jobId);
    if (!job) continue;
    const state = await job.getState();
    if (isQueueStateActive(state)) {
      return true;
    }
  }
  return false;
}

/**
 * Stale な `in_progress` ページを検出し、DB 完全性で status を補正する。
 *
 * この関数は純粋な service として振る舞い、呼び出し側（CLI / cron / tests）は
 * 任意の `PrismaClient` と `Queue` を注入できる。副作用は
 * {@link PrismaClient} 経由の `web_pages.embeddingBackfillStatus` 更新のみ。
 *
 * Detects stale `in_progress` pages and reconciles status against DB completeness.
 *
 * Pure service-style function — callers (CLI / cron / tests) inject any
 * {@link PrismaClient} and {@link Queue}. The only side effect is updating
 * `web_pages.embeddingBackfillStatus` via {@link PrismaClient}.
 *
 * PR6 TPA #1 (CAS): `updateMany` with `embeddingBackfillStatus = 'in_progress'`
 * guard to prevent races with worker-side transitions. Count of skipped updates
 * is surfaced via `concurrentUpdatesSkipped`.
 *
 * PR6 SEC LOW-2 (dry-run): When `dryRun: true`, no DB updates are performed;
 * the result lists targets only for operator preview.
 */
export async function reconcileStaleBackfillJobs(
  options: ReconcileOptions
): Promise<BackfillReconciliationResult> {
  // Zod 検証（外部入力経路の CLI/cron で不正値が渡るケースを弾く）
  // Zod validation — rejects invalid values from CLI/cron call sites.
  const parsed = OptionsSchema.parse({
    staleThresholdMs: options.staleThresholdMs,
    batchLimit: options.batchLimit,
    dryRun: options.dryRun,
  });

  const thresholdMs = parsed.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const batchLimit = parsed.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const dryRun = parsed.dryRun ?? false;
  const { prisma, queue } = options;

  const result: BackfillReconciliationResult = {
    totalChecked: 0,
    staleDetected: 0,
    remediated: 0,
    concurrentUpdatesSkipped: 0,
    errors: 0,
    skipRecoveryEnqueued: 0,
    ttlExpired: 0,
    retryCapExhausted: 0,
    dryRun,
  };

  // -- Section A: in_progress stale recovery (PR5/PR6 既存パス) ---------------
  // Section A: in_progress stale recovery (existing PR5/PR6 path)
  await reconcileInProgressRows({
    prisma,
    queue,
    thresholdMs,
    batchLimit,
    dryRun,
    result,
  });

  // -- Section B: skipped_* recovery (v0.4.0 PR7b / ADR-0008 #6) -------------
  // Section B: skipped_* recovery (v0.4.0 PR7b / ADR-0008 #6)
  await reconcileSkippedRows({
    prisma,
    queue,
    thresholdMs,
    batchLimit,
    dryRun,
    result,
  });

  logger.info("[BackfillReconciliation] Batch complete", {
    totalChecked: result.totalChecked,
    staleDetected: result.staleDetected,
    remediated: result.remediated,
    concurrentUpdatesSkipped: result.concurrentUpdatesSkipped,
    skipRecoveryEnqueued: result.skipRecoveryEnqueued,
    ttlExpired: result.ttlExpired,
    retryCapExhausted: result.retryCapExhausted,
    errors: result.errors,
    dryRun: result.dryRun,
  });

  return result;
}

/**
 * Section A: in_progress 起源の stale 行を reconcile する（PR5/PR6 既存ロジック）。
 * Section A: Reconcile in_progress-origin stale rows (existing PR5/PR6 logic).
 */
async function reconcileInProgressRows(args: {
  prisma: PrismaClient;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  thresholdMs: number;
  batchLimit: number;
  dryRun: boolean;
  result: BackfillReconciliationResult;
}): Promise<void> {
  const { prisma, queue, thresholdMs, batchLimit, dryRun, result } = args;
  const candidates = await fetchStaleInProgressPages(prisma, thresholdMs, batchLimit);
  result.totalChecked += candidates.length;

  for (const row of candidates) {
    try {
      // Queue 側に active/waiting/delayed が残っていればスキップ（処理中）
      // Skip if queue still has an active/waiting/delayed job (in-flight).
      const queueActive = await hasActiveQueueJob(queue, row.id);
      if (queueActive) {
        continue;
      }
      result.staleDetected += 1;

      // v0.4.0 PR7e-β2 carryover (SSOT unification): Worker SSOT の
      // `computeRemainingStatus` を再利用し、7 カテゴリ全ての backfill-eligible 件数で
      // 真の残余を判定する。旧 `countRemainingGaps` は part_text / part_visual の 2
      // カテゴリのみかつ backfill-eligible 絞り込みなし (blank image skip / section
      // カバー外 parts を pending にカウント) だったため、backfill 成功後も
      // reconciliation が誤って `failed` に遷移させる誤判定を引き起こしていた。
      // `computeRemainingStatus` は backfill worker 側と同じロジックで判定するため、
      // Worker と Reconciliation の判定結果が SSOT で同期する。
      //
      // v0.4.0 PR7e-β2 carryover (SSOT unification): Reuses the worker's SSOT
      // `computeRemainingStatus` so all 7 backfill-eligible categories are considered.
      // The former `countRemainingGaps` covered only part_text / part_visual without
      // any backfill-eligible narrowing (blank image skips and out-of-section parts
      // counted as pending), which caused reconciliation to mis-transition rows to
      // `failed` even after a successful backfill. Using `computeRemainingStatus`
      // keeps the worker and reconciliation in lockstep.
      //
      // TODO: Stripe で観測された motion_embeddings 0 件の別件調査は別 PR で扱う
      //       (Phase 5 motion embedding が生成されなかった真因の調査、scope 外)。
      // TODO: Stripe-observed motion_embeddings 0-count issue is out of scope —
      //       follow-up PR to investigate why Phase 5 did not generate motion embeddings.
      // v0.4.0 PR-D-4: `computeRemainingStatusWithPrisma` は `{finalStatus, pendingSnapshot}`
      // を返す single-query refactor 後の API。reconciliation は finalStatus のみ
      // 参照する (pendingSnapshot は parity-check 用で reconciliation とは別契約)。
      // v0.4.0 PR-D-4: `computeRemainingStatusWithPrisma` now returns
      // `{finalStatus, pendingSnapshot}` after the single-query refactor.
      // Reconciliation only consumes `finalStatus` (pendingSnapshot belongs to
      // the parity-check contract and is not used here).
      const { finalStatus: remainingStatus } = await computeRemainingStatusWithPrisma(
        row.id,
        prisma
      );
      // reconciliation の責務は stale 行の status pin。
      // `completed` はそのまま、`in_progress` 相当 (残余あり) は `failed` に固定。
      // reconciliation pins stale rows. `completed` maps through; any remaining
      // (`in_progress`) is pinned to `failed`.
      const newStatus: "completed" | "failed" =
        remainingStatus === "completed" ? "completed" : "failed";

      if (dryRun) {
        // PR6 SEC LOW-2: dry-run は DB 書き込みをスキップし target 一覧を logger.info 出力
        // PR6 SEC LOW-2: dry-run skips DB writes and logs the target list
        logger.info("[BackfillReconciliation] [dry-run] Would reconcile in_progress page", {
          webPageId: row.id.slice(0, 8) + "...",
          remainingStatus,
          wouldTransitionTo: newStatus,
          stalenessMs: Date.now() - row.startedAt.getTime(),
        });
        continue;
      }

      // PR6 TPA #1 (CAS): WHERE 句に embeddingBackfillStatus = 'in_progress' を含めて、
      // Worker が先に遷移させていた場合 updated.count === 0 になり書き込みを抑止する。
      // PR6 TPA #1 (CAS): WHERE-clause guards `embeddingBackfillStatus = 'in_progress'`.
      // If the worker already transitioned the row, updated.count === 0 and we skip.
      const updated = await prisma.webPage.updateMany({
        where: {
          id: row.id,
          embeddingBackfillStatus: "in_progress",
        },
        data: { embeddingBackfillStatus: newStatus },
      });

      if (updated.count === 0) {
        result.concurrentUpdatesSkipped += 1;
        logger.info("[BackfillReconciliation] Status changed by worker during check — skipping", {
          webPageId: row.id.slice(0, 8) + "...",
          attemptedTransition: newStatus,
        });
        continue;
      }

      result.remediated += 1;
      logger.info("[BackfillReconciliation] Reconciled stale in_progress page", {
        webPageId: row.id.slice(0, 8) + "...",
        remainingStatus,
        newStatus,
        stalenessMs: Date.now() - row.startedAt.getTime(),
      });
    } catch (error) {
      result.errors += 1;
      logger.warn("[BackfillReconciliation] Failed to reconcile in_progress page (non-fatal)", {
        webPageId: row.id.slice(0, 8) + "...",
        error: sanitizeErrorMessage(error),
      });
    }
  }
}

/**
 * PR7b-convergence (TDA H-2): TTL 超過の skipped_* 行を `failed` に固定する。
 * `reconcileSkippedRows` から抽出して complexity を ≤10 に収束させる。
 *
 * 副作用 / Side effects:
 *   - dryRun=true: ログ出力のみ
 *   - dryRun=false: `embeddingBackfillStatus = 'failed'` に CAS で遷移し、audit log を記録
 *   - `result.ttlExpired` または `result.concurrentUpdatesSkipped` をインクリメント
 *
 * PR7b-convergence (TDA H-2): Pin TTL-exceeded skipped_* rows to `failed`.
 * Extracted from `reconcileSkippedRows` to bring its complexity down to ≤10.
 */
async function expireSkippedRowOverTTL(args: {
  prisma: PrismaClient;
  row: WebPageSkippedRow;
  skippedAgeMs: number;
  ttlMs: number;
  dryRun: boolean;
  result: BackfillReconciliationResult;
}): Promise<void> {
  const { prisma, row, skippedAgeMs, ttlMs, dryRun, result } = args;

  if (dryRun) {
    logger.info("[BackfillReconciliation] [dry-run] Would expire skipped_* page (TTL)", {
      webPageId: row.id.slice(0, 8) + "...",
      status: row.status,
      skippedAgeMs,
      ttlMs,
    });
    return;
  }

  const expired = await prisma.webPage.updateMany({
    where: {
      id: row.id,
      embeddingBackfillStatus: { in: ["skipped_fork_error", "skipped_memory_pressure"] },
    },
    data: { embeddingBackfillStatus: "failed", embeddingBackfillStartedAt: null },
  });

  if (expired.count === 0) {
    result.concurrentUpdatesSkipped += 1;
    return;
  }

  result.ttlExpired += 1;
  try {
    await getAuditLogService().log({
      action: "skip_recovery_expired",
      actor: "backfill-reconciliation-cron",
      targetType: "web_page",
      targetId: row.id,
      details: {
        status: row.status,
        skippedAgeMs,
        ttlMs,
      },
      result: "denied",
    });
  } catch {
    /* audit log 失敗は致命的でない / non-fatal */
  }
  logger.info("[BackfillReconciliation] Expired skipped_* page via 7d TTL", {
    webPageId: row.id.slice(0, 8) + "...",
    status: row.status,
    skippedAgeMs,
    ttlMs,
  });
}

/**
 * PR7b-convergence (TDA H-2): retry cap 超過の skipped_* 行を `failed` に固定する。
 * `reconcileSkippedRows` から抽出して complexity を ≤10 に収束させる。
 *
 * PR7b-convergence (TDA H-2): Pin retry-cap-exceeded skipped_* rows to `failed`.
 * Extracted from `reconcileSkippedRows` to bring its complexity down to ≤10.
 */
async function pinSkippedRowOverRetryCap(args: {
  prisma: PrismaClient;
  row: WebPageSkippedRow;
  dryRun: boolean;
  result: BackfillReconciliationResult;
}): Promise<void> {
  const { prisma, row, dryRun, result } = args;

  if (dryRun) {
    logger.info("[BackfillReconciliation] [dry-run] Would pin skipped_* page (retry cap)", {
      webPageId: row.id.slice(0, 8) + "...",
      retryCount: row.retryCount,
      cap: SKIP_RECOVERY_RETRY_CAP,
    });
    return;
  }

  const pinned = await prisma.webPage.updateMany({
    where: {
      id: row.id,
      embeddingBackfillStatus: { in: ["skipped_fork_error", "skipped_memory_pressure"] },
    },
    data: { embeddingBackfillStatus: "failed", embeddingBackfillStartedAt: null },
  });

  if (pinned.count === 0) {
    result.concurrentUpdatesSkipped += 1;
    return;
  }

  result.retryCapExhausted += 1;
  try {
    await getAuditLogService().log({
      action: "backfill_retry_exhausted",
      actor: "backfill-reconciliation-cron",
      targetType: "web_page",
      targetId: row.id,
      details: {
        retryCount: row.retryCount,
        retryCap: SKIP_RECOVERY_RETRY_CAP,
        status: row.status,
      },
      result: "denied",
    });
  } catch {
    /* audit log 失敗は致命的でない / non-fatal */
  }
  logger.warn("[BackfillReconciliation] Pinned skipped_* page (retry cap exceeded)", {
    webPageId: row.id.slice(0, 8) + "...",
    retryCount: row.retryCount,
    cap: SKIP_RECOVERY_RETRY_CAP,
  });
}

/**
 * Section B: skipped_* 起源の行を reconcile する（v0.4.0 PR7b / ADR-0008 #6）。
 *
 * 各行に対し:
 *   - 7 日 TTL 超過 → `failed` 固定 (LCC M-3)
 *   - retry cap 超過 → `failed` 固定 + audit log (SEC HIGH-1)
 *   - active queue job 残存 → スキップ
 *   - back-pressure 超過 → スキップ（次 tick で再評価）
 *   - 上記以外 → CAS で `queued` 遷移 + retry count +1 + 全 7 カテゴリ enqueue
 *
 * Section B: Reconcile skipped_*-origin rows (v0.4.0 PR7b / ADR-0008 #6).
 *
 * For each row:
 *   - 7-day TTL exceeded → pin to `failed` (LCC M-3)
 *   - Retry cap exceeded → pin to `failed` + audit log (SEC HIGH-1)
 *   - Active queue job remains → skip
 *   - Back-pressure exceeded → skip (re-evaluate next tick)
 *   - Otherwise → CAS to `queued` + retry count +1 + enqueue all 7 categories
 */
async function reconcileSkippedRows(args: {
  prisma: PrismaClient;
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  thresholdMs: number;
  batchLimit: number;
  dryRun: boolean;
  result: BackfillReconciliationResult;
}): Promise<void> {
  const { prisma, queue, thresholdMs, batchLimit, dryRun, result } = args;
  const candidates = await fetchStaleSkippedPages(prisma, thresholdMs, batchLimit);
  result.totalChecked += candidates.length;
  const ttlMs = DEFAULT_SKIP_RECOVERY_TTL_MS;

  for (const row of candidates) {
    try {
      const skippedAgeMs = Date.now() - row.skippedAt.getTime();

      // -- Step 1: 7-day TTL check (LCC M-3) --------------------------------
      // PR7b-convergence (TDA H-2): TTL pin ロジックは expireSkippedRowOverTTL
      // ヘルパーに抽出して `reconcileSkippedRows` の cyclomatic complexity を
      // 14 → ≤10 に収束させる。
      // PR7b-convergence (TDA H-2): TTL pin logic extracted into the
      // `expireSkippedRowOverTTL` helper to drive the host's cyclomatic
      // complexity down from 14 to ≤10.
      if (skippedAgeMs > ttlMs) {
        await expireSkippedRowOverTTL({
          prisma,
          row,
          skippedAgeMs,
          ttlMs,
          dryRun,
          result,
        });
        continue;
      }

      // -- Step 2: retry cap check (SEC HIGH-1) -----------------------------
      // PR7b-convergence (TDA H-2): 同上、retry cap pin ロジックを
      // `pinSkippedRowOverRetryCap` ヘルパーに抽出。
      if (row.retryCount >= SKIP_RECOVERY_RETRY_CAP) {
        await pinSkippedRowOverRetryCap({
          prisma,
          row,
          dryRun,
          result,
        });
        continue;
      }

      // -- Step 3: active queue job check -----------------------------------
      const queueActive = await hasActiveQueueJob(queue, row.id);
      if (queueActive) {
        continue;
      }
      result.staleDetected += 1;

      // -- Step 4: back-pressure check (SEC HIGH-2) -------------------------
      const backPressure = await checkBackfillQueueBackPressure(queue);
      if (!backPressure.allowEnqueue) {
        logger.warn(
          "[BackfillReconciliation] Back-pressure exceeded; skipping skip recovery this tick",
          {
            webPageId: row.id.slice(0, 8) + "...",
            waitingCount: backPressure.waitingCount,
          }
        );
        continue;
      }

      // -- Step 5: dry-run preview ------------------------------------------
      if (dryRun) {
        logger.info("[BackfillReconciliation] [dry-run] Would re-enqueue skipped_* page", {
          webPageId: row.id.slice(0, 8) + "...",
          status: row.status,
          retryCount: row.retryCount,
          screenshotPresent: row.screenshotStoragePath !== null,
        });
        continue;
      }

      // -- Step 6: CAS guard — skipped_* → queued + retry count +1 ---------
      const reEnqueued = await prisma.webPage.updateMany({
        where: {
          id: row.id,
          embeddingBackfillStatus: { in: ["skipped_fork_error", "skipped_memory_pressure"] },
        },
        data: {
          embeddingBackfillStatus: "queued",
          embeddingBackfillStartedAt: new Date(),
          embeddingBackfillRetryCount: { increment: 1 },
        },
      });
      if (reEnqueued.count === 0) {
        result.concurrentUpdatesSkipped += 1;
        logger.info(
          "[BackfillReconciliation] skipped_* status changed concurrently — skipping recovery",
          {
            webPageId: row.id.slice(0, 8) + "...",
          }
        );
        continue;
      }

      // -- Step 7: enqueue all 7 categories ---------------------------------
      // PR7b-convergence (TDA H-1 / H-2 / M-2): ヘルパーに集約。
      // Worker (page-analyze-worker.ts) と共通ロジック化し `reconcileSkippedRows` の
      // 複雑度を 14 → ≤10 に収束。
      //
      // PR7b-convergence (TDA H-1 / H-2 / M-2): Consolidated into the shared helper.
      // Shared with Worker (page-analyze-worker.ts) and drives
      // `reconcileSkippedRows` complexity from 14 to ≤10.
      const initialDelayMs =
        row.status === "skipped_memory_pressure" ? resolveMemoryPressureDelayMs() : 0;
      const { enqueued: enqueuedCategories, failed: failedCategories } =
        await enqueueAllCategoriesForSkipRecovery(queue, {
          webPageId: row.id,
          screenshotStoragePath: row.screenshotStoragePath ?? undefined,
          initialDelayMs,
          source: "cron",
        });

      result.skipRecoveryEnqueued += 1;
      result.remediated += 1;
      logger.info("[BackfillReconciliation] Re-enqueued skipped_* page for recovery", {
        webPageId: row.id.slice(0, 8) + "...",
        status: row.status,
        retryCountAfter: row.retryCount + 1,
        enqueuedCategories,
        failedCategories,
        initialDelayMs,
      });
    } catch (error) {
      result.errors += 1;
      logger.warn("[BackfillReconciliation] Failed to reconcile skipped_* page (non-fatal)", {
        webPageId: row.id.slice(0, 8) + "...",
        error: sanitizeErrorMessage(error),
      });
    }
  }
}
