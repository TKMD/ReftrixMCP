// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queue Cleanup Service
 *
 * バッチ投入前のキュー自動クリーンアップ機構。
 * 前回のorphaned job（stalled/failed/90% active）が残っていると
 * 新バッチが正常に処理されない問題を解決する。
 *
 * クリーンアップロジック:
 * 1. active job が 0件の場合: queue.obliterate({ force: true }) で全クリア
 * 2. active job が残っている場合: waiting/failed/delayed/completed のみクリア
 * 3. 全ステータスが0件の場合: スキップ
 *
 * Dependency Injection:
 * BullMQ Queue への直接依存を避けるため、QueueAdapter インターフェースを使用。
 * これによりテスト容易性と実装の分離を確保する。
 *
 * @module services/queue-cleanup
 */

import { logger } from '../utils/logger';
import type { Queue } from 'bullmq';
import { isOrphanedByElapsedTime, isDbSavedProgress } from './orphaned-job-utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Orphaned active job の判定閾値（デフォルト: 120分）
 *
 * processedOn が現在時刻からこの値以上前の active job は orphaned と判定する。
 * lockDuration=2400s (40分) に対して lockDuration x 3 = 120分 が適切。
 * 短すぎると処理中のジョブを誤って orphaned と判定するリスクがある。
 */
export const ORPHAN_THRESHOLD_MS = 7_200_000; // 120分

// ============================================================================
// Types
// ============================================================================

/**
 * active ジョブの詳細情報。orphaned 判定に使用する。
 */
export interface JobInfo {
  /** ジョブID */
  id: string;
  /** 処理開始タイムスタンプ（ms）。undefined の場合は orphaned と判定 */
  processedOn?: number;
  /** 進捗（0-100） */
  progress: number;
  /** ジョブを completed に移動 */
  moveToCompleted: (returnValue: unknown, token: string, fetchNext?: boolean) => Promise<void>;
  /** ジョブを failed に移動 */
  moveToFailed: (err: Error, token: string, fetchNext?: boolean) => Promise<void>;
}

/**
 * cleanupQueue のオプション
 */
export interface CleanupOptions {
  /** orphaned 判定の閾値（ms）。デフォルト: ORPHAN_THRESHOLD_MS (120分) */
  orphanThresholdMs?: number;
}

/**
 * BullMQ Queue からクリーンアップに必要なメソッドを抽出したアダプター。
 * テスト時にはモックとして提供する。
 */
export interface QueueAdapter {
  /** 各ステータスのジョブ数を取得 */
  getJobCounts: () => Promise<Record<string, number>>;
  /** キュー内の全ジョブを強制削除 */
  obliterate: (opts: { force: boolean }) => Promise<void>;
  /** 指定ステータスのジョブをクリーンアップ。grace=0で即時、limit=0で全件 */
  clean: (grace: number, limit: number, status: string) => Promise<string[]>;
  /** waiting ジョブを全て削除 */
  drain: () => Promise<void>;
  /** 指定ステータスのジョブを取得（orphaned active job 検出用） */
  getJobs: (status: string, start: number, end: number) => Promise<JobInfo[]>;
}

/**
 * クリーンアップ戦略
 *
 * - obliterate: active=0で全クリア
 * - selective: active>0でwaiting/failed/delayed/completedのみクリア
 * - skipped: 全ステータスが0件
 * - none: エラー発生時
 */
export type CleanupStrategy = 'obliterate' | 'selective' | 'skipped' | 'none';

/**
 * クリーンアップ実行前のジョブ数
 */
export interface JobCounts {
  active: number;
  waiting: number;
  failed: number;
  delayed: number;
  completed: number;
}

/**
 * クリーンアップ結果
 */
