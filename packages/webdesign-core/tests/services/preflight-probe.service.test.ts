// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pre-flight Probe Service Tests
 *
 * TDD: Red Phase - Write failing tests first
 *
 * @module @reftrix/webdesign-core/services/preflight-probe
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PreflightProbeService,
  type ProbeResult,
  type ComplexityAnalysis,
  analyzeComplexity,
  calculateMultiplier,
  BASE_TIMEOUT,
  MAX_TIMEOUT,
  DEFAULT_TIMEOUT,
  PROBE_TIMEOUT,
} from '../../src/services/preflight-probe.service';

// robots.txt チェックをモック（Probeテストの対象外）
// fetchモックだけではrobots.txt用のfetchまで制御できないため、
// isUrlAllowedByRobotsTxtをモックして常にallowedを返す
vi.mock('@reftrix/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reftrix/core')>();
  return {
    ...actual,
    isUrlAllowedByRobotsTxt: vi.fn().mockResolvedValue({
      allowed: true,
      domain: 'https://example.com',
      cached: false,
      reason: 'allowed',
    }),
  };
});

// =============================================================================
// Test Constants
// =============================================================================

const SIMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="/app.js"></script>
  <script src="/vendor.js"></script>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>Simple Page</h1>
  <img src="/image.png" />
  <img src="/logo.png" />
</body>
</html>
`;

const MODERATE_HTML = `
<!DOCTYPE html>
<html>
<head>
  ${Array(15).fill('<script src="/bundle.js"></script>').join('\n  ')}
  ${Array(10).fill('<link rel="stylesheet" href="/style.css">').join('\n  ')}
</head>
<body>
  ${Array(20).fill('<img src="/image.png" />').join('\n  ')}
  <div id="app"></div>
</body>
</html>
`;

const COMPLEX_HTML = `
<!DOCTYPE html>
<html>
<head>
  ${Array(40).fill('<script src="/bundle.js"></script>').join('\n  ')}
  ${Array(20).fill('<link rel="stylesheet" href="/style.css">').join('\n  ')}
  <script src="https://cdn.example.com/react.js"></script>
  <script src="https://cdn.example.com/react-dom.js"></script>
</head>
<body>
  <div id="root"></div>
  <canvas id="webgl-canvas"></canvas>
  <script>
    // React/Vue/Angular markers
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
  </script>
</body>
</html>
`;

const SUPER_COMPLEX_HTML = `
<!DOCTYPE html>
<html>
<head>
  ${Array(50).fill('<script src="/bundle.js"></script>').join('\n  ')}
  <script src="https://cdn.example.com/three.min.js"></script>
  <script src="https://cdn.example.com/gsap.min.js"></script>
</head>
<body>
  <canvas id="webgl-canvas"></canvas>
  <script>
    // Three.js detection
    window.THREE = { REVISION: '150' };
    // GSAP detection
    window.gsap = { version: '3.12' };
  </script>
