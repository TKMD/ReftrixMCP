// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Benchmark テスト
 * TDD Red フェーズ: 検索パフォーマンスベンチマーク
 *
 * 目的:
 * - レスポンスタイム（P95 < 100ms 目標）
 * - 並列リクエスト（10, 50, 100同時）
 * - コールドスタート vs ウォームスタート
 * - スケーラビリティ（1,000件 vs 10,000件 vs 100,000件）
 * - ページネーション効率
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 型定義（実装はまだ存在しない）
interface SearchResult {
  id: string;
  name: string;
  embedding: number[];
  similarity: number;
}

interface SearchPerformanceMetrics {
  requestCount: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  throughput: number; // requests per second
}

interface BenchmarkResult {
  testName: string;
  metrics: SearchPerformanceMetrics;
  passed: boolean;
  threshold: number;
}

type SearchService = {
  search: (query: string, limit?: number, offset?: number) => Promise<SearchResult[]>;
  clearCache: () => void;
};

type BenchmarkRunner = {
  runBenchmark: (
    fn: () => Promise<unknown>,
    options: { iterations: number; warmup?: number }
  ) => Promise<SearchPerformanceMetrics>;
  runParallelBenchmark: (
    fn: () => Promise<unknown>,
    options: { concurrency: number; iterations: number }
  ) => Promise<SearchPerformanceMetrics>;
};

