// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Stall Recovery Service
 *
 * BullMQジョブのstall検出不能問題に対する回復メカニズム。
 *
 * 問題の背景:
 * - ワーカーがNarrative/Embedding処理中（progress 90%）に再起動されると、
 *   ジョブがBullMQ上でactive状態のまま孤立する
 * - lockDuration=2400000ms (40分) 経過後もstall detectionが機能しない場合がある
 * - ジョブが永久にactive状態で残り、新しいワーカーが取得しない
 *
 * 解決策:
 * 1. ワーカー起動時にorphaned active jobsを検出
 * 2. BullMQ stalled イベント発火時に即座にカスタム回復を実行
 * 3. 定期的なstallチェック（10分間隔）で取りこぼしを回復
 * 4. カテゴリ分類（DB保存済み/処理中断/未開始）に基づく回復アクション
 * 5. DB保存済みジョブはcompleted/failedに遷移させる
 *
 * @module services/worker-stall-recovery
 */

import { logger } from '../utils/logger';
import {
  isOrphanedByLockExpiry,
  categorizeByProgress,
  type OrphanedJobCategory as OrphanedJobCategoryFromUtils,
} from './orphaned-job-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Orphaned job の分類（orphaned-job-utils.ts からの re-export）
 *
 * - db_saved_but_stuck: DB保存済みだがBullMQがactive（progress >= 90%）
 * - processing_interrupted: 処理中に中断（progress > 0 && < 90%）
 * - never_started: 処理が開始されていない（progress = 0, processedOn未設定）
 */
export type OrphanedJobCategory = OrphanedJobCategoryFromUtils;

/**
 * Orphaned job の情報（BullMQ Jobから抽出）
 */
export interface OrphanedJobInfo {
  /** BullMQ Job ID */
  jobId: string;
  /** BullMQ Job state */
  state: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Processing start timestamp (ms since epoch) */
  processedOn: number | undefined;
  /** Lock duration configured for the worker (ms) */
  lockDurationMs: number;
  /** Job data subset needed for recovery decisions */
  data: {
    webPageId: string;
    url: string;
  };
}

/**
 * Orphaned job 回復結果
 */
export interface RecoveryResult {
  /** 回復が成功したか */
  success: boolean;
  /** 回復されたジョブ数 */
  recoveredCount: number;
  /** 回復に失敗したジョブ数 */
  failedCount: number;
  /** 個別の回復結果 */
  details: Array<{
    jobId: string;
    category: OrphanedJobCategory;
    action: 'moved_to_failed' | 'moved_to_waiting' | 'completed' | 'skipped';
    error?: string;
  }>;
}

/**
 * Stalled job の回復結果（単一ジョブ用）
 */
export interface StalledJobRecoveryResult {
  /** 回復が成功したか */
  success: boolean;
  /** ジョブID */
  jobId: string;
  /** ジョブのカテゴリ（判定可能な場合） */
  category: OrphanedJobCategory | null;
  /** 実行されたアクション */
  action: 'moved_to_failed' | 'completed' | 'skipped' | 'not_found';
  /** エラーメッセージ（失敗時） */
  error?: string;
}

/**
 * BullMQ Job の操作インターフェース（stalled handler DI用）
 *
 * BullMQ Job インスタンスから必要な操作を抽出する。
 * テスト時にはモックとして提供する。
 */
export interface StalledJobAccessor {
  /** ジョブIDからジョブ情報を取得する。ジョブが見つからない場合はnull */
  getJob: (jobId: string) => Promise<{
    id: string;
    progress: number;
    processedOn: number | undefined;
    data: { webPageId: string; url: string };
    moveToFailed: (err: Error, token: string, fetchNext?: boolean) => Promise<void>;
    moveToCompleted: (returnValue: unknown, token: string, fetchNext?: boolean) => Promise<void>;
    getState: () => Promise<string>;
  } | null>;
}

/**
 * 定期的stall checkの設定
 */
export interface PeriodicStallCheckConfig {
  /** チェック間隔（ms）。デフォルト: 600000 (10分) */
  intervalMs?: number;
  /** lockDuration（ms） */
  lockDurationMs: number;
}

/** デフォルトの定期チェック間隔: 10分 */
export const DEFAULT_PERIODIC_CHECK_INTERVAL_MS = 600_000;

// ============================================================================
// Functions
// ============================================================================

/**
 * ジョブがorphaned active jobかどうかを判定する
 *
 * 共通ユーティリティ isOrphanedByLockExpiry に委譲する。
 * BullMQ Jobの詳細情報（state, lockDurationMs）を使用した判定。
 *
 * @param jobInfo - ジョブ情報
 * @returns orphanedであればtrue
 */
export function isOrphanedActiveJob(jobInfo: OrphanedJobInfo): boolean {
  return isOrphanedByLockExpiry(jobInfo.state, jobInfo.processedOn, jobInfo.lockDurationMs);
}

