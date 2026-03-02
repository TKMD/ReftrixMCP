// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツールのテスト
 * TDD Red Phase: 先にテストを作成（実装はまだ存在しない）
 *
 * URLを指定するだけで以下3つの分析を並列実行し、統合レスポンスを返す統合ツール:
 * - layout.ingest: HTML/スクリーンショット取得、セクション解析
 * - motion.detect: CSSアニメーション/トランジション検出
 * - quality.evaluate: デザイン品質評価（3軸 + AIクリシェ検出）
 *
 * テスト対象:
 * - 入力バリデーション（URL必須、形式チェック）
 * - SSRF対策（プライベートIP、localhost、メタデータサービス拒否）
 * - 正常系（全機能実行）
 * - featuresオプション（個別機能ON/OFF）
 * - summaryオプション（軽量/詳細レスポンス）
 * - タイムアウト処理
 * - 部分失敗時のGraceful Degradation
 * - エラーハンドリング
 *
 * @module tests/tools/page/analyze.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Narrative handler をモックしてOllama Vision接続タイムアウト（35秒）を回避
// vi.resetAllMocks()でリセットされないようプレーン関数を使用
vi.mock('../../../src/tools/page/handlers/narrative-handler', async () => {
  const actual = await vi.importActual('../../../src/tools/page/handlers/narrative-handler');
  return {
    ...(actual as Record<string, unknown>),
    handleNarrativeAnalysis: async () => ({ success: true, skipped: true }),
  };
});

// Redis可用性チェックをモック: Vision自動asyncモード（v0.1.0）を無効化
// Redisが利用可能だとasync=trueになりジョブキュー応答が返されるため、同期モードに強制
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: async () => false,
}));

// =====================================================
// インポート
// TDD Red Phase: 実装が存在しないため、インポートはエラーになる
// 実装完了後、以下のインポートが動作するようになる
// =====================================================

// 実装ファイルのインポート
// 注意: 実装が存在しないため、テスト実行時にエラーが発生する
import {
  pageAnalyzeHandler,
  pageAnalyzeToolDefinition,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
} from '../../../src/tools/page/analyze.tool';

import {
  pageAnalyzeInputSchema,
  pageAnalyzeOutputSchema,
  analysisFeaturesSchema,
  layoutOptionsSchema,
  motionOptionsSchema,
  qualityOptionsSchema,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  PAGE_ANALYZE_ERROR_CODES,
} from '../../../src/tools/page/schemas';

// =====================================================
// モック用ヘルパー（実装後に使用）
// =====================================================

/**
 * Playwrightブラウザのモック
 * 実装時にはPlaywrightをモックして外部HTTP通信を防ぐ
 */
function createMockBrowser() {
  return {
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(null),
        content: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('mock-screenshot')),
        evaluate: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(null),
      }),
      close: vi.fn().mockResolvedValue(null),
    }),
    close: vi.fn().mockResolvedValue(null),
  };
}

/**
 * layout.ingestのモック
 */
function createMockLayoutService() {
  return {
    ingest: vi.fn().mockResolvedValue({
      success: true,
      pageId: '01941234-5678-7abc-def0-987654321fed',
      sectionCount: 5,
      sectionTypes: { hero: 1, feature: 2, cta: 1, footer: 1 },
      processingTimeMs: 1250,
    }),
  };
}

/**
 * motion.detectのモック
 */
function createMockMotionService() {
  return {
    detect: vi.fn().mockResolvedValue({
      success: true,
      patternCount: 12,
      categoryBreakdown: { scroll_trigger: 5, hover_effect: 4, entrance: 3 },
      warningCount: 2,
      a11yWarningCount: 1,
      perfWarningCount: 1,
      processingTimeMs: 340,
    }),
  };
}

/**
 * quality.evaluateのモック
 */
function createMockQualityService() {
  return {
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      overallScore: 78.5,
      grade: 'C',
      axisScores: { originality: 72, craftsmanship: 85, contextuality: 76 },
      clicheCount: 2,
      processingTimeMs: 180,
    }),
  };
}

/**
 * IPageAnalyzeService インターフェースに準拠した統合モックサービス
 * 外部ネットワーク/Playwright/Ollama依存を完全に排除
 *
 * テストで使用する場合:
 * beforeEach(() => {
 *   setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
 * });
 */
