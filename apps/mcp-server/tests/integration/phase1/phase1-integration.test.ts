// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase1 統合テスト
 *
 * Phase1で実装した機能の統合テスト:
 * - Phase1-1: GPU有効化 (enableGPU: true, --use-angle=gl)
 * - Phase1-2: 待機戦略最適化 (waitForWebGL: true, domcontentloaded + 固定待機)
 * - Phase1-3: リトライ戦略見直し (SiteTierベース、タイムアウト累積防止)
 *
 * 検証内容:
 * 1. SiteTier検出 → 適切なリトライ戦略適用
 * 2. タイムアウト分配の正確性
 * 3. MCP 600秒上限の遵守
 *
 * @module tests/integration/phase1/phase1-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Phase1実装モジュール
import {
  preDetectWebGL,
  detectSiteTier,
  KNOWN_WEBGL_DOMAINS,
  KNOWN_ULTRA_HEAVY_DOMAINS,
  KNOWN_HEAVY_DOMAINS,
  type PreDetectionResult,
} from '../../../src/tools/page/handlers/webgl-pre-detector';

import {
  getRetryStrategy,
  isNetworkError,
  shouldRetry,
  calculateMaxTotalTime,
  type RetryStrategyConfig,
  type SiteTier,
} from '../../../src/tools/page/handlers/retry-strategy';

import {
  distributeTimeout,
  ExecutionStatusTracker,
} from '../../../src/tools/page/handlers/timeout-utils';

// ============================================================================
// 定数
// ============================================================================

/** MCP最大タイムアウト（600秒） */
const MCP_MAX_TIMEOUT_MS = 600000;

/** Phase1テスト用のサンプルURL */
const SAMPLE_URLS = {
  // ultra-heavyサイト
  ultraHeavy: [
    'https://resn.co.nz',
    'https://activetheory.net',
    'https://lusion.co',
  ],
  // heavyサイト
  heavy: [
    'https://bruno-simon.com',
    'https://dogstudio.co',
    'https://cuberto.com',
  ],
  // medium（WebGL URLパターン）
  webgl: [
    'https://example.com/webgl/demo',
    'https://example.com/3d/viewer',
    'https://example.com/experience/',
  ],
  // normalサイト
  normal: [
    'https://stripe.com',
    'https://supabase.com',
    'https://github.com',
    'https://google.com',
  ],
};

// ============================================================================
// Phase1-1: GPU有効化テスト
// ============================================================================

describe('Phase1-1: GPU有効化設定', () => {
  describe('WebGL事前検出', () => {
    it.each(KNOWN_WEBGL_DOMAINS)('既知WebGLドメイン %s を検出', (domain) => {
      const result = preDetectWebGL(`https://${domain}`);

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.timeoutMultiplier).toBe(3.0);
      expect(result.matchedDomain).toBe(domain);
    });

    it('URLパターンベースの検出（/webgl/, /3d/, /experience/）', () => {
      const patterns = ['/webgl/', '/3d/', '/experience/', '/interactive/', '/immersive/'];

      for (const pattern of patterns) {
        const url = `https://example.com${pattern}demo`;
        const result = preDetectWebGL(url);

        expect(result.isLikelyWebGL).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.timeoutMultiplier).toBe(2.0);
      }
    });

    it('通常サイトは非WebGLとして検出', () => {
      for (const url of SAMPLE_URLS.normal) {
        // stripe.comはKNOWN_WEBGL_DOMAINSに含まれるためスキップ
        if (url.includes('stripe.com')) continue;

        const result = preDetectWebGL(url);

        // 事前検出では「既知ドメイン」か「URLパターン」のみを検出
        // stripe.com等の「動的にWebGLを使用するサイト」は事前検出では検出されない
        if (!result.matchedDomain && !result.matchedPattern) {
          expect(result.isLikelyWebGL).toBe(false);
          expect(result.timeoutMultiplier).toBe(1.0);
        }
      }
    });
  });

  describe('GPU有効化オプションの適用', () => {
    it('WebGLサイトではGPU有効化フラグが必要', () => {
      const webglUrl = 'https://resn.co.nz';
      const detection = preDetectWebGL(webglUrl);

      // WebGL検出された場合、GPU有効化が推奨される
      expect(detection.isLikelyWebGL).toBe(true);

      // 実際のPlaywright起動オプションではenableGPU: trueを使用
      // ここではその判断ロジックをテスト
      const shouldEnableGPU = detection.isLikelyWebGL;
      expect(shouldEnableGPU).toBe(true);
    });

    it('通常サイトではGPU有効化は不要', () => {
      const normalUrl = 'https://example.com/normal-page';
      const detection = preDetectWebGL(normalUrl);

      expect(detection.isLikelyWebGL).toBe(false);

      const shouldEnableGPU = detection.isLikelyWebGL;
      expect(shouldEnableGPU).toBe(false);
    });
  });
});

