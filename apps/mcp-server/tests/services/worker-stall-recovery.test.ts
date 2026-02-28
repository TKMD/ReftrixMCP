// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Stall Recovery Tests
 *
 * BullMQジョブのstall検出不能問題に対するテスト。
 *
 * テスト対象:
 * 1. isOrphanedActiveJob — orphaned active job の判定
 * 2. categorizeOrphanedJob — カテゴリ分類（db_saved_but_stuck / processing_interrupted / never_started）
 * 3. recoverOrphanedJobs — バッチ回復（ワーカー起動時）
 * 4. handleStalledJob — BullMQ stalled イベント時の単一ジョブ回復
 * 5. createPeriodicStallCheck — 定期チェックのライフサイクル
 *
 * @module tests/services/worker-stall-recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// BullMQ QueueとJobのモック
vi.mock('bullmq', () => {
  return {
    Queue: vi.fn(),
    Worker: vi.fn(),
    QueueEvents: vi.fn(),
  };
});

// Redisモック
vi.mock('../../src/config/redis', () => ({
  getRedisConfig: vi.fn().mockReturnValue({
    host: 'localhost',
    port: 27379,
    maxRetriesPerRequest: null,
  }),
  checkRedisConnection: vi.fn().mockResolvedValue({ connected: true }),
}));

// loggerモック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import {
  isOrphanedActiveJob,
  categorizeOrphanedJob,
  recoverOrphanedJobs,
  handleStalledJob,
  createPeriodicStallCheck,
  DEFAULT_PERIODIC_CHECK_INTERVAL_MS,
  type OrphanedJobInfo,
  type StalledJobAccessor,
} from '../../src/services/worker-stall-recovery.service';

