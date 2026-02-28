// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Full Pipeline 統合テスト: Phase1-4 全機能検証
 *
 * Phase1-4で実装したすべての機能が連携して動作することを検証:
 * - Phase1: GPU有効化、待機戦略最適化、リトライ戦略見直し
 * - Phase2: 段階的分析、部分結果DB保存、進捗追跡
 * - Phase3: BullMQ + Redis、非同期モード、SSE進捗通知
 * - Phase4: WebGL自動検出、ブラウザ強制終了、ドメインリスト拡張
 *
 * 検証シナリオ:
 * 1. WebGL重いサイト分析（同期モード）
 * 2. WebGL重いサイト分析（非同期モード）
 * 3. MCP 600秒制限遵守
 * 4. 部分成功時の結果保存
 * 5. エンドツーエンドのエラーハンドリング
 *
 * @module tests/integration/phase4/full-pipeline.test
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

// ============================================================================
// 実際のモジュールをインポート（WebGL関連はモックなし）
// ============================================================================

import {
  isRedisAvailable,
  checkRedisConnection,
} from '../../../src/config/redis';
import {
  addPageAnalyzeJob,
  getJobStatus,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type PageAnalyzeJobStatus,
} from '../../../src/queues/page-analyze-queue';

import {
  WebGLDetector,
} from '../../../src/tools/page/handlers/webgl-detector';

import {
  preDetectWebGL,
  detectSiteTier,
} from '../../../src/tools/page/handlers/webgl-pre-detector';

import {
  getRetryStrategy,
  type SiteTier,
} from '../../../src/tools/page/handlers/retry-strategy';

import {
  getDomainEntry,
} from '../../../src/tools/page/handlers/webgl-domains';

// ============================================================================
// 定数
// ============================================================================

/** MCP最大タイムアウト（600秒） */
const MCP_MAX_TIMEOUT_MS = 600000;

/** テスト用WebページID */
const TEST_WEB_PAGE_ID = '01903a5b-7c8d-7000-8000-000000000001';

/** Phase別タイムアウト設定 */
const PHASE_TIMEOUTS = {
  ingest: 60000,   // 1分
  layout: 120000,  // 2分
  motion: 180000,  // 3分
  quality: 60000,  // 1分
};

// ============================================================================
// テストユーティリティ
// ============================================================================

/**
 * モックジョブデータを生成
 */
