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

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_BATCH_LIMIT = 500;

/**
 * Options for {@link scheduleBackfillReconciliationCron}.
 */
export interface ScheduleBackfillReconciliationCronOptions {
  /** Prisma client instance / Prisma クライアント */
  prisma: PrismaClient;
  /** BullMQ embedding-backfill queue / BullMQ embedding-backfill キュー */
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /** cron 発火間隔 (ms)、デフォルト 1 時間 / cron interval (ms), default 1h */
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
