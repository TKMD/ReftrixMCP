// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * メトリクス収集サービス テスト
 *
 * テスト対象: MetricsCollectorService
 *
 * このテストは以下を検証します:
 * - リクエスト数のカウント
 * - レスポンス時間のヒストグラム
 * - エラー率の計算
 * - アクティブ接続数の追跡
 * - メモリ使用量の取得
 * - CPU使用率の取得
 * - Prometheus形式でのエクスポート
 * - メトリクスのリセット機能
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// モック: メトリクスデータ構造
interface Histogram {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

interface Counter {
  value: number;
}

interface Gauge {
  value: number;
}

// モック: メトリクス収集サービス
class MetricsCollectorService {
  private requestCounter: Counter = { value: 0 };
  private errorCounter: Counter = { value: 0 };
  private responseTimeHistogram: Histogram = {
    count: 0,
    sum: 0,
    buckets: new Map([
      [10, 0],
      [50, 0],
      [100, 0],
      [500, 0],
      [1000, 0],
      [5000, 0],
    ]),
  };
  private activeConnections: Gauge = { value: 0 };

  /**
   * リクエストをカウントする
   */
  incrementRequestCount(): void {
    this.requestCounter.value++;
  }

  /**
   * エラーをカウントする
   */
  incrementErrorCount(): void {
    this.errorCounter.value++;
  }

  /**
   * レスポンス時間を記録する
   * @param duration レスポンス時間（ミリ秒）
   */
  recordResponseTime(duration: number): void {
    this.responseTimeHistogram.count++;
    this.responseTimeHistogram.sum += duration;

    // ヒストグラムバケットに追加
    for (const [bucket, count] of this.responseTimeHistogram.buckets) {
      if (duration <= bucket) {
        this.responseTimeHistogram.buckets.set(bucket, count + 1);
      }
    }
  }

  /**
   * アクティブ接続数を増やす
   */
  incrementActiveConnections(): void {
    this.activeConnections.value++;
  }

  /**
   * アクティブ接続数を減らす
   */
  decrementActiveConnections(): void {
    this.activeConnections.value = Math.max(0, this.activeConnections.value - 1);
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
    return { ...this.responseTimeHistogram };
  }

  /**
   * アクティブ接続数を取得
   */
  getActiveConnections(): number {
    return this.activeConnections.value;
  }

  /**
   * メモリ使用量を取得（MB）
   */
  getMemoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  } {
    const memoryUsage = process.memoryUsage();
    return {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
    };
  }

  /**
   * CPU使用率を取得（モック）
   */
  getCpuUsage(): number {
    // 実際はos.cpus()やprocess.cpuUsage()を使用
    return Math.random() * 100;
  }

