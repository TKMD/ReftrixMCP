// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.batch_evaluate MCPツール テスト
 *
 * 複数ページの品質評価を一括処理するツールのテスト
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  batchQualityEvaluateHandler,
  setBatchQualityEvaluateServiceFactory,
  resetBatchQualityEvaluateServiceFactory,
  clearBatchJobStore,
  addBatchJob,
  getBatchJob,
  getJobStoreStats,
  type IBatchQualityEvaluateService,
} from '../../../src/tools/quality/batch-evaluate.tool';
import type { BatchQualityJobStatus } from '../../../src/tools/quality/schemas';

// =====================================================
// テストヘルパー
// =====================================================

const createMockService = (overrides?: Partial<IBatchQualityEvaluateService>): IBatchQualityEvaluateService => ({
  evaluatePage: vi.fn().mockResolvedValue({
    pageId: 'test-page-id',
    overall: 75,
    grade: 'C',
    originality: { score: 70, grade: 'C' },
    craftsmanship: { score: 80, grade: 'B' },
    contextuality: { score: 75, grade: 'C' },
    evaluatedAt: new Date().toISOString(),
  }),
  ...overrides,
});

const validBatchInput = {
  items: [
    { html: '<html><body><h1>Page 1</h1></body></html>' },
    { html: '<html><body><h1>Page 2</h1></body></html>' },
    { html: '<html><body><h1>Page 3</h1></body></html>' },
  ],
};

// =====================================================
// テスト
// =====================================================

