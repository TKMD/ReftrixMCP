// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * system.health MCPツールハンドラー
 * MCPサーバーの健全性チェック
 *
 * 機能:
 * - MCPツールメトリクス統計（観測性）
 * - Embeddingキャッシュ統計（MCP-CACHE-01）
 * - サービス初期化状態（MCP-INIT-02）
 * - パターンサービス健全性（REFTRIX-PATTERN-01）
 * - ツールレベルの可用性（REFTRIX-HEALTH-01）
 */

import { logger, isDevelopment } from '../utils/logger';
import { getToolMetricsStats } from '../router';
import type { MetricsStats } from '../services/metrics-collector';
import { getEmbeddingCacheStats } from '../services/layout-embedding.service';
import { getCSSAnalysisCacheService } from '../services/css-analysis-cache.service';
import { getLastInitializationResult } from '../services/service-initializer';
import {
  getPatternMatcherServiceFactory,
  getBenchmarkServiceFactory,
} from './quality/evaluate.tool';
import { allToolDefinitions } from './index';
import {
  type McpResponse,
  generateRequestId,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from '../utils/mcp-response';
import { HardwareDetector, HardwareType } from '../services/vision/hardware-detector';

/**
 * MCPツールメトリクス統計
 */
export interface McpToolMetrics {
  /** 総リクエスト数 */
  total_requests: number;
  /** 総エラー数 */
  total_errors: number;
  /** エラー率（0.0-1.0） */
  error_rate: number;
  /** 平均レスポンス時間（ミリ秒） */
  avg_response_time_ms: number;
  /** アクティブ接続数 */
  active_connections: number;
  /** ツール別リクエスト数 */
  requests_by_tool: Record<string, number>;
  /** ツール別エラー数 */
  errors_by_tool: Record<string, number>;
  /** メモリ使用量（MB） */
  memory: {
    rss: number;
    heap_total: number;
    heap_used: number;
  };
}

/**
 * Embeddingキャッシュ統計
 */
export interface EmbeddingCacheMetrics {
  /** キャッシュヒット数 */
  hits: number;
  /** キャッシュミス数 */
  misses: number;
  /** ヒット率（0.0-1.0） */
  hit_rate: number;
  /** 現在のエントリ数 */
  size: number;
  /** 最大エントリ数 */
  max_size: number;
  /** ディスク使用量（バイト） */
  disk_usage_bytes: number;
  /** エビクション（削除）回数 */
  eviction_count: number;
}

/**
 * サービス初期化状態（MCP-INIT-02）
 */
export interface ServiceInitializationStatus {
  /** 初期化されたカテゴリリスト */
  initializedCategories: string[];
  /** スキップされたカテゴリ詳細 */
  skippedCategories: Array<{
    category: string;
    reason: string;
  }>;
  /** エラー情報 */
  errors: Array<{
    category: string;
    error: string;
  }>;
  /** 登録されたツール/ファクトリ数 */
  registeredToolCount: number;
}

/**
 * パターンサービス健全性ステータス（REFTRIX-PATTERN-01）
 */
export interface PatternServicesStatus {
  /** PatternMatcherService の健全性 */
  patternMatcher: 'healthy' | 'unavailable';
  /** BenchmarkService の健全性 */
  benchmarkService: 'healthy' | 'unavailable';
  /** パターン駆動評価が利用可能か */
  patternDrivenEvaluation: 'available' | 'fallback_mode';
}

/**
 * 個別ツールの可用性ステータス（REFTRIX-HEALTH-01）
 */
export interface ToolOperationalStatus {
  /** ツールの動作状態 */
  status: 'operational' | 'unavailable';
  /** 動作モード: full=フル機能, fallback=縮退モード */
  mode?: 'full' | 'fallback';
  /** 追加情報（エラー詳細など） */
  details?: string;
}

/**
 * ツールレベルの可用性マップ（REFTRIX-HEALTH-01）
 */
export type ToolsStatus = Record<string, ToolOperationalStatus>;

/**
 * CSS解析キャッシュ統計（MCP-CACHE-02）
 */
export interface CssAnalysisCacheMetrics {
  /** layout.inspectキャッシュ統計 */
  layout_inspect: {
    hits: number;
    misses: number;
    hit_rate: number;
    size: number;
  };
  /** motion.detectキャッシュ統計 */
  motion_detect: {
    hits: number;
    misses: number;
    hit_rate: number;
    size: number;
  };
  /** 合計統計 */
  total_hits: number;
  total_misses: number;
  total_hit_rate: number;
  total_size: number;
  max_size: number;
  disk_usage_bytes: number;
}

/**
 * Vision Hardware ステータス（Vision CPU完走保証診断用）
 *
 * HardwareDetectorの状態を診断するための情報。
 * VISION_FORCE_CPU_MODE環境変数が正しく読み込まれているかを確認可能。
 */
export interface VisionHardwareStatus {
  /** 強制CPUモードが有効か（環境変数VISION_FORCE_CPU_MODEまたはコンストラクタオプション） */
  force_cpu_mode: boolean;
  /** 環境変数VISION_FORCE_CPU_MODEの値（診断用） */
  env_vision_force_cpu_mode: string | undefined;
  /** 検出されたハードウェアタイプ（GPU/CPU） */
  detected_type: 'GPU' | 'CPU';
  /** VRAM使用量（バイト）- GPU検出時のみ有効 */
  vram_bytes: number;
  /** GPUが利用可能か */
  is_gpu_available: boolean;
  /** 検出エラーメッセージ（Ollama未起動時等） */
  detection_error?: string;
  /** Ollama接続URL */
  ollama_url: string;
}

/**
 * ヘルスチェックレスポンス
 */
export interface SystemHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    /** サービス初期化状態（MCP-INIT-02） */
    initialization?: ServiceInitializationStatus;
    /** パターンサービス健全性（REFTRIX-PATTERN-01） */
    pattern_services?: PatternServicesStatus;
    /** ツールレベルの可用性（REFTRIX-HEALTH-01） */
    tools?: ToolsStatus;
  };
  /** MCPツールメトリクス（観測性） */
  mcp_metrics?: McpToolMetrics;
  /** Embeddingキャッシュ統計（MCP-CACHE-01） */
  embedding_cache?: EmbeddingCacheMetrics;
  /** CSS解析キャッシュ統計（MCP-CACHE-02） */
  css_analysis_cache?: CssAnalysisCacheMetrics;
  /** Vision Hardware ステータス（Vision CPU完走保証診断用） */
  vision_hardware?: VisionHardwareStatus;
}