/**
 * Orphaned jobのカテゴリを分類する
 *
 * categorizeByProgress に委譲する。OrphanedJobInfo 構造体を受け取る
 * 高レベルラッパー。recoverOrphanedJobs から使用される。
 *
 * カテゴリに基づいて回復アクションを決定する:
 * - db_saved_but_stuck: completedに遷移（DB保存済みデータが利用可能）
 * - processing_interrupted: failedに遷移して再実行可能にする
 * - never_started: waitingに戻して再処理
 *
 * @param jobInfo - ジョブ情報
 * @returns カテゴリ
 */
export function categorizeOrphanedJob(jobInfo: OrphanedJobInfo): OrphanedJobCategory {
  return categorizeByProgress(jobInfo.progress, jobInfo.processedOn);
}

/**
 * Orphaned active jobsを検出して回復する
 *
 * ワーカー起動時に呼び出され、前回のワーカー停止で孤立したジョブを処理する。
 * BullMQ Queue APIを使用してactive状態のジョブを走査し、
 * lockDurationを超過しているものを回復する。
 *
 * @param getActiveJobs - active状態のジョブを取得する関数（DI）
 * @param moveToFailed - ジョブをfailedに移動する関数（DI）
 * @param moveToCompleted - ジョブをcompletedに移動する関数（DI）
 * @param lockDurationMs - ワーカーのlockDuration設定（ms）
 * @returns 回復結果
 */
export async function recoverOrphanedJobs(
  getActiveJobs: () => Promise<OrphanedJobInfo[]>,
  moveToFailed: (jobId: string, reason: string) => Promise<void>,
  moveToCompleted: (jobId: string) => Promise<void>,
  lockDurationMs: number
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    success: true,
    recoveredCount: 0,
    failedCount: 0,
    details: [],
  };

  try {
    const activeJobs = await getActiveJobs();

    logger.info('[StallRecovery] Checking for orphaned active jobs', {
      activeJobCount: activeJobs.length,
      lockDurationMs,
    });

    for (const jobInfo of activeJobs) {
      if (!isOrphanedActiveJob(jobInfo)) {
        continue;
      }

      const category = categorizeOrphanedJob(jobInfo);

      logger.warn('[StallRecovery] Orphaned job detected', {
        jobId: jobInfo.jobId,
        category,
        progress: jobInfo.progress,
        processedOn: jobInfo.processedOn,
        url: jobInfo.data.url,
        webPageId: jobInfo.data.webPageId,
      });

      try {
        switch (category) {
          case 'db_saved_but_stuck': {
            // DB保存済み: completedに遷移
            await moveToCompleted(jobInfo.jobId);
            result.details.push({
              jobId: jobInfo.jobId,
              category,
              action: 'completed',
            });
            result.recoveredCount++;
            break;
          }

          case 'processing_interrupted': {
            // 処理中断: failedに遷移（再実行可能）
            await moveToFailed(
              jobInfo.jobId,
              `Worker restarted during processing (progress: ${jobInfo.progress}%). Job was orphaned and recovered by stall recovery.`
            );
            result.details.push({
              jobId: jobInfo.jobId,
              category,
              action: 'moved_to_failed',
            });
            result.recoveredCount++;
            break;
          }

          case 'never_started': {
            // 未開始: failedに遷移（ユーザーが再試行を判断）
            await moveToFailed(
              jobInfo.jobId,
              'Worker restarted before processing started. Job was orphaned and recovered by stall recovery.'
            );
            result.details.push({
              jobId: jobInfo.jobId,
              category,
              action: 'moved_to_failed',
            });
            result.recoveredCount++;
            break;
          }
        }
      } catch (recoveryError) {
        const errorMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        logger.error('[StallRecovery] Failed to recover orphaned job', {
          jobId: jobInfo.jobId,
          category,
          error: errorMessage,
        });
        result.details.push({
          jobId: jobInfo.jobId,
          category,
          action: 'skipped',
          error: errorMessage,
        });
        result.failedCount++;
      }
    }

    if (result.recoveredCount > 0 || result.failedCount > 0) {
      logger.info('[StallRecovery] Recovery complete', {
        recoveredCount: result.recoveredCount,
        failedCount: result.failedCount,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[StallRecovery] Recovery process failed', {
      error: errorMessage,
    });
    result.success = false;
  }

  return result;
}

// ============================================================================
// Single Stalled Job Handler (BullMQ stalled event 用)
// ============================================================================

/**
 * BullMQ stalled イベントで発火する単一ジョブ回復ハンドラー
 *
 * BullMQ Worker.on('stalled', jobId) から呼ばれ、stalledジョブを
 * progressに基づいて completed または failed に遷移させる。
 *
 * BullMQ の stalled イベントは、ジョブのロックが既に失効した状態で発火する。
 * この時点でジョブは再び waiting に戻されるか、maxStalledCount 超過で
 * failed に移動される。本ハンドラーは BullMQ の内部処理「後」に追加の
 * 回復アクション（DB保存済みジョブの完了遷移等）を行う。
 *
 * @param jobId - stalled となったジョブのID
 * @param accessor - ジョブ操作のDI
 * @returns 回復結果
 */
