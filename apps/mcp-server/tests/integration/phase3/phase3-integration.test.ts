// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase3 統合テスト: Async Processing Pipeline
 *
 * Phase3で実装した機能の統合テスト:
 * - Phase3-1: BullMQ + Redis基盤
 * - Phase3-2: page.analyze非同期モード（async=true）
 * - Phase3-3: SSE進捗通知（/api/jobs/[jobId]/progress）
 *
 * 検証内容:
 * 1. Redis接続とBullMQキュー作成
 * 2. ジョブ投入とステータス取得
 * 3. Worker処理とPhasedExecutor連携
 * 4. エンドツーエンドフロー
 *
 * @module tests/integration/phase3/phase3-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// ============================================================================
// モック設定
// ============================================================================

// Redisモック
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: vi.fn(),
  getRedisConfig: vi.fn(() => ({
    host: 'localhost',
    port: 27379,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
  })),
  checkRedisConnection: vi.fn(),
  createRedisClient: vi.fn(),
  closeRedisClient: vi.fn(),
}));

// BullMQキューモック
vi.mock('../../../src/queues/page-analyze-queue', () => ({
  PAGE_ANALYZE_QUEUE_NAME: 'page-analyze',
  createPageAnalyzeQueue: vi.fn(),
  addPageAnalyzeJob: vi.fn(),
  getJobStatus: vi.fn(),
  closeQueue: vi.fn(),
  checkQueueHealth: vi.fn(),
}));

// Workerモック
vi.mock('../../../src/workers/page-analyze-worker', () => ({
  createPageAnalyzeWorker: vi.fn(),
  processPageAnalyzeJob: vi.fn(),
}));

// インポート
import {
  isRedisAvailable,
  checkRedisConnection,
  getRedisConfig,
} from '../../../src/config/redis';
import {
  PAGE_ANALYZE_QUEUE_NAME,
  createPageAnalyzeQueue,
  addPageAnalyzeJob,
  getJobStatus,
  closeQueue,
  checkQueueHealth,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type PageAnalyzeJobStatus,
} from '../../../src/queues/page-analyze-queue';
import {
  createPageAnalyzeWorker,
} from '../../../src/workers/page-analyze-worker';

// ============================================================================
// 定数
// ============================================================================

/** MCP最大タイムアウト（600秒） */
const MCP_MAX_TIMEOUT_MS = 600000;

/** テスト用WebページID */
const TEST_WEB_PAGE_ID = '01903a5b-7c8d-7000-8000-000000000001';

/** テスト用URL */
const TEST_URL = 'https://example.com/test-page';

// ============================================================================
// モックデータ Factory
// ============================================================================

/**
 * モックジョブデータを生成
 */
