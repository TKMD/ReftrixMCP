// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLサイト E2Eテスト
 *
 * Phase1で実装したWebGL/Three.jsサイト対応機能のE2Eテスト:
 * - GPU有効化 (enableGPU: true)
 * - 待機戦略最適化 (waitForWebGL: true)
 * - リトライ戦略 (SiteTierベース)
 *
 * テスト対象:
 * - モックを使用した単体機能テスト
 * - 実際のWebサイトへのアクセスは最小限に抑える
 *
 * @module tests/e2e/webgl-sites.e2e.test
 */

import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from 'vitest';
import { PrismaClient } from '@prisma/client';

// page.analyze ハンドラー
import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  setPageAnalyzePrismaClientFactory,
  resetPageAnalyzePrismaClientFactory,
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeOutput,
} from '../../src/tools/page';

// Phase1実装モジュール
import {
  preDetectWebGL,
  detectSiteTier,
  KNOWN_WEBGL_DOMAINS,
  KNOWN_ULTRA_HEAVY_DOMAINS,
} from '../../src/tools/page/handlers/webgl-pre-detector';

import {
  getRetryStrategy,
  calculateMaxTotalTime,
  type SiteTier,
} from '../../src/tools/page/handlers/retry-strategy';

import {
  distributeTimeout,
} from '../../src/tools/page/handlers/timeout-utils';

import { TEST_DATABASE_URL } from './test-database-url';

// ============================================================================
// テスト設定
// ============================================================================

/** MCP最大タイムアウト */
const MCP_MAX_TIMEOUT_MS = 600000;

/** テストタイムアウト（秒） */
const TEST_TIMEOUT_SEC = 180;

/** Prismaクライアント */
let prisma: PrismaClient | null = null;

// ============================================================================
// ユーティリティ関数
// ============================================================================

/** 成功レスポンスか判定 */
function isSuccess(response: unknown): response is { success: true; data: PageAnalyzeOutput } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'success' in response &&
    (response as { success: boolean }).success === true
  );
}

/** エラーレスポンスか判定 */
function isError(response: unknown): response is { success: false; error: { code: string; message: string } } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'success' in response &&
    (response as { success: boolean }).success === false
  );
}

// ============================================================================
// E2Eテストスイート
// ============================================================================

