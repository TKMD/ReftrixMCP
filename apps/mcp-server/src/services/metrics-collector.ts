// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * メトリクス収集サービス
 *
 * リクエスト数、レスポンス時間、エラー率などのメトリクスを収集し、
 * Prometheus形式でエクスポートする機能を提供します。
 */

import { Logger } from '../utils/logger';

const logger = new Logger('MetricsCollector');

/**
 * ヒストグラムデータ構造
 */
export interface Histogram {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

/**
 * カウンターデータ構造
 */
export interface Counter {
  value: number;
}

/**
 * ゲージデータ構造
 */
export interface Gauge {
  value: number;
}

/**
 * メモリ使用量情報
 */
export interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}

/**
 * メトリクス統計情報
 */
export interface MetricsStats {
  requests: {
    total: number;
    byEndpoint: Map<string, number>;
    byMethod: Map<string, number>;
    byStatus: Map<number, number>;
  };
  errors: {
    total: number;
    byEndpoint: Map<string, number>;
    byType: Map<string, number>;
  };
  responseTime: {
    average: number;
    count: number;
    sum: number;
    histogram: Histogram;
  };
  connections: {
    active: number;
  };
  system: {
    memory: MemoryUsage;
    cpuUsage: number;
  };
  /**
   * Map エビクション回数（メモリ管理）
   */
  mapEvictions: number;
}

/**
 * デフォルトのヒストグラムバケット境界値（ミリ秒）
 */
const DEFAULT_HISTOGRAM_BUCKETS = [10, 50, 100, 500, 1000, 5000];

/**
 * デフォルトの Map サイズ上限（メモリ管理）
 */
export const DEFAULT_MAX_MAP_SIZE = 500;

/**
 * メトリクス収集サービスの設定
 */
export interface MetricsCollectorConfig {
  /**
   * Map の最大エントリ数（LRU エビクション）
   * @default 500
   */
  maxMapSize?: number;
}

/**
 * メトリクス収集サービス
 *
 * システムのパフォーマンスメトリクスを収集・管理します。
 */
export class MetricsCollectorService {
  // 設定
  private config: Required<MetricsCollectorConfig>;

  // カウンター
  private requestCounter: Counter = { value: 0 };
  private errorCounter: Counter = { value: 0 };

  // Map エビクションカウンター
  private mapEvictions = 0;

  // 詳細カウンター
  private requestsByEndpoint: Map<string, number> = new Map();
  private requestsByMethod: Map<string, number> = new Map();
  private requestsByStatus: Map<number, number> = new Map();
  private errorsByEndpoint: Map<string, number> = new Map();
  private errorsByType: Map<string, number> = new Map();

  /**
   * コンストラクタ
   * @param config オプションの設定
   */
  constructor(config: MetricsCollectorConfig = {}) {
    this.config = {
      maxMapSize: config.maxMapSize ?? DEFAULT_MAX_MAP_SIZE,
    };
  }

  /**
   * Map にエントリを追加（サイズ制限付き）
   * @param map 対象の Map
   * @param key キー
   * @param value 値
   */
  private setMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
    // 既存キーの場合は LRU 更新のため削除して再追加
    if (map.has(key)) {
      map.delete(key);
    }

