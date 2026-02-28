// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query Analyzer Service
 * クエリ分析・パフォーマンス監視サービス
 *
 * 目的:
 * - クエリ実行時間の計測
 * - スロークエリの検出（100ms超）
 * - 統計収集（P50/P95/P99レイテンシ計算）
 * - クエリパターン別統計
 * - 時間帯別負荷分析
 * - 最適化提案
 */

import { Logger } from '../utils/logger';

const logger = new Logger('QueryAnalyzer');

/**
 * クエリメトリクスの型定義
 */
export interface QueryMetrics {
  queryPattern: string;
  executionTimeMs: number;
  timestamp: Date;
  rowsExamined?: number;
  indexUsed?: string;
}

/**
 * クエリ統計情報の型定義
 */
export interface QueryStats {
  pattern: string;
  count: number;
  avgTimeMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minTimeMs: number;
  maxTimeMs: number;
}

/**
 * 時間帯別統計情報の型定義
 */
export interface HourlyStats {
  hour: number;
  queryCount: number;
  avgResponseTime: number;
}

/**
 * 最適化提案の型定義
 */
export interface OptimizationSuggestion {
  type: 'index' | 'rewrite' | 'caching';
  pattern: string;
  suggestion: string;
  expectedImprovement: string;
  priority: 'low' | 'medium' | 'high';
}

/**
 * クエリ分析サービスクラス
 */
export class QueryAnalyzer {
  private metrics: QueryMetrics[] = [];
  private slowQueryThreshold: number;
  private maxMetricsHistory: number;

  constructor(options?: { slowQueryThresholdMs?: number; maxMetricsHistory?: number }) {
    this.slowQueryThreshold = options?.slowQueryThresholdMs ?? 100;
    this.maxMetricsHistory = options?.maxMetricsHistory ?? 10000;

    logger.debug('Initialized', {
      slowQueryThreshold: this.slowQueryThreshold,
      maxMetricsHistory: this.maxMetricsHistory,
    });
  }

  /**
   * クエリ実行を記録
   * @param pattern クエリパターン
   * @param executionTimeMs 実行時間（ミリ秒）
   * @param metadata 追加メタデータ
   */
  recordQuery(
    pattern: string,
    executionTimeMs: number,
    metadata?: Partial<Pick<QueryMetrics, 'rowsExamined' | 'indexUsed'>>
  ): void {
    const metric: QueryMetrics = {
      queryPattern: pattern,
      executionTimeMs,
      timestamp: new Date(),
      ...metadata,
    };

    this.metrics.push(metric);

    // 履歴サイズを制限
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics.shift();
    }