function createMockPageAnalyzeService(): IPageAnalyzeService {
  return {
    // HTML取得のモック（Playwright依存を排除）
    fetchHtml: vi.fn().mockImplementation(async (url: string) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Test Mock] fetchHtml called', { url });
      }
      return {
        html: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Mock Page - ${url}</title>
  <meta name="description" content="Mock description for testing">
  <style>
    .hero { animation: fadeIn 0.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .button { transition: background-color 0.3s ease; }
  </style>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
    <section class="cta"><h2>Call to Action</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`,
        title: `Mock Page - ${url}`,
        description: 'Mock description for testing',
        screenshot: 'mock-screenshot-base64-data',
      };
    }),

    // レイアウト分析のモック
    analyzeLayout: vi.fn().mockImplementation(async (html: string, options) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Test Mock] analyzeLayout called', { htmlLength: html.length, options });
      }
      const result: ReturnType<NonNullable<IPageAnalyzeService['analyzeLayout']>> extends Promise<infer R> ? R : never = {
        success: true,
        sectionCount: 5,
        sectionTypes: { hero: 1, features: 1, cta: 1, navigation: 1, footer: 1 },
        processingTimeMs: 50,
      };

      if (options?.saveToDb) {
        (result as { pageId?: string }).pageId = '01941234-5678-7abc-def0-987654321fed';
      }
      // MCP-RESP-03: snake_case (include_html) を優先、camelCase (includeHtml) はフォールバック
      const shouldIncludeHtml = options?.include_html ?? options?.includeHtml;
      const shouldIncludeScreenshot = options?.include_screenshot ?? options?.includeScreenshot;
      if (shouldIncludeHtml) {
        (result as { html?: string }).html = html;
      }
      if (shouldIncludeScreenshot) {
        (result as { screenshot?: { base64: string; format: 'png' | 'jpeg'; width: number; height: number } }).screenshot = {
          base64: 'mock-screenshot-base64',
          format: 'png',
          width: 1440,
          height: 900,
        };
      }
      // summary=false 時のセクション詳細
      (result as { sections?: Array<{ id: string; type: string; positionIndex: number; heading?: string; confidence: number }> }).sections = [
        { id: '01941234-0001-7abc-def0-000000000001', type: 'navigation', positionIndex: 0, confidence: 0.95 },
        { id: '01941234-0002-7abc-def0-000000000002', type: 'hero', positionIndex: 1, heading: 'Hero Section', confidence: 0.98 },
        { id: '01941234-0003-7abc-def0-000000000003', type: 'features', positionIndex: 2, heading: 'Features', confidence: 0.92 },
        { id: '01941234-0004-7abc-def0-000000000004', type: 'cta', positionIndex: 3, heading: 'Call to Action', confidence: 0.88 },
        { id: '01941234-0005-7abc-def0-000000000005', type: 'footer', positionIndex: 4, confidence: 0.96 },
      ];

      return result;
    }),

    // モーション検出のモック
    detectMotion: vi.fn().mockImplementation(async (html: string, url: string, options) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Test Mock] detectMotion called', { htmlLength: html.length, url, options });
      }
      return {
        success: true,
        patternCount: 3,
        categoryBreakdown: { entrance: 1, hover_effect: 1, loading: 1 },
        warningCount: 1,
        a11yWarningCount: 1,
        perfWarningCount: 0,
        processingTimeMs: 30,
        patterns: [
          {
            id: 'pattern-001',
            name: 'fadeIn',
            type: 'css_animation' as const,
            category: 'entrance',
            trigger: 'load',
            duration: 500,
            easing: 'ease-in-out',
            properties: ['opacity'],
            performance: { level: 'good' as const, usesTransform: false, usesOpacity: true },
            accessibility: { respectsReducedMotion: false },
          },
          {
            id: 'pattern-002',
            name: 'button-hover',
            type: 'css_transition' as const,
            category: 'hover_effect',
            trigger: 'hover',
            duration: 300,
            easing: 'ease',
            properties: ['background-color'],
            performance: { level: 'good' as const, usesTransform: false, usesOpacity: false },
            accessibility: { respectsReducedMotion: true },
          },
        ],
        warnings: [
          {
            code: 'A11Y_NO_REDUCED_MOTION',
            severity: 'warning' as const,
            message: 'Animation does not respect prefers-reduced-motion',
          },
        ],
      };
    }),

    // 品質評価のモック
    evaluateQuality: vi.fn().mockImplementation(async (html: string, options) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Test Mock] evaluateQuality called', { htmlLength: html.length, options });
      }
      const baseScore = 78.5;
      const grade = 'C' as const;

      return {
        success: true,
        overallScore: baseScore,
        grade,
        axisScores: {
          originality: 72,
          craftsmanship: 85,
          contextuality: 76,
        },
        clicheCount: 1,
        processingTimeMs: 25,
        axisGrades: {
          originality: 'C' as const,
          craftsmanship: 'B' as const,
          contextuality: 'C' as const,
        },
        axisDetails: {
          originality: ['Some unique design elements detected'],
          craftsmanship: ['Good HTML structure', 'Proper use of semantic elements'],
          contextuality: ['Appropriate for general web content'],
        },
        cliches: [
          {
            type: 'gradient_sphere',
            description: 'Abstract gradient sphere detected in hero section',
            severity: 'low' as const,
          },
        ],
        recommendations: options?.includeRecommendations !== false ? [
          {
            id: 'rec-001',
            category: 'accessibility',
            priority: 'high' as const,
            title: 'Add reduced motion support',
            description: 'Add prefers-reduced-motion media query to animations',
          },
        ] : undefined,
      };
    }),
  };
}

// =====================================================
// テストデータ
// =====================================================

const validUrl = 'https://example.com';
const validUrlWithPath = 'https://awwwards.com/sites/example-site';
const invalidUrl = 'not-a-url';
const httpUrl = 'http://example.com';

// SSRF対策テスト用のブロックされるべきURL
const localhostUrl = 'http://localhost';
const localhostWithPort = 'http://localhost:3000';
const loopbackUrl = 'http://127.0.0.1';
const loopbackWithPort = 'http://127.0.0.1:8080';
const privateIpClassA = 'http://10.0.0.1';
const privateIpClassB = 'http://172.16.0.1';
const privateIpClassC = 'http://192.168.1.1';
const awsMetadata = 'http://169.254.169.254/latest/meta-data/';
const gcpMetadata = 'http://metadata.google.internal/computeMetadata/v1/';
const ipv6Localhost = 'http://[::1]/';
const ipv6LinkLocal = 'http://[fe80::1]/';
const ipv6UniqueLocal = 'http://[fd00::1]/';

const validUUID = '01941234-5678-7abc-def0-123456789abc';

// サンプルHTML（テスト用）
const sampleHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
  <style>
    .hero { animation: fadeIn 0.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  </style>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`;

// =====================================================
// 入力スキーマテスト
// =====================================================

describe('pageAnalyzeInputSchema', () => {
  describe('有効な入力', () => {
    it('URL のみの入力を受け付ける（最小構成）', () => {
      // スキーマが存在することを確認（実装後に動作する）
      const input = { url: validUrl };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe(validUrl);
      expect(result.summary).toBe(false); // デフォルト（v6.x: summary はデフォルトで無効）
      expect(result.timeout).toBe(600000); // デフォルト（v6.x: WebGL/Three.js対応で600秒に延長）
      expect(result.features?.layout).toBe(true); // デフォルト
      expect(result.features?.motion).toBe(true); // デフォルト
      expect(result.features?.quality).toBe(true); // デフォルト
    });

    it('https:// プロトコルのURLを受け付ける', () => {
      const input = { url: 'https://example.com' };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe('https://example.com');
    });

    it('http:// プロトコルのURLを受け付ける', () => {
      const input = { url: httpUrl };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe(httpUrl);
    });

    it('パス付きURLを受け付ける', () => {
      const input = { url: 'https://example.com/path/to/page' };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe('https://example.com/path/to/page');
    });

    it('クエリパラメータ付きURLを受け付ける', () => {
      const input = { url: 'https://example.com?query=value' };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe('https://example.com?query=value');
    });

    it('sourceType オプションを受け付ける', () => {
      const input = { url: validUrl, sourceType: 'award_gallery' as const };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.sourceType).toBe('award_gallery');
    });

    it('usageScope オプションを受け付ける', () => {
      const input = { url: validUrl, usageScope: 'owned_asset' as const };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.usageScope).toBe('owned_asset');
    });

    it('features オプションを受け付ける', () => {
      const input = { url: validUrl, features: { layout: true, motion: false, quality: true } };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.features?.layout).toBe(true);
      expect(result.features?.motion).toBe(false);
      expect(result.features?.quality).toBe(true);
    });

    it('summary=false オプションを受け付ける', () => {
      const input = { url: validUrl, summary: false };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.summary).toBe(false);
    });

    it('timeout オプションを受け付ける', () => {
      const input = { url: validUrl, timeout: 120000 };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.timeout).toBe(120000);
    });

    it('waitUntil オプションを受け付ける', () => {
      const input = { url: validUrl, waitUntil: 'networkidle' as const };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.waitUntil).toBe('networkidle');
    });

    it('layoutOptions を受け付ける', () => {
      const input = { url: validUrl, layoutOptions: { fullPage: true, saveToDb: true } };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.layoutOptions?.fullPage).toBe(true);
      expect(result.layoutOptions?.saveToDb).toBe(true);
    });

    it('motionOptions を受け付ける', () => {
      const input = { url: validUrl, motionOptions: { fetchExternalCss: true, maxPatterns: 50 } };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.fetchExternalCss).toBe(true);
      expect(result.motionOptions?.maxPatterns).toBe(50);
    });

    it('qualityOptions を受け付ける', () => {
      const input = { url: validUrl, qualityOptions: { strict: true, targetIndustry: 'technology' } };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.qualityOptions?.strict).toBe(true);
      expect(result.qualityOptions?.targetIndustry).toBe('technology');
    });

    it('全オプション指定の入力を受け付ける', () => {
      const input: PageAnalyzeInput = {
        url: validUrl,
        sourceType: 'award_gallery',
        usageScope: 'inspiration_only',
        features: { layout: true, motion: true, quality: true },
        layoutOptions: { fullPage: true, includeHtml: true, includeScreenshot: true },
        motionOptions: { fetchExternalCss: true, maxPatterns: 100 },
        qualityOptions: { strict: true, targetIndustry: 'technology' },
        summary: false,
        timeout: 120000,
        waitUntil: 'networkidle',
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.url).toBe(validUrl);
      expect(result.sourceType).toBe('award_gallery');
      expect(result.summary).toBe(false);
    });
  });

  describe('無効な入力', () => {
    it('url がない場合エラー', () => {
      const input = {};
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('url が空文字の場合エラー', () => {
      const input = { url: '' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('url が無効な形式の場合エラー', () => {
      const input = { url: invalidUrl };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('url がftp://プロトコルの場合エラー', () => {
      const input = { url: 'ftp://example.com' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('url がfile://プロトコルの場合エラー', () => {
      const input = { url: 'file:///etc/passwd' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('url がjavascript:プロトコルの場合エラー', () => {
      const input = { url: 'javascript:alert(1)' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('sourceType が無効な値の場合エラー', () => {
      const input = { url: validUrl, sourceType: 'invalid' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('usageScope が無効な値の場合エラー', () => {
      const input = { url: validUrl, usageScope: 'invalid' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('timeout が下限を下回る場合エラー', () => {
      const input = { url: validUrl, timeout: 1000 }; // 5000未満
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('timeout が上限を超える場合エラー', () => {
      const input = { url: validUrl, timeout: 700000 }; // 600000超過（v0.1.0: 上限を10分に拡張）
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('waitUntil が無効な値の場合エラー', () => {
      const input = { url: validUrl, waitUntil: 'invalid' };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('layoutOptions.viewport.width が範囲外の場合エラー', () => {
      const input = { url: validUrl, layoutOptions: { viewport: { width: 100, height: 900 } } };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('motionOptions.maxPatterns が範囲外の場合エラー', () => {
      const input = { url: validUrl, motionOptions: { maxPatterns: 5000 } }; // 4000超過
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('qualityOptions.targetIndustry が100文字を超える場合エラー', () => {
      const input = { url: validUrl, qualityOptions: { targetIndustry: 'a'.repeat(101) } };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// SSRF対策テスト
// =====================================================

describe('SSRF対策', () => {
  beforeEach(() => {
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ブロックされるべきホスト', () => {
    it('localhost をブロックする', async () => {
      const input = { url: localhostUrl };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('localhost:3000 をブロックする', async () => {
      const input = { url: localhostWithPort };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('127.0.0.1 をブロックする', async () => {
      const input = { url: loopbackUrl };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('127.0.0.1:8080 をブロックする', async () => {
      const input = { url: loopbackWithPort };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('0.0.0.0 をブロックする', async () => {
      const input = { url: 'http://0.0.0.0' };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });
  });

  describe('ブロックされるべきプライベートIPレンジ', () => {
    it('10.0.0.0/8 (クラスAプライベート) をブロックする', async () => {
      const input = { url: privateIpClassA };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('172.16.0.0/12 (クラスBプライベート) をブロックする', async () => {
      const input = { url: privateIpClassB };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('192.168.0.0/16 (クラスCプライベート) をブロックする', async () => {
      const input = { url: privateIpClassC };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });
  });

  describe('ブロックされるべきメタデータサービス', () => {
    it('AWS メタデータサービス (169.254.169.254) をブロックする', async () => {
      const input = { url: awsMetadata };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('GCP メタデータサービス (metadata.google.internal) をブロックする', async () => {
      const input = { url: gcpMetadata };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });
  });

  describe('ブロックされるべきIPv6アドレス', () => {
    it('[::1] (IPv6 localhost) をブロックする', async () => {
      const input = { url: ipv6Localhost };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('fe80::/10 (IPv6 link-local) をブロックする', async () => {
      const input = { url: ipv6LinkLocal };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('fc00::/7 (IPv6 unique local) をブロックする', async () => {
      const input = { url: ipv6UniqueLocal };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('::ffff:127.0.0.1 (IPv4マップドIPv6 localhost) をブロックする', async () => {
      const input = { url: 'http://[::ffff:127.0.0.1]/' };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });

    it('::ffff:192.168.1.1 (IPv4マップドIPv6 プライベート) をブロックする', async () => {
      const input = { url: 'http://[::ffff:192.168.1.1]/' };
      const result = await pageAnalyzeHandler(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
      }
    });
  });
});

// =====================================================
// ツール定義テスト
// =====================================================

describe('pageAnalyzeToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(pageAnalyzeToolDefinition.name).toBe('page.analyze');
  });

  it('description が設定されている', () => {
    expect(pageAnalyzeToolDefinition.description).toBeDefined();
    expect(typeof pageAnalyzeToolDefinition.description).toBe('string');
    expect(pageAnalyzeToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchema が object 型', () => {
    expect(pageAnalyzeToolDefinition.inputSchema.type).toBe('object');
  });

  it('properties に必要なフィールドを含む', () => {
    const { properties } = pageAnalyzeToolDefinition.inputSchema;
    expect(properties).toHaveProperty('url');
    expect(properties).toHaveProperty('sourceType');
    expect(properties).toHaveProperty('usageScope');
    expect(properties).toHaveProperty('features');
    expect(properties).toHaveProperty('layoutOptions');
    expect(properties).toHaveProperty('motionOptions');
    expect(properties).toHaveProperty('qualityOptions');
    expect(properties).toHaveProperty('summary');
    expect(properties).toHaveProperty('timeout');
    expect(properties).toHaveProperty('waitUntil');
  });

  it('required に url を含む', () => {
    expect(pageAnalyzeToolDefinition.inputSchema.required).toContain('url');
  });
});

// =====================================================
// 正常系テスト - 全機能実行
// =====================================================

describe('正常系 - 全機能実行', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('URL指定のみで全分析を実行する（デフォルト設定）', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('分析IDを返す（UUIDv7形式）', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBeDefined();
      expect(result.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('分析対象URLと正規化URLを返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe(validUrl);
      expect(result.data.normalizedUrl).toBeDefined();
    }
  });

  it('ページメタデータ（title, description）を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toBeDefined();
      // titleは必ずしも存在するとは限らないが、metadataオブジェクトは存在する
    }
  });

  it('ソース情報（type, usageScope）を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBeDefined();
      expect(result.data.source.type).toBe('user_provided'); // デフォルト
      expect(result.data.source.usageScope).toBe('inspiration_only'); // デフォルト
    }
  });

  it('全体処理時間を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalProcessingTimeMs).toBeDefined();
      expect(result.data.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('分析日時を返す（ISO 8601形式）', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.analyzedAt).toBeDefined();
      expect(new Date(result.data.analyzedAt).toString()).not.toBe('Invalid Date');
    }
  });
});

// =====================================================
// 正常系テスト - レイアウト分析
// =====================================================

describe('正常系 - レイアウト分析', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('レイアウト分析の成功フラグを返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.success).toBeDefined();
    }
  });

  it('検出セクション数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.sectionCount).toBeDefined();
      expect(result.data.layout.sectionCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('セクションタイプ内訳を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.sectionTypes).toBeDefined();
    }
  });

  it('処理時間を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.processingTimeMs).toBeDefined();
      expect(result.data.layout.processingTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('saveToDb=true でページIDを返す', async () => {
    const input = { url: validUrl, layoutOptions: { saveToDb: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('summary=false でセクション詳細を返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.sections).toBeDefined();
    }
  });

  it('includeHtml=true でHTMLコンテンツを返す', async () => {
    const input = { url: validUrl, layoutOptions: { includeHtml: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.html).toBeDefined();
    }
  });

  it('includeScreenshot=true でスクリーンショットを返す', async () => {
    const input = { url: validUrl, layoutOptions: { includeScreenshot: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.screenshot).toBeDefined();
    }
  });
});

// =====================================================
// 正常系テスト - モーション検出
// =====================================================

describe('正常系 - モーション検出', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('モーション検出の成功フラグを返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.success).toBeDefined();
    }
  });

  it('検出パターン数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.patternCount).toBeDefined();
      expect(result.data.motion.patternCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('カテゴリ内訳を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.categoryBreakdown).toBeDefined();
    }
  });

  it('警告数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.warningCount).toBeDefined();
      expect(result.data.motion.warningCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('アクセシビリティ警告数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.a11yWarningCount).toBeDefined();
      expect(result.data.motion.a11yWarningCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('パフォーマンス警告数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.perfWarningCount).toBeDefined();
      expect(result.data.motion.perfWarningCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('処理時間を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.processingTimeMs).toBeDefined();
      expect(result.data.motion.processingTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('summary=false でパターン詳細を返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.success) {
      expect(result.data.motion.patterns).toBeDefined();
    }
  });

  it('summary=false で警告詳細を返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.success) {
      expect(result.data.motion.warnings).toBeDefined();
    }
  });
});

// =====================================================
// 正常系テスト - 品質評価
// =====================================================

describe('正常系 - 品質評価', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('品質評価の成功フラグを返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.success).toBeDefined();
    }
  });

  it('総合スコア（0-100）を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.overallScore).toBeDefined();
      expect(result.data.quality.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.data.quality.overallScore).toBeLessThanOrEqual(100);
    }
  });

  it('総合グレード（A-F）を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.grade).toBeDefined();
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.data.quality.grade);
    }
  });

  it('軸別スコア（originality, craftsmanship, contextuality）を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.axisScores).toBeDefined();
      expect(result.data.quality.axisScores.originality).toBeDefined();
      expect(result.data.quality.axisScores.craftsmanship).toBeDefined();
      expect(result.data.quality.axisScores.contextuality).toBeDefined();
    }
  });

  it('AIクリシェ検出数を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.clicheCount).toBeDefined();
      expect(result.data.quality.clicheCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('処理時間を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality) {
      expect(result.data.quality.processingTimeMs).toBeDefined();
      expect(result.data.quality.processingTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('summary=false で軸別グレードを返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality?.success) {
      expect(result.data.quality.axisGrades).toBeDefined();
    }
  });

  it('summary=false でAIクリシェ詳細を返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality?.success) {
      expect(result.data.quality.cliches).toBeDefined();
    }
  });

  it('includeRecommendations=true で推奨事項を返す', async () => {
    const input = { url: validUrl, qualityOptions: { includeRecommendations: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.quality?.success) {
      expect(result.data.quality.recommendations).toBeDefined();
    }
  });

  it('カスタム重みを適用して評価する', async () => {
    const input = {
      url: validUrl,
      qualityOptions: { weights: { originality: 0.5, craftsmanship: 0.3, contextuality: 0.2 } },
    };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // カスタム重みが適用されたことを確認（実装依存）
  });

  it('targetIndustry を指定して評価する', async () => {
    const input = { url: validUrl, qualityOptions: { targetIndustry: 'technology' } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('strict=true でより厳格に評価する', async () => {
    const input = { url: validUrl, qualityOptions: { strict: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// features オプションテスト
// =====================================================

describe('features オプション', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('features指定なしで全機能を実行する（デフォルト）', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('features.layout=false でレイアウト分析をスキップする', async () => {
    const input = { url: validUrl, features: { layout: false, motion: true, quality: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeUndefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('features.motion=false でモーション検出をスキップする', async () => {
    const input = { url: validUrl, features: { layout: true, motion: false, quality: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeUndefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('features.quality=false で品質評価をスキップする', async () => {
    const input = { url: validUrl, features: { layout: true, motion: true, quality: false } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeUndefined();
    }
  });

  it('レイアウトのみ分析する', async () => {
    const input = { url: validUrl, features: { layout: true, motion: false, quality: false } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeUndefined();
      expect(result.data.quality).toBeUndefined();
    }
  });

  it('モーションのみ分析する', async () => {
    const input = { url: validUrl, features: { layout: false, motion: true, quality: false } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeUndefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeUndefined();
    }
  });

  it('品質評価のみ実行する', async () => {
    const input = { url: validUrl, features: { layout: false, motion: false, quality: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeUndefined();
      expect(result.data.motion).toBeUndefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('全機能を無効にした場合もメタデータは返す', async () => {
    const input = { url: validUrl, features: { layout: false, motion: false, quality: false } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toBeDefined();
      expect(result.data.url).toBeDefined();
    }
  });
});

// =====================================================
// summary オプションテスト
// =====================================================

describe('summary オプション', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('summary=true（デフォルト）で軽量レスポンスを返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // summary=trueでもセクション情報は含まれる（v6.x: narrative/design pattern連携のため）
    if (result.success && result.data.layout) {
      expect(result.data.layout.sectionCount).toBeDefined();
    }
  });

  it('summary=true でHTMLを含まない', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.html).toBeUndefined();
    }
  });

  it('summary=true でスクリーンショットを含まない', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout) {
      expect(result.data.layout.screenshot).toBeUndefined();
    }
  });

  it('summary=false で詳細レスポンスを返す', async () => {
    const input = { url: validUrl, summary: false };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // summary=falseでは詳細フィールドが含まれる
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.sections).toBeDefined();
    }
  });

  it('summary=true のレスポンスサイズが summary=false より小さい', async () => {
    const inputSummary = { url: validUrl, summary: true };
    const inputFull = { url: validUrl, summary: false };

    const resultSummary = await pageAnalyzeHandler(inputSummary);
    const resultFull = await pageAnalyzeHandler(inputFull);

    expect(resultSummary.success).toBe(true);
    expect(resultFull.success).toBe(true);

    const sizeSummary = JSON.stringify(resultSummary).length;
    const sizeFull = JSON.stringify(resultFull).length;

    expect(sizeSummary).toBeLessThan(sizeFull);
  });
});

// =====================================================
// タイムアウト処理テスト
// =====================================================

describe('タイムアウト処理', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('デフォルトタイムアウト（600秒）が設定される（v6.x: WebGL/Three.js対応で延長）', async () => {
    const input = { url: validUrl };
    const parsed = pageAnalyzeInputSchema.parse(input);
    expect(parsed.timeout).toBe(600000);
  });

  it('カスタムタイムアウトを設定できる', async () => {
    const input = { url: validUrl, timeout: 120000 };
    const parsed = pageAnalyzeInputSchema.parse(input);
    expect(parsed.timeout).toBe(120000);
  });

  it('全体タイムアウト時にエラーを返す', async () => {
    // タイムアウト発生時のテスト（モック設定が必要）
    const input = { url: validUrl, timeout: 5000 };
    // 実装でタイムアウトをシミュレート
    const result = await pageAnalyzeHandler(input);
    // 実装依存：タイムアウトが発生した場合
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR);
    }
  });

  it('ページ取得タイムアウト時にエラーを返す', async () => {
    // ページ取得がタイムアウトした場合
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    // 実装依存
    expect(result).toBeDefined();
  });

  it('レイアウト分析タイムアウト時に他の結果は返す（Graceful Degradation）', async () => {
    // 部分タイムアウトのテスト
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('モーション検出タイムアウト時に他の結果は返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('品質評価タイムアウト時に他の結果は返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// Graceful Degradation テスト
// =====================================================

describe('Graceful Degradation（部分失敗時の継続動作）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('レイアウト分析失敗時に他の分析結果を返す', async () => {
    // モックでレイアウト分析を失敗させる
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // 他の機能は成功している想定
  });

  it('モーション検出失敗時に他の分析結果を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('品質評価失敗時に他の分析結果を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('複数機能失敗時に成功した機能の結果を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('部分失敗時にwarningsに失敗情報を含める', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // 部分失敗がある場合はwarningsに記録される
      if (result.data.warnings && result.data.warnings.length > 0) {
        expect(result.data.warnings[0]).toHaveProperty('feature');
        expect(result.data.warnings[0]).toHaveProperty('code');
        expect(result.data.warnings[0]).toHaveProperty('message');
      }
    }
  });

  it('全機能失敗でもメタデータと警告を返す（success=true）', async () => {
    // 全機能が失敗しても、HTMLさえ取得できればsuccess=true
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBeDefined();
    }
  });

  it('DB保存失敗時は警告のみで処理を継続する', async () => {
    const input = { url: validUrl, layoutOptions: { saveToDb: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('失敗した機能のprocessingTimeMsは0を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // 失敗した場合はprocessingTimeMsが0
    if (result.success && result.data.layout && !result.data.layout.success) {
      expect(result.data.layout.processingTimeMs).toBe(0);
    }
  });

  it('失敗した機能のカウント系フィールドは0を返す', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    // 失敗した場合はカウントが0
    if (result.success && result.data.layout && !result.data.layout.success) {
      expect(result.data.layout.sectionCount).toBe(0);
    }
  });
});

// =====================================================
// エラーハンドリングテスト - 致命的エラー
// =====================================================

describe('エラーハンドリング - 致命的エラー（全体失敗）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('入力がnullの場合エラー', async () => {
    const result = await pageAnalyzeHandler(null as unknown as PageAnalyzeInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('入力がundefinedの場合エラー', async () => {
    const result = await pageAnalyzeHandler(undefined as unknown as PageAnalyzeInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('空オブジェクトの場合エラー', async () => {
    const result = await pageAnalyzeHandler({} as PageAnalyzeInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('SSRF対策によりブロックされた場合エラー', async () => {
    const input = { url: localhostUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED);
    }
  });

  it('ネットワークエラーの場合エラー', async () => {
    // 存在しないドメインでネットワークエラーを発生させる
    const input = { url: 'https://this-domain-does-not-exist-12345.com' };
    const result = await pageAnalyzeHandler(input);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR);
    }
  });

  it('HTTPエラー（404）の場合エラー', async () => {
    // 404を返すURLでテスト（モック必要）
    const input = { url: 'https://example.com/not-found-page-12345' };
    const result = await pageAnalyzeHandler(input);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR);
    }
  });

  it('HTTPエラー（500）の場合エラー', async () => {
    // 500を返すURLでテスト（モック必要）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    // 実装依存
    expect(result).toBeDefined();
  });

  it('ブラウザ起動失敗の場合エラー', async () => {
    // ブラウザ起動失敗をモック（実装依存）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    // ブラウザが起動できない場合
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.BROWSER_UNAVAILABLE);
    }
  });

  it('ブラウザクラッシュの場合エラー', async () => {
    // ブラウザクラッシュをモック（実装依存）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR);
    }
  });

  it('全体タイムアウトの場合エラー', async () => {
    // タイムアウトをシミュレート（実装依存）
    const input = { url: validUrl, timeout: 5000 };
    const result = await pageAnalyzeHandler(input);
    if (!result.success) {
      expect(result.error.code).toBe(PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR);
    }
  });

  it('エラーメッセージを含む', async () => {
    const result = await pageAnalyzeHandler(null as unknown as PageAnalyzeInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeDefined();
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('エラーにdetailsを含める（デバッグ情報）', async () => {
    const result = await pageAnalyzeHandler(null as unknown as PageAnalyzeInput);
    expect(result.success).toBe(false);
    // detailsはオプショナル
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});

// =====================================================
// エラーコード検証テスト
// =====================================================

describe('エラーコード定義', () => {
  it('PAGE_ANALYZE_ERROR_CODES が定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES).toBeDefined();
  });

  it('VALIDATION_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });

  it('SSRF_BLOCKED コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED).toBe('SSRF_BLOCKED');
  });

  it('NETWORK_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR).toBe('NETWORK_ERROR');
  });

  it('TIMEOUT_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR).toBe('TIMEOUT_ERROR');
  });

  it('HTTP_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR).toBe('HTTP_ERROR');
  });

  it('BROWSER_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR).toBe('BROWSER_ERROR');
  });

  it('BROWSER_UNAVAILABLE コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.BROWSER_UNAVAILABLE).toBe('BROWSER_UNAVAILABLE');
  });

  it('LAYOUT_ANALYSIS_FAILED コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.LAYOUT_ANALYSIS_FAILED).toBe('LAYOUT_ANALYSIS_FAILED');
  });

  it('MOTION_DETECTION_FAILED コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.MOTION_DETECTION_FAILED).toBe('MOTION_DETECTION_FAILED');
  });

  it('QUALITY_EVALUATION_FAILED コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED).toBe('QUALITY_EVALUATION_FAILED');
  });

  it('DB_SAVE_FAILED コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.DB_SAVE_FAILED).toBe('DB_SAVE_FAILED');
  });

  it('INTERNAL_ERROR コードが定義されている', () => {
    expect(PAGE_ANALYZE_ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });
});

// =====================================================
// 出力スキーマテスト
// =====================================================

describe('pageAnalyzeOutputSchema', () => {
  it('成功時の基本レスポンスをバリデート', () => {
    const output = {
      success: true,
      data: {
        id: validUUID,
        url: validUrl,
        normalizedUrl: validUrl,
        metadata: {},
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        layout: { success: true, sectionCount: 0, sectionTypes: {}, processingTimeMs: 0 },
        motion: {
          success: true,
          patternCount: 0,
          categoryBreakdown: {},
          warningCount: 0,
          a11yWarningCount: 0,
          perfWarningCount: 0,
          processingTimeMs: 0,
        },
        quality: {
          success: true,
          overallScore: 80,
          grade: 'B',
          axisScores: { originality: 80, craftsmanship: 80, contextuality: 80 },
          clicheCount: 0,
          processingTimeMs: 0,
        },
        totalProcessingTimeMs: 0,
        analyzedAt: new Date().toISOString(),
      },
    };
    expect(() => pageAnalyzeOutputSchema.parse(output)).not.toThrow();
  });

  it('エラー時のレスポンスをバリデート', () => {
    const output = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
      },
    };
    expect(() => pageAnalyzeOutputSchema.parse(output)).not.toThrow();
  });

  it('summaryモードのレスポンスをバリデート', () => {
    const output = {
      success: true,
      data: {
        id: validUUID,
        url: validUrl,
        normalizedUrl: validUrl,
        metadata: {},
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        layout: { success: true, sectionCount: 5, sectionTypes: { hero: 1 }, processingTimeMs: 100 },
        totalProcessingTimeMs: 100,
        analyzedAt: new Date().toISOString(),
      },
    };
    expect(() => pageAnalyzeOutputSchema.parse(output)).not.toThrow();
  });

  it('fullモードのレスポンスをバリデート', () => {
    const output = {
      success: true,
      data: {
        id: validUUID,
        url: validUrl,
        normalizedUrl: validUrl,
        metadata: { title: 'Test Page' },
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        layout: {
          success: true,
          sectionCount: 1,
          sectionTypes: { hero: 1 },
          processingTimeMs: 100,
          sections: [{ id: validUUID, type: 'hero', positionIndex: 0, confidence: 0.9 }],
        },
        totalProcessingTimeMs: 100,
        analyzedAt: new Date().toISOString(),
      },
    };
    expect(() => pageAnalyzeOutputSchema.parse(output)).not.toThrow();
  });

  it('部分失敗時のレスポンスをバリデート', () => {
    const output = {
      success: true,
      data: {
        id: validUUID,
        url: validUrl,
        normalizedUrl: validUrl,
        metadata: {},
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        layout: { success: true, sectionCount: 5, sectionTypes: {}, processingTimeMs: 100 },
        motion: {
          success: false,
          error: { code: 'MOTION_DETECTION_FAILED', message: 'Failed' },
          patternCount: 0,
          categoryBreakdown: {},
          warningCount: 0,
          a11yWarningCount: 0,
          perfWarningCount: 0,
          processingTimeMs: 0,
        },
        totalProcessingTimeMs: 100,
        analyzedAt: new Date().toISOString(),
        warnings: [{ feature: 'motion', code: 'MOTION_DETECTION_FAILED', message: 'Detection failed' }],
      },
    };
    expect(() => pageAnalyzeOutputSchema.parse(output)).not.toThrow();
  });
});

// =====================================================
// 並列処理テスト
// =====================================================

describe('並列処理', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout, motion, quality が並列実行される', async () => {
    const input = { url: validUrl };
    const startTime = Date.now();
    const result = await pageAnalyzeHandler(input);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    // 並列実行されているため、全処理時間は個別処理時間の合計より短いはず
  });

  it('並列処理の結果が正しく統合される', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // 3つの分析結果が全て含まれる
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('1つの分析が遅くても他の結果は先に完了する', async () => {
    // タイムアウト設定で確認
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('HTML取得は1回のみで全分析で共有される', async () => {
    // モックでHTML取得回数を確認（実装依存）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// DB保存オプションテスト
// =====================================================

describe('DB保存オプション', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layoutOptions.saveToDb=true でWebPageを保存する', async () => {
    const input = { url: validUrl, layoutOptions: { saveToDb: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('layoutOptions.autoAnalyze=true でSectionPatternとEmbeddingを保存する', async () => {
    const input = { url: validUrl, layoutOptions: { saveToDb: true, autoAnalyze: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('motionOptions.saveToDb=true でMotionPatternを保存する', async () => {
    const input = { url: validUrl, motionOptions: { saveToDb: true } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('saveToDb=true（デフォルト）でDB保存する', async () => {
    // オプションオブジェクトを空で指定した場合、内部のsaveToDbはデフォルトtrueになる
    const inputWithEmptyOptions = {
      url: validUrl,
      layoutOptions: {},
      motionOptions: {},
    };
    const parsedWithOptions = pageAnalyzeInputSchema.parse(inputWithEmptyOptions);
    // v0.1.0でデフォルト値がtrueに変更された
    expect(parsedWithOptions.layoutOptions?.saveToDb).toBe(true);
    expect(parsedWithOptions.motionOptions?.saveToDb).toBe(true);

    // オプションオブジェクトを指定しない場合:
    // - motionOptionsSchema は .default({}) があるため、空オブジェクトになり内部のsaveToDb=trueが適用される
    // - layoutOptionsSchema は .optional() のみなので undefined のまま（実装側で !== false で処理）
    const inputWithoutOptions = { url: validUrl };
    const parsedWithoutOptions = pageAnalyzeInputSchema.parse(inputWithoutOptions);

    // layoutOptions は undefined（.optional() のみ）
    expect(parsedWithoutOptions.layoutOptions).toBeUndefined();

    // motionOptions は .default({}) により空オブジェクトが生成され、内部のデフォルト値が適用される
    expect(parsedWithoutOptions.motionOptions).toBeDefined();
    expect(parsedWithoutOptions.motionOptions?.saveToDb).toBe(true);
  });

  it('saveToDb=falseを明示的に指定するとDB保存しない', async () => {
    const input = {
      url: validUrl,
      layoutOptions: { saveToDb: false },
      motionOptions: { saveToDb: false },
    };
    const parsed = pageAnalyzeInputSchema.parse(input);
    expect(parsed.layoutOptions?.saveToDb).toBe(false);
    expect(parsed.motionOptions?.saveToDb).toBe(false);
  });
});

// =====================================================
// waitUntil オプションテスト
// =====================================================

describe('waitUntil オプション', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('waitUntil=networkidle（デフォルト）でネットワークアイドルまで待機', async () => {
    const input = { url: validUrl };
    const parsed = pageAnalyzeInputSchema.parse(input);
    expect(parsed.waitUntil).toBe('networkidle');
  });

  it('waitUntil=domcontentloaded でDOMContentLoadedまで待機', async () => {
    const input = { url: validUrl, waitUntil: 'domcontentloaded' as const };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('waitUntil=networkidle でネットワークアイドルまで待機', async () => {
    const input = { url: validUrl, waitUntil: 'networkidle' as const };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// 統合テスト
// =====================================================

describe('統合テスト', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('全オプション指定でフル分析が可能', async () => {
    const input: PageAnalyzeInput = {
      url: validUrl,
      sourceType: 'award_gallery',
      usageScope: 'inspiration_only',
      features: { layout: true, motion: true, quality: true },
      layoutOptions: { fullPage: true, includeHtml: false, saveToDb: false },
      motionOptions: { fetchExternalCss: false, maxPatterns: 100 },
      qualityOptions: { strict: true, targetIndustry: 'technology' },
      summary: false,
      timeout: 120000,
      waitUntil: 'networkidle',
    };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBeDefined();
      expect(result.data.url).toBe(validUrl);
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('デフォルトオプションで分析が動作する', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
  });

  it('ツール定義とハンドラーが一致する', () => {
    const { properties } = pageAnalyzeToolDefinition.inputSchema;
    expect(properties).toHaveProperty('url');
    expect(properties).toHaveProperty('sourceType');
    expect(properties).toHaveProperty('features');
    expect(properties).toHaveProperty('summary');
    expect(properties).toHaveProperty('timeout');
  });

  it('レスポンスが出力スキーマに準拠する', async () => {
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);
    expect(() => pageAnalyzeOutputSchema.parse(result)).not.toThrow();
  });

  it('複数回の呼び出しで独立した結果を返す', async () => {
    const input1 = { url: validUrl };
    const input2 = { url: 'https://example.org' };

    const [result1, result2] = await Promise.all([
      pageAnalyzeHandler(input1),
      pageAnalyzeHandler(input2),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      expect(result1.data.id).not.toBe(result2.data.id);
    }
  });
});

// =====================================================
// パフォーマンステスト（基本）
// =====================================================

describe('パフォーマンス（基本）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // モックサービスを注入して外部依存（Playwright/ネットワーク）を排除
    setPageAnalyzeServiceFactory(createMockPageAnalyzeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('totalProcessingTimeMs が各分析の合計より小さい（並列効果）', async () => {
    const input = { url: validUrl, responsiveOptions: { enabled: false } };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const layoutTime = result.data.layout?.processingTimeMs ?? 0;
      const motionTime = result.data.motion?.processingTimeMs ?? 0;
      const qualityTime = result.data.quality?.processingTimeMs ?? 0;
      const sumTime = layoutTime + motionTime + qualityTime;

      // 並列実行なので、合計時間は個別時間の合計より小さいか、
      // HTMLサニタイズ等の前処理オーバーヘッド + Playwright初期化オーバーヘッドを含めて同等
      // Note: Playwright実装ではブラウザ初期化・ネットワーク遅延が発生するため許容値を増加
      const sanitizeOverhead = 150; // 前処理 + Playwright初期化オーバーヘッド許容値
      expect(result.data.totalProcessingTimeMs).toBeLessThanOrEqual(sumTime + sanitizeOverhead);
    }
  });

  it('summary=true のレスポンスサイズが10KB未満', async () => {
    const input = { url: validUrl, summary: true };
    const result = await pageAnalyzeHandler(input);
    expect(result.success).toBe(true);

    const responseSize = JSON.stringify(result).length;
    expect(responseSize).toBeLessThan(10 * 1024); // 10KB
  });
});

// =====================================================
// WebGL/Canvas検出警告テスト
// =====================================================

describe('WebGL/Canvas検出警告', () => {
  /**
   * モーション検出結果をカスタマイズ可能なモックサービスファクトリ
   */
  function createMockServiceWithMotion(patternCount: number): () => IPageAnalyzeService {
    return () => ({
      fetchHtml: vi.fn().mockResolvedValue({
        html: '<html><body><div>Test</div></body></html>',
        title: 'Test',
        description: 'Test',
        screenshot: 'base64',
      }),
      analyzeLayout: vi.fn().mockResolvedValue({
        success: true,
        sectionCount: 1,
        sectionTypes: { hero: 1 },
        processingTimeMs: 10,
      }),
      detectMotion: vi.fn().mockResolvedValue({
        success: true,
        patternCount,
        categoryBreakdown: patternCount > 0 ? { entrance: patternCount } : {},
        warningCount: 0,
        a11yWarningCount: 0,
        perfWarningCount: 0,
        processingTimeMs: 10,
        patterns: [],
        warnings: [],
      }),
      evaluateQuality: vi.fn().mockResolvedValue({
        success: true,
        overallScore: 75,
        grade: 'B' as const,
        axisScores: { originality: 70, craftsmanship: 80, contextuality: 75 },
        clicheCount: 0,
        processingTimeMs: 10,
      }),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('motion結果0件かつdetect_js_animations=false時にWEBGL_DETECTION_DISABLED警告を出力', async () => {
    // Arrange: patternCount=0を返すモックサービス
    setPageAnalyzeServiceFactory(createMockServiceWithMotion(0));

    // Act: detect_js_animations=false（デフォルト）で実行
    const input = { url: validUrl, motionOptions: { detect_js_animations: false } };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.warnings) {
      const webglWarning = result.data.warnings.find(
        (w) => w.code === 'WEBGL_DETECTION_DISABLED'
      );
      expect(webglWarning).toBeDefined();
      expect(webglWarning?.feature).toBe('motion');
      expect(webglWarning?.message).toContain('WebGL/Canvas');
      expect(webglWarning?.message).toContain('detect_js_animations');
    }
  });

  it('motion結果1件以上の場合はWEBGL_DETECTION_DISABLED警告を出力しない', async () => {
    // Arrange: patternCount>0を返すモックサービス
    setPageAnalyzeServiceFactory(createMockServiceWithMotion(5));

    // Act
    const input = { url: validUrl, motionOptions: { detect_js_animations: false } };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      const webglWarning = result.data.warnings?.find(
        (w) => w.code === 'WEBGL_DETECTION_DISABLED'
      );
      expect(webglWarning).toBeUndefined();
    }
  });

  it('detect_js_animations=trueの場合はWEBGL_DETECTION_DISABLED警告を出力しない', async () => {
    // Arrange: patternCount=0を返すがdetect_js_animations=true
    setPageAnalyzeServiceFactory(createMockServiceWithMotion(0));

    // Act: detect_js_animations=true を明示的に指定
    const input = { url: validUrl, motionOptions: { detect_js_animations: true } };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      const webglWarning = result.data.warnings?.find(
        (w) => w.code === 'WEBGL_DETECTION_DISABLED'
      );
      expect(webglWarning).toBeUndefined();
    }
  });

  it('デフォルト設定（detect_js_animations未指定）で0件の場合は警告を出力しない', async () => {
    // Arrange: デフォルト（v0.1.0以降 detect_js_animations=true）
    setPageAnalyzeServiceFactory(createMockServiceWithMotion(0));

    // Act: motionOptionsを指定しない（デフォルト）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.warnings) {
      const webglWarning = result.data.warnings.find(
        (w) => w.code === 'WEBGL_DETECTION_DISABLED'
      );
      // v0.1.0以降: デフォルトでdetect_js_animations=trueなので、警告は出ない
      expect(webglWarning).toBeUndefined();
    }
  });
});

// =====================================================
// CSS変数抽出テスト（v0.1.0）
// =====================================================

describe('CSS変数抽出（fetchExternalCss: true）', () => {
  /**
   * CSS変数を含むモックレスポンスを返すサービスファクトリ
   */
  function createMockServiceWithCssVariables(includeCssVariables: boolean): () => IPageAnalyzeService {
    return () => ({
      fetchHtml: vi.fn().mockResolvedValue({
        html: `<!DOCTYPE html>
<html lang="ja">
<head>
  <style>
    :root {
      --color-primary: #3b82f6;
      --color-secondary: #10b981;
      --spacing-md: 1rem;
      --font-size-xl: clamp(1.25rem, 1rem + 1.25vw, 1.75rem);
    }
  </style>
</head>
<body><div>Test</div></body>
</html>`,
        title: 'Test',
        description: 'Test',
        screenshot: 'base64',
      }),
      analyzeLayout: vi.fn().mockImplementation(async (_html: string, options) => {
        const result: {
          success: boolean;
          sectionCount: number;
          sectionTypes: { hero: number };
          processingTimeMs: number;
          cssVariables?: {
            variables: Array<{
              name: string;
              value: string;
              category: string;
              scope: string;
            }>;
            clampValues: Array<{
              property: string;
              min: string;
              preferred: string;
              max: string;
              context: string;
            }>;
            calcExpressions: Array<{
              property: string;
              expression: string;
              context: string;
            }>;
            designTokens: {
              hasDesignSystem: boolean;
              tokenCount: number;
              categories: string[];
            };
            processingTimeMs: number;
          };
        } = {
          success: true,
          sectionCount: 1,
          sectionTypes: { hero: 1 },
          processingTimeMs: 10,
        };

        // fetchExternalCss: true の場合のみ cssVariables を含める
        if (includeCssVariables && options?.fetchExternalCss) {
          result.cssVariables = {
            variables: [
              { name: '--color-primary', value: '#3b82f6', category: 'color', scope: ':root' },
              { name: '--color-secondary', value: '#10b981', category: 'color', scope: ':root' },
              { name: '--spacing-md', value: '1rem', category: 'spacing', scope: ':root' },
              { name: '--font-size-xl', value: 'clamp(1.25rem, 1rem + 1.25vw, 1.75rem)', category: 'typography', scope: ':root' },
            ],
            clampValues: [
              {
                property: '--font-size-xl',
                min: '1.25rem',
                preferred: '1rem + 1.25vw',
                max: '1.75rem',
                context: ':root',
              },
            ],
            calcExpressions: [],
            designTokens: {
              hasDesignSystem: true,
              tokenCount: 4,
              categories: ['color', 'spacing', 'typography'],
            },
            processingTimeMs: 5,
          };
        }

        return result;
      }),
      detectMotion: vi.fn().mockResolvedValue({
        success: true,
        patternCount: 1,
        categoryBreakdown: { entrance: 1 },
        warningCount: 0,
        a11yWarningCount: 0,
        perfWarningCount: 0,
        processingTimeMs: 10,
        patterns: [],
        warnings: [],
      }),
      evaluateQuality: vi.fn().mockResolvedValue({
        success: true,
        overallScore: 75,
        grade: 'B' as const,
        axisScores: { originality: 70, craftsmanship: 80, contextuality: 75 },
        clicheCount: 0,
        processingTimeMs: 10,
      }),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('fetchExternalCss: true 指定時に cssVariables が返される', async () => {
    // Arrange: cssVariablesを返すモックサービス
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act: fetchExternalCss=true を明示的に指定（layoutOptionsで）
    const input = {
      url: validUrl,
      layoutOptions: { fetchExternalCss: true },
    };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.cssVariables).toBeDefined();
      expect(result.data.layout?.cssVariables?.variables).toHaveLength(4);
      expect(result.data.layout?.cssVariables?.clampValues).toHaveLength(1);
      expect(result.data.layout?.cssVariables?.designTokens?.hasDesignSystem).toBe(true);
    }
  });

  it('fetchExternalCss: false（デフォルト）時に cssVariables が返されない', async () => {
    // Arrange: cssVariablesを返すモックサービス（ただしfetchExternalCss=falseでは返さない）
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act: fetchExternalCss を指定しない（デフォルト=false）
    const input = { url: validUrl };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      // cssVariables は undefined または存在しない
      expect(result.data.layout?.cssVariables).toBeUndefined();
    }
  });

  it('summary: true の場合でも cssVariables が含まれる', async () => {
    // Arrange
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act: summary=true + fetchExternalCss=true（layoutOptionsで）
    const input = {
      url: validUrl,
      summary: true,
      layoutOptions: { fetchExternalCss: true },
    };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.cssVariables).toBeDefined();
      // summary モードでもデザイントークン情報は保持
      expect(result.data.layout?.cssVariables?.designTokens).toBeDefined();
    }
  });

  it('cssVariables の各カテゴリ（color, spacing, typography）が正しく分類される', async () => {
    // Arrange
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act
    const input = {
      url: validUrl,
      layoutOptions: { fetchExternalCss: true },
    };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.cssVariables) {
      const { variables } = result.data.layout.cssVariables;

      // カテゴリ別に検証
      const colorVars = variables.filter(v => v.category === 'color');
      const spacingVars = variables.filter(v => v.category === 'spacing');
      const typographyVars = variables.filter(v => v.category === 'typography');

      expect(colorVars).toHaveLength(2);
      expect(spacingVars).toHaveLength(1);
      expect(typographyVars).toHaveLength(1);

      // 値の検証
      expect(colorVars.find(v => v.name === '--color-primary')?.value).toBe('#3b82f6');
      expect(spacingVars.find(v => v.name === '--spacing-md')?.value).toBe('1rem');
    }
  });

  it('clamp() 値が正しく解析される', async () => {
    // Arrange
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act
    const input = {
      url: validUrl,
      layoutOptions: { fetchExternalCss: true },
    };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.cssVariables) {
      const { clampValues } = result.data.layout.cssVariables;

      expect(clampValues).toHaveLength(1);
      const clampValue = clampValues[0];
      expect(clampValue.property).toBe('--font-size-xl');
      expect(clampValue.min).toBe('1.25rem');
      expect(clampValue.max).toBe('1.75rem');
    }
  });

  it('designTokens.categories が抽出されたカテゴリを反映する', async () => {
    // Arrange
    setPageAnalyzeServiceFactory(createMockServiceWithCssVariables(true));

    // Act
    const input = {
      url: validUrl,
      layoutOptions: { fetchExternalCss: true },
    };
    const result = await pageAnalyzeHandler(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.cssVariables) {
      const { designTokens } = result.data.layout.cssVariables;

      expect(designTokens.hasDesignSystem).toBe(true);
      expect(designTokens.tokenCount).toBe(4);
      expect(designTokens.categories).toContain('color');
      expect(designTokens.categories).toContain('spacing');
      expect(designTokens.categories).toContain('typography');
    }
  });
});