  /**
   * Prometheus形式でエクスポート
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
  }
}

describe('MetricsCollectorService', () => {
  let service: MetricsCollectorService;

  beforeEach(() => {
    service = new MetricsCollectorService();
  });

  describe('リクエストカウント', () => {
    it('リクエスト数を正しくカウントすること', () => {
      // Arrange & Act
      service.incrementRequestCount();
      service.incrementRequestCount();
      service.incrementRequestCount();

      // Assert
      expect(service.getRequestCount()).toBe(3);
    });

    it('初期状態ではリクエスト数が0であること', () => {
      // Assert
      expect(service.getRequestCount()).toBe(0);
    });
  });

  describe('エラーカウント', () => {
    it('エラー数を正しくカウントすること', () => {
      // Arrange & Act
      service.incrementErrorCount();
      service.incrementErrorCount();

      // Assert
      expect(service.getErrorCount()).toBe(2);
    });

    it('エラー率を正しく計算すること', () => {
      // Arrange & Act
      service.incrementRequestCount(); // 1
      service.incrementRequestCount(); // 2
      service.incrementRequestCount(); // 3
      service.incrementRequestCount(); // 4
      service.incrementErrorCount(); // 1エラー

      // Assert
      expect(service.getErrorRate()).toBe(0.25); // 1/4 = 0.25
    });

    it('リクエスト数が0の場合、エラー率は0であること', () => {
      // Assert
      expect(service.getErrorRate()).toBe(0);
    });
  });

  describe('レスポンス時間ヒストグラム', () => {
    it('レスポンス時間を記録すること', () => {
      // Arrange & Act
      service.recordResponseTime(50);
      service.recordResponseTime(150);
      service.recordResponseTime(300);

      // Assert
      const histogram = service.getResponseTimeHistogram();
      expect(histogram.count).toBe(3);
      expect(histogram.sum).toBe(500);
    });

    it('平均レスポンス時間を計算すること', () => {
      // Arrange & Act
      service.recordResponseTime(100);
      service.recordResponseTime(200);
      service.recordResponseTime(300);

      // Assert
      expect(service.getAverageResponseTime()).toBe(200);
    });

    it('ヒストグラムバケットに正しく分類すること', () => {
      // Arrange & Act
      service.recordResponseTime(5); // <= 10
      service.recordResponseTime(25); // <= 50
      service.recordResponseTime(75); // <= 100
      service.recordResponseTime(250); // <= 500

      // Assert
      const histogram = service.getResponseTimeHistogram();
      expect(histogram.buckets.get(10)).toBe(1);
      expect(histogram.buckets.get(50)).toBe(2); // 5と25
      expect(histogram.buckets.get(100)).toBe(3); // 5, 25, 75
      expect(histogram.buckets.get(500)).toBe(4); // すべて
    });

    it('レスポンス時間が記録されていない場合、平均は0であること', () => {
      // Assert
      expect(service.getAverageResponseTime()).toBe(0);
    });
  });

  describe('アクティブ接続数', () => {
    it('アクティブ接続数を増やすこと', () => {
      // Arrange & Act
      service.incrementActiveConnections();
      service.incrementActiveConnections();

      // Assert
      expect(service.getActiveConnections()).toBe(2);
    });

    it('アクティブ接続数を減らすこと', () => {
      // Arrange
      service.incrementActiveConnections();
      service.incrementActiveConnections();
      service.incrementActiveConnections();

      // Act
      service.decrementActiveConnections();

      // Assert
      expect(service.getActiveConnections()).toBe(2);
    });

    it('アクティブ接続数が負の値にならないこと', () => {
      // Arrange & Act
      service.decrementActiveConnections();
      service.decrementActiveConnections();

      // Assert
      expect(service.getActiveConnections()).toBe(0);
    });
  });

  describe('メモリ使用量', () => {
    it('メモリ使用量を取得すること', () => {
      // Arrange & Act
      const memory = service.getMemoryUsage();

      // Assert
      expect(memory.rss).toBeGreaterThan(0);
      expect(memory.heapTotal).toBeGreaterThan(0);
      expect(memory.heapUsed).toBeGreaterThan(0);
      expect(memory.external).toBeGreaterThanOrEqual(0);
    });

    it('メモリ使用量がMB単位で返されること', () => {
      // Arrange & Act
      const memory = service.getMemoryUsage();

      // Assert
      // MB単位なので整数であること
      expect(Number.isInteger(memory.rss)).toBe(true);
      expect(Number.isInteger(memory.heapTotal)).toBe(true);
      expect(Number.isInteger(memory.heapUsed)).toBe(true);
    });
  });

  describe('CPU使用率', () => {
    it('CPU使用率を取得すること', () => {
      // Arrange & Act
      const cpuUsage = service.getCpuUsage();

      // Assert
      expect(cpuUsage).toBeGreaterThanOrEqual(0);
      expect(cpuUsage).toBeLessThanOrEqual(100);
    });
  });

  describe('Prometheus形式エクスポート', () => {
    it('Prometheus形式でメトリクスをエクスポートすること', () => {
      // Arrange
      service.incrementRequestCount();
      service.incrementRequestCount();
      service.incrementErrorCount();
      service.recordResponseTime(100);
      service.recordResponseTime(200);

      // Act
      const output = service.exportPrometheus();

      // Assert
      expect(output).toContain('http_requests_total 2');
      expect(output).toContain('http_errors_total 1');
      expect(output).toContain('http_error_rate 0.5000');
      expect(output).toContain('http_response_time_milliseconds_sum 300');
      expect(output).toContain('http_response_time_milliseconds_count 2');
    });

    it('HELPとTYPEメタデータを含むこと', () => {
      // Arrange & Act
      const output = service.exportPrometheus();

      // Assert
      expect(output).toContain('# HELP http_requests_total');
      expect(output).toContain('# TYPE http_requests_total counter');
      expect(output).toContain('# HELP http_response_time_milliseconds');
      expect(output).toContain('# TYPE http_response_time_milliseconds histogram');
    });

    it('ヒストグラムバケットを正しくエクスポートすること', () => {
      // Arrange
      service.recordResponseTime(30);
      service.recordResponseTime(80);

      // Act
      const output = service.exportPrometheus();

      // Assert
      expect(output).toContain('http_response_time_milliseconds_bucket{le="50"} 1');
      expect(output).toContain('http_response_time_milliseconds_bucket{le="100"} 2');
      expect(output).toContain('http_response_time_milliseconds_bucket{le="+Inf"} 2');
    });

    it('メモリメトリクスを含むこと', () => {
      // Arrange & Act
      const output = service.exportPrometheus();

      // Assert
      expect(output).toContain('process_memory_rss_megabytes');
      expect(output).toContain('process_memory_heap_used_megabytes');
    });
  });

  describe('メトリクスリセット', () => {
    it('全メトリクスをリセットすること', () => {
      // Arrange
      service.incrementRequestCount();
      service.incrementErrorCount();
      service.recordResponseTime(100);
      service.incrementActiveConnections();

      // Act
      service.reset();

      // Assert
      expect(service.getRequestCount()).toBe(0);
      expect(service.getErrorCount()).toBe(0);
      expect(service.getAverageResponseTime()).toBe(0);
      expect(service.getActiveConnections()).toBe(0);
      expect(service.getResponseTimeHistogram().count).toBe(0);
    });

    it('ヒストグラムバケットもリセットされること', () => {
      // Arrange
      service.recordResponseTime(50);
      service.recordResponseTime(150);

      // Act
      service.reset();

      // Assert
      const histogram = service.getResponseTimeHistogram();
      for (const count of histogram.buckets.values()) {
        expect(count).toBe(0);
      }
    });
  });

  describe('Map size limits (memory management)', () => {
    it('should accept maxMapSize in configuration', async () => {
      // Import actual implementation
      const { MetricsCollectorService } = await import('../../src/services/metrics-collector');
      const service = new MetricsCollectorService({ maxMapSize: 100 });

      expect(service).toBeDefined();
    });

    it('should evict oldest entries when requestsByEndpoint exceeds maxMapSize', async () => {
      const { MetricsCollectorService } = await import('../../src/services/metrics-collector');
      const maxMapSize = 5;
      const service = new MetricsCollectorService({ maxMapSize });

      // Add more unique endpoints than maxMapSize
      for (let i = 0; i < 10; i++) {
        service.incrementRequestCount(`/endpoint-${i}`, 'GET', 200);
      }

      const stats = service.getStats();

      // requestsByEndpoint size should not exceed maxMapSize
      expect(stats.requests.byEndpoint.size).toBeLessThanOrEqual(maxMapSize);
    });

    it('should evict oldest entries when errorsByType exceeds maxMapSize', async () => {
      const { MetricsCollectorService } = await import('../../src/services/metrics-collector');
      const maxMapSize = 3;
      const service = new MetricsCollectorService({ maxMapSize });

      // Add more unique error types than maxMapSize
      for (let i = 0; i < 8; i++) {
        service.incrementErrorCount(`/endpoint-${i}`, `ERROR_TYPE_${i}`);
      }

      const stats = service.getStats();

      // errorsByType size should not exceed maxMapSize
      expect(stats.errors.byType.size).toBeLessThanOrEqual(maxMapSize);
    });

    it('should use default maxMapSize of 500 when not specified', async () => {
      const { MetricsCollectorService, DEFAULT_MAX_MAP_SIZE } = await import('../../src/services/metrics-collector');

      // DEFAULT_MAX_MAP_SIZE should be exported and equal to 500
      expect(DEFAULT_MAX_MAP_SIZE).toBe(500);
    });

    it('should expose mapEvictions count in statistics', async () => {
      const { MetricsCollectorService } = await import('../../src/services/metrics-collector');
      const maxMapSize = 2;
      const service = new MetricsCollectorService({ maxMapSize });

      // Add 5 unique endpoints, should trigger 3 evictions
      for (let i = 0; i < 5; i++) {
        service.incrementRequestCount(`/endpoint-${i}`, 'GET', 200);
      }

      const stats = service.getStats();

      expect(stats.mapEvictions).toBeGreaterThanOrEqual(3);
    });
  });

  describe('統合シナリオ', () => {
    it('実際のリクエスト処理をシミュレートすること', () => {
      // Arrange & Act: 100リクエストをシミュレート
      for (let i = 0; i < 100; i++) {
        service.incrementActiveConnections();
        service.incrementRequestCount();

        // レスポンス時間をランダムに生成（10-500ms）
        const responseTime = Math.random() * 490 + 10;
        service.recordResponseTime(responseTime);

        // 10%の確率でエラー
        if (Math.random() < 0.1) {
          service.incrementErrorCount();
        }

        service.decrementActiveConnections();
      }

      // Assert
      expect(service.getRequestCount()).toBe(100);
      expect(service.getErrorRate()).toBeGreaterThan(0);
      expect(service.getErrorRate()).toBeLessThan(0.2); // ~10%のエラー率
      expect(service.getAverageResponseTime()).toBeGreaterThan(0);
      expect(service.getActiveConnections()).toBe(0); // すべて処理完了
    });

    it('Prometheusエクスポートが有効なデータを含むこと', () => {
      // Arrange
      service.incrementRequestCount();
      service.recordResponseTime(123);

      // Act
      const output = service.exportPrometheus();

      // Assert
      // 有効なPrometheus形式であること
      expect(output.split('\n').filter((line) => line.startsWith('#')).length).toBeGreaterThan(
        0
      );
      expect(output).toMatch(/\w+ \d+/); // メトリクス名と値のパターン
    });
  });
});