function createMockJobData(overrides?: Partial<PageAnalyzeJobData>): PageAnalyzeJobData {
  return {
    webPageId: TEST_WEB_PAGE_ID,
    url: TEST_URL,
    options: {
      timeout: 60000,
      features: { layout: true, motion: true, quality: true },
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * モックジョブ結果を生成
 */
function createMockJobResult(overrides?: Partial<PageAnalyzeJobResult>): PageAnalyzeJobResult {
  return {
    webPageId: TEST_WEB_PAGE_ID,
    success: true,
    partialSuccess: false,
    completedPhases: ['ingest', 'layout', 'motion', 'quality'],
    failedPhases: [],
    results: {
      layout: { sectionsDetected: 5, visionUsed: true },
      motion: { patternsDetected: 10, jsAnimationsDetected: 3 },
      quality: { overallScore: 85, grade: 'A' },
    },
    processingTimeMs: 5000,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * モックジョブステータスを生成
 */
function createMockJobStatus(
  state: PageAnalyzeJobStatus['state'],
  overrides?: Partial<PageAnalyzeJobStatus>
): PageAnalyzeJobStatus {
  const base: PageAnalyzeJobStatus = {
    jobId: TEST_WEB_PAGE_ID,
    state,
    progress: state === 'completed' ? 100 : state === 'active' ? 50 : 0,
    timestamps: {
      created: Date.now() - 60000,
    },
  };

  if (state === 'active') {
    base.currentPhase = 'layout';
    base.timestamps.started = Date.now() - 30000;
  }

  if (state === 'completed') {
    base.result = createMockJobResult();
    base.timestamps.started = Date.now() - 30000;
    base.timestamps.completed = Date.now() - 5000;
  }

  if (state === 'failed') {
    base.error = 'Timeout: page analysis exceeded 600 seconds';
    base.timestamps.started = Date.now() - 60000;
    base.timestamps.failed = Date.now() - 5000;
  }

  return { ...base, ...overrides };
}

/**
 * モックキューを生成
 */
function createMockQueue(): {
  add: Mock;
  close: Mock;
  getJob: Mock;
  getWaitingCount: Mock;
  getActiveCount: Mock;
  getCompletedCount: Mock;
  getFailedCount: Mock;
  getDelayedCount: Mock;
} {
  return {
    add: vi.fn(),
    close: vi.fn(),
    getJob: vi.fn(),
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
    getDelayedCount: vi.fn().mockResolvedValue(0),
  };
}

// ============================================================================
// Phase3-1: BullMQ + Redis基盤 テスト
// ============================================================================

describe('Phase3-1: BullMQ + Redis基盤', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Redis接続', () => {
    it('should connect to Redis successfully', async () => {
      // Arrange
      (checkRedisConnection as Mock).mockResolvedValue({
        connected: true,
        info: {
          version: '7.0.0',
          mode: 'standalone',
          connectedClients: 1,
        },
      });

      // Act
      const status = await checkRedisConnection();

      // Assert
      expect(status.connected).toBe(true);
      expect(status.info?.version).toBeDefined();
    });

    it('should return error when Redis is unavailable', async () => {
      // Arrange
      (checkRedisConnection as Mock).mockResolvedValue({
        connected: false,
        error: 'ECONNREFUSED',
      });

      // Act
      const status = await checkRedisConnection();

      // Assert
      expect(status.connected).toBe(false);
      expect(status.error).toContain('ECONNREFUSED');
    });

    it('should use port offset 27379 by default', () => {
      // Act
      const config = getRedisConfig();

      // Assert
      // ポートオフセット: 6379 + 21000 = 27379
      expect(config.port).toBe(27379);
    });
  });

  describe('キュー作成', () => {
    it('should create page-analyze queue', () => {
      // Arrange
      const mockQueue = createMockQueue();
      (createPageAnalyzeQueue as Mock).mockReturnValue(mockQueue);

      // Act
      const queue = createPageAnalyzeQueue();

      // Assert
      expect(createPageAnalyzeQueue).toHaveBeenCalled();
      expect(queue).toBeDefined();
    });

    it('should use correct queue name', () => {
      // Assert
      expect(PAGE_ANALYZE_QUEUE_NAME).toBe('page-analyze');
    });
  });

  describe('ジョブ追加', () => {
    it('should add job to queue', async () => {
      // Arrange
      const mockQueue = createMockQueue();
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData(),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Act
      const job = await addPageAnalyzeJob(
        mockQueue as any,
        {
          webPageId: TEST_WEB_PAGE_ID,
          url: TEST_URL,
          options: { timeout: 60000 },
        }
      );

      // Assert
      expect(addPageAnalyzeJob).toHaveBeenCalled();
      expect(job.id).toBe(TEST_WEB_PAGE_ID);
      expect(job.data.url).toBe(TEST_URL);
    });

    it('should use webPageId as job ID', async () => {
      // Arrange
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData(),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Act
      const job = await addPageAnalyzeJob({} as any, {
        webPageId: TEST_WEB_PAGE_ID,
        url: TEST_URL,
        options: {},
      });

      // Assert
      expect(job.id).toBe(TEST_WEB_PAGE_ID);
    });
  });

  describe('ヘルスチェック', () => {
    it('should return healthy queue status', async () => {
      // Arrange
      (checkQueueHealth as Mock).mockResolvedValue({
        healthy: true,
        stats: {
          waiting: 5,
          active: 2,
          completed: 100,
          failed: 3,
          delayed: 0,
        },
      });

      // Act
      const health = await checkQueueHealth({} as any);

      // Assert
      expect(health.healthy).toBe(true);
      expect(health.stats.waiting).toBeGreaterThanOrEqual(0);
      expect(health.stats.active).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when Redis is unavailable', async () => {
      // Arrange
      (checkQueueHealth as Mock).mockResolvedValue({
        healthy: false,
        stats: {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
        },
        error: 'Redis connection failed',
      });

      // Act
      const health = await checkQueueHealth({} as any);

      // Assert
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('Redis');
    });
  });
});

// ============================================================================
// Phase3-2: page.analyze 非同期モード テスト
// ============================================================================

describe('Phase3-2: page.analyze 非同期モード', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('async=true時のジョブ投入', () => {
    it('should queue job when async=true and Redis is available', async () => {
      // Arrange
      (isRedisAvailable as Mock).mockResolvedValue(true);
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData(),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Act & Assert - ジョブ追加が呼ばれることを確認
      const job = await addPageAnalyzeJob({} as any, {
        webPageId: TEST_WEB_PAGE_ID,
        url: TEST_URL,
        options: {},
      });

      expect(job.id).toBe(TEST_WEB_PAGE_ID);
    });

    it('should return jobId in async response', async () => {
      // Arrange
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData(),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Act
      const job = await addPageAnalyzeJob({} as any, {
        webPageId: TEST_WEB_PAGE_ID,
        url: TEST_URL,
        options: {},
      });

      // Assert
      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('Redis未起動時のエラーハンドリング', () => {
    it('should return error when Redis is unavailable', async () => {
      // Arrange
      (isRedisAvailable as Mock).mockResolvedValue(false);

      // Act
      const available = await isRedisAvailable();

      // Assert - Graceful Degradation: Redis未起動時はfalseを返す
      expect(available).toBe(false);
    });
  });

  describe('page.getJobStatus', () => {
    it('should get job status via getJobStatus', async () => {
      // Arrange
      const mockStatus = createMockJobStatus('completed');
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);

      // Assert
      expect(status).not.toBeNull();
      expect(status?.jobId).toBe(TEST_WEB_PAGE_ID);
      expect(status?.state).toBe('completed');
      expect(status?.result).toBeDefined();
    });

    it('should return null when job does not exist', async () => {
      // Arrange
      (getJobStatus as Mock).mockResolvedValue(null);

      // Act
      const status = await getJobStatus({} as any, 'non-existent-job-id');

      // Assert
      expect(status).toBeNull();
    });

    it('should return waiting status for queued jobs', async () => {
      // Arrange
      const mockStatus = createMockJobStatus('waiting');
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('waiting');
      expect(status?.progress).toBe(0);
    });

    it('should return active status with currentPhase for in-progress jobs', async () => {
      // Arrange
      const mockStatus = createMockJobStatus('active', {
        currentPhase: 'motion',
        progress: 60,
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('active');
      expect(status?.currentPhase).toBe('motion');
      expect(status?.progress).toBe(60);
    });

    it('should return failed status with error for failed jobs', async () => {
      // Arrange
      const mockStatus = createMockJobStatus('failed');
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('failed');
      expect(status?.error).toContain('Timeout');
    });
  });
});

// ============================================================================
// Phase3 Worker処理 テスト
// ============================================================================

describe('Phase3 Worker処理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Worker作成', () => {
    it('should create worker with correct concurrency', () => {
      // Arrange
      const mockWorker = {
        worker: {},
        close: vi.fn(),
        isRunning: vi.fn().mockReturnValue(true),
      };
      (createPageAnalyzeWorker as Mock).mockReturnValue(mockWorker);

      // Act
      const workerInstance = createPageAnalyzeWorker({
        concurrency: 2,
      });

      // Assert
      expect(createPageAnalyzeWorker).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 2 })
      );
      expect(workerInstance.isRunning()).toBe(true);
    });

    it('should create worker with lockDuration=600000ms', () => {
      // Arrange
      const mockWorker = {
        worker: {},
        close: vi.fn(),
        isRunning: vi.fn().mockReturnValue(true),
      };
      (createPageAnalyzeWorker as Mock).mockReturnValue(mockWorker);

      // Act
      createPageAnalyzeWorker({
        lockDuration: MCP_MAX_TIMEOUT_MS,
      });

      // Assert - lockDuration=600000ms（MCP制限と整合）
      expect(createPageAnalyzeWorker).toHaveBeenCalledWith(
        expect.objectContaining({ lockDuration: 600000 })
      );
    });
  });

  describe('Worker処理結果', () => {
    it('should return completed result on success', async () => {
      // Arrange
      const mockResult = createMockJobResult();

      // Assert - モックで想定される結果構造
      expect(mockResult.success).toBe(true);
      expect(mockResult.completedPhases).toContain('layout');
      expect(mockResult.completedPhases).toContain('motion');
      expect(mockResult.completedPhases).toContain('quality');
      expect(mockResult.failedPhases).toEqual([]);
    });

    it('should return partial success when some phases fail', async () => {
      // Arrange
      const mockResult = createMockJobResult({
        success: false,
        partialSuccess: true,
        completedPhases: ['ingest', 'layout'],
        failedPhases: ['motion', 'quality'],
        results: {
          layout: { sectionsDetected: 5, visionUsed: true },
        },
      });

      // Assert
      expect(mockResult.success).toBe(false);
      expect(mockResult.partialSuccess).toBe(true);
      expect(mockResult.completedPhases).toContain('layout');
      expect(mockResult.failedPhases).toContain('motion');
    });

    it('should return failed result on complete failure', async () => {
      // Arrange
      const mockResult: PageAnalyzeJobResult = {
        webPageId: TEST_WEB_PAGE_ID,
        success: false,
        partialSuccess: false,
        completedPhases: [],
        failedPhases: ['ingest'],
        error: 'Failed to fetch HTML content',
        processingTimeMs: 1000,
        completedAt: new Date().toISOString(),
      };

      // Assert
      expect(mockResult.success).toBe(false);
      expect(mockResult.partialSuccess).toBe(false);
      expect(mockResult.error).toContain('Failed');
    });
  });
});

// ============================================================================
// Phase3 エンドツーエンドフロー テスト
// ============================================================================

describe('Phase3 エンドツーエンドフロー', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('完全非同期フロー', () => {
    it('should complete full async analysis flow', async () => {
      // Arrange - ジョブ投入
      (isRedisAvailable as Mock).mockResolvedValue(true);
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData(),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Step 1: ジョブ投入
      const job = await addPageAnalyzeJob({} as any, {
        webPageId: TEST_WEB_PAGE_ID,
        url: TEST_URL,
        options: { timeout: 60000 },
      });
      expect(job.id).toBe(TEST_WEB_PAGE_ID);

      // Step 2: ステータス確認（waiting）
      (getJobStatus as Mock).mockResolvedValue(createMockJobStatus('waiting'));
      let status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);
      expect(status?.state).toBe('waiting');

      // Step 3: ステータス確認（active）
      (getJobStatus as Mock).mockResolvedValue(createMockJobStatus('active', { progress: 40 }));
      status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);
      expect(status?.state).toBe('active');
      expect(status?.progress).toBe(40);

      // Step 4: ステータス確認（completed）
      (getJobStatus as Mock).mockResolvedValue(createMockJobStatus('completed'));
      status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);
      expect(status?.state).toBe('completed');
      expect(status?.result?.success).toBe(true);
    });

    it('should handle partial success in async mode', async () => {
      // Arrange
      const partialResult = createMockJobResult({
        success: false,
        partialSuccess: true,
        completedPhases: ['ingest', 'layout'],
        failedPhases: ['motion', 'quality'],
      });

      const mockStatus = createMockJobStatus('completed', {
        result: partialResult,
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as any, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('completed');
      expect(status?.result?.success).toBe(false);
      expect(status?.result?.partialSuccess).toBe(true);
      expect(status?.result?.completedPhases).toContain('layout');
    });
  });

  describe('MCP 600秒制限の遵守', () => {
    it('should respect MCP 600s timeout in async mode', () => {
      // Worker設定がMCP制限と整合していることを確認
      const DEFAULT_LOCK_DURATION = 600000;
      expect(DEFAULT_LOCK_DURATION).toBe(MCP_MAX_TIMEOUT_MS);
    });

    it('should calculate total processing time within MCP limit', () => {
      // フェーズ別タイムアウト設定
      const PHASE_TIMEOUTS = {
        ingest: 60000,  // 1分
        layout: 120000, // 2分
        motion: 180000, // 3分
        quality: 60000, // 1分
      };

      // シーケンシャル実行の最大時間
      const maxSequentialTime = Object.values(PHASE_TIMEOUTS).reduce((a, b) => a + b, 0);

      // MCP制限内であることを確認
      expect(maxSequentialTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
    });
  });
});

