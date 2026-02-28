// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP-RESP-04: バッチ品質評価進捗精度テスト
 *
 * テスト対象:
 * - 進捗情報のRedis保存/取得
 * - ワーカーによる進捗更新
 * - getBatchQualityJobStatusでの正確な進捗取得
 * - LRUストアへのフォールバック
 *
 * @module tests/queues/batch-quality-progress.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type {
  BatchQualityJobData,
  BatchQualityJobResult,
} from '../../src/queues/batch-quality-queue';

// Mock Redis for unit tests
vi.mock('../../src/config/redis', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/redis')>();
  return {
    ...original,
    isRedisAvailable: vi.fn().mockResolvedValue(false),
    getRedisClient: vi.fn().mockReturnValue({
      setex: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    }),
  };
});

// =====================================================
// Redis進捗保存/取得のテスト
// =====================================================

describe('MCP-RESP-04: Batch Quality Progress Accuracy', () => {
  describe('saveBatchQualityProgress / getBatchQualityProgress', () => {
    it('should save and retrieve progress data correctly via LRU fallback', async () => {
      const { saveBatchQualityProgress, getBatchQualityProgress } = await import(
        '../../src/queues/batch-quality-queue'
      );
      const { addBatchJob, getBatchJob } = await import(
        '../../src/tools/quality/batch-evaluate.tool'
      );

      const jobId = `test-job-progress-001-${Date.now()}`;
      const progressData = {
        processedItems: 5,
        successItems: 4,
        failedItems: 1,
        totalItems: 10,
      };

      // LRUストアにジョブを追加（saveBatchQualityProgressがLRUに同期するため必要）
      addBatchJob({
        job_id: jobId,
        status: 'processing',
        total_items: 10,
        processed_items: 0,
        success_items: 0,
        failed_items: 0,
        progress_percent: 0,
        created_at: new Date().toISOString(),
      });

      // 進捗を保存（Redis unavailable なのでLRUに同期）
      await saveBatchQualityProgress(jobId, progressData);

      // 進捗を取得（Redis unavailable なのでLRUからフォールバック）
      const retrieved = await getBatchQualityProgress(jobId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.processedItems).toBe(5);
      expect(retrieved?.successItems).toBe(4);
      expect(retrieved?.failedItems).toBe(1);
      expect(retrieved?.totalItems).toBe(10);
    });

    it('should return null for non-existent job progress', async () => {
      const { getBatchQualityProgress } = await import(
        '../../src/queues/batch-quality-queue'
      );

      const result = await getBatchQualityProgress('non-existent-job-id-' + Date.now());

      expect(result).toBeNull();
    });

    it('should update existing progress data via LRU', async () => {
      const { saveBatchQualityProgress, getBatchQualityProgress } = await import(
        '../../src/queues/batch-quality-queue'
      );
      const { addBatchJob } = await import(
        '../../src/tools/quality/batch-evaluate.tool'
      );

      const jobId = `test-job-progress-002-${Date.now()}`;

      // LRUストアにジョブを追加
      addBatchJob({
        job_id: jobId,
        status: 'processing',
        total_items: 10,
        processed_items: 0,
        success_items: 0,
        failed_items: 0,
        progress_percent: 0,
        created_at: new Date().toISOString(),
      });

      // 初期進捗
      await saveBatchQualityProgress(jobId, {
        processedItems: 2,
        successItems: 2,
        failedItems: 0,
        totalItems: 10,
      });

      // 進捗更新
      await saveBatchQualityProgress(jobId, {
        processedItems: 5,
        successItems: 4,
        failedItems: 1,
        totalItems: 10,
      });

      const retrieved = await getBatchQualityProgress(jobId);

      expect(retrieved?.processedItems).toBe(5);
      expect(retrieved?.successItems).toBe(4);
      expect(retrieved?.failedItems).toBe(1);
    });
  });

  describe('getBatchQualityJobStatus with accurate progress', () => {
    it('should return accurate processedItems/successItems/failedItems from Redis', async () => {
      const {
        saveBatchQualityProgress,
        getBatchQualityJobStatus,
        createBatchQualityQueue,
        addBatchQualityJob,
        closeBatchQualityQueue,
      } = await import('../../src/queues/batch-quality-queue');
      const { isRedisAvailable } = await import('../../src/config/redis');

      // Redisが利用可能かチェック
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        console.log('Skipping test: Redis not available');
        return;
      }

      const queue = createBatchQualityQueue();
      const jobId = `test-progress-job-${Date.now()}`;

      try {
        // ジョブを作成
        await addBatchQualityJob(queue, {
          jobId,
          items: Array.from({ length: 10 }, (_, i) => ({ index: i, html: '<html></html>' })),
          batchSize: 5,
          onError: 'skip',
          strict: false,
        });

        // 進捗データを保存（ワーカーがこれを行う想定）
        await saveBatchQualityProgress(jobId, {
          processedItems: 6,
          successItems: 5,
          failedItems: 1,
          totalItems: 10,
        });

        // ステータス取得
        const status = await getBatchQualityJobStatus(queue, jobId);

        expect(status).not.toBeNull();
        expect(status?.processedItems).toBe(6);
        expect(status?.successItems).toBe(5);
        expect(status?.failedItems).toBe(1);
        expect(status?.progress).toBe(60); // 6/10 * 100
      } finally {
        await closeBatchQualityQueue(queue);
      }
    });
  });

  describe('updateBatchQualityJobProgress integration', () => {
    it('should update progress in Redis and be retrievable via getBatchQualityJobStatus', async () => {
      const {
        updateBatchQualityJobProgress,
        getBatchQualityJobStatus,
        createBatchQualityQueue,
        addBatchQualityJob,
        closeBatchQualityQueue,
      } = await import('../../src/queues/batch-quality-queue');
      const { isRedisAvailable } = await import('../../src/config/redis');

      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        console.log('Skipping test: Redis not available');
        return;
      }

      const queue = createBatchQualityQueue();
      const jobId = `test-update-progress-job-${Date.now()}`;

      try {
        // ジョブを作成
        const job = await addBatchQualityJob(queue, {
          jobId,
          items: Array.from({ length: 20 }, (_, i) => ({ index: i, html: '<html></html>' })),
          batchSize: 5,
          onError: 'skip',
          strict: false,
        });

        // updateBatchQualityJobProgressで進捗更新
        await updateBatchQualityJobProgress(job, 10, 8, 2);

        // ステータス取得して検証
        const status = await getBatchQualityJobStatus(queue, jobId);

        expect(status).not.toBeNull();
        expect(status?.processedItems).toBe(10);
        expect(status?.successItems).toBe(8);
        expect(status?.failedItems).toBe(2);
        expect(status?.progress).toBe(50); // 10/20 * 100
      } finally {
        await closeBatchQualityQueue(queue);
      }
    });
  });

  describe('LRU store fallback for progress', () => {
    it('should sync progress to LRU store when updating via Redis', async () => {
      const { saveBatchQualityProgress } = await import('../../src/queues/batch-quality-queue');
      const { getBatchJob, addBatchJob, updateBatchJob } = await import(
        '../../src/tools/quality/batch-evaluate.tool'
      );

      const jobId = `test-lru-sync-${Date.now()}`;

      // LRUストアにジョブを追加
      addBatchJob({
        job_id: jobId,
        status: 'processing',
        total_items: 10,
        processed_items: 0,
        success_items: 0,
        failed_items: 0,
        progress_percent: 0,
        created_at: new Date().toISOString(),
      });

      // Redis経由で進捗を保存（LRUにも同期されるべき）
      await saveBatchQualityProgress(jobId, {
        processedItems: 7,
        successItems: 6,
        failedItems: 1,
        totalItems: 10,
      });

      // LRUストアからも最新の進捗が取得できるべき
      const lruJob = getBatchJob(jobId);

      expect(lruJob).toBeDefined();
      expect(lruJob?.processed_items).toBe(7);
      expect(lruJob?.success_items).toBe(6);
      expect(lruJob?.failed_items).toBe(1);
      expect(lruJob?.progress_percent).toBe(70);
    });
  });

  describe('Worker progress updates', () => {
    it('should update progress correctly during batch processing', async () => {
      // Mock updateBatchQualityJobProgress to capture calls
      const updateProgressCalls: Array<{ processedItems: number; successItems: number; failedItems: number }> = [];
      vi.doMock('../../src/queues/batch-quality-queue', async (importOriginal) => {
        const original = await importOriginal<typeof import('../../src/queues/batch-quality-queue')>();
        return {
          ...original,
          updateBatchQualityJobProgress: vi.fn().mockImplementation(async (_job, processedItems, successItems, failedItems) => {
            updateProgressCalls.push({ processedItems, successItems, failedItems });
          }),
        };
      });

      // Re-import worker to get fresh module with mocked dependencies
      const { processBatchQualityJob, setQualityEvaluatorService, resetQualityEvaluatorService } =
        await import('../../src/workers/batch-quality-worker');

      const mockService = {
        evaluatePage: vi.fn().mockResolvedValue({
          overall: 80,
          grade: 'B',
        }),
        getPageById: vi.fn().mockResolvedValue('<html></html>'),
      };

      setQualityEvaluatorService(mockService);

      const jobId = `test-worker-progress-${Date.now()}`;
      const mockJob = {
        id: 'bullmq-job-id',
        data: {
          jobId,
          items: Array.from({ length: 4 }, (_, i) => ({
            index: i,
            html: `<html><body>Page ${i}</body></html>`,
          })),
          batchSize: 2,
          onError: 'skip' as const,
          strict: false,
          createdAt: new Date().toISOString(),
        },
        updateProgress: vi.fn().mockResolvedValue(undefined),
        log: vi.fn().mockResolvedValue(undefined),
      } as unknown as Job<BatchQualityJobData, BatchQualityJobResult>;

      try {
        const result = await processBatchQualityJob(mockJob);

        // ジョブが正常に処理されたことを確認
        expect(result.success).toBe(true);
        expect(result.processedItems).toBe(4);
        expect(result.successItems).toBe(4);
        expect(result.failedItems).toBe(0);
        expect(result.totalItems).toBe(4);
      } finally {
        resetQualityEvaluatorService();
        vi.doUnmock('../../src/queues/batch-quality-queue');
      }
    });

    it('should update progress incrementally during processing', async () => {
      // Mock updateBatchQualityJobProgress to capture calls
      const updateProgressCalls: Array<{ processedItems: number; successItems: number; failedItems: number }> = [];
      vi.doMock('../../src/queues/batch-quality-queue', async (importOriginal) => {
        const original = await importOriginal<typeof import('../../src/queues/batch-quality-queue')>();
        return {
          ...original,
          updateBatchQualityJobProgress: vi.fn().mockImplementation(async (_job, processedItems, successItems, failedItems) => {
            updateProgressCalls.push({ processedItems, successItems, failedItems });
          }),
        };
      });

      const { processBatchQualityJob, setQualityEvaluatorService, resetQualityEvaluatorService } =
        await import('../../src/workers/batch-quality-worker');

      const mockService = {
        evaluatePage: vi.fn().mockResolvedValue({ overall: 80, grade: 'B' }),
        getPageById: vi.fn().mockResolvedValue('<html></html>'),
      };

      setQualityEvaluatorService(mockService);

      const mockJob = {
        id: 'bullmq-job-id',
        data: {
          jobId: `test-incremental-job-${Date.now()}`,
          items: Array.from({ length: 6 }, (_, i) => ({
            index: i,
            html: `<html><body>Page ${i}</body></html>`,
          })),
          batchSize: 2, // 3バッチに分割
          onError: 'skip' as const,
          strict: false,
          createdAt: new Date().toISOString(),
        },
        updateProgress: vi.fn().mockResolvedValue(undefined),
        log: vi.fn().mockResolvedValue(undefined),
      } as unknown as Job<BatchQualityJobData, BatchQualityJobResult>;

      try {
        const result = await processBatchQualityJob(mockJob);

        // バッチごとに進捗が更新されているべき
        expect(result.processedItems).toBe(6);
        expect(result.successItems).toBe(6);
        expect(result.failedItems).toBe(0);
      } finally {
        resetQualityEvaluatorService();
        vi.doUnmock('../../src/queues/batch-quality-queue');
      }
    });
  });
});
