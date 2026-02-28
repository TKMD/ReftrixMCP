// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Benchmark Utilities
 *
 * ベンチマーク実行用のヘルパー関数とユーティリティ
 */

import { vi } from 'vitest';

// ============================================================================
// SLO Definitions
// ============================================================================

/**
 * Service Level Objectives (SLO) 定義
 *
 * P95: 95%のリクエストがこの時間内に完了すべき
 * P99: 99%のリクエストがこの時間内に完了すべき（異常検知閾値）
 */
export const SLO = {
  'svg.search': { p95: 500, p99: 1000 },
  'svg.transform': { p95: 200, p99: 500 },
  'svg.search_and_get': { p95: 800, p99: 1500 },
  'motion.detect': { p95: 300, p99: 600 },
  'layout.ingest': { p95: 5000, p99: 10000 },
} as const;

export type ToolName = keyof typeof SLO;

// ============================================================================
// Test Data Fixtures
// ============================================================================

/**
 * 小規模SVGテストデータ（約1KB）
 */
export const TEST_SVG_SMALL = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="10" fill="#3B82F6" />
  <path d="M8 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none" />
</svg>
`.trim();

/**
 * 中規模SVGテストデータ（約5KB）
 */
export const TEST_SVG_MEDIUM = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3B82F6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#8B5CF6;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="80" height="80" rx="8" fill="url(#grad1)" />
  <circle cx="30" cy="40" r="8" fill="#fff" opacity="0.9" />
  <circle cx="70" cy="40" r="8" fill="#fff" opacity="0.9" />
  <path d="M30 65 Q50 80 70 65" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" />
  <path d="M25 25 L35 35 M75 25 L65 35" stroke="#fff" stroke-width="2" stroke-linecap="round" />
</svg>
`.trim();

/**
 * 複雑なSVGテストデータ（約15KB相当の構造）
 */
export const TEST_SVG_COMPLEX = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1E40AF;stop-opacity:1" />
      <stop offset="50%" style="stop-color:#3B82F6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#60A5FA;stop-opacity:1" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="4" stdDeviation="4" flood-opacity="0.3"/>
    </filter>
    <clipPath id="circleClip">
      <circle cx="100" cy="100" r="80"/>
    </clipPath>
  </defs>
  <rect width="200" height="200" fill="url(#bgGrad)"/>
  <g clip-path="url(#circleClip)">
    <rect x="20" y="20" width="160" height="160" fill="#fff" opacity="0.1"/>
    ${Array.from(
      { length: 20 },
      (_, i) =>
        `<circle cx="${50 + (i % 5) * 25}" cy="${50 + Math.floor(i / 5) * 25}" r="${5 + (i % 3) * 2}" fill="#fff" opacity="${0.3 + (i % 5) * 0.1}"/>`
    ).join('\n    ')}
  </g>
  <g filter="url(#shadow)">
    <path d="M60 100 Q100 60 140 100 Q100 140 60 100" fill="#fff" opacity="0.8"/>
    <circle cx="85" cy="95" r="5" fill="#1E40AF"/>
    <circle cx="115" cy="95" r="5" fill="#1E40AF"/>
    <path d="M85 115 Q100 125 115 115" stroke="#1E40AF" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
  <text x="100" y="180" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff">Complex SVG</text>
</svg>
`.trim();

/**
 * アニメーション付きHTMLテストデータ
 */
export const TEST_HTML_WITH_ANIMATIONS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @keyframes slideIn {
      from { transform: translateX(-100%); }
      to { transform: translateX(0); }
    }
    .hero { animation: fadeIn 0.6s ease-out; }
    .cta-button {
      transition: all 0.3s ease;
      animation: pulse 2s infinite;
    }
    .cta-button:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .sidebar { animation: slideIn 0.4s ease-out; }
    .card {
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    }
  </style>
</head>
<body>
  <header class="hero">Hero Section</header>
  <nav class="sidebar">Navigation</nav>
  <main>
    <button class="cta-button">Call to Action</button>
    <div class="card">Card 1</div>
    <div class="card">Card 2</div>
  </main>
</body>
</html>
`.trim();

/**
 * 複雑なアニメーション付きHTML（より多くのパターン）
 */