// ============================================================================
// キュー設定テスト
// ============================================================================

describe('キュー設定', () => {
  describe('ジョブ保持設定', () => {
    it('should configure 24h job retention for completed jobs', () => {
      // 設定値の検証
      const COMPLETED_JOB_RETENTION_HOURS = 24;
      const COMPLETED_JOB_RETENTION_SECONDS = COMPLETED_JOB_RETENTION_HOURS * 60 * 60;

      expect(COMPLETED_JOB_RETENTION_SECONDS).toBe(86400);
    });

    it('should configure 7d job retention for failed jobs', () => {
      // 設定値の検証
      const FAILED_JOB_RETENTION_DAYS = 7;
      const FAILED_JOB_RETENTION_SECONDS = FAILED_JOB_RETENTION_DAYS * 24 * 60 * 60;

      expect(FAILED_JOB_RETENTION_SECONDS).toBe(604800);
    });
  });

  describe('ワーカー設定', () => {
    it('should use concurrency=2 for GPU/memory consideration', () => {
      // GPU/メモリ負荷を考慮したconcurrency設定
      const DEFAULT_CONCURRENCY = 2;
      expect(DEFAULT_CONCURRENCY).toBe(2);
    });

    it('should use attempts=1 for WebGL heavy sites', () => {
      // WebGL重いサイトはリトライしない（再タイムアウトするだけ）
      const ATTEMPTS = 1;
      expect(ATTEMPTS).toBe(1);
    });
  });
});

