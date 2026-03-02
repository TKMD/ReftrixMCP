// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * system.health MCPツール テスト
 *
 * テスト対象: system.health ツールハンドラー
 *
 * このテストは以下を検証します:
 * - McpResponse形式のレスポンスフォーマット（success/data/error/metadata）
 * - エラーハンドリング
 * - サービス初期化状態の表示（MCP-INIT-02）
 * - パターンサービス健全性（REFTRIX-PATTERN-01）
 * - ツールレベルの可用性（REFTRIX-HEALTH-01）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { systemHealthHandler, systemHealthToolDefinition, type SystemHealthHandlerResponse } from '../../src/tools/system-health';

// service-initializer モジュールをモック
vi.mock('../../src/services/service-initializer', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/service-initializer')>(
    '../../src/services/service-initializer'
  );
  return {
    ...actual,
    getLastInitializationResult: vi.fn(),
  };
});

// quality/evaluate.tool モジュールをモック（パターンサービス）
vi.mock('../../src/tools/quality/evaluate.tool', async () => {
  const actual = await vi.importActual<typeof import('../../src/tools/quality/evaluate.tool')>(
    '../../src/tools/quality/evaluate.tool'
  );
  return {
    ...actual,
    getPatternMatcherServiceFactory: vi.fn(),
    getBenchmarkServiceFactory: vi.fn(),
  };
});

// css-analysis-cache.service モジュールをモック（MCP-CACHE-02）
vi.mock('../../src/services/css-analysis-cache.service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/css-analysis-cache.service')>(
    '../../src/services/css-analysis-cache.service'
  );
  return {
    ...actual,
    getCSSAnalysisCacheService: vi.fn(() => ({
      getStats: vi.fn().mockResolvedValue({
        layoutInspect: { hits: 10, misses: 5, hitRate: 0.67, size: 15 },
        motionDetect: { hits: 8, misses: 4, hitRate: 0.67, size: 12 },
        totalHits: 18,
        totalMisses: 9,
        totalHitRate: 0.67,
        totalSize: 27,
        maxSize: 5000,
        diskUsageBytes: 1024,
      }),
    })),
  };
});

import { getLastInitializationResult } from '../../src/services/service-initializer';
import { getPatternMatcherServiceFactory, getBenchmarkServiceFactory } from '../../src/tools/quality/evaluate.tool';
import { getCSSAnalysisCacheService } from '../../src/services/css-analysis-cache.service';
import { HardwareDetector, HardwareType } from '../../src/services/vision/hardware-detector';

// HardwareDetector モジュールをモック
// Note: vi.hoisted() でモック関数を先にホイスティングし、vi.mock()内で参照可能にする
const {
  mockDetect,
  mockIsForceCpuModeEnabled,
  mockClearCache,
} = vi.hoisted(() => ({
  mockDetect: vi.fn(),
  mockIsForceCpuModeEnabled: vi.fn(),
  mockClearCache: vi.fn(),
}));

vi.mock('../../src/services/vision/hardware-detector', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/vision/hardware-detector')>(
    '../../src/services/vision/hardware-detector'
  );

  // クラスとしてモックを定義（Vitest要件: "function" or "class" in implementation）
  class MockHardwareDetector {
    detect = mockDetect;
    isForceCpuModeEnabled = mockIsForceCpuModeEnabled;
    clearCache = mockClearCache;
  }

  return {
    ...actual,
    HardwareDetector: MockHardwareDetector,
  };
});