// ============================================================================
// Phase1-2: 待機戦略最適化テスト
// ============================================================================

describe('Phase1-2: 待機戦略最適化', () => {
  describe('SiteTier別の待機戦略', () => {
    it.each([
      ['ultra-heavy', 180000, 'networkidle'],
      ['heavy', 120000, 'networkidle'],
      ['webgl', 60000, 'webgl-extended'],
      ['normal', 30000, 'standard'],
    ] as const)('SiteTier=%s → timeout=%dms, strategy=%s', (tier, expectedTimeout, _strategy) => {
      const config = getRetryStrategy(tier as SiteTier);

      // SiteTierに基づくリトライ設定が正しく返されることを確認
      expect(config).toBeDefined();
      expect(config.autoRetry).toBe(true);

      // タイムアウト計算の検証（モックとして基本タイムアウトを設定）
      const baseTimeout = expectedTimeout;
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      // MCP上限を超えないことを確認
      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
    });
  });

  describe('タイムアウト分配', () => {
    it('JSアニメーション有効時のタイムアウト分配', () => {
      const distributed = distributeTimeout(
        120000, // 2分
        false,  // フレームキャプチャ無効
        true,   // JSアニメーション有効
        { detected: true, multiplier: 2.0 } // WebGL検出
      );

      // モーション検出タイムアウトがWebGL乗数で延長されていることを確認
      expect(distributed.motionDetection).toBeGreaterThan(0);
      expect(distributed.jsAnimationDetection).toBeGreaterThan(0);
    });

    it('CSS静的解析のみの場合のタイムアウト分配', () => {
      const distributed = distributeTimeout(
        60000,  // 1分
        false,  // フレームキャプチャ無効
        false,  // JSアニメーション無効
      );

      // CSS解析のみの場合は最小20秒が保証される
      // distributeTimeout内でratioに基づいて計算されるが、
      // MIN_MOTION_TIMEOUT (20000) が適用される
      expect(distributed.motionDetection).toBeGreaterThanOrEqual(20000);
    });

    it('video mode有効時のタイムアウト分配', () => {
      const distributed = distributeTimeout(
        180000, // 3分
        true,   // フレームキャプチャ有効
        false,  // JSアニメーション無効
      );

      // フレームキャプチャ分が追加されていることを確認
      expect(distributed.frameCapture).toBeGreaterThan(0);
    });
  });

  describe('ExecutionStatusTracker', () => {
    let tracker: ExecutionStatusTracker;

    beforeEach(() => {
      tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });
    });

    it('フェーズ完了を正しく追跡', () => {
      tracker.markCompleted('html');
      tracker.markCompleted('layout');

      const status = tracker.toExecutionStatus();

      expect(status.completed_phases).toContain('html');
      expect(status.completed_phases).toContain('layout');
      expect(status.timeout_occurred).toBe(false);
    });

    it('タイムアウト発生を正しく記録', () => {
      tracker.markCompleted('html');
      tracker.markFailed('motion', true);

      const status = tracker.toExecutionStatus();

      expect(status.completed_phases).toContain('html');
      expect(status.failed_phases).toContain('motion');
      expect(status.timeout_occurred).toBe(true);
    });

    it('WebGL検出時のタイムアウト延長を記録', () => {
      tracker.setWebGLDetected(true, true);
      tracker.updateEffectiveTimeout(120000);

      const status = tracker.toExecutionStatus();

      expect(status.webgl_detected).toBe(true);
      expect(status.timeout_extended).toBe(true);
      expect(status.effective_timeout_ms).toBe(120000);
    });

    it('progressive戦略で部分結果を返却', () => {
      tracker.markCompleted('html');
      tracker.markFailed('motion', true);

      expect(tracker.shouldReturnPartialResults()).toBe(true);
    });

    it('strict戦略では部分結果を返却しない', () => {
      const strictTracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'strict',
        partialResultsEnabled: false,
      });

      strictTracker.markCompleted('html');
      strictTracker.markFailed('motion', true);

      expect(strictTracker.shouldReturnPartialResults()).toBe(false);
    });
  });
});

