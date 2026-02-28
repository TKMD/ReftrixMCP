// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.getJobStatus MCPツール テストスイート
 *
 * テスト対象:
 * - 正常系: ジョブが見つかった場合（success: true）
 * - 正常系: ジョブが見つからない場合（success: false, JOB_NOT_FOUND）
 * - 異常系: 無効なjob_id（バリデーションエラー）
 * - 異常系: 内部エラー
 * - メタデータにrequest_idが含まれることの検証
 *
 * @module tests/tools/page/get-job-status.tool.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// モック対象
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: vi.fn(),
}));

vi.mock('../../../src/queues/page-analyze-queue', () => ({
  createPageAnalyzeQueue: vi.fn(),
  getJobStatus: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock('../../../src/utils/mcp-response', () => ({
  generateRequestId: vi.fn(() => 'test-request-id-12345'),
  createSuccessResponseWithRequestId: vi.fn(
    (data: unknown, requestId: string) => ({
      success: true,
      data,
      metadata: { request_id: requestId },
    })
  ),
  createErrorResponseWithRequestId: vi.fn(
    (code: string, message: string, requestId: string) => ({
      success: false,
      error: { code, message },
      metadata: { request_id: requestId },
    })
  ),
}));

// インポート
import { isRedisAvailable } from '../../../src/config/redis';
import {
  createPageAnalyzeQueue,
  getJobStatus,
  closeQueue,
} from '../../../src/queues/page-analyze-queue';
import {
  pageGetJobStatusHandler,
  GET_JOB_STATUS_ERROR_CODES,
} from '../../../src/tools/page/get-job-status.tool';
import { generateRequestId } from '../../../src/utils/mcp-response';

describe('page.getJobStatus MCPツール', () => {
  // テスト用のモックキュー
  const mockQueue = {
    getJob: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (createPageAnalyzeQueue as Mock).mockReturnValue(mockQueue);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常系: ジョブが見つかった場合', () => {
    it('完了したジョブのステータスを返す（success: true）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'completed' as const,
        progress: 100,
        result: {
          webPageId: validJobId,
          success: true,
          partialSuccess: false,
          completedPhases: ['ingest', 'layout', 'motion', 'quality'],
          failedPhases: [],
        },
        timestamps: {
          created: Date.now() - 120000,
          started: Date.now() - 110000,
          completed: Date.now() - 5000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jobId).toBe(validJobId);
        expect(result.data.status).toBe('completed');
        expect(result.data.progress).toBe(100);
        expect(result.data.result).toBeDefined();
        expect(result.data.result?.success).toBe(true);
      }
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('処理中のジョブのステータスを返す（currentPhase付き）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'active' as const,
        progress: 50,
        currentPhase: 'motion' as const,
        timestamps: {
          created: Date.now() - 30000,
          started: Date.now() - 25000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('active');
        expect(result.data.progress).toBe(50);
        expect(result.data.currentPhase).toBe('motion');
      }
    });

    it('失敗したジョブのステータスを返す（failedReason付き）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';
      const mockJobStatus = {
        jobId: validJobId,
        state: 'failed' as const,
        progress: 25,
        error: 'Network timeout during layout analysis',
        timestamps: {
          created: Date.now() - 60000,
          started: Date.now() - 55000,
          failed: Date.now() - 10000,
        },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('failed');
        expect(result.data.failedReason).toBe('Network timeout during layout analysis');
      }
    });
  });

  describe('正常系: ジョブが見つからない場合', () => {
    it('JOB_NOT_FOUNDエラーを返す（success: false）', async () => {
      // Arrange
      const nonExistentJobId = '01234567-89ab-cdef-0123-000000000000';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(null);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: nonExistentJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.JOB_NOT_FOUND);
        expect(result.error.message).toContain(nonExistentJobId);
        expect(result.error.message).toContain('not found');
      }
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });
  });

  describe('異常系: 無効なjob_id（バリデーションエラー）', () => {
    it('無効なUUID形式でVALIDATION_ERRORを返す', async () => {
      // Arrange
      const invalidJobId = 'not-a-valid-uuid';

      // Act
      const result = await pageGetJobStatusHandler({ job_id: invalidJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('空のjob_idでVALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await pageGetJobStatusHandler({ job_id: '' });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('job_idが欠落している場合VALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await pageGetJobStatusHandler({});

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('入力がnullの場合VALIDATION_ERRORを返す', async () => {
      // Arrange & Act
      const result = await pageGetJobStatusHandler(null);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  describe('異常系: Redis未起動', () => {
    it('Redis未起動でREDIS_UNAVAILABLEエラーを返す', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';

      (isRedisAvailable as Mock).mockResolvedValue(false);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.REDIS_UNAVAILABLE);
        expect(result.error.message).toContain('Redis');
      }
    });
  });

  describe('異常系: 内部エラー', () => {
    it('getJobStatus例外でINTERNAL_ERRORを返す', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockRejectedValue(new Error('Connection lost'));

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.INTERNAL_ERROR);
        // SEC監査指摘: 本番環境ではエラー詳細を隠蔽
        // 開発環境でのみ詳細が表示されるが、テストではmockしているため一般的なメッセージ
        expect(result.error.message).toContain('Failed to get job status');
      }
      // エラー発生時もキューがクローズされることを確認
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('非Errorオブジェクトの例外でもINTERNAL_ERRORを返す', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockRejectedValue('String error');

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(GET_JOB_STATUS_ERROR_CODES.INTERNAL_ERROR);
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
        timestamps: { created: Date.now() },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(generateRequestId).toHaveBeenCalled();
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-12345');
    });

    it('エラーレスポンスにrequest_idが含まれる', async () => {
      // Arrange
      const invalidJobId = 'invalid';

      // Act
      const result = await pageGetJobStatusHandler({ job_id: invalidJobId });

      // Assert
      expect(generateRequestId).toHaveBeenCalled();
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-12345');
    });

    it('JOB_NOT_FOUNDレスポンスにrequest_idが含まれる', async () => {
      // Arrange
      const nonExistentJobId = '01234567-89ab-cdef-0123-000000000000';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(null);

      // Act
      const result = await pageGetJobStatusHandler({ job_id: nonExistentJobId });

      // Assert
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBe('test-request-id-12345');
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
        timestamps: { created: Date.now() },
      };

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockResolvedValue(mockJobStatus);

      // Act
      await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });

    it('エラー発生時もキューがクローズされる（finally保証）', async () => {
      // Arrange
      const validJobId = '01234567-89ab-cdef-0123-456789abcdef';

      (isRedisAvailable as Mock).mockResolvedValue(true);
      (getJobStatus as Mock).mockRejectedValue(new Error('Test error'));

      // Act
      await pageGetJobStatusHandler({ job_id: validJobId });

      // Assert
      expect(closeQueue).toHaveBeenCalledWith(mockQueue);
    });
  });
});
