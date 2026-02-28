// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BatchQualityWorker テストスイート
 *
 * BullMQワーカーによるバッチ品質評価処理のテスト
 *
 * テスト対象:
 * - ワーカー作成とライフサイクル
 * - サービスインジェクション
 * - バッチ処理ロジック
 * - エラーハンドリング（skip/abort）
 * - 進捗更新
 *
 * @module tests/workers/batch-quality-worker.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import {
  processBatchQualityJob,
  setQualityEvaluatorService,
  resetQualityEvaluatorService,
  type IQualityEvaluatorService,
  type BatchQualityWorkerOptions,
} from '../../src/workers/batch-quality-worker';
import type {
  BatchQualityJobData,
  BatchQualityJobResult,
} from '../../src/queues/batch-quality-queue';

// Mock updateBatchQualityJobProgress to avoid Redis connection in tests
vi.mock('../../src/queues/batch-quality-queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/queues/batch-quality-queue')>();
  return {
    ...original,
    updateBatchQualityJobProgress: vi.fn().mockResolvedValue(undefined),
  };
});

// =====================================================
// テストヘルパー
// =====================================================

const createMockJob = (
  data: Partial<BatchQualityJobData>
): Job<BatchQualityJobData, BatchQualityJobResult> => {
  const fullData: BatchQualityJobData = {
    jobId: 'test-job-id',
    items: [],
    batchSize: 10,
    onError: 'skip',
    strict: false,
    createdAt: new Date().toISOString(),
    ...data,
  };

  return {
    id: 'bullmq-job-id',
    data: fullData,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    // BullMQ Job interface の最小限のモック
    name: 'batch-quality',
    opts: {},
    timestamp: Date.now(),
    attemptsMade: 0,
    stacktrace: [],
    returnvalue: undefined,
    failedReason: undefined,
    finishedOn: undefined,
    processedOn: undefined,
    progress: 0,
    delay: 0,
    parent: undefined,
    parentKey: undefined,
    repeatJobKey: undefined,
    token: 'test-token',
  } as unknown as Job<BatchQualityJobData, BatchQualityJobResult>;
};

const createMockService = (
  overrides?: Partial<IQualityEvaluatorService>
): IQualityEvaluatorService => ({
  evaluatePage: vi.fn().mockResolvedValue({
    pageId: 'test-page-id',
    overall: 75,
    grade: 'C',
    originality: { score: 70, grade: 'C' },
    craftsmanship: { score: 80, grade: 'B' },
    contextuality: { score: 75, grade: 'C' },
    evaluatedAt: new Date().toISOString(),
  }),
  getPageById: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
  ...overrides,
});

// =====================================================
// テスト
// =====================================================

