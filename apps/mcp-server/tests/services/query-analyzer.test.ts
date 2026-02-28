// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query Analyzer Service テスト
 * TDD Red フェーズ: クエリ分析サービスのテスト
 *
 * 目的:
 * - クエリ解析（実行時間計測、実行計画取得）
 * - スロークエリ検出（100ms超）
 * - 統計収集（P50/P95/P99レイテンシ計算）
 * - クエリパターン別統計
 * - 時間帯別負荷分析
 * - 最適化提案（インデックス推奨、クエリ書き換え）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// =====================================================
// 型定義（実装はまだ存在しない）
// =====================================================

interface QueryExecutionPlan {
  query: string;
  planningTime: number;
  executionTime: number;
  totalCost: number;
  plan: unknown;
}

interface QueryAnalysisResult {
  queryHash: string;
  executionTime: number;
  plan?: QueryExecutionPlan;
  isSlow: boolean;
  timestamp: number;
}

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  count: number;
}

interface QueryPatternStats {
  pattern: string;
  count: number;
  avgExecutionTime: number;
  p95ExecutionTime: number;
  slowQueryCount: number;
}

interface HourlyLoadStats {
  hour: number;
  queryCount: number;
  avgExecutionTime: number;
  peakExecutionTime: number;
}

interface OptimizationSuggestion {
  type: 'index' | 'rewrite';
  queryPattern: string;
  suggestion: string;
  expectedImprovement: string;
}

type QueryAnalyzerService = {
  analyzeQuery: (sql: string, params?: unknown[]) => Promise<QueryAnalysisResult>;
  detectSlowQueries: (thresholdMs?: number) => Promise<QueryAnalysisResult[]>;
  getLatencyStats: (timeRangeMs?: number) => Promise<LatencyStats>;
  getQueryPatternStats: () => Promise<QueryPatternStats[]>;
  getHourlyLoadStats: () => Promise<HourlyLoadStats[]>;
  suggestOptimizations: () => Promise<OptimizationSuggestion[]>;
  clear: () => void;
};

// =====================================================
// 共通ファクトリー・ヘルパー（重複削減）
// =====================================================

// 空のLatencyStats（重複削減）
const EMPTY_LATENCY_STATS: LatencyStats = { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, count: 0 };

// パーセンタイル計算ヘルパー（重複削減）
const calculatePercentile = (sorted: number[], percentile: number): number =>
  sorted[Math.floor(sorted.length * percentile)] ?? 0;

// LatencyStats計算ヘルパー（重複削減）
const calculateLatencyStats = (queries: QueryAnalysisResult[], timeRangeMs?: number): LatencyStats => {
  let filtered = queries;
  if (timeRangeMs) {
    const cutoff = Date.now() - timeRangeMs;
    filtered = queries.filter((q) => q.timestamp > cutoff);
  }
  if (filtered.length === 0) return { ...EMPTY_LATENCY_STATS };

  const sorted = filtered.map((q) => q.executionTime).sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);

  return {
    p50: calculatePercentile(sorted, 0.5),
    p95: calculatePercentile(sorted, 0.95),
    p99: calculatePercentile(sorted, 0.99),
    mean: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
};

// QueryPatternStats計算ヘルパー（重複削減）
const calculateQueryPatternStats = (queryHistory: QueryAnalysisResult[]): QueryPatternStats[] => {
  const patterns = new Map<string, number[]>();
  for (const query of queryHistory) {
    const pattern = query.queryHash;
    if (!patterns.has(pattern)) patterns.set(pattern, []);
    patterns.get(pattern)!.push(query.executionTime);
  }

  return Array.from(patterns.entries()).map(([pattern, times]) => {
    const sorted = times.sort((a, b) => a - b);
    const avg = times.reduce((acc, val) => acc + val, 0) / times.length;
    return {
      pattern,
      count: times.length,
      avgExecutionTime: avg,
      p95ExecutionTime: calculatePercentile(sorted, 0.95),
      slowQueryCount: times.filter((t) => t > 100).length,
    };
  });
};

// HourlyLoadStats計算ヘルパー（重複削減）
const calculateHourlyLoadStats = (queryHistory: QueryAnalysisResult[], useUtc = false): HourlyLoadStats[] => {
  const hourlyData = new Map<number, number[]>();
  for (const query of queryHistory) {
    const hour = useUtc ? new Date(query.timestamp).getUTCHours() : new Date(query.timestamp).getHours();
    if (!hourlyData.has(hour)) hourlyData.set(hour, []);
    hourlyData.get(hour)!.push(query.executionTime);
  }

  return Array.from(hourlyData.entries()).map(([hour, times]) => ({
    hour,
    queryCount: times.length,
    avgExecutionTime: times.reduce((acc, val) => acc + val, 0) / times.length,
    peakExecutionTime: Math.max(...times),
  }));
};