export async function handleStalledJob(
  jobId: string,
  accessor: StalledJobAccessor,
): Promise<StalledJobRecoveryResult> {
  logger.warn('[StallRecovery] Handling stalled job event', { jobId });

  try {
    const job = await accessor.getJob(jobId);

    if (!job) {
      logger.warn('[StallRecovery] Stalled job not found (already removed or completed)', { jobId });
      return {
        success: true,
        jobId,
        category: null,
        action: 'not_found',
      };
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    logger.info('[StallRecovery] Stalled job state', {
      jobId,
      state,
      progress,
      processedOn: job.processedOn,
      url: job.data.url,
      webPageId: job.data.webPageId,
    });

    // BullMQ may have already moved the job to failed (maxStalledCount exceeded)
    // or back to waiting (stall retry). Only act on active/waiting jobs.
    if (state === 'completed') {
      return {
        success: true,
        jobId,
        category: null,
        action: 'skipped',
      };
    }

    // Determine category based on progress
    const category = categorizeByProgress(progress, job.processedOn);

    if (category === 'db_saved_but_stuck') {
      // DB保存済み: completedに遷移
      // token '0' は orphaned (lock-expired) ジョブの遷移に使用する慣例
      logger.info('[StallRecovery] Moving DB-saved stalled job to completed', {
        jobId,
        progress,
        webPageId: job.data.webPageId,
      });
      await job.moveToCompleted(
        {
          webPageId: job.data.webPageId,
          success: true,
          partialSuccess: true,
          completedPhases: [],
          failedPhases: [],
          processingTimeMs: 0,
          completedAt: new Date().toISOString(),
        },
        '0',
        false,
      );
      return {
        success: true,
        jobId,
        category,
        action: 'completed',
      };
    }

    // For processing_interrupted and never_started:
    // BullMQ's built-in stall handler already moves to failed after maxStalledCount.
    // If the job is still active/waiting, force it to failed for visibility.
    if (state === 'active' || state === 'waiting') {
      const reason = category === 'processing_interrupted'
        ? `worker_restart_during_processing (progress: ${progress}%)`
        : 'worker_restart_before_processing';
      logger.info('[StallRecovery] Moving stalled job to failed', {
        jobId,
        category,
        progress,
        reason,
      });
      await job.moveToFailed(
        new Error(`Stall recovery: ${reason}`),
        '0',
        false,
      );
      return {
        success: true,
        jobId,
        category,
        action: 'moved_to_failed',
      };
    }

    // Job is already in failed/delayed state — no action needed
    return {
      success: true,
      jobId,
      category,
      action: 'skipped',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[StallRecovery] Failed to handle stalled job', {
      jobId,
      error: errorMessage,
    });
    return {
      success: false,
      jobId,
      category: null,
      action: 'skipped',
      error: errorMessage,
    };
  }
}

// ============================================================================
// Periodic Stall Check
// ============================================================================

/**
 * 定期的なstallチェックを開始する
 *
 * BullMQの内蔵stall検出に依存せず、独立した間隔でorphaned jobsを検出・回復する。
 * CPU-bound処理（ONNX推論）がイベントループをブロックし、BullMQのstalledInterval
 * タイマーが発火しない場合のセーフティネット。
 *
 * @param getActiveJobs - active状態のジョブを取得する関数（DI）
 * @param moveToFailed - ジョブをfailedに移動する関数（DI）
 * @param moveToCompleted - ジョブをcompletedに移動する関数（DI）
 * @param config - 定期チェック設定
 * @returns タイマーを停止するcleanup関数
 */
export function createPeriodicStallCheck(
  getActiveJobs: () => Promise<OrphanedJobInfo[]>,
  moveToFailed: (jobId: string, reason: string) => Promise<void>,
  moveToCompleted: (jobId: string) => Promise<void>,
  config: PeriodicStallCheckConfig,
): { stop: () => void } {
  const intervalMs = config.intervalMs ?? DEFAULT_PERIODIC_CHECK_INTERVAL_MS;

  logger.info('[StallRecovery] Starting periodic stall check', {
    intervalMs,
    lockDurationMs: config.lockDurationMs,
  });

  const timerId = setInterval(() => {
    recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, config.lockDurationMs)
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('[StallRecovery] Periodic stall check failed', { error: errorMessage });
      });
  }, intervalMs);

  // unref() so the timer doesn't prevent process exit
  timerId.unref();

  return {
    stop: (): void => {
      clearInterval(timerId);
      logger.info('[StallRecovery] Periodic stall check stopped');
    },
  };
}