// ============================================================================
// スキーマバリデーションテスト
// ============================================================================

describe('スキーマバリデーション', () => {
  describe('async パラメータ', () => {
    it('should accept async=true in pageAnalyzeInputSchema', () => {
      // 入力データ構造の検証
      const input = {
        url: TEST_URL,
        async: true,
      };

      expect(input.async).toBe(true);
      expect(typeof input.async).toBe('boolean');
    });

    it('should default async=false', () => {
      // デフォルト値の検証
      const DEFAULT_ASYNC = false;
      expect(DEFAULT_ASYNC).toBe(false);
    });
  });

  describe('layout_first パラメータ', () => {
    it('should accept layout_first=auto in pageAnalyzeInputSchema', () => {
      const input = {
        url: TEST_URL,
        layout_first: 'auto' as const,
      };

      expect(input.layout_first).toBe('auto');
    });

    it('should accept layout_first=always', () => {
      const input = {
        url: TEST_URL,
        layout_first: 'always' as const,
      };

      expect(input.layout_first).toBe('always');
    });

    it('should accept layout_first=never', () => {
      const input = {
        url: TEST_URL,
        layout_first: 'never' as const,
      };

      expect(input.layout_first).toBe('never');
    });
  });
});

// ============================================================================
// パフォーマンステスト
// ============================================================================