/**
 * system.health入力スキーマ
 */
export interface SystemHealthInput {
  /** メトリクスを含めるか（デフォルト: true） */
  include_metrics?: boolean;
  /** Embeddingキャッシュ統計を含めるか（デフォルト: true） */
  include_cache_stats?: boolean;
  /** CSS解析キャッシュ統計を含めるか（デフォルト: true）（MCP-CACHE-02） */
  include_css_analysis_cache_stats?: boolean;
  /** サービス初期化状態を含めるか（デフォルト: true）（MCP-INIT-02） */
  include_initialization_status?: boolean;
  /** パターンサービス健全性を含めるか（デフォルト: true）（REFTRIX-PATTERN-01） */
  include_pattern_services?: boolean;
  /** ツールレベルの可用性を含めるか（デフォルト: true）（REFTRIX-HEALTH-01） */
  include_tools_status?: boolean;
  /** Vision Hardware ステータスを含めるか（デフォルト: true）（Vision CPU完走保証診断用） */
  include_vision_hardware?: boolean;
}

/**
 * MetricsStatsからMcpToolMetricsへ変換
 */
function convertToMcpToolMetrics(stats: MetricsStats): McpToolMetrics {
  // Map to Record変換
  const requestsByTool: Record<string, number> = {};
  for (const [key, value] of stats.requests.byEndpoint) {
    requestsByTool[key] = value;
  }

  const errorsByTool: Record<string, number> = {};
  for (const [key, value] of stats.errors.byEndpoint) {
    errorsByTool[key] = value;
  }

  return {
    total_requests: stats.requests.total,
    total_errors: stats.errors.total,
    error_rate: stats.requests.total > 0 ? stats.errors.total / stats.requests.total : 0,
    avg_response_time_ms: stats.responseTime.average,
    active_connections: stats.connections.active,
    requests_by_tool: requestsByTool,
    errors_by_tool: errorsByTool,
    memory: {
      rss: stats.system.memory.rss,
      heap_total: stats.system.memory.heapTotal,
      heap_used: stats.system.memory.heapUsed,
    },
  };
}

