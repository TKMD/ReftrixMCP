// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot Retention Cron — 終端ページの screenshot を保持期限で失効させる定期実行
 *
 * `runRetentionCycle` を setInterval で駆動する (sibling の phase0-cleanup-cron /
 * backfill-recovery-cron と同じ形)。保持日数は `REFTRIX_SCREENSHOT_RETENTION_DAYS`
 * (既定 7、1..30)。
 *
 * 二重実行の扱い: backfill worker は数ジョブごとに計画的に再起動するため、24h 間隔の
 * 起動待ちでは発火しない。そこで `runOnStart` を既定で true にし、周期は 1h とする
 * (対象が無ければ 1 SELECT で終わる)。同じプロセス内の重なりは `inFlight` で防ぎ、
 * プロセスをまたぐ重なり (再起動の合間) は service 側の行ロック
 * (`FOR UPDATE SKIP LOCKED` + 適格条件の再確認 + path の CAS) が防ぐので、同じ行を
 * 2 つの run が消すことはない。dual-run lock (`WorkerActiveLockService`) は worker 全体の
 * 排他であり、ここでは追加の lock を取らない (sibling cron と同じ)。
 *
 * 運用スイッチ: `REFTRIX_SCREENSHOT_RETENTION_CRON_DRY_RUN=true` は、定期実行の削除を止める
 * **唯一の方法**。件数をログに出すだけで何も消さず、設定されている間は保持期限は満たされない。
 * そのため cycle のたびに全環境で warn を出す (見えない無効化にしない)。ロールアウトの確認用で、
 * 確認が済んだら外すこと。
 * 設定ミス: `REFTRIX_SCREENSHOT_RETENTION_DAYS` が不正 (非整数・0 以下) のときは schedule せず
 * error log を出す (既定値へ黙って戻さない)。30 超は 30 に丸める (warn)。
 *
 * Periodic driver of the screenshot retention cycle. The backfill worker restarts every few
 * jobs, so a 24h wait would never fire: `runOnStart` defaults to true with a 1h cadence (an
 * empty run is one SELECT). In-process overlap is stopped by `inFlight`; cross-process overlap
 * (between restarts) is stopped by the service's row lock (`FOR UPDATE SKIP LOCKED`, eligibility
 * re-check, path CAS), so no row is expired twice. No extra lock, like the sibling crons.
 * `REFTRIX_SCREENSHOT_RETENTION_CRON_DRY_RUN=true` is the ONE way to pause the scheduled
 * deletion: it only counts, and while it is set the retention period is NOT met. So every cycle
 * logs a warning in all environments (never an invisible switch-off). It is a rollout aid;
 * remove it once the check is done. An invalid `REFTRIX_SCREENSHOT_RETENTION_DAYS` (non-integer,
 * 0 or less) means the cron is not scheduled and an error is logged (no silent fallback); a
 * value above 30 is clamped to 30 with a warning.
 *
 * @module cron/screenshot-retention-cron
 */

import { parseBoolEnv, parseBoundedIntEnv } from "../utils/env-validators";
import { logger } from "../utils/logger";
import {
  ScreenshotRetentionConfigError,
  getScreenshotRetentionDays,
  type IScreenshotRetentionService,
} from "../services/screenshot-retention.service";

/** 周期 (ms) の env 名 / interval env var */
export const SCREENSHOT_RETENTION_INTERVAL_ENV = "REFTRIX_SCREENSHOT_RETENTION_INTERVAL_MS";
/** dry-run スイッチの env 名 / dry-run switch env var */
export const SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV = "REFTRIX_SCREENSHOT_RETENTION_CRON_DRY_RUN";
/** 既定の周期: 1h / default interval */
export const SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** 周期の下限: 5min (CWE-770) / lower bound */
export const SCREENSHOT_RETENTION_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** 周期の上限: 24h / upper bound */
export const SCREENSHOT_RETENTION_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ScheduleScreenshotRetentionCronOptions {
  service: IScreenshotRetentionService;
  /** 周期を直接指定 (テスト用)。未指定なら env / override interval (tests); env otherwise */
  intervalMs?: number;
  /** 起動直後にも 1 回実行するか (既定 true) / fire once on start (default true) */
  runOnStart?: boolean;
  /** env を読み替える (テスト用) / env source (tests) */
  env?: Record<string, string | undefined>;
}