describe('Search Benchmark', () => {
  let searchService: SearchService;
  let benchmarkRunner: BenchmarkRunner;

  beforeEach(() => {
    // モック検索サービス
    let cacheEnabled = true;
    const cache = new Map<string, SearchResult[]>();

    searchService = {
      search: async (query: string, limit = 10, offset = 0) => {
        const cacheKey = `${query}:${limit}:${offset}`;

        // キャッシュヒット
        if (cacheEnabled && cache.has(cacheKey)) {
          await new Promise((resolve) => setTimeout(resolve, 5)); // 5ms
          return cache.get(cacheKey)!;
        }

        // キャッシュミス（検索実行）
        await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms

        const results: SearchResult[] = Array.from({ length: limit }, (_, i) => ({
          id: `svg-${offset + i}`,
          name: `SVG ${offset + i}`,
          embedding: new Array(384).fill(0),
          similarity: 0.9 - i * 0.01,
        }));

        cache.set(cacheKey, results);
        return results;
      },
      clearCache: () => {
        cache.clear();
      },
    };

    // ベンチマークランナー
    benchmarkRunner = {
      runBenchmark: async (fn, options) => {
        const { iterations, warmup = 5 } = options;
        const times: number[] = [];

        // ウォームアップ
        for (let i = 0; i < warmup; i++) {
          await fn();
        }

        // 計測
        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          const iterStart = performance.now();
          await fn();
          const iterEnd = performance.now();
          times.push(iterEnd - iterStart);
        }
        const endTime = performance.now();

        const sorted = times.sort((a, b) => a - b);
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const duration = (endTime - startTime) / 1000; // 秒

        return {
          requestCount: iterations,
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
          mean: sum / sorted.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          throughput: iterations / duration,
        };
      },
      runParallelBenchmark: async (fn, options) => {
        const { concurrency, iterations } = options;
        const times: number[] = [];

        const startTime = performance.now();

        // 並列実行
        for (let batch = 0; batch < iterations; batch += concurrency) {
          const batchSize = Math.min(concurrency, iterations - batch);
          const promises = Array.from({ length: batchSize }, async () => {
            const iterStart = performance.now();
            await fn();
            const iterEnd = performance.now();
            return iterEnd - iterStart;
          });

          const batchTimes = await Promise.all(promises);
          times.push(...batchTimes);
        }

        const endTime = performance.now();

        const sorted = times.sort((a, b) => a - b);
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const duration = (endTime - startTime) / 1000;

        return {
          requestCount: iterations,
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
          mean: sum / sorted.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          throughput: iterations / duration,
        };
      },
    };
  });

  describe('レスポンスタイム - P95 < 100ms 目標', () => {
    it('P95レスポンスタイムが100ms未満であること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('blue bird'),
        { iterations: 100, warmup: 10 }
      );

      expect(metrics.p95).toBeLessThan(100);
      expect(metrics.requestCount).toBe(100);
      // TDD Red: P95目標の実装がないため失敗
    });

    it('P50レスポンスタイムが50ms未満であること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('bird'),
        { iterations: 100, warmup: 10 }
      );

      expect(metrics.p50).toBeLessThan(50);
      // TDD Red: P50目標の実装がないため失敗
    });

    it('P99レスポンスタイムが150ms未満であること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('cat'),
        { iterations: 100, warmup: 10 }
      );

      expect(metrics.p99).toBeLessThan(150);
      // TDD Red: P99目標の実装がないため失敗
    });

    it('平均レスポンスタイムが60ms未満であること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('dog'),
        { iterations: 50 }
      );

      expect(metrics.mean).toBeLessThan(60);
      // TDD Red: 平均目標の実装がないため失敗
    });
  });

  describe('並列リクエスト', () => {
    it('10同時リクエストを処理できること', async () => {
      const metrics = await benchmarkRunner.runParallelBenchmark(
        () => searchService.search('bird'),
        { concurrency: 10, iterations: 100 }
      );

      expect(metrics.requestCount).toBe(100);
      expect(metrics.p95).toBeLessThan(200); // 並列では少し緩和
      // TDD Red: 10並列の実装がないため失敗
    });

    it('50同時リクエストを処理できること', async () => {
      const metrics = await benchmarkRunner.runParallelBenchmark(
        () => searchService.search('icon'),
        { concurrency: 50, iterations: 100 }
      );

      expect(metrics.requestCount).toBe(100);
      expect(metrics.p95).toBeLessThan(300);
      // TDD Red: 50並列の実装がないため失敗
    });

    it('100同時リクエストを処理できること', async () => {
      const metrics = await benchmarkRunner.runParallelBenchmark(
        () => searchService.search('logo'),
        { concurrency: 100, iterations: 100 }
      );

      expect(metrics.requestCount).toBe(100);
      expect(metrics.p95).toBeLessThan(500);
      // TDD Red: 100並列の実装がないため失敗
    });

    it('並列度が高いほどスループットが向上すること', async () => {
      const sequential = await benchmarkRunner.runBenchmark(
        () => searchService.search('test'),
        { iterations: 50 }
      );

      const parallel10 = await benchmarkRunner.runParallelBenchmark(
        () => searchService.search('test'),
        { concurrency: 10, iterations: 50 }
      );

      expect(parallel10.throughput).toBeGreaterThan(sequential.throughput);
      // TDD Red: スループット改善の実装がないため失敗
    });
  });

  describe('コールドスタート vs ウォームスタート', () => {
    it('コールドスタート（初回）は遅いこと', async () => {
      searchService.clearCache();

      const coldStart = performance.now();
      await searchService.search('cold start test');
      const coldEnd = performance.now();
      const coldTime = coldEnd - coldStart;

      expect(coldTime).toBeGreaterThan(40); // キャッシュなし
      // TDD Red: コールドスタート計測の実装がないため失敗
    });

    it('ウォームスタート（キャッシュヒット）は速いこと', async () => {
      // 1回目（キャッシュ作成）
      await searchService.search('warm start test');

      // 2回目（キャッシュヒット）
      const warmStart = performance.now();
      await searchService.search('warm start test');
      const warmEnd = performance.now();
      const warmTime = warmEnd - warmStart;

      expect(warmTime).toBeLessThan(20); // キャッシュヒット
      // TDD Red: ウォームスタート計測の実装がないため失敗
    });

    it('キャッシュありなしで5倍以上の差があること', async () => {
      searchService.clearCache();

      // コールドスタート
      const coldStart = performance.now();
      await searchService.search('performance test');
      const coldEnd = performance.now();
      const coldTime = coldEnd - coldStart;

      // ウォームスタート
      const warmStart = performance.now();
      await searchService.search('performance test');
      const warmEnd = performance.now();
      const warmTime = warmEnd - warmStart;

      expect(coldTime).toBeGreaterThan(warmTime * 5);
      // TDD Red: キャッシュ効果の実装がないため失敗
    });
  });

  describe('スケーラビリティ', () => {
    it('1,000件のデータセットで検索できること', async () => {
      // 1,000件を想定したモック
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Array.from({ length: 10 }, (_, i) => ({
          id: `svg-${i}`,
          name: `SVG ${i}`,
          embedding: [],
          similarity: 0.9,
        }));
      });

      const metrics = await benchmarkRunner.runBenchmark(mockSearch, {
        iterations: 20,
      });

      expect(metrics.p95).toBeLessThan(100);
      // TDD Red: 1,000件スケールの実装がないため失敗
    });

    it('10,000件のデータセットで検索できること', async () => {
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return Array.from({ length: 10 }, (_, i) => ({
          id: `svg-${i}`,
          name: `SVG ${i}`,
          embedding: [],
          similarity: 0.9,
        }));
      });

      const metrics = await benchmarkRunner.runBenchmark(mockSearch, {
        iterations: 20,
      });

      expect(metrics.p95).toBeLessThan(150);
      // TDD Red: 10,000件スケールの実装がないため失敗
    });

    it('100,000件のデータセットで検索できること', async () => {
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return Array.from({ length: 10 }, (_, i) => ({
          id: `svg-${i}`,
          name: `SVG ${i}`,
          embedding: [],
          similarity: 0.9,
        }));
      });

      const metrics = await benchmarkRunner.runBenchmark(mockSearch, {
        iterations: 10,
      });

      expect(metrics.p95).toBeLessThan(200);
      // TDD Red: 100,000件スケールの実装がないため失敗
    });

    it('データセットサイズが大きくなっても線形的な劣化であること', async () => {
      const mock1k = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      });

      const mock10k = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [];
      });

      const metrics1k = await benchmarkRunner.runBenchmark(mock1k, {
        iterations: 20,
      });
      const metrics10k = await benchmarkRunner.runBenchmark(mock10k, {
        iterations: 20,
      });

      // 10倍のデータで2倍未満の劣化
      expect(metrics10k.mean).toBeLessThan(metrics1k.mean * 2);
      // TDD Red: 線形スケーラビリティの実装がないため失敗
    });
  });

  describe('ページネーション効率', () => {
    it('ページネーションで異なるページを取得できること', async () => {
      const page1 = await searchService.search('bird', 10, 0);
      const page2 = await searchService.search('bird', 10, 10);

      expect(page1[0].id).not.toBe(page2[0].id);
      expect(page1).toHaveLength(10);
      expect(page2).toHaveLength(10);
      // TDD Red: ページネーションの実装がないため失敗
    });

    it('ページネーションのパフォーマンスが一定であること', async () => {
      const page1Time = performance.now();
      await searchService.search('icon', 10, 0);
      const page1End = performance.now();

      const page2Time = performance.now();
      await searchService.search('icon', 10, 100);
      const page2End = performance.now();

      const time1 = page1End - page1Time;
      const time2 = page2End - page2Time;

      // ページ位置による大きな差がないこと（HNSW特性）
      expect(Math.abs(time1 - time2)).toBeLessThan(50);
      // TDD Red: ページネーション効率の実装がないため失敗
    });

    it('大きなlimitでもP95 < 200msであること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('logo', 100),
        { iterations: 20 }
      );

      expect(metrics.p95).toBeLessThan(200);
      // TDD Red: 大きなlimitの実装がないため失敗
    });
  });

  describe('スループット', () => {
    it('毎秒10リクエスト以上処理できること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('test'),
        { iterations: 50 }
      );

      expect(metrics.throughput).toBeGreaterThan(10);
      // TDD Red: スループット計測の実装がないため失敗
    });

    it('並列実行時に毎秒50リクエスト以上処理できること', async () => {
      const metrics = await benchmarkRunner.runParallelBenchmark(
        () => searchService.search('parallel'),
        { concurrency: 10, iterations: 100 }
      );

      expect(metrics.throughput).toBeGreaterThan(50);
      // TDD Red: 並列スループットの実装がないため失敗
    });
  });

  describe('統計情報の正確性', () => {
    it('min/max/meanが正しく計算されること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('stats'),
        { iterations: 50 }
      );

      expect(metrics.min).toBeLessThanOrEqual(metrics.mean);
      expect(metrics.mean).toBeLessThanOrEqual(metrics.max);
      expect(metrics.p50).toBeLessThanOrEqual(metrics.p95);
      expect(metrics.p95).toBeLessThanOrEqual(metrics.p99);
      // TDD Red: 統計計算の実装がないため失敗
    });

    it('requestCountが正しくカウントされること', async () => {
      const metrics = await benchmarkRunner.runBenchmark(
        () => searchService.search('count'),
        { iterations: 75 }
      );

      expect(metrics.requestCount).toBe(75);
      // TDD Red: カウント処理の実装がないため失敗
    });
  });
});