    const isSlow = executionTimeMs > this.slowQueryThreshold;
    logger.debug('Query recorded', {
      pattern,
      executionTimeMs,
      isSlow,
      ...metadata,
    });
  }

  /**
   * スロークエリを取得
   * @param thresholdMs オプションの閾値（デフォルト: 100ms）
   * @returns スロークエリのリスト
   */
  getSlowQueries(thresholdMs?: number): QueryMetrics[] {
    const threshold = thresholdMs ?? this.slowQueryThreshold;
    const slowQueries = this.metrics.filter((m) => m.executionTimeMs > threshold);

    logger.debug('Slow queries', {
      threshold,
      count: slowQueries.length,
    });

    return slowQueries;
  }

  /**
   * クエリパターン別の統計を取得
   * @returns クエリパターン別統計のリスト
   */
  getStatsByPattern(): QueryStats[] {
    const patternMap = new Map<string, number[]>();

    for (const metric of this.metrics) {
      const existing = patternMap.get(metric.queryPattern) ?? [];
      existing.push(metric.executionTimeMs);
      patternMap.set(metric.queryPattern, existing);
    }

    const stats: QueryStats[] = [];

    for (const [pattern, times] of patternMap) {
      const sorted = [...times].sort((a, b) => a - b);
      const sum = times.reduce((acc, val) => acc + val, 0);

      stats.push({
        pattern,
        count: times.length,
        avgTimeMs: sum / times.length,
        p50Ms: this.getPercentile(sorted, 50),
        p95Ms: this.getPercentile(sorted, 95),
        p99Ms: this.getPercentile(sorted, 99),
        minTimeMs: sorted[0] ?? 0,
        maxTimeMs: sorted[sorted.length - 1] ?? 0,
      });
    }

    logger.debug('Stats by pattern', {
      patternCount: stats.length,
    });

    return stats;
  }

  /**
   * 時間帯別統計を取得（UTC時間）
   * @returns 時間帯別統計のリスト
   */
  getHourlyStats(): HourlyStats[] {
    const hourlyMap = new Map<number, number[]>();

    for (const metric of this.metrics) {
      // UTC時間を使用してタイムゾーン非依存にする
      const hour = metric.timestamp.getUTCHours();
      const existing = hourlyMap.get(hour) ?? [];
      existing.push(metric.executionTimeMs);
      hourlyMap.set(hour, existing);
    }

    const stats: HourlyStats[] = [];

    for (const [hour, times] of hourlyMap) {
      const sum = times.reduce((acc, val) => acc + val, 0);

      stats.push({
        hour,
        queryCount: times.length,
        avgResponseTime: sum / times.length,
      });
    }

    // 時間順にソート
    stats.sort((a, b) => a.hour - b.hour);

    logger.debug('Hourly stats', {
      hourCount: stats.length,
    });

    return stats;
  }

  /**
   * パーセンタイル値を計算
   * @param sortedTimes ソート済み実行時間配列
   * @param percentile パーセンタイル（0-100）
   * @returns パーセンタイル値
   */
  getPercentile(sortedTimes: number[], percentile: number): number {
    if (sortedTimes.length === 0) return 0;

    const index = Math.floor((sortedTimes.length * percentile) / 100);
    const clampedIndex = Math.min(index, sortedTimes.length - 1);
    return sortedTimes[clampedIndex] ?? 0;
  }

  /**
   * 最適化提案を生成
   * @returns 最適化提案のリスト
   */
  getOptimizationSuggestions(): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const stats = this.getStatsByPattern();

    for (const stat of stats) {
      // P95が100msを超えるパターンにはインデックス提案
      if (stat.p95Ms > 100) {
        suggestions.push({
          type: 'index',
          pattern: stat.pattern,
          suggestion: `Consider adding an index for pattern: ${stat.pattern}. P95 is ${stat.p95Ms.toFixed(2)}ms.`,
          expectedImprovement: 'Reduce P95 latency by 50-70%',
          priority: stat.p95Ms > 200 ? 'high' : 'medium',
        });
      }

      // P99が500msを超えるパターンにはクエリ書き換え提案
      if (stat.p99Ms > 500) {
        suggestions.push({
          type: 'rewrite',
          pattern: stat.pattern,
          suggestion: `Consider rewriting query for pattern: ${stat.pattern}. P99 is ${stat.p99Ms.toFixed(2)}ms.`,
          expectedImprovement: 'Reduce P99 latency by 30-50%',
          priority: 'high',
        });
      }

      // 頻繁に呼ばれるパターンにはキャッシング提案
      if (stat.count > 100 && stat.avgTimeMs > 50) {
        suggestions.push({
          type: 'caching',
          pattern: stat.pattern,
          suggestion: `Consider caching results for pattern: ${stat.pattern}. Called ${stat.count} times with avg ${stat.avgTimeMs.toFixed(2)}ms.`,
          expectedImprovement: 'Reduce load by 80-90%',
          priority: stat.count > 500 ? 'high' : 'medium',
        });
      }
    }

    // 優先度順にソート
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    logger.debug('Optimization suggestions', {
      count: suggestions.length,
    });

    return suggestions;
  }

  /**
   * メトリクスをクリア
   */
  clear(): void {
    this.metrics = [];
    logger.debug('Metrics cleared');
  }

  /**
   * メトリクス件数を取得
   * @returns メトリクス件数
   */
  getMetricsCount(): number {
    return this.metrics.length;
  }

  /**
   * 全メトリクスを取得
   * @returns 全メトリクス
   */
  getAllMetrics(): QueryMetrics[] {
    return [...this.metrics];
  }
}

/**
 * シングルトンインスタンス
 */
export const queryAnalyzer = new QueryAnalyzer();