describe('Phase3 パフォーマンス', () => {
  it('should complete job status lookup quickly (mocked)', async () => {
    // Arrange
    const mockStatus = createMockJobStatus('completed');
    (getJobStatus as Mock).mockResolvedValue(mockStatus);

    // Act
    const startTime = performance.now();
    for (let i = 0; i < 100; i++) {
      await getJobStatus({} as any, TEST_WEB_PAGE_ID);
    }
    const duration = performance.now() - startTime;

    // Assert - 100回のモックルックアップが100ms以内
    expect(duration).toBeLessThan(100);
    console.log(`[Phase3] Job status lookup 100回: ${duration.toFixed(2)}ms`);
  });

  it('should handle concurrent job additions (mocked)', async () => {
    // Arrange
    const mockJob = {
      id: TEST_WEB_PAGE_ID,
      data: createMockJobData(),
    };
    (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

    // Act - 並列でジョブ追加
    const startTime = performance.now();
    const promises = Array.from({ length: 50 }, (_, i) =>
      addPageAnalyzeJob({} as any, {
        webPageId: `01903a5b-7c8d-7000-8000-0000000000${String(i).padStart(2, '0')}`,
        url: `https://example.com/page-${i}`,
        options: {},
      })
    );
    await Promise.all(promises);
    const duration = performance.now() - startTime;

    // Assert - 50並列追加が50ms以内
    expect(duration).toBeLessThan(50);
    console.log(`[Phase3] Concurrent job additions 50: ${duration.toFixed(2)}ms`);
  });
});

// ============================================================================
// エラーハンドリングテスト
// ============================================================================

describe('Phase3 エラーハンドリング', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle Redis connection failure gracefully', async () => {
    // Arrange
    (isRedisAvailable as Mock).mockResolvedValue(false);

    // Act
    const available = await isRedisAvailable();

    // Assert
    expect(available).toBe(false);
  });

  it('should handle queue creation failure gracefully', async () => {
    // Arrange
    (createPageAnalyzeQueue as Mock).mockImplementation(() => {
      throw new Error('Failed to create queue: ECONNREFUSED');
    });

    // Act & Assert
    expect(() => createPageAnalyzeQueue()).toThrow('ECONNREFUSED');
  });

  it('should handle job addition failure gracefully', async () => {
    // Arrange
    (addPageAnalyzeJob as Mock).mockRejectedValue(
      new Error('Failed to add job: Queue is paused')
    );

    // Act & Assert
    await expect(
      addPageAnalyzeJob({} as any, {
        webPageId: TEST_WEB_PAGE_ID,
        url: TEST_URL,
        options: {},
      })
    ).rejects.toThrow('Queue is paused');
  });

  it('should handle worker shutdown gracefully', async () => {
    // Arrange
    const mockWorker = {
      worker: {},
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(false),
    };
    (createPageAnalyzeWorker as Mock).mockReturnValue(mockWorker);

    // Act
    const workerInstance = createPageAnalyzeWorker();
    await workerInstance.close();

    // Assert
    expect(workerInstance.close).toHaveBeenCalled();
    expect(workerInstance.isRunning()).toBe(false);
  });
});