export interface CleanupResult {
  /** クリーンアップが成功したか */
  success: boolean;
  /** 使用されたクリーンアップ戦略 */
  strategy: CleanupStrategy;
  /** クリーンアップ前のジョブ数 */
  beforeCounts: JobCounts;
  /** クリーンアップされたジョブの総数 */
  totalCleaned: number;
  /** orphaned active job としてクリーンアップされた数 */
  orphanedActivesCleaned: number;
  /** クリーンアップにかかった時間（ms） */
  durationMs: number;
  /** エラーメッセージ（失敗時） */
  error?: string;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * orphaned active job を判定する
 *
 * 共通ユーティリティ isOrphanedByElapsedTime に委譲する。
 * QueueAdapter のJobInfoから取得可能な情報のみで判定。
 *
 * @param job - ジョブ情報
 * @param thresholdMs - orphaned 判定の閾値（ms）
 * @returns orphaned かどうか
 */
function isOrphanedActiveJob(job: JobInfo, thresholdMs: number): boolean {
  return isOrphanedByElapsedTime(job.processedOn, job.progress, thresholdMs);
}

/**
 * orphaned active job をクリーンアップする
 *
 * - progress >= 90: DB保存済みとみなし moveToCompleted
 * - progress < 90: moveToFailed
 *
 * @param job - orphaned と判定されたジョブ
 * @returns クリーンアップ成功かどうか
 */
async function cleanOrphanedJob(job: JobInfo): Promise<boolean> {
  try {
    if (isDbSavedProgress(job.progress)) {
      await job.moveToCompleted({ orphanRecovered: true }, '0', false);
      logger.info('[QueueCleanup] Orphaned active job moved to completed', {
        jobId: job.id,
        progress: job.progress,
        processedOn: job.processedOn,
      });
    } else {
      await job.moveToFailed(
        new Error('Orphaned active job cleaned up'),
        '0',
        false,
      );
      logger.warn('[QueueCleanup] Orphaned active job moved to failed', {
        jobId: job.id,
        progress: job.progress,
        processedOn: job.processedOn,
      });
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[QueueCleanup] Failed to clean orphaned job', {
      jobId: job.id,
      error: msg,
    });
    return false;
  }
}

/**
 * キューのクリーンアップを実行する
 *
 * バッチ投入の前処理として呼び出す。
 * active job の有無に応じてクリーンアップ戦略を自動選択する。
 * active job の中に orphaned job がある場合は検出・クリーンアップする。
 *
 * @param adapter - キュー操作のアダプター
 * @param options - クリーンアップオプション
 * @returns クリーンアップ結果
 */
