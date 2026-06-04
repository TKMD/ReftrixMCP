// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Recovery Cron — Periodic auto-recovery for `failed_with_known_reason`
 *
 * Plan v3 T3-Backfill V1 §3.1 axis C / Wave 2 (NEW). `runRecoveryCycle` を
 * setInterval で定期駆動し、`web_pages.embeddingBackfillStatus =
 * 'failed_with_known_reason'` rows を 5min ごとに scan + per-reason recovery
 * dispatch する。
 *
 * Periodically drives `runRecoveryCycle` for `failed_with_known_reason`
 * rows via setInterval (default 5min).
 *
 * 設計判断 / Design decisions:
 *   - setInterval + concurrency=1 (overlap 防止) で BullMQ Queue 操作と
 *     worker への影響を最小化
 *   - 実 update は service 内部 (`updateMany` CAS) で排他制御するため、
 *     cron が worker と同時に走っても安全
 *   - `BACKFILL_RECOVERY_INTERVAL_MS` env で interval をオーバーライド可
 *     (Zod-bounded 30s-1h、default 5min)
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C
 * @see ADR-0007 Amendment 1 §A1.2.1 (C-1 winning contract)
 *
 * @module cron/backfill-recovery-cron
 */

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  runRecoveryCycle,
  isRecoveryReconciliationEnabled,
  BACKFILL_RECOVERY_DEFAULT_INTERVAL_MS,
  BACKFILL_RECOVERY_DEFAULT_BATCH_LIMIT,
  type BackfillRecoveryReconciliationResult,
} from "../services/backfill-recovery-reconciliation.service";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../queues/embedding-backfill-queue";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { parseBoundedIntEnv } from "../utils/env-validators";

/**
 * Plan v3 T3-Backfill V1 §3.1 axis C — minimum interval bound
 * (FIND-PLAN-SEC-T3B-04 M, CWE-770 budget overflow guard).
 */
const BACKFILL_RECOVERY_MIN_INTERVAL_MS = 30 * 1000; // 30s (per V1 §3.1 axis C)
/**
 * Maximum interval bound (1h — beyond this the SLO contract degrades).
 */
const BACKFILL_RECOVERY_MAX_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Options for {@link scheduleBackfillRecoveryCron}.
 */
export interface ScheduleBackfillRecoveryCronOptions {
  /** Prisma client instance / Prisma クライアント */
  prisma: PrismaClient;
  /** BullMQ embedding-backfill queue */
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /** cron 発火間隔 (ms)、デフォルト 5 分 / cron interval (ms), default 5min */
  intervalMs?: number;
  /** 1 回で処理する最大行数 / max rows per invocation */
  batchLimit?: number;
  /**
   * 起動直後にも 1 回実行するか (default false) / fire-once-on-start (default false)
   */
  runOnStart?: boolean;
}

/**
 * Cron handle returned by {@link scheduleBackfillRecoveryCron}.
 */
export interface BackfillRecoveryCronHandle {
  stop: () => void;
}

/**
 * Schedule the periodic backfill recovery cron.
 *
 * Returned `stop()` MUST be invoked at worker shutdown to release the timer.
 */
export function scheduleBackfillRecoveryCron(
  options: ScheduleBackfillRecoveryCronOptions
): BackfillRecoveryCronHandle {
  // Resolve interval via env override with Zod-bounded validation (CWE-770 guard).
  const intervalMs = parseBoundedIntEnv(
    process.env["BACKFILL_RECOVERY_INTERVAL_MS"],
    options.intervalMs ?? BACKFILL_RECOVERY_DEFAULT_INTERVAL_MS,
    BACKFILL_RECOVERY_MIN_INTERVAL_MS,
    BACKFILL_RECOVERY_MAX_INTERVAL_MS,
    "BACKFILL_RECOVERY_INTERVAL_MS"
  );
  const batchLimit = options.batchLimit ?? BACKFILL_RECOVERY_DEFAULT_BATCH_LIMIT;
  const runOnStart = options.runOnStart ?? false;

  let stopped = false;
  let inFlight = false;

  const runOnce = async (): Promise<void> => {
    if (inFlight) {
      logger.info("[BackfillRecoveryCron] Previous run still in flight; skipping this tick");
      return;
    }
    if (!isRecoveryReconciliationEnabled()) {
      logger.info("[BackfillRecoveryCron] Disabled via feature flag; skipping cycle");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      const result: BackfillRecoveryReconciliationResult = await runRecoveryCycle({
        prisma: options.prisma,
        queue: options.queue,
        batchLimit,
      });
      logger.info("[BackfillRecoveryCron] Cycle complete", {
        ...result,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("[BackfillRecoveryCron] Cycle failed (non-fatal)", {
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
  // Don't prevent the event loop from exiting on its own.
  timer.unref();

  if (runOnStart) {
    void runOnce();
  }

  logger.info("[BackfillRecoveryCron] Scheduled", {
    intervalMs,
    batchLimit,
    runOnStart,
  });

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      logger.info("[BackfillRecoveryCron] Stopped");
    },
  };
}
