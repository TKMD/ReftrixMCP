// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 Cleanup Cron — Periodic removal of stale Phase 0-failed web_pages rows
 *
 * PR-B (v0.4.0 PR7e P4 / LCC-M3-03): `PHASE0_EARLY_INSERT=true` により Phase 0
 * 早期 INSERT された `web_pages` 行のうち、robots.txt / SSRF / DNS fail 等で
 * Phase 0 層で失敗した (`analysisStatus='failed'` + `lastAnalyzedPhase IS NULL`)
 * 行を TTL ベース (default 7日) で定期削除する。
 *
 * PR-B (v0.4.0 PR7e P4 / LCC-M3-03): Periodically deletes `web_pages` rows
 * inserted by Phase 0 Early INSERT (`PHASE0_EARLY_INSERT=true`) that failed at
 * the Phase 0 layer (robots.txt / SSRF / DNS failure, etc.) — identified by
 * `analysisStatus='failed'` + `lastAnalyzedPhase IS NULL`. TTL default: 7 days.
 *
 * ## 設計判断 / Design decisions
 *
 *   - BullMQ Repeatable Job ではなく setInterval を採用
 *     → (retired) screenshot-cleanup-cron.ts と同じパターンを踏襲していた
 *       (screenshot TTL cron は PR-SS-B / ADR-0041 で撤去済)
 *     → cleanup は DB 操作のみ (Redis 不要) で本体 worker と同プロセスで問題ない
 *   - We use setInterval rather than BullMQ Repeatable Job. This mirrored the
 *     (retired) screenshot-cleanup-cron.ts pattern (the screenshot TTL cron was
 *     removed in PR-SS-B / ADR-0041) since the cleanup only touches DB (no Redis)
 *     and piggybacks on the existing worker process.
 *
 * @module cron/phase0-cleanup-cron
 */

import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import type { IPhase0CleanupService } from "../services/phase0-cleanup.service";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_BATCH_SIZE = 1000;

/**
 * Options for {@link schedulePhase0CleanupCron}.
 */
export interface SchedulePhase0CleanupCronOptions {
  /** Cleanup サービスインスタンス (DI friendly) / Cleanup service instance */
  service: IPhase0CleanupService;
  /** cron 発火間隔 (ms)、デフォルト 24 時間 / cron interval (ms), default 24h */
  intervalMs?: number;
  /** 削除対象の年齢 (ms)、デフォルト 7 日 / retention age (ms), default 7d */
  olderThanMs?: number;
  /** 1 回あたり最大削除件数、デフォルト 1000 / max per invocation, default 1000 */
  maxBatchSize?: number;
  /** 起動直後にも 1 回実行するか / Whether to fire once immediately on start */
  runOnStart?: boolean;
}

/**
 * Cron handle returned by {@link schedulePhase0CleanupCron}.
 */
export interface Phase0CleanupCronHandle {
  /** Stop the cron and release timer / cron を停止しタイマーを解放 */
  stop: () => void;
}

/**
 * Schedule a periodic Phase 0 cleanup cron.
 *
 * 呼び出し側 (`start-workers.ts`) は戻り値の `stop()` を Worker 終了時に呼ぶ。
 * Callers retain the handle and invoke `stop()` on worker shutdown.
 */
export function schedulePhase0CleanupCron(
  options: SchedulePhase0CleanupCronOptions
): Phase0CleanupCronHandle {
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
    if (inFlight) {
      logger.info("[Phase0CleanupCron] Previous run still in flight; skipping this tick");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      const deleted = await options.service.cleanupStaleFailedRows(olderThanMs, {
        maxBatchSize,
      });
      logger.info("[Phase0CleanupCron] Cleanup complete", {
        deletedCount: deleted,
        olderThanMs,
        maxBatchSize,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("[Phase0CleanupCron] Cleanup failed (non-fatal)", {
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

  logger.info("[Phase0CleanupCron] Scheduled", {
    intervalMs,
    olderThanMs,
    maxBatchSize,
    runOnStart,
  });

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      logger.info("[Phase0CleanupCron] Stopped");
    },
  };
}

/**
 * Defensive numeric validation — NaN/非正値はデフォルトへフォールバック (silent-fallback セマンティクス)。
 * Defensive numeric validation — NaN/non-positive values fall back to default (silent-fallback semantics).
 *
 * **負値/NaN/Infinity 挙動の層別契約 / Per-layer negative-value semantics (FIND-PR-B-010)**:
 * - **Cron layer (本関数 / this function)**: warn + fallback (silent-fallback)。
 *   env var 由来の設定ミス (`PHASE0_CLEANUP_OLDER_THAN_MS=-1` 等) を許容し、
 *   cron 全体が停止しないよう operational resilience を優先する。
 *   Tolerates env-var misconfiguration (e.g., `PHASE0_CLEANUP_OLDER_THAN_MS=-1`)
 *   to prevent total cron shutdown; prioritizes operational resilience.
 * - **Service layer (`phase0-cleanup.service.ts::cleanupStaleFailedRows`)**: **throw** (fail-fast)。
 *   programmatic caller 前提、不正値は bug として即時エラー。
 *   Assumes programmatic callers; invalid values are bugs and throw immediately.
 *
 * この層別契約は意図的なもの。cron は env var から取得した値を `validatePositive` で
 * 正規化した上で service に渡すため、通常 service 層に負値が到達することはない。
 * This layered contract is intentional. Cron normalizes env-var values via
 * `validatePositive` before passing them to the service, so negative values
 * normally do not reach the service layer.
 */
function validatePositive(value: number, label: string, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn("[Phase0CleanupCron] Invalid option; falling back to default", {
      label,
      received: value,
      fallback,
    });
    return fallback;
  }
  return Math.floor(value);
}