/** system.health ハンドラーの戻り値型 */
export type SystemHealthHandlerResponse = McpResponse<SystemHealthResponse>;

/**
 * ツールレベルの可用性ステータスを取得（REFTRIX-HEALTH-01）
 *
 * 各MCPツールが実際に動作可能かどうかを判定する。
 * サービスがunavailableでもfallbackモードで動作可能なツールは'operational'として報告。
 *
 * @param patternServices - パターンサービスの健全性ステータス
 * @returns ツール別の可用性ステータス
 */
function getToolsOperationalStatus(
  patternServices?: PatternServicesStatus
): ToolsStatus {
  const tools: ToolsStatus = {};

  // quality.evaluate - パターンサービスがなくても静的評価で動作可能
  const isQualityFullMode = patternServices?.patternDrivenEvaluation === 'available';
  tools['quality.evaluate'] = {
    status: 'operational',
    mode: isQualityFullMode ? 'full' : 'fallback',
    ...(isQualityFullMode ? {} : { details: 'Pattern-driven evaluation unavailable, using static analysis only' }),
  };

  // layout.search - 常に動作可能（DBベースの検索）
  tools['layout.search'] = {
    status: 'operational',
    mode: 'full',
  };

  // layout.ingest - 常に動作可能（Webページ取得）
  tools['layout.ingest'] = {
    status: 'operational',
    mode: 'full',
  };

  // layout.inspect - 常に動作可能（HTML解析）
  tools['layout.inspect'] = {
    status: 'operational',
    mode: 'full',
  };

  // layout.generate_code - 常に動作可能（コード生成）
  tools['layout.generate_code'] = {
    status: 'operational',
    mode: 'full',
  };

  // motion.detect - 常に動作可能（CSS解析、オプションでフレームキャプチャ）
  tools['motion.detect'] = {
    status: 'operational',
    mode: 'full',
  };

  // motion.search - 常に動作可能（DBベースの検索）
  tools['motion.search'] = {
    status: 'operational',
    mode: 'full',
  };

  // quality.batch_evaluate - quality.evaluateと同じ依存関係
  tools['quality.batch_evaluate'] = {
    status: 'operational',
    mode: isQualityFullMode ? 'full' : 'fallback',
    ...(isQualityFullMode ? {} : { details: 'Pattern-driven evaluation unavailable, using static analysis only' }),
  };

  // page.analyze - 統合分析（layout + motion + quality）
  tools['page.analyze'] = {
    status: 'operational',
    mode: isQualityFullMode ? 'full' : 'fallback',
    ...(isQualityFullMode ? {} : { details: 'Quality evaluation running in fallback mode' }),
  };

  // style.get_palette - 常に動作可能
  tools['style.get_palette'] = {
    status: 'operational',
    mode: 'full',
  };

  // brief.validate - 常に動作可能
  tools['brief.validate'] = {
    status: 'operational',
    mode: 'full',
  };

  // project.get / project.list - 常に動作可能
  tools['project.get'] = {
    status: 'operational',
    mode: 'full',
  };

  tools['project.list'] = {
    status: 'operational',
    mode: 'full',
  };

  // page.getJobStatus - 常に動作可能
  tools['page.getJobStatus'] = {
    status: 'operational',
    mode: 'full',
  };

  return tools;
}