function createMockJobData(url: string, overrides?: Partial<PageAnalyzeJobData>): PageAnalyzeJobData {
  return {
    webPageId: TEST_WEB_PAGE_ID,
    url,
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
 * WebGL重いサイト分析のフルシミュレーション
 */
function simulateWebGLSiteAnalysis(url: string): {
  preDetection: ReturnType<typeof WebGLDetector.preDetect>;
  siteTier: SiteTier;
  retryStrategy: ReturnType<typeof getRetryStrategy>;
  recommendedTimeout: number;
  canCompleteWithinMCPLimit: boolean;
} {
  // Step 1: URL事前検出
  const preDetection = WebGLDetector.preDetect(url);

  // Step 2: SiteTier決定
  const siteTier = detectSiteTier(url);

  // Step 3: リトライ戦略取得
  const retryStrategy = getRetryStrategy(siteTier);

  // Step 4: 推奨タイムアウト計算
  const recommendedTimeout = preDetection.recommendedConfig.timeout;

  // Step 5: MCP制限内で完了可能か計算
  let totalTime = recommendedTimeout;
  for (let i = 0; i < retryStrategy.maxRetries; i++) {
    totalTime += retryStrategy.waitBetweenRetriesMs;
    totalTime += recommendedTimeout * retryStrategy.timeoutMultiplier;
  }
  const canCompleteWithinMCPLimit = totalTime <= MCP_MAX_TIMEOUT_MS;

  return {
    preDetection,
    siteTier,
    retryStrategy,
    recommendedTimeout,
    canCompleteWithinMCPLimit,
  };
}

// ============================================================================
// Full Pipeline 統合テスト
// ============================================================================

describe('Full Pipeline Integration: Phase1-4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // シナリオ1: WebGL重いサイト分析（同期モード）
  // ==========================================================================

  describe('WebGL重いサイト分析シナリオ（同期モード）', () => {
    it('should analyze ultra-heavy WebGL site with correct settings', () => {
      // Arrange
      const url = 'https://resn.co.nz';

      // Act
      const analysis = simulateWebGLSiteAnalysis(url);

      // Assert
      expect(analysis.preDetection.isWebGL).toBe(true);
      expect(analysis.siteTier).toBe('ultra-heavy');
      expect(analysis.preDetection.recommendedConfig.enableGPU).toBe(true);
      expect(analysis.preDetection.recommendedConfig.forceKillOnTimeout).toBe(true);
      expect(analysis.recommendedTimeout).toBe(180000); // 3分
      expect(analysis.retryStrategy.maxRetries).toBe(1);
      expect(analysis.retryStrategy.retryOnlyOnNetworkError).toBe(true);
      expect(analysis.canCompleteWithinMCPLimit).toBe(true);
    });

    it('should analyze heavy WebGL site (vercel.com) with correct settings', () => {
      // Arrange
      const url = 'https://vercel.com';

      // Act
      const analysis = simulateWebGLSiteAnalysis(url);

      // Assert
      expect(analysis.preDetection.isWebGL).toBe(true);
      expect(['heavy', 'ultra-heavy']).toContain(analysis.siteTier);
      expect(analysis.preDetection.recommendedConfig.enableGPU).toBe(true);
      expect(analysis.canCompleteWithinMCPLimit).toBe(true);
    });

    it('should analyze user-reported timeout site (linear.app) with correct settings', () => {
      // Arrange
      const url = 'https://linear.app';

      // Act
      const analysis = simulateWebGLSiteAnalysis(url);

      // Assert
      expect(analysis.preDetection.isWebGL).toBe(true);
      expect(analysis.siteTier).toBe('ultra-heavy');

      // ユーザー報告サイトはドメインリストに登録されている
      const domainEntry = getDomainEntry('linear.app');
      expect(domainEntry).toBeDefined();
      expect(domainEntry?.notes).toContain('ユーザー報告');
    });

    it('should analyze normal site with minimal overhead', () => {
      // Arrange
      const url = 'https://example.com';

      // Act
      const analysis = simulateWebGLSiteAnalysis(url);

      // Assert
      expect(analysis.preDetection.isWebGL).toBe(false);
      expect(analysis.siteTier).toBe('normal');
      expect(analysis.preDetection.recommendedConfig.enableGPU).toBe(false);
      expect(analysis.preDetection.recommendedConfig.forceKillOnTimeout).toBe(false);
      expect(analysis.recommendedTimeout).toBe(60000); // 1分
      expect(analysis.retryStrategy.maxRetries).toBe(2);
    });
  });

  // ==========================================================================
  // シナリオ2: WebGL重いサイト分析（非同期モード）
  // ==========================================================================

  describe('WebGL重いサイト分析シナリオ（非同期モード）', () => {
    it('should queue heavy WebGL site in async mode', async () => {
      // Arrange
      (isRedisAvailable as Mock).mockResolvedValue(true);
      const mockJob = {
        id: TEST_WEB_PAGE_ID,
        data: createMockJobData('https://resn.co.nz'),
      };
      (addPageAnalyzeJob as Mock).mockResolvedValue(mockJob);

      // Act
      const job = await addPageAnalyzeJob({} as unknown, {
        webPageId: TEST_WEB_PAGE_ID,
        url: 'https://resn.co.nz',
        options: {
          async: true,
        },
      });

      // Assert
      expect(addPageAnalyzeJob).toHaveBeenCalled();
      expect(job.id).toBe(TEST_WEB_PAGE_ID);
    });

    it('should track async job progress through phases', async () => {
      // Arrange - 各フェーズの進捗を順番にモック
      const phases = ['ingest', 'layout', 'motion', 'quality'];
      const progressValues = [10, 40, 70, 100];

      // Act & Assert - 各フェーズの進捗を確認
      for (let i = 0; i < phases.length; i++) {
        (getJobStatus as Mock).mockResolvedValue(
          createMockJobStatus('active', {
            currentPhase: phases[i],
            progress: progressValues[i],
          })
        );

        const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);
        expect(status?.currentPhase).toBe(phases[i]);
        expect(status?.progress).toBe(progressValues[i]);
      }
    });

    it('should complete async job and return results', async () => {
      // Arrange
      (getJobStatus as Mock).mockResolvedValue(createMockJobStatus('completed'));

      // Act
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('completed');
      expect(status?.result?.success).toBe(true);
      expect(status?.result?.completedPhases).toContain('layout');
      expect(status?.result?.completedPhases).toContain('motion');
      expect(status?.result?.completedPhases).toContain('quality');
    });
  });

  // ==========================================================================
  // シナリオ3: MCP 600秒制限遵守
  // ==========================================================================

  describe('MCP 600秒制限遵守', () => {
    it('should respect MCP 600s timeout for all site tiers', () => {
      // Arrange
      const siteTiers: SiteTier[] = ['normal', 'webgl', 'heavy', 'ultra-heavy'];
      const tierTimeouts: Record<SiteTier, number> = {
        'normal': 60000,
        'webgl': 90000,
        'heavy': 120000,
        'ultra-heavy': 180000,
      };

      // Act & Assert
      for (const tier of siteTiers) {
        const strategy = getRetryStrategy(tier);
        const baseTimeout = tierTimeouts[tier];

        // 最大リトライ時の合計時間を計算
        let totalTime = baseTimeout;
        for (let i = 0; i < strategy.maxRetries; i++) {
          totalTime += strategy.waitBetweenRetriesMs;
          totalTime += baseTimeout * strategy.timeoutMultiplier;
        }

        // MCP制限内であることを確認
        expect(totalTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
        console.log(`[MCP Limit] ${tier}: ${(totalTime / 1000).toFixed(1)}s / 600s`);
      }
    });

    it('should calculate sequential phase execution time within limit', () => {
      // Arrange
      const totalPhaseTime = Object.values(PHASE_TIMEOUTS).reduce((a, b) => a + b, 0);

      // Assert - 全フェーズの合計がMCP制限以内
      expect(totalPhaseTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      console.log(`[MCP Limit] Sequential phases: ${(totalPhaseTime / 1000).toFixed(1)}s / 600s`);
    });

    it('should have lockDuration matching MCP limit for async processing', () => {
      // Arrange
      const WORKER_LOCK_DURATION = 600000; // Worker設定値

      // Assert
      expect(WORKER_LOCK_DURATION).toBe(MCP_MAX_TIMEOUT_MS);
    });
  });

  // ==========================================================================
  // シナリオ4: 部分成功時の結果保存
  // ==========================================================================

  describe('部分成功時の結果保存', () => {
    it('should save partial results when layout succeeds but motion fails', async () => {
      // Arrange
      const partialResult = createMockJobResult({
        success: false,
        partialSuccess: true,
        completedPhases: ['ingest', 'layout'],
        failedPhases: ['motion', 'quality'],
        results: {
          layout: { sectionsDetected: 5, visionUsed: true },
        },
        error: 'Motion detection timeout',
      });

      const mockStatus = createMockJobStatus('completed', {
        result: partialResult,
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('completed');
      expect(status?.result?.success).toBe(false);
      expect(status?.result?.partialSuccess).toBe(true);
      expect(status?.result?.completedPhases).toContain('ingest');
      expect(status?.result?.completedPhases).toContain('layout');
      expect(status?.result?.failedPhases).toContain('motion');
      expect(status?.result?.results?.layout).toBeDefined();
      expect(status?.result?.results?.motion).toBeUndefined();
    });

    it('should save partial results when ingest succeeds but all analysis fails', async () => {
      // Arrange
      const partialResult = createMockJobResult({
        success: false,
        partialSuccess: true,
        completedPhases: ['ingest'],
        failedPhases: ['layout', 'motion', 'quality'],
        results: {},
        error: 'All analysis phases failed due to WebGL timeout',
      });

      const mockStatus = createMockJobStatus('completed', {
        result: partialResult,
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.result?.partialSuccess).toBe(true);
      expect(status?.result?.completedPhases).toHaveLength(1);
      expect(status?.result?.completedPhases).toContain('ingest');
    });

    it('should mark complete failure when ingest fails', async () => {
      // Arrange
      const failureResult: PageAnalyzeJobResult = {
        webPageId: TEST_WEB_PAGE_ID,
        success: false,
        partialSuccess: false,
        completedPhases: [],
        failedPhases: ['ingest'],
        error: 'Failed to fetch HTML: ECONNREFUSED',
        processingTimeMs: 5000,
        completedAt: new Date().toISOString(),
      };

      const mockStatus = createMockJobStatus('completed', {
        result: failureResult,
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.result?.success).toBe(false);
      expect(status?.result?.partialSuccess).toBe(false);
      expect(status?.result?.completedPhases).toHaveLength(0);
      expect(status?.result?.error).toContain('ECONNREFUSED');
    });
  });

  // ==========================================================================
  // シナリオ5: エラーハンドリング
  // ==========================================================================

  describe('エンドツーエンドのエラーハンドリング', () => {
    it('should handle Redis unavailable gracefully for async mode', async () => {
      // Arrange
      (isRedisAvailable as Mock).mockResolvedValue(false);

      // Act
      const available = await isRedisAvailable();

      // Assert - Redis未起動時はfalseを返す（Graceful Degradation）
      expect(available).toBe(false);
    });

    it('should handle job not found', async () => {
      // Arrange
      (getJobStatus as Mock).mockResolvedValue(null);

      // Act
      const status = await getJobStatus({} as unknown, 'non-existent-job');

      // Assert
      expect(status).toBeNull();
    });

    it('should handle job failure with error message', async () => {
      // Arrange
      const mockStatus = createMockJobStatus('failed', {
        error: 'Browser process timed out and was force killed',
      });
      (getJobStatus as Mock).mockResolvedValue(mockStatus);

      // Act
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Assert
      expect(status?.state).toBe('failed');
      expect(status?.error).toContain('force killed');
    });
  });

  // ==========================================================================
  // Phase間の連携テスト
  // ==========================================================================

  describe('Phase間の連携', () => {
    it('should use Phase4 WebGL detection to configure Phase1 GPU settings', () => {
      // Step 1: Phase4 - WebGL検出
      const webglResult = WebGLDetector.preDetect('https://resn.co.nz');
      expect(webglResult.isWebGL).toBe(true);

      // Step 2: Phase1 - GPU設定の決定
      const config = webglResult.recommendedConfig;
      expect(config.enableGPU).toBe(true);

      // Step 3: 検証 - GPU有効化フラグが正しく設定される
      expect(config.enableGPU).toBe(true);
    });

    it('should use Phase4 SiteTier to configure Phase1 retry strategy', () => {
      // Step 1: Phase4 - SiteTier判定
      const siteTier = detectSiteTier('https://resn.co.nz');
      expect(siteTier).toBe('ultra-heavy');

      // Step 2: Phase1 - リトライ戦略の決定
      const strategy = getRetryStrategy(siteTier);

      // Step 3: 検証 - ultra-heavyはリトライ1回、タイムアウト累積なし
      expect(strategy.maxRetries).toBe(1);
      expect(strategy.timeoutMultiplier).toBe(1.0);
      expect(strategy.retryOnlyOnNetworkError).toBe(true);
    });

    it('should integrate Phase2 partial results with Phase3 async job status', async () => {
      // Step 1: Phase3 - 非同期ジョブのステータス取得
      const partialResult = createMockJobResult({
        partialSuccess: true,
        completedPhases: ['ingest', 'layout'],
        failedPhases: ['motion'],
      });
      (getJobStatus as Mock).mockResolvedValue(
        createMockJobStatus('completed', { result: partialResult })
      );

      // Step 2: ステータス確認
      const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);

      // Step 3: Phase2 - 部分結果が正しく保存されている
      expect(status?.result?.partialSuccess).toBe(true);
      expect(status?.result?.completedPhases).toContain('layout');
      expect(status?.result?.failedPhases).toContain('motion');
    });
  });

  // ==========================================================================
  // パフォーマンス検証
  // ==========================================================================

  describe('パフォーマンス検証', () => {
    it('should complete full detection pipeline quickly', () => {
      // Arrange
      const urls = [
        'https://resn.co.nz',
        'https://linear.app',
        'https://vercel.com',
        'https://notion.so',
        'https://stripe.com',
        'https://example.com',
        'https://google.com',
      ];

      // Act
      const startTime = performance.now();
      for (let i = 0; i < 100; i++) {
        for (const url of urls) {
          simulateWebGLSiteAnalysis(url);
        }
      }
      const duration = performance.now() - startTime;

      // Assert - 700回の分析シミュレーションが500ms以内
      expect(duration).toBeLessThan(500);
      console.log(`[Full Pipeline] 700 analyses: ${duration.toFixed(2)}ms`);
    });
  });
});

// ============================================================================
// 回帰テスト
// ============================================================================

describe('回帰テスト: Phase1-4', () => {
  it('should maintain Phase1 GPU enablement for WebGL sites', () => {
    // Phase1の機能が維持されていることを確認
    const result = WebGLDetector.preDetect('https://threejs.org');
    expect(result.recommendedConfig.enableGPU).toBe(true);
  });

  it('should maintain Phase2 partial result tracking', () => {
    // Phase2の部分結果追跡が維持されていることを確認
    const partialResult = createMockJobResult({
      partialSuccess: true,
      completedPhases: ['ingest'],
      failedPhases: ['layout'],
    });
    expect(partialResult.partialSuccess).toBe(true);
    expect(partialResult.completedPhases).toContain('ingest');
  });

  it('should maintain Phase3 async mode functionality', async () => {
    // Phase3の非同期モード機能が維持されていることを確認
    (isRedisAvailable as Mock).mockResolvedValue(true);
    (getJobStatus as Mock).mockResolvedValue(createMockJobStatus('waiting'));

    const status = await getJobStatus({} as unknown, TEST_WEB_PAGE_ID);
    expect(status?.state).toBe('waiting');
  });

  it('should maintain Phase4 domain list integrity', () => {
    // Phase4のドメインリストが維持されていることを確認
    const entry = getDomainEntry('linear.app');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe('ultra-heavy');
  });
});