</body>
</html>
`;

// =============================================================================
// Unit Tests: analyzeComplexity
// =============================================================================

describe('analyzeComplexity', () => {
  it('should count script tags correctly', () => {
    const result = analyzeComplexity(SIMPLE_HTML);
    expect(result.scriptCount).toBe(2);
  });

  it('should count external resources correctly', () => {
    const result = analyzeComplexity(SIMPLE_HTML);
    // 2 scripts + 1 link + 2 images = 5
    expect(result.externalResourceCount).toBe(5);
  });

  it('should detect WebGL (canvas element)', () => {
    const htmlWithCanvas = '<html><body><canvas id="webgl"></canvas></body></html>';
    const result = analyzeComplexity(htmlWithCanvas);
    expect(result.hasWebGL).toBe(true);
  });

  it('should detect Three.js', () => {
    const htmlWithThree = `
      <html><head>
        <script src="https://cdn.example.com/three.min.js"></script>
      </head></html>
    `;
    const result = analyzeComplexity(htmlWithThree);
    expect(result.hasWebGL).toBe(true);
  });

  it('should detect Babylon.js', () => {
    const htmlWithBabylon = `
      <html><head>
        <script src="https://cdn.example.com/babylon.js"></script>
      </head></html>
    `;
    const result = analyzeComplexity(htmlWithBabylon);
    expect(result.hasWebGL).toBe(true);
  });

  it('should detect SPA frameworks (React)', () => {
    const htmlWithReact = `
      <html>
        <body>
          <div id="root"></div>
          <script>window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};</script>
        </body>
      </html>
    `;
    const result = analyzeComplexity(htmlWithReact);
    expect(result.hasSPA).toBe(true);
  });

  it('should detect SPA frameworks (Vue)', () => {
    const htmlWithVue = `
      <html>
        <body>
          <div id="app" data-v-app></div>
        </body>
      </html>
    `;
    const result = analyzeComplexity(htmlWithVue);
    expect(result.hasSPA).toBe(true);
  });

  it('should detect SPA frameworks (Angular)', () => {
    const htmlWithAngular = `
      <html>
        <body>
          <app-root ng-version="17.0.0"></app-root>
        </body>
      </html>
    `;
    const result = analyzeComplexity(htmlWithAngular);
    expect(result.hasSPA).toBe(true);
  });

  it('should detect heavy frameworks (GSAP)', () => {
    const htmlWithGSAP = `
      <html><head>
        <script src="https://cdn.example.com/gsap.min.js"></script>
      </head></html>
    `;
    const result = analyzeComplexity(htmlWithGSAP);
    expect(result.hasHeavyFramework).toBe(true);
  });

  it('should detect heavy frameworks (anime.js)', () => {
    const htmlWithAnime = `
      <html><head>
        <script src="https://cdn.example.com/anime.min.js"></script>
      </head></html>
    `;
    const result = analyzeComplexity(htmlWithAnime);
    expect(result.hasHeavyFramework).toBe(true);
  });

  it('should handle moderate complexity HTML', () => {
    const result = analyzeComplexity(MODERATE_HTML);
    expect(result.scriptCount).toBe(15);
    expect(result.externalResourceCount).toBeGreaterThan(30);
  });

  it('should handle complex HTML with multiple indicators', () => {
    const result = analyzeComplexity(COMPLEX_HTML);
    expect(result.scriptCount).toBeGreaterThan(30);
    expect(result.hasWebGL).toBe(true);
    expect(result.hasSPA).toBe(true);
  });

  it('should handle empty HTML gracefully', () => {
    const result = analyzeComplexity('');
    expect(result.scriptCount).toBe(0);
    expect(result.externalResourceCount).toBe(0);
    expect(result.hasWebGL).toBe(false);
    expect(result.hasSPA).toBe(false);
    expect(result.hasHeavyFramework).toBe(false);
  });
});

// =============================================================================
// Unit Tests: calculateMultiplier
// =============================================================================

describe('calculateMultiplier', () => {
  const baseMetrics: ComplexityAnalysis = {
    scriptCount: 0,
    externalResourceCount: 0,
    hasWebGL: false,
    hasSPA: false,
    hasHeavyFramework: false,
  };

  it('should return base multiplier (1.0) for simple metrics', () => {
    const multiplier = calculateMultiplier(baseMetrics, 100);
    expect(multiplier).toBe(1.0);
  });

  it('should increase multiplier for slow response time (> 2000ms)', () => {
    const multiplier = calculateMultiplier(baseMetrics, 2500);
    expect(multiplier).toBe(2.0); // 1.0 + 1.0
  });

  it('should increase multiplier for moderate response time (500-2000ms)', () => {
    const multiplier = calculateMultiplier(baseMetrics, 1000);
    expect(multiplier).toBe(1.5); // 1.0 + 0.5
  });

  it('should increase multiplier for many scripts (> 30)', () => {
    const metrics = { ...baseMetrics, scriptCount: 40 };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(2.5); // 1.0 + 1.5
  });

  it('should increase multiplier for moderate scripts (15-30)', () => {
    const metrics = { ...baseMetrics, scriptCount: 20 };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(1.75); // 1.0 + 0.75
  });

  it('should increase multiplier for few scripts (5-15)', () => {
    const metrics = { ...baseMetrics, scriptCount: 10 };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(1.25); // 1.0 + 0.25
  });

  it('should increase multiplier for many external resources (> 50)', () => {
    const metrics = { ...baseMetrics, externalResourceCount: 60 };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(2.0); // 1.0 + 1.0
  });

  it('should increase multiplier for moderate external resources (30-50)', () => {
    const metrics = { ...baseMetrics, externalResourceCount: 40 };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(1.5); // 1.0 + 0.5
  });

  it('should increase multiplier for WebGL', () => {
    const metrics = { ...baseMetrics, hasWebGL: true };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(3.0); // 1.0 + 2.0
  });

  it('should increase multiplier for heavy frameworks', () => {
    const metrics = { ...baseMetrics, hasHeavyFramework: true };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(2.5); // 1.0 + 1.5
  });

  it('should increase multiplier for SPA', () => {
    const metrics = { ...baseMetrics, hasSPA: true };
    const multiplier = calculateMultiplier(metrics, 100);
    expect(multiplier).toBe(1.5); // 1.0 + 0.5
  });

  it('should accumulate all multipliers correctly', () => {
    const metrics: ComplexityAnalysis = {
      scriptCount: 40,
      externalResourceCount: 60,
      hasWebGL: true,
      hasSPA: true,
      hasHeavyFramework: true,
    };
    const multiplier = calculateMultiplier(metrics, 3000);
    // 1.0 (base) + 1.0 (slow) + 1.5 (scripts) + 1.0 (resources) + 2.0 (webgl) + 1.5 (heavy) + 0.5 (spa)
    expect(multiplier).toBe(8.5);
  });
});

// =============================================================================
// Unit Tests: PreflightProbeService
// =============================================================================

describe('PreflightProbeService', () => {
  let service: PreflightProbeService;

  beforeEach(() => {
    service = new PreflightProbeService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('probe()', () => {
    it('should return ProbeResult with all required fields', async () => {
      // Mock fetch for this test
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true }) // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(SIMPLE_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result).toHaveProperty('responseTimeMs');
      expect(result).toHaveProperty('htmlSizeBytes');
      expect(result).toHaveProperty('scriptCount');
      expect(result).toHaveProperty('externalResourceCount');
      expect(result).toHaveProperty('hasWebGL');
      expect(result).toHaveProperty('hasSPA');
      expect(result).toHaveProperty('hasHeavyFramework');
      expect(result).toHaveProperty('calculatedTimeoutMs');
      expect(result).toHaveProperty('complexityScore');
      expect(result).toHaveProperty('probedAt');
      expect(result).toHaveProperty('probeVersion');
    });

    it('should calculate simple page timeout (~30s)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(SIMPLE_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      // Simple page should get base timeout (30s) or close to it
      expect(result.calculatedTimeoutMs).toBeGreaterThanOrEqual(BASE_TIMEOUT);
      expect(result.calculatedTimeoutMs).toBeLessThanOrEqual(60000);
    });

    it('should calculate moderate page timeout (~60s)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(MODERATE_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.calculatedTimeoutMs).toBeGreaterThanOrEqual(45000);
      expect(result.calculatedTimeoutMs).toBeLessThanOrEqual(90000);
    });

    it('should calculate complex page timeout (~120s)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(COMPLEX_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.calculatedTimeoutMs).toBeGreaterThanOrEqual(90000);
      expect(result.calculatedTimeoutMs).toBeLessThanOrEqual(180000);
    });

    it('should calculate super complex page timeout (~180s)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(SUPER_COMPLEX_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.calculatedTimeoutMs).toBeGreaterThanOrEqual(120000);
      expect(result.calculatedTimeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT);
    });

    it('should respect MAX_TIMEOUT ceiling', async () => {
      // Simulate extremely complex page
      const extremeHtml = `
        ${Array(100).fill('<script src="/bundle.js"></script>').join('\n')}
        ${Array(100).fill('<img src="/image.png" />').join('\n')}
        <canvas></canvas>
        <script>window.THREE = {}; window.gsap = {};</script>
      `;

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(extremeHtml),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.calculatedTimeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT);
    });

    it('should return default timeout on probe timeout', async () => {
      // AbortControllerのabortイベントをシミュレート
      const mockFetch = vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
        return new Promise((_, reject) => {
          // AbortSignalがある場合、abort時にrejectする
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
          // タイムアウトを待つ（fake timersで制御）
        });
      });

      vi.stubGlobal('fetch', mockFetch);

      const probePromise = service.probe('https://slow-site.com');

      // fake timerでPROBE_TIMEOUTを超えさせる
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT + 1000);

      const result = await probePromise;

      expect(result.calculatedTimeoutMs).toBe(DEFAULT_TIMEOUT);
    });

    it('should return default timeout on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://unreachable.com');

      expect(result.calculatedTimeoutMs).toBe(DEFAULT_TIMEOUT);
    });
  });

  describe('calculateDynamicTimeout()', () => {
    it('should return calculated timeout for valid URL', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(SIMPLE_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const timeout = await service.calculateDynamicTimeout('https://example.com');

      expect(timeout).toBeGreaterThanOrEqual(BASE_TIMEOUT);
      expect(typeof timeout).toBe('number');
    });

    it('should return default timeout on error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const timeout = await service.calculateDynamicTimeout('https://unreachable.com');

      expect(timeout).toBe(DEFAULT_TIMEOUT);
    });
  });

  describe('SSRF Protection', () => {
    it('should reject private IP addresses', async () => {
      await expect(service.probe('http://192.168.1.1/page')).rejects.toThrow();
      await expect(service.probe('http://10.0.0.1/page')).rejects.toThrow();
      await expect(service.probe('http://172.16.0.1/page')).rejects.toThrow();
    });

    it('should reject localhost', async () => {
      await expect(service.probe('http://localhost/page')).rejects.toThrow();
      await expect(service.probe('http://127.0.0.1/page')).rejects.toThrow();
    });

    it('should reject metadata services', async () => {
      await expect(service.probe('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    });

    it('should accept valid external URLs', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('<html></html>'),
        });

      vi.stubGlobal('fetch', mockFetch);

      // Should not throw
      await expect(service.probe('https://example.com')).resolves.toBeDefined();
    });
  });

  describe('complexityScore calculation', () => {
    it('should calculate complexity score as sum of weighted factors', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(COMPLEX_HTML),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.complexityScore).toBeGreaterThan(0);
      expect(result.complexityScore).toBeLessThanOrEqual(100);
    });
  });

  describe('probedAt and probeVersion', () => {
    it('should include valid ISO timestamp', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('<html></html>'),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include probeVersion', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('<html></html>'),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await service.probe('https://example.com');

      expect(result.probeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