describe('Worker Stall Recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // isOrphanedActiveJob
  // ==========================================================================

  describe('isOrphanedActiveJob', () => {
    it('lockDuration+マージンを超過したactive jobをorphanedとして検出する', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-001',
        state: 'active',
        progress: 90,
        processedOn: now - 2_700_000, // 45分前（lockDuration 40分 + STALL_MARGIN 4分 = 44分を超過）
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-001',
          url: 'https://spaceandtime.io',
        },
      };

      expect(isOrphanedActiveJob(jobInfo)).toBe(true);
    });

    it('lockDuration内のactive jobはorphanedではない', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-002',
        state: 'active',
        progress: 50,
        processedOn: now - 1_200_000, // 20分前（lockDuration 40分以内）
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-002',
          url: 'https://example.com',
        },
      };

      expect(isOrphanedActiveJob(jobInfo)).toBe(false);
    });

    it('processedOnが未設定のactive jobはorphanedとして扱う', () => {
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-003',
        state: 'active',
        progress: 0,
        processedOn: undefined,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-003',
          url: 'https://example.com',
        },
      };

      expect(isOrphanedActiveJob(jobInfo)).toBe(true);
    });

    it('completedまたはfailed状態のjobはorphanedではない', () => {
      const now = Date.now();
      const completedJob: OrphanedJobInfo = {
        jobId: 'job-004',
        state: 'completed',
        progress: 100,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-004',
          url: 'https://example.com',
        },
      };

      const failedJob: OrphanedJobInfo = {
        jobId: 'job-005',
        state: 'failed',
        progress: 45,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-005',
          url: 'https://example.com',
        },
      };

      expect(isOrphanedActiveJob(completedJob)).toBe(false);
      expect(isOrphanedActiveJob(failedJob)).toBe(false);
    });

    it('lockDuration+マージン丁度のjobはorphanedではない（境界値）', () => {
      const now = Date.now();
      // lockDuration(2400000) + STALL_MARGIN(240000) = 2640000ms
      // elapsed == threshold はorphanedではない（> threshold が条件）
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-006',
        state: 'active',
        progress: 50,
        processedOn: now - 2_640_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-006',
          url: 'https://example.com',
        },
      };

      expect(isOrphanedActiveJob(jobInfo)).toBe(false);
    });
  });

  // ==========================================================================
  // categorizeOrphanedJob
  // ==========================================================================

  describe('categorizeOrphanedJob', () => {
    it('progress >= 90% のジョブをdb_saved_but_stuckとして分類する', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-001',
        state: 'active',
        progress: 90,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-001',
          url: 'https://spaceandtime.io',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('db_saved_but_stuck');
    });

    it('progress = 96% のジョブをdb_saved_but_stuckとして分類する（obys.agency case）', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-obys',
        state: 'active',
        progress: 96,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-obys',
          url: 'https://obys.agency',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('db_saved_but_stuck');
    });

    it('progress < 90% のジョブをprocessing_interruptedとして分類する', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-002',
        state: 'active',
        progress: 45,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-002',
          url: 'https://example.com',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('processing_interrupted');
    });

    it('progress = 0、processedOn未設定のジョブをnever_startedとして分類する', () => {
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-003',
        state: 'active',
        progress: 0,
        processedOn: undefined,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-003',
          url: 'https://example.com',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('never_started');
    });

    it('progress = 0、processedOnがあるジョブをnever_startedとして分類する', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-004',
        state: 'active',
        progress: 0,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-004',
          url: 'https://example.com',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('never_started');
    });

    it('progress = 100 のジョブをdb_saved_but_stuckとして分類する', () => {
      const now = Date.now();
      const jobInfo: OrphanedJobInfo = {
        jobId: 'job-005',
        state: 'active',
        progress: 100,
        processedOn: now - 3_000_000,
        lockDurationMs: 2_400_000,
        data: {
          webPageId: 'wp-005',
          url: 'https://example.com',
        },
      };

      expect(categorizeOrphanedJob(jobInfo)).toBe('db_saved_but_stuck');
    });
  });

  // ==========================================================================
  // recoverOrphanedJobs
  // ==========================================================================

  describe('recoverOrphanedJobs', () => {
    const lockDurationMs = 2_400_000;

    it('orphaned db_saved_but_stuck ジョブを completed に遷移する', async () => {
      const now = Date.now();
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-spaceandtime',
          state: 'active',
          progress: 90,
          processedOn: now - 3_000_000, // 50分前
          lockDurationMs,
          data: { webPageId: 'wp-spaceandtime', url: 'https://spaceandtime.io' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn().mockResolvedValue(undefined);

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toEqual({
        jobId: 'job-spaceandtime',
        category: 'db_saved_but_stuck',
        action: 'completed',
      });
      expect(moveToCompleted).toHaveBeenCalledWith('job-spaceandtime');
      expect(moveToFailed).not.toHaveBeenCalled();
    });

    it('orphaned processing_interrupted ジョブを failed に遷移する', async () => {
      const now = Date.now();
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-mid-process',
          state: 'active',
          progress: 45,
          processedOn: now - 3_000_000,
          lockDurationMs,
          data: { webPageId: 'wp-mid', url: 'https://mid.example.com' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn().mockResolvedValue(undefined);

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(result.details[0]).toEqual({
        jobId: 'job-mid-process',
        category: 'processing_interrupted',
        action: 'moved_to_failed',
      });
      expect(moveToFailed).toHaveBeenCalledWith(
        'job-mid-process',
        expect.stringContaining('progress: 45%'),
      );
    });

    it('orphaned never_started ジョブを failed に遷移する', async () => {
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-never',
          state: 'active',
          progress: 0,
          processedOn: undefined,
          lockDurationMs,
          data: { webPageId: 'wp-never', url: 'https://never.example.com' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn().mockResolvedValue(undefined);

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(result.details[0]).toEqual({
        jobId: 'job-never',
        category: 'never_started',
        action: 'moved_to_failed',
      });
    });

    it('非orphanedのactive jobはスキップする', async () => {
      const now = Date.now();
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-healthy',
          state: 'active',
          progress: 50,
          processedOn: now - 600_000, // 10分前（lockDuration 40分以内）
          lockDurationMs,
          data: { webPageId: 'wp-healthy', url: 'https://healthy.example.com' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.recoveredCount).toBe(0);
      expect(result.details).toHaveLength(0);
      expect(moveToFailed).not.toHaveBeenCalled();
      expect(moveToCompleted).not.toHaveBeenCalled();
    });

    it('active jobsが0件の場合は何もしない', async () => {
      const getActiveJobs = vi.fn().mockResolvedValue([]);
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('複数ジョブの混在ケース（spaceandtime + obys scenario）', async () => {
      const now = Date.now();
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-spaceandtime',
          state: 'active',
          progress: 90,
          processedOn: now - 3_600_000, // 60分前
          lockDurationMs,
          data: { webPageId: 'wp-spaceandtime', url: 'https://spaceandtime.io' },
        },
        {
          jobId: 'job-obys',
          state: 'active',
          progress: 96,
          processedOn: now - 3_600_000,
          lockDurationMs,
          data: { webPageId: 'wp-obys', url: 'https://obys.agency' },
        },
        {
          jobId: 'job-active-healthy',
          state: 'active',
          progress: 30,
          processedOn: now - 300_000, // 5分前（健全）
          lockDurationMs,
          data: { webPageId: 'wp-active', url: 'https://active.example.com' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn().mockResolvedValue(undefined);

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(2);
      expect(result.failedCount).toBe(0);

      // spaceandtime + obys は completed
      expect(moveToCompleted).toHaveBeenCalledTimes(2);
      expect(moveToCompleted).toHaveBeenCalledWith('job-spaceandtime');
      expect(moveToCompleted).toHaveBeenCalledWith('job-obys');

      // healthy はスキップ
      expect(moveToFailed).not.toHaveBeenCalled();
    });

    it('回復中にエラーが発生した場合はfailedCountを増加し、処理を続行する', async () => {
      const now = Date.now();
      const getActiveJobs = vi.fn().mockResolvedValue([
        {
          jobId: 'job-error',
          state: 'active',
          progress: 90,
          processedOn: now - 3_600_000,
          lockDurationMs,
          data: { webPageId: 'wp-error', url: 'https://error.example.com' },
        },
        {
          jobId: 'job-ok',
          state: 'active',
          progress: 50,
          processedOn: now - 3_600_000,
          lockDurationMs,
          data: { webPageId: 'wp-ok', url: 'https://ok.example.com' },
        },
      ] satisfies OrphanedJobInfo[]);
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn()
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockResolvedValue(undefined);

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(true); // overall process succeeded
      expect(result.recoveredCount).toBe(1); // job-ok recovered
      expect(result.failedCount).toBe(1); // job-error failed
      expect(result.details).toHaveLength(2);
      expect(result.details[0]).toEqual({
        jobId: 'job-error',
        category: 'db_saved_but_stuck',
        action: 'skipped',
        error: 'Redis connection lost',
      });
    });

    it('getActiveJobs自体がエラーの場合はsuccess=falseを返す', async () => {
      const getActiveJobs = vi.fn().mockRejectedValue(new Error('Queue not available'));
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const result = await recoverOrphanedJobs(getActiveJobs, moveToFailed, moveToCompleted, lockDurationMs);

      expect(result.success).toBe(false);
      expect(result.recoveredCount).toBe(0);
    });
  });

  // ==========================================================================
  // handleStalledJob
  // ==========================================================================

  describe('handleStalledJob', () => {
    function createMockAccessor(job: {
      id: string;
      progress: number;
      processedOn: number | undefined;
      state: string;
      data: { webPageId: string; url: string };
    } | null): StalledJobAccessor {
      const moveToFailed = vi.fn().mockResolvedValue(undefined);
      const moveToCompleted = vi.fn().mockResolvedValue(undefined);

      return {
        getJob: vi.fn().mockResolvedValue(
          job
            ? {
                id: job.id,
                progress: job.progress,
                processedOn: job.processedOn,
                data: job.data,
                moveToFailed,
                moveToCompleted,
                getState: vi.fn().mockResolvedValue(job.state),
              }
            : null,
        ),
      };
    }

    it('progress >= 90% の stalled job を completed に遷移する', async () => {
      const accessor = createMockAccessor({
        id: 'job-spaceandtime',
        progress: 90,
        processedOn: Date.now() - 3_600_000,
        state: 'active',
        data: { webPageId: 'wp-spaceandtime', url: 'https://spaceandtime.io' },
      });

      const result = await handleStalledJob('job-spaceandtime', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('completed');
      expect(result.category).toBe('db_saved_but_stuck');

      const resolvedJob = await accessor.getJob('job-spaceandtime');
      expect(resolvedJob?.moveToCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          webPageId: 'wp-spaceandtime',
          success: true,
          partialSuccess: true,
        }),
        '0',
        false,
      );
    });

    it('progress = 96% の stalled job を completed に遷移する（obys.agency case）', async () => {
      const accessor = createMockAccessor({
        id: 'job-obys',
        progress: 96,
        processedOn: Date.now() - 3_600_000,
        state: 'active',
        data: { webPageId: 'wp-obys', url: 'https://obys.agency' },
      });

      const result = await handleStalledJob('job-obys', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('completed');
      expect(result.category).toBe('db_saved_but_stuck');
    });

    it('progress < 90% の stalled active job を failed に遷移する', async () => {
      const accessor = createMockAccessor({
        id: 'job-mid',
        progress: 45,
        processedOn: Date.now() - 3_600_000,
        state: 'active',
        data: { webPageId: 'wp-mid', url: 'https://mid.example.com' },
      });

      const result = await handleStalledJob('job-mid', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_failed');
      expect(result.category).toBe('processing_interrupted');

      const resolvedJob = await accessor.getJob('job-mid');
      expect(resolvedJob?.moveToFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('worker_restart_during_processing'),
        }),
        '0',
        false,
      );
    });

    it('progress = 0 の stalled active job を failed に遷移する', async () => {
      const accessor = createMockAccessor({
        id: 'job-zero',
        progress: 0,
        processedOn: undefined,
        state: 'active',
        data: { webPageId: 'wp-zero', url: 'https://zero.example.com' },
      });

      const result = await handleStalledJob('job-zero', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_failed');
      expect(result.category).toBe('never_started');
    });

    it('存在しないジョブに対してはnot_foundを返す', async () => {
      const accessor = createMockAccessor(null);

      const result = await handleStalledJob('job-missing', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('not_found');
      expect(result.category).toBeNull();
    });

    it('既にcompleted状態のジョブはスキップする', async () => {
      const accessor = createMockAccessor({
        id: 'job-done',
        progress: 100,
        processedOn: Date.now() - 3_600_000,
        state: 'completed',
        data: { webPageId: 'wp-done', url: 'https://done.example.com' },
      });

      const result = await handleStalledJob('job-done', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('既にfailed状態のジョブはスキップする', async () => {
      const accessor = createMockAccessor({
        id: 'job-failed',
        progress: 45,
        processedOn: Date.now() - 3_600_000,
        state: 'failed',
        data: { webPageId: 'wp-failed', url: 'https://failed.example.com' },
      });

      const result = await handleStalledJob('job-failed', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('waiting状態のstalled job（retry後）はfailedに遷移する', async () => {
      const accessor = createMockAccessor({
        id: 'job-waiting',
        progress: 30,
        processedOn: Date.now() - 3_600_000,
        state: 'waiting',
        data: { webPageId: 'wp-waiting', url: 'https://waiting.example.com' },
      });

      const result = await handleStalledJob('job-waiting', accessor);

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_failed');
      expect(result.category).toBe('processing_interrupted');
    });

    it('moveToCompleted がエラーの場合はsuccess=falseを返す', async () => {
      const moveToCompleted = vi.fn().mockRejectedValue(new Error('Missing lock'));
      const accessor: StalledJobAccessor = {
        getJob: vi.fn().mockResolvedValue({
          id: 'job-lock-err',
          progress: 95,
          processedOn: Date.now() - 3_600_000,
          data: { webPageId: 'wp-lock', url: 'https://lock.example.com' },
          moveToFailed: vi.fn().mockResolvedValue(undefined),
          moveToCompleted,
          getState: vi.fn().mockResolvedValue('active'),
        }),
      };

      const result = await handleStalledJob('job-lock-err', accessor);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing lock');
    });

    it('getJob がエラーの場合はsuccess=falseを返す', async () => {
      const accessor: StalledJobAccessor = {
        getJob: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };

      const result = await handleStalledJob('job-conn-err', accessor);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  // ==========================================================================
  // createPeriodicStallCheck
  // ==========================================================================

  describe('createPeriodicStallCheck', () => {
    it('デフォルト間隔は10分（600000ms）', () => {
      expect(DEFAULT_PERIODIC_CHECK_INTERVAL_MS).toBe(600_000);
    });

    it('指定間隔でrecoverOrphanedJobsを呼び出す', async () => {
      const getActiveJobs = vi.fn().mockResolvedValue([]);
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const check = createPeriodicStallCheck(
        getActiveJobs,
        moveToFailed,
        moveToCompleted,
        { intervalMs: 5000, lockDurationMs: 2_400_000 },
      );

      // 初回（0ms）は呼ばれない
      expect(getActiveJobs).not.toHaveBeenCalled();

      // 5秒後に1回目
      await vi.advanceTimersByTimeAsync(5000);
      expect(getActiveJobs).toHaveBeenCalledTimes(1);

      // 10秒後に2回目
      await vi.advanceTimersByTimeAsync(5000);
      expect(getActiveJobs).toHaveBeenCalledTimes(2);

      check.stop();

      // 停止後は呼ばれない
      await vi.advanceTimersByTimeAsync(5000);
      expect(getActiveJobs).toHaveBeenCalledTimes(2);
    });

    it('stop()後はタイマーが停止する', async () => {
      const getActiveJobs = vi.fn().mockResolvedValue([]);
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const check = createPeriodicStallCheck(
        getActiveJobs,
        moveToFailed,
        moveToCompleted,
        { intervalMs: 1000, lockDurationMs: 2_400_000 },
      );

      check.stop();

      await vi.advanceTimersByTimeAsync(3000);
      expect(getActiveJobs).not.toHaveBeenCalled();
    });

    it('recoverOrphanedJobsのエラーはクラッシュさせない', async () => {
      const getActiveJobs = vi.fn().mockRejectedValue(new Error('Redis down'));
      const moveToFailed = vi.fn();
      const moveToCompleted = vi.fn();

      const check = createPeriodicStallCheck(
        getActiveJobs,
        moveToFailed,
        moveToCompleted,
        { intervalMs: 1000, lockDurationMs: 2_400_000 },
      );

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);

      expect(getActiveJobs).toHaveBeenCalledTimes(1);

      check.stop();
    });
  });
});