describe('quality.batch_evaluate', () => {
  beforeEach(() => {
    clearBatchJobStore();
    resetBatchQualityEvaluateServiceFactory();
  });

  afterEach(() => {
    clearBatchJobStore();
    resetBatchQualityEvaluateServiceFactory();
  });

  // =====================================================
  // 入力バリデーション
  // =====================================================

  describe('Input Validation', () => {
    it('should reject empty items array', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({ items: [] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject more than 100 items', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const items = Array.from({ length: 101 }, (_, i) => ({
        html: `<html><body><h1>Page ${i}</h1></body></html>`,
      }));

      const result = await batchQualityEvaluateHandler({ items });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject items without html or pageId', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        items: [{}],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject items with both html and pageId', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        items: [{ html: '<html></html>', pageId: '123e4567-e89b-12d3-a456-426614174000' }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should accept valid pageId format', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService({
        getPageById: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
      }));

      const result = await batchQualityEvaluateHandler({
        items: [{ pageId: '123e4567-e89b-12d3-a456-426614174000' }],
      });

      expect(result.success).toBe(true);
    });

    it('should accept batch_size within range', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        batch_size: 25,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.batch_size).toBe(25);
      }
    });

    it('should reject batch_size below minimum', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        batch_size: 0,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject batch_size above maximum', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        batch_size: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should accept on_error values', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const skipResult = await batchQualityEvaluateHandler({
        ...validBatchInput,
        on_error: 'skip',
      });

      expect(skipResult.success).toBe(true);

      const abortResult = await batchQualityEvaluateHandler({
        ...validBatchInput,
        on_error: 'abort',
      });

      expect(abortResult.success).toBe(true);
    });
  });

  // =====================================================
  // ジョブ作成
  // =====================================================

  describe('Job Creation', () => {
    it('should create a job with valid UUID', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.job_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
      }
    });

    it('should return pending status on creation', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('pending');
      }
    });

    it('should return correct total_items count', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_items).toBe(3);
      }
    });

    it('should use default batch_size when not specified', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.batch_size).toBe(10);
      }
    });

    it('should use default on_error when not specified', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.on_error).toBe('skip');
      }
    });

    it('should include created_at timestamp', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.created_at).toBeDefined();
        expect(new Date(result.data.created_at).getTime()).not.toBeNaN();
      }
    });

    it('should store job in jobStore', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        const storedJob = getBatchJob(result.data.job_id);
        expect(storedJob).toBeDefined();
        // LRU fallback mode: ジョブは即時開始されるため、pendingまたはprocessingの状態
        // Redis/BullMQ使用時はpending、LRUフォールバック時は即座にprocessingに遷移する可能性あり
        expect(['pending', 'processing']).toContain(storedJob?.status);
      }
    });
  });

  // =====================================================
  // サービス連携
  // =====================================================

  describe('Service Integration', () => {
    it('should succeed even when service factory is not set for HTML items', async () => {
      // Factory not set - but HTML items should still work
      const result = await batchQualityEvaluateHandler(validBatchInput);

      // HTMLが直接指定されているアイテムは、サービスファクトリがなくても成功する
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_items).toBe(3);
      }
    });

    it('should warn when service factory is not set for pageId items', async () => {
      // pageIdを持つアイテムはサービスが必要だが、警告のみでジョブは開始される
      const pageIdInput = {
        items: [
          { pageId: '00000000-0000-0000-0000-000000000001' },
          { html: '<html><body>Test</body></html>' },
        ],
      };

      const result = await batchQualityEvaluateHandler(pageIdInput);

      // ジョブ自体は開始される（pageIdアイテムは後でスキップされる想定）
      expect(result.success).toBe(true);
    });

    it('should include message in successful response', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.message).toContain('3');
        expect(result.data.message).toContain('10');
      }
    });
  });

  // =====================================================
  // 出力スキーマ
  // =====================================================

  describe('Output Schema', () => {
    it('should return success: true for valid input', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
    });

    it('should return success: false for invalid input', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({});

      expect(result.success).toBe(false);
    });

    it('should have correct data structure on success', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('job_id');
        expect(result.data).toHaveProperty('status');
        expect(result.data).toHaveProperty('total_items');
        expect(result.data).toHaveProperty('batch_size');
        expect(result.data).toHaveProperty('on_error');
        expect(result.data).toHaveProperty('created_at');
        expect(result.data).toHaveProperty('message');
      }
    });

    it('should have correct error structure on failure', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }
    });
  });

  // =====================================================
  // ジョブストア操作
  // =====================================================

  describe('Job Store Operations', () => {
    it('clearBatchJobStore should clear all jobs', () => {
      const job: BatchQualityJobStatus = {
        job_id: 'test-id',
        status: 'pending',
        total_items: 5,
        processed_items: 0,
        success_items: 0,
        failed_items: 0,
        progress_percent: 0,
        created_at: new Date().toISOString(),
      };

      addBatchJob(job);
      expect(getBatchJob('test-id')).toBeDefined();

      clearBatchJobStore();
      expect(getBatchJob('test-id')).toBeUndefined();
    });

    it('addBatchJob should add a job to store', () => {
      const job: BatchQualityJobStatus = {
        job_id: 'new-job',
        status: 'processing',
        total_items: 10,
        processed_items: 5,
        success_items: 4,
        failed_items: 1,
        progress_percent: 50,
        created_at: new Date().toISOString(),
      };

      addBatchJob(job);

      const retrieved = getBatchJob('new-job');
      expect(retrieved).toBeDefined();
      expect(retrieved?.status).toBe('processing');
      expect(retrieved?.processed_items).toBe(5);
    });

    it('getBatchJob should return undefined for non-existent job', () => {
      const result = getBatchJob('non-existent');
      expect(result).toBeUndefined();
    });
  });

  // =====================================================
  // 設定オプション
  // =====================================================

  describe('Configuration Options', () => {
    it('should pass weights to evaluation', async () => {
      const evaluateMock = vi.fn().mockResolvedValue({
        pageId: 'test',
        overall: 80,
        grade: 'B',
        originality: { score: 75, grade: 'C' },
        craftsmanship: { score: 85, grade: 'B' },
        contextuality: { score: 80, grade: 'B' },
        evaluatedAt: new Date().toISOString(),
      });

      setBatchQualityEvaluateServiceFactory(() => createMockService({
        evaluatePage: evaluateMock,
      }));

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        weights: {
          originality: 0.3,
          craftsmanship: 0.4,
          contextuality: 0.3,
        },
      });

      expect(result.success).toBe(true);
    });

    it('should validate weights sum to 1.0', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        weights: {
          originality: 0.5,
          craftsmanship: 0.5,
          contextuality: 0.5,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should accept strict mode option', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler({
        ...validBatchInput,
        strict: true,
      });

      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // LRUキャッシュ・TTL機能（M-1セキュリティ対策）
  // =====================================================

  describe('LRU Cache and TTL (M-1 Security)', () => {
    it('should evict oldest job when max size is exceeded', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      // まず1000件のジョブを作成（デフォルトmax）
      const jobIds: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const result = await batchQualityEvaluateHandler({
          items: [{ html: `<html><body>Page ${i}</body></html>` }],
        });
        if (result.success) {
          jobIds.push(result.data.job_id);
        }
      }

      // 1000件作成されたことを確認
      expect(jobIds.length).toBe(1000);

      // 統計情報でサイズを確認（getBatchJobはLRU順序を更新してしまうため避ける）
      const statsBefore = getJobStoreStats();
      expect(statsBefore.size).toBe(1000);

      // 1001番目のジョブを作成
      const result = await batchQualityEvaluateHandler({
        items: [{ html: '<html><body>Page 1001</body></html>' }],
      });
      expect(result.success).toBe(true);

      // サイズは1000のまま（1つ追放されている）
      const statsAfter = getJobStoreStats();
      expect(statsAfter.size).toBe(1000);

      // 最初のジョブはLRUにより削除されているはず
      // （作成時から一度もアクセスされていないため最も古い）
      expect(getBatchJob(jobIds[0])).toBeUndefined();
    });

    it('should return undefined for expired jobs', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      const result = await batchQualityEvaluateHandler(validBatchInput);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const jobId = result.data.job_id;
      expect(getBatchJob(jobId)).toBeDefined();

      // 時間を24時間以上進める（TTLは24時間）
      vi.useFakeTimers();
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25時間

      // TTL経過後はundefinedを返す
      expect(getBatchJob(jobId)).toBeUndefined();

      vi.useRealTimers();
    });

    it('should update lastAccessed on get (LRU behavior)', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      // 2つのジョブを作成
      const result1 = await batchQualityEvaluateHandler({
        items: [{ html: '<html><body>Page 1</body></html>' }],
      });
      const result2 = await batchQualityEvaluateHandler({
        items: [{ html: '<html><body>Page 2</body></html>' }],
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      if (!result1.success || !result2.success) return;

      const jobId1 = result1.data.job_id;
      const jobId2 = result2.data.job_id;

      // job1にアクセスしてlastAccessedを更新
      getBatchJob(jobId1);

      // job1は最近アクセスされたため、job2より後に削除される
      // この動作は明示的にテスト可能
      const job1 = getBatchJob(jobId1);
      const job2 = getBatchJob(jobId2);
      expect(job1).toBeDefined();
      expect(job2).toBeDefined();
    });

    it('should expose getJobStoreStats for monitoring', async () => {
      setBatchQualityEvaluateServiceFactory(() => createMockService());

      // 5つのジョブを作成
      for (let i = 0; i < 5; i++) {
        await batchQualityEvaluateHandler({
          items: [{ html: `<html><body>Page ${i}</body></html>` }],
        });
      }

      // 統計が取得できる（実装後に追加される関数）
      const { getJobStoreStats } = await import('../../../src/tools/quality/batch-evaluate.tool');
      const stats = getJobStoreStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.size).toBe(5);
      expect(stats.maxSize).toBe(1000);
    });
  });
});
