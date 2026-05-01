// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Reconciliation Cron — Periodic Stale `in_progress` Cleanup
 *
 * v0.4.0 PR6: `reconcileStaleBackfillJobs` を setInterval で定期駆動する。
 * PR5 の CLI は運用者手動実行専用として残しつつ、本 cron が自動回復を担う。
 *
 * v0.4.0 PR6: Periodically drives `reconcileStaleBackfillJobs` via setInterval.
 * The PR5 CLI remains for manual operator use while this cron handles automatic
 * recovery.
 *
 * 設計判断 / Design decisions:
 *   - setInterval + concurrency=1（前回完了前は次回 tick を skip）で BullMQ
 *     Queue 自体への操作と worker への影響を最小化。
 *   - setInterval with concurrency=1 (skip tick if previous run still pending)
 *     minimizes impact on the BullMQ queue and workers.
 *   - 実 update は service 内部 (`updateMany` CAS) で排他制御するため、cron が
 *     worker と同時に走っても安全。
 *   - Real updates use service-internal `updateMany` CAS; the cron is safe to
 *     run alongside workers.
 *
 * @module cron/backfill-reconciliation-cron
 */

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  reconcileStaleBackfillJobs,
  type BackfillReconciliationResult,
} from "../services/backfill-reconciliation.service";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../queues/embedding-backfill-queue";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

/**
 * Item 2 / CO-30 closure: cron polling cadence 1h → 5min.
 *
 * Embedding-backfill worker per-job aggregate UPDATE
 * (`embedding-backfill-worker.ts:661 await updateEmbeddingBackfillStatus(webPageId, remainingStatus)`)
 * が late-arrive または drop した場合の reconciliation polling cadence を 1h → 5min に高頻度化。
 * `staleThresholdMs` (default 1h, `fetchStaleInProgressPages`) は worker-side
 * late-arrive race 回避のため immutable per IO Plan Decision option (b)。
 *
 * Effective reconciliation upper bound = max(staleThresholdMs, intervalMs)
 *                                      = max(1h, 5min) = 1h + 5min worst-tail
 * Realized improvement: ~12% reduction in worst-tail lag (was [1h, 2h], now [1h, 1h+5min])
 *
 * Note: True 12x SLO improvement requires `staleThresholdMs` reduction (1h → 5min),
 *       deferred to CO-30-FOLLOWUP M 2026-Q4 (combined Option B + staleThresholdMs PR).
 *
 * Item 2 / CO-30 closure: reduces cron polling cadence from 1h to 5min. Catches
 * late-arriving or dropped per-job aggregate UPDATEs from the embedding-backfill
 * worker (`embedding-backfill-worker.ts:661`). `staleThresholdMs` (default 1h,
 * `fetchStaleInProgressPages`) is unchanged per IO Plan Decision option (b) to
 * avoid racing with late-arriving worker-side UPDATEs. Effective reconciliation
 * upper bound = max(staleThresholdMs=1h, intervalMs=5min) = 1h+5min worst-tail
 * (~12% reduction in worst-tail lag, NOT 12x improvement). True 12x SLO
 * improvement requires `staleThresholdMs` reduction, deferred to
 * CO-30-FOLLOWUP M 2026-Q4.
 *
 * `inFlight` skip-tick backpressure (see `runOnce` below) prevents tick piling
 * when a previous sweep is still in flight (TPA-03 advisory; pre-existing
 * mechanism, retained at higher cadence for spike protection).
 *
 * Cross-ref: PR-E-1 finding registry §1.3 CO-30 (closed by Item 2);
 *            Item 2 finding registry §1.3.2 (self carryover CO-30-FOLLOWUP);
 *            DATA_RETENTION.md §11.9 + §11.9.6.bis (cadence ↔ staleThresholdMs
 *            orthogonality);
 *            ADR-0008 (Skip Recovery / 7d TTL); ADR-0011 (Worker Dual-run Lock).
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (Item 2 / CO-30 closure)
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour (immutable per IO Plan Decision option (b))
const DEFAULT_BATCH_LIMIT = 500;

/**
 * Options for {@link scheduleBackfillReconciliationCron}.
 */
export interface ScheduleBackfillReconciliationCronOptions {
  /** Prisma client instance / Prisma クライアント */
  prisma: PrismaClient;
  /** BullMQ embedding-backfill queue / BullMQ embedding-backfill キュー */
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /** cron 発火間隔 (ms)、デフォルト 5 分 (Item 2 / CO-30 closure) / cron interval (ms), default 5min */
  intervalMs?: number;
  /** stale 判定しきい値 (ms)、デフォルト 1 時間 / stale threshold (ms), default 1h */
  staleThresholdMs?: number;
  /** 1 回で処理する最大行数 / max rows per invocation */
  batchLimit?: number;
  /**
   * 起動直後にも 1 回実行するか（デフォルト false）。
   * Whether to fire once immediately on start (default false).
   */
  runOnStart?: boolean;
}

/**
 * Cron handle returned by {@link scheduleBackfillReconciliationCron}.
 */
export interface BackfillReconciliationCronHandle {
  /** Stop the cron and release timer / cron を停止しタイマーを解放 */
  stop: () => void;
}

/**
 * Schedule a periodic reconciliation sweep.
 *
 * 呼び出し側（`start-workers.ts`）は戻り値を保持し、Worker 終了時に `stop()` を呼ぶ。
 *
 * Callers (`start-workers.ts`) retain the returned handle and invoke `stop()`
 * on worker shutdown.
 */
export function scheduleBackfillReconciliationCron(
  options: ScheduleBackfillReconciliationCronOptions
): BackfillReconciliationCronHandle {
  const intervalMs = validatePositive(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    "intervalMs",
    DEFAULT_INTERVAL_MS
  );
  const staleThresholdMs = validatePositive(
    options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
    "staleThresholdMs",
    DEFAULT_STALE_THRESHOLD_MS
  );
  const batchLimit = validatePositive(
    options.batchLimit ?? DEFAULT_BATCH_LIMIT,
    "batchLimit",
    DEFAULT_BATCH_LIMIT
  );
  const runOnStart = options.runOnStart ?? false;

  let stopped = false;
  let inFlight = false;

  const runOnce = async (): Promise<void> => {
    if (inFlight) {
      logger.info("[BackfillReconciliationCron] Previous run still in flight; skipping this tick");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
        prisma: options.prisma,
        queue: options.queue,
        staleThresholdMs,
        batchLimit,
      });
      logger.info("[BackfillReconciliationCron] Sweep complete", {
        ...result,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("[BackfillReconciliationCron] Sweep failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void runOnce();
  }, intervalMs);
  timer.unref();

  if (runOnStart) {
    void runOnce();
  }

  logger.info("[BackfillReconciliationCron] Scheduled", {
    intervalMs,
    staleThresholdMs,
    batchLimit,
    runOnStart,
  });

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      logger.info("[BackfillReconciliationCron] Stopped");
    },
  };
}

function validatePositive(value: number, label: string, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn("[BackfillReconciliationCron] Invalid option; falling back to default", {
      label,
      received: value,
      fallback,
    });
    return fallback;
  }
  return Math.floor(value);
}