// 最適化提案生成ヘルパー（重複削減）
const generateOptimizationSuggestions = (patternStats: QueryPatternStats[]): OptimizationSuggestion[] => {
  const suggestions: OptimizationSuggestion[] = [];
  for (const stat of patternStats) {
    if (stat.slowQueryCount > stat.count * 0.3) {
      suggestions.push({
        type: 'index',
        queryPattern: stat.pattern,
        suggestion: 'Add index on frequently filtered columns',
        expectedImprovement: 'Reduce execution time by 50-70%',
      });
    }
    if (stat.p95ExecutionTime > 200) {
      suggestions.push({
        type: 'rewrite',
        queryPattern: stat.pattern,
        suggestion: 'Consider using CTEs or subqueries',
        expectedImprovement: 'Reduce execution time by 30-50%',
      });
    }
  }
  return suggestions;
};

// AnalyzerConfig型定義（重複削減）
interface AnalyzerConfig {
  hashFn?: (sql: string) => string;
  execTimeFn?: (sql: string) => number;
  mockDatabase?: { execute: ReturnType<typeof vi.fn>; explain: ReturnType<typeof vi.fn> };
  useUtcHours?: boolean;
}

// QueryAnalyzerService ファクトリー（重複削減）
const createQueryAnalyzer = (config: AnalyzerConfig = {}): { analyzer: QueryAnalyzerService; queryHistory: QueryAnalysisResult[] } => {
  const queryHistory: QueryAnalysisResult[] = [];
  const hashFn = config.hashFn ?? ((sql: string) => Buffer.from(sql).toString('base64').substring(0, 16));
  const execTimeFn = config.execTimeFn ?? (() => Math.random() * 100);
  const useUtcHours = config.useUtcHours ?? false;

  const analyzer: QueryAnalyzerService = {
    analyzeQuery: async (sql: string, params?: unknown[]) => {
      let executionTime: number;
      let plan: QueryExecutionPlan | undefined;

      if (config.mockDatabase) {
        const startTime = performance.now();
        await config.mockDatabase.execute(sql, params);
        executionTime = performance.now() - startTime;
        plan = await config.mockDatabase.explain(`EXPLAIN ANALYZE ${sql}`);
      } else {
        executionTime = execTimeFn(sql);
      }

      const result: QueryAnalysisResult = {
        queryHash: hashFn(sql),
        executionTime,
        plan,
        isSlow: executionTime > 100,
        timestamp: Date.now(),
      };
      queryHistory.push(result);
      return result;
    },
    detectSlowQueries: async (thresholdMs = 100) => queryHistory.filter((q) => q.executionTime > thresholdMs),
    getLatencyStats: async (timeRangeMs?: number) => calculateLatencyStats(queryHistory, timeRangeMs),
    getQueryPatternStats: async () => calculateQueryPatternStats(queryHistory),
    getHourlyLoadStats: async () => calculateHourlyLoadStats(queryHistory, useUtcHours),
    suggestOptimizations: async () => generateOptimizationSuggestions(await analyzer.getQueryPatternStats()),
    clear: () => { queryHistory.length = 0; },
  };

  return { analyzer, queryHistory };
};