    // サイズ上限に達した場合は最古のエントリを削除
    while (map.size >= this.config.maxMapSize) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
        this.mapEvictions++;
      } else {
        break;
      }
    }

    map.set(key, value);
  }

  // ヒストグラム
  private responseTimeHistogram: Histogram = {
    count: 0,
    sum: 0,
    buckets: new Map(DEFAULT_HISTOGRAM_BUCKETS.map((b) => [b, 0])),
  };

  // ゲージ
  private activeConnections: Gauge = { value: 0 };

  // CPU使用率計算用
  private lastCpuUsage: ReturnType<typeof process.cpuUsage> | null = null;
  private lastCpuTime: number = Date.now();

  /**
   * リクエスト数をインクリメント
   * @param endpoint オプションのエンドポイント
   * @param method オプションのHTTPメソッド
   * @param status オプションのHTTPステータスコード
   */
  incrementRequestCount(endpoint?: string, method?: string, status?: number): void {
    this.requestCounter.value++;

    if (endpoint) {
      const current = this.requestsByEndpoint.get(endpoint) ?? 0;
      this.setMapEntry(this.requestsByEndpoint, endpoint, current + 1);
    }

    if (method) {
      const current = this.requestsByMethod.get(method) ?? 0;
      this.setMapEntry(this.requestsByMethod, method, current + 1);
    }

    if (status !== undefined) {
      const current = this.requestsByStatus.get(status) ?? 0;
      this.setMapEntry(this.requestsByStatus, status, current + 1);
    }

    logger.debug('Request counted', { endpoint, method, status });
  }

  /**
   * エラー数をインクリメント
   * @param endpoint オプションのエンドポイント
   * @param errorType オプションのエラータイプ
   */
  incrementErrorCount(endpoint?: string, errorType?: string): void {
    this.errorCounter.value++;

    if (endpoint) {
      const current = this.errorsByEndpoint.get(endpoint) ?? 0;
      this.setMapEntry(this.errorsByEndpoint, endpoint, current + 1);
    }

    if (errorType) {
      const current = this.errorsByType.get(errorType) ?? 0;
      this.setMapEntry(this.errorsByType, errorType, current + 1);
    }

    logger.debug('Error counted', { endpoint, errorType });
  }

  /**
   * レスポンス時間を記録
   * @param duration レスポンス時間（ミリ秒）
   * @param endpoint オプションのエンドポイント
   */
  recordResponseTime(duration: number, endpoint?: string): void {
    this.responseTimeHistogram.count++;
    this.responseTimeHistogram.sum += duration;

    // ヒストグラムバケットに追加（累積）
    for (const [bucket, count] of this.responseTimeHistogram.buckets) {
      if (duration <= bucket) {
        this.responseTimeHistogram.buckets.set(bucket, count + 1);
      }
    }

    logger.debug('Response time recorded', { duration, endpoint });
  }

  /**
   * アクティブ接続数をインクリメント
   */
  incrementActiveConnections(): void {
    this.activeConnections.value++;

    logger.debug('Active connections incremented', { value: this.activeConnections.value });
  }

  /**
   * アクティブ接続数をデクリメント
   */
  decrementActiveConnections(): void {
    this.activeConnections.value = Math.max(0, this.activeConnections.value - 1);

    logger.debug('Active connections decremented', { value: this.activeConnections.value });
  }

  /**
   * リクエスト数を取得
   */
  getRequestCount(): number {
    return this.requestCounter.value;
  }

  /**
   * エラー数を取得
   */
  getErrorCount(): number {
    return this.errorCounter.value;
  }

  /**
   * エラー率を計算（0.0 - 1.0）
   */
  getErrorRate(): number {
    if (this.requestCounter.value === 0) return 0;
    return this.errorCounter.value / this.requestCounter.value;
  }

  /**
   * 平均レスポンス時間を取得（ミリ秒）
   */
  getAverageResponseTime(): number {
    if (this.responseTimeHistogram.count === 0) return 0;
    return this.responseTimeHistogram.sum / this.responseTimeHistogram.count;
  }

  /**
   * レスポンス時間のヒストグラムを取得
   */
  getResponseTimeHistogram(): Histogram {
    return {
      count: this.responseTimeHistogram.count,
      sum: this.responseTimeHistogram.sum,
      buckets: new Map(this.responseTimeHistogram.buckets),
    };
  }

  /**
   * アクティブ接続数を取得
   */
  getActiveConnections(): number {
    return this.activeConnections.value;
  }

  /**
   * メモリ使用量を取得（MB単位）
   */
  getMemoryUsage(): MemoryUsage {
    const memoryUsage = process.memoryUsage();
    return {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
    };
  }

  /**
   * CPU使用率を取得（0-100%）
   */
  getCpuUsage(): number {
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage ?? undefined);
    const currentTime = Date.now();
    const elapsedTime = currentTime - this.lastCpuTime;

    // CPU使用率を計算（ユーザー時間 + システム時間）
    // cpuUsageはマイクロ秒で返されるので、ミリ秒に変換
    const totalCpuTime = (currentCpuUsage.user + currentCpuUsage.system) / 1000;
    const cpuPercent = elapsedTime > 0 ? (totalCpuTime / elapsedTime) * 100 : 0;

    // 次回の計算用に保存
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = currentTime;

    // 0-100の範囲にクランプ
    return Math.min(100, Math.max(0, cpuPercent));
  }

  /**
   * Prometheus形式でメトリクスをエクスポート
   */
  exportPrometheus(): string {
    let output = '';

    // リクエスト数
    output += `# HELP http_requests_total Total HTTP requests\n`;
    output += `# TYPE http_requests_total counter\n`;
    output += `http_requests_total ${this.requestCounter.value}\n\n`;

    // エラー数
    output += `# HELP http_errors_total Total HTTP errors\n`;
    output += `# TYPE http_errors_total counter\n`;
    output += `http_errors_total ${this.errorCounter.value}\n\n`;

    // エラー率
    output += `# HELP http_error_rate HTTP error rate\n`;
    output += `# TYPE http_error_rate gauge\n`;
    output += `http_error_rate ${this.getErrorRate().toFixed(4)}\n\n`;

    // レスポンス時間ヒストグラム
    output += `# HELP http_response_time_milliseconds HTTP response time histogram\n`;
    output += `# TYPE http_response_time_milliseconds histogram\n`;
    for (const [bucket, count] of this.responseTimeHistogram.buckets) {
      output += `http_response_time_milliseconds_bucket{le="${bucket}"} ${count}\n`;
    }
    output += `http_response_time_milliseconds_bucket{le="+Inf"} ${this.responseTimeHistogram.count}\n`;
    output += `http_response_time_milliseconds_sum ${this.responseTimeHistogram.sum}\n`;
    output += `http_response_time_milliseconds_count ${this.responseTimeHistogram.count}\n\n`;

    // アクティブ接続数
    output += `# HELP http_active_connections Active HTTP connections\n`;
    output += `# TYPE http_active_connections gauge\n`;
    output += `http_active_connections ${this.activeConnections.value}\n\n`;

    // メモリ使用量
    const memory = this.getMemoryUsage();
    output += `# HELP process_memory_rss_megabytes Process RSS memory in MB\n`;
    output += `# TYPE process_memory_rss_megabytes gauge\n`;
    output += `process_memory_rss_megabytes ${memory.rss}\n\n`;

    output += `# HELP process_memory_heap_used_megabytes Process heap used memory in MB\n`;
    output += `# TYPE process_memory_heap_used_megabytes gauge\n`;
    output += `process_memory_heap_used_megabytes ${memory.heapUsed}\n\n`;

    return output;
  }

  /**
   * 全メトリクスをリセット
   */
  reset(): void {
    this.requestCounter.value = 0;
    this.errorCounter.value = 0;
    this.responseTimeHistogram.count = 0;
    this.responseTimeHistogram.sum = 0;
    for (const bucket of this.responseTimeHistogram.buckets.keys()) {
      this.responseTimeHistogram.buckets.set(bucket, 0);
    }
    this.activeConnections.value = 0;

    // 詳細カウンターもリセット
    this.requestsByEndpoint.clear();
    this.requestsByMethod.clear();
    this.requestsByStatus.clear();
    this.errorsByEndpoint.clear();
    this.errorsByType.clear();

    // Map エビクションカウンターもリセット
    this.mapEvictions = 0;

    logger.debug('Metrics reset');
  }

  /**
   * 統計情報を取得
   */
  getStats(): MetricsStats {
    return {
      requests: {
        total: this.requestCounter.value,
        byEndpoint: new Map(this.requestsByEndpoint),
        byMethod: new Map(this.requestsByMethod),
        byStatus: new Map(this.requestsByStatus),
      },
      errors: {
        total: this.errorCounter.value,
        byEndpoint: new Map(this.errorsByEndpoint),
        byType: new Map(this.errorsByType),
      },
      responseTime: {
        average: this.getAverageResponseTime(),
        count: this.responseTimeHistogram.count,
        sum: this.responseTimeHistogram.sum,
        histogram: this.getResponseTimeHistogram(),
      },
      connections: {
        active: this.activeConnections.value,
      },
      system: {
        memory: this.getMemoryUsage(),
        cpuUsage: this.getCpuUsage(),
      },
      mapEvictions: this.mapEvictions,
    };
  }
}

// シングルトンインスタンス
let metricsInstance: MetricsCollectorService | null = null;

/**
 * メトリクス収集サービスのシングルトンインスタンスを取得
 */
export function getMetricsCollector(): MetricsCollectorService {
  if (!metricsInstance) {
    metricsInstance = new MetricsCollectorService();
  }
  return metricsInstance;
}

/**
 * メトリクス収集サービスをリセット（テスト用）
 */
export function resetMetricsCollector(): void {
  metricsInstance = null;
}

// デフォルトエクスポート
export default MetricsCollectorService;