export const TEST_HTML_COMPLEX_ANIMATIONS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Entrance animations */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeInLeft {
      from { opacity: 0; transform: translateX(-30px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes fadeInRight {
      from { opacity: 0; transform: translateX(30px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }

    /* Continuous animations */
    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    @keyframes rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    /* Hover transitions */
    .btn-primary {
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    }

    .nav-link {
      transition: color 0.2s ease, transform 0.2s ease;
    }
    .nav-link:hover {
      color: #3B82F6;
      transform: translateX(4px);
    }

    .card-interactive {
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .card-interactive:hover {
      transform: translateY(-8px) scale(1.02);
      box-shadow: 0 20px 40px rgba(0,0,0,0.1);
    }

    /* Animation classes */
    .animate-fade-up { animation: fadeInUp 0.6s ease-out forwards; }
    .animate-fade-left { animation: fadeInLeft 0.5s ease-out forwards; }
    .animate-fade-right { animation: fadeInRight 0.5s ease-out forwards; }
    .animate-scale { animation: scaleIn 0.4s ease-out forwards; }
    .animate-float { animation: float 3s ease-in-out infinite; }
    .animate-rotate { animation: rotate 8s linear infinite; }
    .animate-shimmer {
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
      background-size: 200% 100%;
      animation: shimmer 2s infinite;
    }

    /* Staggered animations */
    .stagger-1 { animation-delay: 0.1s; }
    .stagger-2 { animation-delay: 0.2s; }
    .stagger-3 { animation-delay: 0.3s; }
    .stagger-4 { animation-delay: 0.4s; }

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <header class="animate-fade-up">
    <nav>
      <a class="nav-link" href="#">Home</a>
      <a class="nav-link" href="#">About</a>
      <a class="nav-link" href="#">Services</a>
    </nav>
  </header>
  <main>
    <section class="hero animate-scale">
      <h1>Welcome</h1>
      <button class="btn-primary">Get Started</button>
    </section>
    <section class="features">
      <div class="card-interactive animate-fade-left stagger-1">Feature 1</div>
      <div class="card-interactive animate-fade-up stagger-2">Feature 2</div>
      <div class="card-interactive animate-fade-right stagger-3">Feature 3</div>
    </section>
    <div class="animate-float">Floating Element</div>
    <div class="animate-rotate">Rotating Element</div>
    <div class="animate-shimmer">Loading...</div>
  </main>
</body>
</html>
`.trim();

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * モック検索結果を生成
 */
export function generateMockSearchResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `mock-svg-${i + 1}`,
    name: `Test SVG ${i + 1}`,
    similarity: 0.95 - i * 0.02,
    license_spdx: 'MIT',
    style: 'flat' as const,
    purpose: 'icon' as const,
  }));
}

/**
 * SVG検索リポジトリのモックファクトリ
 */
export function createMockSvgSearchRepository(resultCount = 10) {
  return {
    search: vi.fn().mockResolvedValue({
      results: generateMockSearchResults(resultCount),
      total: resultCount * 10,
      searchTimeMs: 5,
    }),
    getById: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: `SVG ${id}`,
        svg_content: TEST_SVG_MEDIUM,
        license_spdx: 'MIT',
        viewbox: '0 0 100 100',
        created_at: new Date().toISOString(),
      })
    ),
  };
}

/**
 * Transform Serviceのモックファクトリ
 */
export function createMockTransformService() {
  return {
    optimize: vi.fn().mockImplementation((svg: string) =>
      Promise.resolve({
        svg: svg.replace(/\s+/g, ' ').trim(),
        stats: { originalSize: svg.length, optimizedSize: svg.length * 0.8 },
      })
    ),
    recolor: vi.fn().mockImplementation((svg: string) =>
      Promise.resolve({
        svg: svg.replace(/#[0-9A-Fa-f]{6}/g, '#FF0000'),
        colorsReplaced: 3,
      })
    ),
    normalize: vi.fn().mockImplementation((svg: string) =>
      Promise.resolve({
        svg,
        dimensions: { width: 24, height: 24 },
      })
    ),
    toReact: vi.fn().mockImplementation((svg: string, options?: { componentName?: string }) =>
      Promise.resolve({
        code: `export const ${options?.componentName || 'SvgIcon'} = () => (${svg});`,
        componentName: options?.componentName || 'SvgIcon',
      })
    ),
  };
}

/**
 * Layout Ingest Serviceのモックファクトリ
 */
export function createMockLayoutIngestService() {
  return {
    ingest: vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        url,
        title: 'Test Page',
        html: '<html><body>Test</body></html>',
        screenshot: null,
        sections_analyzed: 5,
        ingestedAt: new Date().toISOString(),
      })
    ),
    validateUrl: vi.fn().mockImplementation((url: string) => {
      // SSRF検証シミュレーション
      const blocked = ['127.0.0.1', 'localhost', '192.168.', '10.', '169.254.'];
      return !blocked.some((b) => url.includes(b));
    }),
  };
}

/**
 * Motion Detect Serviceのモックファクトリ
 */
export function createMockMotionDetectService() {
  return {
    detect: vi.fn().mockImplementation((html: string) =>
      Promise.resolve({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'fadeIn',
            category: 'entrance',
            trigger: 'load',
            animation: {
              duration: 600,
              easing: 'ease-out',
              iterations: 1,
            },
            properties: ['opacity', 'transform'],
            performance: { level: 'good', usesTransform: true, usesOpacity: true },
            accessibility: { respectsReducedMotion: true },
          },
          {
            id: 'pattern-2',
            type: 'css_transition',
            name: 'hover-effect',
            category: 'hover_effect',
            trigger: 'hover',
            animation: {
              duration: 300,
              easing: 'ease',
              iterations: 1,
            },
            properties: ['transform', 'box-shadow'],
            performance: { level: 'good', usesTransform: true, usesOpacity: false },
            accessibility: { respectsReducedMotion: false },
          },
        ],
        warnings: [],
        summary: {
          total: 2,
          byType: { css_animation: 1, css_transition: 1 },
          byCategory: { entrance: 1, hover_effect: 1 },
        },
      })
    ),
  };
}

// ============================================================================
// Benchmark Helpers
// ============================================================================

/**
 * ベンチマーク結果をSLOと比較
 */
export function validateAgainstSlo(
  toolName: ToolName,
  measurements: number[]
): {
  p95: number;
  p99: number;
  passesP95: boolean;
  passesP99: boolean;
} {
  const sorted = [...measurements].sort((a, b) => a - b);
  const p95Index = Math.floor(sorted.length * 0.95);
  const p99Index = Math.floor(sorted.length * 0.99);

  const p95 = sorted[p95Index] || sorted[sorted.length - 1];
  const p99 = sorted[p99Index] || sorted[sorted.length - 1];

  const slo = SLO[toolName];

  return {
    p95,
    p99,
    passesP95: p95 <= slo.p95,
    passesP99: p99 <= slo.p99,
  };
}

/**
 * 統計情報を計算
 */
export function calculateStats(measurements: number[]): {
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
} {
  const sorted = [...measurements].sort((a, b) => a - b);
  const n = sorted.length;

  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;

  const percentile = (p: number) => {
    const index = Math.floor(n * (p / 100));
    return sorted[Math.min(index, n - 1)];
  };

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: percentile(50),
    stdDev: Math.sqrt(variance),
    p50: percentile(50),
    p75: percentile(75),
    p90: percentile(90),
    p95: percentile(95),
    p99: percentile(99),
  };
}

/**
 * ベンチマーク結果をフォーマット
 */
export function formatBenchmarkResult(
  toolName: string,
  scenario: string,
  stats: ReturnType<typeof calculateStats>
): string {
  return `
${toolName} - ${scenario}
  Min: ${stats.min.toFixed(2)}ms
  Max: ${stats.max.toFixed(2)}ms
  Mean: ${stats.mean.toFixed(2)}ms
  Median: ${stats.median.toFixed(2)}ms
  StdDev: ${stats.stdDev.toFixed(2)}ms
  P95: ${stats.p95.toFixed(2)}ms
  P99: ${stats.p99.toFixed(2)}ms
`.trim();
}

/**
 * メモリ使用量を測定（Node.js環境）
 */
export function measureMemoryUsage(): {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
} {
  const memUsage = process.memoryUsage();
  return {
    heapUsed: memUsage.heapUsed / 1024 / 1024, // MB
    heapTotal: memUsage.heapTotal / 1024 / 1024,
    external: memUsage.external / 1024 / 1024,
    rss: memUsage.rss / 1024 / 1024,
  };
}

/**
 * 遅延を追加（ネットワーク遅延シミュレーション用）
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 時間計測ラッパー
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}