export interface ScreenshotRetentionCronHandle {
  /** false: 設定ミスで schedule していない / false: not scheduled because of a configuration error */
  scheduled: boolean;
  stop: () => void;
  /** 手動 1 回実行 (テスト用) / manual one-shot (tests) */
  runOnce: () => Promise<void>;
}

/** 不正な env は既定値に戻して warn (保持を止めない) / invalid env falls back with a warning */
export function resolveRetentionIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env[SCREENSHOT_RETENTION_INTERVAL_ENV];
  try {
    return parseBoundedIntEnv(
      raw,
      SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS,
      SCREENSHOT_RETENTION_MIN_INTERVAL_MS,
      SCREENSHOT_RETENTION_MAX_INTERVAL_MS,
      SCREENSHOT_RETENTION_INTERVAL_ENV
    );
  } catch {
    logger.warn("[ScreenshotRetentionCron] Invalid interval; using the default", {
      envVar: SCREENSHOT_RETENTION_INTERVAL_ENV,
      rawValue: JSON.stringify(String(raw).slice(0, 32)),
      defaultMs: SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS,
    });
    return SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS;
  }
}

/** 不正な値は false (= 通常どおり失効させる) に倒して warn / invalid value => enforce, with a warning */
export function resolveRetentionCronDryRun(env: Record<string, string | undefined>): boolean {
  try {
    return parseBoolEnv(env[SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV], false);
  } catch {
    logger.warn("[ScreenshotRetentionCron] Invalid dry-run switch; retention stays enforced", {
      envVar: SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV,
    });
    return false;
  }
}

export function scheduleScreenshotRetentionCron(
  options: ScheduleScreenshotRetentionCronOptions
): ScreenshotRetentionCronHandle {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? resolveRetentionIntervalMs(env);
  const dryRun = resolveRetentionCronDryRun(env);
  const runOnStart = options.runOnStart ?? true;

  let retentionDays: number;
  try {
    retentionDays = getScreenshotRetentionDays(env);
  } catch (error) {
    if (!(error instanceof ScreenshotRetentionConfigError)) throw error;
    logger.error(
      "[ScreenshotRetentionCron] Not scheduled: invalid retention days; screenshots are NOT being expired",
      { error: error.message }
    );
    return {
      scheduled: false,
      stop: (): void => undefined,
      runOnce: async (): Promise<void> => undefined,
    };
  }

  let stopped = false;
  let inFlight = false;

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      logger.info("[ScreenshotRetentionCron] Previous run still in flight; skipping this tick");
      return;
    }
    inFlight = true;
    try {
      if (dryRun) {
        logger.warn(
          "[ScreenshotRetentionCron] DRY-RUN is set: screenshots are NOT being deleted and the retention period is NOT met until REFTRIX_SCREENSHOT_RETENTION_CRON_DRY_RUN is removed",
          { envVar: SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV }
        );
      }
      const result = await options.service.runRetentionCycle({
        retentionDays,
        dryRun,
        shouldStop: () => stopped,
      });
      logger.info("[ScreenshotRetentionCron] Cycle complete", { ...result });
    } catch (error) {
      logger.warn("[ScreenshotRetentionCron] Cycle failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref();

  if (runOnStart) void runOnce();

  logger.info("[ScreenshotRetentionCron] Scheduled", {
    intervalMs,
    retentionDays,
    dryRun,
    runOnStart,
  });

  return {
    scheduled: true,
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      logger.info("[ScreenshotRetentionCron] Stopped");
    },
    runOnce,
  };
}
