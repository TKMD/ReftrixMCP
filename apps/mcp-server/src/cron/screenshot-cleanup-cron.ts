// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot TTL Cleanup Cron — Periodic Removal of Expired Screenshots
 *
 * v0.4.0 PR6: PR1 で永続化された screenshot を TTL ベースで定期削除する。
 * 既存の {@link IScreenshotPersistenceService.cleanupExpired} を setInterval
 * で駆動し、embedding backfill の想定最長リトライウィンドウ（7日）を超えた
 * ファイルを削除して DB の `screenshotStoragePath` も NULL 化する。
 *
 * v0.4.0 PR6: Periodically deletes screenshots persisted by PR1 based on TTL.
 * Drives {@link IScreenshotPersistenceService.cleanupExpired} via setInterval,
 * removing files older than the assumed maximum retry horizon for embedding
 * backfill (7 days) and NULLing the corresponding `screenshotStoragePath`.
 *
 * 設計判断 / Design decisions:
 *   - BullMQ Repeatable Job ではなく setInterval を採用
 *     → cleanup はファイルシステム+DB 操作のみ（Redis 不要）で、本体 worker と
 *       同プロセスで問題ない。専用 queue を作るコストが利益に見合わない。
 *   - We use setInterval rather than BullMQ Repeatable Job.
 *     Cleanup only touches filesystem + DB (no Redis needed) and piggybacks on
 *     the existing worker process, so a dedicated queue is unjustified cost.
 *
 * @module cron/screenshot-cleanup-cron
 */

import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import type { IScreenshotPersistenceService } from "../services/screenshot-persistence.service";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_BATCH_SIZE = 1000;

/**
 * Options for {@link scheduleScreenshotCleanupCron}.
 */
export interface ScheduleScreenshotCleanupCronOptions {
  /** Persistence service instance (DI friendly) / 注入する永続化サービス */
  service: IScreenshotPersistenceService;
  /** cron 発火間隔 (ms)、デフォルト 24 時間 / cron interval (ms), default 24h */
  intervalMs?: number;
  /** 削除対象の年齢 (ms)、デフォルト 7 日 / retention age (ms), default 7d */
  olderThanMs?: number;
  /** 1 回あたり最大削除件数、デフォルト 1000 / max per invocation, default 1000 */
  maxBatchSize?: number;
  /**
   * 起動直後にも 1 回実行するか（デフォルト false）。
   * cron 発火を待たずに初回実行するかの制御。
   *
   * Whether to fire once immediately on start (default false).
   * Controls initial execution before the first interval tick.
   */
  runOnStart?: boolean;
}

/**
 * Cron handle returned by {@link scheduleScreenshotCleanupCron}.
 */
export interface ScreenshotCleanupCronHandle {
  /** Stop the cron and release timer / cron を停止しタイマーを解放 */
  stop: () => void;
}

/**
 * Schedule a periodic screenshot TTL cleanup.
 *
 * 呼び出し側（`start-workers.ts`）は、この関数の戻り値を保持し、Worker 終了時に
 * `stop()` を呼ぶ。
 *
 * Callers (`start-workers.ts`) retain the returned handle and invoke `stop()`
 * on worker shutdown.
 */
export function scheduleScreenshotCleanupCron(
  options: ScheduleScreenshotCleanupCronOptions
): ScreenshotCleanupCronHandle {
  const intervalMs = validatePositive(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    "intervalMs",
    DEFAULT_INTERVAL_MS
  );
  const olderThanMs = validatePositive(
    options.olderThanMs ?? DEFAULT_OLDER_THAN_MS,
    "olderThanMs",
    DEFAULT_OLDER_THAN_MS
  );
  const maxBatchSize = validatePositive(
    options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    "maxBatchSize",
    DEFAULT_MAX_BATCH_SIZE
  );
  const runOnStart = options.runOnStart ?? false;

  let stopped = false;
  let inFlight = false;

  const runOnce = async (): Promise<void> => {
    // Overlap 防止: 前回実行が終わっていなければ skip（slow backend で雪崩を防ぐ）
    // Overlap prevention: skip if previous run still ongoing (avoids pile-up
    // with a slow backend).
    if (inFlight) {
      logger.info("[ScreenshotCleanupCron] Previous run still in flight; skipping this tick");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      const deleted = await options.service.cleanupExpired(olderThanMs, { maxBatchSize });
      logger.info("[ScreenshotCleanupCron] Cleanup complete", {
        deletedCount: deleted,
        olderThanMs,
        maxBatchSize,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("[ScreenshotCleanupCron] Cleanup failed (non-fatal)", {
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
  // Don't prevent the event loop from exiting on its own
  // Node タイマーがプロセス終了を阻害しないようにする
  timer.unref();

  if (runOnStart) {
    void runOnce();
  }

  logger.info("[ScreenshotCleanupCron] Scheduled", {
    intervalMs,
    olderThanMs,
    maxBatchSize,
    runOnStart,
  });

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      logger.info("[ScreenshotCleanupCron] Stopped");
    },
  };
}

/**
 * Defensive numeric validation — NaN/非正値はデフォルトへフォールバック。
 * Defensive numeric validation — NaN/non-positive values fall back to default.
 */
function validatePositive(value: number, label: string, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn("[ScreenshotCleanupCron] Invalid option; falling back to default", {
      label,
      received: value,
      fallback,
    });
    return fallback;
  }
  return Math.floor(value);
}