describe('BatchQualityWorker', () => {
  beforeEach(() => {
    resetQualityEvaluatorService();
  });

  afterEach(() => {
    resetQualityEvaluatorService();
    vi.clearAllMocks();
  });

  // =====================================================
  // サービスインジェクション
  // =====================================================

  describe('Service Injection', () => {
    it('should throw error when service is not configured', async () => {
      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      await expect(processBatchQualityJob(mockJob)).rejects.toThrow(
        'Quality evaluator service not configured'
      );
    });

    it('should process jobs after service is configured', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(true);
      expect(result.processedItems).toBe(1);
    });

    it('should reset service correctly', async () => {
      setQualityEvaluatorService(createMockService());
      resetQualityEvaluatorService();

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      await expect(processBatchQualityJob(mockJob)).rejects.toThrow(
        'Quality evaluator service not configured'
      );
    });
  });

  // =====================================================
  // バッチ処理
  // =====================================================

  describe('Batch Processing', () => {
    it('should process all items successfully', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [
          { index: 0, html: '<html><body>Page 1</body></html>' },
          { index: 1, html: '<html><body>Page 2</body></html>' },
          { index: 2, html: '<html><body>Page 3</body></html>' },
        ],
        batchSize: 10,
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(true);
      expect(result.totalItems).toBe(3);
      expect(result.processedItems).toBe(3);
      expect(result.successItems).toBe(3);
      expect(result.failedItems).toBe(0);
      expect(result.results).toHaveLength(3);
    });

    it('should process items in batches', async () => {
      const evaluateMock = vi.fn().mockResolvedValue({
        overall: 80,
        grade: 'B',
      });
      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const items = Array.from({ length: 25 }, (_, i) => ({
        index: i,
        html: `<html><body>Page ${i}</body></html>`,
      }));

      const mockJob = createMockJob({
        items,
        batchSize: 10,
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(true);
      expect(result.totalItems).toBe(25);
      expect(result.processedItems).toBe(25);
      expect(evaluateMock).toHaveBeenCalledTimes(25);
    });

    it('should resolve HTML from pageId using getPageById', async () => {
      const getPageByIdMock = vi.fn().mockResolvedValue('<html><body>From DB</body></html>');
      setQualityEvaluatorService(createMockService({ getPageById: getPageByIdMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, pageId: '00000000-0000-0000-0000-000000000001' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(true);
      expect(getPageByIdMock).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
    });

    it('should use html directly when provided', async () => {
      const getPageByIdMock = vi.fn();
      setQualityEvaluatorService(createMockService({ getPageById: getPageByIdMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html><body>Direct HTML</body></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(true);
      expect(getPageByIdMock).not.toHaveBeenCalled();
    });

    it('should return sorted results by index', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [
          { index: 2, html: '<html><body>Page 2</body></html>' },
          { index: 0, html: '<html><body>Page 0</body></html>' },
          { index: 1, html: '<html><body>Page 1</body></html>' },
        ],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.results[0].index).toBe(0);
      expect(result.results[1].index).toBe(1);
      expect(result.results[2].index).toBe(2);
    });
  });

  // =====================================================
  // エラーハンドリング: skip モード
  // =====================================================

  describe('Error Handling: skip mode', () => {
    it('should continue processing after error with skip mode', async () => {
      const evaluateMock = vi
        .fn()
        .mockResolvedValueOnce({ overall: 80, grade: 'B' })
        .mockRejectedValueOnce(new Error('Evaluation failed'))
        .mockResolvedValueOnce({ overall: 85, grade: 'B' });

      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [
          { index: 0, html: '<html>1</html>' },
          { index: 1, html: '<html>2</html>' },
          { index: 2, html: '<html>3</html>' },
        ],
        onError: 'skip',
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(false); // At least one failed
      expect(result.totalItems).toBe(3);
      expect(result.processedItems).toBe(3);
      expect(result.successItems).toBe(2);
      expect(result.failedItems).toBe(1);
      expect(result.results.find((r) => r.index === 1)?.success).toBe(false);
    });

    it('should record error details for failed items', async () => {
      const evaluateMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('Test error message'));

      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
        onError: 'skip',
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error?.code).toBe('EVALUATION_ERROR');
      expect(result.results[0].error?.message).toBe('Test error message');
    });

    it('should fail when HTML cannot be resolved', async () => {
      const getPageByIdMock = vi.fn().mockResolvedValue(null);
      setQualityEvaluatorService(createMockService({ getPageById: getPageByIdMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, pageId: '00000000-0000-0000-0000-000000000001' }],
        onError: 'skip',
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error?.message).toContain('Cannot resolve HTML');
    });
  });

  // =====================================================
  // エラーハンドリング: abort モード
  // =====================================================

  describe('Error Handling: abort mode', () => {
    it('should abort processing on first error with abort mode', async () => {
      const evaluateMock = vi
        .fn()
        .mockResolvedValueOnce({ overall: 80, grade: 'B' })
        .mockRejectedValueOnce(new Error('Evaluation failed'))
        .mockResolvedValueOnce({ overall: 85, grade: 'B' });

      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [
          { index: 0, html: '<html>1</html>' },
          { index: 1, html: '<html>2</html>' },
          { index: 2, html: '<html>3</html>' },
        ],
        onError: 'abort',
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(false);
      // Should stop after first batch completes (all 3 items processed in parallel)
      // then abort when error is detected
      expect(result.failedItems).toBeGreaterThanOrEqual(1);
      expect(result.error).toContain('Aborted');
      expect(result.error).toContain('index 1');
    });

    it('should return partial results when aborted', async () => {
      const evaluateMock = vi
        .fn()
        .mockResolvedValueOnce({ overall: 80, grade: 'B' })
        .mockRejectedValueOnce(new Error('Abort error'));

      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [
          { index: 0, html: '<html>1</html>' },
          { index: 1, html: '<html>2</html>' },
        ],
        batchSize: 10,
        onError: 'abort',
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.success).toBe(false);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =====================================================
  // 進捗更新
  // =====================================================

  describe('Progress Updates', () => {
    it('should update progress after each batch', async () => {
      // Import the mocked function to check calls
      const { updateBatchQualityJobProgress } = await import('../../src/queues/batch-quality-queue');

      setQualityEvaluatorService(createMockService());

      const items = Array.from({ length: 20 }, (_, i) => ({
        index: i,
        html: `<html><body>Page ${i}</body></html>`,
      }));

      const mockJob = createMockJob({
        items,
        batchSize: 10,
      });

      await processBatchQualityJob(mockJob);

      // updateBatchQualityJobProgress should be called at least twice (after each batch)
      expect(updateBatchQualityJobProgress).toHaveBeenCalled();
      const progressCalls = (updateBatchQualityJobProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(progressCalls.length).toBeGreaterThanOrEqual(2);
      // Last call should have processedItems = 20 (all items)
      const lastCall = progressCalls[progressCalls.length - 1];
      expect(lastCall[1]).toBe(20); // processedItems
    });

    it('should calculate correct progress percentage', async () => {
      const { updateBatchQualityJobProgress } = await import('../../src/queues/batch-quality-queue');

      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [
          { index: 0, html: '<html>1</html>' },
          { index: 1, html: '<html>2</html>' },
          { index: 2, html: '<html>3</html>' },
          { index: 3, html: '<html>4</html>' },
        ],
        batchSize: 2,
      });

      await processBatchQualityJob(mockJob);

      const progressCalls = (updateBatchQualityJobProgress as ReturnType<typeof vi.fn>).mock.calls;
      // updateBatchQualityJobProgress is called with (job, processedItems, successItems, failedItems)
      // After first batch: 2 items processed
      expect(progressCalls[0][1]).toBe(2); // processedItems
      // After second batch: 4 items processed
      expect(progressCalls[1][1]).toBe(4); // processedItems
    });
  });

  // =====================================================
  // 結果構造
  // =====================================================

  describe('Result Structure', () => {
    it('should include jobId in result', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        jobId: 'custom-job-id-123',
        items: [{ index: 0, html: '<html></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.jobId).toBe('custom-job-id-123');
    });

    it('should include completedAt timestamp', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.completedAt).toBeDefined();
      expect(new Date(result.completedAt).getTime()).not.toBeNaN();
    });

    it('should include processingTimeMs', async () => {
      setQualityEvaluatorService(createMockService());

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include evaluation data in successful results', async () => {
      const mockData = {
        overall: 85,
        grade: 'B',
        originality: { score: 80, grade: 'B' },
      };
      setQualityEvaluatorService(createMockService({
        evaluatePage: vi.fn().mockResolvedValue(mockData),
      }));

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
      });

      const result = await processBatchQualityJob(mockJob);

      expect(result.results[0].success).toBe(true);
      expect(result.results[0].data).toEqual(mockData);
    });
  });

  // =====================================================
  // 評価オプション
  // =====================================================

  describe('Evaluation Options', () => {
    it('should pass strict option to evaluatePage', async () => {
      const evaluateMock = vi.fn().mockResolvedValue({ overall: 80 });
      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
        strict: true,
      });

      await processBatchQualityJob(mockJob);

      expect(evaluateMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ strict: true })
      );
    });

    it('should pass weights option to evaluatePage', async () => {
      const evaluateMock = vi.fn().mockResolvedValue({ overall: 80 });
      setQualityEvaluatorService(createMockService({ evaluatePage: evaluateMock }));

      const mockJob = createMockJob({
        items: [{ index: 0, html: '<html></html>' }],
        weights: {
          originality: 0.4,
          craftsmanship: 0.3,
          contextuality: 0.3,
        },
      });

      await processBatchQualityJob(mockJob);

      expect(evaluateMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          weights: {
            originality: 0.4,
            craftsmanship: 0.3,
            contextuality: 0.3,
          },
        })
      );
    });
  });
});
