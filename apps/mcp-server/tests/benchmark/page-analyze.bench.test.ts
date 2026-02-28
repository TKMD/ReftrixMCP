// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze パフォーマンスベンチマーク
 *
 * 各処理ステップの所要時間を測定:
 * - HTML取得（fetchHtml）
 * - Layout分析（analyzeLayout）
 * - Motion検出（detectMotion）
 * - Quality評価（evaluateQuality）
 * - DB保存（saveToDatabase）
 * - Embedding生成
 *
 * 目標値:
 * | 処理 | 目標P95 |
 * |------|---------|
 * | HTML取得 | < 5s |
 * | Layout分析 | < 2s |
 * | Motion検出 | < 3s |
 * | Quality評価 | < 2s |
 * | DB保存 | < 500ms |
 * | Embedding | < 1s |
 * | 合計 | < 10s |
 *
 * @module tests/benchmark/page-analyze.bench
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { performance } from 'perf_hooks';

// Service imports
import {
  getLayoutAnalyzerService,
  type LayoutAnalysisResult,
} from '../../src/services/page/layout-analyzer.service';
import {
  getMotionDetectorService,
  type MotionDetectionResult,
} from '../../src/services/page/motion-detector.service';
import {
  getQualityEvaluatorService,
  type QualityEvaluationResult,
} from '../../src/services/page/quality-evaluator.service';

// Handler import (for full integration test)
import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  setPageAnalyzePrismaClientFactory,
  resetPageAnalyzePrismaClientFactory,
  type IPageAnalyzeService,
  type IPageAnalyzePrismaClient,
} from '../../src/tools/page/analyze.tool';

import type { PageAnalyzeInput, PageAnalyzeOutput } from '../../src/tools/page/schemas';

// =====================================================
// SLO定義（Service Level Objectives）
// =====================================================

export const PAGE_ANALYZE_SLO = {
  'html.fetch': { p95: 5000, p99: 10000 },
  'layout.analyze': { p95: 2000, p99: 4000 },
  'motion.detect': { p95: 3000, p99: 6000 },
  'quality.evaluate': { p95: 2000, p99: 4000 },
  'db.save': { p95: 500, p99: 1000 },
  'embedding.generate': { p95: 1000, p99: 2000 },
  'total': { p95: 10000, p99: 20000 },
  // Video mode（フレームキャプチャ無効時）
  'total_no_video': { p95: 8000, p99: 15000 },
} as const;

export type BenchmarkTarget = keyof typeof PAGE_ANALYZE_SLO;

// =====================================================
// テストHTMLフィクスチャ
// =====================================================

/**
 * シンプルなHTML（1KB程度）
 */