/**
 * system.health ツールハンドラー
 *
 * 他のMCPツールと統一されたMcpResponse形式でレスポンスを返却。
 * 成功時: { success: true, data: SystemHealthResponse, metadata: { request_id, ... } }
 * 失敗時: { success: false, error: { code, message }, metadata: { request_id, ... } }
 *
 * @param input - 入力パラメータ（オプション）
 * @returns McpResponse<SystemHealthResponse>
 */
export async function systemHealthHandler(
  input?: unknown
): Promise<SystemHealthHandlerResponse> {
  // router.tsから注入された_request_idを使用、フォールバックとして自動生成
  const requestId =
    (input as Record<string, unknown> | null)?._request_id as string | undefined ??
    generateRequestId();

  const startTime = Date.now();

  try {
    const options = (input as SystemHealthInput) ?? {};
    const includeMetrics = options.include_metrics !== false; // デフォルトはtrue
    const includeInitializationStatus = options.include_initialization_status !== false; // デフォルトはtrue（MCP-INIT-02）

    if (isDevelopment()) {
      logger.info('[MCP Tool] system.health called', { includeMetrics, includeInitializationStatus, requestId });
    }

    // 初期状態は healthy、後続のチェックで degraded に下げる可能性あり
    const healthData: SystemHealthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {},
    };

    // サービス初期化状態を含める（MCP-INIT-02）
    if (includeInitializationStatus) {
      const initResult = getLastInitializationResult();
      if (initResult) {
        healthData.services.initialization = {
          initializedCategories: initResult.initializedCategories,
          skippedCategories: initResult.skippedCategories.map((s) => ({
            category: s.category,
            reason: s.reason,
          })),
          errors: initResult.errors.map((e) => ({
            category: e.category,
            error: e.error,
          })),
          // allToolDefinitionsから実際のMCPツール数を取得（17ツール）
          registeredToolCount: allToolDefinitions.length,
        };

        // 初期化エラーがある場合、全体ステータスを degraded に下げる
        if (initResult.errors.length > 0 && healthData.status === 'healthy') {
          healthData.status = 'degraded';
        }
      }
    }

    // メトリクス統計を含める
    if (includeMetrics) {
      const metricsStats = getToolMetricsStats();
      healthData.mcp_metrics = convertToMcpToolMetrics(metricsStats);
    }

    // Embeddingキャッシュ統計を含める（MCP-CACHE-01）
    const includeCacheStats = options.include_cache_stats !== false; // デフォルトはtrue
    if (includeCacheStats) {
      try {
        const cacheStats = await getEmbeddingCacheStats();
        if (cacheStats) {
          healthData.embedding_cache = {
            hits: cacheStats.hits,
            misses: cacheStats.misses,
            hit_rate: cacheStats.hitRate,
            size: cacheStats.size,
            max_size: cacheStats.maxSize,
            disk_usage_bytes: cacheStats.diskUsageBytes,
            eviction_count: cacheStats.evictionCount,
          };
        }
      } catch (cacheError) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] Failed to get embedding cache stats', {
            error: cacheError instanceof Error ? cacheError.message : 'Unknown error',
            requestId,
          });
        }
      }
    }

    // CSS解析キャッシュ統計を含める（MCP-CACHE-02）
    const includeCssAnalysisCacheStats = options.include_css_analysis_cache_stats !== false; // デフォルトはtrue
    if (includeCssAnalysisCacheStats) {
      try {
        const cssAnalysisCacheService = getCSSAnalysisCacheService();
        const cssStats = await cssAnalysisCacheService.getStats();
        healthData.css_analysis_cache = {
          layout_inspect: {
            hits: cssStats.layoutInspect.hits,
            misses: cssStats.layoutInspect.misses,
            hit_rate: cssStats.layoutInspect.hitRate,
            size: cssStats.layoutInspect.size,
          },
          motion_detect: {
            hits: cssStats.motionDetect.hits,
            misses: cssStats.motionDetect.misses,
            hit_rate: cssStats.motionDetect.hitRate,
            size: cssStats.motionDetect.size,
          },
          total_hits: cssStats.totalHits,
          total_misses: cssStats.totalMisses,
          total_hit_rate: cssStats.totalHitRate,
          total_size: cssStats.totalSize,
          max_size: cssStats.maxSize,
          disk_usage_bytes: cssStats.diskUsageBytes,
        };
      } catch (cssAnalysisCacheError) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] Failed to get CSS analysis cache stats', {
            error: cssAnalysisCacheError instanceof Error ? cssAnalysisCacheError.message : 'Unknown error',
            requestId,
          });
        }
      }
    }

    // パターンサービス健全性を含める（REFTRIX-PATTERN-01）
    const includePatternServices = options.include_pattern_services !== false; // デフォルトはtrue
    if (includePatternServices) {
      const patternMatcherFactory = getPatternMatcherServiceFactory();
      const benchmarkFactory = getBenchmarkServiceFactory();

      const patternMatcherStatus: 'healthy' | 'unavailable' = patternMatcherFactory ? 'healthy' : 'unavailable';
      const benchmarkServiceStatus: 'healthy' | 'unavailable' = benchmarkFactory ? 'healthy' : 'unavailable';
      const patternDrivenEvaluation: 'available' | 'fallback_mode' =
        patternMatcherFactory && benchmarkFactory ? 'available' : 'fallback_mode';

      healthData.services.pattern_services = {
        patternMatcher: patternMatcherStatus,
        benchmarkService: benchmarkServiceStatus,
        patternDrivenEvaluation,
      };

      // パターンサービスが unavailable の場合、全体ステータスを degraded に下げる
      if (patternDrivenEvaluation === 'fallback_mode' && healthData.status === 'healthy') {
        healthData.status = 'degraded';
      }

      if (isDevelopment()) {
        logger.info('[MCP Tool] Pattern services status', {
          patternMatcher: patternMatcherStatus,
          benchmarkService: benchmarkServiceStatus,
          patternDrivenEvaluation,
          requestId,
        });
      }
    }

    // ツールレベルの可用性を含める（REFTRIX-HEALTH-01）
    const includeToolsStatus = options.include_tools_status !== false; // デフォルトはtrue
    if (includeToolsStatus) {
      const toolsStatus = getToolsOperationalStatus(healthData.services.pattern_services);
      healthData.services.tools = toolsStatus;

      if (isDevelopment()) {
        logger.info('[MCP Tool] Tools operational status', {
          tools: Object.keys(toolsStatus),
          allOperational: Object.values(toolsStatus).every(t => t.status === 'operational'),
          requestId,
        });
      }
    }

    // Vision Hardware ステータスを含める（Vision CPU完走保証診断用）
    const includeVisionHardware = options.include_vision_hardware !== false; // デフォルトはtrue
    if (includeVisionHardware) {
      try {
        const hardwareDetector = new HardwareDetector();
        const hardwareInfo = await hardwareDetector.detect();

        // 環境変数の値を直接取得（診断用）
        const envForceCpuMode = process.env['VISION_FORCE_CPU_MODE'];

        healthData.vision_hardware = {
          force_cpu_mode: hardwareDetector.isForceCpuModeEnabled(),
          env_vision_force_cpu_mode: envForceCpuMode,
          detected_type: hardwareInfo.type === HardwareType.GPU ? 'GPU' : 'CPU',
          vram_bytes: hardwareInfo.vramBytes,
          is_gpu_available: hardwareInfo.isGpuAvailable,
          ...(hardwareInfo.error !== undefined && { detection_error: hardwareInfo.error }),
          ollama_url: 'http://localhost:11434', // デフォルトOllama URL
        };

        if (isDevelopment()) {
          logger.info('[MCP Tool] Vision hardware status', {
            forceCpuMode: hardwareDetector.isForceCpuModeEnabled(),
            envForceCpuMode,
            detectedType: hardwareInfo.type,
            vramBytes: hardwareInfo.vramBytes,
            isGpuAvailable: hardwareInfo.isGpuAvailable,
            error: hardwareInfo.error,
            requestId,
          });
        }
      } catch (visionHardwareError) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] Failed to get vision hardware status', {
            error: visionHardwareError instanceof Error ? visionHardwareError.message : 'Unknown error',
            requestId,
          });
        }
        // エラー時は環境変数のみを報告
        healthData.vision_hardware = {
          force_cpu_mode: process.env['VISION_FORCE_CPU_MODE']?.toLowerCase() === 'true',
          env_vision_force_cpu_mode: process.env['VISION_FORCE_CPU_MODE'],
          detected_type: 'CPU', // 安全側
          vram_bytes: 0,
          is_gpu_available: false,
          detection_error: visionHardwareError instanceof Error ? visionHardwareError.message : 'Unknown error',
          ollama_url: 'http://localhost:11434',
        };
      }
    }

    const processingTime = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MCP Tool] system.health completed', {
        status: healthData.status,
        totalTime: processingTime,
        hasMetrics: includeMetrics,
        hasCacheStats: includeCacheStats,
        hasCssAnalysisCacheStats: includeCssAnalysisCacheStats,
        hasInitializationStatus: includeInitializationStatus,
        hasPatternServices: includePatternServices,
        hasToolsStatus: includeToolsStatus,
        hasVisionHardware: includeVisionHardware,
        requestId,
      });
    }

    return createSuccessResponseWithRequestId(healthData, requestId, {
      processing_time_ms: processingTime,
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;

    if (isDevelopment()) {
      logger.error('[MCP Tool] system.health error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });
    }

    return createErrorResponseWithRequestId(
      'HEALTH_CHECK_ERROR',
      `ヘルスチェック中にエラーが発生しました: ${error instanceof Error ? error.message : 'Unknown error'}`,
      requestId,
      error instanceof Error ? { stack: error.stack } : undefined,
      { processing_time_ms: processingTime }
    );
  }
}

/**
 * system.health ツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const systemHealthToolDefinition = {
  name: 'system.health',
  description:
    'Run MCP server health check. Checks MCP tool metrics, embedding cache stats, service initialization status, pattern services health, and returns diagnostics.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      include_metrics: {
        type: 'boolean' as const,
        description:
          'Include MCP tool metrics (requests, errors, response times). Default: true',
        default: true,
      },
      include_cache_stats: {
        type: 'boolean' as const,
        description:
          'Include embedding cache statistics (hits, misses, hit rate). Default: true',
        default: true,
      },
      include_css_analysis_cache_stats: {
        type: 'boolean' as const,
        description:
          'Include CSS analysis cache statistics (layout.inspect/motion.detect cache hits, misses, hit rate). Default: true (MCP-CACHE-02)',
        default: true,
      },
      include_initialization_status: {
        type: 'boolean' as const,
        description:
          'Include service initialization status (initialized categories, skipped, errors). Default: true (MCP-INIT-02)',
        default: true,
      },
      include_pattern_services: {
        type: 'boolean' as const,
        description:
          'Include pattern services health (patternMatcher, benchmarkService, patternDrivenEvaluation). Default: true (REFTRIX-PATTERN-01)',
        default: true,
      },
      include_tools_status: {
        type: 'boolean' as const,
        description:
          'Include tool-level operational status (operational/unavailable, full/fallback mode). Default: true (REFTRIX-HEALTH-01)',
        default: true,
      },
      include_vision_hardware: {
        type: 'boolean' as const,
        description:
          'Include Vision hardware status (force CPU mode, detected hardware type). Default: true (Vision CPU completion guarantee diagnostics)',
        default: true,
      },
    },
    required: [],
  },
  annotations: {
    title: 'System Health',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};
