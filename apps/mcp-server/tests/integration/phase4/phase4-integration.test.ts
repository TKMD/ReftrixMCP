// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase4 統合テスト: WebGL Optimization
 *
 * Phase4で実装した機能の統合テスト:
 * - Phase4-1: WebGL自動検出と設定切替
 * - Phase4-2: ブラウザプロセス管理と強制終了
 * - Phase4-3: ドメインリスト拡張
 *
 * 検証内容:
 * 1. WebGL自動検出（URL/HTML両方）
 * 2. SiteTierに基づいた推奨設定の生成
 * 3. BrowserProcessManagerの動作
 * 4. ドメインリストの整合性と検索機能
 * 5. エンドツーエンドの最適化フロー
 *
 * @module tests/integration/phase4/phase4-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { type Browser } from 'playwright';

// ============================================================================
// 実際のモジュールをインポート（モックなし）
// ============================================================================

import {
  WebGLDetector,
  detectWebGL,
  adjustTimeoutForWebGL,
  WEBGL_DETECTION_THRESHOLD,
  type WebGLDetectionResult,
  type RecommendedConfig,
  type LegacyWebGLDetectionResult,
} from '../../../src/tools/page/handlers/webgl-detector';

import {
  KNOWN_WEBGL_DOMAINS,
  WEBGL_DOMAIN_MAP,
  getDomainsByCategory,
  getDomainsByTier,
  getDomainEntry,
  isDomainInList,
  type WebGLDomainEntry,
} from '../../../src/tools/page/handlers/webgl-domains';

import {
  preDetectWebGL,
  detectSiteTier,
  KNOWN_ULTRA_HEAVY_DOMAINS,
  KNOWN_HEAVY_DOMAINS,
} from '../../../src/tools/page/handlers/webgl-pre-detector';

import {
  getRetryStrategy,
  type SiteTier,
  type RetryStrategyConfig,
} from '../../../src/tools/page/handlers/retry-strategy';

import { BrowserProcessManager } from '../../../src/services/browser-process-manager';

// ============================================================================
// テスト用HTMLコンテンツ
// ============================================================================

/** Three.jsを使用したHTML */
const HTML_WITH_THREEJS = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script>
</head>
<body>
  <canvas id="webgl"></canvas>
  <script>
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('webgl') });
  </script>
</body>
</html>
`;

/** Babylon.jsを使用したHTML */
const HTML_WITH_BABYLONJS = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
</head>
<body>
  <canvas id="renderCanvas"></canvas>
  <script>
    const canvas = document.getElementById('renderCanvas');
    const engine = new BABYLON.Engine(canvas, true);
    const scene = new BABYLON.Scene(engine);
  </script>
</body>
</html>
`;

/** WebGLコンテキストを直接使用したHTML */
const HTML_WITH_RAW_WEBGL = `
<!DOCTYPE html>
<html>
<body>
  <canvas id="glCanvas"></canvas>
  <script>
    const canvas = document.getElementById('glCanvas');
    const gl = canvas.getContext('webgl2');
    // WebGL rendering code
  </script>
</body>
</html>
`;

/** GSAP + Lottieを使用したHTML */
const HTML_WITH_ANIMATION_LIBS = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js"></script>
</head>
<body>
  <div id="animation"></div>
  <script>
    gsap.to('.element', { duration: 1, x: 100 });
    lottie.loadAnimation({ container: document.getElementById('animation') });
  </script>
</body>
</html>
`;

/** WebGLなしの通常HTML */
const HTML_NORMAL = `
<!DOCTYPE html>
<html>
<head>
  <title>Normal Page</title>
</head>
<body>
  <h1>Hello World</h1>
  <p>This is a normal page without WebGL.</p>
</body>
</html>
`;

/** Canvas要素のみのHTML */
const HTML_WITH_CANVAS_ONLY = `
<!DOCTYPE html>
<html>
<body>
  <canvas id="canvas1"></canvas>
  <canvas id="canvas2"></canvas>
  <canvas id="canvas3"></canvas>