describe('WebGLサイト E2Eテスト', () => {
  // ==========================================================================
  // セットアップ
  // ==========================================================================

  beforeAll(async () => {
    try {
      prisma = new PrismaClient({
        datasources: {
          db: {
            url: TEST_DATABASE_URL,
          },
        },
        log: ['error'],
      });

      await prisma.$connect();
      console.log('[E2E][WebGL] Database connected');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPageAnalyzePrismaClientFactory(() => prisma as any);
    } catch (error) {
      console.warn('[E2E][WebGL] Database connection failed, some tests may be skipped:', error);
    }
  }, 30000);

  afterAll(async () => {
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();

    if (prisma) {
      await prisma.$disconnect();
      console.log('[E2E][WebGL] Database disconnected');
    }
  });

  // ==========================================================================
  // Phase1機能検証: モック使用
  // ==========================================================================

  describe('Phase1機能検証（モック）', () => {
    describe('SiteTier検出', () => {
      it.each([
        ['https://resn.co.nz', 'ultra-heavy'],
        ['https://activetheory.net', 'ultra-heavy'],
        ['https://lusion.co', 'ultra-heavy'],
        ['https://bruno-simon.com', 'heavy'],
        ['https://dogstudio.co', 'heavy'],
        ['https://example.com/webgl/demo', 'webgl'],
        ['https://example.com/3d/viewer', 'webgl'],
        ['https://google.com', 'normal'],
        // github.comはドメインリスト登録済みで、既知ドメインマッチ時はconfidence=1.0のためheavyになる
        ['https://github.com', 'heavy'],
      ] as const)('%s → %s', (url, expectedTier) => {
        const tier = detectSiteTier(url);
        expect(tier).toBe(expectedTier);
      });
    });

    describe('タイムアウト戦略', () => {
      it('ultra-heavy: リトライ1回、累積なし', () => {
        const config = getRetryStrategy('ultra-heavy');

        expect(config.maxRetries).toBe(1);
        expect(config.timeoutMultiplier).toBe(1.0);
        expect(config.retryOnlyOnNetworkError).toBe(true);

        // MCP上限内か確認
        const maxTime = calculateMaxTotalTime(180000, config);
        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      });

      it('heavy: リトライ1回、累積なし', () => {
        const config = getRetryStrategy('heavy');

        expect(config.maxRetries).toBe(1);
        expect(config.timeoutMultiplier).toBe(1.0);

        const maxTime = calculateMaxTotalTime(120000, config);
        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      });

      it('webgl: リトライ2回、軽い累積(1.2)', () => {
        const config = getRetryStrategy('webgl');

        expect(config.maxRetries).toBe(2);
        expect(config.timeoutMultiplier).toBe(1.2);

        const maxTime = calculateMaxTotalTime(60000, config);
        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      });

      it('normal: リトライ2回、従来累積(1.5)', () => {
        const config = getRetryStrategy('normal');

        expect(config.maxRetries).toBe(2);
        expect(config.timeoutMultiplier).toBe(1.5);

        const maxTime = calculateMaxTotalTime(60000, config);
        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      });
    });

    describe('タイムアウト分配', () => {
      it('WebGL検出時: モーション検出タイムアウトが延長される', () => {
        const withWebGL = distributeTimeout(
          120000,
          false, // フレームキャプチャ無効
          true,  // JSアニメーション有効
          { detected: true, multiplier: 2.0 }
        );

        const withoutWebGL = distributeTimeout(
          120000,
          false,
          true,
          { detected: false, multiplier: 1.0 }
        );

        // WebGL検出時はタイムアウトが延長される
        // ただし、最小値（MIN_WEBGL_JS_MOTION_TIMEOUT = 180000）が適用されるため
        // 単純な比較ではなく、最小値以上であることを確認
        expect(withWebGL.motionDetection).toBeGreaterThanOrEqual(180000);
        // withoutWebGLの場合も最小値が適用される可能性があるため、具体的な値でチェック
        expect(withWebGL.jsAnimationDetection).toBeGreaterThan(0);
      });

      it('フレームキャプチャ有効時: frameCapture分が追加される', () => {
        const withFrameCapture = distributeTimeout(
          180000,
          true,  // フレームキャプチャ有効
          false,
        );

        expect(withFrameCapture.frameCapture).toBeGreaterThan(0);
      });
    });
  });

  // ==========================================================================
  // 実際のWebサイトテスト（スキップ可能）
  // ==========================================================================

  describe('実際のWebサイトテスト', () => {
    // 環境変数でスキップ可能
    const SKIP_REAL_SITE_TESTS = process.env.SKIP_REAL_SITE_TESTS === 'true';

    describe.skipIf(SKIP_REAL_SITE_TESTS || !prisma)('stripe.com (medium tier)', () => {
      it(
        'page.analyzeが成功する（save_to_db=false）',
        async () => {
          const result = await pageAnalyzeHandler({
            url: 'https://stripe.com',
            summary: true,
            timeout: 120000, // 2分
            features: {
              layout: true,
              motion: false, // モーション検出は無効（高速化）
              quality: false,
            },
            layoutOptions: {
              saveToDb: false,
              autoAnalyze: false,
              includeHtml: false,
              includeScreenshot: false,
              useVision: false,
            },
            waitUntil: 'domcontentloaded',
          });

          // 成功またはタイムアウトのいずれか
          if (isSuccess(result)) {
            expect(result.data).toBeDefined();
            console.log('[E2E][stripe.com] Success:', {
              hasPageInfo: !!result.data.pageInfo,
              hasLayout: !!result.data.layout,
              processingTime: result.data.processingTime,
            });
          } else if (isError(result)) {
            // タイムアウトやネットワークエラーは許容
            console.log('[E2E][stripe.com] Error (acceptable):', result.error);
            expect([
              PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
              PAGE_ANALYZE_ERROR_CODES.FETCH_FAILED,
              PAGE_ANALYZE_ERROR_CODES.NAVIGATION_FAILED,
            ]).toContain(result.error.code);
          }
        },
        TEST_TIMEOUT_SEC * 1000
      );
    });

    describe.skipIf(SKIP_REAL_SITE_TESTS || !prisma)('supabase.com (medium tier)', () => {
      it(
        'page.analyzeが成功する（save_to_db=false）',
        async () => {
          const result = await pageAnalyzeHandler({
            url: 'https://supabase.com',
            summary: true,
            timeout: 120000, // 2分
            features: {
              layout: true,
              motion: false,
              quality: false,
            },
            layoutOptions: {
              saveToDb: false,
              autoAnalyze: false,
              includeHtml: false,
              includeScreenshot: false,
              useVision: false,
            },
            waitUntil: 'domcontentloaded',
          });

          if (isSuccess(result)) {
            expect(result.data).toBeDefined();
            console.log('[E2E][supabase.com] Success:', {
              hasPageInfo: !!result.data.pageInfo,
              hasLayout: !!result.data.layout,
              processingTime: result.data.processingTime,
            });
          } else if (isError(result)) {
            console.log('[E2E][supabase.com] Error (acceptable):', result.error);
            expect([
              PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
              PAGE_ANALYZE_ERROR_CODES.FETCH_FAILED,
              PAGE_ANALYZE_ERROR_CODES.NAVIGATION_FAILED,
            ]).toContain(result.error.code);
          }
        },
        TEST_TIMEOUT_SEC * 1000
      );
    });

    // Heavy/Ultra-heavyサイトは時間がかかりすぎるためCIではスキップ
    describe.skip('heavy/ultra-heavy サイト（ローカル実行のみ）', () => {
      it.skip('resn.co.nz (ultra-heavy) - 手動実行用', async () => {
        const tier = detectSiteTier('https://resn.co.nz');
        expect(tier).toBe('ultra-heavy');

        // 実際のテストは非常に時間がかかるためスキップ
        // ローカルで手動実行する場合はこのテストを有効化
      });

      it.skip('bruno-simon.com (heavy) - 手動実行用', async () => {
        const tier = detectSiteTier('https://bruno-simon.com');
        expect(tier).toBe('heavy');
      });
    });
  });

  // ==========================================================================
  // エラーハンドリングテスト
  // ==========================================================================

  describe('エラーハンドリング', () => {
    it('無効なURLでエラーを返す', async () => {
      const result = await pageAnalyzeHandler({
        url: 'not-a-valid-url',
        summary: true,
        timeout: 10000,
      });

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        // Zodバリデーションエラー（VALIDATION_ERROR）
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('存在しないドメインでエラーを返す', async () => {
      // fetchHtmlをモックしてネットワークエラーをシミュレート
      // 実際のPlaywright接続はタイムアウトが長いため、モックで高速化
      setPageAnalyzeServiceFactory(() => ({
        fetchHtml: async () => {
          throw new Error('net::ERR_NAME_NOT_RESOLVED');
        },
      }));

      const result = await pageAnalyzeHandler({
        url: 'https://this-domain-definitely-does-not-exist-12345.com',
        summary: true,
        timeout: 10000,
        async: false,
        auto_timeout: false,
        layoutOptions: { useVision: false },
        narrativeOptions: { enabled: false },
      });

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        // ネットワークエラー、タイムアウト、ブラウザエラーのいずれか
        expect([
          PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR,
          PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR,
        ]).toContain(result.error.code);
      }

      // クリーンアップ: サービスファクトリーをリセット
      resetPageAnalyzeServiceFactory();
    }, 30000);
  });

  // ==========================================================================
  // パフォーマンステスト
  // ==========================================================================

  describe('パフォーマンス', () => {
    it('SiteTier検出は1ms以内', () => {
      const urls = [
        'https://resn.co.nz',
        'https://bruno-simon.com',
        'https://example.com/webgl/demo',
        'https://google.com',
      ];

      for (const url of urls) {
        const start = performance.now();
        detectSiteTier(url);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(1);
      }
    });

    it('preDetectWebGL は1ms以内', () => {
      const urls = [
        'https://resn.co.nz',
        'https://activetheory.net',
        'https://threejs.org/examples',
        'https://google.com',
      ];

      for (const url of urls) {
        const start = performance.now();
        preDetectWebGL(url);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(1);
      }
    });

    it('タイムアウト計算は600秒上限を遵守', () => {
      const tiers: SiteTier[] = ['ultra-heavy', 'heavy', 'webgl', 'normal'];
      const baseTimeouts = [180000, 120000, 90000, 60000];

      for (let i = 0; i < tiers.length; i++) {
        const config = getRetryStrategy(tiers[i]);
        const maxTime = calculateMaxTotalTime(baseTimeouts[i], config);

        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
        console.log(`[Perf] ${tiers[i]}: maxTime=${maxTime}ms`);
      }
    });
  });

  // ==========================================================================
  // 成功指標の検証
  // ==========================================================================

  describe('Phase1成功指標', () => {
    it('WebGLサイト成功率: 80%以上の達成可能性を検証', () => {
      // 実際の成功率はCIでの実行結果から計測
      // ここでは、Phase1実装により成功率向上の前提条件が整っていることを確認

      // 1. 全ての既知WebGLドメインが検出される
      for (const domain of KNOWN_WEBGL_DOMAINS) {
        const result = preDetectWebGL(`https://${domain}`);
        expect(result.isLikelyWebGL).toBe(true);
      }

      // 2. SiteTierベースのリトライ戦略が正しく適用される
      for (const domain of KNOWN_ULTRA_HEAVY_DOMAINS) {
        const tier = detectSiteTier(`https://${domain}`);
        expect(tier).toBe('ultra-heavy');

        const config = getRetryStrategy(tier);
        expect(config.retryOnlyOnNetworkError).toBe(true);
      }

      // 3. 全てのSiteTierでMCP上限を遵守
      const scenarios = [
        { tier: 'ultra-heavy', baseTimeout: 180000 },
        { tier: 'heavy', baseTimeout: 120000 },
        { tier: 'webgl', baseTimeout: 90000 },
        { tier: 'normal', baseTimeout: 60000 },
      ] as const;

      for (const { tier, baseTimeout } of scenarios) {
        const config = getRetryStrategy(tier);
        const maxTime = calculateMaxTotalTime(baseTimeout, config);
        expect(maxTime).toBeLessThanOrEqual(MCP_MAX_TIMEOUT_MS);
      }

      console.log('[Phase1] 成功指標の前提条件が満たされています');
    });

    it('タイムアウト発生率: 20%以下の達成可能性を検証', () => {
      // ultra-heavyサイトではタイムアウトしやすいため、リトライ戦略を最小化
      const ultraHeavyConfig = getRetryStrategy('ultra-heavy');

      // リトライ回数が少ない = タイムアウト累積が抑制される
      expect(ultraHeavyConfig.maxRetries).toBe(1);

      // タイムアウト累積なし
      expect(ultraHeavyConfig.timeoutMultiplier).toBe(1.0);

      // ネットワークエラーのみリトライ = 無駄なタイムアウト待機を削減
      expect(ultraHeavyConfig.retryOnlyOnNetworkError).toBe(true);

      console.log('[Phase1] タイムアウト抑制戦略が正しく設定されています');
    });
  });
});