const SIMPLE_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <title>Simple Page</title>
  <style>
    .fade { animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  </style>
</head>
<body>
  <header class="fade">Header</header>
  <main><section>Content</section></main>
  <footer>Footer</footer>
</body>
</html>
`.trim();

/**
 * ランディングページHTML（中規模: 5KB程度）
 */
const LANDING_PAGE_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modern Landing Page</title>
  <meta name="description" content="A modern landing page with animations">
  <style>
    /* Keyframe animations */
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideUp {
      0% { transform: translateY(30px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* Hero section */
    .hero {
      animation: fadeIn 0.8s ease-out;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 80vh;
      display: flex;
      align-items: center;
    }
    .hero-title {
      animation: slideUp 0.6s ease-out 0.2s forwards;
      opacity: 0;
      font-size: 3rem;
      color: white;
    }
    .hero-subtitle {
      animation: slideUp 0.6s ease-out 0.4s forwards;
      opacity: 0;
    }

    /* Button transitions */
    .btn-primary {
      transition: background-color 0.3s ease, transform 0.2s ease;
      background-color: #3B82F6;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      border: none;
    }
    .btn-primary:hover {
      background-color: #2563EB;
      transform: scale(1.05);
    }

    /* Feature cards */
    .feature-card {
      transition: box-shadow 0.3s ease, transform 0.2s ease;
      background: white;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    .feature-card:hover {
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
      transform: translateY(-4px);
    }

    /* Testimonial section */
    .testimonial-card {
      transition: opacity 0.3s ease;
    }

    /* CTA section */
    .cta-section {
      animation: pulse 3s infinite;
      background: #1F2937;
      color: white;
    }

    /* Navigation */
    .nav-link {
      transition: color 0.2s ease;
    }
    .nav-link:hover {
      color: #3B82F6;
    }
  </style>
</head>
<body>
  <header class="navigation">
    <nav>
      <a href="/" class="nav-link">Home</a>
      <a href="/about" class="nav-link">About</a>
      <a href="/services" class="nav-link">Services</a>
      <a href="/contact" class="nav-link">Contact</a>
    </nav>
  </header>

  <section class="hero">
    <div class="hero-content">
      <h1 class="hero-title">Modern SaaS Platform</h1>
      <p class="hero-subtitle">Build amazing products with our powerful tools</p>
      <button class="btn-primary">Get Started</button>
    </div>
  </section>

  <section class="features" id="features">
    <h2>Features</h2>
    <div class="feature-grid">
      <article class="feature-card">
        <h3>Fast Performance</h3>
        <p>Lightning fast page loads with optimized code.</p>
      </article>
      <article class="feature-card">
        <h3>Beautiful Design</h3>
        <p>Modern and responsive design that looks great everywhere.</p>
      </article>
      <article class="feature-card">
        <h3>Easy Integration</h3>
        <p>Simple APIs that integrate with your existing tools.</p>
      </article>
    </div>
  </section>

  <section class="testimonials" id="testimonials">
    <h2>What Our Customers Say</h2>
    <blockquote class="testimonial-card">
      <p>"This product changed our workflow completely."</p>
      <cite>- John Doe, CEO</cite>
    </blockquote>
    <blockquote class="testimonial-card">
      <p>"Amazing experience from start to finish."</p>
      <cite>- Jane Smith, CTO</cite>
    </blockquote>
  </section>

  <section class="cta-section" id="cta">
    <h2>Ready to Get Started?</h2>
    <p>Join thousands of satisfied customers today.</p>
    <button class="btn-primary">Start Free Trial</button>
  </section>

  <footer>
    <nav>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
    </nav>
    <p>&copy; 2025 Modern SaaS. All rights reserved.</p>
  </footer>
</body>
</html>
`.trim();

/**
 * 複雑なHTML（大規模: 20KB程度）
 */
const COMPLEX_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Enterprise Dashboard</title>
  <style>
    /* 多数のキーフレームアニメーション */
    ${Array.from({ length: 20 }, (_, i) => `
    @keyframes animation${i} {
      0% { opacity: 0; transform: translateY(${10 + i * 2}px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .animate-${i} { animation: animation${i} ${0.3 + i * 0.05}s ease-out; }
    `).join('\n')}

    /* 多数のトランジション */
    ${Array.from({ length: 20 }, (_, i) => `
    .transition-${i} {
      transition: all ${0.2 + i * 0.02}s ease;
    }
    .transition-${i}:hover {
      transform: scale(1.0${5 + i % 5});
      box-shadow: 0 ${4 + i}px ${20 + i * 2}px rgba(0, 0, 0, 0.1);
    }
    `).join('\n')}

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }

    .dashboard { display: grid; grid-template-columns: 250px 1fr; gap: 24px; }
    .sidebar { background: #1F2937; color: white; padding: 24px; }
    .main-content { padding: 24px; }
    .card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .chart { height: 300px; background: linear-gradient(to right, #3B82F6, #10B981); border-radius: 8px; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { padding: 12px; border-bottom: 1px solid #E5E7EB; }
  </style>
</head>
<body>
  <div class="dashboard">
    <aside class="sidebar animate-0">
      <nav>
        ${Array.from({ length: 10 }, (_, i) => `
        <a href="/nav${i}" class="nav-item transition-${i}">Navigation ${i + 1}</a>
        `).join('\n')}
      </nav>
    </aside>
    <main class="main-content">
      <header class="animate-1">
        <h1>Dashboard Overview</h1>
      </header>

      <section class="metrics animate-2">
        <h2>Key Metrics</h2>
        <div class="metric-grid">
          ${Array.from({ length: 6 }, (_, i) => `
          <article class="card transition-${i}">
            <h3>Metric ${i + 1}</h3>
            <p class="value">${Math.floor(Math.random() * 10000)}</p>
            <span class="trend">+${(Math.random() * 20).toFixed(1)}%</span>
          </article>
          `).join('\n')}
        </div>
      </section>

      <section class="charts animate-3">
        <h2>Analytics</h2>
        <div class="chart-container">
          <div class="chart" id="revenue-chart">Revenue Over Time</div>
          <div class="chart" id="users-chart">Active Users</div>
        </div>
      </section>

      <section class="data-table animate-4">
        <h2>Recent Activity</h2>
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>Action</th>
              <th>Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${Array.from({ length: 20 }, (_, i) => `
            <tr class="transition-${i % 10}">
              <td>${1000 + i}</td>
              <td>User ${i + 1}</td>
              <td>Action Type ${i % 5}</td>
              <td>2025-12-${String(i + 1).padStart(2, '0')}</td>
              <td>${['Active', 'Pending', 'Completed'][i % 3]}</td>
            </tr>
            `).join('\n')}
          </tbody>
        </table>
      </section>

      <section class="widgets animate-5">
        <h2>Quick Actions</h2>
        ${Array.from({ length: 8 }, (_, i) => `
        <article class="card transition-${i + 10}">
          <h3>Widget ${i + 1}</h3>
          <p>Description for widget ${i + 1}</p>
          <button class="btn transition-${i}">Action</button>
        </article>
        `).join('\n')}
      </section>
    </main>
  </div>

  <footer class="animate-6">
    <p>&copy; 2025 Enterprise Dashboard</p>
  </footer>
</body>
</html>
`.trim();

// =====================================================
// ベンチマークユーティリティ
// =====================================================

interface BenchmarkMetrics {
  iterations: number;
  warmupIterations: number;
  times: number[];
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  passesP95: boolean;
  passesP99: boolean;
}

interface MemoryMetrics {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

function measureMemory(): MemoryMetrics {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: mem.heapUsed / 1024 / 1024,
    heapTotalMB: mem.heapTotal / 1024 / 1024,
    rssMB: mem.rss / 1024 / 1024,
    externalMB: mem.external / 1024 / 1024,
  };
}

async function runBenchmark(
  fn: () => Promise<unknown>,
  target: BenchmarkTarget,
  options: { iterations?: number; warmup?: number } = {}
): Promise<BenchmarkMetrics> {
  const { iterations = 10, warmup = 3 } = options;

  // ウォームアップ
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // GC実行（利用可能な場合）
  if (global.gc) {
    global.gc();
  }

  // 測定
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  // 統計計算
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const percentile = (p: number) => {
    const index = Math.floor(n * (p / 100));
    return sorted[Math.min(index, n - 1)] ?? 0;
  };

  const p95 = percentile(95);
  const p99 = percentile(99);
  const slo = PAGE_ANALYZE_SLO[target];

  return {
    iterations,
    warmupIterations: warmup,
    times,
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    mean,
    median: percentile(50),
    stdDev,
    p50: percentile(50),
    p75: percentile(75),
    p90: percentile(90),
    p95,
    p99,
    passesP95: p95 <= slo.p95,
    passesP99: p99 <= slo.p99,
  };
}

function formatMetrics(target: BenchmarkTarget, metrics: BenchmarkMetrics): string {
  const slo = PAGE_ANALYZE_SLO[target];
  const p95Status = metrics.passesP95 ? 'PASS' : 'FAIL';
  const p99Status = metrics.passesP99 ? 'PASS' : 'FAIL';

  return `
${target}:
  Iterations: ${metrics.iterations} (warmup: ${metrics.warmupIterations})
  Min: ${metrics.min.toFixed(2)}ms
  Max: ${metrics.max.toFixed(2)}ms
  Mean: ${metrics.mean.toFixed(2)}ms
  Median: ${metrics.median.toFixed(2)}ms
  StdDev: ${metrics.stdDev.toFixed(2)}ms
  P50: ${metrics.p50.toFixed(2)}ms
  P75: ${metrics.p75.toFixed(2)}ms
  P90: ${metrics.p90.toFixed(2)}ms
  P95: ${metrics.p95.toFixed(2)}ms [SLO: ${slo.p95}ms] ${p95Status}
  P99: ${metrics.p99.toFixed(2)}ms [SLO: ${slo.p99}ms] ${p99Status}
`.trim();
}

// =====================================================
// モックサービス（HTML取得以外のテスト用）
// =====================================================

function createMockFetchHtml(html: string, delay = 100) {
  return async (
    _url: string,
    _options: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      viewport?: { width: number; height: number };
    }
  ) => {
    // 模擬的なネットワーク遅延
    await new Promise((resolve) => setTimeout(resolve, delay));
    return {
      html,
      title: 'Test Page',
      description: 'Test Description',
      screenshot: undefined,
    };
  };
}

function createMockPrismaClient(): IPageAnalyzePrismaClient {
  return {
    webPage: {
      create: async (args) => ({ id: args.data.id ?? 'mock-web-page-id' }),
    },
    sectionPattern: {
      create: async (args) => ({ id: args.data.id ?? 'mock-section-id' }),
      createMany: async (args) => ({ count: args.data.length }),
    },
    motionPattern: {
      create: async (args) => ({ id: args.data.id ?? 'mock-motion-id' }),
      createMany: async (args) => ({ count: args.data.length }),
    },
    qualityEvaluation: {
      create: async (args) => ({ id: args.data.id ?? 'mock-quality-id' }),
    },
    $transaction: async <T>(fn: (tx: IPageAnalyzePrismaClient) => Promise<T>) => {
      return fn(createMockPrismaClient());
    },
    $executeRawUnsafe: async () => 0,
  };
}

// =====================================================
// ベンチマークテスト
// =====================================================

describe('page.analyze Performance Benchmark', () => {
  const benchmarkResults: Record<string, BenchmarkMetrics> = {};
  let memoryBefore: MemoryMetrics;
  let memoryAfter: MemoryMetrics;

  beforeAll(() => {
    memoryBefore = measureMemory();
    console.log('\n=== page.analyze Performance Benchmark ===\n');
    console.log('Memory Before:', JSON.stringify(memoryBefore, null, 2));
  });

  afterAll(() => {
    memoryAfter = measureMemory();
    console.log('\n=== Benchmark Summary ===\n');

    // 結果サマリー（手動フォーマット）
    for (const [label, metrics] of Object.entries(benchmarkResults)) {
      console.log(`${label}:`);
      console.log(`  Iterations: ${metrics.iterations} (warmup: ${metrics.warmupIterations})`);
      console.log(`  Min: ${metrics.min.toFixed(2)}ms`);
      console.log(`  Max: ${metrics.max.toFixed(2)}ms`);
      console.log(`  Mean: ${metrics.mean.toFixed(2)}ms`);
      console.log(`  Median: ${metrics.median.toFixed(2)}ms`);
      console.log(`  StdDev: ${metrics.stdDev.toFixed(2)}ms`);
      console.log(`  P50: ${metrics.p50.toFixed(2)}ms`);
      console.log(`  P75: ${metrics.p75.toFixed(2)}ms`);
      console.log(`  P90: ${metrics.p90.toFixed(2)}ms`);
      console.log(`  P95: ${metrics.p95.toFixed(2)}ms [${metrics.passesP95 ? 'PASS' : 'FAIL'}]`);
      console.log(`  P99: ${metrics.p99.toFixed(2)}ms [${metrics.passesP99 ? 'PASS' : 'FAIL'}]`);
      console.log('');
    }

    // メモリ使用量
    console.log('Memory After:', JSON.stringify(memoryAfter, null, 2));
    console.log(`Memory Delta (Heap Used): ${(memoryAfter.heapUsedMB - memoryBefore.heapUsedMB).toFixed(2)}MB`);
  });

  beforeEach(() => {
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  afterEach(() => {
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  // =====================================================
  // 個別サービスベンチマーク
  // =====================================================

  describe('Individual Service Benchmarks', () => {
    describe('Layout Analysis', () => {
      it('should analyze simple HTML within SLO', async () => {
        const layoutAnalyzer = getLayoutAnalyzerService();

        const metrics = await runBenchmark(async () => {
          await layoutAnalyzer.analyze(SIMPLE_HTML, {
            includeContent: true,
            includeStyles: true,
          });
        }, 'layout.analyze');

        benchmarkResults['layout.analyze (simple)'] = metrics;
        console.log(formatMetrics('layout.analyze', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should analyze landing page HTML within SLO', async () => {
        const layoutAnalyzer = getLayoutAnalyzerService();

        const metrics = await runBenchmark(async () => {
          await layoutAnalyzer.analyze(LANDING_PAGE_HTML, {
            includeContent: true,
            includeStyles: true,
          });
        }, 'layout.analyze');

        benchmarkResults['layout.analyze (landing)'] = metrics;
        console.log(formatMetrics('layout.analyze', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should analyze complex HTML within SLO', async () => {
        const layoutAnalyzer = getLayoutAnalyzerService();

        const metrics = await runBenchmark(async () => {
          await layoutAnalyzer.analyze(COMPLEX_HTML, {
            includeContent: true,
            includeStyles: true,
          });
        }, 'layout.analyze');

        benchmarkResults['layout.analyze (complex)'] = metrics;
        console.log(formatMetrics('layout.analyze', metrics));

        expect(metrics.passesP95).toBe(true);
      });
    });

    describe('Motion Detection', () => {
      it('should detect motion in simple HTML within SLO', async () => {
        const motionDetector = getMotionDetectorService();

        const metrics = await runBenchmark(async () => {
          motionDetector.detect(SIMPLE_HTML, {
            includeInlineStyles: true,
            includeStyleSheets: true,
            minDuration: 0,
            maxPatterns: 100,
            verbose: false,
          });
        }, 'motion.detect');

        benchmarkResults['motion.detect (simple)'] = metrics;
        console.log(formatMetrics('motion.detect', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should detect motion in landing page HTML within SLO', async () => {
        const motionDetector = getMotionDetectorService();

        const metrics = await runBenchmark(async () => {
          motionDetector.detect(LANDING_PAGE_HTML, {
            includeInlineStyles: true,
            includeStyleSheets: true,
            minDuration: 0,
            maxPatterns: 100,
            verbose: false,
          });
        }, 'motion.detect');

        benchmarkResults['motion.detect (landing)'] = metrics;
        console.log(formatMetrics('motion.detect', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should detect motion in complex HTML within SLO', async () => {
        const motionDetector = getMotionDetectorService();

        const metrics = await runBenchmark(async () => {
          motionDetector.detect(COMPLEX_HTML, {
            includeInlineStyles: true,
            includeStyleSheets: true,
            minDuration: 0,
            maxPatterns: 100,
            verbose: false,
          });
        }, 'motion.detect');

        benchmarkResults['motion.detect (complex)'] = metrics;
        console.log(formatMetrics('motion.detect', metrics));

        expect(metrics.passesP95).toBe(true);
      });
    });

    describe('Quality Evaluation', () => {
      it('should evaluate simple HTML within SLO', async () => {
        const qualityEvaluator = getQualityEvaluatorService();

        const metrics = await runBenchmark(async () => {
          await qualityEvaluator.evaluate(SIMPLE_HTML, {
            includeRecommendations: true,
          });
        }, 'quality.evaluate');

        benchmarkResults['quality.evaluate (simple)'] = metrics;
        console.log(formatMetrics('quality.evaluate', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should evaluate landing page HTML within SLO', async () => {
        const qualityEvaluator = getQualityEvaluatorService();

        const metrics = await runBenchmark(async () => {
          await qualityEvaluator.evaluate(LANDING_PAGE_HTML, {
            includeRecommendations: true,
          });
        }, 'quality.evaluate');

        benchmarkResults['quality.evaluate (landing)'] = metrics;
        console.log(formatMetrics('quality.evaluate', metrics));

        expect(metrics.passesP95).toBe(true);
      });

      it('should evaluate complex HTML within SLO', async () => {
        const qualityEvaluator = getQualityEvaluatorService();

        const metrics = await runBenchmark(async () => {
          await qualityEvaluator.evaluate(COMPLEX_HTML, {
            includeRecommendations: true,
          });
        }, 'quality.evaluate');

        benchmarkResults['quality.evaluate (complex)'] = metrics;
        console.log(formatMetrics('quality.evaluate', metrics));

        expect(metrics.passesP95).toBe(true);
      });
    });
  });

  // =====================================================
  // 並列実行ベンチマーク
  // =====================================================

  describe('Parallel Execution Benchmarks', () => {
    it('should run layout/motion/quality in parallel within SLO', async () => {
      const layoutAnalyzer = getLayoutAnalyzerService();
      const motionDetector = getMotionDetectorService();
      const qualityEvaluator = getQualityEvaluatorService();

      const metrics = await runBenchmark(async () => {
        await Promise.all([
          layoutAnalyzer.analyze(LANDING_PAGE_HTML, {
            includeContent: true,
            includeStyles: true,
          }),
          Promise.resolve(
            motionDetector.detect(LANDING_PAGE_HTML, {
              includeInlineStyles: true,
              includeStyleSheets: true,
              minDuration: 0,
              maxPatterns: 100,
              verbose: false,
            })
          ),
          qualityEvaluator.evaluate(LANDING_PAGE_HTML, {
            includeRecommendations: true,
          }),
        ]);
      }, 'total_no_video');

      benchmarkResults['parallel (landing, no video)'] = metrics;
      console.log(formatMetrics('total_no_video', metrics));

      // 並列実行なので個別SLOより速いはず
      expect(metrics.passesP95).toBe(true);
    });

    it('should run parallel analysis on complex HTML within SLO', async () => {
      const layoutAnalyzer = getLayoutAnalyzerService();
      const motionDetector = getMotionDetectorService();
      const qualityEvaluator = getQualityEvaluatorService();

      const metrics = await runBenchmark(async () => {
        await Promise.all([
          layoutAnalyzer.analyze(COMPLEX_HTML, {
            includeContent: true,
            includeStyles: true,
          }),
          Promise.resolve(
            motionDetector.detect(COMPLEX_HTML, {
              includeInlineStyles: true,
              includeStyleSheets: true,
              minDuration: 0,
              maxPatterns: 100,
              verbose: false,
            })
          ),
          qualityEvaluator.evaluate(COMPLEX_HTML, {
            includeRecommendations: true,
          }),
        ]);
      }, 'total_no_video');

      benchmarkResults['parallel (complex, no video)'] = metrics;
      console.log(formatMetrics('total_no_video', metrics));

      expect(metrics.passesP95).toBe(true);
    });
  });

  // =====================================================
  // 統合ベンチマーク（モック利用）
  // =====================================================

  describe('Integration Benchmarks (with mocks)', () => {
    it('should complete full analysis with mocked fetch within SLO', async () => {
      // モックサービスファクトリを設定
      const mockService: IPageAnalyzeService = {
        fetchHtml: createMockFetchHtml(LANDING_PAGE_HTML, 50), // 50ms模擬遅延
      };
      setPageAnalyzeServiceFactory(() => mockService);
      setPageAnalyzePrismaClientFactory(() => createMockPrismaClient());

      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        summary: true,
        timeout: 60000,
        waitUntil: 'load',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        async: false, // 同期モードを強制（auto-async Vision回避）
        auto_timeout: false, // pre-flight probeオーバーヘッド回避
        layoutOptions: { useVision: false }, // Vision処理をスキップ
        narrativeOptions: { enabled: false }, // Narrative処理をスキップ
        motionOptions: {
          enable_frame_capture: false, // Video modeを無効化
          analyze_frames: false,
        },
      };

      const metrics = await runBenchmark(async () => {
        const result = await pageAnalyzeHandler(input);
        expect((result as PageAnalyzeOutput).success).toBe(true);
      }, 'total_no_video', { iterations: 5, warmup: 2 });

      benchmarkResults['integration (landing, mocked)'] = metrics;
      console.log(formatMetrics('total_no_video', metrics));

      expect(metrics.passesP95).toBe(true);
    });

    it('should complete complex analysis with mocked fetch within SLO', async () => {
      const mockService: IPageAnalyzeService = {
        fetchHtml: createMockFetchHtml(COMPLEX_HTML, 50),
      };
      setPageAnalyzeServiceFactory(() => mockService);
      setPageAnalyzePrismaClientFactory(() => createMockPrismaClient());

      const input: PageAnalyzeInput = {
        url: 'https://example.com/complex',
        features: { layout: true, motion: true, quality: true },
        summary: true,
        timeout: 60000,
        waitUntil: 'load',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        async: false, // 同期モードを強制（auto-async Vision回避）
        auto_timeout: false, // pre-flight probeオーバーヘッド回避
        layoutOptions: { useVision: false }, // Vision処理をスキップ
        narrativeOptions: { enabled: false }, // Narrative処理をスキップ
        motionOptions: {
          enable_frame_capture: false,
          analyze_frames: false,
        },
      };

      const metrics = await runBenchmark(async () => {
        const result = await pageAnalyzeHandler(input);
        expect((result as PageAnalyzeOutput).success).toBe(true);
      }, 'total_no_video', { iterations: 5, warmup: 2 });

      benchmarkResults['integration (complex, mocked)'] = metrics;
      console.log(formatMetrics('total_no_video', metrics));

      expect(metrics.passesP95).toBe(true);
    });

    it('should handle DB save operations within SLO', async () => {
      const mockPrisma = createMockPrismaClient();

      const metrics = await runBenchmark(async () => {
        // 模擬的なDB保存操作（トランザクション）
        await mockPrisma.$transaction(async (tx) => {
          await tx.webPage.create({
            data: {
              id: 'test-id',
              url: 'https://example.com',
              htmlContent: LANDING_PAGE_HTML,
              sourceType: 'user_provided',
              usageScope: 'inspiration_only',
            },
          });
          await tx.sectionPattern.createMany({
            data: Array.from({ length: 10 }, (_, i) => ({
              id: `section-${i}`,
              webPageId: 'test-id',
              type: 'feature',
              positionIndex: i,
              confidence: 0.9,
            })),
          });
          await tx.motionPattern.createMany({
            data: Array.from({ length: 5 }, (_, i) => ({
              id: `motion-${i}`,
              webPageId: 'test-id',
              name: `animation-${i}`,
              category: 'entrance',
              triggerType: 'load',
              animation: { duration: 300 },
              properties: ['opacity'],
            })),
          });
          await tx.qualityEvaluation.create({
            data: {
              id: 'quality-id',
              targetType: 'web_page',
              targetId: 'test-id',
              overallScore: 85,
              grade: 'B',
              originalityScore: 80,
              craftsmanshipScore: 85,
              contextualityScore: 90,
            },
          });
        });
      }, 'db.save');

      benchmarkResults['db.save (mock)'] = metrics;
      console.log(formatMetrics('db.save', metrics));

      expect(metrics.passesP95).toBe(true);
    });
  });

  // =====================================================
  // 境界条件テスト
  // =====================================================

  describe('Edge Case Benchmarks', () => {
    it('should handle empty HTML gracefully', async () => {
      const layoutAnalyzer = getLayoutAnalyzerService();

      const metrics = await runBenchmark(async () => {
        await layoutAnalyzer.analyze('', {
          includeContent: true,
          includeStyles: true,
        });
      }, 'layout.analyze');

      benchmarkResults['layout.analyze (empty)'] = metrics;
      console.log(formatMetrics('layout.analyze', metrics));

      // 空HTMLは非常に高速であるべき
      expect(metrics.p95).toBeLessThan(100);
    });

    it('should handle minimal HTML', async () => {
      const minimalHtml = '<html><body></body></html>';
      const layoutAnalyzer = getLayoutAnalyzerService();

      const metrics = await runBenchmark(async () => {
        await layoutAnalyzer.analyze(minimalHtml, {
          includeContent: true,
          includeStyles: true,
        });
      }, 'layout.analyze');

      benchmarkResults['layout.analyze (minimal)'] = metrics;
      console.log(formatMetrics('layout.analyze', metrics));

      expect(metrics.p95).toBeLessThan(100);
    });
  });
});

// =====================================================
// エクスポート（レポート生成用）
// 注: PAGE_ANALYZE_SLOは上部でexport constとして既にエクスポート済み
// =====================================================
