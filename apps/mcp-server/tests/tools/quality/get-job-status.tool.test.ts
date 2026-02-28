// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.getJobStatus MCPツール テストスイート
 *
 * テスト対象:
 * - 正常系: BullMQキューでジョブが見つかった場合
 * - 正常系: LRUストアでジョブが見つかった場合（Redisフォールバック）
 * - 正常系: ジョブが見つからない場合（success: false, JOB_NOT_FOUND）
 * - 異常系: 無効なjob_id（バリデーションエラー）
 * - メタデータにrequest_idが含まれることの検証
 *
 * @module tests/tools/quality/get-job-status.tool.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// モック対象
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: vi.fn(),
}));

vi.mock('../../../src/queues/batch-quality-queue', () => ({
  createBatchQualityQueue: vi.fn(),
  getBatchQualityJobStatus: vi.fn(),
  closeBatchQualityQueue: vi.fn(),
}));

vi.mock('../../../src/utils/mcp-response', () => ({
  generateRequestId: vi.fn(() => 'test-request-id-quality-12345'),
  createErrorResponseWithRequestId: vi.fn(
    (code: string, message: string, requestId: string) => ({
      success: false,
      error: { code, message },
      metadata: { request_id: requestId },
    })
  ),
}));

// batch-evaluate.toolからのLRUストア関数をモック
vi.mock('../../../src/tools/quality/batch-evaluate.tool', () => ({
  getBatchJob: vi.fn(),
}));

// インポート
import { isRedisAvailable } from '../../../src/config/redis';
import {
  createBatchQualityQueue,
  getBatchQualityJobStatus,
  closeBatchQualityQueue,
} from '../../../src/queues/batch-quality-queue';
import {
  qualityGetJobStatusHandler,
  GET_QUALITY_JOB_STATUS_ERROR_CODES,
} from '../../../src/tools/quality/get-job-status.tool';
import { getBatchJob } from '../../../src/tools/quality/batch-evaluate.tool';
import { generateRequestId } from '../../../src/utils/mcp-response';