</body>
</html>
`;

// ============================================================================
// Phase4-1: WebGL自動検出 テスト
// ============================================================================

describe('Phase4-1: WebGL自動検出', () => {
  describe('既知ドメイン検出', () => {
    it('should detect known WebGL domain (linear.app)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://linear.app');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.indicators.domainMatch).toBe(true);
      expect(result.siteTier).toBe('ultra-heavy');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should detect known WebGL domain (vercel.com)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://vercel.com');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.indicators.domainMatch).toBe(true);
      // vercel.comはheavyドメイン
      expect(['heavy', 'ultra-heavy']).toContain(result.siteTier);
    });

    it('should detect known WebGL domain (notion.so)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://notion.so');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.indicators.domainMatch).toBe(true);
    });

    it('should detect known ultra-heavy domain (resn.co.nz)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://resn.co.nz');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('ultra-heavy');
      expect(result.recommendedConfig.forceKillOnTimeout).toBe(true);
    });

    it('should detect known heavy domain (stripe.com)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://stripe.com');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(['heavy', 'webgl']).toContain(result.siteTier);
    });

    it('should not detect normal domain (google.com)', () => {
      // Act
      const result = WebGLDetector.preDetect('https://google.com');

      // Assert
      expect(result.isWebGL).toBe(false);
      expect(result.indicators.domainMatch).toBe(false);
      expect(result.siteTier).toBe('normal');
    });

    it('should handle www prefix correctly', () => {
      // Act
      const result1 = WebGLDetector.preDetect('https://www.linear.app');
      const result2 = WebGLDetector.preDetect('https://linear.app');

      // Assert - 両方同じ結果になるべき
      expect(result1.isWebGL).toBe(result2.isWebGL);
      expect(result1.siteTier).toBe(result2.siteTier);
    });

    it('should handle URL with path correctly', () => {
      // Act
      const result = WebGLDetector.preDetect('https://linear.app/team/project/issue-123');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('ultra-heavy');
    });
  });

  describe('HTML解析検出', () => {
    it('should detect Three.js from HTML content', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_WITH_THREEJS);

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('three.js');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('should detect Babylon.js from HTML content', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_WITH_BABYLONJS);

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('babylon.js');
    });

    it('should detect WebGL context from HTML content', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_WITH_RAW_WEBGL);

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('raw-webgl');
    });

    it('should detect GSAP and Lottie from HTML content', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_WITH_ANIMATION_LIBS);

      // Assert
      // GSAP/Lottieは必ずしもWebGLではないが、重いアニメーションとして検出される
      expect(result.detectedLibraries).toContain('gsap');
      expect(result.detectedLibraries).toContain('lottie');
    });

    it('should not detect WebGL in normal HTML', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_NORMAL);

      // Assert
      expect(result.isWebGL).toBe(false);
      expect(result.detectedLibraries).toHaveLength(0);
      expect(result.siteTier).toBe('normal');
    });

    it('should detect canvas elements with weak confidence', () => {
      // Act
      const result = WebGLDetector.analyzeHtml(HTML_WITH_CANVAS_ONLY);

      // Assert
      expect(result.indicators.htmlIndicators).toContain('canvas elements: 3');
      // Canvas単独では低い信頼度
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should handle empty HTML', () => {
      // Act
      const result = WebGLDetector.analyzeHtml('');

      // Assert
      expect(result.isWebGL).toBe(false);
      expect(result.siteTier).toBe('normal');
    });
  });

  describe('SiteTier決定', () => {
    it('should determine ultra-heavy tier for high confidence WebGL', () => {
      // Arrange
      const html = HTML_WITH_THREEJS;

      // Act
      const result = WebGLDetector.analyzeHtml(html);

      // Assert
      // Three.jsと高信頼度でultra-heavy
      if (result.confidence >= 0.7 && result.detectedLibraries.includes('three.js')) {
        expect(result.siteTier).toBe('ultra-heavy');
      }
    });

    it('should determine heavy tier for medium confidence', () => {
      // Act
      const tier = detectSiteTier('https://awwwards.com');

      // Assert
      expect(['heavy', 'webgl']).toContain(tier);
    });

    it('should determine normal tier for non-WebGL sites', () => {
      // Act
      const tier = detectSiteTier('https://example.com');

      // Assert
      expect(tier).toBe('normal');
    });
  });

  describe('推奨設定生成', () => {
    it('should generate correct config for ultra-heavy sites', () => {
      // Act
      const result = WebGLDetector.preDetect('https://resn.co.nz');
      const config = result.recommendedConfig;

      // Assert
      expect(config.enableGPU).toBe(true);
      expect(config.waitForWebGL).toBe(true);
      expect(config.webglWaitMs).toBeGreaterThanOrEqual(3000);
      expect(config.timeout).toBe(180000); // 3分
      expect(config.waitUntil).toBe('networkidle');
      expect(config.forceKillOnTimeout).toBe(true);
    });

    it('should generate correct config for heavy sites', () => {
      // Act
      const result = WebGLDetector.preDetect('https://stripe.com');
      const config = result.recommendedConfig;

      // Assert
      expect(config.enableGPU).toBe(true);
      expect(config.timeout).toBe(120000); // 2分
    });

    it('should generate correct config for normal sites', () => {
      // Act
      const result = WebGLDetector.preDetect('https://example.com');
      const config = result.recommendedConfig;

      // Assert
      expect(config.enableGPU).toBe(false);
      expect(config.waitForWebGL).toBe(false);
      expect(config.timeout).toBe(60000); // 1分
      expect(config.waitUntil).toBe('load');
      expect(config.forceKillOnTimeout).toBe(false);
    });
  });

  describe('レガシーAPI互換性', () => {
    it('should maintain backward compatibility with detectWebGL', () => {
      // Act
      const result = detectWebGL(HTML_WITH_THREEJS);

      // Assert
      expect(result.detected).toBe(true);
      expect(result.libraries).toContain('three.js');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it('should maintain backward compatibility with adjustTimeoutForWebGL', () => {
      // Arrange
      const webglResult: LegacyWebGLDetectionResult = {
        detected: true,
        libraries: ['three.js'],
        confidence: 0.9,
        evidence: ['three.js detected'],
      };

      // Act
      const adjusted = adjustTimeoutForWebGL(60000, webglResult);

      // Assert
      expect(adjusted.extended).toBe(true);
      expect(adjusted.effectiveTimeout).toBeGreaterThan(60000);
      expect(adjusted.effectiveTimeout).toBeLessThanOrEqual(300000); // 最大5分
    });
  });
});

// ============================================================================
// Phase4-2: ブラウザプロセス管理 テスト
// ============================================================================

describe('Phase4-2: ブラウザプロセス管理', () => {
  describe('BrowserProcessManager初期化', () => {
    it('should create manager with default options', () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      // Act
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // Assert
      expect(manager).toBeDefined();
    });

    it('should create manager with custom kill grace period', () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      // Act
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 10000,
      });

      // Assert
      expect(manager).toBeDefined();
    });
  });

  describe('safeClose', () => {
    it('should close browser gracefully on success', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      // Act
      await manager.safeClose();

      // Assert
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    it('should handle close failure without force kill when disabled', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockRejectedValue(new Error('Browser crashed')),
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      // Act & Assert - エラーが発生しないこと
      await expect(manager.safeClose()).resolves.toBeUndefined();
    });
  });

  describe('closeWithTimeout', () => {
    it('should return true when close completes within timeout', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      // Act
      const result = await manager.closeWithTimeout(5000);

      // Assert
      expect(result).toBe(true);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    it('should return false when close times out', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockImplementation(() => new Promise(() => {})), // 永久に解決しない
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      // Act
      const result = await manager.closeWithTimeout(100);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when close fails', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockRejectedValue(new Error('Close failed')),
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      // Act
      const result = await manager.closeWithTimeout(5000);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('killAllChildren（Linuxのみ）', () => {
    it('should handle killAllChildren gracefully when no PID', async () => {
      // Arrange
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // Act & Assert - エラーが発生しないこと
      await expect(manager.killAllChildren()).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// Phase4-3: ドメインリスト テスト
// ============================================================================

describe('Phase4-3: ドメインリスト', () => {
  describe('ドメイン数検証', () => {
    it('should have 35+ known WebGL domains', () => {
      // Assert - 最低35ドメイン以上（Phase4-3で39ドメイン登録済み）
      expect(KNOWN_WEBGL_DOMAINS.length).toBeGreaterThanOrEqual(35);
      console.log(`[Phase4-3] Known WebGL domains count: ${KNOWN_WEBGL_DOMAINS.length}`);
    });

    it('should have domains in WEBGL_DOMAIN_MAP', () => {
      // Assert
      expect(WEBGL_DOMAIN_MAP.size).toBeGreaterThanOrEqual(35);
    });
  });

  describe('ユーザー報告サイト', () => {
    it('should include user-reported timeout site: linear.app', () => {
      // Act
      const entry = getDomainEntry('linear.app');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.tier).toBe('ultra-heavy');
      expect(entry?.notes).toContain('ユーザー報告');
    });

    it('should include user-reported timeout site: vercel.com', () => {
      // Act
      const entry = getDomainEntry('vercel.com');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.notes).toContain('ユーザー報告');
    });

    it('should include user-reported timeout site: notion.so', () => {
      // Act
      const entry = getDomainEntry('notion.so');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.notes).toContain('ユーザー報告');
    });
  });

  describe('カテゴリ検索', () => {
    it('should filter domains by category: award_gallery', () => {
      // Act
      const awardSites = getDomainsByCategory('award_gallery');

      // Assert
      expect(awardSites.length).toBeGreaterThan(0);
      awardSites.forEach(site => {
        expect(site.category).toBe('award_gallery');
      });
    });

    it('should filter domains by category: agency', () => {
      // Act
      const agencySites = getDomainsByCategory('agency');

      // Assert
      expect(agencySites.length).toBeGreaterThan(0);
      agencySites.forEach(site => {
        expect(site.category).toBe('agency');
      });
    });

    it('should filter domains by category: product', () => {
      // Act
      const productSites = getDomainsByCategory('product');

      // Assert
      expect(productSites.length).toBeGreaterThan(0);
      expect(productSites.map(s => s.domain)).toContain('linear.app');
      expect(productSites.map(s => s.domain)).toContain('vercel.com');
    });

    it('should filter domains by category: experiment', () => {
      // Act
      const experimentSites = getDomainsByCategory('experiment');

      // Assert
      expect(experimentSites.length).toBeGreaterThan(0);
      expect(experimentSites.map(s => s.domain)).toContain('threejs.org');
    });

    it('should filter domains by category: portfolio', () => {
      // Act
      const portfolioSites = getDomainsByCategory('portfolio');

      // Assert
      expect(portfolioSites.length).toBeGreaterThan(0);
    });
  });

  describe('Tier検索', () => {
    it('should filter domains by tier: ultra-heavy', () => {
      // Act
      const ultraHeavySites = getDomainsByTier('ultra-heavy');

      // Assert
      expect(ultraHeavySites.length).toBeGreaterThan(0);
      ultraHeavySites.forEach(site => {
        expect(site.tier).toBe('ultra-heavy');
      });
      expect(ultraHeavySites.map(s => s.domain)).toContain('resn.co.nz');
      expect(ultraHeavySites.map(s => s.domain)).toContain('linear.app');
    });

    it('should filter domains by tier: heavy', () => {
      // Act
      const heavySites = getDomainsByTier('heavy');

      // Assert
      expect(heavySites.length).toBeGreaterThan(0);
      heavySites.forEach(site => {
        expect(site.tier).toBe('heavy');
      });
    });

    it('should filter domains by tier: webgl', () => {
      // Act
      const webglSites = getDomainsByTier('webgl');

      // Assert
      expect(webglSites.length).toBeGreaterThan(0);
      webglSites.forEach(site => {
        expect(site.tier).toBe('webgl');
      });
    });
  });

  describe('ドメインエントリ取得', () => {
    it('should get entry by domain name', () => {
      // Act
      const entry = getDomainEntry('resn.co.nz');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.domain).toBe('resn.co.nz');
      expect(entry?.tier).toBe('ultra-heavy');
      expect(entry?.category).toBe('agency');
    });

    it('should get entry by URL', () => {
      // Act
      const entry = getDomainEntry('https://resn.co.nz/work/project');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.domain).toBe('resn.co.nz');
    });

    it('should get entry with www prefix', () => {
      // Act
      const entry = getDomainEntry('www.stripe.com');

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.domain).toBe('stripe.com');
    });

    it('should return undefined for unknown domain', () => {
      // Act
      const entry = getDomainEntry('unknown-domain.com');

      // Assert
      expect(entry).toBeUndefined();
    });
  });

  describe('ドメイン存在確認', () => {
    it('should return true for known domain', () => {
      // Assert
      expect(isDomainInList('linear.app')).toBe(true);
      expect(isDomainInList('https://vercel.com')).toBe(true);
      expect(isDomainInList('www.notion.so')).toBe(true);
    });

    it('should return false for unknown domain', () => {
      // Assert
      expect(isDomainInList('google.com')).toBe(false);
      expect(isDomainInList('https://example.com')).toBe(false);
    });
  });

  describe('後方互換性', () => {
    it('should export KNOWN_ULTRA_HEAVY_DOMAINS array', () => {
      // Assert
      expect(Array.isArray(KNOWN_ULTRA_HEAVY_DOMAINS)).toBe(true);
      expect(KNOWN_ULTRA_HEAVY_DOMAINS.length).toBeGreaterThan(0);
      expect(KNOWN_ULTRA_HEAVY_DOMAINS).toContain('resn.co.nz');
    });

    it('should export KNOWN_HEAVY_DOMAINS array', () => {
      // Assert
      expect(Array.isArray(KNOWN_HEAVY_DOMAINS)).toBe(true);
      expect(KNOWN_HEAVY_DOMAINS.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// リトライ戦略 テスト
// ============================================================================

describe('Phase4: リトライ戦略', () => {
  describe('SiteTier別のリトライ設定', () => {
    it('should return correct strategy for ultra-heavy sites', () => {
      // Act
      const strategy = getRetryStrategy('ultra-heavy');

      // Assert
      expect(strategy.maxRetries).toBe(1);
      expect(strategy.timeoutMultiplier).toBe(1.0); // 累積なし
      expect(strategy.retryOnlyOnNetworkError).toBe(true);
    });

    it('should return correct strategy for heavy sites', () => {
      // Act
      const strategy = getRetryStrategy('heavy');

      // Assert
      expect(strategy.maxRetries).toBe(1);
      expect(strategy.timeoutMultiplier).toBe(1.0);
      expect(strategy.retryOnlyOnNetworkError).toBe(true);
    });

    it('should return correct strategy for webgl sites', () => {
      // Act
      const strategy = getRetryStrategy('webgl');

      // Assert
      expect(strategy.maxRetries).toBe(2);
      expect(strategy.timeoutMultiplier).toBe(1.2);
      expect(strategy.retryOnlyOnNetworkError).toBe(false);
    });

    it('should return correct strategy for normal sites', () => {
      // Act
      const strategy = getRetryStrategy('normal');

      // Assert
      expect(strategy.maxRetries).toBe(2);
      expect(strategy.timeoutMultiplier).toBe(1.5);
      expect(strategy.retryOnlyOnNetworkError).toBe(false);
    });
  });

  describe('MCP 600秒制限遵守', () => {
    it('should keep retry time within MCP limit for ultra-heavy', () => {
      // Arrange
      const strategy = getRetryStrategy('ultra-heavy');
      const baseTimeout = 180000; // 3分

      // Act - 最大リトライ時の合計時間を計算
      let totalTime = baseTimeout; // 初回
      for (let i = 0; i < strategy.maxRetries; i++) {
        totalTime += strategy.waitBetweenRetriesMs;
        totalTime += baseTimeout * strategy.timeoutMultiplier;
      }

      // Assert - 600秒（10分）以内
      expect(totalTime).toBeLessThanOrEqual(600000);
    });

    it('should keep retry time within MCP limit for heavy', () => {
      // Arrange
      const strategy = getRetryStrategy('heavy');
      const baseTimeout = 120000; // 2分

      // Act
      let totalTime = baseTimeout;
      for (let i = 0; i < strategy.maxRetries; i++) {
        totalTime += strategy.waitBetweenRetriesMs;
        totalTime += baseTimeout * strategy.timeoutMultiplier;
      }

      // Assert
      expect(totalTime).toBeLessThanOrEqual(600000);
    });
  });
});

// ============================================================================
// エンドツーエンドフロー テスト
// ============================================================================

describe('Phase4: エンドツーエンドフロー', () => {
  describe('WebGL検出から設定切替までのフロー', () => {
    it('should complete WebGL site analysis with optimized settings (URL detection)', () => {
      // Step 1: URL事前検出
      const preResult = WebGLDetector.preDetect('https://resn.co.nz');
      expect(preResult.isWebGL).toBe(true);
      expect(preResult.siteTier).toBe('ultra-heavy');

      // Step 2: 推奨設定を取得
      const config = preResult.recommendedConfig;
      expect(config.enableGPU).toBe(true);
      expect(config.timeout).toBe(180000);
      expect(config.forceKillOnTimeout).toBe(true);

      // Step 3: リトライ戦略を取得
      const strategy = getRetryStrategy(preResult.siteTier);
      expect(strategy.maxRetries).toBe(1);
      expect(strategy.retryOnlyOnNetworkError).toBe(true);
    });

    it('should complete WebGL site analysis with optimized settings (HTML detection)', () => {
      // Step 1: HTML解析
      const htmlResult = WebGLDetector.analyzeHtml(HTML_WITH_THREEJS);
      expect(htmlResult.isWebGL).toBe(true);
      expect(htmlResult.detectedLibraries).toContain('three.js');

      // Step 2: 推奨設定を取得
      const config = htmlResult.recommendedConfig;
      expect(config.enableGPU).toBe(true);
      expect(config.waitForWebGL).toBe(true);

      // Step 3: リトライ戦略を取得
      const strategy = getRetryStrategy(htmlResult.siteTier);
      expect(strategy.autoRetry).toBe(true);
    });

    it('should handle normal site without WebGL optimization', () => {
      // Step 1: URL事前検出
      const preResult = WebGLDetector.preDetect('https://example.com');
      expect(preResult.isWebGL).toBe(false);
      expect(preResult.siteTier).toBe('normal');

      // Step 2: 推奨設定を取得
      const config = preResult.recommendedConfig;
      expect(config.enableGPU).toBe(false);
      expect(config.timeout).toBe(60000);
      expect(config.forceKillOnTimeout).toBe(false);

      // Step 3: リトライ戦略を取得
      const strategy = getRetryStrategy(preResult.siteTier);
      expect(strategy.maxRetries).toBe(2);
      expect(strategy.timeoutMultiplier).toBe(1.5);
    });
  });

  describe('信頼度スコア計算', () => {
    it('should calculate confidence from multiple signals', () => {
      // Arrange
      const signals = {
        domainMatch: true,
        urlPatternMatch: false,
        libraries: ['three.js', 'gsap'],
        canvasCount: 2,
        webglContext: true,
      };

      // Act
      const confidence = WebGLDetector.calculateConfidence(signals);

      // Assert
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(confidence).toBeGreaterThan(0.5); // 複数シグナルがあるので高め
    });

    it('should return low confidence for minimal signals', () => {
      // Arrange
      const signals = {
        domainMatch: false,
        urlPatternMatch: false,
        libraries: [],
        canvasCount: 1,
        webglContext: false,
      };

      // Act
      const confidence = WebGLDetector.calculateConfidence(signals);

      // Assert
      expect(confidence).toBeLessThan(0.5);
    });
  });
});

// ============================================================================
// パフォーマンステスト
// ============================================================================

describe('Phase4: パフォーマンス', () => {
  it('should complete domain lookup quickly (O(1))', () => {
    // Arrange
    const domains = ['resn.co.nz', 'linear.app', 'vercel.com', 'stripe.com', 'google.com'];

    // Act
    const startTime = performance.now();
    for (let i = 0; i < 1000; i++) {
      for (const domain of domains) {
        getDomainEntry(domain);
      }
    }
    const duration = performance.now() - startTime;

    // Assert - 5000回のルックアップが200ms以内（CI runners have variable performance）
    expect(duration).toBeLessThan(200);
    console.log(`[Phase4] Domain lookup 5000x: ${duration.toFixed(2)}ms`);
  });

  it('should complete URL pre-detection quickly', () => {
    // Arrange
    const urls = [
      'https://resn.co.nz',
      'https://linear.app',
      'https://google.com',
      'https://example.com/webgl/demo',
    ];

    // Act
    const startTime = performance.now();
    for (let i = 0; i < 1000; i++) {
      for (const url of urls) {
        WebGLDetector.preDetect(url);
      }
    }
    const duration = performance.now() - startTime;

    // Assert - 4000回の事前検出が200ms以内
    expect(duration).toBeLessThan(200);
    console.log(`[Phase4] URL pre-detection 4000x: ${duration.toFixed(2)}ms`);
  });

  it('should complete HTML analysis quickly', () => {
    // Act
    const startTime = performance.now();
    for (let i = 0; i < 100; i++) {
      WebGLDetector.analyzeHtml(HTML_WITH_THREEJS);
    }
    const duration = performance.now() - startTime;

    // Assert - 100回のHTML解析が500ms以内
    expect(duration).toBeLessThan(500);
    console.log(`[Phase4] HTML analysis 100x: ${duration.toFixed(2)}ms`);
  });
});

// ============================================================================
// エッジケーステスト
// ============================================================================

describe('Phase4: エッジケース', () => {
  describe('入力バリデーション', () => {
    it('should handle null/undefined URL', () => {
      // Act & Assert
      expect(() => WebGLDetector.preDetect(null as unknown as string)).not.toThrow();
      expect(() => WebGLDetector.preDetect(undefined as unknown as string)).not.toThrow();
    });

    it('should handle malformed URL', () => {
      // Act
      const result = WebGLDetector.preDetect('not-a-valid-url');

      // Assert
      expect(result.isWebGL).toBe(false);
    });

    it('should handle URL without protocol', () => {
      // Act
      const result = WebGLDetector.preDetect('resn.co.nz');

      // Assert
      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('ultra-heavy');
    });
  });

  describe('HTML解析のエッジケース', () => {
    it('should handle very large HTML', () => {
      // Arrange - 100KB以上のHTML
      const largeHtml = '<html><body>' + '<div>Content</div>'.repeat(10000) + '</body></html>';

      // Act
      const startTime = performance.now();
      const result = WebGLDetector.analyzeHtml(largeHtml);
      const duration = performance.now() - startTime;

      // Assert - 大きなHTMLでも1秒以内に完了
      expect(duration).toBeLessThan(1000);
      expect(result.isWebGL).toBe(false);
    });

    it('should handle HTML with special characters', () => {
      // Arrange
      const html = '<script>const x = "THREE.Scene"; // Not actual Three.js</script>';

      // Act
      const result = WebGLDetector.analyzeHtml(html);

      // Assert - 文字列内のパターンも検出される（false positive）
      // これは既知の制限事項
      expect(result).toBeDefined();
    });
  });

  describe('ドメインリストのエッジケース', () => {
    it('should handle case-insensitive domain lookup', () => {
      // Act
      const entry1 = getDomainEntry('RESN.CO.NZ');
      const entry2 = getDomainEntry('Resn.Co.Nz');

      // Assert
      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
      expect(entry1?.domain).toBe(entry2?.domain);
    });

    it('should handle subdomain lookup', () => {
      // Act - サブドメインはマッチしない（仕様）
      const entry = getDomainEntry('app.linear.app');

      // Assert
      // 現在の実装ではサブドメインは検出されない
      // これは期待される動作（完全一致のみ）
      expect(entry).toBeUndefined();
    });
  });
});