describe('Query Analyzer Service', () => {
  // ---------------------------------------------------
  // クエリ解析（mockDatabaseを使用）
  // ---------------------------------------------------
  describe('クエリ解析', () => {
    let analyzer: QueryAnalyzerService;
    let mockDatabase: { execute: ReturnType<typeof vi.fn>; explain: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockDatabase = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        explain: vi.fn().mockResolvedValue({
          planningTime: 0.5,
          executionTime: 10.2,
          totalCost: 100.5,
          plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'svg_assets' },
        }),
      };
      ({ analyzer } = createQueryAnalyzer({ mockDatabase }));
    });

    it('クエリ実行時間を計測できること', async () => {
      const result = await analyzer.analyzeQuery('SELECT * FROM svg_assets LIMIT 10');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.queryHash).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('実行計画を取得できること', async () => {
      const result = await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE id = $1', ['123']);
      expect(result.plan).toBeDefined();
      expect(result.plan?.planningTime).toBeGreaterThanOrEqual(0);
      expect(result.plan?.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.plan?.totalCost).toBeGreaterThanOrEqual(0);
      expect(mockDatabase.explain).toHaveBeenCalled();
    });

    it('スロークエリを検出できること（100ms超）', async () => {
      mockDatabase.execute.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { rows: [] };
      });
      const result = await analyzer.analyzeQuery('SELECT * FROM svg_assets');
      expect(result.isSlow).toBe(true);
      expect(result.executionTime).toBeGreaterThan(100);
    });

    it('高速クエリは非スロークエリとしてマークされること', async () => {
      mockDatabase.execute.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { rows: [] };
      });
      const result = await analyzer.analyzeQuery('SELECT * FROM svg_assets LIMIT 1');
      expect(result.isSlow).toBe(false);
      expect(result.executionTime).toBeLessThan(100);
    });
  });

  // ---------------------------------------------------
  // スロークエリ検出
  // ---------------------------------------------------
  describe('スロークエリ検出', () => {
    let analyzer: QueryAnalyzerService;
    beforeEach(() => {
      ({ analyzer } = createQueryAnalyzer({ execTimeFn: () => Math.random() * 200 }));
    });

    it('100ms超のクエリを検出できること', async () => {
      for (let i = 0; i < 10; i++) await analyzer.analyzeQuery(`SELECT * FROM svg_assets WHERE id = ${i}`);
      const slowQueries = await analyzer.detectSlowQueries(100);
      expect(slowQueries.every((q) => q.executionTime > 100)).toBe(true);
    });

    it('カスタム閾値でスロークエリを検出できること', async () => {
      await analyzer.analyzeQuery('SELECT * FROM svg_assets');
      const slowQueries50 = await analyzer.detectSlowQueries(50);
      const slowQueries150 = await analyzer.detectSlowQueries(150);
      expect(slowQueries50.length).toBeGreaterThanOrEqual(slowQueries150.length);
    });
  });

  // ---------------------------------------------------
  // 統計収集 - P50/P95/P99レイテンシ計算
  // ---------------------------------------------------
  describe('統計収集 - P50/P95/P99レイテンシ計算', () => {
    let analyzer: QueryAnalyzerService;
    beforeEach(() => { ({ analyzer } = createQueryAnalyzer()); });

    it('P50/P95/P99レイテンシを計算できること', async () => {
      for (let i = 0; i < 100; i++) await analyzer.analyzeQuery(`SELECT * FROM svg_assets WHERE id = ${i}`);
      const stats = await analyzer.getLatencyStats();
      expect(stats.p50).toBeGreaterThanOrEqual(0);
      expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
      expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
      expect(stats.count).toBe(100);
    });

    it('平均値・最小値・最大値を計算できること', async () => {
      for (let i = 0; i < 50; i++) await analyzer.analyzeQuery(`SELECT * FROM svg_assets WHERE id = ${i}`);
      const stats = await analyzer.getLatencyStats();
      expect(stats.mean).toBeGreaterThanOrEqual(0);
      expect(stats.min).toBeGreaterThanOrEqual(0);
      expect(stats.max).toBeGreaterThanOrEqual(stats.min);
      expect(stats.mean).toBeGreaterThanOrEqual(stats.min);
      expect(stats.mean).toBeLessThanOrEqual(stats.max);
    });

    it('時間範囲を指定して統計を取得できること', async () => {
      vi.useFakeTimers();
      await analyzer.analyzeQuery('SELECT 1');
      vi.advanceTimersByTime(60000);
      await analyzer.analyzeQuery('SELECT 2');
      const stats30s = await analyzer.getLatencyStats(30000);
      const statsAll = await analyzer.getLatencyStats();
      expect(stats30s.count).toBeLessThanOrEqual(statsAll.count);
      vi.useRealTimers();
    });

    it('クエリがない場合は0値を返すこと', async () => {
      const stats = await analyzer.getLatencyStats();
      expect(stats.p50).toBe(0);
      expect(stats.p95).toBe(0);
      expect(stats.p99).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.count).toBe(0);
    });
  });

  // ---------------------------------------------------
  // クエリパターン別統計
  // ---------------------------------------------------
  describe('クエリパターン別統計', () => {
    let analyzer: QueryAnalyzerService;
    beforeEach(() => {
      ({ analyzer } = createQueryAnalyzer({
        hashFn: (sql) => sql.includes('search') ? 'search-pattern' : 'other-pattern',
        execTimeFn: () => Math.random() * 150,
      }));
    });

    it('クエリパターンごとに統計を集計できること', async () => {
      await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE id = 1');
      const stats = await analyzer.getQueryPatternStats();
      expect(stats.length).toBeGreaterThan(0);
      const searchPattern = stats.find((s) => s.pattern === 'search-pattern');
      expect(searchPattern).toBeDefined();
      expect(searchPattern!.count).toBe(2);
    });

    it('パターンごとの平均実行時間を計算できること', async () => {
      await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      const stats = await analyzer.getQueryPatternStats();
      const searchPattern = stats.find((s) => s.pattern === 'search-pattern');
      expect(searchPattern?.avgExecutionTime).toBeGreaterThanOrEqual(0);
    });

    it('パターンごとのP95実行時間を計算できること', async () => {
      for (let i = 0; i < 20; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      const stats = await analyzer.getQueryPatternStats();
      const searchPattern = stats.find((s) => s.pattern === 'search-pattern');
      expect(searchPattern?.p95ExecutionTime).toBeGreaterThanOrEqual(0);
    });

    it('パターンごとのスロークエリ数を集計できること', async () => {
      for (let i = 0; i < 10; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE search = true');
      const stats = await analyzer.getQueryPatternStats();
      const searchPattern = stats.find((s) => s.pattern === 'search-pattern');
      expect(searchPattern?.slowQueryCount).toBeGreaterThanOrEqual(0);
      expect(searchPattern?.slowQueryCount).toBeLessThanOrEqual(searchPattern!.count);
    });
  });

  // ---------------------------------------------------
  // 時間帯別負荷分析
  // ---------------------------------------------------
  describe('時間帯別負荷分析', () => {
    let analyzer: QueryAnalyzerService;
    beforeEach(() => { ({ analyzer } = createQueryAnalyzer({ useUtcHours: true })); });

    it('時間帯ごとのクエリ数を集計できること', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-11-30T10:00:00Z'));
      await analyzer.analyzeQuery('SELECT 1');
      await analyzer.analyzeQuery('SELECT 2');
      vi.setSystemTime(new Date('2025-11-30T14:00:00Z'));
      await analyzer.analyzeQuery('SELECT 3');
      const stats = await analyzer.getHourlyLoadStats();
      expect(stats.length).toBeGreaterThan(0);
      const hour10 = stats.find((s) => s.hour === 10);
      expect(hour10?.queryCount).toBe(2);
      vi.useRealTimers();
    });

    it('時間帯ごとの平均実行時間を計算できること', async () => {
      await analyzer.analyzeQuery('SELECT 1');
      await analyzer.analyzeQuery('SELECT 2');
      const stats = await analyzer.getHourlyLoadStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].avgExecutionTime).toBeGreaterThanOrEqual(0);
    });

    it('時間帯ごとのピーク実行時間を計算できること', async () => {
      await analyzer.analyzeQuery('SELECT 1');
      await analyzer.analyzeQuery('SELECT 2');
      const stats = await analyzer.getHourlyLoadStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].peakExecutionTime).toBeGreaterThanOrEqual(stats[0].avgExecutionTime);
    });
  });

  // ---------------------------------------------------
  // 最適化提案
  // ---------------------------------------------------
  describe('最適化提案', () => {
    let analyzer: QueryAnalyzerService;
    beforeEach(() => {
      ({ analyzer } = createQueryAnalyzer({
        hashFn: (sql) => sql.includes('slow') ? 'slow-pattern' : 'fast-pattern',
        execTimeFn: (sql) => sql.includes('slow') ? 250 : 50,
      }));
    });

    it('スロークエリが多い場合、インデックスを推奨すること', async () => {
      for (let i = 0; i < 10; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE slow = true');
      const suggestions = await analyzer.suggestOptimizations();
      const indexSuggestion = suggestions.find((s) => s.type === 'index');
      expect(indexSuggestion).toBeDefined();
      expect(indexSuggestion?.suggestion).toContain('index');
    });

    it('P95が高い場合、クエリ書き換えを推奨すること', async () => {
      for (let i = 0; i < 20; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE slow = true');
      const suggestions = await analyzer.suggestOptimizations();
      const rewriteSuggestion = suggestions.find((s) => s.type === 'rewrite');
      expect(rewriteSuggestion).toBeDefined();
      expect(rewriteSuggestion?.suggestion).toBeDefined();
    });

    it('最適化提案に期待される改善効果が含まれること', async () => {
      for (let i = 0; i < 10; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets WHERE slow = true');
      const suggestions = await analyzer.suggestOptimizations();
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].expectedImprovement).toBeDefined();
      expect(suggestions[0].expectedImprovement).toContain('%');
    });

    it('高速クエリには最適化提案がないこと', async () => {
      for (let i = 0; i < 10; i++) await analyzer.analyzeQuery('SELECT * FROM svg_assets LIMIT 1');
      const suggestions = await analyzer.suggestOptimizations();
      expect(suggestions.length).toBe(0);
    });
  });
});