describe('system.health MCPツール', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  const mockGetPatternMatcherServiceFactory = vi.mocked(getPatternMatcherServiceFactory);
  const mockGetBenchmarkServiceFactory = vi.mocked(getBenchmarkServiceFactory);

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    // デフォルトでパターンサービスを利用可能に設定
    mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
    mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));
    // HardwareDetectorモックのデフォルト設定（Vision CPU完走保証診断用）
    // Note: HardwareType.CPUはモジュールがモックされているため、文字列'CPU'を使用
    mockDetect.mockResolvedValue({
      type: HardwareType.CPU,
      vramBytes: 0,
      isGpuAvailable: false,
      error: 'Force CPU mode enabled (VISION_FORCE_CPU_MODE=true)',
    });
    mockIsForceCpuModeEnabled.mockReturnValue(true);
    mockClearCache.mockReturnValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('McpResponse形式', () => {
    it('成功時にsuccess: true, data, metadataを含むレスポンスを返すこと', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      expect(result).toHaveProperty('data');
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.request_id).toBeDefined();
      expect(result.metadata?.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('request_idがUUID形式であること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.metadata?.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('外部から_request_idを渡した場合、そのIDが使用されること', async () => {
      // Arrange
      const customRequestId = '01234567-89ab-cdef-0123-456789abcdef';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ _request_id: customRequestId });

      // Assert
      expect(result.metadata?.request_id).toBe(customRequestId);
    });
  });

  describe('systemHealthHandler', () => {
    it('レスポンスにtimestampが含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timestamp).toBeDefined();
        expect(() => new Date(result.data.timestamp)).not.toThrow();
      }
    });

  });

  describe('ツール定義', () => {
    it('正しいツール名が定義されていること', () => {
      expect(systemHealthToolDefinition.name).toBe('system.health');
    });

    it('説明が定義されていること', () => {
      expect(systemHealthToolDefinition.description).toBeDefined();
      expect(systemHealthToolDefinition.description.length).toBeGreaterThan(0);
    });

    it('入力スキーマが定義されていること', () => {
      expect(systemHealthToolDefinition.inputSchema).toBeDefined();
      expect(systemHealthToolDefinition.inputSchema.type).toBe('object');
    });

    it('必須パラメータがないこと', () => {
      expect(systemHealthToolDefinition.inputSchema.required).toEqual([]);
    });

    it('include_initialization_statusパラメータが定義されていること（MCP-INIT-02）', () => {
      expect(systemHealthToolDefinition.inputSchema.properties.include_initialization_status).toBeDefined();
      expect(systemHealthToolDefinition.inputSchema.properties.include_initialization_status.type).toBe('boolean');
      expect(systemHealthToolDefinition.inputSchema.properties.include_initialization_status.default).toBe(true);
    });

    it('include_tools_statusパラメータが定義されていること（REFTRIX-HEALTH-01）', () => {
      expect(systemHealthToolDefinition.inputSchema.properties.include_tools_status).toBeDefined();
      expect(systemHealthToolDefinition.inputSchema.properties.include_tools_status.type).toBe('boolean');
      expect(systemHealthToolDefinition.inputSchema.properties.include_tools_status.default).toBe(true);
    });

    it('include_css_analysis_cache_statsパラメータが定義されていること（MCP-CACHE-02）', () => {
      expect(systemHealthToolDefinition.inputSchema.properties.include_css_analysis_cache_stats).toBeDefined();
      expect(systemHealthToolDefinition.inputSchema.properties.include_css_analysis_cache_stats.type).toBe('boolean');
      expect(systemHealthToolDefinition.inputSchema.properties.include_css_analysis_cache_stats.default).toBe(true);
    });
  });

  describe('サービス初期化状態（MCP-INIT-02）', () => {
    const mockGetLastInitializationResult = vi.mocked(getLastInitializationResult);

    beforeEach(() => {
      mockGetLastInitializationResult.mockReset();
    });

    it('初期化状態が正常な場合、初期化情報がレスポンスに含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetLastInitializationResult.mockReturnValue({
        success: true,
        initializedCategories: ['motion', 'layout', 'quality', 'page'],
        skippedCategories: [],
        errors: [],
        registeredToolCount: 19,
        registeredFactories: ['motionSearch', 'layoutSearch', 'qualityEvaluate'],
      });

      // Act
      const result = await systemHealthHandler({ include_initialization_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.initialization).toBeDefined();
        expect(result.data.services.initialization?.initializedCategories).toEqual(['motion', 'layout', 'quality', 'page']);
        expect(result.data.services.initialization?.skippedCategories).toEqual([]);
        expect(result.data.services.initialization?.errors).toEqual([]);
        // v0.1.1: 20 tools (WebDesign専用) - responsive.search追加
        expect(result.data.services.initialization?.registeredToolCount).toBe(20);
      }
    });

    it('初期化エラーがある場合、エラー情報がレスポンスに含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetLastInitializationResult.mockReturnValue({
        success: true,
        initializedCategories: ['motion', 'layout'],
        skippedCategories: [
          { category: 'Quality.patternMatcher', reason: 'Missing dependency' },
        ],
        errors: [
          { category: 'Page', error: 'PrismaClient initialization failed' },
        ],
        registeredToolCount: 10,
        registeredFactories: ['motionSearch', 'layoutSearch'],
      });

      // Act
      const result = await systemHealthHandler({ include_initialization_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('degraded'); // エラーがある場合は degraded になる
        expect(result.data.services.initialization?.errors).toHaveLength(1);
        expect(result.data.services.initialization?.errors[0]).toEqual({
          category: 'Page',
          error: 'PrismaClient initialization failed',
        });
        expect(result.data.services.initialization?.skippedCategories).toHaveLength(1);
        expect(result.data.services.initialization?.skippedCategories[0]).toEqual({
          category: 'Quality.patternMatcher',
          reason: 'Missing dependency',
        });
      }
    });

    it('include_initialization_status=falseの場合、初期化状態が含まれないこと', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetLastInitializationResult.mockReturnValue({
        success: true,
        initializedCategories: ['motion', 'layout', 'quality', 'page'],
        skippedCategories: [],
        errors: [],
        registeredToolCount: 19,
        registeredFactories: [],
      });

      // Act
      const result = await systemHealthHandler({ include_initialization_status: false });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.initialization).toBeUndefined();
      }
    });

    it('初期化結果がnullの場合、初期化状態がレスポンスに含まれないこと', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetLastInitializationResult.mockReturnValue(null);

      // Act
      const result = await systemHealthHandler({ include_initialization_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.initialization).toBeUndefined();
      }
    });

    it('デフォルトで初期化状態が含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetLastInitializationResult.mockReturnValue({
        success: true,
        initializedCategories: ['motion', 'layout', 'quality', 'page'],
        skippedCategories: [],
        errors: [],
        registeredToolCount: 19,
        registeredFactories: [],
      });

      // Act - パラメータなしで呼び出し
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.initialization).toBeDefined();
      }
    });
  });

  describe('ツールレベルの可用性（REFTRIX-HEALTH-01）', () => {
    const mockGetLastInitializationResult = vi.mocked(getLastInitializationResult);

    beforeEach(() => {
      mockGetLastInitializationResult.mockReset();
      mockGetPatternMatcherServiceFactory.mockReset();
      mockGetBenchmarkServiceFactory.mockReset();
    });

    it('パターンサービスがfallbackモードでもツールがoperationalであればdegradedを返すこと', async () => {
      // Arrange - パターンサービスが利用不可
      mockGetPatternMatcherServiceFactory.mockReturnValue(null);
      mockGetBenchmarkServiceFactory.mockReturnValue(null);
      mockGetLastInitializationResult.mockReturnValue(null);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_tools_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('degraded'); // unhealthyではなくdegraded
        expect(result.data.services.pattern_services?.patternDrivenEvaluation).toBe('fallback_mode');
        expect(result.data.services.tools).toBeDefined();
        expect(result.data.services.tools?.['quality.evaluate']?.status).toBe('operational');
        expect(result.data.services.tools?.['quality.evaluate']?.mode).toBe('fallback');
      }
    });

    it('すべてのサービスが正常な場合、ツールはフル機能でoperationalを返すこと', async () => {
      // Arrange - パターンサービスが利用可能
      mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
      mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));
      mockGetLastInitializationResult.mockReturnValue({
        success: true,
        initializedCategories: ['motion', 'layout', 'quality', 'page'],
        skippedCategories: [],
        errors: [],
        registeredToolCount: 19,
        registeredFactories: [],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_tools_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('healthy');
        expect(result.data.services.tools).toBeDefined();
        expect(result.data.services.tools?.['quality.evaluate']?.status).toBe('operational');
        expect(result.data.services.tools?.['quality.evaluate']?.mode).toBe('full');
      }
    });

    it('include_tools_status=falseの場合、ツール状態が含まれないこと', async () => {
      // Arrange
      mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
      mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_tools_status: false });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.tools).toBeUndefined();
      }
    });

    it('デフォルトでツール状態が含まれること', async () => {
      // Arrange
      mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
      mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.tools).toBeDefined();
      }
    });

    it('layout.searchツールがoperationalであることを確認', async () => {
      // Arrange
      mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
      mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_tools_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.tools?.['layout.search']?.status).toBe('operational');
      }
    });

    it('motion.detectツールがoperationalであることを確認', async () => {
      // Arrange
      mockGetPatternMatcherServiceFactory.mockReturnValue(() => ({} as any));
      mockGetBenchmarkServiceFactory.mockReturnValue(() => ({} as any));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_tools_status: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.tools?.['motion.detect']?.status).toBe('operational');
      }
    });
  });

  describe('CSS解析キャッシュ統計（MCP-CACHE-02）', () => {
    const mockGetCSSAnalysisCacheService = vi.mocked(getCSSAnalysisCacheService);

    beforeEach(() => {
      mockGetCSSAnalysisCacheService.mockReset();
      mockGetCSSAnalysisCacheService.mockReturnValue({
        getStats: vi.fn().mockResolvedValue({
          layoutInspect: { hits: 10, misses: 5, hitRate: 0.67, size: 15 },
          motionDetect: { hits: 8, misses: 4, hitRate: 0.67, size: 12 },
          totalHits: 18,
          totalMisses: 9,
          totalHitRate: 0.67,
          totalSize: 27,
          maxSize: 5000,
          diskUsageBytes: 1024,
        }),
      } as any);
    });

    it('デフォルトでCSS解析キャッシュ統計が含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.css_analysis_cache).toBeDefined();
        expect(result.data.css_analysis_cache?.layout_inspect).toBeDefined();
        expect(result.data.css_analysis_cache?.motion_detect).toBeDefined();
        expect(result.data.css_analysis_cache?.total_hits).toBe(18);
        expect(result.data.css_analysis_cache?.total_misses).toBe(9);
        expect(result.data.css_analysis_cache?.total_hit_rate).toBeCloseTo(0.67, 2);
      }
    });

    it('layout.inspectキャッシュ統計が正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_css_analysis_cache_stats: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.css_analysis_cache?.layout_inspect.hits).toBe(10);
        expect(result.data.css_analysis_cache?.layout_inspect.misses).toBe(5);
        expect(result.data.css_analysis_cache?.layout_inspect.hit_rate).toBeCloseTo(0.67, 2);
        expect(result.data.css_analysis_cache?.layout_inspect.size).toBe(15);
      }
    });

    it('motion.detectキャッシュ統計が正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_css_analysis_cache_stats: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.css_analysis_cache?.motion_detect.hits).toBe(8);
        expect(result.data.css_analysis_cache?.motion_detect.misses).toBe(4);
        expect(result.data.css_analysis_cache?.motion_detect.hit_rate).toBeCloseTo(0.67, 2);
        expect(result.data.css_analysis_cache?.motion_detect.size).toBe(12);
      }
    });

    it('合計統計が正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_css_analysis_cache_stats: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.css_analysis_cache?.total_size).toBe(27);
        expect(result.data.css_analysis_cache?.max_size).toBe(5000);
        expect(result.data.css_analysis_cache?.disk_usage_bytes).toBe(1024);
      }
    });

    it('include_css_analysis_cache_stats=falseの場合、CSS解析キャッシュ統計が含まれないこと', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_css_analysis_cache_stats: false });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.css_analysis_cache).toBeUndefined();
      }
    });

    it('キャッシュサービスがエラーを返しても、全体は成功すること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      mockGetCSSAnalysisCacheService.mockReturnValue({
        getStats: vi.fn().mockRejectedValue(new Error('Cache service error')),
      } as any);

      // Act
      const result = await systemHealthHandler({ include_css_analysis_cache_stats: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('healthy'); // エラーでもhealthyを維持
        expect(result.data.css_analysis_cache).toBeUndefined(); // キャッシュ統計は含まれない
      }
    });
  });

  describe('エラーハンドリング', () => {
    it('予期しないエラーが発生した場合、エラーレスポンスを返すこと', async () => {
      // Arrange - fetchがエラーを投げる（webApiHealthChecker内で捕捉されないエラー）
      // webApiHealthCheckerは通常エラーを捕捉するため、
      // 代わりに初期化関数のモックでエラーを発生させる
      const mockGetLastInitializationResult = vi.mocked(getLastInitializationResult);
      mockGetLastInitializationResult.mockImplementation(() => {
        throw new Error('Unexpected initialization error');
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_initialization_status: true });

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('HEALTH_CHECK_ERROR');
        expect(result.error.message).toContain('Unexpected initialization error');
        expect(result.metadata?.request_id).toBeDefined();
        expect(result.metadata?.processing_time_ms).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Vision Hardware診断（Vision CPU完走保証）', () => {
    // Note: mockDetect, mockIsForceCpuModeEnabled, mockClearCache は
    // vi.hoisted() でファイル先頭に定義済み。beforeEach でデフォルト値が設定される。

    const mockGetLastInitializationResult = vi.mocked(getLastInitializationResult);

    beforeEach(() => {
      // エラーハンドリングテストで設定されたmockImplementationをリセット
      mockGetLastInitializationResult.mockReset();
      mockGetLastInitializationResult.mockReturnValue(null);
    });

    it('デフォルトでVision Hardware状態が含まれること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler();

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware).toBeDefined();
      }
    });

    it('force_cpu_modeが正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware?.force_cpu_mode).toBe(true);
      }
    });

    it('detected_typeが正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware?.detected_type).toBe('CPU');
      }
    });

    it('detection_errorが存在する場合、正しく返されること', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware?.detection_error).toContain('Force CPU mode');
      }
    });

    it('include_vision_hardware=falseの場合、Vision Hardware状態が含まれないこと', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: false });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware).toBeUndefined();
      }
    });

    it('include_vision_hardwareパラメータがスキーマに定義されていること', () => {
      expect(systemHealthToolDefinition.inputSchema.properties.include_vision_hardware).toBeDefined();
      expect(systemHealthToolDefinition.inputSchema.properties.include_vision_hardware.type).toBe('boolean');
      expect(systemHealthToolDefinition.inputSchema.properties.include_vision_hardware.default).toBe(true);
    });

    it('HardwareDetectorがエラーを投げてもエラーが返されないこと（Graceful Degradation）', async () => {
      // Arrange: mockDetectをエラーを投げるように設定
      mockDetect.mockRejectedValueOnce(new Error('HardwareDetector error'));
      mockIsForceCpuModeEnabled.mockReturnValueOnce(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // エラー時はフォールバック値が設定される
        expect(result.data.vision_hardware).toBeDefined();
        expect(result.data.vision_hardware?.detection_error).toContain('HardwareDetector error');
        expect(result.data.vision_hardware?.detected_type).toBe('CPU'); // 安全側
      }
    });

    it('GPU検出時にdetected_type=GPUが返されること', async () => {
      // Arrange: mockDetectをGPU検出結果に設定
      mockDetect.mockResolvedValueOnce({
        type: HardwareType.GPU,
        vramBytes: 8589934592, // 8GB
        isGpuAvailable: true,
      });
      mockIsForceCpuModeEnabled.mockReturnValueOnce(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '0.1.0' }),
      });

      // Act
      const result = await systemHealthHandler({ include_vision_hardware: true });

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.vision_hardware?.detected_type).toBe('GPU');
        expect(result.data.vision_hardware?.vram_bytes).toBe(8589934592);
        expect(result.data.vision_hardware?.is_gpu_available).toBe(true);
        expect(result.data.vision_hardware?.force_cpu_mode).toBe(false);
      }
    });
  });
});