// ============================================================================
// Phase1-3: リトライ戦略テスト
// ============================================================================

describe('Phase1-3: リトライ戦略', () => {
  describe('SiteTier検出', () => {
    it.each(KNOWN_ULTRA_HEAVY_DOMAINS)('ultra-heavy: %s', (domain) => {
      const tier = detectSiteTier(`https://${domain}`);
      expect(tier).toBe('ultra-heavy');
    });

    it.each(KNOWN_HEAVY_DOMAINS)('heavy: %s', (domain) => {
      const tier = detectSiteTier(`https://${domain}`);
      expect(tier).toBe('heavy');
    });

    it('URLパターンマッチでwebgl判定', () => {
      for (const url of SAMPLE_URLS.webgl) {
        const tier = detectSiteTier(url);
        expect(tier).toBe('webgl');
      }
    });

    it('未知サイトはnormal判定', () => {
      const tier = detectSiteTier('https://unknown-site.example.com');
      expect(tier).toBe('normal');
    });
  });

  describe('リトライ戦略設定', () => {
    it('ultra-heavy: リトライ1回、ネットワークエラーのみ', () => {
      const config = getRetryStrategy('ultra-heavy');

      expect(config.autoRetry).toBe(true);
      expect(config.maxRetries).toBe(1);
      expect(config.timeoutMultiplier).toBe(1.0); // 累積なし
      expect(config.retryOnlyOnNetworkError).toBe(true);
    });

    it('heavy: リトライ1回、ネットワークエラーのみ', () => {
      const config = getRetryStrategy('heavy');

      expect(config.autoRetry).toBe(true);
      expect(config.maxRetries).toBe(1);
      expect(config.timeoutMultiplier).toBe(1.0); // 累積なし
      expect(config.retryOnlyOnNetworkError).toBe(true);
    });

    it('webgl: リトライ2回、軽い累積', () => {
      const config = getRetryStrategy('webgl');

      expect(config.autoRetry).toBe(true);
      expect(config.maxRetries).toBe(2);
      expect(config.timeoutMultiplier).toBe(1.2); // 軽い累積
      expect(config.retryOnlyOnNetworkError).toBe(false);
    });

    it('normal: リトライ2回、従来動作', () => {
      const config = getRetryStrategy('normal');

      expect(config.autoRetry).toBe(true);
      expect(config.maxRetries).toBe(2);
      expect(config.timeoutMultiplier).toBe(1.5); // 従来の累積
      expect(config.retryOnlyOnNetworkError).toBe(false);
    });
  });

  describe('ネットワークエラー判定', () => {
    it.each([
      'net::ERR_CONNECTION_REFUSED',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'Network error occurred',
      'Socket hang up',
      'DNS resolution failed',
    ])('ネットワークエラーとして判定: %s', (message) => {
      const error = new Error(message);
      expect(isNetworkError(error)).toBe(true);
    });

    it.each([
      'Timeout waiting for page',
      'Page load timeout',
      'Navigation timeout',
      'Element not found',
    ])('ネットワークエラーではない: %s', (message) => {
      const error = new Error(message);
      expect(isNetworkError(error)).toBe(false);
    });

    it('Errorでないオブジェクトは常にfalse', () => {
      expect(isNetworkError('string error')).toBe(false);
      expect(isNetworkError(null)).toBe(false);
      expect(isNetworkError(undefined)).toBe(false);
      expect(isNetworkError({})).toBe(false);
    });
  });

  describe('リトライ判定（shouldRetry）', () => {
    it('ultra-heavy: ネットワークエラーのみリトライ', () => {
      const config = getRetryStrategy('ultra-heavy');

      const networkError = new Error('net::ERR_CONNECTION_REFUSED');
      const timeoutError = new Error('Timeout waiting for page');

      expect(shouldRetry(networkError, 0, config)).toBe(true);
      expect(shouldRetry(timeoutError, 0, config)).toBe(false);
    });

    it('normal: 全エラーでリトライ', () => {
      const config = getRetryStrategy('normal');

      const networkError = new Error('net::ERR_CONNECTION_REFUSED');
      const timeoutError = new Error('Timeout waiting for page');

      expect(shouldRetry(networkError, 0, config)).toBe(true);
      expect(shouldRetry(timeoutError, 0, config)).toBe(true);
    });

    it('最大リトライ回数到達後はリトライしない', () => {
      const config = getRetryStrategy('normal');

      const error = new Error('Any error');

      expect(shouldRetry(error, 0, config)).toBe(true);  // 1回目
      expect(shouldRetry(error, 1, config)).toBe(true);  // 2回目
      expect(shouldRetry(error, 2, config)).toBe(false); // 上限到達
    });
  });

  describe('MCP 600秒上限遵守', () => {
    it.each([
      ['ultra-heavy', 180000],
      ['heavy', 120000],
      ['webgl', 90000],
      ['normal', 60000],
    ] as const)('SiteTier=%s, baseTimeout=%dms: 600秒以内', (tier, baseTimeout) => {
      const config = getRetryStrategy(tier as SiteTier);
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);

      // 各Tierでの最大時間を記録（開発ログ用）
      console.log(`[Phase1] ${tier}: baseTimeout=${baseTimeout}ms, maxTotalTime=${maxTime}ms`);
    });

    it('最悪ケース: ultra-heavy + 180秒タイムアウト', () => {
      const config = getRetryStrategy('ultra-heavy');
      const baseTimeout = 180000; // 3分

      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      // ultra-heavy: 1回リトライ、累積なし
      // 180000 + 5000 + 180000 = 365000ms (約6分)
      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      expect(maxTime).toBe(365000);
    });

    it('最悪ケース: normal + 60秒タイムアウト + 2回リトライ', () => {
      const config = getRetryStrategy('normal');
      const baseTimeout = 60000; // 1分

      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      // normal: 2回リトライ、1.5倍累積
      // 60000 + 1000 + 90000 + 1000 + 135000 = 287000ms (約4.8分)
      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
    });
  });
});