export async function cleanupQueue(
  adapter: QueueAdapter,
  options?: CleanupOptions,
): Promise<CleanupResult> {
  const startTime = Date.now();
  const thresholdMs = options?.orphanThresholdMs ?? ORPHAN_THRESHOLD_MS;

  const emptyResult: CleanupResult = {
    success: false,
    strategy: 'none',
    beforeCounts: { active: 0, waiting: 0, failed: 0, delayed: 0, completed: 0 },
    totalCleaned: 0,
    orphanedActivesCleaned: 0,
    durationMs: 0,
  };

  try {
    // Step 1: 現在のジョブ数を取得
    const rawCounts = await adapter.getJobCounts();

    const beforeCounts: JobCounts = {
      active: rawCounts['active'] ?? 0,
      waiting: rawCounts['waiting'] ?? 0,
      failed: rawCounts['failed'] ?? 0,
      delayed: rawCounts['delayed'] ?? 0,
      completed: rawCounts['completed'] ?? 0,
    };

    const prioritized = rawCounts['prioritized'] ?? 0;
    const totalNonActive = beforeCounts.waiting + beforeCounts.failed + beforeCounts.delayed + beforeCounts.completed + prioritized;

    // Step 2: 全ステータスが0件ならスキップ
    if (beforeCounts.active === 0 && totalNonActive === 0) {
      const result: CleanupResult = {
        success: true,
        strategy: 'skipped',
        beforeCounts,
        totalCleaned: 0,
        orphanedActivesCleaned: 0,
        durationMs: Date.now() - startTime,
      };

      logger.info('[QueueCleanup] Queue is already clean, skipping', {
        strategy: result.strategy,
        beforeCounts,
      });

      return result;
    }

    // Step 3: active job が 0件の場合 → obliterate で全クリア
    if (beforeCounts.active === 0) {
      await adapter.obliterate({ force: true });

      const result: CleanupResult = {
        success: true,
        strategy: 'obliterate',
        beforeCounts,
        totalCleaned: totalNonActive,
        orphanedActivesCleaned: 0,
        durationMs: Date.now() - startTime,
      };

      logger.info('[QueueCleanup] Obliterated all jobs', {
        strategy: result.strategy,
        beforeCounts,
        totalCleaned: result.totalCleaned,
        durationMs: result.durationMs,
      });

      return result;
    }

    // Step 4: active job が残っている場合 → orphaned 検出 + 選択的クリア

    // Step 4a: orphaned active job の検出・クリーンアップ
    let orphanedActivesCleaned = 0;
    let remainingActiveCount = beforeCounts.active;

    try {
      const activeJobs = await adapter.getJobs('active', 0, -1);

      for (const job of activeJobs) {
        if (isOrphanedActiveJob(job, thresholdMs)) {
          const cleaned = await cleanOrphanedJob(job);
          if (cleaned) {
            orphanedActivesCleaned++;
            remainingActiveCount--;
          }
        }
      }
    } catch (err) {
      // getJobs がエラーを投げた場合は orphaned 検出をスキップし既存の selective を続行
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[QueueCleanup] Failed to detect orphaned active jobs, skipping', {
        error: msg,
      });
    }

    // Step 4b: 全 active が orphaned だった場合は obliterate に切り替え
    if (remainingActiveCount <= 0) {
      await adapter.obliterate({ force: true });

      const result: CleanupResult = {
        success: true,
        strategy: 'obliterate',
        beforeCounts,
        totalCleaned: totalNonActive + orphanedActivesCleaned,
        orphanedActivesCleaned,
        durationMs: Date.now() - startTime,
      };

      logger.info('[QueueCleanup] All active jobs were orphaned, obliterated queue', {
        strategy: result.strategy,
        beforeCounts,
        orphanedActivesCleaned,
        totalCleaned: result.totalCleaned,
        durationMs: result.durationMs,
      });

      return result;
    }

    // Step 4c: 通常の選択的クリア
    let cleanedCount = 0;

    // waiting ジョブをクリア
    if (beforeCounts.waiting > 0) {
      await adapter.drain();
      cleanedCount += beforeCounts.waiting;
    }

    // failed ジョブをクリア
    if (beforeCounts.failed > 0) {
      const cleaned = await adapter.clean(0, 0, 'failed');
      cleanedCount += cleaned.length;
    }

    // delayed ジョブをクリア
    if (beforeCounts.delayed > 0) {
      const cleaned = await adapter.clean(0, 0, 'delayed');
      cleanedCount += cleaned.length;
    }

    // completed ジョブをクリア
    if (beforeCounts.completed > 0) {
      const cleaned = await adapter.clean(0, 0, 'completed');
      cleanedCount += cleaned.length;
    }

    const result: CleanupResult = {
      success: true,
      strategy: 'selective',
      beforeCounts,
      totalCleaned: cleanedCount + orphanedActivesCleaned,
      orphanedActivesCleaned,
      durationMs: Date.now() - startTime,
    };

    logger.info('[QueueCleanup] Selective cleanup completed', {
      strategy: result.strategy,
      beforeCounts,
      totalCleaned: result.totalCleaned,
      orphanedActivesCleaned,
      activePreserved: remainingActiveCount,
      durationMs: result.durationMs,
    });

    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('[QueueCleanup] Cleanup failed', {
      error: errorMessage,
    });

    return {
      ...emptyResult,
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Helper: BullMQ Queue → QueueAdapter
// ============================================================================

/**
 * BullMQ Queue インスタンスから QueueAdapter を生成する
 *
 * 実運用時にはこの関数を使用して BullMQ Queue をラップする。
 *
 * @param queue - BullMQ Queue インスタンス
 * @returns QueueAdapter
 */
export function createQueueAdapter(queue: Queue): QueueAdapter {
  return {
    getJobCounts: (): Promise<Record<string, number>> => queue.getJobCounts(),
    obliterate: (opts: { force: boolean }): Promise<void> => queue.obliterate(opts),
    clean: (grace: number, limit: number, status: string): Promise<string[]> =>
      queue.clean(grace, limit, status as 'completed' | 'wait' | 'active' | 'paused' | 'delayed' | 'failed'),
    drain: (): Promise<void> => queue.drain(),
    getJobs: async (status: string, start: number, end: number): Promise<JobInfo[]> => {
      const jobs = await queue.getJobs(
        [status as 'completed' | 'wait' | 'active' | 'paused' | 'delayed' | 'failed'],
        start,
        end,
      );
      return jobs.map((job) => {
        const info: JobInfo = {
          id: job.id ?? '',
          progress: typeof job.progress === 'number' ? job.progress : 0,
          moveToCompleted: async (returnValue: unknown, token: string, fetchNext?: boolean): Promise<void> => {
            await job.moveToCompleted(returnValue, token, fetchNext);
          },
          moveToFailed: async (err: Error, token: string, fetchNext?: boolean): Promise<void> => {
            await job.moveToFailed(err, token, fetchNext);
          },
        };
        if (job.processedOn != null) {
          info.processedOn = job.processedOn;
        }
        return info;
      });
    },
  };
}