describe('quality.getJobStatus MCPツール', () => {
  // テスト用のモックキュー
  const mockQueue = {
    getJob: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (createBatchQualityQueue as Mock).mockReturnValue(mockQueue);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常系: BullMQキューでジョブが見つかった場合', () => {
    it('完了したジョブのステータスを返す（success: true）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'completed' as const,
        progress: 100,
        totalItems: 10,
        processedItems: 10,
        successItems: 9,
        failedItems: 1,
        result: {
          jobId: validJobId,
          success: true,
          totalItems: 10,
          processedItems: 10,
          successItems: 9,
          failedItems: 1,
          results: [
            { index: 0, success: true, data: { overall: 85 } },
            { index: 1, success: false, error: { code: 'EVAL_ERROR', message: 'Test error' } },
          ],
          processingTimeMs: 5000,
          completedAt: new Date().toISOString(),
        },
        timestamps: {
          created: Date.now() - 120000,
          started: Date.now() - 110000,
          completed: Date.now() - 5000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jobId).toBe(validJobId);
        expect(result.data.status).toBe('completed');
        expect(result.data.progress).toBe(100);
        expect(result.data.totalItems).toBe(10);
        expect(result.data.successItems).toBe(9);
        expect(result.data.failedItems).toBe(1);
        expect(result.data.result).toBeDefined();
        expect(result.data.result?.success).toBe(true);
        expect(result.metadata?.redis_used).toBe(true);
        expect(result.metadata?.lru_fallback).toBe(false);
      }
      expect(closeBatchQualityQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('処理中のジョブのステータスを返す', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'active' as const,
        progress: 50,
        totalItems: 10,
        processedItems: 5,
        successItems: 4,
        failedItems: 1,
        timestamps: {
          created: Date.now() - 30000,
          started: Date.now() - 25000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('active');
        expect(result.data.progress).toBe(50);
        expect(result.data.processedItems).toBe(5);
      }
    });

    it('失敗したジョブのステータスを返す（failedReason付き）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'failed' as const,
        progress: 25,
        totalItems: 10,
        processedItems: 3,
        successItems: 2,
        failedItems: 1,
        error: 'Batch processing failed: timeout',
        timestamps: {
          created: Date.now() - 60000,
          started: Date.now() - 55000,
          failed: Date.now() - 10000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('failed');
        expect(result.data.failedReason).toBe('Batch processing failed: timeout');
      }
    });
  });

  describe('正常系: LRUストアでジョブが見つかった場合（Redisフォールバック）', () => {
    it('Redis未接続時にLRUストアからジョブを取得する', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockLRUJob = {
        job_id: validJobId,
        status: 'completed' as const,
        total_items: 5,
        processed_items: 5,
        success_items: 5,
        failed_items: 0,
        progress_percent: 100,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        results: [
          { overall: 85, grade: 'B' },
          { overall: 90, grade: 'A' },
        ],
      };

      (isRedisAvailable as Mock).mockResolvedValue(false);
      (getBatchJob as Mock).mockReturnValue(mockLRUJob);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jobId).toBe(validJobId);
        expect(result.data.status).toBe('completed');
        expect(result.data.progress).toBe(100);
        expect(result.metadata?.redis_used).toBe(false);
        expect(result.metadata?.lru_fallback).toBe(true);
      }
    });

    it('BullMQで見つからない場合はLRUストアにフォールバックする', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockLRUJob = {
        job_id: validJobId,
        status: 'processing' as const,
        total_items: 10,
        processed_items: 5,
        success_items: 5,
        failed_items: 0,
        progress_percent: 50,
        created_at: new Date().toISOString(),
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(null);
      (getBatchJob as Mock).mockReturnValue(mockLRUJob);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('active');
        expect(result.metadata?.lru_fallback).toBe(true);
      }
    });
  });

  describe('正常系: ジョブが見つからない場合', () => {
    it('BullMQとLRUストア両方で見つからない場合JOB_NOT_FOUNDを返す', async () => {
      // Arrange
      const nonExistentJobId = '01234567-89ab-cdef-0123-000000000000';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(null);
      (getBatchJob as Mock).mockReturnValue(undefined);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: nonExistentJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.JOB_NOT_FOUND);
        expect(result.error.message).toContain(nonExistentJobId);
        expect(result.error.message).toContain('not found');
      }
      expect(closeBatchQualityQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('Redis未接続でLRUストアにもない場合JOB_NOT_FOUNDを返す', async () => {
      // Arrange
      const nonExistentJobId = '01234567-89ab-cdef-0123-000000000000';

      (isRedisAvailable as Mock).mockResolvedValue(false);
      (getBatchJob as Mock).mockReturnValue(undefined);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: nonExistentJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.JOB_NOT_FOUND);
      }
    });
  });

  describe('異常系: 無効なjob_id（バリデーションエラー）', () => {
    it('無効なUUID形式でVALIDATION_ERRORを返す', async () => {
      // Arrange
      const invalidJobId = 'not-a-valid-uuid';

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: invalidJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('空のjob_idでVALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await qualityGetJobStatusHandler({ job_id: '' });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('job_idが欠落している場合VALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await qualityGetJobStatusHandler({});

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('入力がnullの場合VALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await qualityGetJobStatusHandler(null);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_QUALITY_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  describe('メタデータ: request_idの検証', () => {
    it('成功レスポンスにrequest_idが含まれる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'completed' as const,
        progress: 100,
        totalItems: 5,
        processedItems: 5,
        successItems: 5,
        failedItems: 0,
        timestamps: { created: Date.now() },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(generateRequestId).toHaveBeenCalled();
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-quality-12345');
    });

    it('エラーレスポンスにrequest_idが含まれる', async () => {
      // Arrange
      const invalidJobId = 'invalid';

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: invalidJobId });

      // Assert
      expect(generateRequestId).toHaveBeenCalled();
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-quality-12345');
    });

    it('JOB_NOT_FOUNDレスポンスにrequest_idが含まれる', async () => {
      // Arrange
      const nonExistentJobId = '01234567-89ab-cdef-0123-000000000000';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(null);
      (getBatchJob as Mock).mockReturnValue(undefined);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: nonExistentJobId });

      // Assert
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-quality-12345');
    });
  });

  describe('リソースクリーンアップ', () => {
    it('正常完了時にキューがクローズされる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'completed' as const,
        progress: 100,
        totalItems: 5,
        processedItems: 5,
        successItems: 5,
        failedItems: 0,
        timestamps: { created: Date.now() },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(closeBatchQualityQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('ジョブ未発見時もキューがクローズされる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getBatchQualityJobStatus as Mock).mockResolvedValue(null);
      (getBatchJob as Mock).mockReturnValue(undefined);

      // Act
      await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(closeBatchQualityQueue).toHaveBeenCalledWith(mockQueue);
    });
  });

  describe('LRUストアのステータスマッピング', () => {
    it('pending -> waiting にマッピングされる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockLRUJob = {
        job_id: validJobId,
        status: 'pending' as const,
        total_items: 5,
        processed_items: 0,
        success_items: 0,
        failed_items: 0,
        progress_percent: 0,
        created_at: new Date().toISOString(),
      };

      (isRedisAvailable as Mock).mockResolvedValue(false);
      (getBatchJob as Mock).mockReturnValue(mockLRUJob);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('waiting');
      }
    });

    it('processing -> active にマッピングされる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockLRUJob = {
        job_id: validJobId,
        status: 'processing' as const,
        total_items: 10,
        processed_items: 5,
        success_items: 4,
        failed_items: 1,
        progress_percent: 50,
        created_at: new Date().toISOString(),
      };

      (isRedisAvailable as Mock).mockResolvedValue(false);
      (getBatchJob as Mock).mockReturnValue(mockLRUJob);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('active');
      }
    });

    it('cancelled -> failed にマッピングされる', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockLRUJob = {
        job_id: validJobId,
        status: 'cancelled' as const,
        total_items: 10,
        processed_items: 3,
        success_items: 2,
        failed_items: 1,
        progress_percent: 30,
        created_at: new Date().toISOString(),
        errors: [
          { index: -1, error: { code: 'CANCELLED', message: 'Job cancelled by user' } },
        ],
      };

      (isRedisAvailable as Mock).mockResolvedValue(false);
      (getBatchJob as Mock).mockReturnValue(mockLRUJob);

      // Act
      const result = await qualityGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('failed');
      }
    });
  });
});