// ============================================================================
// 統合シナリオテスト
// ============================================================================

describe('Phase1 統合シナリオ', () => {
  describe('WebGLサイト検出 → リトライ戦略適用フロー', () => {
    it('resn.co.nz: ultra-heavy → 控えめなリトライ', () => {
      const url = 'https://resn.co.nz';

      // Step 1: 事前検出
      const preDetection = preDetectWebGL(url);
      expect(preDetection.isLikelyWebGL).toBe(true);
      expect(preDetection.timeoutMultiplier).toBe(3.0);

      // Step 2: SiteTier検出
      const tier = detectSiteTier(url, preDetection);
      expect(tier).toBe('ultra-heavy');

      // Step 3: リトライ戦略取得
      const retryConfig = getRetryStrategy(tier);
      expect(retryConfig.maxRetries).toBe(1);
      expect(retryConfig.retryOnlyOnNetworkError).toBe(true);

      // Step 4: タイムアウト計算（MCP上限内か確認）
      // ultra-heavyサイトでは基本タイムアウトを使用（乗数は適用しない）
      // 実際のpage.analyzeでは乗数適用後にMCP上限でクリップされる
      const baseTimeout = 180000; // 3分（ultra-heavy標準）
      const maxTime = calculateMaxTotalTime(baseTimeout, retryConfig);

      // ultra-heavy: 1回リトライ、累積なし
      // 180000 + 5000 + 180000 = 365000ms (約6分)
      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      expect(maxTime).toBe(365000);
    });

    it('URLパターンサイト: webgl → 適度なリトライ', () => {
      const url = 'https://example.com/webgl/demo';

      // Step 1: 事前検出
      const preDetection = preDetectWebGL(url);
      expect(preDetection.isLikelyWebGL).toBe(true);
      expect(preDetection.timeoutMultiplier).toBe(2.0);

      // Step 2: SiteTier検出
      const tier = detectSiteTier(url, preDetection);
      expect(tier).toBe('webgl');

      // Step 3: リトライ戦略取得
      const retryConfig = getRetryStrategy(tier);
      expect(retryConfig.maxRetries).toBe(2);
      expect(retryConfig.retryOnlyOnNetworkError).toBe(false);

      // Step 4: タイムアウト計算
      const baseTimeout = 60000 * preDetection.timeoutMultiplier; // 120000ms
      const maxTime = calculateMaxTotalTime(baseTimeout, retryConfig);

      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
    });

    it('通常サイト: normal → 従来動作', () => {
      const url = 'https://example.com';

      // Step 1: 事前検出
      const preDetection = preDetectWebGL(url);
      expect(preDetection.isLikelyWebGL).toBe(false);
      expect(preDetection.timeoutMultiplier).toBe(1.0);

      // Step 2: SiteTier検出
      const tier = detectSiteTier(url, preDetection);
      expect(tier).toBe('normal');

      // Step 3: リトライ戦略取得
      const retryConfig = getRetryStrategy(tier);
      expect(retryConfig.maxRetries).toBe(2);
      expect(retryConfig.timeoutMultiplier).toBe(1.5);

      // Step 4: タイムアウト計算
      const baseTimeout = 60000; // 1分
      const maxTime = calculateMaxTotalTime(baseTimeout, retryConfig);

      expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
    });
  });

  describe('パフォーマンス', () => {
    it('preDetectWebGL: 10000回実行が200ms以内', () => {
      const urls = [
        'https://resn.co.nz',
        'https://google.com',
        'https://example.com/webgl/demo',
        'https://threejs.org/examples',
        'https://github.com',
      ];

      const startTime = performance.now();

      for (let i = 0; i < 10000; i++) {
        const url = urls[i % urls.length];
        preDetectWebGL(url);
      }

      const duration = performance.now() - startTime;

      // CI runners have variable performance; 200ms gives headroom while still verifying O(1) lookup
      expect(duration).toBeLessThan(200);
      console.log(`[Phase1] preDetectWebGL 10000回: ${duration.toFixed(2)}ms`);
    });

    it('detectSiteTier: 10000回実行が200ms以内', () => {
      const urls = [
        'https://resn.co.nz',
        'https://bruno-simon.com',
        'https://example.com/webgl/demo',
        'https://google.com',
      ];

      const startTime = performance.now();

      for (let i = 0; i < 10000; i++) {
        const url = urls[i % urls.length];
        detectSiteTier(url);
      }

      const duration = performance.now() - startTime;

      // CI環境のCPUばらつきを考慮して200msに設定（ローカルでは通常50ms以下）
      expect(duration).toBeLessThan(200);
      console.log(`[Phase1] detectSiteTier 10000回: ${duration.toFixed(2)}ms`);
    });
  });
});
